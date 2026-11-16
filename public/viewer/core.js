// Drawing viewer core: pure functions over the display file (lib/dxf/render.js, version 3), no DOM, no Node APIs.
// Loaded as a plain script in the browser (window.TV) and with require() in Node (tests).
//
// Coordinates:
//   world  = the drawing's own coordinates (drawing units); an entity's point k is eo[2i] + pts[2k] (Float64 math).
//   local  = world − origin (the header origin, the drawing's bbox min), Float64; the view, the grid and every distance
//            work in local coordinates so screen math stays stable at georeferenced values (500,000 / 2,700,000 m).
//   screen = (local x · scale + tx, −local y · scale + ty), CSS pixels.
// toWorld/toScreen and every rect, point and tolerance passed in or returned use true world coordinates.
// A NaN,NaN point pair is a path break: no segment touching it is ever drawn, hit, snapped or box-tested. Kind 4
// (dropped) has no points and is never visible, hit or selected; kinds 2 (insert marker), 5 (nested insert marker: an
// INSERT inside a block) and 3 (text anchor) are points, and kind 5 is drawn, hit and selected exactly like kind 2.
// Display data is approximate (Float32, arcs as chords): previewTotal is for display only, never a saved quantity.
'use strict';
(function () {
const VERSION = 3;
const KIND_OPEN = 0, KIND_CLOSED = 1, KIND_INSERT = 2, KIND_DROPPED = 4, KIND_NESTED = 5;
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// ---- display file ----
// decodeRender(arrayBuffer, byteOffset = 0, byteLength = rest) -> R with typed-array views on the given buffer (copies
// only a section whose offset is not aligned for its type, or on a big-endian machine)
function decodeRender(ab, byteOffset, byteLength) {
  const base = byteOffset || 0, size = byteLength === undefined ? ab.byteLength - base : byteLength;
  const bad = why => new Error('invalid display file: ' + why);
  if (size < 4) throw bad('too short');
  const dv = new DataView(ab, base, size);
  const hl = dv.getUint32(0, true);
  if (4 + hl > size) throw bad('header length');
  let header;
  try { header = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(ab, base + 4, hl))); } catch (e) { throw bad('header'); }
  if (!header || header.version !== VERSION) throw bad('version ' + (header && header.version) + ', expected ' + VERSION);
  if (!Array.isArray(header.handles) || !Array.isArray(header.layers) || !Array.isArray(header.origin)) throw bad('header fields');
  const n = header.handles.length;
  const up = (v, m) => Math.ceil(v / m) * m;
  const oIdx = up(4 + hl, 4), oKind = oIdx + 12 * n, oBlock = up(oKind + n, 4), oF64 = up(oBlock + 4 * n, 8), oPts = oF64 + 32 * n;
  if (oPts > size || (size - oPts) % 9) throw bad('size');   // per point: Float32 x, y and one vtx byte
  const np = (size - oPts) / 9 * 2;
  const view = (T, off, len, get) => {
    const abs = base + off;
    if (LE && abs % T.BYTES_PER_ELEMENT === 0) return new T(ab, abs, len);
    if (LE) return new T(ab.slice(abs, abs + len * T.BYTES_PER_ELEMENT));
    const a = new T(len);
    for (let k = 0; k < len; k++) a[k] = get(off + k * T.BYTES_PER_ELEMENT);
    return a;
  };
  const u32 = o => dv.getUint32(o, true), f64 = o => dv.getFloat64(o, true), f32 = o => dv.getFloat32(o, true);
  const R = {
    header, version: header.version, origin: header.origin, bbox: header.bbox, layers: header.layers, handles: header.handles,
    blocks: header.blocks || [], n,
    layer: view(Uint32Array, oIdx, n, u32), start: view(Uint32Array, oIdx + 4 * n, n, u32), count: view(Uint32Array, oIdx + 8 * n, n, u32),
    kind: new Uint8Array(ab, base + oKind, n), block: view(Uint32Array, oBlock, n, u32),
    len: view(Float64Array, oF64, n, f64), area: view(Float64Array, oF64 + 8 * n, n, f64), eo: view(Float64Array, oF64 + 16 * n, 2 * n, f64),
    pts: view(Float32Array, oPts, np, f32), vtx: new Uint8Array(ab, base + oPts + 4 * np, np / 2),
  };
  const N = np / 2;
  for (let i = 0; i < n; i++) {
    if (R.start[i] + R.count[i] > N) throw bad('entity ' + i + ' points out of range');
    if (R.layer[i] >= R.layers.length) throw bad('entity ' + i + ' layer out of range');
  }
  return R;
}

