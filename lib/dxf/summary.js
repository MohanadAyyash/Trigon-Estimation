// Per-layer totals, block counts and duplicate warnings from flattened DXF geometry.
const { UNIT_TO_M } = require('../units.js');
// Written into every summary and cache by the worker. Raise it whenever the parse result changes (new fields, new
// rules): a stored summary of another version is parsed again, never reused. 2 = per-layer `dropped`. 3 = clockwise hatch arcs no longer flagged approximate.
// 4 = the display file <sha>.render.bin.gz is written with the caches. 5 = nested insert markers are kind 5 in the display file.
const PARSER_VERSION = 5;

// unit null -> nothing is computed: every number is null (blocks too), no warnings.
function layerTable(flat, layers, unit) {
  const f = unit === null || unit === undefined ? null : (Object.hasOwn(UNIT_TO_M, unit) ? UNIT_TO_M[unit] : undefined);
  if (unit != null && typeof f !== 'number') throw new Error('unknown unit ' + unit);
  const rows = new Map();
  const row = (name, off, frozen) => {
    let r = rows.get(name);
    if (!r) { r = { layer: name, off: !!off, frozen: !!frozen, open: 0, perim: 0, area: 0, excluded: 0, dropped: 0, blocks: new Map(), entities: 0, approx: 0, keys: new Map(), ikeys: new Map() }; rows.set(name, r); }
    return r;
  };
  for (const l of layers || []) { const r = row(l.name, l.off, l.frozen); r.off = !!l.off; r.frozen = !!l.frozen; }
  for (const e of flat) {
    const r = row(e.layer, false, false);
    if (e.kind === 'dropped') { r.dropped += e.count; continue; }   // there, but not measured (no numbers)
    if (e.kind === 'insert') {
      let b = r.blocks.get(e.block);
      if (!b) { b = { name: e.block, top: 0, nested: 0 }; r.blocks.set(e.block, b); }
      if (e.depth === 0) b.top += e.count; else b.nested += e.count;
      const ik = e.block + '\0' + e.geomKey;
      r.ikeys.set(ik, { block: e.block, n: (r.ikeys.has(ik) ? r.ikeys.get(ik).n : 0) + 1 });
      continue;
    }
    r.entities++;
    if (e.approx) r.approx++;
    if (e.kind === 'open') r.open += e.length;
    else if (e.kind === 'closed') {
      if (e.type !== 'HATCH') r.perim += e.length; // R3: HATCH contributes to area only
      if (e.area === null) r.excluded++; else r.area += e.area;
    }
    if (e.kind === 'open' || e.kind === 'closed') r.keys.set(e.geomKey, (r.keys.get(e.geomKey) || 0) + 1);
  }
  const out = [], warnings = [];
  const names = [...rows.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const r = rows.get(name);
    let extra = 0;
    for (const n of r.keys.values()) if (n > 1) extra += n - 1;
    if (f === null) {
      out.push({ layer: name, off: r.off, frozen: r.frozen, open_length: null, closed_perimeter: null, area: null, area_excluded: null, blocks: null, entities: null, approx: null, dropped: null });
      continue;
    }
    if (extra > 0) warnings.push({ code: 'possible_duplicate', detail: { layer: name, count: extra } });
    const blocks = [...r.blocks.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const { block, n } of r.ikeys.values()) if (n > 1) warnings.push({ code: 'possible_duplicate', detail: { layer: name, count: n - 1, block } });
    out.push({ layer: name, off: r.off, frozen: r.frozen, open_length: r.open * f, closed_perimeter: r.perim * f, area: r.area * f * f,
      area_excluded: r.excluded, blocks, entities: r.entities, approx: r.approx, dropped: r.dropped });
  }
  return { layers: out, warnings };
}

module.exports = { layerTable, PARSER_VERSION };
