// Tenders: BOQ import, take-off, links to library items, hidden-cost checklist, pricing, QS -> admin approval, revisions.
// Spec 5.6-5.8 and 7. Editing is allowed only in draft; an approved price is frozen and never recomputed.
const { readXlsx } = require('../lib/xlsx');
const { unitCost, snapshotHours } = require('../lib/unitcost');
const { priceTender } = require('../lib/pricing');
const { writeXlsx } = require('../lib/xlsx');
const { round2 } = require('../lib/money');
const { viewSnapshot } = require('../lib/costs');
const { normUom } = require('../lib/units');

const DAY = 86400000, MAX = 1e12, MAX_MONTHS = 1200;
const KINDS = ['rta', 'direct'];
const HIDDEN_KINDS = ['fixed', 'monthly', 'pct', 'locked'];
const HIDDEN_STATUS = ['applies', 'na', 'included'];
const FROZEN_STATUSES = ['approved', 'sent', 'won', 'lost'];
// names only, no amounts (global constraint: no fees hard-coded as facts)
const SEED = [
  ['RTA permits & NOCs', 'تصاريح RTA وموافقات الجهات (NOCs)', 'fixed'],
  ['Permit deposit', 'تأمين (ديبوزت) التصريح', 'locked'],
  ['Traffic diversion (TMP)', 'تحويل المرور (TMP)', 'monthly'],
  ['Security/guarding', 'الحراسة', 'monthly'],
  ['Lab testing', 'فحوصات المختبر', 'fixed'],
  ['Consultant', 'الاستشاري', 'fixed'],
  ['CAR insurance', 'تأمين جميع أخطار المقاول (CAR)', 'pct'],
  ['Performance bond', 'ضمان حسن التنفيذ', 'locked'],
  ['Waste disposal', 'نقل المخلفات', 'fixed'],
  ['Extra accommodation & transport', 'سكن ومواصلات إضافية', 'monthly'],
  ['Site office', 'مكتب الموقع', 'monthly'],
];
const isPlain = o => o && typeof o === 'object' && !Array.isArray(o);
const text = v => v == null ? null : String(v).trim() || null;
const blankCell = c => c === null || c === undefined || (typeof c === 'string' && c.trim() === '');
const realDate = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const finNum = v => typeof v === 'number' && Number.isFinite(v);
// take-off qty = Σ ±(l ?? 1)(w ?? 1)(d ?? 1)(count ?? 1); a line with l, w and d all blank counts 0
const takeoffQty = lines => lines.reduce((s, x) => {
  if (x.l === null && x.w === null && x.d === null) return s;
  const v = (x.l ?? 1) * (x.w ?? 1) * (x.d ?? 1) * (x.count ?? 1);
  return s + (x.deduct ? -v : v);
}, 0);

