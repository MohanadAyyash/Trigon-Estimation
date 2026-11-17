// Manual take-off measurements (batch 3, plan Task 4): lengths, areas with holes, rectangles and counts drawn by hand on a
// DXF (drawing units), a PDF page (points) or an image (pixels). Pure: no DOM, no Node APIs, no I/O.
// One file, two users: the server computes every saved quantity with manualQty (modules/drawings.js, require), and the
// browser loads this same file as a plain script (window.TakeoffManual, served at /lib/takeoff/manual.js by server.js)
// for the live preview only. Keep it a single self-contained UMD script.
//
// geom (coordinates in drawing/page units, each point [x, y], finite, |v| ≤ 1e9, at most 10000 points: hand-drawn):
//   { tool: 'line', pts: [p, q] } | { tool: 'polyline', pts: [p, …] } (≥ 2 points)
//   { tool: 'area', outer: [p, …], holes: [[p, …], …] } (outer ≥ 3, each hole ≥ 3; rings are closed implicitly)
//   { tool: 'rect', p1, p2 } (opposite corners)       { tool: 'count', pts: [p, …] } (≥ 1)
// manualQty order: 1. the shape (length; area − Σ hole areas; perimeter of outer + holes; number of points),
// 2. × scale (metres per unit; an area × scale²; a count takes none), 3. × width × depth, 4. × factor, 5. deduct → negative.
// Units as batch 1: m, m2, m3, nr.
'use strict';
(function () {
const MAX_COORD = 1e9, MAX_POINTS = 10000, TAU = 2 * Math.PI;
const FIELDS = { line: ['pts'], polyline: ['pts'], area: ['outer', 'holes'], rect: ['p1', 'p2'], count: ['pts'] };

// ---- input checks ----
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPt = p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD);
function checkPt(p, what) { if (!isPt(p)) throw new Error(what + ' must be a point [x, y] (finite numbers, at most 1e9)'); }
function checkList(pts, min, what) {
  if (!Array.isArray(pts) || pts.length < min) throw new Error(`${what} must be a list of at least ${min} point${min > 1 ? 's' : ''}`);
}
const same = (p, q) => p[0] === q[0] && p[1] === q[1];
function noRepeats(pts, closed, what) {
  for (let i = 1; i < pts.length; i++) if (same(pts[i], pts[i - 1])) throw new Error(`${what}: repeated point ${i + 1} (the same as the point before it)`);
  if (closed && same(pts[0], pts[pts.length - 1])) throw new Error(`${what}: repeated point (the last point repeats the first; the outline closes by itself)`);
}
// count points are all distinct: the same point twice counts one item twice
function distinct(pts, what) {
  const seen = new Map();
  pts.forEach((p, i) => {
    const k = p[0] + ',' + p[1];
    if (seen.has(k)) throw new Error(`${what}: repeated point ${i + 1} (the same as point ${seen.get(k) + 1})`);
    seen.set(k, i);
  });
}
// a ring must not double back along itself at a vertex (a spike or slit: the next edge runs back along the previous one,
// cross ≈ 0 and dot < 0); its area would be right but its perimeter would count the spike twice
function noSpikes(pts, what) {
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    if (ux * vx + uy * vy < 0 && Math.abs(ux * vy - uy * vx) <= 1e-9 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) throw new Error(`${what} must not self-intersect (it doubles back along itself at point ${i + 1})`);
  }
}

// the rings of a closed shape (a rect as its 4 corners)
function ringsOf(g) {
  if (g.tool !== 'rect') return { outer: g.outer, holes: g.holes || [] };
  const x0 = Math.min(g.p1[0], g.p2[0]), y0 = Math.min(g.p1[1], g.p2[1]), x1 = Math.max(g.p1[0], g.p2[0]), y1 = Math.max(g.p1[1], g.p2[1]);
  return { outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: [] };
}
// every point of a shape, in order (a rect: its two corners)
function points(g) {
  if (g.tool === 'rect') return [g.p1, g.p2];
  if (g.tool === 'area') return g.outer.concat(...(g.holes || []));
  return g.pts;
}
const pointCount = g => g.tool === 'rect' ? 2 : g.tool === 'area' ? g.outer.length + (g.holes || []).reduce((s, h) => s + h.length, 0) : g.pts.length;
// the point that picks the calibration (page or region): the first one drawn
const firstPoint = g => g.tool === 'rect' ? g.p1 : g.tool === 'area' ? g.outer[0] : g.pts[0];

