// ERP read-only reader: node --no-warnings test-erpsync.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { readErp, ErpSchemaError } = require('./lib/erpsync.js');
const { makeErp } = require('./test/fixtures/make-erp.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-erp-'));
const now = new Date('2026-11-14T10:00:00Z');
const fx = () => ({
  employees: [
    { id: 11, name: 'Test Mason A', designation: 'Mason', project_id: 1 },
    { id: 12, name: 'Test Foreman B', designation: 'Foreman', project_id: null },
    { id: 13, name: 'Test Clerk C', designation: '  ', project_id: null },
    { id: 14, name: 'Test Helper D', designation: 'Helper', project_id: null },
  ],
  payroll: [
    { id: 1, month: '2026-09', employee_id: 11, project_id: null, gross: 3000, overtime: 200, status: 'final' },
    { id: 2, month: '2026-10', employee_id: 11, project_id: null, gross: 3000, overtime: 0, status: 'final' },
    { id: 3, month: '2026-11', employee_id: 11, project_id: null, gross: 3000, overtime: 0, status: 'draft' },
    { id: 4, month: '2026-10', employee_id: 12, project_id: 1, gross: 4000, overtime: 0, status: 'final' },
    { id: 5, month: '2026-10', employee_id: 13, project_id: null, gross: 5000, overtime: 0, status: 'final' },
    { id: 6, month: '2026-10', employee_id: 14, project_id: null, gross: 2000, overtime: 0, status: 'final' },
    { id: 7, month: '2025-01', employee_id: 14, project_id: null, gross: 2000, overtime: 0, status: 'final' },   // outside window
  ],
  payroll_alloc: [{ payroll_id: 1, project_id: 1, days: 15, amount: 1500 }],
  eos_provisions: [{ month: '2026-10', employee_id: 11, amount: 100 }],
  bills: [
    { id: 1, date: '2026-10-01', project_id: 1, category: 'materials', amount: 100 },
    { id: 2, date: '2026-09-01', project_id: null, category: 'fuel', amount: 50 },
    { id: 3, date: '2024-01-01', project_id: null, category: 'old-cat', amount: 10 },
  ],
  purchase_orders: [
    { id: 1, date: '2026-10-01', status: 'approved', items: JSON.stringify([{ description: 'Cement', unit: 'bag', qty: 10, rate: 18, vat: 5 }, { description: 'Bad', unit: 'm', qty: 1, rate: 'abc' }]) },
    { id: 2, date: '2026-10-02', status: 'cancelled', items: JSON.stringify([{ description: 'Cancelled item', unit: 'bag', rate: 1 }]) },
    { id: 3, date: '2026-10-03', status: 'draft', items: JSON.stringify([{ description: 'Draft item', unit: 'bag', rate: 1 }]) },
    { id: 4, date: '2026-10-04', status: 'approved', items: '{not json' },
    { id: 5, date: '2023-01-01', status: 'approved', items: JSON.stringify([{ description: 'Too old', unit: 'bag', rate: 1 }]) },
  ],
  fixed_assets: [
    { id: 21, name: 'Test Excavator', category: 'plant', cost: 100000, salvage: 10000, life_years: 8, status: 'active', project_id: 1 },
    { id: 22, name: 'Test Old Truck', category: 'vehicle', cost: 5000, salvage: 0, life_years: 5, status: 'disposed', project_id: null },
    { id: 23, name: 'Test Roller', category: 'plant', cost: 20000, salvage: 0, life_years: 5, status: 'active', project_id: null },
  ],
  equipment_logs: [
    { asset_id: 21, date: '2026-10-05', hours: 8, cost: 400 },
    { asset_id: 21, date: '2026-09-05', hours: 2, cost: 100 },
    { asset_id: 23, date: '2024-01-05', hours: 5, cost: 50 },   // ever logged, not in 12 months
  ],
  hire_items: [
    { id: 31, name: 'Test Crane Hire', type: 'equipment', basis: 'day', rate: 1000, base_hours: 10, status: 'active' },
    { id: 32, name: 'Test Returned Hire', type: 'labour', basis: 'month', rate: 1, base_hours: 260, status: 'returned' },
  ],
  projects: [
    { id: 1, name: 'Fake Project One', contract_value: 1000000, start_date: '2026-01-01', end_date: '2027-01-01', status: 'active' },
    { id: 2, name: 'Fake Project Two', contract_value: 5, start_date: '2020-01-01', end_date: '2021-01-01', status: 'completed' },
  ],
});

let n = 0;
const fresh = data => { const f = path.join(dir, `erp${++n}.db`); makeErp(f, data || fx()); return f; };

// ---- main read, with a live writer connection on the same WAL file ----
const file = fresh();
const writer = new DatabaseSync(file);
writer.exec('PRAGMA journal_mode=WAL');
const raw = readErp(file, { now });
writer.prepare("INSERT INTO bills(date, category, amount) VALUES('2026-11-01','x',1)").run();   // writer unaffected
const ck = writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
assert.strictEqual(Object.values(ck)[0], 0, 'readErp left a handle open (checkpoint busy)');
writer.close();

