// Display file for the drawing viewer: flatten(doc, { withSegs: true }) -> one compact little-endian buffer.
// Approximate on purpose (Float32 points relative to their entity's own origin, arcs as chords): for drawing and hit
// testing only, never for a saved quantity (those come from the exact parse cache).
//
//   uint32 headerLen, UTF-8 JSON header { version: 2, origin, bbox, layers: [{ name, color, off, frozen }], handles, blocks }
//     origin = the drawing's bbox min (for fitting the view); bbox = the drawing's extent (world, drawing units)
//   zero padding to 4 bytes
//   Uint32 layer[n], Uint32 start[n], Uint32 count[n]       (start/count in points, into pts)
//   Uint8 kind[n]  0 open, 1 closed, 2 insert marker, 3 text anchor, 4 dropped (no points)
//   zero padding to 4 bytes
//   Uint32 block[n]  (index into blocks, or 0xFFFFFFFF)
//   zero padding to 8 bytes
//   Float64 len[n], Float64 area[n]  (drawing units; NaN when null). len is what a selection's preview adds up, as
//     lib/dxf/select.js does: a HATCH has len NaN (an area only, never a perimeter); an insert marker (kind 2) has
//     len = its count (rows × cols for an MINSERT)
//   Float64 eo[2n]  each entity's own origin (world): its bbox min; an insert marker's or text anchor's own point;
//                   the header origin for an entity with no points
//   Float32 pts[2N] (x - eo x, y - eo y) of the entity the point belongs to; world = eo + pts, in Float64.
//     Precision depends on the entity's own extent, so a stray far-away entity never coarsens georeferenced geometry.
// Path break: an entity with several paths (a HATCH with several boundary loops) separates them in pts with one
// NaN,NaN point pair. count includes the break points; there is never a break at the start or the end of an entity, and
// no segment is drawn, hit or snapped across a break. In a closed entity (kind 1) every path is its own closed ring,
// and its closing point is not repeated. Within one path, consecutive segments are joined: a gap between a segment's
// end and the next one's start (only possible within float noise or a tolerated hatch gap) is bridged for display.
// More than maxPoints points in all (default 20,000,000) -> Error('drawing too large to display').
'use strict';
const TAU = 2 * Math.PI;
const CHORD_REL = 0.002;                  // chord error ≤ 0.002 × radius (ellipses: major radius)
const MIN_TURN = 4, MAX_TURN = 256;       // segments per full turn
const STEP = TAU / Math.min(MAX_TURN, Math.max(MIN_TURN, Math.ceil(TAU / (2 * Math.acos(1 - CHORD_REL)))));
const NONE = 0xFFFFFFFF;
const KIND = { open: 0, closed: 1, insert: 2, text: 3, dropped: 4 };
const MAX_POINTS = 20000000;
const NEEDS_SEGS = 'buildRender needs flatten(doc, { withSegs: true })';

