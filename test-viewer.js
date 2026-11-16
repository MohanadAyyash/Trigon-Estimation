// Viewer core (public/viewer/core.js) and ACI table, pure, in Node: node --no-warnings test-viewer.js
// Display files are built with the real lib/dxf/render.js from string DXF fixtures, then decoded as the browser does.
const assert = require('assert');
const { parseDxf } = require('./lib/dxf/parse.js');
const { flatten } = require('./lib/dxf/geometry.js');
const { buildRender } = require('./lib/dxf/render.js');
const TV = require('./public/viewer/core.js');
const ACI = require('./public/viewer/aci.js');

const dxf = pairs => [...pairs, [0, 'EOF']].map(([c, v]) => c + '\n' + v).join('\n') + '\n';
const sec = (name, pairs) => [[0, 'SECTION'], [2, name], ...pairs, [0, 'ENDSEC']];
const ents = list => sec('ENTITIES', list);
const layerRec = (name, color = 7) => [[0, 'LAYER'], [2, name], [70, 0], [62, color], [6, 'CONTINUOUS']];
const tables = layers => sec('TABLES', [[0, 'TABLE'], [2, 'LAYER'], [70, layers.length], ...layers.flat(), [0, 'ENDTAB']]);
const line = (h, layer, x1, y1, x2, y2) => [[0, 'LINE'], [5, h], [8, layer], [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]];
const lwp = (h, pts, closed, layer = '0') => [[0, 'LWPOLYLINE'], [5, h], [8, layer], [90, pts.length], [70, closed ? 1 : 0], ...pts.flatMap(([x, y]) => [[10, x], [20, y]])];
const sq = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
const hpoly = pts => [[92, 3], [72, 0], [73, 1], [93, pts.length], ...pts.flatMap(([x, y]) => [[10, x], [20, y]]), [97, 0]];
const hatch = (h, loops, layer = 'H') => [[0, 'HATCH'], [5, h], [8, layer], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, 'SOLID'], [70, 1], [71, 0], [91, loops.length], ...loops.flat(), [75, 0], [76, 1], [98, 0]];
const insert = (h, name, layer, x, y) => [[0, 'INSERT'], [5, h], [8, layer], [2, name], [10, x], [20, y]];
const block = (name, list) => [[0, 'BLOCK'], [2, name], [70, 0], [10, 0], [20, 0], ...list, [0, 'ENDBLK']];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b);
// buildRender's Buffer → its ArrayBuffer (+ byteOffset), decoded by the browser-side decoder
const load = pairs => {
  const d = parseDxf(dxf(pairs)), buf = buildRender(d, flatten(d, { withSegs: true }));
  return TV.decodeRender(buf.buffer, buf.byteOffset);
};
const allOn = R => new Uint8Array(R.layers.length).fill(1);
const ids = a => Array.from(a).map(Number);