// ---- view ----
function makeView(bbox, width, height, origin) {
  const ox = origin ? origin[0] : bbox[0], oy = origin ? origin[1] : bbox[1];
  const fw = (bbox[2] - bbox[0]) * 1.1, fh = (bbox[3] - bbox[1]) * 1.1;   // 5 % margin on each side
  let scale = Math.min(fw > 0 ? width / fw : Infinity, fh > 0 ? height / fh : Infinity);
  if (!(scale > 0) || !Number.isFinite(scale)) scale = 1;
  const cx = ((bbox[0] - ox) + (bbox[2] - ox)) / 2, cy = ((bbox[1] - oy) + (bbox[3] - oy)) / 2;
  return { scale, tx: width / 2 - cx * scale, ty: height / 2 + cy * scale, ox, oy };
}
function zoomAt(V, sx, sy, factor) {
  const lx = (sx - V.tx) / V.scale, ly = (V.ty - sy) / V.scale, scale = V.scale * factor;
  return { scale, tx: sx - lx * scale, ty: sy + ly * scale, ox: V.ox, oy: V.oy };
}
function pan(V, dx, dy) { return { scale: V.scale, tx: V.tx + dx, ty: V.ty + dy, ox: V.ox, oy: V.oy }; }
function toWorld(V, sx, sy) { return [(sx - V.tx) / V.scale + V.ox, (V.ty - sy) / V.scale + V.oy]; }
function toScreen(V, x, y) { return [(x - V.ox) * V.scale + V.tx, -(y - V.oy) * V.scale + V.ty]; }

// ---- segments of one entity (local coordinates); fn returning true stops the walk ----
// open: consecutive points within each path; closed: each path is a ring (its last point joins its first)
function forSegs(R, i, ox, oy, fn) {
  const s = R.start[i], e = s + R.count[i], p = R.pts, ex = R.eo[2 * i] - ox, ey = R.eo[2 * i + 1] - oy;
  const closed = R.kind[i] === KIND_CLOSED;
  let rs = s;   // the current path's first point
  for (let k = s; k <= e; k++) {
    if (k === e || p[2 * k] !== p[2 * k] || p[2 * k + 1] !== p[2 * k + 1]) {   // end of a path (end of entity or a break)
      if (closed && k - rs >= 3 && fn(ex + p[2 * k - 2], ey + p[2 * k - 1], ex + p[2 * rs], ey + p[2 * rs + 1])) return true;
      rs = k + 1;
      continue;
    }
    if (k > rs && fn(ex + p[2 * k - 2], ey + p[2 * k - 1], ex + p[2 * k], ey + p[2 * k + 1])) return true;
  }
  return false;
}
// a point-like entity: an insert marker, a text anchor, or a path of one point
function isPoint(R, i) { return (R.kind[i] !== KIND_OPEN && R.kind[i] !== KIND_CLOSED) || R.count[i] === 1; }
function segDist2(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x0 + t * dx - px, qy = y0 + t * dy - py;
  return qx * qx + qy * qy;
}
// even-odd over every ring of a closed entity (an island is a hole)
function inside(R, i, ox, oy, px, py) {
  let c = false;
  forSegs(R, i, ox, oy, (x0, y0, x1, y1) => {
    if ((y0 > py) !== (y1 > py) && px < x0 + (py - y0) * (x1 - x0) / (y1 - y0)) c = !c;
  });
  return c;
}
// does the segment touch the rect? (Liang–Barsky)
function segInRect(x0, y0, x1, y1, a, b, c, d) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, x0 - a) && clip(dx, c - x0) && clip(-dy, y0 - b) && clip(dy, d - y0);
}