function buildRender(doc, flat, opts) {
  const maxPoints = (opts && opts.maxPoints) || MAX_POINTS;
  const n = flat.length;
  // layers: the LAYER table first, then layers only used by entities
  const layers = [], layerIdx = new Map();
  const addLayer = (name, color, off, frozen) => {
    if (layerIdx.has(name)) return;
    layerIdx.set(name, layers.length);
    layers.push({ name, color: Number.isFinite(color) ? Math.abs(color) : 7, off: !!off, frozen: !!frozen });
  };
  for (const l of doc.layers || []) addLayer(l.name, l.color, l.off, l.frozen);
  const blocks = [], blockIdx = new Map();
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of flat) {
    addLayer(e.layer, 7, false, false);
    if (e.block !== null && e.block !== undefined && !blockIdx.has(e.block)) { blockIdx.set(e.block, blocks.length); blocks.push(e.block); }
    const b = e.bbox;
    if (!b) continue;
    if (b[0] < bbox[0]) bbox[0] = b[0]; if (b[1] < bbox[1]) bbox[1] = b[1];
    if (b[2] > bbox[2]) bbox[2] = b[2]; if (b[3] > bbox[3]) bbox[3] = b[3];
  }
  if (bbox[0] === Infinity) bbox.fill(0);
  const x0 = bbox[0], y0 = bbox[1];

  // points, relative to their entity's origin in Float64 first (exact subtraction), then stored as Float32
  let pts = new Float32Array(Math.max(16, Math.min(4 * n, 2 * maxPoints))), np = 0;   // np = number of floats written
  let ex = x0, ey = y0;   // the current entity's origin
  const pushRaw = (x, y) => {
    if (np + 2 > 2 * maxPoints) throw new Error('drawing too large to display');
    if (np + 2 > pts.length) { const g = new Float32Array(Math.min(pts.length * 2, 2 * maxPoints)); g.set(pts); pts = g; }
    pts[np++] = x; pts[np++] = y;
  };
  const push = (x, y) => pushRaw(x - ex, y - ey);
  const layerA = new Uint32Array(n), startA = new Uint32Array(n), countA = new Uint32Array(n), kindA = new Uint8Array(n), blockA = new Uint32Array(n);
  const lenA = new Float64Array(n), areaA = new Float64Array(n), eoA = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const e = flat[i], k = KIND[e.kind];
    if (k === undefined) throw new Error('render: unknown entity kind ' + e.kind);
    if ((k === 0 || k === 1) && (!Array.isArray(e.segs) || !Array.isArray(e.pathLens))) throw new Error(NEEDS_SEGS);
    if (k === 2 && !Array.isArray(e.ins)) throw new Error(NEEDS_SEGS);
    if (k === 2) { ex = e.ins[0]; ey = e.ins[1]; }
    else if (k === 3 || ((k === 0 || k === 1) && e.segs.length)) { ex = e.bbox[0]; ey = e.bbox[1]; }
    else { ex = x0; ey = y0; }
    eoA[2 * i] = ex; eoA[2 * i + 1] = ey;
    layerA[i] = layerIdx.get(e.layer); kindA[i] = k;
    blockA[i] = e.block !== null && e.block !== undefined ? blockIdx.get(e.block) : NONE;
    lenA[i] = k === 2 ? e.count : e.type === 'HATCH' || e.length === null || e.length === undefined ? NaN : e.length;
    areaA[i] = e.area === null || e.area === undefined ? NaN : e.area;
    const s0 = np / 2;
    startA[i] = s0;
    if (k === 2) push(e.ins[0], e.ins[1]);
    else if (k === 3) push(e.bbox[0], e.bbox[1]);
    else if (k !== 4) {
      const lens = e.pathLens;
      let si = 0;
      for (const pl of lens) {
        if (!pl) continue;
        if (np / 2 > s0) pushRaw(NaN, NaN);   // path break between paths
        const p0 = np / 2;
        let lx = NaN, ly = NaN;   // last point pushed (Float64): a segment that starts there continues the run
        for (let q = si; q < si + pl; q++) {
          const s = e.segs[q];
          if (s.p0[0] !== lx || s.p0[1] !== ly) push(s.p0[0], s.p0[1]);
          if (s.t === 'A' || s.t === 'E') {
            const m = Math.max(1, Math.ceil(Math.abs(s.sw) / STEP - 1e-9));
            for (let j = 1; j < m; j++) {
              const f = j / m;
              if (s.t === 'A') { const a = s.a0 + s.sw * f; push(s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)); }
              else { const t = s.t0 + s.sw * f, c = Math.cos(t), sn = Math.sin(t); push(s.c[0] + s.M[0] * c + s.N[0] * sn, s.c[1] + s.M[1] * c + s.N[1] * sn); }
            }
          }
          push(s.p1[0], s.p1[1]); lx = s.p1[0]; ly = s.p1[1];
        }
        si += pl;
        // closed: the renderer closes each ring, so a last point equal to the path's first is not repeated
        if (k === 1 && np / 2 - p0 > 1 && pts[np - 2] === pts[2 * p0] && pts[np - 1] === pts[2 * p0 + 1]) np -= 2;
      }
    }
    countA[i] = np / 2 - s0;
  }

  const header = { version: 2, origin: [x0, y0], bbox, layers, handles: flat.map(e => e.handle), blocks };
  const json = Buffer.from(JSON.stringify(header), 'utf8'), hl = json.length;
  const up = (v, m) => Math.ceil(v / m) * m;
  const oIdx = up(4 + hl, 4), oKind = oIdx + 12 * n, oBlock = up(oKind + n, 4), oF64 = up(oBlock + 4 * n, 8), oPts = oF64 + 32 * n;
  const buf = Buffer.alloc(oPts + 4 * np), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);   // zero-filled: padding is 0
  dv.setUint32(0, hl, true);
  json.copy(buf, 4);
  let o = oIdx;
  for (const a of [layerA, startA, countA]) for (let i = 0; i < n; i++) { dv.setUint32(o, a[i], true); o += 4; }
  buf.set(kindA, oKind);
  o = oBlock;
  for (let i = 0; i < n; i++) { dv.setUint32(o, blockA[i], true); o += 4; }
  o = oF64;
  for (const a of [lenA, areaA, eoA]) for (let i = 0; i < a.length; i++) { dv.setFloat64(o, a[i], true); o += 8; }
  for (let i = 0; i < np; i++) { dv.setFloat32(o, pts[i], true); o += 4; }
  return buf;
}

module.exports = { buildRender, MAX_POINTS };
