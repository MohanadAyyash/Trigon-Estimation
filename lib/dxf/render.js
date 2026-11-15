// Display file for the drawing viewer: flatten(doc, { withSegs: true }) -> one compact little-endian buffer.
// Approximate on purpose (Float32 points relative to the drawing origin, arcs as chords): for drawing and hit testing
// only, never for a saved quantity (those come from the exact parse cache).
//
//   uint32 headerLen, UTF-8 JSON header { version, origin, bbox, layers: [{ name, color, off, frozen }], handles, blocks }
//   padding to 4 bytes
//   Uint32 layer[n], Uint32 start[n], Uint32 count[n]       (start/count in points, into pts)
//   Uint8 kind[n]  0 open, 1 closed, 2 insert marker, 3 text anchor, 4 dropped (no points)
//   padding to 4 bytes
//   Uint32 block[n]  (index into blocks, or 0xFFFFFFFF)
//   Float64 len[n], Float64 area[n]  (drawing units; NaN when null)
//   Float32 pts[2N]  (x - origin x, y - origin y)
// Path break: an entity with several paths (a HATCH with several boundary loops) separates them in pts with one
// NaN,NaN point pair. count includes the break points; there is never a break at the start or the end of an entity, and
// no segment is drawn, hit or snapped across a break. In a closed entity (kind 1) every path is its own closed ring,
// and its closing point is not repeated.
// The JSON header is padded with spaces so that the Float64 section starts on an 8-byte boundary.
'use strict';
const TAU = 2 * Math.PI;
const CHORD_REL = 0.002;                  // chord error ≤ 0.002 × radius (ellipses: major radius)
const MIN_TURN = 4, MAX_TURN = 256;       // segments per full turn
const STEP = TAU / Math.min(MAX_TURN, Math.max(MIN_TURN, Math.ceil(TAU / (2 * Math.acos(1 - CHORD_REL)))));
const NONE = 0xFFFFFFFF;
const KIND = { open: 0, closed: 1, insert: 2, text: 3, dropped: 4 };

function buildRender(doc, flat) {
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

  // points, relative to the origin in Float64 first (exact subtraction), then stored as Float32
  let pts = new Float32Array(Math.max(16, 4 * n)), np = 0;   // np = number of floats written
  const pushRaw = (x, y) => {
    if (np + 2 > pts.length) { const g = new Float32Array(pts.length * 2); g.set(pts); pts = g; }
    pts[np++] = x; pts[np++] = y;
  };
  const push = (x, y) => pushRaw(x - x0, y - y0);
  const layerA = new Uint32Array(n), startA = new Uint32Array(n), countA = new Uint32Array(n), kindA = new Uint8Array(n), blockA = new Uint32Array(n);
  const lenA = new Float64Array(n), areaA = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const e = flat[i], k = KIND[e.kind];
    if (k === undefined) throw new Error('render: unknown entity kind ' + e.kind);
    layerA[i] = layerIdx.get(e.layer); kindA[i] = k;
    blockA[i] = e.block !== null && e.block !== undefined ? blockIdx.get(e.block) : NONE;
    lenA[i] = e.length === null || e.length === undefined ? NaN : e.length;
    areaA[i] = e.area === null || e.area === undefined ? NaN : e.area;
    const s0 = np / 2;
    startA[i] = s0;
    if (k === 2) push(e.ins[0], e.ins[1]);
    else if (k === 3) push(e.bbox[0], e.bbox[1]);
    else if (k !== 4) {
      const lens = e.pathLens || [e.segs.length];
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

  const header = { version: 1, origin: [x0, y0], bbox, layers, handles: flat.map(e => e.handle), blocks };
  let json = Buffer.from(JSON.stringify(header), 'utf8');
  const kindPad = (4 - (n % 4)) % 4;
  // pad the JSON with spaces: header end on 4 bytes, and the Float64 section on 8
  let hl = json.length;
  while ((4 + hl) % 4 !== 0 || (4 + hl + 12 * n + n + kindPad + 4 * n) % 8 !== 0) hl++;
  if (hl > json.length) json = Buffer.concat([json, Buffer.alloc(hl - json.length, 0x20)]);
  const total = 4 + hl + 12 * n + n + kindPad + 4 * n + 16 * n + 4 * np;
  const buf = Buffer.alloc(total), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  dv.setUint32(o, hl, true); o += 4;
  json.copy(buf, o); o += hl;
  for (const a of [layerA, startA, countA]) for (let i = 0; i < n; i++) { dv.setUint32(o, a[i], true); o += 4; }
  buf.set(kindA, o); o += n + kindPad;
  for (let i = 0; i < n; i++) { dv.setUint32(o, blockA[i], true); o += 4; }
  for (const a of [lenA, areaA]) for (let i = 0; i < n; i++) { dv.setFloat64(o, a[i], true); o += 8; }
  for (let i = 0; i < np; i++) { dv.setFloat32(o, pts[i], true); o += 4; }
  return buf;
}

module.exports = { buildRender };