// ---- crossings: the batch-1 rules of lib/dxf/geometry.js crossings() ----
// Within one ring: a proper crossing of two edges; a vertex through which two passages interleave (a crossing through a
// vertex); a vertex on the inside of another edge whose passage crosses it (T); and the conservative rule that any
// shared collinear stretch of two non-adjacent edges is a crossing. Touching at a vertex without crossing is not one.
// Between two different rings (holes): any contact at all (they must be strictly apart).
// Returns { self: Set of ring indexes that cross themselves, contacts: [[i, j], …] with i < j }.
function side(a, b, c) { const ux = b[0] - a[0], uy = b[1] - a[1]; return (ux * (c[1] - a[1]) - uy * (c[0] - a[0])) / Math.hypot(ux, uy); }
function properCross(a, b, c, d) {
  const tol = 1e-9 * (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - c[0], d[1] - c[1]));
  const s1 = side(a, b, c), s2 = side(a, b, d);
  if (!((s1 > tol && s2 < -tol) || (s1 < -tol && s2 > tol))) return false;
  const s3 = side(c, d, a), s4 = side(c, d, b);
  return (s3 > tol && s4 < -tol) || (s3 < -tol && s4 > tol);
}
// two passages through one contact point P cross when their edge directions interleave in cyclic order around P; a
// shared direction counts as touching, not crossing
function interleaved(P, u1, u2, v1, v2) {
  const ang = q => Math.atan2(q[1] - P[1], q[0] - P[0]);
  const a1 = ang(u1), a2 = ang(u2), b1 = ang(v1), b2 = ang(v2), eps = 1e-9;
  const rel = b => ((b - a1) % TAU + TAU) % TAU, span = rel(a2);
  for (const b of [b1, b2]) { const r = rel(b); if (r < eps || TAU - r < eps || Math.abs(r - span) < eps) return false; }
  return (rel(b1) < span) !== (rel(b2) < span);
}
function crossings(rings) {
  const o = rings[0][0], items = [];
  let big = 0; const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const pts of rings) for (const p of pts) {
    big = Math.max(big, Math.abs(p[0]), Math.abs(p[1]));
    const x = p[0] - o[0], y = p[1] - o[1];
    bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y);
  }
  const tol = 1e-9 * Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) + 8 * Number.EPSILON * big;
  const d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  rings.forEach((pts, li) => {
    const q = [];   // consecutive points closer than tol are one vertex
    for (const p of pts) { const r = [p[0] - o[0], p[1] - o[1]]; if (!q.length || d2(r, q[q.length - 1]) > tol) q.push(r); }
    while (q.length > 1 && d2(q[0], q[q.length - 1]) <= tol) q.pop();
    const n = q.length;
    if (n < 2) return;
    for (let k = 0; k < n; k++) {
      const a = q[k], b = q[(k + 1) % n];
      items.push({ e: true, a, b, li, k, n, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
      if (n >= 3) items.push({ e: false, p: a, prev: q[(k - 1 + n) % n], next: b, li, x0: a[0], x1: a[0], y0: a[1], y1: a[1] });
    }
  });
  const onInterior = (v, e) => {   // vertex strictly inside an edge (not at its ends)
    if (d2(v, e.a) <= tol || d2(v, e.b) <= tol) return false;
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], l2 = dx * dx + dy * dy, t = ((v[0] - e.a[0]) * dx + (v[1] - e.a[1]) * dy) / l2;
    return t > 0 && t < 1 && Math.abs(dx * (v[1] - e.a[1]) - dy * (v[0] - e.a[0])) / Math.sqrt(l2) <= tol;
  };
  const collinearOverlap = (A, B) => {
    const dx = A.b[0] - A.a[0], dy = A.b[1] - A.a[1], l = Math.hypot(dx, dy);
    const off = p => Math.abs(dx * (p[1] - A.a[1]) - dy * (p[0] - A.a[0])) / l, along = p => ((p[0] - A.a[0]) * dx + (p[1] - A.a[1]) * dy) / l;
    if (off(B.a) > tol || off(B.b) > tol) return false;
    const b0 = along(B.a), b1 = along(B.b);
    return Math.min(l, Math.max(b0, b1)) - Math.max(0, Math.min(b0, b1)) > tol;
  };
  // distance from a point to a segment
  const ptSeg = (p, e) => {
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - e.a[0] - t * dx, p[1] - e.a[1] - t * dy);
  };
  const contact = (A, B) => properCross(A.a, A.b, B.a, B.b) || ptSeg(A.a, B) <= tol || ptSeg(A.b, B) <= tol || ptSeg(B.a, A) <= tol || ptSeg(B.b, A) <= tol;
  // sweep along the axis on which the edges extend less (a comb of long horizontal teeth sweeps in y): the same pairs are
  // tested, only fewer bbox-disjoint ones are visited
  let sx = 0, sy = 0;
  for (const it of items) if (it.e) { sx += it.x1 - it.x0; sy += it.y1 - it.y0; }
  if (sy < sx) for (const it of items) { [it.x0, it.y0] = [it.y0, it.x0]; [it.x1, it.y1] = [it.y1, it.x1]; }
  items.forEach(it => { it.x0 -= tol; it.x1 += tol; });
  items.sort((p, q) => p.x0 - q.x0);
  const self = new Set(), pairs = new Map();
  for (let i = 0; i < items.length; i++) {
    const A = items[i];
    for (let j = i + 1; j < items.length && items[j].x0 <= A.x1; j++) {
      const B = items[j];
      if (B.y0 - tol > A.y1 || B.y1 + tol < A.y0) continue;
      if (A.li === B.li) {
        if (self.has(A.li)) continue;
        let hit = false;
        if (A.e && B.e) {
          const adjacent = (A.k + 1) % A.n === B.k || (B.k + 1) % B.n === A.k;
          hit = properCross(A.a, A.b, B.a, B.b) || (!adjacent && collinearOverlap(A, B));
        } else if (!A.e && !B.e) hit = d2(A.p, B.p) <= tol && interleaved(A.p, A.prev, A.next, B.prev, B.next);
        else {
          const v = A.e ? B : A, e = A.e ? A : B;
          hit = onInterior(v.p, e) && interleaved(v.p, v.prev, v.next, e.a, e.b);
        }
        if (hit) self.add(A.li);
      } else if (A.e && B.e) {
        const key = Math.min(A.li, B.li) + ',' + Math.max(A.li, B.li);
        if (!pairs.has(key) && contact(A, B)) pairs.set(key, [Math.min(A.li, B.li), Math.max(A.li, B.li)]);
      }
    }
  }
  return { self, contacts: [...pairs.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]) };
}
function pointIn(pt, poly) {   // even-odd ray cast
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- measures (relative to an origin, so georeferenced coordinates keep their precision) ----
function ringArea(r, o) {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    s += (a[0] - o[0]) * (b[1] - o[1]) - (b[0] - o[0]) * (a[1] - o[1]);
  }
  return Math.abs(s) / 2;
}
function pathLength(pts, closed) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed) s += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  return s;
}