// ---- ACI table: generated from ezdxf ----
assert.strictEqual(ACI.length, 256);
assert.strictEqual(ACI[1], '#ff0000'); assert.strictEqual(ACI[7], '#ffffff'); assert.strictEqual(ACI[8], '#808080');
assert.ok(ACI.every(c => /^#[0-9a-f]{6}$/.test(c)));

// ---- decode: typed-array views, no copies when aligned; also at an unaligned byteOffset ----
{
  const d = parseDxf(dxf(ents([...line('A', 'K', 0, 0, 5, 0), ...lwp('S', sq(10, 0, 2), true, 'K')])));
  const buf = buildRender(d, flatten(d, { withSegs: true }));
  const big = new ArrayBuffer(buf.length + 8);
  new Uint8Array(big, 8).set(buf);
  const R = TV.decodeRender(big, 8);
  assert.strictEqual(R.n, 2); assert.strictEqual(R.version, 3);
  assert.deepStrictEqual(R.handles, ['A', 'S']); assert.deepStrictEqual(ids(R.kind), [0, 1]); assert.deepStrictEqual(ids(R.count), [2, 4]);
  assert.ok(R.pts instanceof Float32Array && R.eo instanceof Float64Array && R.len instanceof Float64Array);
  assert.strictEqual(R.pts.buffer, big, 'pts is a view on the given buffer');
  assert.strictEqual(R.eo.buffer, big);
  assert.deepStrictEqual(Array.from(R.eo), [0, 0, 10, 0]); assert.strictEqual(R.len[0], 5);
  // unaligned: still decodes (copies only what must be copied)
  const odd = new ArrayBuffer(buf.length + 3); new Uint8Array(odd, 3).set(buf);
  const R2 = TV.decodeRender(odd, 3);
  assert.deepStrictEqual(Array.from(R2.pts), Array.from(R.pts)); assert.deepStrictEqual(Array.from(R2.eo), Array.from(R.eo));
  assert.throws(() => TV.decodeRender(new Uint8Array([4, 0, 0, 0, 123, 34, 118, 34]).buffer), /display file/);
}

// ---- view: fit with a 5 % margin; zoomAt keeps the point under the cursor; pan; toWorld/toScreen in true world ----
{
  const V = TV.makeView([0, 0, 100, 50], 1100, 550);
  near(V.scale, 10, 1e-12, 'fit: 100 units + 5 % each side into 1100 px');
  const c = TV.toScreen(V, 50, 25); near(c[0], 550, 1e-9); near(c[1], 275, 1e-9);
  const lo = TV.toScreen(V, 0, 0); near(lo[0], 50, 1e-9); near(lo[1], 525, 1e-9, 'y grows upwards');
  let W = V; const sx = 123.4, sy = 321.9, p = TV.toWorld(V, sx, sy);
  for (const f of [2, 0.5, 10]) {
    W = TV.zoomAt(W, sx, sy, f);
    const s = TV.toScreen(W, p[0], p[1]);
    near(s[0], sx, 1e-9, 'zoom ' + f + ' x'); near(s[1], sy, 1e-9, 'zoom ' + f + ' y');
  }
  near(W.scale, 100, 1e-9);
  const wtx = W.tx, P = TV.pan(W, 7, -3), q = TV.toScreen(P, p[0], p[1]); near(q[0], sx + 7, 1e-9); near(q[1], sy - 3, 1e-9);
  assert.notStrictEqual(P, W); assert.strictEqual(W.tx, wtx, 'views are values: pan does not change its input');
  // georeferenced: the true world coordinate comes back exactly enough for the status bar
  const X = 500000, Y = 2700000, G = TV.makeView([X, Y, X + 10, Y + 10], 800, 600);
  const w = TV.toWorld(G, ...TV.toScreen(G, X + 3.25, Y + 7.5)); near(w[0], X + 3.25, 1e-6); near(w[1], Y + 7.5, 1e-6);
}

// ---- georeferenced hit test: a 1 m line at scale 100 px/m; 1 px away hits, 10 px away misses ----
{
  const X = 500000, Y = 2700000;
  const R = load([...tables([layerRec('ROAD')]), ...ents([...line('L1', 'ROAD', X, Y, X + 1, Y), ...line('L2', 'ROAD', X, Y + 0.2, X + 1, Y + 0.2)])]);
  const G = TV.buildGrid(R), on = allOn(R);
  const V = { ...TV.makeView(R.bbox, 400, 400), scale: 100 };
  const tol = 3 / V.scale;   // 3 px
  const [mx, my] = TV.toScreen(V, X + 0.5, Y);
  assert.strictEqual(TV.hitTest(G, R, ...TV.toWorld(V, mx, my - 1), tol, on), 0, '1 px above L1 → L1');
  assert.strictEqual(TV.hitTest(G, R, ...TV.toWorld(V, mx, my + 1), tol, on), 0, '1 px below L1 → L1');
  assert.strictEqual(TV.hitTest(G, R, ...TV.toWorld(V, mx, my + 10), tol, on), -1, '10 px away → nothing');
  assert.strictEqual(TV.hitTest(G, R, ...TV.toWorld(V, mx, my - 19), tol, on), 1, 'the nearest: 1 px from L2');
  assert.strictEqual(TV.hitTest(G, R, ...TV.toWorld(V, mx, my - 8), 0.15, on), 0, 'both within tolerance: the nearer wins');
  const s = TV.snap(G, R, X + 0.004, Y - 0.003, 0.01, on);
  assert.strictEqual(s.kind, 'end'); near(s.x, X, 1e-6); near(s.y, Y, 1e-6);
}

// ---- hit test: closed shapes (inside counts unless an edge is near), islands, markers, text, path breaks ----
{
  const R = load([...sec('BLOCKS', block('B', [])), ...ents([
    ...hatch('HI', [hpoly(sq(0, 0, 10)), hpoly(sq(4, 4, 2))], 'H'),
    ...lwp('S2', sq(20, 0, 10), true, 'P'), ...lwp('S3', sq(22, 2, 2), true, 'P'),
    ...insert('I1', 'B', 'MH', 50, 50), [0, 'MTEXT'], [5, 'T'], [8, 'TX'], [10, 60], [20, 60], [1, 'NOTE'],
    [0, 'MLINE'], [5, 'M1'], [8, 'K'],
  ])]);
  assert.deepStrictEqual(ids(R.kind), [1, 1, 1, 2, 3, 4]);
  const G = TV.buildGrid(R), on = allOn(R);
  assert.strictEqual(TV.hitTest(G, R, 2, 2, 0.1, on), 0, 'inside the hatch');
  assert.strictEqual(TV.hitTest(G, R, 5, 5, 0.1, on), -1, 'inside the island: a hole');
  assert.strictEqual(TV.hitTest(G, R, 4.05, 5, 0.1, on), 0, 'on the island edge');
  assert.strictEqual(TV.hitTest(G, R, 23, 3, 0.1, on), 2, 'inside both squares: the inner one');
  assert.strictEqual(TV.hitTest(G, R, 24.05, 3, 0.1, on), 2, 'near the inner edge');
  assert.strictEqual(TV.hitTest(G, R, 21.95, 3, 0.1, on), 2, 'an edge within tolerance beats an inside');
  assert.strictEqual(TV.hitTest(G, R, 20.05, 5, 0.1, on), 1, 'outer edge');
  assert.strictEqual(TV.hitTest(G, R, 50.3, 50, 0.5, on), 3, 'insert marker within tolerance');
  assert.strictEqual(TV.hitTest(G, R, 50.6, 50, 0.5, on), -1, 'insert marker outside tolerance');
  assert.strictEqual(TV.hitTest(G, R, 60, 60.2, 0.5, on), 4, 'text anchor as a point');
  // the would-be segment across the break (0,10)→(4,4) is never snapped or box-tested
  assert.strictEqual(TV.snap(G, R, 2, 7, 0.5, on), null, 'no midpoint across a path break');
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, [1.8, 6.8, 2.2, 7.2], 'crossing', on)), [], 'no crossing across a path break');
  // dropped never hit or selected
  assert.ok(!ids(TV.boxSelect(G, R, [-1000, -1000, 1000, 1000], 'window', on)).includes(5));
  assert.ok(!ids(TV.boxSelect(G, R, [-1000, -1000, 1000, 1000], 'crossing', on)).includes(5));
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, [-1000, -1000, 1000, 1000], 'window', on)), [0, 1, 2, 3, 4]);
  assert.ok(!ids(TV.visible(G, R, [-1000, -1000, 1000, 1000], on)).includes(5));
}

