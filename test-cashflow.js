// Cash-flow financing cost (pure function): node --no-warnings test-cashflow.js
const assert = require('assert');
const { round2 } = require('./lib/money.js');
const { financingCost } = require('./lib/cashflow.js');

const base = { spend: 200000, M: 2, V: 240000, adv_pct: 0, ret_pct: 10, collection_days: 60, retention_months: 12, rate_pct: 12 };
const r = financingCost(base);
assert.strictEqual(round2(r.F), 3920);
assert.strictEqual(r.schedule.length, 15, 'months 0..14');
assert.strictEqual(r.schedule[0].month, 0);
assert.strictEqual(r.schedule[r.schedule.length - 1].month, 14);
assert.deepStrictEqual(Object.keys(r.schedule[1]), ['month', 'out', 'in', 'balance', 'cost']);
assert.strictEqual(r.schedule[2].balance, -200000);
assert.strictEqual(r.schedule[14].in, 24000);

assert.strictEqual(round2(financingCost({ ...base, adv_pct: 10 }).F), 3320);
assert.strictEqual(round2(financingCost({ ...base, adv_pct: 0, ret_pct: 0, collection_days: 0, V: 250000 }).F), 0);

const bad = (o, re) => assert.throws(() => financingCost({ ...base, ...o }), e => e.code === 'bad_input' && re.test(e.message), JSON.stringify(o));
bad({ M: 0 }, /duration/);
bad({ M: 1.5 }, /duration/);
bad({ M: -1 }, /duration/);
bad({ M: NaN }, /duration/);
bad({ spend: -1 }, /spend/);
bad({ spend: Infinity }, /spend/);
bad({ spend: undefined }, /spend/);
bad({ V: 0 }, /V/);
bad({ V: NaN }, /V/);
bad({ adv_pct: -1 }, /adv_pct/);
bad({ adv_pct: 100 }, /adv_pct/);
bad({ ret_pct: 100 }, /ret_pct/);
bad({ ret_pct: -0.1 }, /ret_pct/);
bad({ rate_pct: -1 }, /rate_pct/);
bad({ rate_pct: Infinity }, /rate_pct/);
bad({ collection_days: -1 }, /collection_days/);
bad({ collection_days: NaN }, /collection_days/);
bad({ retention_months: -1 }, /retention_months/);
bad({ retention_months: 1.5 }, /retention_months/);
bad({ collection_days: 1e12 }, /collection_days/);
assert.throws(() => financingCost(null), e => e.code === 'bad_input');

// always finite
const z = financingCost({ ...base, spend: 0, rate_pct: 0 });
assert.strictEqual(z.F, 0);
assert.ok(z.schedule.every(x => Object.values(x).every(Number.isFinite)));
console.log('cashflow ok');