// throws an Error with a clear message unless geom is a well-formed shape that can be measured
function validateGeom(g) {
  if (!isObj(g)) throw new Error('geom must be an object { tool, … }');
  if (typeof g.tool !== 'string' || !Object.hasOwn(FIELDS, g.tool)) throw new Error('geom tool must be line, polyline, area, rect or count');
  for (const k of Object.keys(g)) if (k !== 'tool' && !FIELDS[g.tool].includes(k)) throw new Error('unknown field in geom: ' + k);
  if (g.tool === 'rect') {
    checkPt(g.p1, 'p1'); checkPt(g.p2, 'p2');
    if (g.p1[0] === g.p2[0] || g.p1[1] === g.p2[1]) throw new Error('a rect must have a size > 0 (width and height)');
    return;
  }
  if (g.tool !== 'area') {
    checkList(g.pts, g.tool === 'count' ? 1 : 2, 'pts');
    if (g.tool === 'line' && g.pts.length !== 2) throw new Error('a line has exactly 2 points (use a polyline for more)');
    if (g.pts.length > MAX_POINTS) throw new Error(`too many points: at most ${MAX_POINTS}`);
    g.pts.forEach((p, i) => checkPt(p, `point ${i + 1}`));
    noRepeats(g.pts, false, g.tool);
    if (g.tool === 'count') distinct(g.pts, 'count');
    return;
  }
  checkList(g.outer, 3, 'outer');
  if (g.holes !== undefined && !Array.isArray(g.holes)) throw new Error('holes must be a list of outlines');
  const holes = g.holes || [];
  holes.forEach((h, i) => checkList(h, 3, `hole ${i + 1}`));
  if (pointCount(g) > MAX_POINTS) throw new Error(`too many points: at most ${MAX_POINTS}`);
  g.outer.forEach((p, i) => checkPt(p, `outer point ${i + 1}`));
  holes.forEach((h, j) => h.forEach((p, i) => checkPt(p, `hole ${j + 1} point ${i + 1}`)));
  noRepeats(g.outer, true, 'outer');
  holes.forEach((h, j) => noRepeats(h, true, `hole ${j + 1}`));
  noSpikes(g.outer, 'the area outline');
  holes.forEach((h, j) => noSpikes(h, `hole ${j + 1}`));
  const rings = [g.outer, ...holes], x = crossings(rings);
  rings.forEach((r, i) => { if (x.self.has(i)) throw new Error(i ? `hole ${i} must not self-intersect` : 'the area outline must not self-intersect'); });
  for (const [i, j] of x.contacts) throw new Error(i === 0 ? `hole ${j} touches or crosses the outline: a hole must lie strictly inside it` : `holes ${i} and ${j} touch or cross`);
  holes.forEach((h, j) => { if (!pointIn(h[0], g.outer)) throw new Error(`hole ${j + 1} lies outside the outline`); });
  holes.forEach((h, j) => holes.forEach((o, i) => { if (i !== j && pointIn(h[0], o)) throw new Error(`hole ${j + 1} lies inside hole ${i + 1}`); }));
  const o = g.outer[0];
  if (!(ringArea(g.outer, o) > 0)) throw new Error('the area outline has no area');
  holes.forEach((h, j) => { if (!(ringArea(h, o) > 0)) throw new Error(`hole ${j + 1} has no area`); });
}

