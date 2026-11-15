// Cost snapshot builder (pure): node --no-warnings test-costs.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { buildSnapshot, viewSnapshot } = require('./lib/costs.js');
const { readErp } = require('./lib/erpsync.js');
const { makeErp } = require('./test/fixtures/make-erp.js');

const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-4, `${msg}: expected ≈${b}, got ${a}`);
const codes = s => s.warnings.map(w => w.code);
const months12 = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];

function fixture() {
  const payroll = [], eos = [], bills = [];
  // 3 masons (keys 1-3) and 1 foreman (key 4), final payroll 2026-08..10, all on projects
  for (const m of ['2026-08', '2026-09', '2026-10']) {
    for (const k of [1, 2, 3]) {
      payroll.push({ month: m, employee_key: k, designation: 'Mason', gross: 3000, overtime: 300, project_share: 1 });
      eos.push({ month: m, employee_key: k, amount: 150 });
    }
    payroll.push({ month: m, employee_key: 4, designation: 'Foreman', gross: 6000, overtime: 0, project_share: 1 });
    eos.push({ month: m, employee_key: 4, amount: 150 });
  }
  // office staff: 4000/month for the 12 window months, not on projects, unmapped designation
  for (const m of months12) payroll.push({ month: m, employee_key: 5, designation: 'Office Clerk', gross: 4000, overtime: 0, project_share: 0 });
  payroll.push({ month: '2025-10', employee_key: 5, designation: 'Office Clerk', gross: 4000, overtime: 0, project_share: 0 });   // before window
  for (const m of months12) {
    bills.push({ date: m + '-15', category: 'Accommodation', amount: 3000, has_project: false });   // labour_oncost 36000
    bills.push({ date: m + '-10', category: 'Rent', amount: 10000, has_project: false });            // overhead 120000
  }
  bills.push({ date: '2026-03-01', category: 'Rent', amount: 50000, has_project: true });           // project -> excluded
  bills.push({ date: '2026-03-02', category: 'misc', amount: 7777, has_project: false });           // unmapped
  bills.push({ date: '2026-04-02', category: 'Fuel', amount: 5000, has_project: false });           // equipment -> excluded
  bills.push({ date: '2026-04-03', category: 'Materials', amount: 8000, has_project: false });      // project -> excluded
  bills.push({ date: '2026-04-04', category: 'Bank', amount: 900, has_project: false });            // ignore -> excluded
  bills.push({ date: '2025-10-31', category: 'Rent', amount: 99999, has_project: false });          // before window
  bills.push({ date: '2026-11-05', category: 'Rent', amount: 99999, has_project: false });          // current month: after window
  return {
    read_at: '2026-11-14T10:00:00.000Z',
    payroll, eos, bills,
    categories: ['Accommodation', 'Bank', 'Fuel', 'Materials', 'Rent', 'misc'],
    designations: ['Foreman', 'Mason', 'Office Clerk'],
    po_lines: [{ date: '2026-10-01', description: 'Cement', unit: 'bag', rate: 18 }],
    assets: [
      { key: 1, name: 'Test Office Fitout', category: 'office', cost: 66000, salvage: 6000, life_years: 5, has_project: false, log_hours_12m: 0, log_cost_12m: 0, ever_logged: false },
      { key: 2, name: 'Test Site Cabin', category: 'site', cost: 12000, salvage: 0, life_years: 1, has_project: true, log_hours_12m: 0, log_cost_12m: 0, ever_logged: false },
      { key: 3, name: 'Test Excavator', category: 'plant', cost: 260000, salvage: 20000, life_years: 8, has_project: false, log_hours_12m: 1200, log_cost_12m: 30000, ever_logged: true },
      { key: 4, name: 'Test Idle Excavator', category: 'plant', cost: 260000, salvage: 20000, life_years: 8, has_project: false, log_hours_12m: 0, log_cost_12m: 0, ever_logged: true },
    ],
    hires: [
      { key: 7, name: 'Test Roller', type: 'equipment', basis: 'month', rate: 13000, base_hours: 260 },
      { key: 8, name: 'Test Pump', type: 'equipment', basis: 'hour', rate: 40, base_hours: null },
      { key: 9, name: 'Test Labour Supply', type: 'labour', basis: 'month', rate: 2600, base_hours: 260 },
    ],
    projects: [
      { contract_value: 1200000, start_date: '2026-01-01', end_date: '2026-12-31' },   // 12 months (end inclusive)
      { contract_value: 100000, start_date: '2026-03-01', end_date: '2026-04-30' },    // 2 months
      { contract_value: 500000, start_date: null, end_date: '2027-01-01' },
    ],
    earliest_bill: '2024-02-01',
    warnings: [{ code: 'bad_po_items', id: 4 }],
  };
}
const cfg = (extra) => Object.assign({
  work_days: 26, work_hours: 8,
  category_map: { Accommodation: 'labour_oncost', Rent: 'overhead', Fuel: 'equipment', Materials: 'project', Bank: 'ignore' },
  trade_map: { Mason: 'Mason', Foreman: 'Foreman' },
  trade_groups: { Mason: 'Site', Foreman: 'Site' },
  overrides: {},
}, extra);