// ---- box select: window vs crossing; a layer switched off is never hit, selected, snapped or visible ----
{
  const R = load([...tables([layerRec('A'), layerRec('B')]), ...ents([
    ...line('IN', 'A', 1, 1, 4, 1), ...line('PART', 'A', 2, 3, 9, 3), ...line('OUT', 'A', 20, 20, 30, 20), ...line('OFF', 'B', 1, 2, 4, 2)])]);
  const G = TV.buildGrid(R), on = allOn(R);
  const rect = [0, 0, 5, 5];
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, rect, 'window', on)), [0, 3]);
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, rect, 'crossing', on)), [0, 1, 3]);
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, [5, 5, 0, 0], 'crossing', on)), [0, 1, 3], 'any corner order');
  // a segment crossing the rect with both ends outside
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, [5, 2.5, 6, 3.5], 'crossing', on)), [1]);
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, [5, 2.5, 6, 3.5], 'window', on)), []);
  const off = allOn(R); off[R.layers.findIndex(l => l.name === 'B')] = 0;
  assert.strictEqual(TV.hitTest(G, R, 2, 2, 0.1, on), 3);
  assert.strictEqual(TV.hitTest(G, R, 2, 2, 0.1, off), -1, 'layer off: never hit');
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, rect, 'window', off)), [0]);
  assert.deepStrictEqual(ids(TV.boxSelect(G, R, rect, 'crossing', off)), [0, 1]);
  assert.strictEqual(TV.snap(G, R, 4, 2, 0.1, off), null, 'layer off: never snapped');
  assert.deepStrictEqual(ids(TV.visible(G, R, [0, 0, 50, 50], off)), [0, 1, 2]);
  assert.deepStrictEqual(ids(TV.visible(G, R, [0, 0, 5, 5], on)), [0, 1, 3]);
  // snap: endpoint within tolerance; midpoint of the segment
  assert.deepStrictEqual(TV.snap(G, R, 4.05, 1.02, 0.1, on), { x: 4, y: 1, kind: 'end' });
  assert.deepStrictEqual(TV.snap(G, R, 2.45, 1.05, 0.1, on), { x: 2.5, y: 1, kind: 'mid' });
  assert.strictEqual(TV.snap(G, R, 3.2, 1.5, 0.1, on), null);
}