// ---- grid ----
// Entities go into every cell their bbox touches; an entity covering more than 25 % of the cells, or one past the
// insertion budget, goes into the oversize list (checked on every query) instead, so memory stays bounded.
function buildGrid(R, cellSize) {
  const n = R.n, ox = R.origin[0], oy = R.origin[1];
  const bb = new Float64Array(4 * n).fill(NaN);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, m = 0;
  const p = R.pts;
  for (let i = 0; i < n; i++) {
    if (R.kind[i] === KIND_DROPPED) continue;
    const s = R.start[i], e = s + R.count[i], ex = R.eo[2 * i] - ox, ey = R.eo[2 * i + 1] - oy;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let k = s; k < e; k++) {
      const x = p[2 * k], y = p[2 * k + 1];
      if (x !== x || y !== y) continue;
      if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y;
    }
    if (a === Infinity) continue;
    a += ex; b += ey; c += ex; d += ey;
    bb[4 * i] = a; bb[4 * i + 1] = b; bb[4 * i + 2] = c; bb[4 * i + 3] = d; m++;
    if (a < minx) minx = a; if (b < miny) miny = b; if (c > maxx) maxx = c; if (d > maxy) maxy = d;
  }
  if (!m) { minx = miny = maxx = maxy = 0; }
  const W = maxx - minx, H = maxy - miny;
  let cs = cellSize > 0 ? cellSize : W > 0 && H > 0 ? Math.sqrt(W * H / Math.max(1, m)) : Math.max(W, H) / Math.sqrt(Math.max(1, m));
  if (!(cs > 0) || !Number.isFinite(cs)) cs = 1;
  const maxCells = Math.max(1024, 4 * m);
  let nx, ny;
  for (;;) {
    nx = Math.floor(W / cs) + 1; ny = Math.floor(H / cs) + 1;
    if (nx * ny <= maxCells) break;
    cs *= 1.5;
  }
  const nc = nx * ny, budget = 8 * m + nc;
  const cx = x => { const v = Math.floor((x - minx) / cs); return v < 0 ? 0 : v >= nx ? nx - 1 : v; };
  const cy = y => { const v = Math.floor((y - miny) / cs); return v < 0 ? 0 : v >= ny ? ny - 1 : v; };
  const cellStart = new Uint32Array(nc + 1), isOver = new Uint8Array(n), over = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (bb[4 * i] !== bb[4 * i]) continue;
    const x0 = cx(bb[4 * i]), x1 = cx(bb[4 * i + 2]), y0 = cy(bb[4 * i + 1]), y1 = cy(bb[4 * i + 3]);
    const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (cells * 4 > nc && nc >= 16 || total + cells > budget) { isOver[i] = 1; over.push(i); continue; }
    total += cells;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cellStart[y * nx + x + 1]++;
  }
  for (let c = 0; c < nc; c++) cellStart[c + 1] += cellStart[c];
  const items = new Uint32Array(total), fill = cellStart.slice(0, nc);
  for (let i = 0; i < n; i++) {
    if (bb[4 * i] !== bb[4 * i] || isOver[i]) continue;
    const x0 = cx(bb[4 * i]), x1 = cx(bb[4 * i + 2]), y0 = cy(bb[4 * i + 1]), y1 = cy(bb[4 * i + 3]);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) items[fill[y * nx + x]++] = i;
  }
  return { ox, oy, x0: minx, y0: miny, x1: maxx, y1: maxy, cs, nx, ny, cellStart, items, over: Uint32Array.from(over), bb,
    stamp: new Uint32Array(n), tick: 0 };
}
// call fn(i) once for each entity in a cell touching the local rect, and each oversize entity
function candidates(G, a, b, c, d, fn) {
  if (++G.tick === 0xFFFFFFFF) { G.stamp.fill(0); G.tick = 1; }
  const t = G.tick, st = G.stamp;
  for (let k = 0; k < G.over.length; k++) { const i = G.over[k]; st[i] = t; fn(i); }
  if (c < G.x0 || a > G.x1 || d < G.y0 || b > G.y1) return;
  const cl = (v, hi) => v < 0 ? 0 : v > hi ? hi : v;
  const x0 = cl(Math.floor((a - G.x0) / G.cs), G.nx - 1), x1 = cl(Math.floor((c - G.x0) / G.cs), G.nx - 1);
  const y0 = cl(Math.floor((b - G.y0) / G.cs), G.ny - 1), y1 = cl(Math.floor((d - G.y0) / G.cs), G.ny - 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const cell = y * G.nx + x;
    for (let k = G.cellStart[cell], e = G.cellStart[cell + 1]; k < e; k++) {
      const i = G.items[k];
      if (st[i] !== t) { st[i] = t; fn(i); }
    }
  }
}
const isOn = (R, i, layerOn) => !layerOn || layerOn[R.layer[i]] === 1;
const localRect = (G, r) => [Math.min(r[0], r[2]) - G.ox, Math.min(r[1], r[3]) - G.oy, Math.max(r[0], r[2]) - G.ox, Math.max(r[1], r[3]) - G.oy];
const sortIdx = list => Uint32Array.from(list).sort();

