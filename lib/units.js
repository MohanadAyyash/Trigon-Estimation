// Drawing units and quantity-unit normalisation.
const UNIT_TO_M = { mm: 0.001, cm: 0.01, m: 1, km: 1000, ft: 0.3048, in: 0.0254 };
const INSUNITS = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km' };
function insunitsToUnit(code) { return INSUNITS[code] || null; }

const ALIASES = {
  m: ['m', 'lm', 'rm', 'l.m', 'م', 'م.ط'],
  m2: ['m2', 'm²', 'sqm', 'sq.m', 'sq m', 'م2', 'م²'],
  m3: ['m3', 'm³', 'cum', 'cu.m', 'cu m', 'م3', 'م³'],
  nr: ['nr', 'no', 'nos', 'no.', 'ea', 'each', 'pcs', 'عدد'],
  ls: ['ls', 'l.s', 'l.s.', 'lump sum', 'item', 'مقطوعية'],
};
const LOOKUP = new Map();
for (const [u, list] of Object.entries(ALIASES)) for (const a of list) LOOKUP.set(a, u);
function normUom(s) {
  if (s == null) return null;
  return LOOKUP.get(String(s).trim().toLowerCase().replace(/\s+/g, ' ')) || null;
}
module.exports = { UNIT_TO_M, insunitsToUnit, normUom };
