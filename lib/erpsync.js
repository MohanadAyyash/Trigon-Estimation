// Read-only reader for the company ERP database. This is the ONLY code allowed to open that file.
// Safety: existence check first, readOnly connection, one short BEGIN..COMMIT, always closed in finally.
// No personal data leaves this function: employees are replaced by an opaque per-read index.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

class ErpSchemaError extends Error {
  constructor(message) { super(message); this.name = 'ErpSchemaError'; }
}

// Columns this reader actually uses.
const REQUIRED = {
  employees: ['id', 'designation', 'project_id'],
  payroll: ['id', 'month', 'employee_id', 'project_id', 'gross', 'overtime', 'status'],
  payroll_alloc: ['payroll_id', 'amount'],
  eos_provisions: ['month', 'employee_id', 'amount'],
  bills: ['date', 'project_id', 'category', 'amount'],
  purchase_orders: ['id', 'date', 'status', 'items'],
  fixed_assets: ['id', 'name', 'category', 'cost', 'salvage', 'life_years', 'status', 'project_id'],
  equipment_logs: ['asset_id', 'date', 'hours', 'cost'],
  hire_items: ['id', 'name', 'type', 'basis', 'rate', 'base_hours', 'status'],
  projects: ['contract_value', 'start_date', 'end_date', 'status'],
};