// entities whose bbox touches the world rect, on a visible layer, in drawing order
function visible(G, R, rect, layerOn) {
  const [a, b, c, d] = localRect(G, rect), bb = G.bb, out = [];
  const take = i => {
    if (bb[4 * i] !== bb[4 * i] || !isOn(R, i, layerOn)) return;
    if (bb[4 * i + 2] < a || bb[4 * i] > c || bb[4 * i + 3] < b || bb[4 * i + 1] > d) return;
    out.push(i);
  };
  if (a <= G.x0 && b <= G.y0 && c >= G.x1 && d >= G.y1) { for (let i = 0; i < R.n; i++) take(i); return Uint32Array.from(out); }
  candidates(G, a, b, c, d, take);
  return sortIdx(out);
}

// the entity nearest the world point: an edge (or a point entity) within tol wins (equal distances: the topmost, i.e.
// the highest index, drawn last); else the smallest closed shape the point is inside; -1 when none
function hitTest(G, R, wx, wy, tol, layerOn) {
  const px = wx - G.ox, py = wy - G.oy, bb = G.bb, t2 = tol * tol;
  let best = -1, bestD = Infinity, inIdx = -1, inArea = Infinity;
  candidates(G, px - tol, py - tol, px + tol, py + tol, i => {
    if (bb[4 * i] !== bb[4 * i] || !isOn(R, i, layerOn)) return;
    if (px < bb[4 * i] - tol || px > bb[4 * i + 2] + tol || py < bb[4 * i + 1] - tol || py > bb[4 * i + 3] + tol) return;
    let d2 = Infinity;
    if (isPoint(R, i)) {
      const k = R.start[i], x = R.eo[2 * i] - G.ox + R.pts[2 * k], y = R.eo[2 * i + 1] - G.oy + R.pts[2 * k + 1];
      d2 = (x - px) * (x - px) + (y - py) * (y - py);
    } else {
      forSegs(R, i, G.ox, G.oy, (x0, y0, x1, y1) => { const v = segDist2(px, py, x0, y0, x1, y1); if (v < d2) d2 = v; });
    }
    if (d2 <= t2) { if (d2 < bestD || (d2 === bestD && i > best)) { bestD = d2; best = i; } return; }   // a tie: the topmost
    if (R.kind[i] === KIND_CLOSED && R.count[i] > 2 && inside(R, i, G.ox, G.oy, px, py)) {
      const ar = (bb[4 * i + 2] - bb[4 * i]) * (bb[4 * i + 3] - bb[4 * i + 1]);
      if (ar < inArea || (ar === inArea && i > inIdx)) { inArea = ar; inIdx = i; }
    }
  });
  return best >= 0 ? best : inIdx;
}

// window: the entity's bbox is fully inside the rect; crossing: that, or any of its segments touches the rect
function boxSelect(G, R, rect, mode, layerOn) {
  if (mode !== 'window' && mode !== 'crossing') throw new Error('boxSelect: mode must be window or crossing');
  const [a, b, c, d] = localRect(G, rect), bb = G.bb, out = [];
  candidates(G, a, b, c, d, i => {
    if (bb[4 * i] !== bb[4 * i] || !isOn(R, i, layerOn)) return;
    if (bb[4 * i] >= a && bb[4 * i + 2] <= c && bb[4 * i + 1] >= b && bb[4 * i + 3] <= d) { out.push(i); return; }
    if (mode === 'window' || isPoint(R, i)) return;
    if (bb[4 * i + 2] < a || bb[4 * i] > c || bb[4 * i + 3] < b || bb[4 * i + 1] > d) return;
    if (forSegs(R, i, G.ox, G.oy, (x0, y0, x1, y1) => segInRect(x0, y0, x1, y1, a, b, c, d))) out.push(i);
  });
  return sortIdx(out);
}