const raw = fixture();
const rawCopy = JSON.parse(JSON.stringify(raw));
const snap = buildSnapshot(raw, cfg());
assert.deepStrictEqual(raw, rawCopy, 'buildSnapshot must not mutate raw');
const trade = (s, n) => s.trades.find(t => t.trade === n);
const group = (s, n) => s.groups.find(g => g.group === n);
const equip = (s, id) => s.equipment.find(e => e.id === id);

// the work days/hours the rates were built on are stored, so later pricing uses the same hours
assert.strictEqual(snap.work_days, 26); assert.strictEqual(snap.work_hours, 8);
assert.strictEqual(buildSnapshot(fixture(), cfg({ work_hours: 'x' })).work_hours, null, 'a bad work_hours is stored as null, never guessed');

// trades and groups
near(trade(snap, 'Mason').rate, 17.3077, 'Mason rate');
near(trade(snap, 'Foreman').rate, 33.1731, 'Foreman rate');
assert.strictEqual(trade(snap, 'Mason').headcount, 3);
assert.strictEqual(trade(snap, 'Foreman').headcount, 1);
assert.strictEqual(trade(snap, 'Mason').group, 'Site');
assert.strictEqual(trade(snap, 'Mason').overridden, false);
near(group(snap, 'Site').rate, 21.2740, 'Site rate');
assert.strictEqual(group(snap, 'Site').headcount, 4);
assert.deepStrictEqual(snap.unmapped.designations, ['Office Clerk']);
assert.ok(codes(snap).includes('unmapped_designation'));

// overhead
assert.strictEqual(snap.months_covered, 12);
assert.ok(!codes(snap).includes('short_history'));
near(snap.oh_parts.bills, 120000, 'OH bills');
near(snap.oh_parts.payroll, 48000, 'OH payroll');
near(snap.oh_parts.depreciation, 12000, 'OH depreciation');
near(snap.oh_monthly, 15000, 'OH monthly');
assert.deepStrictEqual(snap.unmapped.categories, ['misc']);
assert.ok(codes(snap).includes('unmapped_category'));

// equipment
near(equip(snap, 'asset:3').rate, 50, 'owned excavator');
assert.strictEqual(equip(snap, 'asset:3').source, 'owned');
assert.strictEqual(equip(snap, 'asset:3').name, 'Test Excavator');
assert.strictEqual(equip(snap, 'asset:4').rate, null);
assert.ok(snap.warnings.some(w => w.code === 'equipment_no_hours' && /asset:4/.test(w.detail)));
assert.strictEqual(equip(snap, 'asset:1'), undefined, 'never-logged asset is overhead, not equipment');
near(equip(snap, 'hire:7').rate, 50, 'hired roller');
assert.strictEqual(equip(snap, 'hire:7').source, 'hired');
near(equip(snap, 'hire:8').rate, 40, 'hired pump per hour');
assert.strictEqual(equip(snap, 'hire:9'), undefined, 'hired labour is not equipment');

