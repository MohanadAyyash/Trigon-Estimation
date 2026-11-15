// Totals of a user's selection of flattened DXF entities (by handle), in drawing units. Pure: the select worker runs it
// on the full parse cache, never the main thread.
//   open_length      Σ length of kind 'open'
//   closed_perimeter Σ length of kind 'closed', HATCH excluded (a hatch is an area only, as in layerTable)
//   area             Σ area of kind 'closed'; a closed shape with no area (self-intersecting…) is counted in area_null
//   count            Σ count of kind 'insert' (an MINSERT counts rows × cols)
// Selected entities that do not apply to the metric are counted in `skipped`; dropped placeholders (shapes the parser
// could not measure) in `dropped` (their count, as layerTable does), whatever the metric. `approx` and `duplicates`
// (extra copies by geomKey) are counted among the entities that contributed (`used`), since only those change the total.
// The flat array is walked in its own order, so a selection of a whole layer adds up exactly as the layer table does.
// A handle that names several flat entries (a malformed file) selects all of them.
const METRICS = ['open_length', 'closed_perimeter', 'area', 'count'];

function selectionTotals(flat, handles, metric) {
  if (!METRICS.includes(metric)) throw new Error('unknown metric ' + metric);
  const want = new Set(handles), found = new Set(), usedSet = new Set();
  const keys = new Set(), layers = new Map(), blocks = new Map();
  const out = { base: 0, used: 0, dropped: 0, area_null: 0, approx: 0, duplicates: 0, unknown: 0, skipped: 0, by_layer: null, blocks: [], used_handles: [] };
  for (const e of flat) {
    if (!want.has(e.handle)) continue;
    found.add(e.handle);
    if (e.kind === 'dropped') { out.dropped += e.count; continue; }
    let v = null;
    if (metric === 'open_length') { if (e.kind === 'open') v = e.length; }
    else if (metric === 'closed_perimeter') { if (e.kind === 'closed' && e.type !== 'HATCH') v = e.length; }
    else if (metric === 'area') {
      if (e.kind === 'closed') { if (e.area === null) { out.area_null++; continue; } v = e.area; }
    } else if (e.kind === 'insert') v = e.count;
    if (v === null) { out.skipped++; continue; }
    out.base += v; out.used++;
    if (e.approx) out.approx++;
    if (keys.has(e.geomKey)) out.duplicates++; else keys.add(e.geomKey);
    layers.set(e.layer, (layers.get(e.layer) || 0) + 1);
    if (e.kind === 'insert') {
      const k = e.layer + '\0' + e.block, b = blocks.get(k);
      if (b) b.count += e.count; else blocks.set(k, { layer: e.layer, block: e.block, count: e.count });
    }
    if (!usedSet.has(e.handle)) { usedSet.add(e.handle); out.used_handles.push(e.handle); }
  }
  for (const h of handles) if (!found.has(h)) out.unknown++;
  out.by_layer = Object.fromEntries(layers);   // own properties, whatever the layer is called
  out.blocks = [...blocks.values()];
  return out;
}

module.exports = { selectionTotals, METRICS };
