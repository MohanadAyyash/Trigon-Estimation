// Tender pricing engine (pure function): node --no-warnings test-pricing.js
const assert = require('assert');
const { round2 } = require('./lib/money.js');
const { priceTender } = require('./lib/pricing.js');

const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) <= 0.01, `${msg}: ${a} vs ${b}`);
// Every number in the result is finite; only OH_flat_compare may be null (when w_monthly is 0).
const allFinite = (x, path = '') => {
  if (typeof x === 'number') return assert.ok(Number.isFinite(x), 'non-finite at ' + path);
  if (x === null) return assert.strictEqual(path, '.OH_flat_compare', 'null at ' + path);
  if (typeof x === 'object') for (const k of Object.keys(x)) allFinite(x[k], path + '.' + k);
};

// Brief example: D = 400000, fixed 8000, monthly 6000 × 2, locked 50000 for 8 months at 8 %.
const base = {
  rows: [{ id: 'r1', qty: 1000, direct_unit: 400 }],
  hidden: [{ kind: 'fixed', amount: 8000 }, { kind: 'monthly', amount: 6000 },
           { kind: 'locked', amount: 50000, months: 8, bank_fee_pct: 0, loss_pct: 0 }],
  M: 2, oh_monthly: 120000, w_monthly: 0, finance_rate_pct: 8, margin_pct: 12, min_profit_pct: 5,
  adv_pct: 0, ret_pct: 0, collection_days: 0, retention_months: 0,
};
const r = priceTender(base);
assert.strictEqual(r.D, 400000);
assert.strictEqual(r.H, 20000);
near(r.L, 2666.67, 'L');
assert.strictEqual(r.OH, 240000);
assert.strictEqual(r.F, 0);
near(r.C, 662666.67, 'C');
near(r.P, 753030.30, 'P');
near(r.V, 753030.30, 'V');
near(r.P_min, 697543.86, 'P_min');
assert.strictEqual(r.OH_flat_compare, null, 'w_monthly 0 → no meaningful flat comparison');
assert.ok(Number.isInteger(r.iterations) && r.iterations >= 1 && r.iterations <= 100);
assert.ok(Array.isArray(r.schedule) && r.schedule.length === 3, 'schedule months 0..2');
assert.deepStrictEqual(r.rows, [{ id: 'r1', rate: round2(400 * r.P / 400000), amount: round2(1000 * round2(400 * r.P / 400000)) }]);
assert.strictEqual(r.total, r.rows[0].amount);
assert.strictEqual(r.rounding_diff, round2(r.total - r.P));
allFinite(r);

// CAR 0.5 % of contract value: V feeds back into H.
const car = priceTender({ ...base, hidden: [...base.hidden, { kind: 'pct', pct: 0.5 }] });
near(car.V, 757333.33, 'CAR V');
near(car.C, 666453.33, 'CAR C');
near(car.P_min, 701529.82, 'CAR P_min');
near(car.H, 20000 + 0.005 * car.V, 'CAR H');
assert.ok(Math.abs(car.P - car.V) < 0.005, 'converged: P ≈ V');
assert.ok(car.iterations > 1);
allFinite(car);

// Locked: bank fee per year pro-rated, loss as expected cost.
const lk = priceTender({ ...base, hidden: [{ kind: 'locked', amount: 100000, months: 6, bank_fee_pct: 2, loss_pct: 10 }] });
near(lk.L, 100000 * (0.08 * 6 / 12 + 0.02 * 6 / 12 + 0.10), 'locked L with fee and loss');

// V-dependent overhead (w_monthly > 0) and financing: fixed point holds at the final V.
const w = priceTender({ ...base, w_monthly: 300000, adv_pct: 10, ret_pct: 10, collection_days: 60, retention_months: 12 });
near(w.OH, 120000 * 2 * w.V / (w.V + 300000 * 2), 'OH share at V');
assert.ok(w.F > 0);
near(w.C, w.D + w.H + w.OH + w.F + w.L, 'C = D+H+OH+F+L');
near(w.P, w.C / 0.88, 'P = C/(1-margin)');
near(w.P_min, w.C / 0.95, 'P_min = C/(1-min)');
assert.ok(Math.abs(w.P - w.V) < 0.005);
near(w.OH_flat_compare, 120000 * 12 / (300000 * 12) * w.V, 'OH flat compare');
assert.strictEqual(w.schedule.length, 2 + 12 + 1);
allFinite(w);