// work per month, PO prices, carried warnings
near(snap.w_monthly, 1200000 / 12 + 100000 / 2, 'w_monthly');
assert.ok(codes(snap).includes('project_no_dates'));
assert.deepStrictEqual(snap.po_prices, [{ description: 'Cement', unit: 'bag', date: '2026-10-01', rate: 18 }]);
assert.ok(codes(snap).includes('bad_po_items'));
assert.ok(!JSON.stringify(snap).includes('employee_key'), 'no employee keys in the snapshot');

// views: small trades see only their group's rate
const snapCopy = JSON.parse(JSON.stringify(snap));
for (const role of ['qs', 'viewer']) {
  const v = viewSnapshot(snap, role);
  // Site 4 = Mason 3 + Foreman 1: Foreman = Site + (Site - Mason) x 3, so neither Site nor Foreman is shown
  assert.strictEqual(trade(v, 'Foreman').rate, null, role + ' Foreman hidden');
  assert.strictEqual(group(v, 'Site').rate, null, role + ' Site hidden (small trades total 1)');
  assert.strictEqual(trade(v, 'Foreman').via_group, true);
  assert.ok(!('headcount' in trade(v, 'Foreman')), role + ' Foreman headcount hidden');
  assert.ok(!('overridden' in trade(v, 'Foreman')), role + ' no overridden flag on via_group rows');
  near(trade(v, 'Mason').rate, 17.3077, role + ' Mason keeps own rate');
  assert.ok(!trade(v, 'Mason').via_group);
  assert.ok(!('oh_parts' in v), role + ' overhead parts hidden (payroll derivable from the others)');
  assert.ok(!('headcount' in group(v, 'Site')), role + ' group headcount hidden (would reveal small trades by subtraction)');
}
near(group(viewSnapshot(snap, 'admin'), 'Site').rate, 21.2740, 'admin still sees Site');
assert.deepStrictEqual(snap, snapCopy, 'viewSnapshot must not mutate its input');
assert.deepStrictEqual(viewSnapshot(snap, 'admin'), snap, 'admin sees everything');

// a group made only of small trades would reveal their rate: hidden for qs
{
  const s = buildSnapshot(fixture(), cfg({ trade_groups: { Mason: 'Site', Foreman: 'Supervision' } }));
  near(group(s, 'Supervision').rate, 33.1731, 'Supervision group (admin)');
  const v = viewSnapshot(s, 'qs');
  assert.strictEqual(trade(v, 'Foreman').rate, null);
  assert.strictEqual(trade(v, 'Foreman').via_group, true);
  assert.strictEqual(group(v, 'Supervision').rate, null);
}

// small trades totalling >= 3 people (Steel Fixer 2 + Foreman 1) next to Mason: the group rate is shown
{
  const r = fixture();
  for (const m of ['2026-08', '2026-09', '2026-10']) for (const k of [6, 7]) {
    r.payroll.push({ month: m, employee_key: k, designation: 'Steel Fixer', gross: 3500, overtime: 0, project_share: 1 });
    r.eos.push({ month: m, employee_key: k, amount: 150 });
  }
  r.designations.push('Steel Fixer');
  const s = buildSnapshot(r, cfg({ trade_map: { Mason: 'Mason', Foreman: 'Foreman', 'Steel Fixer': 'Steel Fixer' },
    trade_groups: { Mason: 'Site', Foreman: 'Site', 'Steel Fixer': 'Site' }, overrides: { 'trade:Foreman': 40 } }));
  const site = group(s, 'Site').rate;
  assert.ok(site > 0);
  const v = viewSnapshot(s, 'qs');
  near(group(v, 'Site').rate, site, 'group visible');
  near(trade(v, 'Foreman').rate, site, 'Foreman via group');
  near(trade(v, 'Steel Fixer').rate, site, 'Steel Fixer via group');
  assert.ok(!('overridden' in trade(v, 'Foreman')));
  near(trade(v, 'Mason').rate, (2700 + 3000 / 6 + 150) / 208, 'Mason own rate (on-cost now shared by 6)');
}