// validated === true: the caller has already run validateGeom on this same geom (the server validates once per request,
// R13, and rescales stored geometry that was validated when saved). Anything else validates it first.
// { base, unit, qty, qty_unit, metric, perimeter? } — base: the shape in metres (m, m2) or a count, before width/depth/
// factor; qty: the saved quantity (negative for a deduction); perimeter (area and rect): outer + holes in metres
function manualQty(g, opts, validated) {
  if (validated !== true) validateGeom(g);
  const o = opts || {};
  const pos = k => {
    const v = o[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) throw new Error(k + ' must be a number > 0');
    return v;
  };
  const width = pos('width'), depth = pos('depth'), f = pos('factor'), factor = f === null ? 1 : f;
  if (o.deduct !== undefined && o.deduct !== null && typeof o.deduct !== 'boolean') throw new Error('deduct must be true or false');
  const closed = g.tool === 'area' || g.tool === 'rect';
  if (o.metric !== undefined && o.metric !== null) {
    if (!closed) throw new Error('metric applies to an area or a rect only');
    if (o.metric !== 'area' && o.metric !== 'perimeter') throw new Error('metric must be area or perimeter');
  }
  const metric = g.tool === 'count' ? 'count' : closed ? (o.metric || 'area') : 'length';
  let scale = null;
  if (metric !== 'count') {
    scale = o.scale;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || !(scale > 0)) throw new Error('scale must be a number > 0 (metres per unit)');
  }
  // m → ×width m2 → ×width×depth m3; m2 → ×depth m3; nr takes neither
  if (metric === 'count' && (width !== null || depth !== null)) throw new Error('width and depth do not apply to a count');
  if (metric === 'area' && width !== null) throw new Error('an area takes depth, not width');
  if ((metric === 'length' || metric === 'perimeter') && depth !== null && width === null) throw new Error('depth needs a width');
  let base, perimeter;
  if (metric === 'count') base = g.pts.length;
  else if (metric === 'length') base = pathLength(g.pts, false) * scale;
  else {
    const { outer, holes } = ringsOf(g), org = outer[0];
    perimeter = (pathLength(outer, true) + holes.reduce((s, h) => s + pathLength(h, true), 0)) * scale;
    base = metric === 'perimeter' ? perimeter : (ringArea(outer, org) - holes.reduce((s, h) => s + ringArea(h, org), 0)) * scale * scale;
  }
  let qty = base * (width === null ? 1 : width) * (depth === null ? 1 : depth) * factor;
  if (!Number.isFinite(base) || !Number.isFinite(qty)) throw new Error('the quantity is out of range');
  if (!(base > 0) || !(qty > 0)) throw new Error('nothing to measure: the shape is too small at this scale');
  if (o.deduct === true) qty = -qty;
  const unit = metric === 'count' ? 'nr' : metric === 'area' ? 'm2' : 'm';
  const qty_unit = metric === 'count' ? 'nr' : ['m', 'm2', 'm3'][(metric === 'area' ? 1 : 0) + (width !== null) + (depth !== null)];
  return closed ? { base, unit, qty, qty_unit, metric, perimeter } : { base, unit, qty, qty_unit, metric };
}