assert.strictEqual(raw.read_at, now.toISOString());
const json = JSON.stringify(raw);
assert.ok(!json.includes('Test Mason A'), 'employee name leaked');
assert.ok(!/"name"/.test(JSON.stringify({ p: raw.payroll, e: raw.eos })), 'name key in payroll/eos');
assert.ok(!/employee_id/.test(json), 'employee_id key leaked');

// payroll: final only, window, share
assert.ok(raw.payroll.every(r => r.month >= '2025-12'), 'window');
assert.strictEqual(raw.payroll.length, 5);
const mason9 = raw.payroll.find(r => r.month === '2026-09'), mason10 = raw.payroll.find(r => r.month === '2026-10' && r.designation === 'Mason');
assert.strictEqual(mason9.project_share, 0.5);
assert.strictEqual(mason9.overtime, 200);
assert.strictEqual(mason10.project_share, 1, 'employees.project_id fallback');
assert.strictEqual(raw.payroll.find(r => r.designation === 'Foreman').project_share, 1, 'payroll.project_id');
assert.strictEqual(raw.payroll.find(r => r.gross === 5000).project_share, 0);
assert.strictEqual(raw.payroll.find(r => r.designation === 'Helper').project_share, 0);
// employee_key: stable within a read, distinct per employee, not the ERP id
assert.strictEqual(mason9.employee_key, mason10.employee_key);
const keys = new Set(raw.payroll.map(r => r.employee_key));
assert.strictEqual(keys.size, 4);
for (const [k, id] of [[mason9.employee_key, 11]]) assert.notStrictEqual(k, id);
assert.ok(![11, 12, 13, 14].some(id => keys.has(id) || keys.has(String(id))), 'employee_key equals ERP id');
assert.strictEqual(raw.eos.length, 1);
assert.strictEqual(raw.eos[0].employee_key, mason9.employee_key);
assert.strictEqual(raw.eos[0].amount, 100);

// bills / categories / designations
assert.deepStrictEqual(raw.bills.map(b => b.category).sort(), ['fuel', 'materials']);
assert.strictEqual(raw.bills.find(b => b.category === 'materials').has_project, true);
assert.strictEqual(raw.bills.find(b => b.category === 'fuel').has_project, false);
assert.deepStrictEqual(raw.categories, ['fuel', 'materials', 'old-cat']);
assert.strictEqual(raw.earliest_bill, '2024-01-01');
assert.deepStrictEqual(raw.designations, ['Foreman', 'Helper', 'Mason']);

// PO lines: cancelled/draft/old excluded; bad rate skipped; malformed JSON warned
assert.deepStrictEqual(raw.po_lines, [{ date: '2026-10-01', description: 'Cement', unit: 'bag', rate: 18 }]);
assert.deepStrictEqual(raw.warnings, [{ code: 'bad_po_items', id: 4 }]);

// assets / hires / projects
assert.deepStrictEqual(raw.assets.map(a => a.key).sort(), [21, 23]);
const ex = raw.assets.find(a => a.key === 21), ro = raw.assets.find(a => a.key === 23);
assert.deepStrictEqual(ex, { key: 21, name: 'Test Excavator', category: 'plant', cost: 100000, salvage: 10000, life_years: 8, has_project: true, log_hours_12m: 10, log_cost_12m: 500, ever_logged: true });
assert.strictEqual(ro.has_project, false); assert.strictEqual(ro.log_hours_12m, 0); assert.strictEqual(ro.ever_logged, true);
assert.deepStrictEqual(raw.hires, [{ key: 31, name: 'Test Crane Hire', type: 'equipment', basis: 'day', rate: 1000, base_hours: 10 }]);
assert.deepStrictEqual(raw.projects, [{ contract_value: 1000000, start_date: '2026-01-01', end_date: '2027-01-01' }]);

// ---- empty ERP ----
const empty = readErp(fresh({}), { now });
assert.strictEqual(empty.earliest_bill, null); assert.deepStrictEqual(empty.payroll, []);

// ---- schema check ----
{
  const f = fresh(); const d = new DatabaseSync(f); d.exec('ALTER TABLE payroll DROP COLUMN overtime'); d.close();
  assert.throws(() => readErp(f, { now }), e => e instanceof ErpSchemaError && /ERP column missing: payroll\.overtime/.test(e.message));
  const g = fresh(); const d2 = new DatabaseSync(g); d2.exec('DROP TABLE hire_items'); d2.close();
  assert.throws(() => readErp(g, { now }), /ERP column missing: hire_items\./);
}
// failed read also releases the handle
{
  const f = fresh(); const w = new DatabaseSync(f); w.exec('ALTER TABLE payroll DROP COLUMN overtime');
  assert.throws(() => readErp(f, { now }), ErpSchemaError);
  assert.strictEqual(Object.values(w.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get())[0], 0, 'handle open after failure'); w.close();
}

// ---- missing path ----
const missing = path.join(dir, 'nope.db');
assert.throws(() => readErp(missing, { now }), /ERP database not found: /);
assert.strictEqual(fs.existsSync(missing), false);
assert.strictEqual(fs.existsSync(missing + '-wal'), false);

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-erpsync: all passed');