// payroll-related warning details are hidden from non-admin views
{
  const r = fixture();
  r.warnings.push({ code: 'bad_payroll_gross', id: 77 });
  r.eos = r.eos.filter(e => e.employee_key !== 4);
  const s = buildSnapshot(r, cfg());
  assert.ok(s.warnings.some(w => w.code === 'bad_payroll_gross' && w.detail === 'id 77'));
  assert.ok(s.warnings.some(w => w.code === 'eos_missing' && w.detail === 'Foreman'));
  const v = viewSnapshot(s, 'qs');
  for (const w of v.warnings) if (['bad_payroll_gross', 'eos_missing'].includes(w.code)) assert.ok(!('detail' in w), w.code + ' detail hidden');
  assert.ok(v.warnings.some(w => w.code === 'unmapped_category' && w.detail === 'misc'), 'other details kept');
}

// trade with no group mapping is its own group
{
  const s = buildSnapshot(fixture(), cfg({ trade_groups: { Mason: 'Site' } }));
  near(group(s, 'Foreman').rate, 33.1731, 'own group');
  assert.strictEqual(trade(s, 'Foreman').group, 'Foreman');
}

// overrides
{
  const s = buildSnapshot(fixture(), cfg({ overrides: { 'trade:Mason': 18, 'equip:asset:4': 95, 'equip:hire:7': 55, oh_monthly: 16000 } }));
  assert.strictEqual(trade(s, 'Mason').rate, 18);
  assert.strictEqual(trade(s, 'Mason').overridden, true);
  near(group(s, 'Site').rate, 21.2740, 'override does not move the group');
  assert.strictEqual(equip(s, 'asset:4').rate, 95);
  assert.strictEqual(equip(s, 'asset:4').overridden, true);
  assert.strictEqual(equip(s, 'hire:7').rate, 55);
  assert.strictEqual(equip(s, 'asset:3').overridden, false);
  assert.strictEqual(s.oh_monthly, 16000);
  assert.strictEqual(s.oh_overridden, true);
  near(s.oh_parts.bills, 120000, 'parts stay computed');
  const bad = buildSnapshot(fixture(), cfg({ overrides: { 'trade:Mason': -1, 'trade:Painter': 20 } }));
  near(trade(bad, 'Mason').rate, 17.3077, 'bad override ignored');
  assert.ok(codes(bad).includes('bad_override'));
  assert.ok(codes(bad).includes('override_unused'));
}

// short history
{
  const r = fixture();
  r.earliest_bill = '2026-05-01';
  r.bills = r.bills.filter(b => b.date >= '2026-05-01');
  const s = buildSnapshot(r, cfg());
  assert.strictEqual(s.months_covered, 6);   // 2026-05 .. 2026-10
  assert.ok(codes(s).includes('short_history'));
  // office payroll 4000/month exists for 12 months, but only the 6 covered months count:
  // (rent 6 x 10000 + payroll 6 x 4000 + depreciation 6 x 1000) / 6 = 15000
  near(s.oh_parts.payroll, 24000, 'short-history OH payroll limited to covered months');
  near(s.oh_monthly, 10000 + 4000 + 1000, 'short-history OH');
  r.earliest_bill = '2026-11-02';
  assert.strictEqual(buildSnapshot(r, cfg()).months_covered, 1);
}

