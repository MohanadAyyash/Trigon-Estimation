// Drawing replacement (batch 4, plan Task 2; spec 6.5): what each measurement of the old drawing becomes on the new one.
// Pure decisions only: modules/drawings.js reads the new summary and cache, totals selections in the worker and computes
// every new qty with the creation code (dxfQty, selectionBase, manualQty); these functions say where the base comes
// from, whether the measurement still matches, and its status, reason and options in the before/after table.
//   same / changed  the same layer metric, block count or selection (every handle with its stored geomKey) is there
//   review          a manual shape: carried over unchanged, to be checked (not blocking)
//   blocked         needs a resolution before accept: delete, relink (layer/block to a name in the new drawing) or
//                   keep_matched (a selection: only the handles still there with an identical geomKey)

const pos = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

// dxf_layer: the same metric on the same layer name of the new layer table (metres). { base } or
// { reason: 'layer_missing' | 'layer_empty', relink_choices: the other layers with that metric > 0 }.
function layerMatch(layers, m) {
  const l = layers.find(x => x.layer === m.layer);
  if (l && pos(l[m.metric])) return { base: l[m.metric] };
  return { reason: l ? 'layer_empty' : 'layer_missing', relink_choices: layers.filter(x => x.layer !== m.layer && pos(x[m.metric])).map(x => x.layer) };
}

// dxf_blocks: the same block name on the same layer, top inserts plus nested ones when the measurement counted them.
// { base } or { reason: 'block_missing', relink_choices: the other block names of that layer with a count > 0 }.
function blockMatch(layers, m) {
  const l = layers.find(x => x.layer === m.layer), blocks = (l && l.blocks) || [];
  const count = b => b.top + (m.nested ? b.nested : 0);
  const b = blocks.find(x => x.name === m.block);
  if (b && pos(count(b))) return { base: count(b) };
  return { reason: 'block_missing', relink_choices: blocks.filter(x => x.name !== m.block && pos(count(x))).map(x => x.name).sort((a, c) => (a < c ? -1 : a > c ? 1 : 0)) };
}

// dxf_selection: stored [{ handle, geom_key }] against current (Map handle → geomKey of the new drawing's entities that
// still measure under the selection's metric) and unknown (how many stored handles the new drawing does not have).
// A handle matches only with the identical geomKey, so a handle reused for other geometry never keeps its old quantity;
// a stored row without a geomKey never matches. reason when not all match: handles_missing if any handle is gone,
// otherwise geometry_changed.
function selectionMatch(stored, current, unknown) {
  const matched = stored.filter(h => h.geom_key !== null && h.geom_key !== undefined && current.get(h.handle) === h.geom_key).map(h => h.handle);
  const all = matched.length === stored.length;
  return { all, matched, reason: all ? null : unknown > 0 ? 'handles_missing' : 'geometry_changed' };
}

// one row of the before/after table. r: { new_qty } (dxf, matched) | { review: true, new_qty } (manual) |
// { reason, relink_choices?, keep_matched_qty? } (blocked)
function item(m, r) {
  const it = { measurement_id: m.id, row_id: m.row_id, tool: m.tool, label: m.label, old_qty: m.qty, new_qty: null, qty_unit: m.qty_unit };
  if (r.reason !== undefined) {
    const relink = m.tool === 'dxf_layer' || m.tool === 'dxf_blocks', keep = m.tool === 'dxf_selection';
    const choices = relink ? r.relink_choices || [] : null, kq = keep && r.keep_matched_qty !== undefined ? r.keep_matched_qty : null;
    Object.assign(it, { status: 'blocked', reason: r.reason, options: ['delete', ...(relink && choices.length ? ['relink'] : []), ...(kq !== null ? ['keep_matched'] : [])] });
    if (relink) it.relink_choices = choices;
    if (keep) it.keep_matched_qty = kq;
    return it;
  }
  it.new_qty = r.new_qty;
  if (r.review) return Object.assign(it, { status: 'review', reason: 'manual_check', options: ['mark_reviewed'] });
  return Object.assign(it, { status: r.new_qty === m.qty ? 'same' : 'changed', options: [] });
}

// per linked row (in the order first seen): old = Σ old_qty and new = Σ new_qty of this drawing's items on it; new is
// null while one of them is blocked (it depends on the resolution)
function rowTotals(items) {
  const rows = new Map();
  for (const it of items) {
    if (it.row_id === null) continue;
    const t = rows.get(it.row_id) || { row_id: it.row_id, old: 0, new: 0 };
    t.old += it.old_qty;
    t.new = t.new === null || it.status === 'blocked' ? null : t.new + it.new_qty;
    rows.set(it.row_id, t);
  }
  return [...rows.values()];
}

module.exports = { layerMatch, blockMatch, selectionMatch, item, rowTotals };