// Rows: P = 1234.567 forced via margin; total is the sum of rounded amounts.
const rp = priceTender({ ...base, rows: [{ id: 'a', qty: 3, direct_unit: 100 }, { id: 'b', qty: 7, direct_unit: 100 }, { id: 'c', qty: 0, direct_unit: 50 }],
  hidden: [], oh_monthly: 0, margin_pct: 100 * (1 - 1000 / 1234.567) });
near(rp.P, 1234.567, 'forced P');
assert.deepStrictEqual(rp.rows, [{ id: 'a', rate: 123.46, amount: 370.38 }, { id: 'b', rate: 123.46, amount: 864.22 }, { id: 'c', rate: 61.73, amount: 0 }]);
assert.strictEqual(rp.total, 1234.6);
assert.strictEqual(rp.total, round2(rp.rows.reduce((s, x) => s + x.amount, 0)));
assert.strictEqual(rp.rounding_diff, round2(rp.total - rp.P));
assert.strictEqual(rp.rounding_diff, 0.03);

// Guards: bad_input with a message naming the field, never NaN.
const bad = (o, re) => assert.throws(() => priceTender({ ...base, ...o }), e => e.code === 'bad_input' && re.test(e.message), JSON.stringify(o) + ' should throw ' + re);
bad({ rows: [{ id: 'z', qty: 0, direct_unit: 400 }] }, /D/);
bad({ rows: [] }, /D/);
bad({ M: 0 }, /M/);
bad({ M: 1.5 }, /M/);
bad({ M: -1 }, /M/);
bad({ margin_pct: 100 }, /margin_pct/);
bad({ margin_pct: -1 }, /margin_pct/);
bad({ min_profit_pct: 100 }, /min_profit_pct/);
bad({ min_profit_pct: -0.1 }, /min_profit_pct/);
bad({ adv_pct: 60, ret_pct: 40 }, /adv_pct/);
bad({ oh_monthly: null }, /overhead/);
bad({ oh_monthly: undefined }, /overhead/);
bad({ oh_monthly: -1 }, /overhead/);
bad({ oh_monthly: NaN }, /overhead/);
bad({ w_monthly: null }, /w_monthly/);
bad({ w_monthly: Infinity }, /w_monthly/);
bad({ finance_rate_pct: null }, /finance_rate_pct/);
bad({ rows: [{ id: 'x', qty: null, direct_unit: 1 }] }, /qty/);
bad({ rows: [{ id: 'x', qty: 1, direct_unit: null }] }, /direct_unit/);
bad({ rows: [{ id: 'x', qty: -1, direct_unit: 1 }] }, /qty/);
bad({ rows: [{ id: 'x', qty: 1, direct_unit: NaN }] }, /direct_unit/);
bad({ rows: null }, /rows/);
bad({ hidden: null }, /hidden/);
bad({ hidden: [{ kind: 'fixed' }] }, /amount/);
bad({ hidden: [{ kind: 'monthly', amount: -5 }] }, /amount/);
bad({ hidden: [{ kind: 'pct', pct: null }] }, /pct/);
bad({ hidden: [{ kind: 'locked', amount: 1000, months: 3, bank_fee_pct: 0 }] }, /loss_pct/);
bad({ hidden: [{ kind: 'locked', amount: 1000, bank_fee_pct: 0, loss_pct: 0 }] }, /months/);
bad({ hidden: [{ kind: 'bogus', amount: 1 }] }, /kind/);
// financingCost's own errors pass through unchanged.
bad({ collection_days: -1 }, /collection_days/);
bad({ retention_months: 1.5 }, /retention_months/);
assert.throws(() => priceTender(null), e => e.code === 'bad_input');

// Pct items at or above (1 − margin) of V have no finite fixed point.
assert.throws(() => priceTender({ ...base, hidden: [{ kind: 'pct', pct: 95 }] }), e => e.code === 'no_convergence' && /did not converge/.test(e.message));

// Defined result at odd but valid inputs: margin 0, no OH, no hidden.
const z = priceTender({ ...base, hidden: [], oh_monthly: 0, margin_pct: 0, min_profit_pct: 0 });
assert.strictEqual(z.C, 400000);
assert.strictEqual(z.P, 400000);
assert.strictEqual(z.P_min, 400000);
allFinite(z);

console.log('pricing ok');
