// Unit cost of a library item (pure): node --no-warnings test-unitcost.js
const assert = require('assert');
const { unitCost } = require('./lib/unitcost.js');

const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}: expected ≈${b}, got ${a}`);
const snap = {
  trades: [{ trade: 'Foreman', group: 'Site', rate: 40, headcount: 1, overridden: false }, { trade: 'Labourer', group: 'Site', rate: 15, headcount: 4, overridden: false }],
  equipment: [{ id: 'asset:3', name: 'Test Excavator', rate: 120, source: 'asset', overridden: false }],
  warnings: [],
};
const cfg = { work_hours: 8, materialPrice: id => (id === 12 ? 300 : null) };
const v = {
  rework_pct: 2, condition_factor: 1.25,
  parts: [
    { kind: 'material', material_id: 12, qty: 1, waste_pct: 5 },
    { kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }, { trade: 'Labourer', count: 4 }], output_per_day: 20 },
    { kind: 'equipment', equipment_id: 'asset:3', output_per_hour: 10 },
    { kind: 'fixed', amount: 5 },
  ],
};
let r = unitCost(v, snap, cfg);
near(r.unit, 392.7, 'unit');
assert.deepStrictEqual(r.parts.map(p => p.kind), ['material', 'labour', 'equipment', 'fixed']);
r.parts.forEach((p, i) => near(p.cost, [315, 50, 15, 5][i], 'part ' + i));
assert.deepStrictEqual(r.missing, []);

// sub-contract rate
near(unitCost({ parts: [{ kind: 'sub', rate: 80 }] }, snap, cfg).unit, 80, 'sub, defaults rework 0 / factor 1');

// missing material price
r = unitCost(v, snap, { work_hours: 8, materialPrice: () => null });
assert.strictEqual(r.unit, null); assert.ok(r.missing.includes('material:12'));
assert.strictEqual(r.parts[0].cost, null);
near(r.parts[1].cost, 50, 'other parts still priced');

// missing trade / equipment
r = unitCost({ parts: [{ kind: 'labour', crew: [{ trade: 'Mason', count: 2 }], output_per_day: 10 }, { kind: 'equipment', equipment_id: 'hire:9', output_per_hour: 5 }] }, snap, cfg);
assert.strictEqual(r.unit, null); assert.deepStrictEqual(r.missing, ['trade:Mason', 'equipment:hire:9']);
// null / zero rates in the snapshot are missing, never zero
const snap0 = { trades: [{ trade: 'Mason', rate: null, headcount: 3 }, { trade: 'Foreman', rate: 0, headcount: 3 }], equipment: [{ id: 'asset:3', rate: null }] };
r = unitCost({ parts: [{ kind: 'labour', crew: [{ trade: 'Mason', count: 1 }, { trade: 'Foreman', count: 1 }], output_per_day: 10 }, { kind: 'equipment', equipment_id: 'asset:3', output_per_hour: 5 }] }, snap0, cfg);
assert.strictEqual(r.unit, null); assert.deepStrictEqual(r.missing, ['trade:Mason', 'trade:Foreman', 'equipment:asset:3']);

// zero / invalid output: missing code, never Infinity
for (const o of [0, -1, null, NaN]) {
  r = unitCost({ parts: [{ kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: o }] }, snap, cfg);
  assert.strictEqual(r.unit, null); assert.deepStrictEqual(r.missing, ['labour:output']);
  r = unitCost({ parts: [{ kind: 'equipment', equipment_id: 'asset:3', output_per_hour: o }] }, snap, cfg);
  assert.strictEqual(r.unit, null); assert.deepStrictEqual(r.missing, ['equipment:output']);
}
// no snapshot at all
r = unitCost({ parts: [{ kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: 10 }] }, null, cfg);
assert.strictEqual(r.unit, null); assert.deepStrictEqual(r.missing, ['trade:Foreman']);
// missing quantities / rates / counts are never zero
const one = (part, c) => unitCost({ parts: [part] }, snap, c || cfg);
for (const [part, code] of [
  [{ kind: 'material', material_id: 12, waste_pct: 0 }, 'material:qty'], [{ kind: 'sub' }, 'sub:rate'], [{ kind: 'fixed' }, 'fixed:amount'],
  [{ kind: 'labour', crew: [{ trade: 'Foreman' }], output_per_day: 5 }, 'labour:count'],
]) { r = one(part); assert.strictEqual(r.unit, null, code); assert.strictEqual(r.parts[0].cost, null); assert.deepStrictEqual(r.missing, [code]); }
// work_hours must be positive and finite for labour
for (const h of [undefined, NaN, 0, -8]) {
  r = one({ kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: 5 }, { ...cfg, work_hours: h });
  assert.strictEqual(r.unit, null); assert.deepStrictEqual(r.missing, ['work_hours']);
}
near(one({ kind: 'fixed', amount: 3 }, { ...cfg, work_hours: undefined }).unit, 3, 'work_hours irrelevant without labour');
// overflow is reported, never a silent Infinity/null
near(one({ kind: 'sub', rate: 1e308 }).unit, 1e308, 'finite large value is not an overflow');
r = unitCost({ rework_pct: 1e308, parts: [{ kind: 'sub', rate: 1e308 }] }, snap, cfg); assert.strictEqual(r.unit, null); assert.deepStrictEqual(r.missing, ['overflow']);
r = one({ kind: 'material', material_id: 12, qty: 1e308, waste_pct: 1e308 }); assert.strictEqual(r.unit, null); assert.deepStrictEqual(r.missing, ['overflow']); assert.strictEqual(r.parts[0].cost, null);
// unknown kind is a hard error, not a silent zero
assert.throws(() => unitCost({ parts: [{ kind: 'magic' }] }, snap, cfg));
console.log('unitcost ok');