// ---- identical geometry (the overlap check): coordinates rounded to 1e-6; a closed ring starts at its smallest vertex
// and its direction does not matter; an open path either way round; holes and count points in any order ----
const r6 = v => Math.round(v * 1e6);
const keyOf = pts => pts.map(p => r6(p[0]) + ',' + r6(p[1])).join(';');
function ringKey(ring) {
  const p = ring.map(q => [r6(q[0]), r6(q[1])]), n = p.length;
  let min = p[0];
  for (const q of p) if (q[0] < min[0] || (q[0] === min[0] && q[1] < min[1])) min = q;
  let best = null;
  for (let i = 0; i < n; i++) {
    if (p[i][0] !== min[0] || p[i][1] !== min[1]) continue;
    const fwd = [], rev = [];
    for (let k = 0; k < n; k++) { fwd.push(p[(i + k) % n]); rev.push(p[(i - k + n) % n]); }
    for (const s of [fwd, rev].map(x => x.map(q => q[0] + ',' + q[1]).join(';'))) if (best === null || s < best) best = s;
  }
  return best;
}
function geomKey(g) {
  if (g.tool === 'line' || g.tool === 'polyline') { const a = keyOf(g.pts), b = keyOf(g.pts.slice().reverse()); return 'path:' + (a < b ? a : b); }
  if (g.tool === 'count') return 'count:' + g.pts.map(p => r6(p[0]) + ',' + r6(p[1])).sort().join(';');
  const { outer, holes } = ringsOf(g);
  return 'area:' + ringKey(outer) + holes.map(ringKey).sort().map(h => '|' + h).join('');
}

const TakeoffManual = { MAX_POINTS, manualQty, validateGeom, geomKey, firstPoint, points, pointCount };
if (typeof module !== 'undefined' && module.exports) module.exports = TakeoffManual; else window.TakeoffManual = TakeoffManual;
})();