// ---- display file v3: snap only to true vertices (vtx = 1); a midpoint only of a straight segment; never a tessellation point ----
{
  const lwpB = (h, pts, closed, layer = '0') => [[0, 'LWPOLYLINE'], [5, h], [8, layer], [90, pts.length], [70, closed ? 1 : 0],
    ...pts.flatMap(([x, y, b]) => [[10, x], [20, y], ...(b ? [[42, b]] : [])])];
  // a closed square s × s at (x0, y0) whose bottom edge is a half-circle bulge (through (x0 + s/2, y0 - s/2))
  const shape = (x0, y0, s) => lwpB('B', [[x0, y0, 1], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]], true);
  for (const [X, Y, s, what] of [[0, 0, 10, 'local'], [500000, 2700000, 10, 'georeferenced m'], [500000000, 2700000000, 10000, 'georeferenced mm']]) {
    const R = load(ents(shape(X, Y, s))), G = TV.buildGrid(R), on = allOn(R);
    assert.ok(R.vtx instanceof Uint8Array && R.vtx.length === R.pts.length / 2, what + ': one vtx flag per point');
    const st = R.start[0], c = R.count[0], v = ids(R.vtx.subarray(st, st + c));
    assert.ok(c > 8, what + ': the arc is tessellated');
    assert.deepStrictEqual(v, [1, ...Array(c - 4).fill(0), 1, 1, 1], what + ': vtx 1 at the four vertices only');
    const tol = s / 20;
    // every tessellation point: never a snap target (nothing, or a true vertex)
    for (let k = st + 1; k < st + c - 3; k++) {
      const wx = R.eo[0] + R.pts[2 * k], wy = R.eo[1] + R.pts[2 * k + 1], r = TV.snap(G, R, wx, wy, tol, on);
      assert.ok(r === null || (r.kind === 'end' && [[X, Y], [X + s, Y]].some(([a, b]) => Math.abs(r.x - a) <= 1e-3 && Math.abs(r.y - b) <= 1e-3)),
        what + ': no snap to the arc point ' + k + ': ' + JSON.stringify(r));
    }
    // the arc's chords have no midpoint snap; the bottom of the arc snaps to nothing
    assert.strictEqual(TV.snap(G, R, X + s / 2, Y - s / 2, tol, on), null, what + ': nothing at the bottom of the arc');
    // true vertices reproduce within 1e-3 drawing units, also next to the arc
    for (const [a, b] of [[X, Y], [X + s, Y], [X + s, Y + s], [X, Y + s]]) {
      const r = TV.snap(G, R, a + tol / 3, b - tol / 4, tol, on);
      assert.strictEqual(r && r.kind, 'end', what + ': vertex ' + a + ',' + b);
      near(r.x, a, 1e-3, what + ' vertex x'); near(r.y, b, 1e-3, what + ' vertex y');
    }
    // a straight edge's midpoint (also the closing edge); within 1e-3
    for (const [a, b] of [[X + s, Y + s / 2], [X + s / 2, Y + s], [X, Y + s / 2]]) {
      const r = TV.snap(G, R, a + tol / 4, b + tol / 5, tol, on);
      assert.strictEqual(r && r.kind, 'mid', what + ': midpoint ' + a + ',' + b);
      near(r.x, a, 1e-3, what + ' mid x'); near(r.y, b, 1e-3, what + ' mid y');
    }
  }
  // a short arc (one chord) has no midpoint snap either; insert markers and text anchors snap as 'end'
  const A = load([...sec('BLOCKS', block('B', [])), ...ents([[0, 'ARC'], [5, 'A'], [8, '0'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 3],
    ...insert('I1', 'B', 'MH', 50, 50), [0, 'MTEXT'], [5, 'T'], [8, 'TX'], [10, 60], [20, 60], [1, 'NOTE']])]);
  const GA = TV.buildGrid(A), onA = allOn(A);
  const cx = 10 * Math.cos(1.5 * Math.PI / 180), cy = 10 * Math.sin(1.5 * Math.PI / 180);
  assert.strictEqual(TV.snap(GA, A, cx, cy, 0.05, onA), null, 'no midpoint on a short arc');
  assert.strictEqual(TV.snap(GA, A, 10, 0.01, 0.05, onA).kind, 'end', 'the arc start is a true vertex');
  assert.deepStrictEqual(TV.snap(GA, A, 50.1, 50, 0.5, onA), { x: 50, y: 50, kind: 'end' }, 'insert marker');
  assert.deepStrictEqual(TV.snap(GA, A, 60, 60.1, 0.5, onA), { x: 60, y: 60, kind: 'end' }, 'text anchor');
}