// ---- export helpers (pure) -------------------------------------------------------------------------------
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PARTIAL_EN = 'PARTIAL — not a tender price', PARTIAL_AR = 'سعر ناقص — ليس سعر المناقصة';
const NO_PRICE_EN = 'NO PRICE — pricing is blocked', NO_PRICE_AR = 'لا يوجد سعر — التسعير متوقف';
const DRAFT_EN = 'DRAFT — NOT APPROVED', DRAFT_AR = 'مسودة — غير معتمدة';
// CSV: a text cell that a spreadsheet could read as a formula gets a leading quote (the client's BOQ text is untrusted)
const csvCell = v => {
  if (v === null || v === undefined) return '';
  let t = typeof v === 'number' ? String(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
// sheets: [{ name, rows }]. One sheet -> plain table; several -> each later sheet is introduced by a [Name] row.
const toCsv = sheets => {
  const lines = [];
  sheets.forEach((sh, i) => {
    if (i > 0) { lines.push(''); lines.push(csvCell('[' + sh.name + ']')); }
    for (const r of sh.rows) lines.push(r.map(csvCell).join(','));
  });
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
};
const safeRef = (ref, id) => { const r = String(ref || '').replace(/[^A-Za-z0-9_-]/g, '_'); return r.replace(/_/g, '') ? r : String(id); };

module.exports = ctx => {
  const { db, send, bad, need, readBody, audit, getSettings, num } = ctx;
  db.exec(`
CREATE TABLE IF NOT EXISTS tenders(id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, title TEXT NOT NULL, client TEXT, kind TEXT NOT NULL, root_id INTEGER, rev INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', snapshot_id INTEGER, M INTEGER, adv_pct REAL, ret_pct REAL, collection_days REAL, retention_months INTEGER, margin_pct REAL, submit_date TEXT,
  result TEXT, winner_price REAL, approved_by TEXT, approved_at TEXT, frozen TEXT, created TEXT NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS tender_rows(id INTEGER PRIMARY KEY AUTOINCREMENT, tender_id INTEGER NOT NULL, seq INTEGER NOT NULL, no TEXT, description TEXT, unit TEXT, qty REAL,
  is_heading INTEGER NOT NULL DEFAULT 0, manual_unit REAL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tender_rows_tender ON tender_rows(tender_id, seq);
CREATE TABLE IF NOT EXISTS row_links(row_id INTEGER NOT NULL, item_id INTEGER NOT NULL, share REAL NOT NULL, UNIQUE(row_id, item_id));
CREATE TABLE IF NOT EXISTS takeoff_lines(id INTEGER PRIMARY KEY AUTOINCREMENT, row_id INTEGER NOT NULL, description TEXT, l REAL, w REAL, d REAL, count REAL, deduct INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS takeoff_lines_row ON takeoff_lines(row_id);
CREATE TABLE IF NOT EXISTS hidden_templates(id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, name_en TEXT, kind TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS tender_hidden(id INTEGER PRIMARY KEY AUTOINCREMENT, tender_id INTEGER NOT NULL, template_id INTEGER, name_ar TEXT, name_en TEXT, kind TEXT NOT NULL, status TEXT,
  amount REAL, pct REAL, months REAL, bank_fee_pct REAL, loss_pct REAL, note TEXT);
CREATE INDEX IF NOT EXISTS tender_hidden_tender ON tender_hidden(tender_id);
`);
  if (db.prepare('SELECT COUNT(*) n FROM hidden_templates').get().n === 0) {
    const ins = db.prepare('INSERT INTO hidden_templates(name_en,name_ar,kind,sort,active) VALUES(?,?,?,?,1)');
    SEED.forEach(([en, ar, kind], i) => ins.run(en, ar, kind, i + 1));
  }

  const reply = (...a) => { send(...a); return true; };
  const idOf = s => /^\d+$/.test(s || '') ? Number(s) : null;
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const conflict = (msg, blocking) => { throw Object.assign(new Error(msg), { status: 409, blocking }); };
  const tenderRow = id => id === null ? null : db.prepare('SELECT * FROM tenders WHERE id=?').get(id);
  const mustDraft = t => { if (t.status !== 'draft') conflict(`tender is ${t.status}: only a draft can be changed`); };
  const tenderView = t => { const { frozen, ...v } = t; return { ...v, approved_P: frozen ? JSON.parse(frozen).P : null }; };

  // ---- measured quantities (drawings.js) ---------------------------------------------------------------
  // A take-off row's qty = its take-off lines + its measurements. A measurement counts when its unit is the row's
  // normalised unit, or the row's unit is not recognised and it was confirmed (uom_confirmed) — all in one unit.
  // Any other one stops the write: never silently left out, never m added into m2.
  const rowMeasurements = rowId => ctx.drawings ? ctx.drawings.rowMeasurements(rowId) : [];
  function recomputeTakeoffQty(rowId) {
    const row = db.prepare('SELECT * FROM tender_rows WHERE id=?').get(rowId);
    if (!row || row.source !== 'takeoff' || row.is_heading) return null;   // an imported row's qty is the client's: never changed
    const u = normUom(row.unit);
    let qty = takeoffQty(db.prepare('SELECT * FROM takeoff_lines WHERE row_id=?').all(row.id));
    const ms = rowMeasurements(row.id);
    if (new Set(ms.map(m => m.qty_unit)).size > 1) conflict(`the row's measurements are in different units: relink or remove them`);
    for (const m of ms) {
      if (!(m.qty_unit === u || (u === null && m.uom_confirmed))) conflict(`measurement ${m.id} is in ${m.qty_unit} but the row is in ${row.unit}: relink or remove it`);
      qty += m.qty;
    }
    if (!Number.isFinite(qty) || qty < 0) bad(`take-off total would be ${qty}: deductions exceed the measured quantity`);
    db.prepare('UPDATE tender_rows SET qty=? WHERE id=?').run(qty, row.id);
    return qty;
  }
  ctx.tenders = { recomputeTakeoffQty };
  // measured_incomplete: a measurement saved with confirm_incomplete (its layer total left shapes out or approximated).
  // measured vs client qty. measured_qty only when one unit (else null, see measured_units); the difference only for an
  // imported row measured in its own unit with a non-zero qty
  const measuredView = r => {
    const m = ctx.drawings ? ctx.drawings.rowMeasuredQty(r.id) : null;
    const v = { measured_qty: m ? m.qty : null, measured_unit: m ? m.unit : null, measured_units: m ? m.units : [], measured_diff_pct: null, measure_diff: false, measured_incomplete: !!(m && m.incomplete) };
    if (m && r.source === 'import' && !r.is_heading && m.unit !== null && m.unit === normUom(r.unit) && finNum(r.qty) && r.qty !== 0) {
      v.measured_diff_pct = (m.qty - r.qty) / r.qty * 100;
      v.measure_diff = Math.abs(v.measured_diff_pct) > 5;
    }
    return v;
  };
  const measureWarnings = t => db.prepare("SELECT * FROM tender_rows WHERE tender_id=? AND source='import' AND is_heading=0 ORDER BY seq, id").all(t.id)
    .map(r => ({ row_id: r.id, v: measuredView(r) })).filter(x => x.v.measure_diff).map(x => ({ row_id: x.row_id, diff_pct: x.v.measured_diff_pct }));

  // ---- validation -----------------------------------------------------------------------------------
  // a number field: null/'' clears it, otherwise num() must parse it and `check` must pass
  const numField = (v, what, check, rule) => {
    if (v === null || v === '') return null;
    const n = num(v);
    if (n === null || !check(n)) bad(`${what} must be ${rule}`);
    return n;
  };
  const pctField = (v, what) => numField(v, what, n => n >= 0 && n < 100, 'a number ≥ 0 and < 100');
  const nonNegField = (v, what, max = MAX) => numField(v, what, n => n >= 0 && n <= max, `a number ≥ 0 (at most ${max})`);
  const intField = (v, what, min) => numField(v, what, n => Number.isInteger(n) && n >= min && n <= MAX_MONTHS, `a whole number ≥ ${min} (at most ${MAX_MONTHS})`);
  const INFO = ['ref', 'title', 'client', 'kind', 'M', 'adv_pct', 'ret_pct', 'collection_days', 'retention_months', 'margin_pct', 'submit_date'];
  function cleanInfo(b, prev, me) {
    const n = prev ? Object.fromEntries(INFO.map(k => [k, prev[k]])) : Object.fromEntries(INFO.map(k => [k, null]));
    for (const k of Object.keys(b)) if (!INFO.includes(k)) bad('unknown field: ' + k);
    for (const f of ['ref', 'title', 'client']) if (f in b) n[f] = text(b[f]);
    if ('kind' in b) n.kind = b.kind;
    if ('M' in b) n.M = intField(b.M, 'M (duration in months)', 1);
    if ('adv_pct' in b) n.adv_pct = pctField(b.adv_pct, 'adv_pct');
    if ('ret_pct' in b) n.ret_pct = pctField(b.ret_pct, 'ret_pct');
    if ('collection_days' in b) n.collection_days = nonNegField(b.collection_days, 'collection_days', MAX_MONTHS * 30);
    if ('retention_months' in b) n.retention_months = intField(b.retention_months, 'retention_months', 0);
    if ('margin_pct' in b) { need(me, 'admin'); n.margin_pct = pctField(b.margin_pct, 'margin_pct'); }   // spec 5.8: only the admin sets the margin
    if ('submit_date' in b) { n.submit_date = text(b.submit_date); if (n.submit_date !== null && !realDate(n.submit_date)) bad('submit_date must be a real date, YYYY-MM-DD'); }
    if (!n.title) bad('title is required');
    if (!KINDS.includes(n.kind)) bad('kind must be one of ' + KINDS.join(', '));
    if (n.adv_pct !== null && n.ret_pct !== null && n.adv_pct + n.ret_pct >= 100) bad('adv_pct + ret_pct must be < 100');
    return n;
  }

  // ---- pricing ----------------------------------------------------------------------------------------
  // Prices a tender on its bound snapshot. Returns raw (admin) data; `hide` marks a labour part whose crew is one
  // trade with fewer than 3 people (the library's rule) so a view can blank it for qs/viewer.
  function compute(t, marginOverride) {
    const s = getSettings(), now = new Date();
    const snap = t.snapshot_id === null ? null : ctx.costs.get(t.snapshot_id);
    const blocking = [], block = (code, extra) => blocking.push({ code, ...extra });
    if (!snap) block('no_snapshot', { detail: t.snapshot_id === null ? 'no cost snapshot' : `snapshot ${t.snapshot_id} not found` });
    else {
      // age of the cost data: when a sync last read it (a later sync that found the same data confirms it again)
      if (!((now.getTime() - Date.parse(snap.checked)) / DAY <= s.stale_days)) block('snapshot_stale', { detail: snap.checked });
      if (!(finNum(snap.data.oh_monthly) && snap.data.oh_monthly >= 0)) block('overhead_missing', { detail: 'oh_monthly' });
      if (!(finNum(snap.data.w_monthly) && snap.data.w_monthly >= 0)) block('overhead_missing', { detail: 'w_monthly' });
    }
    const trades = new Map(((snap && snap.data.trades) || []).map(x => [x.trade, x]));
    const smallCrew = p => {
      if (p.kind !== 'labour' || new Set(p.crew.map(c => c.trade)).size !== 1) return false;
      const tr = trades.get(p.crew[0].trade);
      return !!tr && !(tr.headcount >= 3);
    };
    const mats = new Map(), versions = new Map();
    const mat = id => { if (!mats.has(id)) mats.set(id, snap ? ctx.costs.materialPrice(id, snap.data, now) : null); return mats.get(id); };
    // the bound snapshot's warnings (raw; a view filters them per role) plus warnings about how it is used
    const wh = snapshotHours(snap && snap.data, s.work_hours), snapWarnings = [];
    if (snap) for (const w of snap.data.warnings || []) snapWarnings.push({ code: w.code, detail: w.detail ?? null });
    if (snap && wh.fallback) snapWarnings.push({ code: 'snapshot_no_work_hours', detail: 'work hours from settings: ' + s.work_hours });
    const cfg = { work_hours: wh.hours, materialPrice: id => { const m = mat(id); return m ? m.rate : null; } };
    const version = (itemId, v) => {
      const k = itemId + ':' + v;
      if (!versions.has(k)) { const r = db.prepare('SELECT id, data FROM item_versions WHERE item_id=? AND version=?').get(itemId, v); versions.set(k, r ? { id: r.id, data: JSON.parse(r.data) } : null); }
      return versions.get(k);
    };
    const linkQ = db.prepare('SELECT l.item_id, l.share, i.code, i.unit AS uom, i.name_ar, i.name_en, i.current_version FROM row_links l JOIN items i ON i.id=l.item_id WHERE l.row_id=? ORDER BY l.rowid');
    const itemVersions = [];
    const rows = db.prepare('SELECT * FROM tender_rows WHERE tender_id=? ORDER BY seq, id').all(t.id).map(r => {
      const o = { id: r.id, seq: r.seq, no: r.no, description: r.description, unit: r.unit, qty: r.qty, is_heading: r.is_heading, source: r.source,
        manual_unit: r.manual_unit, direct_unit: null, links: [], rate: null, amount: null };
      if (r.is_heading) return o;
      // a priced row with qty 0 (e.g. a take-off row with no lines yet) would silently add nothing
      const zero = () => { if (r.qty === 0) block('row_zero_qty', { row_id: r.id }); };
      // a priced row whose unit cost is 0 (manual 0, or items that cost nothing) would understate the price silently
      const zeroCost = () => { if (o.direct_unit !== null && !(o.direct_unit > 0)) block('row_zero_cost', { row_id: r.id }); };
      if (r.manual_unit !== null) { o.direct_unit = r.manual_unit; zero(); zeroCost(); return o; }   // a manual row is a direct cost; its links are not used
      const links = linkQ.all(r.id);
      if (!links.length) { block('row_unlinked', { row_id: r.id }); return o; }
      zero();
      let du = 0;
      const missing = [], stale = [];
      for (const l of links) {
        const v = version(l.item_id, l.current_version);
        const lk = { item_id: l.item_id, code: l.code, name_ar: l.name_ar, name_en: l.name_en, uom: l.uom, share: l.share, version: l.current_version, version_id: v ? v.id : null, unit: null, missing: [], parts: [] };
        if (!v) lk.missing = ['version:' + l.item_id + '/' + l.current_version];   // the item's current version row is missing: unpriced, never a crash
        else if (!snap) lk.missing = ['snapshot'];
        else {
          const uc = unitCost(v.data, snap.data, cfg);
          lk.unit = uc.unit; lk.missing = uc.missing;
          lk.parts = uc.parts.map((p, i) => smallCrew(v.data.parts[i]) ? { kind: p.kind, cost: p.cost, hide: true } : { kind: p.kind, cost: p.cost });
          for (const p of v.data.parts) if (p.kind === 'material') { const m = mat(p.material_id); if (m && m.stale && !stale.includes(p.material_id)) stale.push(p.material_id); }
        }
        if (v) itemVersions.push({ row_id: r.id, item_id: l.item_id, version: l.current_version, version_id: v.id, share: l.share });
        for (const m of lk.missing) if (!missing.includes(m)) missing.push(m);
        if (lk.unit === null || du === null) du = null; else du += l.share * lk.unit;
        o.links.push(lk);
      }
      if (du !== null && !Number.isFinite(du)) { du = null; missing.push('overflow'); }
      o.direct_unit = du;
      if (du === null) block('row_unpriced', { row_id: r.id, detail: missing.join(', ') });
      zeroCost();
      for (const id of stale) block('material_stale', { row_id: r.id, detail: 'material:' + id });
      return o;
    });
    const hidden = db.prepare('SELECT * FROM tender_hidden WHERE tender_id=? ORDER BY id').all(t.id);
    for (const h of hidden) if (h.status === null) block('hidden_unanswered', { hidden_id: h.id });
    const applied = hidden.filter(h => h.status === 'applies');
    const margin = marginOverride ?? t.margin_pct ?? s.default_margin_pct;
    const inputs = { M: t.M, oh_monthly: snap ? snap.data.oh_monthly : null, w_monthly: snap ? snap.data.w_monthly : null, finance_rate_pct: s.finance_rate_pct,
      min_profit_pct: s.min_profit_pct, margin_pct: margin, adv_pct: t.adv_pct, ret_pct: t.ret_pct, collection_days: t.collection_days, retention_months: t.retention_months };
    let result = null, error = null;
    if (!snap) error = 'no cost snapshot';
    else {
      try {
        result = priceTender({ ...inputs, rows: rows.filter(o => !o.is_heading && o.direct_unit !== null).map(o => ({ id: o.id, qty: o.qty, direct_unit: o.direct_unit })),
          hidden: applied.map(h => ({ kind: h.kind, amount: h.amount, pct: h.pct, months: h.months, bank_fee_pct: h.bank_fee_pct, loss_pct: h.loss_pct })) });
      } catch (e) { if (e.code !== 'bad_input' && e.code !== 'no_convergence') throw e; error = e.message; }
    }
    if (result) { const by = new Map(result.rows.map(x => [x.id, x])); for (const o of rows) { const x = by.get(o.id); if (x) { o.rate = x.rate; o.amount = x.amount; } } }
    // a price that leaves out rows or unanswered hidden items is not the tender's price: say so
    const excludedRows = rows.filter(o => !o.is_heading && o.direct_unit === null).map(o => o.id);
    const unansweredHidden = hidden.filter(h => h.status === null).map(h => h.id);
    const complete = !excludedRows.length && !unansweredHidden.length;
    if (result) result.partial = !complete;
    return { snap, settings: s, inputs, margin, rows, hidden, applied, blocking, result, error, itemVersions, complete, excludedRows, unansweredHidden, snapWarnings };
  }
  // role view of breakdown rows: qs/viewer never see a small-trade labour part
  const viewRows = (rows, role) => rows.map(r => ({ ...r, links: r.links.map(l => ({ ...l, parts: l.parts.map(p => {
    const { hide, ...q } = p;
    return hide && role !== 'admin' ? { kind: q.kind, cost: null, hidden: true } : q;
  }) })) }));
  const viewFrozen = (f, role) => ({ ...f, rows: viewRows(f.rows, role) });
  // role view of a priced tender's snapshot warnings: non-admin roles get payroll-related warnings without their detail
  const viewWarnings = (c, role) => {
    if (!c.snap || role === 'admin') return c.snapWarnings;
    const own = viewSnapshot({ warnings: c.snap.data.warnings || [] }, role).warnings.map(w => ({ code: w.code, detail: w.detail ?? null }));
    return own.concat(c.snapWarnings.slice(own.length));
  };
  const latestId = () => { const l = ctx.costs.latest(); return l ? l.id : null; };

  // ---- import -------------------------------------------------------------------------------------------
  const decode = b64 => {
    if (typeof b64 !== 'string' || !b64) bad('file_b64 is required');
    try { return readXlsx(Buffer.from(b64, 'base64')); } catch (e) { bad(e.message); }
  };
  const colOf = (v, what, required) => {
    if (v === undefined || v === null || v === '') { if (required) bad(`cols.${what} is required`); return null; }
    if (Number.isInteger(v) && v >= 0 && v < 16384) return v;
    if (typeof v === 'string' && /^[A-Za-z]{1,3}$/.test(v.trim())) { let n = 0; for (const ch of v.trim().toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; if (n <= 16384) return n - 1; }
    bad(`cols.${what} must be a 0-based column number or a column letter`);
  };

  // ---- HTTP -----------------------------------------------------------------------------------------------
  async function handle(req, res, url, parts, me) {
    try { return await route(req, res, url, parts, me); }
    catch (e) { if (e.status === 409) return reply(res, 409, e.blocking ? { error: e.message, blocking: e.blocking } : { error: e.message }); throw e; }
  }

  async function route(req, res, url, parts, me) {
    const method = req.method;
    if (parts[0] === 'hidden-templates') return templates(req, res, parts, me);
    if (parts[0] !== 'tenders') return false;
    const [, idStr, sub, subId, sub2, sub2Id] = parts;

    if (idStr === undefined) {
      if (method === 'GET') return reply(res, 200, db.prepare('SELECT * FROM tenders ORDER BY id DESC').all().map(tenderView));
      if (method === 'POST') {
        need(me, 'admin', 'qs');
        const n = cleanInfo(await readBody(req), null, me), snapId = latestId();
        const id = tx(() => {
          const tid = Number(db.prepare(`INSERT INTO tenders(ref,title,client,kind,rev,status,snapshot_id,M,adv_pct,ret_pct,collection_days,retention_months,margin_pct,submit_date,created,created_by)
            VALUES(?,?,?,?,1,'draft',?,?,?,?,?,?,?,?,?,?)`).run(n.ref, n.title, n.client, n.kind, snapId, n.M, n.adv_pct, n.ret_pct, n.collection_days, n.retention_months, n.margin_pct, n.submit_date, new Date().toISOString(), me.username).lastInsertRowid);
          db.prepare('UPDATE tenders SET root_id=? WHERE id=?').run(tid, tid);
          db.prepare(`INSERT INTO tender_hidden(tender_id,template_id,name_ar,name_en,kind) SELECT ?, id, name_ar, name_en, kind FROM hidden_templates WHERE active=1 ORDER BY sort, id`).run(tid);
          audit(me, 'create', 'tenders', tid, { ...n, snapshot_id: snapId });
          return tid;
        });
        return reply(res, 200, { id });
      }
      return false;
    }
    const t = tenderRow(idOf(idStr));
    if (!t) bad('tender not found', 404);

    if (sub === undefined) {
      if (method === 'GET') return reply(res, 200, tenderView(t));
      if (method === 'PUT') {
        need(me, 'admin', 'qs'); mustDraft(t);
        const b = await readBody(req), n = cleanInfo(b, t, me);
        mustDraft(tenderRow(t.id));
        tx(() => {
          db.prepare('UPDATE tenders SET ref=?, title=?, client=?, kind=?, M=?, adv_pct=?, ret_pct=?, collection_days=?, retention_months=?, margin_pct=?, submit_date=? WHERE id=?')
            .run(n.ref, n.title, n.client, n.kind, n.M, n.adv_pct, n.ret_pct, n.collection_days, n.retention_months, n.margin_pct, n.submit_date, t.id);
          audit(me, 'update', 'tenders', t.id, { before: Object.fromEntries(INFO.map(k => [k, t[k]])), after: n });
        });
        return reply(res, 200, tenderView(tenderRow(t.id)));
      }
      if (method === 'DELETE') {
        need(me, 'admin', 'qs'); mustDraft(t);
        tx(() => {
          mustDraft(tenderRow(t.id));
          // its drawings and measurements rows go too; the files stay (shared by sha256)
          const dr = ctx.drawings ? ctx.drawings.deleteForTender(t.id) : { drawings: 0, measurements: 0 };
          db.prepare('DELETE FROM takeoff_lines WHERE row_id IN (SELECT id FROM tender_rows WHERE tender_id=?)').run(t.id);
          db.prepare('DELETE FROM row_links WHERE row_id IN (SELECT id FROM tender_rows WHERE tender_id=?)').run(t.id);
          db.prepare('DELETE FROM tender_rows WHERE tender_id=?').run(t.id);
          db.prepare('DELETE FROM tender_hidden WHERE tender_id=?').run(t.id);
          db.prepare('DELETE FROM tenders WHERE id=?').run(t.id);
          audit(me, 'delete', 'tenders', t.id, { ...tenderView(t), drawings_deleted: dr.drawings, measurements_deleted: dr.measurements });
        });
        return reply(res, 200, { ok: 1 });
      }
      return false;
    }

    // ---- pricing + workflow ----
    if (sub === 'price' && parts.length === 3 && method === 'GET') {
      if (FROZEN_STATUSES.includes(t.status)) return reply(res, 200, { tender_id: t.id, status: t.status, frozen: viewFrozen(JSON.parse(t.frozen), me.role) });
      const q = url.searchParams.get('margin_pct');
      const margin = q === null || q === '' ? undefined : pctField(q, 'margin_pct');
      // what-if on duration and collection days: priced with the override, never saved
      const qM = url.searchParams.get('M'), qCd = url.searchParams.get('collection_days'), w = { ...t };
      if (qM !== null && qM !== '') w.M = intField(qM, 'M (duration in months)', 1);
      if (qCd !== null && qCd !== '') w.collection_days = nonNegField(qCd, 'collection_days', MAX_MONTHS * 30);
      // reprice preview: priced on the latest snapshot without rebinding (spec 7.8: the difference is shown before applying)
      const qS = url.searchParams.get('snapshot'), latest = latestId();
      if (qS !== null && qS !== '') {
        if (qS !== 'latest') bad("snapshot must be 'latest'");
        if (t.status !== 'draft') conflict(`tender is ${t.status}: only a draft can be repriced`);
        if (latest === null) bad('no cost snapshot yet');
        w.snapshot_id = latest;
      }
      const c = compute(w, margin);
      if (!c.result && !c.blocking.length) bad(c.error);
      return reply(res, 200, { tender_id: t.id, status: t.status, snapshot_id: w.snapshot_id, snapshot_created: c.snap ? c.snap.created : null,
        newer_snapshot: latest !== null && latest !== w.snapshot_id, margin_pct: c.margin, inputs: c.inputs, result: c.result, error: c.error,
        complete: c.complete, excluded_rows: c.excludedRows, unanswered_hidden: c.unansweredHidden,
        rows: viewRows(c.rows, me.role), hidden: c.hidden, blocking: c.blocking, snapshot_warnings: viewWarnings(c, me.role), measure_warnings: measureWarnings(t) });
    }
    if (sub === 'export' && parts.length === 3 && method === 'GET') return exportApi(res, url, t, me);
    if (parts.length === 3 && method === 'POST' && ['submit', 'return', 'send', 'reprice', 'approve', 'revise'].includes(sub)) return workflow(sub, req, res, t, me);
    if (sub === 'result' && parts.length === 3 && method === 'PUT') {
      need(me, 'admin', 'qs');
      const b = await readBody(req);
      if (!['won', 'lost'].includes(b.result)) bad("result must be 'won' or 'lost'");
      const wp = b.winner_price === undefined ? null : nonNegField(b.winner_price, 'winner_price');
      if (b.result === 'won' && wp !== null) bad('winner_price is recorded only for a lost tender');
      const cur = tenderRow(t.id);
      if (cur.status !== 'sent') conflict(`tender is ${cur.status}: a result is recorded only for a sent tender, once`);   // won/lost are final
      tx(() => {
        db.prepare("UPDATE tenders SET status=?, result=?, winner_price=? WHERE id=? AND status='sent'").run(b.result, b.result, wp, t.id);
        audit(me, 'result', 'tenders', t.id, { from: cur.status, result: b.result, winner_price: wp });
      });
      return reply(res, 200, tenderView(tenderRow(t.id)));
    }

    // ---- import ----
    if (sub === 'import' && method === 'POST') {
      need(me, 'admin', 'qs');
      if (subId === 'preview' && parts.length === 4) {
        const wb = decode((await readBody(req)).file_b64);
        return reply(res, 200, { sheets: wb.sheets.map(s => ({ name: s.name, row_count: s.rows.length, rows: s.rows.slice(0, 30) })) });
      }
      if (parts.length !== 3) return false;
      mustDraft(t);
      const b = await readBody(req);
      mustDraft(tenderRow(t.id));
      const wb = decode(b.file_b64);
      if (typeof b.sheet !== 'string') bad('sheet (the sheet name) is required');
      const sheet = wb.sheets.find(s => s.name === b.sheet);
      if (!sheet) bad(`sheet "${b.sheet}" not found`);
      if (!Number.isInteger(b.header_row) || b.header_row < 0) bad('header_row must be a whole number ≥ 0 (1-based; 0 = no header)');
      if (!isPlain(b.cols)) bad('cols must be an object');
      const cols = { no: colOf(b.cols.no, 'no', false), desc: colOf(b.cols.desc, 'desc', true), unit: colOf(b.cols.unit, 'unit', false), qty: colOf(b.cols.qty, 'qty', true) };
      const cell = (row, i) => i === null ? null : row[i] ?? null;
      const out = [];
      sheet.rows.forEach((row, i) => {
        if (i < b.header_row) return;
        if (row.every(blankCell)) return;   // empty row: skipped
        const rn = i + 1, qc = cell(row, cols.qty);
        let qty = null;
        if (!blankCell(qc)) {
          qty = num(qc);
          if (qty === null) bad(`row ${rn}: quantity "${qc}" is not a number`);
          if (qty < 0 || qty > MAX) bad(`row ${rn}: quantity ${qty} must be ≥ 0`);
        }
        out.push({ no: text(cell(row, cols.no)), description: text(cell(row, cols.desc)), unit: text(cell(row, cols.unit)), qty });
      });
      if (!out.length) bad(`no rows found after header row ${b.header_row} in sheet "${sheet.name}"`);   // a wrong header_row must not wipe the BOQ
      const done = tx(() => {
        // measurements of the replaced rows are kept, unlinked: the user relinks them to the new rows
        const unlinked = ctx.drawings ? ctx.drawings.unlinkRows(db.prepare("SELECT id FROM tender_rows WHERE tender_id=? AND source='import'").all(t.id).map(r => r.id)) : 0;
        const removed = Number(db.prepare("DELETE FROM row_links WHERE row_id IN (SELECT id FROM tender_rows WHERE tender_id=? AND source='import')").run(t.id).changes);
        db.prepare("DELETE FROM takeoff_lines WHERE row_id IN (SELECT id FROM tender_rows WHERE tender_id=? AND source='import')").run(t.id);
        db.prepare("DELETE FROM tender_rows WHERE tender_id=? AND source='import'").run(t.id);
        const ins = db.prepare("INSERT INTO tender_rows(tender_id,seq,no,description,unit,qty,is_heading,source) VALUES(?,?,?,?,?,?,?,'import')");
        out.forEach((r, i) => ins.run(t.id, i + 1, r.no, r.description, r.unit, r.qty, r.qty === null ? 1 : 0));
        // take-off rows keep their order, after the imported rows
        const upd = db.prepare('UPDATE tender_rows SET seq=? WHERE id=?');
        db.prepare("SELECT id FROM tender_rows WHERE tender_id=? AND source='takeoff' ORDER BY seq, id").all(t.id).forEach((r, i) => upd.run(out.length + i + 1, r.id));
        audit(me, 'import', 'tenders', t.id, { sheet: sheet.name, header_row: b.header_row, cols, rows: out.length, headings: out.filter(r => r.qty === null).length, links_removed: removed, measurements_unlinked: unlinked });
        return { removed, unlinked };
      });
      return reply(res, 200, { ok: 1, rows: out.length, links_removed: done.removed, measurements_unlinked: done.unlinked });
    }

    if (sub === 'rows') return rowsApi(req, res, t, me, subId, sub2, sub2Id, parts.length);
    if (sub === 'hidden') return hiddenApi(req, res, t, me, subId, parts.length);
    return false;
  }

  // ---- exports (xlsx / csv) ---------------------------------------------------------------------------------
  // client: only a complete price, and before approval marked DRAFT (first row + file name); internal: also a partial
  // price, marked on its first row.
  // approved/sent/won/lost tenders read the frozen result only.
  function exportApi(res, url, t, me) {
    need(me, 'admin', 'qs', 'viewer');
    const format = url.searchParams.get('format') || 'xlsx', kind = url.searchParams.get('kind') || 'client';
    if (!['xlsx', 'csv'].includes(format)) bad('format must be xlsx or csv');
    if (!['client', 'internal'].includes(kind)) bad('kind must be client or internal');
    if (kind === 'internal') need(me, 'admin', 'qs');
    let d;
    if (FROZEN_STATUSES.includes(t.status)) {
      const f = JSON.parse(t.frozen);
      d = { result: f, rows: f.rows, hidden: f.hidden, complete: true, blocking: [], excluded: [], unanswered: [], margin: f.margin_pct, snapshot: f.snapshot_created, error: null };
    } else {
      const c = compute(t);
      if (kind === 'client' && (!c.result || !c.complete || c.blocking.length)) conflict(c.error && !c.blocking.length ? c.error : 'pricing is not complete: a client BOQ needs a complete price', c.blocking);
      d = { result: c.result, rows: c.rows, hidden: c.hidden, complete: c.complete, blocking: c.blocking, excluded: c.excludedRows, unanswered: c.unansweredHidden,
        margin: c.margin, snapshot: c.snap ? c.snap.created : null, error: c.error };
    }
    const rows = viewRows(d.rows, me.role);   // the same role view as the price response: no small-trade labour part for qs
    const r = d.result;
    let sheets;
    if (kind === 'client') {
      sheets = [{ name: 'BOQ', colWidths: [8, 60, 8, 12, 12, 14], rows: [
        ['No', 'Description', 'Unit', 'Qty', 'Rate', 'Amount'],
        ...rows.map(o => o.is_heading ? [o.no, o.description, o.unit, null, null, null] : [o.no, o.description, o.unit, o.qty, o.rate, o.amount]),
        [null, 'Total', null, null, null, r.total],
        [null, 'Prices exclude VAT'], [null, 'الأسعار لا تشمل ضريبة القيمة المضافة'],
      ] }];
      // before approval a client file is a draft: it says so on its first row and in its name
      if (!FROZEN_STATUSES.includes(t.status)) sheets[0].rows.unshift([DRAFT_EN, DRAFT_AR]);
    } else {
      const label = o => [o.no, o.description].filter(Boolean).join(' ');
      const sum = [];
      if (!r) sum.push([NO_PRICE_EN, NO_PRICE_AR], ...d.blocking.map(b => [b.code, b.detail ?? (b.row_id ? 'row ' + b.row_id : b.hidden_id ? 'hidden item ' + b.hidden_id : null)]), [d.error], []);
      else if (!d.complete) {
        sum.push([PARTIAL_EN, PARTIAL_AR]);
        sum.push(['Rows left out of the price']);
        for (const o of rows.filter(x => d.excluded.includes(x.id))) sum.push([label(o)]);
        sum.push(['Unanswered hidden items']);
        for (const h of d.hidden.filter(x => d.unanswered.includes(x.id))) sum.push([h.name_en || h.name_ar]);
        sum.push([]);
      }
      sum.push(['Tender', t.title], ['Ref', t.ref], ['Revision', t.rev], ['Status', t.status], ['Snapshot date', d.snapshot], ['Margin %', d.margin]);
      if (r) sum.push(['D (direct cost)', round2(r.D)], ['H (hidden items)', round2(r.H)], ['OH (overhead)', round2(r.OH)], ['F (financing)', round2(r.F)], ['L (locked amounts)', round2(r.L)],
        ['C (true cost)', round2(r.C)], ['P_min (floor price)', round2(r.P_min)], ['P (price)', round2(r.P)], ['Total of BOQ amounts', r.total], ['Rounding difference', r.rounding_diff]);
      const parts = o => o.manual_unit !== null ? 'manual unit rate' : o.links.map(l => `${l.code} x${l.share}: ` + (l.parts.length ? l.parts.map(p => p.hidden ? `${p.kind} hidden` : `${p.kind} ${round2(p.cost)}`).join(' | ') : (l.missing.length ? 'unpriced: ' + l.missing.join(', ') : ''))).join('; ');
      sheets = [
        { name: 'Summary', colWidths: [32, 40], rows: sum },
        { name: 'Rows', colWidths: [8, 50, 8, 12, 14, 12, 14, 70], rows: [['No', 'Description', 'Unit', 'Qty', 'Direct unit', 'Rate', 'Amount', 'Parts'],
          ...rows.map(o => o.is_heading ? [o.no, o.description, o.unit, null, null, null, null, null]
            : [o.no, o.description, o.unit, o.qty, o.direct_unit === null ? null : round2(o.direct_unit), o.rate, o.amount, parts(o)])] },
        { name: 'Hidden', colWidths: [34, 34, 10, 10, 12, 8, 8, 12, 8, 30], rows: [['Name', 'Name (AR)', 'Kind', 'Status', 'Amount', '%', 'Months', 'Bank fee %', 'Loss %', 'Note'],
          ...d.hidden.map(h => [h.name_en, h.name_ar, h.kind, h.status, h.amount, h.pct, h.months, h.bank_fee_pct, h.loss_pct, h.note])] },
        { name: 'CashFlow', colWidths: [8, 14, 14, 14, 14], rows: [['Month', 'Out', 'In', 'Balance', 'Financing cost'],
          ...(r ? r.schedule.map(x => [x.month, round2(x.out), round2(x.in), round2(x.balance), round2(x.cost)]) : [])] },
      ];
    }
    const draft = kind === 'client' && !FROZEN_STATUSES.includes(t.status);
    const name = `tender-${safeRef(t.ref, t.id)}-rev${t.rev}-${kind}${draft ? '-DRAFT' : ''}.${format}`;
    const head = { 'Content-Disposition': `attachment; filename="${name}"` };
    if (format === 'xlsx') return reply(res, 200, writeXlsx(sheets), { ...head, 'Content-Type': XLSX_TYPE });
    return reply(res, 200, toCsv(sheets), { ...head, 'Content-Type': 'text/csv; charset=utf-8' });
  }

  // ---- workflow ----------------------------------------------------------------------------------------
  async function workflow(sub, req, res, t, me) {
    const move = (from, to, action) => {
      if (t.status !== from) conflict(`tender is ${t.status}: ${action} needs ${from}`);
      tx(() => {
        db.prepare('UPDATE tenders SET status=? WHERE id=? AND status=?').run(to, t.id, from);
        audit(me, action, 'tenders', t.id, { from, to });
      });
      return reply(res, 200, tenderView(tenderRow(t.id)));
    };
    if (sub === 'submit') { need(me, 'admin', 'qs'); return move('draft', 'submitted', 'submit'); }
    if (sub === 'return') { need(me, 'admin'); return move('submitted', 'draft', 'return'); }
    if (sub === 'send') { need(me, 'admin', 'qs'); return move('approved', 'sent', 'send'); }
    if (sub === 'reprice') {
      need(me, 'admin', 'qs'); mustDraft(t);
      const latest = latestId();
      if (latest === null) bad('no cost snapshot yet');
      const old = compute(t), next = compute({ ...t, snapshot_id: latest });
      const out = { old_snapshot_id: t.snapshot_id, snapshot_id: latest, old_P: old.result ? old.result.P : null, new_P: next.result ? next.result.P : null,
        old_complete: old.complete, new_complete: next.complete };
      tx(() => {
        db.prepare("UPDATE tenders SET snapshot_id=? WHERE id=? AND status='draft'").run(latest, t.id);
        audit(me, 'reprice', 'tenders', t.id, out);
      });
      return reply(res, 200, { ...out, blocking: next.blocking });
    }
    if (sub === 'approve') {
      need(me, 'admin');
      if (t.status !== 'submitted') conflict(`tender is ${t.status}: approve needs submitted`);
      const b = await readBody(req);
      const margin = b.margin_pct === undefined ? undefined : pctField(b.margin_pct, 'margin_pct');
      if (margin === null) bad('margin_pct must be a number ≥ 0 and < 100');
      if (b.override_stale !== undefined && typeof b.override_stale !== 'boolean') bad('override_stale must be true or false');
      if (b.ack_warnings !== undefined && typeof b.ack_warnings !== 'boolean') bad('ack_warnings must be true or false');
      if (!finNum(b.expected_P)) bad('expected_P (the price P shown when approving) must be a number');
      const cur = tenderRow(t.id);
      if (cur.status !== 'submitted') conflict(`tender is ${cur.status}: approve needs submitted`);
      const c = compute(cur, margin), override = b.override_stale === true;
      const stale = c.blocking.some(x => x.code === 'snapshot_stale');
      const blocking = c.blocking.filter(x => !(override && x.code === 'snapshot_stale'));
      if (blocking.length) conflict('pricing is blocked', blocking);
      if (!c.result) bad(c.error);
      // a snapshot with warnings (missing EOS, short history, bad ERP rows…) may understate costs: the admin must say they read them
      const warnCodes = c.snapWarnings.map(w => w.code), ack = warnCodes.length > 0 && b.ack_warnings === true;
      if (warnCodes.length && !ack) return reply(res, 409, { error: 'the cost data has warnings: read them and acknowledge to approve', warnings: c.snapWarnings });
      // the price moved since the admin saw it (an item, a row or a setting changed): approve only what was shown
      if (Math.abs(c.result.P - b.expected_P) > 0.005) return reply(res, 409, { error: 'price changed', P: c.result.P });
      const at = new Date().toISOString(), s = c.settings;
      const frozen = { ...c.result, rows: c.rows, hidden: c.hidden, item_versions: c.itemVersions, snapshot_id: c.snap.id, snapshot_created: c.snap.created,
        margin_pct: c.margin, finance_rate_pct: s.finance_rate_pct, min_profit_pct: s.min_profit_pct, inputs: c.inputs, override_stale: override && stale, snapshot_warnings: warnCodes, approved_by: me.username, approved_at: at };
      tx(() => {
        db.prepare("UPDATE tenders SET status='approved', margin_pct=?, approved_by=?, approved_at=?, frozen=? WHERE id=? AND status='submitted'").run(c.margin, me.username, at, JSON.stringify(frozen), t.id);
        audit(me, override && stale ? 'approve_stale' : 'approve', 'tenders', t.id, { P: frozen.P, margin_pct: c.margin, snapshot_id: c.snap.id, snapshot_created: c.snap.created });
        if (ack) audit(me, 'approve_ack_warnings', 'tenders', t.id, { codes: warnCodes, snapshot_id: c.snap.id });
      });
      return reply(res, 200, { id: t.id, status: 'approved', frozen: viewFrozen(frozen, me.role) });
    }
    if (sub === 'revise') {
      need(me, 'admin', 'qs');
      if (!['approved', 'sent'].includes(t.status)) conflict(`tender is ${t.status}: only an approved or sent tender can be revised`);
      const snapId = latestId();
      const id = tx(() => {
        const rev = db.prepare('SELECT MAX(rev) r FROM tenders WHERE root_id=?').get(t.root_id).r + 1;
        const nid = Number(db.prepare(`INSERT INTO tenders(ref,title,client,kind,root_id,rev,status,snapshot_id,M,adv_pct,ret_pct,collection_days,retention_months,margin_pct,submit_date,created,created_by)
          VALUES(?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)`).run(t.ref, t.title, t.client, t.kind, t.root_id, rev, snapId, t.M, t.adv_pct, t.ret_pct, t.collection_days, t.retention_months, t.margin_pct, t.submit_date, new Date().toISOString(), me.username).lastInsertRowid);
        const insRow = db.prepare('INSERT INTO tender_rows(tender_id,seq,no,description,unit,qty,is_heading,manual_unit,source) VALUES(?,?,?,?,?,?,?,?,?)');
        const insLink = db.prepare('INSERT INTO row_links(row_id,item_id,share) SELECT ?, item_id, share FROM row_links WHERE row_id=? ORDER BY rowid');
        const insLine = db.prepare('INSERT INTO takeoff_lines(row_id,description,l,w,d,count,deduct) SELECT ?, description, l, w, d, count, deduct FROM takeoff_lines WHERE row_id=? ORDER BY id');
        const rowIdMap = new Map();
        for (const r of db.prepare('SELECT * FROM tender_rows WHERE tender_id=? ORDER BY seq, id').all(t.id)) {
          const rid = Number(insRow.run(nid, r.seq, r.no, r.description, r.unit, r.qty, r.is_heading, r.manual_unit, r.source).lastInsertRowid);
          insLink.run(rid, r.id); insLine.run(rid, r.id);
          rowIdMap.set(r.id, rid);
        }
        // the drawings (same files) and measurements, on the new row ids
        const cl = ctx.drawings ? ctx.drawings.cloneForTender(t.id, nid, rowIdMap) : { drawings: 0, measurements: 0 };
        db.prepare(`INSERT INTO tender_hidden(tender_id,template_id,name_ar,name_en,kind,status,amount,pct,months,bank_fee_pct,loss_pct,note)
          SELECT ?, template_id, name_ar, name_en, kind, status, amount, pct, months, bank_fee_pct, loss_pct, note FROM tender_hidden WHERE tender_id=? ORDER BY id`).run(nid, t.id);
        audit(me, 'revise', 'tenders', nid, { from: t.id, rev, root_id: t.root_id, snapshot_id: snapId, drawings_copied: cl.drawings, measurements_copied: cl.measurements });
        return nid;
      });
      return reply(res, 200, { id });
    }
    return false;
  }

  // ---- rows, links, take-off lines ----------------------------------------------------------------------
  async function rowsApi(req, res, t, me, ridStr, sub2, lidStr, n) {
    const method = req.method;
    if (ridStr === undefined) {
      if (method === 'GET') {
        const linkQ = db.prepare('SELECT l.item_id, l.share, i.code, i.unit AS uom, i.name_ar, i.name_en FROM row_links l JOIN items i ON i.id=l.item_id WHERE l.row_id=? ORDER BY l.rowid');
        const lineQ = db.prepare('SELECT * FROM takeoff_lines WHERE row_id=? ORDER BY id');
        return reply(res, 200, db.prepare('SELECT * FROM tender_rows WHERE tender_id=? ORDER BY seq, id').all(t.id).map(r => ({ ...r, links: linkQ.all(r.id), lines: lineQ.all(r.id), ...measuredView(r) })));
      }
      if (method === 'POST') {
        need(me, 'admin', 'qs'); mustDraft(t);
        const b = await readBody(req);
        mustDraft(tenderRow(t.id));
        const heading = b.is_heading === true, r = { no: text(b.no), description: text(b.description), unit: text(b.unit) };
        if (!r.description && !r.no) bad('description is required');
        const id = tx(() => {
          const seq = db.prepare('SELECT COALESCE(MAX(seq),0)+1 s FROM tender_rows WHERE tender_id=?').get(t.id).s;
          // a take-off row's qty is the sum of its lines (0 before any line); a heading has none
          const rid = Number(db.prepare("INSERT INTO tender_rows(tender_id,seq,no,description,unit,qty,is_heading,source) VALUES(?,?,?,?,?,?,?,'takeoff')").run(t.id, seq, r.no, r.description, r.unit, heading ? null : 0, heading ? 1 : 0).lastInsertRowid);
          audit(me, 'create', 'tender_rows', rid, { tender_id: t.id, ...r, is_heading: heading });
          return rid;
        });
        return reply(res, 200, { id });
      }
      return false;
    }
    const row = idOf(ridStr) === null ? null : db.prepare('SELECT * FROM tender_rows WHERE id=? AND tender_id=?').get(idOf(ridStr), t.id);
    if (!row) bad('row not found', 404);
    need(me, 'admin', 'qs'); mustDraft(t);
    const body = method === 'DELETE' ? {} : await readBody(req);
    mustDraft(tenderRow(t.id));

    if (sub2 === undefined && method === 'PUT') {
      // built from the row as it is now (inside the tx): a line or measurement write may have committed while the
      // body was being read, and its recomputed qty must never be overwritten with a stale one
      tx(() => {
        const cur = db.prepare('SELECT * FROM tender_rows WHERE id=?').get(row.id);
        if (!cur) bad('row not found', 404);
        const nr = { no: cur.no, description: cur.description, unit: cur.unit, qty: cur.qty, is_heading: cur.is_heading, manual_unit: cur.manual_unit };
        for (const f of ['no', 'description', 'unit']) if (f in body) nr[f] = text(body[f]);
        if ('qty' in body) {
          if (cur.source !== 'import') bad("a take-off row's qty comes from its lines");
          const q = body.qty;
          if (blankCell(q)) { nr.qty = null; nr.is_heading = 1; }
          else { nr.qty = num(q); if (nr.qty === null || nr.qty < 0 || nr.qty > MAX) bad('qty must be a number ≥ 0'); nr.is_heading = 0; }
        }
        if ('manual_unit' in body) nr.manual_unit = nonNegField(body.manual_unit, 'manual_unit');
        if (nr.is_heading && (nr.manual_unit !== null || db.prepare('SELECT 1 FROM row_links WHERE row_id=?').get(cur.id))) bad('a heading row has no price: remove its links and manual unit first');
        // measurements were checked against the row's unit: it cannot change under them (an unrecognised unit text
        // not even in spelling, as the confirmation was for it), nor the row become a heading
        const unitChanged = normUom(nr.unit) !== normUom(cur.unit) || (normUom(cur.unit) === null && nr.unit !== cur.unit);
        if ((nr.is_heading || unitChanged) && ctx.drawings && ctx.drawings.hasMeasurements(cur.id)) conflict('the row has measurements: remove them before changing its unit or making it a heading');
        db.prepare('UPDATE tender_rows SET no=?, description=?, unit=?, qty=?, is_heading=?, manual_unit=? WHERE id=?').run(nr.no, nr.description, nr.unit, nr.qty, nr.is_heading, nr.manual_unit, cur.id);
        if (cur.source === 'takeoff' && !nr.is_heading) nr.qty = recomputeTakeoffQty(cur.id);   // lines + measurements, never the request's
        audit(me, 'update', 'tender_rows', cur.id, { tender_id: t.id, before: cur, after: nr });
      });
      return reply(res, 200, db.prepare('SELECT * FROM tender_rows WHERE id=?').get(row.id));
    }
    if (sub2 === undefined && method === 'DELETE') {
      tx(() => {
        if (ctx.drawings && ctx.drawings.hasMeasurements(row.id)) conflict('remove its measurements first');
        db.prepare('DELETE FROM takeoff_lines WHERE row_id=?').run(row.id);
        db.prepare('DELETE FROM row_links WHERE row_id=?').run(row.id);
        db.prepare('DELETE FROM tender_rows WHERE id=?').run(row.id);
        audit(me, 'delete', 'tender_rows', row.id, { tender_id: t.id, row });
      });
      return reply(res, 200, { ok: 1 });
    }
    if (sub2 === 'links' && n === 5 && method === 'PUT') {
      if (row.is_heading) bad('a heading row cannot be linked');
      if (!Array.isArray(body.links)) bad('links must be a list');
      const seen = new Set();
      let sum = 0;
      const links = body.links.map((l, i) => {
        if (!isPlain(l)) bad(`links[${i}] must be an object`);
        if (!Number.isInteger(l.item_id) || !db.prepare('SELECT 1 FROM items WHERE id=?').get(l.item_id)) bad(`links[${i}].item_id: item not found`);
        if (seen.has(l.item_id)) bad(`links[${i}]: item linked twice`);
        seen.add(l.item_id);
        if (!finNum(l.share) || !(l.share > 0) || l.share > 1) bad(`links[${i}].share must be > 0 and ≤ 1`);
        sum += l.share;
        return { item_id: l.item_id, share: l.share };
      });
      if (links.length && Math.abs(sum - 1) > 1e-9) bad(`shares must add up to 1 (they add up to ${sum})`);
      tx(() => {
        db.prepare('DELETE FROM row_links WHERE row_id=?').run(row.id);
        const ins = db.prepare('INSERT INTO row_links(row_id,item_id,share) VALUES(?,?,?)');
        for (const l of links) ins.run(row.id, l.item_id, l.share);
        audit(me, 'links', 'tender_rows', row.id, { tender_id: t.id, links });
      });
      return reply(res, 200, { ok: 1 });
    }
    if (sub2 === 'lines') {
      if (row.source !== 'takeoff' || row.is_heading) bad('take-off lines belong under a take-off quantity row');
      const lineOf = () => {
        const l = idOf(lidStr) === null ? null : db.prepare('SELECT * FROM takeoff_lines WHERE id=? AND row_id=?').get(idOf(lidStr), row.id);
        if (!l) bad('line not found', 404);
        return l;
      };
      const clean = prev => {
        const l = prev ? { description: prev.description, l: prev.l, w: prev.w, d: prev.d, count: prev.count, deduct: prev.deduct } : { description: null, l: null, w: null, d: null, count: null, deduct: 0 };
        if ('description' in body) l.description = text(body.description);
        for (const f of ['l', 'w', 'd', 'count']) if (f in body) l[f] = body[f] === undefined ? null : nonNegField(body[f], f, 1e9);
        if ('deduct' in body) { if (typeof body.deduct !== 'boolean') bad('deduct must be true or false'); l.deduct = body.deduct ? 1 : 0; }
        return l;
      };
      // write, then recompute the row qty in the same transaction; a negative total is refused
      const save = (fn, action, detail) => tx(() => {
        const lid = fn();
        const qty = recomputeTakeoffQty(row.id);   // lines + measurements; a negative total is refused
        audit(me, action, 'takeoff_lines', lid, { tender_id: t.id, row_id: row.id, ...detail, row_qty: qty });
        return { id: lid, row_qty: qty };
      });
      if (lidStr === undefined && n === 5 && method === 'POST') {
        const l = clean(null);
        return reply(res, 200, save(() => Number(db.prepare('INSERT INTO takeoff_lines(row_id,description,l,w,d,count,deduct) VALUES(?,?,?,?,?,?,?)').run(row.id, l.description, l.l, l.w, l.d, l.count, l.deduct).lastInsertRowid), 'create', l));
      }
      if (lidStr !== undefined && n === 6 && method === 'PUT') {
        const prev = lineOf(), l = clean(prev);
        return reply(res, 200, save(() => { db.prepare('UPDATE takeoff_lines SET description=?, l=?, w=?, d=?, count=?, deduct=? WHERE id=?').run(l.description, l.l, l.w, l.d, l.count, l.deduct, prev.id); return prev.id; }, 'update', { before: prev, after: l }));
      }
      if (lidStr !== undefined && n === 6 && method === 'DELETE') {
        const prev = lineOf();
        return reply(res, 200, save(() => { db.prepare('DELETE FROM takeoff_lines WHERE id=?').run(prev.id); return prev.id; }, 'delete', prev));
      }
    }
    return false;
  }

  // ---- hidden items of a tender -------------------------------------------------------------------------
  async function hiddenApi(req, res, t, me, hidStr, n) {
    const method = req.method;
    if (hidStr === undefined && method === 'GET') return reply(res, 200, db.prepare('SELECT * FROM tender_hidden WHERE tender_id=? ORDER BY id').all(t.id));
    need(me, 'admin', 'qs'); mustDraft(t);
    if (hidStr === undefined && method === 'POST') {
      const b = await readBody(req);
      mustDraft(tenderRow(t.id));
      const h = { name_ar: text(b.name_ar), name_en: text(b.name_en), kind: b.kind };
      if (!h.name_ar && !h.name_en) bad('a name is required');
      if (!HIDDEN_KINDS.includes(h.kind)) bad('kind must be one of ' + HIDDEN_KINDS.join(', '));
      const id = tx(() => {
        const hid = Number(db.prepare('INSERT INTO tender_hidden(tender_id,template_id,name_ar,name_en,kind) VALUES(?,NULL,?,?,?)').run(t.id, h.name_ar, h.name_en, h.kind).lastInsertRowid);
        audit(me, 'create', 'tender_hidden', hid, { tender_id: t.id, ...h });
        return hid;
      });
      return reply(res, 200, { id });
    }
    if (hidStr === undefined || n !== 4) return false;
    const h = idOf(hidStr) === null ? null : db.prepare('SELECT * FROM tender_hidden WHERE id=? AND tender_id=?').get(idOf(hidStr), t.id);
    if (!h) bad('hidden item not found', 404);
    if (method === 'DELETE') {
      if (h.template_id !== null) bad("a checklist item cannot be deleted: answer it 'na' instead");
      tx(() => {
        db.prepare('DELETE FROM tender_hidden WHERE id=?').run(h.id);
        audit(me, 'delete', 'tender_hidden', h.id, h);
      });
      return reply(res, 200, { ok: 1 });
    }
    if (method !== 'PUT') return false;
    const b = await readBody(req);
    mustDraft(tenderRow(t.id));
    const nh = { status: h.status, amount: h.amount, pct: h.pct, months: h.months, bank_fee_pct: h.bank_fee_pct, loss_pct: h.loss_pct, note: h.note };
    if ('status' in b) { if (b.status !== null && !HIDDEN_STATUS.includes(b.status)) bad('status must be null or one of ' + HIDDEN_STATUS.join(', ')); nh.status = b.status; }
    if ('amount' in b) nh.amount = nonNegField(b.amount, 'amount');
    if ('pct' in b) nh.pct = pctField(b.pct, 'pct');
    if ('months' in b) nh.months = nonNegField(b.months, 'months', MAX_MONTHS);
    if ('bank_fee_pct' in b) nh.bank_fee_pct = pctField(b.bank_fee_pct, 'bank_fee_pct');
    if ('loss_pct' in b) nh.loss_pct = numField(b.loss_pct, 'loss_pct', x => x >= 0 && x <= 100, 'a number ≥ 0 and ≤ 100');
    if ('note' in b) nh.note = text(b.note);
    if (nh.status === 'applies') {   // a missing value is never read as zero
      const req2 = { fixed: ['amount'], monthly: ['amount'], pct: ['pct'], locked: ['amount', 'months', 'bank_fee_pct', 'loss_pct'] }[h.kind];
      for (const f of req2) if (nh[f] === null) bad(`${f} is required when a ${h.kind} item applies`);
    }
    tx(() => {
      db.prepare('UPDATE tender_hidden SET status=?, amount=?, pct=?, months=?, bank_fee_pct=?, loss_pct=?, note=? WHERE id=?').run(nh.status, nh.amount, nh.pct, nh.months, nh.bank_fee_pct, nh.loss_pct, nh.note, h.id);
      audit(me, 'update', 'tender_hidden', h.id, { tender_id: t.id, before: h, after: nh });
    });
    return reply(res, 200, db.prepare('SELECT * FROM tender_hidden WHERE id=?').get(h.id));
  }

  // ---- hidden-cost templates ------------------------------------------------------------------------------
  async function templates(req, res, parts, me) {
    const method = req.method, [, idStr] = parts;
    if (parts.length > 2) return false;
    if (idStr === undefined && method === 'GET') return reply(res, 200, db.prepare('SELECT * FROM hidden_templates ORDER BY sort, id').all());
    if (method !== 'POST' && method !== 'PUT') return false;
    need(me, 'admin');
    const prev = idStr === undefined ? null : (idOf(idStr) === null ? null : db.prepare('SELECT * FROM hidden_templates WHERE id=?').get(idOf(idStr)));
    if (idStr !== undefined && !prev) bad('template not found', 404);
    if ((method === 'POST') !== (idStr === undefined)) return false;
    const b = await readBody(req), n = prev ? { name_ar: prev.name_ar, name_en: prev.name_en, kind: prev.kind, sort: prev.sort, active: prev.active } : { name_ar: null, name_en: null, kind: null, sort: 0, active: 1 };
    for (const f of ['name_ar', 'name_en']) if (f in b) n[f] = text(b[f]);
    if ('kind' in b) n.kind = b.kind;
    if ('sort' in b) { if (!Number.isInteger(b.sort)) bad('sort must be a whole number'); n.sort = b.sort; }
    if ('active' in b) { if (![0, 1, true, false].includes(b.active)) bad('active must be 0 or 1'); n.active = b.active ? 1 : 0; }
    if (!n.name_ar && !n.name_en) bad('a name is required');
    if (!HIDDEN_KINDS.includes(n.kind)) bad('kind must be one of ' + HIDDEN_KINDS.join(', '));
    // existing tenders hold their own copies: nothing here changes them
    if (!prev) {
      const id = tx(() => {
        const tid = Number(db.prepare('INSERT INTO hidden_templates(name_ar,name_en,kind,sort,active) VALUES(?,?,?,?,?)').run(n.name_ar, n.name_en, n.kind, n.sort, n.active).lastInsertRowid);
        audit(me, 'create', 'hidden_templates', tid, n);
        return tid;
      });
      return reply(res, 200, { id });
    }
    tx(() => {
      db.prepare('UPDATE hidden_templates SET name_ar=?, name_en=?, kind=?, sort=?, active=? WHERE id=?').run(n.name_ar, n.name_en, n.kind, n.sort, n.active, prev.id);
      audit(me, 'update', 'hidden_templates', prev.id, { before: prev, after: n });
    });
    return reply(res, 200, db.prepare('SELECT * FROM hidden_templates WHERE id=?').get(prev.id));
  }

  return { handle };
};
