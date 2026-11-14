// Item library (rate analysis): sections, items, immutable versions, unit cost from the latest cost snapshot.
const { unitCost } = require('../lib/unitcost');

const SEED = [
  ['Excavation', 'الحفر'], ['Backfill & compaction', 'الردم والدمك'], ['Sub-base', 'الطبقة التحتية'], ['Road base', 'طبقة الأساس'],
  ['Asphalt', 'الأسفلت'], ['Kerbs', 'الأرصفة (الحواجز)'], ['Interlock', 'البلاط المتشابك'], ['Road marking & signs', 'دهان الطرق واللوحات'],
  ['Drainage', 'تصريف المياه'], ['Utility protection', 'حماية المرافق'], ['Waste disposal', 'التخلص من المخلفات'],
];
const KINDS = ['material', 'labour', 'equipment', 'sub', 'fixed'];
const isPlain = o => o && typeof o === 'object' && !Array.isArray(o);
const nonEmpty = v => typeof v === 'string' && v.trim() !== '';
const MAX = 1e9;
const text = v => v == null ? null : String(v).trim() || null;

module.exports = ctx => {
  const { db, send, bad, need, readBody, audit, getSettings } = ctx;
  db.exec(`
CREATE TABLE IF NOT EXISTS sections(id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, name_en TEXT, parent_id INTEGER, default_rework_pct REAL NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, section_id INTEGER NOT NULL, unit TEXT NOT NULL, name_ar TEXT, name_en TEXT, current_version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS item_versions(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, version INTEGER NOT NULL, created TEXT NOT NULL, created_by TEXT, data TEXT NOT NULL, UNIQUE(item_id, version));
`);
  if (db.prepare('SELECT COUNT(*) n FROM sections').get().n === 0) {
    const ins = db.prepare('INSERT INTO sections(name_en,name_ar,sort) VALUES(?,?,?)');
    SEED.forEach(([en, ar], i) => ins.run(en, ar, i + 1));   // names only, no rates
  }

  const reply = (...a) => { send(...a); return true; };
  const idOf = s => /^\d+$/.test(s || '') ? Number(s) : null;
  const sectionRow = id => id === null ? null : db.prepare('SELECT * FROM sections WHERE id=?').get(id);
  const itemRow = id => id === null ? null : db.prepare('SELECT * FROM items WHERE id=?').get(id);
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  // ---- validation ----------------------------------------------------------------
  const nonNeg = (v, what, max = Infinity) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) bad(`${what} must be a number ≥ 0` + (max < Infinity ? ' and ≤ ' + max : '')); return v; };
  const posNum = (v, what) => { if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0) || v > MAX) bad(`${what} must be a number > 0`); return v; };
  function cleanPart(p, i) {
    if (!isPlain(p)) bad(`parts[${i}] must be an object`);
    const w = `parts[${i}]`;
    if (!KINDS.includes(p.kind)) bad(`${w}.kind must be one of ${KINDS.join(', ')}`);
    if (p.kind === 'material') {
      if (!Number.isInteger(p.material_id) || !db.prepare('SELECT 1 FROM materials WHERE id=?').get(p.material_id)) bad(`${w}.material_id: material not found`);
      return { kind: 'material', material_id: p.material_id, qty: nonNeg(p.qty, w + '.qty', MAX), waste_pct: nonNeg(p.waste_pct === undefined ? 0 : p.waste_pct, w + '.waste_pct') };
    }
    if (p.kind === 'labour') {
      if (!Array.isArray(p.crew) || !p.crew.length) bad(`${w}.crew must be a non-empty list`);
      const crew = p.crew.map((c, j) => {
        if (!isPlain(c) || !nonEmpty(c.trade)) bad(`${w}.crew[${j}].trade is required`);
        if (!Number.isInteger(c.count) || c.count < 1) bad(`${w}.crew[${j}].count must be a positive whole number`);
        return { trade: c.trade, count: c.count };
      });
      return { kind: 'labour', crew, output_per_day: posNum(p.output_per_day, w + '.output_per_day') };
    }
    if (p.kind === 'equipment') {
      if (!nonEmpty(p.equipment_id)) bad(`${w}.equipment_id is required`);
      return { kind: 'equipment', equipment_id: p.equipment_id, output_per_hour: posNum(p.output_per_hour, w + '.output_per_hour') };
    }
    if (p.kind === 'sub') return { kind: 'sub', rate: nonNeg(p.rate, w + '.rate', MAX) };
    return { kind: 'fixed', amount: nonNeg(p.amount, w + '.amount', MAX) };
  }
  // version data from a body, falling back to `prev` (the current version's data) for omitted fields
  function cleanData(b, prev, head) {
    const d = {};
    // rework is frozen into the version: absent on PUT keeps the previous value; absent/null on POST (or null on PUT) takes the section default of this moment
    let rw = 'rework_pct' in b ? b.rework_pct : prev && prev.rework_pct;
    if (rw === undefined || rw === null) { const sec = sectionRow(head.section_id); rw = sec ? sec.default_rework_pct : 0; }
    d.rework_pct = nonNeg(rw, 'rework_pct');
    const cf = 'condition_factor' in b ? b.condition_factor : prev && prev.condition_factor;
    d.condition_factor = cf === undefined || cf === null ? 1 : cf;
    if (typeof d.condition_factor !== 'number' || !Number.isFinite(d.condition_factor) || d.condition_factor < 1) bad('condition_factor must be a number ≥ 1');
    const parts = 'parts' in b ? b.parts : prev && prev.parts;
    if (!Array.isArray(parts) || !parts.length) bad('parts must be a non-empty list');
    d.parts = parts.map(cleanPart);
    d.head = { code: head.code, uom: head.unit, name_ar: head.name_ar, name_en: head.name_en, section_id: head.section_id };
    return d;
  }

  // ---- pricing --------------------------------------------------------------------
  function priceItems(rows, role) {
    const snap = ctx.costs.latest(), cfg = { work_hours: getSettings().work_hours, materialPrice: id => { const m = ctx.costs.materialPrice(id, snap && snap.data, new Date()); return m ? m.rate : null; } };
    const trades = new Map(((snap && snap.data.trades) || []).map(t => [t.trade, t]));
    return rows.map(it => {
      const vr = db.prepare('SELECT data FROM item_versions WHERE item_id=? AND version=?').get(it.id, it.current_version), data = JSON.parse(vr.data);
      const out = { id: it.id, code: it.code, section_id: it.section_id, uom: it.unit, name_ar: it.name_ar, name_en: it.name_en, version: it.current_version };
      if (!snap) return { ...out, unit: null, missing: ['snapshot'], parts: data.parts.map(p => ({ kind: p.kind, cost: null })) };
      const r = unitCost(data, snap.data, cfg);
      const parts = r.parts.map((p, i) => {
        const src = data.parts[i];
        if (role !== 'admin' && src.kind === 'labour' && new Set(src.crew.map(c => c.trade)).size === 1) {
          const t = trades.get(src.crew[0].trade);
          if (t && !(t.headcount >= 3)) return { kind: p.kind, cost: null, hidden: true };   // cost x output / hours would reveal one trade's hourly rate
        }
        return { kind: p.kind, cost: p.cost };
      });
      return { ...out, unit: r.unit, missing: r.missing, parts };
    });
  }

  // ---- HTTP -----------------------------------------------------------------------
  async function handle(req, res, url, parts, me) {
    if (parts[0] !== 'library') return false;
    const method = req.method, [, sub, idStr, sub2] = parts;

    if (sub === 'sections') {
      if (idStr === undefined && method === 'GET') return reply(res, 200, db.prepare('SELECT * FROM sections ORDER BY sort, id').all());
      need(me, 'admin', 'qs');
      const clean = async prev => {
        const b = await readBody(req), n = { ...(prev || { name_ar: null, name_en: null, parent_id: null, default_rework_pct: 0, sort: 0 }) };
        for (const f of ['name_ar', 'name_en']) if (f in b) n[f] = text(b[f]);
        if (!n.name_ar && !n.name_en) bad('a name is required');
        if ('default_rework_pct' in b) n.default_rework_pct = nonNeg(b.default_rework_pct, 'default_rework_pct');
        if ('sort' in b) { if (!Number.isInteger(b.sort)) bad('sort must be a whole number'); n.sort = b.sort; }
        if ('parent_id' in b) {
          if (b.parent_id !== null && (!Number.isInteger(b.parent_id) || !sectionRow(b.parent_id))) bad('parent section not found');
          if (prev && b.parent_id !== null) for (let p = sectionRow(b.parent_id); p; p = p.parent_id === null ? null : sectionRow(p.parent_id)) if (p.id === prev.id) bad('a section cannot be its own ancestor');
          n.parent_id = b.parent_id;
        }
        return n;
      };
      if (idStr === undefined && method === 'POST') {
        const n = await clean(null);
        const id = Number(db.prepare('INSERT INTO sections(name_ar,name_en,parent_id,default_rework_pct,sort) VALUES(?,?,?,?,?)').run(n.name_ar, n.name_en, n.parent_id, n.default_rework_pct, n.sort).lastInsertRowid);
        audit(me, 'create', 'sections', id, n);
        return reply(res, 200, { id });
      }
      const sec = sectionRow(idOf(idStr));
      if (idStr !== undefined && !sec) bad('section not found', 404);
      if (sec && method === 'PUT') {
        const n = await clean(sec);
        db.prepare('UPDATE sections SET name_ar=?, name_en=?, parent_id=?, default_rework_pct=?, sort=? WHERE id=?').run(n.name_ar, n.name_en, n.parent_id, n.default_rework_pct, n.sort, sec.id);
        audit(me, 'update', 'sections', sec.id, { before: sec, after: n });
        return reply(res, 200, sectionRow(sec.id));
      }
      if (sec && method === 'DELETE') {
        if (db.prepare('SELECT 1 FROM items WHERE section_id=?').get(sec.id) || db.prepare('SELECT 1 FROM sections WHERE parent_id=?').get(sec.id)) bad('section is not empty');
        db.prepare('DELETE FROM sections WHERE id=?').run(sec.id);
        audit(me, 'delete', 'sections', sec.id, sec);
        return reply(res, 200, { ok: 1 });
      }
      return false;
    }

    if (sub !== 'items') return false;
    if (idStr === undefined && method === 'GET') return reply(res, 200, priceItems(db.prepare('SELECT * FROM items ORDER BY code').all(), me.role));
    if (idStr === undefined && method === 'POST') {
      need(me, 'admin', 'qs');
      const b = await readBody(req), head = itemHead(b, null), data = cleanData(b, null, head);
      const id = tx(() => {
        const iid = Number(db.prepare('INSERT INTO items(code,section_id,unit,name_ar,name_en,current_version) VALUES(?,?,?,?,?,1)').run(head.code, head.section_id, head.unit, head.name_ar, head.name_en).lastInsertRowid);
        db.prepare('INSERT INTO item_versions(item_id,version,created,created_by,data) VALUES(?,1,?,?,?)').run(iid, new Date().toISOString(), me.username, JSON.stringify(data));
        return iid;
      });
      audit(me, 'create', 'items', id, { ...head, version: 1 });
      return reply(res, 200, { id, version: 1 });
    }
    const item = itemRow(idOf(idStr));
    if (idStr !== undefined && !item) bad('item not found', 404);
    if (item && sub2 === undefined && method === 'PUT') {
      need(me, 'admin', 'qs');
      const b = await readBody(req), head = itemHead(b, item);
      const prev = JSON.parse(db.prepare('SELECT data FROM item_versions WHERE item_id=? AND version=?').get(item.id, item.current_version).data);
      const data = cleanData(b, prev, head), version = item.current_version + 1;
      tx(() => {
        db.prepare('UPDATE items SET code=?, section_id=?, unit=?, name_ar=?, name_en=?, current_version=? WHERE id=?').run(head.code, head.section_id, head.unit, head.name_ar, head.name_en, version, item.id);
        db.prepare('INSERT INTO item_versions(item_id,version,created,created_by,data) VALUES(?,?,?,?,?)').run(item.id, version, new Date().toISOString(), me.username, JSON.stringify(data));
      });
      audit(me, 'update', 'items', item.id, { before: { code: item.code, section_id: item.section_id, unit: item.unit, version: item.current_version }, after: { ...head, version } });
      return reply(res, 200, { id: item.id, version });
    }
    if (item && sub2 === 'versions' && parts.length === 4 && method === 'GET')
      return reply(res, 200, db.prepare('SELECT version, created, created_by, data FROM item_versions WHERE item_id=? ORDER BY version').all(item.id).map(r => ({ ...r, data: JSON.parse(r.data) })));
    return false;
  }

  function itemHead(b, prev) {
    const n = prev ? { code: prev.code, section_id: prev.section_id, unit: prev.unit, name_ar: prev.name_ar, name_en: prev.name_en } : { code: null, section_id: null, unit: null, name_ar: null, name_en: null };
    if ('unit' in b) bad('use uom for the unit of measure');
    if ('uom' in b) n.unit = text(b.uom);
    for (const f of ['code', 'name_ar', 'name_en']) if (f in b) n[f] = text(b[f]);
    if ('section_id' in b) n.section_id = b.section_id;
    if (!n.code) bad('code is required');
    if (!n.unit) bad('uom is required');
    if (!n.name_ar && !n.name_en) bad('a name is required');
    if (!Number.isInteger(n.section_id) || !sectionRow(n.section_id)) bad('section not found');
    const dup = db.prepare('SELECT id FROM items WHERE code=?').get(n.code);
    if (dup && (!prev || dup.id !== prev.id)) bad('code already exists');
    return n;
  }

  return { handle };
};
