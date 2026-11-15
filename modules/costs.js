// Costs: ERP sync (hourly + on demand), cost snapshots, cost config, material prices (PO-linked + manual quotes).
// Exposes ctx.costs = { latest, get, materialPrice, sync, startScheduler } for later modules.
const { readErp } = require('../lib/erpsync');
const { buildSnapshot, viewSnapshot } = require('../lib/costs');

const CONFIG_KEYS = ['category_map', 'trade_map', 'trade_groups', 'overrides'];
const CATEGORY_KINDS = ['overhead', 'labour_oncost', 'equipment', 'project', 'ignore'];
const norm = s => String(s == null ? '' : s).toLowerCase().trim().replace(/\s+/g, ' ');
const DAY = 86400000;
const dayMs = s => {   // real 'YYYY-MM-DD' -> UTC ms, else null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]), d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
};
const isPlain = o => o && typeof o === 'object' && !Array.isArray(o);

module.exports = ctx => {
  const { db, send, bad, need, readBody, audit, getSettings, num } = ctx;
  db.exec(`
CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, created TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS materials(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name_ar TEXT, name_en TEXT, unit TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS material_po_links(material_id INTEGER NOT NULL, description_norm TEXT NOT NULL, unit TEXT NOT NULL, UNIQUE(material_id, description_norm, unit));
CREATE TABLE IF NOT EXISTS material_quotes(id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER NOT NULL, date TEXT NOT NULL, supplier TEXT, rate REAL NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS cost_config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
  // last_checked: the last sync that read the same data again (no new row is written for unchanged data)
  if (!db.prepare('PRAGMA table_info(snapshots)').all().some(c => c.name === 'last_checked')) db.exec('ALTER TABLE snapshots ADD COLUMN last_checked TEXT');
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  // ---- config -----------------------------------------------------------------
  const getConfig = () => {
    const c = {};
    for (const k of CONFIG_KEYS) c[k] = {};
    for (const r of db.prepare('SELECT key,value FROM cost_config').all()) if (r.key in c) { try { c[r.key] = JSON.parse(r.value); } catch (e) { /* keep {} */ } }
    return c;
  };

  // ---- snapshots --------------------------------------------------------------
  // checked: when this data was last confirmed by a sync (created, or a later sync that found the same data)
  const rowToSnap = r => r && r.ok === 1 ? { id: r.id, created: r.created, checked: r.last_checked || r.created, data: JSON.parse(r.data) } : null;
  const latest = () => rowToSnap(db.prepare('SELECT * FROM snapshots WHERE ok=1 ORDER BY id DESC LIMIT 1').get());
  const get = id => rowToSnap(db.prepare('SELECT * FROM snapshots WHERE id=?').get(id));

  let running = false;
  async function sync(opts) {
    const user = opts && opts.user ? opts.user : 'system';
    if (running) return { ok: false, error: 'a sync is already running' };
    running = true;
    try {
      await new Promise(r => setImmediate(r));   // yield once, so a second concurrent call really meets the guard
      const now = opts && opts.now instanceof Date ? opts.now : new Date();
      let json;
      try {
        const s = getSettings();
        const raw = readErp(s.erp_db_path, { now });
        // compute fully first; the row is written in one INSERT, so a failure never leaves a partial snapshot
        json = JSON.stringify(buildSnapshot(raw, { ...getConfig(), work_days: s.work_days, work_hours: s.work_hours }));
      } catch (e) {
        const error = String(e && e.message || e);
        tx(() => {
          db.prepare('INSERT INTO snapshots(created,ok,error,data) VALUES(?,0,?,NULL)').run(new Date().toISOString(), error);
          audit(user, 'sync_failed', 'snapshots', null, { error });
        });
        prune();
        return { ok: false, error };
      }
      // the same data as the latest snapshot: no new row and no audit row, only the check time
      const last = db.prepare('SELECT id, data FROM snapshots WHERE ok=1 ORDER BY id DESC LIMIT 1').get();
      let out;
      if (last && last.data === json) {
        db.prepare('UPDATE snapshots SET last_checked=? WHERE id=?').run(new Date().toISOString(), last.id);
        out = { ok: true, id: last.id, unchanged: true };
      } else {
        out = tx(() => {
          const id = Number(db.prepare('INSERT INTO snapshots(created,ok,error,data) VALUES(?,1,NULL,?)').run(new Date().toISOString(), json).lastInsertRowid);
          audit(user, 'sync', 'snapshots', id, null);
          return { ok: true, id };
        });
      }
      prune();
      return out;
    } finally { running = false; }
  }

  // ok snapshots older than 90 days that no tender (any status) uses, except the latest; failed rows older than 30 days
  function prune() {
    const ago = d => new Date(Date.now() - d * DAY).toISOString();
    const keep = db.prepare('SELECT MAX(id) id FROM snapshots WHERE ok=1').get().id;
    db.prepare(`DELETE FROM snapshots WHERE ok=1 AND created < ? AND id <> ?
      AND id NOT IN (SELECT snapshot_id FROM tenders WHERE snapshot_id IS NOT NULL)`).run(ago(90), keep === null ? -1 : keep);
    db.prepare('DELETE FROM snapshots WHERE ok=0 AND created < ?').run(ago(30));
  }

  let timer = null;
  function startScheduler() {
    if (timer || process.env.ERP_SYNC_DISABLED === '1') return;
    const run = () => { Promise.resolve().then(() => sync()).catch(e => console.error('ERP sync error:', e && e.message)); };
    const minutes = Math.max(1, Number(getSettings().sync_minutes) || 60);
    timer = setInterval(run, minutes * 60e3);
    timer.unref();
    run();
  }

  // ---- material prices ----------------------------------------------------------
  // avg/min/max over every matching PO line and quote (all dates); rate/date/source from the latest-dated one
  // (a manual quote wins a date tie). stale = older than material_stale_days.
  function materialPrice(materialId, snapData, now) {
    if (!(now instanceof Date) || isNaN(now)) throw new Error('materialPrice: now must be a valid Date');
    const pts = [];   // { date, ms, rate, source }
    const add = (date, rate, source) => { const ms = dayMs(date), r = Number(rate); if (ms !== null && Number.isFinite(r) && r > 0) pts.push({ date, ms, rate: r, source }); };
    const links = db.prepare('SELECT description_norm, unit FROM material_po_links WHERE material_id=?').all(materialId);
    if (links.length && snapData && Array.isArray(snapData.po_prices)) {
      const keys = new Set(links.map(l => l.description_norm + '\u0000' + l.unit));
      for (const l of snapData.po_prices) if (keys.has(norm(l.description) + '\u0000' + norm(l.unit))) add(l.date, l.rate, 'po');
    }
    for (const q of db.prepare('SELECT date, rate FROM material_quotes WHERE material_id=?').all(materialId)) add(q.date, q.rate, 'quote');
    if (!pts.length) return null;
    let best = pts[0];
    for (const p of pts) if (p.ms > best.ms || (p.ms === best.ms && p.source === 'quote' && best.source !== 'quote')) best = p;
    const rates = pts.map(p => p.rate);
    const sd = getSettings().material_stale_days, staleDays = Number.isFinite(sd) && sd > 0 ? sd : 60;
    return {
      rate: best.rate, date: best.date, source: best.source,
      avg: rates.reduce((a, b) => a + b, 0) / rates.length, min: Math.min(...rates), max: Math.max(...rates),
      stale: (now.getTime() - best.ms) / DAY > staleDays,
    };
  }

  ctx.costs = { latest, get, materialPrice, sync, startScheduler };

  // ---- HTTP ---------------------------------------------------------------------
  const reply = (...a) => { send(...a); return true; };
  const matRow = id => db.prepare('SELECT * FROM materials WHERE id=?').get(id);
  const text = v => v == null ? null : String(v).trim() || null;

  async function handle(req, res, url, parts, me) {
    if (parts[0] !== 'costs') return false;
    const method = req.method, [, sub, idStr, sub2, idStr2] = parts;

    if (sub === 'sync' && parts.length === 2 && method === 'POST') {
      need(me, 'admin', 'qs');   // the QS may refresh costs before pricing; a viewer only reads
      const r = await sync({ user: me });
      return r.ok ? reply(res, 200, { ok: 1, id: r.id }) : reply(res, 502, { error: r.error });
    }
    if (sub === 'status' && parts.length === 2 && method === 'GET') {
      const ok = db.prepare('SELECT id, created, last_checked FROM snapshots WHERE ok=1 ORDER BY id DESC LIMIT 1').get();
      const last = db.prepare('SELECT created, ok, error FROM snapshots ORDER BY id DESC LIMIT 1').get();
      // the last good sync is the last one that read good data: a new snapshot, or a check that found the same data
      const okAt = ok ? ok.last_checked || ok.created : null;
      // the newest row is a failure, unless a no-change sync confirmed the data after it
      const failedLater = last && !last.ok && !(ok && ok.last_checked && ok.last_checked > last.created);
      const stale = !ok || (Date.now() - Date.parse(okAt)) / DAY > getSettings().stale_days;
      return reply(res, 200, { last_ok: okAt, last_ok_id: ok ? ok.id : null, snapshot_created: ok ? ok.created : null, last_checked: ok ? ok.last_checked : null,
        last_attempt: [last && last.created, okAt].filter(Boolean).sort().pop() || null,
        last_error: failedLater ? (me.role === 'admin' ? last.error : 'ERP sync failed') : null, stale });
    }
    if (sub === 'snapshot' && parts.length === 2 && method === 'GET') {
      const s = latest();
      if (!s) return reply(res, 404, { error: 'no cost snapshot yet' });
      return reply(res, 200, viewSnapshot(s.data, me.role));
    }
    if (sub === 'config' && parts.length === 2) {
      need(me, 'admin');
      if (method === 'GET') return reply(res, 200, getConfig());
      if (method === 'PUT') {
        const b = await readBody(req), changed = {};
        for (const key of Object.keys(b)) {
          if (!CONFIG_KEYS.includes(key)) bad('unknown config key: ' + key);
          if (!isPlain(b[key])) bad(`${key} must be an object`);
          const v = {};
          for (const [kk, vv] of Object.entries(b[key])) {
            if (key === 'overrides') { const n = num(vv); if (n === null || !(n > 0)) bad(`overrides.${kk} must be a positive number`); v[kk] = n; }
            else {
              if (typeof vv !== 'string') bad(`${key}.${kk} must be text`);
              if (key === 'category_map' && !CATEGORY_KINDS.includes(vv)) bad(`${key}.${kk} must be one of ${CATEGORY_KINDS.join(', ')}`);
              if (key !== 'category_map' && !vv.trim()) bad(`${key}.${kk} must not be empty`);
              v[kk] = vv;
            }
          }
          changed[key] = v;
        }
        for (const key in changed) db.prepare('INSERT INTO cost_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(changed[key]));
        audit(me, 'config', 'cost_config', null, changed);
        return reply(res, 200, getConfig());
      }
      return false;
    }

    if (sub !== 'materials') return false;
    need(me, 'admin', 'qs');
    if (idStr === undefined) {
      if (method === 'GET') return reply(res, 200, db.prepare('SELECT * FROM materials ORDER BY id').all());
      if (method === 'POST') {
        const b = await readBody(req), name_en = text(b.name_en), name_ar = text(b.name_ar), unit = text(b.unit);
        if (!name_en && !name_ar) bad('a name is required');
        if (!unit) bad('unit is required');
        const id = Number(db.prepare('INSERT INTO materials(code,name_ar,name_en,unit) VALUES(?,?,?,?)').run(text(b.code), name_ar, name_en, unit).lastInsertRowid);
        audit(me, 'create', 'materials', id, { code: text(b.code), name_en, name_ar, unit });
        return reply(res, 200, { id });
      }
      return false;
    }
    const id = /^\d+$/.test(idStr) ? Number(idStr) : null, mat = id === null ? null : matRow(id);
    if (!mat) bad('material not found', 404);

    if (sub2 === undefined) {
      if (method === 'GET') return reply(res, 200, mat);
      if (method === 'PUT') {
        const b = await readBody(req), n = { ...mat };
        for (const f of ['code', 'name_ar', 'name_en', 'unit']) if (f in b) n[f] = text(b[f]);
        if (!n.name_en && !n.name_ar) bad('a name is required');
        if (!n.unit) bad('unit is required');
        db.prepare('UPDATE materials SET code=?, name_ar=?, name_en=?, unit=? WHERE id=?').run(n.code, n.name_ar, n.name_en, n.unit, id);
        audit(me, 'update', 'materials', id, { before: mat, after: n });
        return reply(res, 200, matRow(id));
      }
      if (method === 'DELETE') {
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM material_po_links WHERE material_id=?').run(id);
          db.prepare('DELETE FROM material_quotes WHERE material_id=?').run(id);
          db.prepare('DELETE FROM materials WHERE id=?').run(id);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        audit(me, 'delete', 'materials', id, mat);
        return reply(res, 200, { ok: 1 });
      }
      return false;
    }

    if (sub2 === 'links') {
      if (idStr2 === undefined && method === 'GET') return reply(res, 200, db.prepare('SELECT rowid AS id, description_norm, unit FROM material_po_links WHERE material_id=? ORDER BY rowid').all(id));
      if (idStr2 === undefined && method === 'POST') {
        const b = await readBody(req), d = norm(b.description), u = norm(b.unit);
        if (!d) bad('description is required');
        if (!u) bad('unit is required');
        if (db.prepare('SELECT 1 FROM material_po_links WHERE material_id=? AND description_norm=? AND unit=?').get(id, d, u)) bad('this link already exists');
        const lid = Number(db.prepare('INSERT INTO material_po_links(material_id,description_norm,unit) VALUES(?,?,?)').run(id, d, u).lastInsertRowid);
        audit(me, 'create', 'material_po_links', lid, { material_id: id, description_norm: d, unit: u });
        return reply(res, 200, { id: lid });
      }
      if (idStr2 !== undefined && method === 'DELETE') {
        const row = /^\d+$/.test(idStr2) ? db.prepare('SELECT rowid AS id, * FROM material_po_links WHERE material_id=? AND rowid=?').get(id, Number(idStr2)) : null;
        if (!row) bad('link not found', 404);
        db.prepare('DELETE FROM material_po_links WHERE rowid=?').run(row.id);
        audit(me, 'delete', 'material_po_links', row.id, { material_id: id, description_norm: row.description_norm, unit: row.unit });
        return reply(res, 200, { ok: 1 });
      }
      return false;
    }

    if (sub2 === 'quotes') {
      if (idStr2 === undefined && method === 'GET') return reply(res, 200, db.prepare('SELECT * FROM material_quotes WHERE material_id=? ORDER BY date DESC, id DESC').all(id));
      if (idStr2 === undefined && method === 'POST') {
        const b = await readBody(req), rate = num(b.rate), date = typeof b.date === 'string' ? b.date.trim() : '';
        if (dayMs(date) === null) bad('date must be a real date, YYYY-MM-DD');
        if (rate === null || !(rate > 0)) bad('rate must be a positive number');
        const qid = Number(db.prepare('INSERT INTO material_quotes(material_id,date,supplier,rate,created_by) VALUES(?,?,?,?,?)').run(id, date, text(b.supplier), rate, me.username).lastInsertRowid);
        audit(me, 'create', 'material_quotes', qid, { material_id: id, date, supplier: text(b.supplier), rate });
        return reply(res, 200, { id: qid });
      }
      if (idStr2 !== undefined && method === 'DELETE') {
        const row = /^\d+$/.test(idStr2) ? db.prepare('SELECT * FROM material_quotes WHERE material_id=? AND id=?').get(id, Number(idStr2)) : null;
        if (!row) bad('quote not found', 404);
        db.prepare('DELETE FROM material_quotes WHERE id=?').run(row.id);
        audit(me, 'delete', 'material_quotes', row.id, row);
        return reply(res, 200, { ok: 1 });
      }
      return false;
    }
    return false;
  }

  return { handle };
};