const pad = n => String(n).padStart(2, '0');
// 'YYYY-MM-DD' (UTC) of `now` minus `months` calendar months; the day is clamped to the target month's length
function monthsAgoDate(now, months) {
  let y = now.getUTCFullYear(), m = now.getUTCMonth() - months;
  while (m < 0) { m += 12; y--; }
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${pad(m + 1)}-${pad(Math.min(now.getUTCDate(), last))}`;
}
const finite = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));

function checkSchema(db) {
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const c of cols) if (!have.has(c)) throw new ErpSchemaError(`ERP column missing: ${table}.${c}`);
  }
}

function readErp(erpPath, opts) {
  const now = opts && opts.now;
  if (!(now instanceof Date) || isNaN(now)) throw new Error('readErp: opts.now must be a valid Date');
  if (!fs.existsSync(erpPath)) throw new Error(`ERP database not found: ${erpPath}`);
  const db = new DatabaseSync(erpPath, { readOnly: true });
  let inTx = false;
  try {
    db.exec('BEGIN');
    inTx = true;
    checkSchema(db);
    const from12 = monthsAgoDate(now, 12), from24 = monthsAgoDate(now, 24), month12 = monthsAgoDate(now, 12).slice(0, 7);
    // payroll, EOS and bills cover the whole calendar month now−12, so the cost builder's window (the 12 full months
    // before now's month) is fully inside what is read
    const billsFrom = month12 + '-01';
    const warnings = [];

    const keyOf = new Map();   // ERP employee id -> opaque index, assigned in this read only
    const empKey = id => { if (!keyOf.has(id)) keyOf.set(id, keyOf.size + 1); return keyOf.get(id); };

    const allocByPayroll = new Map();
    for (const a of db.prepare('SELECT payroll_id, SUM(amount) s FROM payroll_alloc GROUP BY payroll_id').all()) allocByPayroll.set(a.payroll_id, a.s);
    const payroll = [];
    for (const r of db.prepare(`SELECT p.id, p.month, p.employee_id, p.project_id, p.gross, p.overtime, e.designation, e.project_id emp_project
      FROM payroll p LEFT JOIN employees e ON e.id = p.employee_id
      WHERE p.status = 'final' AND p.month >= ? AND p.month <= ? ORDER BY p.month, p.id`).all(month12, now.toISOString().slice(0, 7))) {
      if (!finite(r.gross)) { warnings.push({ code: 'bad_payroll_gross', id: r.id }); continue; }   // never read a missing figure as 0
      const gross = Number(r.gross);
      let share;
      if (allocByPayroll.has(r.id)) share = gross > 0 ? Math.min(1, Math.max(0, allocByPayroll.get(r.id) / gross)) : 0;
      else share = (r.project_id || r.emp_project) ? 1 : 0;
      payroll.push({ month: r.month, employee_key: empKey(r.employee_id), designation: r.designation || '', gross, overtime: finite(r.overtime) ? Number(r.overtime) : 0, project_share: share });
    }

    const eos = db.prepare('SELECT month, employee_id, amount FROM eos_provisions WHERE month >= ? AND month <= ? ORDER BY month, id')
      .all(month12, now.toISOString().slice(0, 7)).filter(r => finite(r.amount))
      .map(r => ({ month: r.month, employee_key: empKey(r.employee_id), amount: Number(r.amount) }));

    const bills = db.prepare('SELECT date, category, amount, project_id FROM bills WHERE date >= ? AND date <= ? ORDER BY date, id')
      .all(billsFrom, now.toISOString().slice(0, 10)).filter(b => finite(b.amount))
      .map(b => ({ date: b.date, category: b.category, amount: Number(b.amount), has_project: !!b.project_id }));
    const categories = db.prepare("SELECT DISTINCT category c FROM bills WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY c").all().map(r => r.c);
    const designations = [...new Set(db.prepare('SELECT designation d FROM employees WHERE designation IS NOT NULL').all().map(r => String(r.d).trim()).filter(Boolean))].sort();
    const earliest_bill = db.prepare('SELECT MIN(date) d FROM bills WHERE date IS NOT NULL').get().d || null;

    const po_lines = [];
    for (const po of db.prepare("SELECT id, date, items FROM purchase_orders WHERE COALESCE(status,'') NOT IN ('draft','cancelled') AND date >= ? AND date <= ? ORDER BY date, id")
      .all(from24, now.toISOString().slice(0, 10))) {
      let items;
      try { items = JSON.parse(po.items); } catch (e) { items = null; }
      if (!Array.isArray(items)) { warnings.push({ code: 'bad_po_items', id: po.id }); continue; }
      for (const it of items) {
        if (!it || typeof it !== 'object' || !finite(it.rate)) continue;
        po_lines.push({ date: po.date, description: String(it.description == null ? '' : it.description), unit: String(it.unit == null ? '' : it.unit), rate: Number(it.rate) });
      }
    }

    const logs = new Map();
    for (const l of db.prepare('SELECT asset_id, date, hours, cost FROM equipment_logs').all()) {
      const s = logs.get(l.asset_id) || { h: 0, c: 0, ever: true };
      if (l.date >= from12 && l.date <= now.toISOString().slice(0, 10)) { s.h += Number(l.hours) || 0; s.c += Number(l.cost) || 0; }
      logs.set(l.asset_id, s);
    }
    const assets = db.prepare("SELECT id, name, category, cost, salvage, life_years, project_id FROM fixed_assets WHERE status = 'active' ORDER BY id").all().map(a => {
      const s = logs.get(a.id);
      return { key: a.id, name: a.name, category: a.category, cost: a.cost, salvage: a.salvage, life_years: a.life_years, has_project: !!a.project_id,
        log_hours_12m: s ? s.h : 0, log_cost_12m: s ? s.c : 0, ever_logged: !!s };
    });
    const hires = db.prepare("SELECT id, name, type, basis, rate, base_hours FROM hire_items WHERE status = 'active' ORDER BY id").all()
      .map(h => ({ key: h.id, name: h.name, type: h.type, basis: h.basis, rate: h.rate, base_hours: h.base_hours }));
    const projects = db.prepare("SELECT contract_value, start_date, end_date FROM projects WHERE status = 'active' ORDER BY id").all()
      .map(p => ({ contract_value: p.contract_value, start_date: p.start_date, end_date: p.end_date }));

    db.exec('COMMIT');
    inTx = false;
    return { read_at: now.toISOString(), payroll, eos, bills, categories, designations, po_lines, assets, hires, projects, earliest_bill, warnings };
  } finally {
    try { if (inTx) db.exec('ROLLBACK'); } catch (e) { /* closing anyway */ }
    db.close();
  }
}

module.exports = { readErp, ErpSchemaError };