// ---- fix round 1: exact vertices on a long georeferenced entity (R7); sampled runs never snap (R8); decoder checks ----
{
  // a 111.8 km two-point polyline in mm at (500,000,000; 2,700,000,000) with fractional coordinates: exact ends and midpoint
  const X0 = 500000000.1234, Y0 = 2700000000.5678, X1 = X0 + 100000.3, Y1 = Y0 + 50000.7;
  const R = load(ents(lwp('LG', [[X0, Y0], [X1, Y1]], false))), G = TV.buildGrid(R), on = allOn(R);
  assert.deepStrictEqual(TV.snap(G, R, X0 + 0.4, Y0 - 0.3, 1, on), { x: X0, y: Y0, kind: 'end' }, 'start exact');
  assert.deepStrictEqual(TV.snap(G, R, X1 - 0.2, Y1 + 0.5, 1, on), { x: X1, y: Y1, kind: 'end' }, 'end exact');
  const m = TV.snap(G, R, (X0 + X1) / 2 + 0.3, (Y0 + Y1) / 2, 1, on);
  assert.deepStrictEqual(m, { x: (X0 + X1) / 2, y: (Y0 + Y1) / 2, kind: 'mid' }, 'midpoint from the exact pair');
  // sampled runs: a SPLINE, and an ARC in a block inserted with xscale 2, yscale 1: no sample point is an end or a mid
  const sampled = [
    [ents([[0, 'SPLINE'], [5, 'S2'], [8, '0'], [70, 8], [71, 2], [72, 6], [73, 3], ...[0, 0, 0, 1, 1, 1].map(k => [40, k]), [10, 0], [20, 0], [10, 1], [20, 1], [10, 2], [20, 0]]), [[0, 0], [2, 0]], 'SPLINE'],
    [[...sec('BLOCKS', block('BA', [[0, 'ARC'], [5, 'A1'], [8, '0'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]])),
      ...ents([[0, 'INSERT'], [5, 'I1'], [8, '0'], [2, 'BA'], [10, 0], [20, 0], [41, 2], [42, 1]])], [[20, 0], [0, 10]], 'ARC under non-uniform scale'],
  ];
  for (const [pairs, ends, what] of sampled) {
    const S = load(pairs), GS = TV.buildGrid(S), onS = allOn(S), i = Array.from(S.kind).indexOf(0);
    const st = S.start[i], c = S.count[i];
    assert.ok(c > 10, what + ': sampled into ' + c + ' points');
    const tol = 1e-3;
    for (let k = st + 1; k < st + c - 1; k++) {
      const wx = S.eo[2 * i] + S.pts[2 * k], wy = S.eo[2 * i + 1] + S.pts[2 * k + 1];
      assert.strictEqual(TV.snap(GS, S, wx, wy, tol, onS), null, what + ': sample ' + (k - st) + ' is no snap target');
      const nx = S.eo[2 * i] + S.pts[2 * k + 2], ny = S.eo[2 * i + 1] + S.pts[2 * k + 3];
      assert.strictEqual(TV.snap(GS, S, (wx + nx) / 2, (wy + ny) / 2, tol, onS), null, what + ': no chord midpoint ' + (k - st));
    }
    for (const [a, b] of ends) { const r = TV.snap(GS, S, a + 1e-4, b, tol, onS); assert.strictEqual(r && r.kind, 'end', what + ': run end'); near(r.x, a, 1e-9); near(r.y, b, 1e-9); }
  }
  // decoder: a format 2 file is refused by version; a truncated format 3 file by size
  const d = parseDxf(dxf(ents([...line('A', 'K', 0, 0, 5, 0), ...lwp('S', sq(10, 0, 2), true, 'K')]))), buf = buildRender(d, flatten(d, { withSegs: true }));
  const hl = buf.readUInt32LE(0), hdr = buf.subarray(4, 4 + hl).toString('utf8').replace('"version":3', '"version":2');
  const v2 = Buffer.concat([buf.subarray(0, 4), Buffer.from(hdr, 'utf8'), buf.subarray(4 + hl)]);
  assert.throws(() => TV.decodeRender(v2.buffer.slice(v2.byteOffset, v2.byteOffset + v2.length)), /invalid display file: version 2, expected 3/);
  for (const cut of [1, 3, 8, 17]) {
    const tr = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - cut);
    assert.throws(() => TV.decodeRender(tr), /invalid display file: size/, 'truncated by ' + cut);
  }
  const extra = new Uint8Array(buf.length + 8); extra.set(buf);
  assert.throws(() => TV.decodeRender(extra.buffer), /invalid display file: size/, 'trailing bytes');
}