// rates <= 0 and non-finite inputs never produce NaN / Infinity
{
  const r = fixture();
  r.hires.push({ key: 9, name: 'Test Free Hire', type: 'equipment', basis: 'month', rate: 0, base_hours: 260 });
  r.hires.push({ key: 10, name: 'Test Bad Hire', type: 'equipment', basis: 'day', rate: 500, base_hours: 0 });
  r.assets.push({ key: 11, name: 'Test Broken', category: 'plant', cost: null, salvage: 0, life_years: 0, has_project: false, log_hours_12m: 10, log_cost_12m: 0, ever_logged: true });
  r.assets.push({ key: 12, name: 'Test Bad Office Asset', category: 'office', cost: 1000, salvage: 0, life_years: 0, has_project: false, log_hours_12m: 0, log_cost_12m: 0, ever_logged: false });
  const s = buildSnapshot(r, cfg({ work_hours: 0 }));
  assert.strictEqual(equip(s, 'hire:9').rate, null);
  assert.strictEqual(equip(s, 'hire:10').rate, null);
  assert.strictEqual(equip(s, 'asset:11').rate, null);
  assert.ok(codes(s).includes('bad_rate'));
  assert.ok(codes(s).includes('bad_asset'));
  assert.strictEqual(trade(s, 'Mason').rate, null);
  assert.strictEqual(group(s, 'Site').rate, null);
  assert.ok(codes(s).includes('bad_work_hours'));
  const json = JSON.stringify(s);
  const walk = o => { for (const v of Object.values(o)) { if (typeof v === 'number') assert.ok(Number.isFinite(v), 'finite ' + v); else if (v && typeof v === 'object') walk(v); } };
  walk(s);
  assert.ok(!/NaN|Infinity/.test(json));
}

// empty ERP: no payroll, no bills, no projects -> defined result, nulls + warnings, never NaN
{
  const s = buildSnapshot({ read_at: '2026-11-14T10:00:00.000Z', payroll: [], eos: [], bills: [], categories: [], designations: [], po_lines: [], assets: [], hires: [], projects: [], earliest_bill: null, warnings: [] }, cfg());
  assert.strictEqual(s.oh_monthly, null);
  assert.ok(codes(s).includes('no_bill_history'));
  assert.deepStrictEqual(s.trades, []);
  assert.ok(codes(s).includes('no_final_payroll'));
  assert.strictEqual(s.w_monthly, 0);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(s)));
}

// an employee missing EOS in one month: averaged over the months present, not counted as zero
{
  const r = fixture();
  r.eos = r.eos.filter(e => !(e.employee_key === 4 && e.month === '2026-09'));
  near(trade(buildSnapshot(r, cfg()), 'Foreman').rate, 33.1731, 'EOS average over present months');
}

// project months: end date inclusive
{
  const r = fixture();
  r.projects = [{ contract_value: 60000, start_date: '2026-03-01', end_date: '2026-04-30' }];
  near(buildSnapshot(r, cfg()).w_monthly, 30000, '2-month project');
  r.projects = [{ contract_value: 60000, start_date: '2026-02-30', end_date: '2026-04-30' }];
  const s = buildSnapshot(r, cfg());
  assert.strictEqual(s.w_monthly, 0);
  assert.ok(codes(s).includes('project_no_dates'), 'impossible date rejected');
}

// integration: readErp's window covers the builder's whole window (first day of month - 12)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-costs-'));
  try {
    const file = path.join(dir, 'erp.db');
    makeErp(file, {
      employees: [{ id: 1, name: 'Test Clerk A', designation: 'Office Clerk', project_id: null }],
      payroll: [{ id: 1, month: '2025-11', employee_id: 1, project_id: null, gross: 2400, overtime: 0, status: 'final' }],
      bills: [{ id: 1, date: '2025-11-01', project_id: null, category: 'Rent', amount: 1200 }],
    });
    const s = buildSnapshot(readErp(file, { now: new Date('2026-11-14T10:00:00Z') }), cfg());
    assert.strictEqual(s.months_covered, 12);
    near(s.oh_parts.bills, 1200, 'bill dated 2025-11-01 counted');
    near(s.oh_parts.payroll, 2400, 'payroll of 2025-11 counted');
    near(s.oh_monthly, 300, 'integration OH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

assert.throws(() => buildSnapshot(fixture(), null), /cfg/);
assert.throws(() => buildSnapshot(Object.assign(fixture(), { read_at: 'nope' }), cfg()), /read_at/);

console.log('test-costs: all passed');