// the nearest true vertex ('end': vtx 1, or a marker / text anchor) or straight-segment midpoint ('mid': two consecutive
// vtx 1 points) within tol, in world coordinates; an endpoint wins a tie. An arc's tessellation point (vtx 0) is never a
// target, nor is a chord next to one. World = eo + pts in Float64, so a georeferenced vertex comes back within Float32's
// precision over the entity's own extent.
function snap(G, R, wx, wy, tol, layerOn) {
  const px = wx - G.ox, py = wy - G.oy, bb = G.bb, t2 = tol * tol, p = R.pts, v = R.vtx;
  let best = null, bestD = Infinity;
  const consider = (x, y, kind) => {   // world x, y
    const dx = x - G.ox - px, dy = y - G.oy - py, d2 = dx * dx + dy * dy;
    if (d2 <= t2 && (d2 < bestD || (d2 === bestD && kind === 'end' && best.kind === 'mid'))) { bestD = d2; best = { x, y, kind }; }
  };
  candidates(G, px - tol, py - tol, px + tol, py + tol, i => {
    if (bb[4 * i] !== bb[4 * i] || !isOn(R, i, layerOn)) return;
    if (px < bb[4 * i] - tol || px > bb[4 * i + 2] + tol || py < bb[4 * i + 1] - tol || py > bb[4 * i + 3] + tol) return;
    const s = R.start[i], e = s + R.count[i], ex = R.eo[2 * i], ey = R.eo[2 * i + 1];
    if (isPoint(R, i)) {   // insert marker, text anchor, a one-point path
      for (let k = s; k < e; k++) if (p[2 * k] === p[2 * k]) consider(ex + p[2 * k], ey + p[2 * k + 1], 'end');
      return;
    }
    for (let k = s; k < e; k++) if (v[k] && p[2 * k] === p[2 * k] && p[2 * k + 1] === p[2 * k + 1]) consider(ex + p[2 * k], ey + p[2 * k + 1], 'end');
    // midpoints of straight segments (both ends vtx 1), in world coordinates; within a path, and a closed ring's closing one
    const mid = (a, b) => consider(ex + (p[2 * a] + p[2 * b]) / 2, ey + (p[2 * a + 1] + p[2 * b + 1]) / 2, 'mid');
    const closed = R.kind[i] === KIND_CLOSED;
    let rs = s;   // the current path's first point
    for (let k = s; k <= e; k++) {
      if (k === e || p[2 * k] !== p[2 * k] || p[2 * k + 1] !== p[2 * k + 1]) {   // end of a path
        if (closed && k - rs >= 3 && v[k - 1] && v[rs]) mid(k - 1, rs);
        rs = k + 1;
        continue;
      }
      if (k > rs && v[k - 1] && v[k]) mid(k - 1, k);
    }
  });
  return best;
}

// display-only live total of a selection (drawing units × unitFactor, area × unitFactor²); used = entities counted.
// Mirrors lib/dxf/select.js through the display file's len: a HATCH's len is NaN (no perimeter), an insert marker's len
// is its count (rows × cols for an MINSERT). A count takes the top-level markers (kind 2) only; with opts.nested also the
// nested ones (kind 5), as the server does with nested: true.
const METRICS = { open_length: 1, closed_perimeter: 1, area: 1, count: 1 };
function previewTotal(R, indices, metric, unitFactor, opts) {
  const nested = !!(opts && opts.nested);
  if (!METRICS[metric]) throw new Error('previewTotal: unknown metric ' + metric);
  if (typeof unitFactor !== 'number' || !Number.isFinite(unitFactor) || unitFactor <= 0) throw new Error('previewTotal: unit factor must be a number > 0');
  let sum = 0, used = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k], kind = R.kind[i];
    if (metric === 'count' ? kind !== KIND_INSERT && !(nested && kind === KIND_NESTED) : metric === 'open_length' ? kind !== KIND_OPEN : kind !== KIND_CLOSED) continue;
    const v = metric === 'area' ? R.area[i] : R.len[i];
    if (v !== v) continue;
    sum += v; used++;
  }
  const value = metric === 'count' ? sum : metric === 'area' ? sum * unitFactor * unitFactor : sum * unitFactor;
  return { value, used };
}

// the selection's block inserts by block name, in name order: [{ block, top, nested }] = Σ count of its top-level (kind 2)
// and nested (kind 5) markers. Display only, like previewTotal.
function previewBlocks(R, indices) {
  const by = new Map();
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k], kind = R.kind[i];
    if (kind !== KIND_INSERT && kind !== KIND_NESTED) continue;
    const name = R.block[i] < R.blocks.length ? R.blocks[R.block[i]] : '?', v = R.len[i];
    let b = by.get(name);
    if (!b) { b = { block: name, top: 0, nested: 0 }; by.set(name, b); }
    if (v !== v) continue;
    if (kind === KIND_NESTED) b.nested += v; else b.top += v;
  }
  return [...by.values()].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
}

const TV = { decodeRender, makeView, zoomAt, pan, toWorld, toScreen, buildGrid, visible, hitTest, boxSelect, snap, previewTotal, previewBlocks };
if (typeof module !== 'undefined' && module.exports) module.exports = TV; else window.TV = TV;
})();