// ---- preview totals (display only): two 5 m lines drawn in mm → 10 ----
{
  const R = load(ents([...line('A', '0', 0, 0, 5000, 0), ...line('B', '0', 0, 1000, 0, 6000), ...lwp('S', sq(0, 0, 2000), true),
    [0, 'MLINE'], [5, 'M1'], [8, 'K']]));
  const all = Uint32Array.from({ length: R.n }, (_, i) => i);
  assert.deepStrictEqual(TV.previewTotal(R, [0, 1], 'open_length', 0.001), { value: 10, used: 2 });
  assert.deepStrictEqual(TV.previewTotal(R, all, 'open_length', 0.001), { value: 10, used: 2 });
  assert.deepStrictEqual(TV.previewTotal(R, all, 'closed_perimeter', 0.001), { value: 8, used: 1 });
  const a = TV.previewTotal(R, all, 'area', 0.001); near(a.value, 4, 1e-12); assert.strictEqual(a.used, 1);
  assert.deepStrictEqual(TV.previewTotal(R, all, 'count', 0.001), { value: 0, used: 0 });
  const M = load([...sec('BLOCKS', block('B', [])), ...ents([...insert('I1', 'B', 'MH', 1, 1), ...insert('I2', 'B', 'MH', 2, 1)])]);
  assert.deepStrictEqual(TV.previewTotal(M, [0, 1], 'count', 1), { value: 2, used: 2 });
  assert.throws(() => TV.previewTotal(R, all, 'volume', 1), /metric/);
}

// ---- preview = the saved quantity: previewTotal agrees with the server's selectionTotals for every metric ----
{
  const { selectionTotals, METRICS } = require('./lib/dxf/select.js');
  const insertRC = (h, name, layer, x, y, cols, rows) => [...insert(h, name, layer, x, y), [70, cols], [71, rows], [44, 10], [45, 5]];
  const d = parseDxf(dxf([...sec('BLOCKS', [...block('B', []), ...block('BL', line('BL1', '0', 0, 0, 1, 0))]), ...ents([
    ...hatch('HA', [hpoly(sq(0, 0, 10)), hpoly(sq(4, 4, 2))], 'H'), ...lwp('PL', sq(20, 0, 7), true, 'P'),
    ...line('L1', 'K', 0, 50, 3000, 50), ...line('L2', 'K', 0, 60, 1234.5, 60), ...lwp('OP', [[0, 70], [10, 70], [10, 80]], false, 'K'),
    ...insertRC('MI', 'B', 'MH', 100, 100, 3, 2), ...insert('IN', 'B', 'MH', 200, 200), ...insertRC('MB', 'BL', 'MH', 300, 300, 2, 2),
    [0, 'MTEXT'], [5, 'T'], [8, 'TX'], [10, 60], [20, 60], [1, 'NOTE'], [0, 'MLINE'], [5, 'M1'], [8, 'K']])]));
  const flat = flatten(d, { withSegs: true }), buf = buildRender(d, flat), R = TV.decodeRender(buf.buffer, buf.byteOffset);
  assert.deepStrictEqual(R.handles, flat.map(e => e.handle));
  assert.strictEqual(new Set(R.handles).size, R.n, 'handles unique in this fixture');
  const all = Array.from({ length: R.n }, (_, i) => i), f = 0.001;
  for (const sel of [all, all.filter(i => i % 2 === 0), all.filter(i => i % 3 === 1)]) {
    for (const metric of METRICS) {
      const p = TV.previewTotal(R, sel, metric, f), s = selectionTotals(flat, sel.map(i => R.handles[i]), metric);
      const want = metric === 'area' ? s.base * f * f : metric === 'count' ? s.base : s.base * f;
      if (metric === 'area') near(p.value, want, 1e-9 * Math.max(1, Math.abs(want)), metric);
      else assert.strictEqual(p.value, want, metric + ' over ' + sel.length + ' entities');
      assert.strictEqual(p.used, s.used, metric + ' used');
    }
  }
  assert.strictEqual(TV.previewTotal(R, all, 'closed_perimeter', 1).value, 28, 'the hatch has no perimeter: only the polyline');
  assert.strictEqual(TV.previewTotal(R, all, 'count', 1).value, 6 + 1 + 4, 'MINSERT counts rows × cols');
  for (const bad of [0, -1, NaN, Infinity, '1', null, undefined]) assert.throws(() => TV.previewTotal(R, all, 'area', bad), /unit factor/);
}

// ---- final review item 1: nested inserts (kind 5) are counted only with the nested toggle; preview = saved either way ----
{
  const { selectionTotals } = require('./lib/dxf/select.js');
  const doors = [];
  for (let i = 0; i < 10; i++) doors.push(...insert('D' + i, 'DOOR', 'DR', i * 10, 0));
  const d = parseDxf(dxf([...sec('BLOCKS', [...block('HINGE', line('HL', '0', 0.5, 0, 0.6, 0)), ...block('DOOR', [...line('DL', '0', 0, 0, 1, 0), ...insert('H1', 'HINGE', '0', 0, 0), ...insert('H2', 'HINGE', '0', 0, 2)]),
    ...block('WINDOW', line('WL', '0', 0, 0, 2, 0))]), ...ents([...doors, ...insert('W1', 'WINDOW', 'WN', 0, 50)])]));
  const flat = flatten(d, { withSegs: true }), buf = buildRender(d, flat), R = TV.decodeRender(buf.buffer, buf.byteOffset);
  assert.strictEqual(ids(R.kind).filter(k => k === 5).length, 20, 'nested markers are kind 5');
  const G = TV.buildGrid(R), on = allOn(R);
  // a window around the doors takes the doors, their contents and the nested markers (kind 5 is hit and boxed like kind 2)
  const win = ids(TV.boxSelect(G, R, [-1, -1, 100, 3], 'window', on));
  assert.strictEqual(win.filter(i => R.kind[i] === 5).length, 20); assert.strictEqual(win.filter(i => R.kind[i] === 2).length, 10);
  const h5 = R.handles.indexOf('D3/H2');
  assert.strictEqual(R.kind[h5], 5); assert.strictEqual(TV.hitTest(G, R, 30, 2, 0.01, on), h5, 'a nested marker is hit');
  const doorsOnly = win, all = Array.from({ length: R.n }, (_, i) => i);
  for (const [sel, nested, want] of [[doorsOnly, false, 10], [doorsOnly, true, 30], [all, false, 11], [all, true, 31]]) {
    const p = TV.previewTotal(R, sel, 'count', 1, { nested }), s = selectionTotals(flat, sel.map(i => R.handles[i]), 'count', { nested });
    assert.strictEqual(p.value, want, 'preview count nested=' + nested); assert.strictEqual(p.value, s.base, 'preview = saved'); assert.strictEqual(p.used, s.used);
  }
  assert.strictEqual(TV.previewTotal(R, doorsOnly, 'count', 1).value, 10, 'default: top level only');
  // per-block breakdown (by name), top and nested apart, in name order
  assert.deepStrictEqual(TV.previewBlocks(R, doorsOnly), [{ block: 'DOOR', top: 10, nested: 0 }, { block: 'HINGE', top: 0, nested: 20 }]);
  assert.deepStrictEqual(TV.previewBlocks(R, all).map(b => b.block), ['DOOR', 'HINGE', 'WINDOW']);
  assert.deepStrictEqual(TV.previewBlocks(R, []), []);
}

// ---- hit ties: two exact copies → the topmost (drawn last, highest index) ----
{
  const R = load(ents([...line('C1', '0', 0, 0, 10, 0), ...line('C2', '0', 0, 0, 10, 0), ...line('X', '0', 0, 5, 10, 5)]));
  const G = TV.buildGrid(R), on = allOn(R);
  assert.strictEqual(TV.hitTest(G, R, 5, 0.01, 0.1, on), 1, 'exact copies: the topmost wins');
  assert.strictEqual(TV.hitTest(G, R, 5, 0, 0.1, on), 1);
  const Q = load(ents([...lwp('Q1', sq(0, 0, 10), true), ...lwp('Q2', sq(0, 0, 10), true)])), GQ = TV.buildGrid(Q);
  assert.strictEqual(TV.hitTest(GQ, Q, 5, 5, 0.1, allOn(Q)), 1, 'inside two exact copies: the topmost');
}

// ---- performance: 100k lines ----
{
  const side = 317, list = [];   // ~100k short lines on a 10 km square
  let k = 0;
  for (let i = 0; i < side; i++) for (let j = 0; j < side && k < 100000; j++, k++) {
    const x = i * 31.5, y = j * 31.5;
    list.push(...line('P' + k.toString(16), 'L' + (k % 7), x, y, x + 20, y + 10));
  }
  const R = load(ents(list));
  assert.strictEqual(R.n, 100000);
  const on = allOn(R);
  let t = process.hrtime.bigint();
  const G = TV.buildGrid(R);
  const tGrid = Number(process.hrtime.bigint() - t) / 1e6;
  const ext = R.bbox[2] - R.bbox[0], w = ext / 10;   // 1 % of the area
  t = process.hrtime.bigint();
  const vis = TV.visible(G, R, [R.bbox[0] + 4 * w, R.bbox[1] + 4 * w, R.bbox[0] + 5 * w, R.bbox[1] + 5 * w], on);
  const tVis = Number(process.hrtime.bigint() - t) / 1e6;
  console.log('viewer: grid over 100k lines ' + tGrid.toFixed(1) + ' ms; visible(1 %) ' + tVis.toFixed(2) + ' ms → ' + vis.length + ' entities');
  assert.ok(tGrid < 1000, 'grid build ' + tGrid + ' ms');
  assert.ok(tVis < 20, 'visible ' + tVis + ' ms');
  assert.ok(vis.length > 900 && vis.length < 1300, 'about 1 % visible: ' + vis.length);
  assert.strictEqual(TV.visible(G, R, R.bbox, on).length, 100000);
  // the hit test agrees with the brute force distance
  const i = TV.hitTest(G, R, 31.5 * 100 + 10, 31.5 * 200 + 5, 0.5, on);
  assert.strictEqual(R.handles[i], 'P' + (100 * side + 200).toString(16));
}

// ---- oversize: an entity spanning the whole drawing is still found everywhere without filling every cell ----
{
  const list = [...line('BIG', '0', 0, 0, 1000, 1000)];
  for (let k = 0; k < 400; k++) list.push(...line('s' + k, '0', (k % 20) * 50, Math.floor(k / 20) * 50, (k % 20) * 50 + 1, Math.floor(k / 20) * 50));
  const R = load(ents(list)), G = TV.buildGrid(R), on = allOn(R);
  assert.ok(ids(G.over).includes(0), 'the huge entity is in the oversize list');
  assert.strictEqual(TV.hitTest(G, R, 777, 777.01, 0.1, on), 0);
  assert.ok(ids(TV.visible(G, R, [500, 500, 501, 501], on)).includes(0));
  assert.ok(ids(TV.boxSelect(G, R, [499, 499.5, 501, 500.5], 'crossing', on)).includes(0));
}

console.log('viewer core: all tests passed');
