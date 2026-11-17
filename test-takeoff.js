// Take-off (batch 3) pure tests: image size reader, synthetic fixtures, vendored pdf.js: node --no-warnings test-takeoff.js
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { imageSize } = require('./lib/takeoff/imagesize.js');
const { scaleOf, calibrationFor, verifyPct, normRect, rectsOverlap } = require('./lib/takeoff/calib.js');
const { makePdf, PDF_PAGES, makePng, pngHeader, jpegHeader } = require('./test/fixtures/make-takeoff.js');

// ---- imageSize: PNG IHDR, JPEG SOFn, refusals ------------------------------------------------------------
assert.deepStrictEqual(imageSize(pngHeader(640, 480)), { type: 'png', width: 640, height: 480 });
assert.deepStrictEqual(imageSize(makePng(64, 48)), { type: 'png', width: 64, height: 48 });
assert.deepStrictEqual(imageSize(jpegHeader(1200, 900, 0xc2)), { type: 'jpeg', width: 1200, height: 900 }, 'progressive (SOF2)');
assert.deepStrictEqual(imageSize(jpegHeader(800, 600, 0xc0)), { type: 'jpeg', width: 800, height: 600 }, 'baseline (SOF0)');
// DHT (C4), JPG (C8) and DAC (CC) are not frame headers: skipped, the walk goes on to the SOF
{
  const j = jpegHeader(320, 200, 0xc1), i = j.indexOf(Buffer.from([0xff, 0xdb]));
  const dht = Buffer.from([0xff, 0xc4, 0, 3, 0]);
  assert.deepStrictEqual(imageSize(Buffer.concat([j.subarray(0, i), dht, j.subarray(i)])), { type: 'jpeg', width: 320, height: 200 });
}
const notImage = { message: 'not a PNG or JPEG image' }, tooLarge = { message: 'image too large (max 20000 px per side)' };
{
  const j = jpegHeader(1200, 900), sof = j.indexOf(Buffer.from([0xff, 0xc2]));
  for (const cut of [3, 10, sof + 2, sof + 6]) assert.throws(() => imageSize(j.subarray(0, cut)), notImage, 'truncated JPEG at ' + cut);
  // no frame header before the scan or the end
  const noSof = Buffer.concat([j.subarray(0, sof), Buffer.from([0xff, 0xd9])]);
  assert.throws(() => imageSize(noSof), notImage, 'JPEG without SOF');
}
assert.throws(() => imageSize(pngHeader(30000, 100)), tooLarge);
assert.throws(() => imageSize(pngHeader(100, 20001)), tooLarge);
assert.deepStrictEqual(imageSize(pngHeader(20000, 20000)), { type: 'png', width: 20000, height: 20000 }, '20000 px is allowed');
assert.throws(() => imageSize(jpegHeader(30000, 900)), tooLarge);
assert.throws(() => imageSize(pngHeader(0, 10)), notImage, 'zero width');
assert.throws(() => imageSize(jpegHeader(10, 0)), notImage, 'zero height (DNL) is not supported');
assert.throws(() => imageSize(pngHeader(640, 480).subarray(0, 20)), notImage, 'truncated PNG');
{
  const p = pngHeader(640, 480); p.write('IDAT', 12, 'latin1');
  assert.throws(() => imageSize(p), notImage, 'first chunk is not IHDR');
}
let seed = 7;
const rnd = Buffer.alloc(4096).map(() => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff);
assert.throws(() => imageSize(rnd), notImage, 'random bytes');
assert.throws(() => imageSize(Buffer.alloc(0)), notImage, 'empty');
assert.throws(() => imageSize(makePdf()), notImage, 'a PDF is not an image');

// ---- the PDF fixture: a correct xref (every offset points at its object) --------------------------------------
{
  const s = makePdf().toString('latin1');
  assert.ok(s.startsWith('%PDF-'));
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1]);
  assert.ok(s.startsWith('xref\n', start));
  const rows = s.slice(start).split('\n').slice(2, 9);
  assert.strictEqual(rows[0], '0000000000 65535 f ');
  rows.slice(1).forEach((r, i) => { assert.match(r, /^\d{10} 00000 n $/); assert.ok(s.startsWith(`${i + 1} 0 obj\n`, Number(r.slice(0, 10))), 'offset of object ' + (i + 1)); });
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) assert.ok(s.startsWith('endstream', m.index + m[0].length + Number(m[1])), 'stream length');
  assert.deepStrictEqual(PDF_PAGES.map(p => p.rotation), [0, 90]);
}

// ---- vendored pdf.js: exactly the three files, each matching the sha256 in its README --------------------------
{
  const dir = path.join(__dirname, 'public', 'vendor', 'pdfjs');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /4\.10\.38/); assert.match(readme, /https:\/\/registry\.npmjs\.org\/pdfjs-dist\/-\/pdfjs-dist-4\.10\.38\.tgz/);
  const listed = Object.fromEntries([...readme.matchAll(/`([\w.-]+)`\s*\|\s*`([0-9a-f]{64})`/g)].map(m => [m[1], m[2]]));
  assert.deepStrictEqual(Object.keys(listed).sort(), ['LICENSE', 'pdf.min.mjs', 'pdf.worker.min.mjs']);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['LICENSE', 'README.md', 'pdf.min.mjs', 'pdf.worker.min.mjs'], 'nothing else vendored');
  for (const [f, sha] of Object.entries(listed)) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'), sha, f);
}

// ---- calibration: scale (metres per page unit), region lookup, verify % ---------------------------------------
{
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg}: ${a} vs ${b}`);
  near(scaleOf([0, 0], [100, 0], 5, 'm'), 0.05, '100 units = 5 m');
  near(scaleOf([0, 0], [100, 0], 5000, 'mm'), 0.05, '100 units = 5000 mm');
  near(scaleOf([10, 10], [40, 50], 1, 'ft'), 0.3048 / 50, 'diagonal 50 units = 1 ft');
  near(scaleOf([0, 0], [0, 10], 1, 'in'), 0.00254, 'exactly 10 units apart is allowed');
  const tooClose = { message: /at least 10/ };
  assert.throws(() => scaleOf([0, 0], [5, 0], 5, 'm'), tooClose, 'distance 5 → throws');
  assert.throws(() => scaleOf([0, 0], [6, 7.9], 5, 'm'), tooClose, 'distance just under 10 → throws');
  assert.throws(() => scaleOf([3, 3], [3, 3], 5, 'm'), tooClose, 'the same point twice');
  for (const real of [0, -5, NaN, Infinity, '5', null, undefined]) assert.throws(() => scaleOf([0, 0], [100, 0], real, 'm'), /real length/, 'real ' + String(real));
  for (const unit of ['yd', 'M', '', null, 'constructor', '__proto__']) assert.throws(() => scaleOf([0, 0], [100, 0], 5, unit), /unit/, 'unit ' + String(unit));
  for (const p of [[0], [0, NaN], [0, Infinity], 'x', null, [0, '1'], [0, 1, 2]]) assert.throws(() => scaleOf(p, [100, 0], 5, 'm'), /point/, 'point ' + JSON.stringify(p));

  // regions: [minx, miny, maxx, maxy]; edges belong to the region; touching at an edge is no overlap
  assert.deepStrictEqual(normRect([300, 400, 100, 200]), [100, 200, 300, 400]);
  assert.throws(() => normRect([0, 0, 0, 10]), /size/, 'zero width');
  assert.throws(() => normRect([0, 0, 10]), /region/);
  assert.throws(() => normRect([0, 0, 10, NaN]), /region/);
  assert.strictEqual(rectsOverlap([0, 0, 100, 100], [50, 50, 150, 150]), true);
  assert.strictEqual(rectsOverlap([0, 0, 100, 100], [100, 0, 200, 100]), false, 'sharing an edge');
  assert.strictEqual(rectsOverlap([0, 0, 100, 100], [100, 100, 200, 200]), false, 'sharing a corner');
  assert.strictEqual(rectsOverlap([0, 0, 100, 100], [20, 20, 30, 30]), true, 'one inside the other');
  assert.strictEqual(rectsOverlap([0, 0, 100, 100], [99.5, -50, 300, 0.5]), true, 'a thin overlap');
  const page = { id: 1, region: null, scale: 0.05 }, reg = { id: 2, region: [100, 100, 200, 200], scale: 0.01 }, reg2 = { id: 3, region: '[200,100,300,200]', scale: 0.02 };
  const cals = [reg, page, reg2];
  assert.strictEqual(calibrationFor(cals, [150, 150]), reg, 'inside the region');
  assert.strictEqual(calibrationFor(cals, [100, 200]), reg, 'on its edge (inclusive)');
  assert.strictEqual(calibrationFor(cals, [250, 150]), reg2, 'a region stored as JSON text');
  assert.strictEqual(calibrationFor(cals, [200, 150]), reg, 'the shared edge of two regions: the lower id');
  assert.strictEqual(calibrationFor([reg2, reg], [200, 150]), reg, 'the lower id whatever the order');
  assert.strictEqual(calibrationFor(cals, [50, 50]), page, 'outside every region → page');
  assert.strictEqual(calibrationFor([reg], [50, 50]), null, 'no page calibration → null');
  assert.strictEqual(calibrationFor([], [50, 50]), null);

  // verify: line 200 units at 0.05 m/unit = 10 m measured, 10.2 m real → −1.96 %
  const pct = verifyPct({ scale: 0.05 }, [0, 0], [200, 0], 10.2, 'm');
  near(pct, (10 - 10.2) / 10.2 * 100, 'verify %'); assert.ok(Math.abs(pct + 1.96) < 0.005 && Math.abs(pct) > 1);
  near(verifyPct({ scale: 0.05 }, [0, 0], [0, 200], 10000, 'mm'), 0, 'exact in mm');
  assert.throws(() => verifyPct({ scale: 0.05 }, [0, 0], [5, 0], 1, 'm'), /at least 10/);
  assert.throws(() => verifyPct({ scale: 0.05 }, [0, 0], [50, 0], 0, 'm'), /real length/);
  // non-finite or zero results never pass as a number (1e306 km overflows to Infinity, 5e-324 mm underflows to 0)
  assert.throws(() => scaleOf([0, 0], [100, 0], 1e306, 'km'), /real length/, 'real in metres overflows');
  assert.throws(() => scaleOf([0, 0], [100, 0], 5e-324, 'mm'), /real length/, 'real in metres underflows to 0');
  assert.throws(() => scaleOf([0, 0], [1e9, 0], 1e-320, 'm'), /scale/, 'scale underflows to 0');
  assert.throws(() => verifyPct({ scale: 0.05 }, [0, 0], [200, 0], 1e306, 'km'), /real length/, 'verify: real overflows');
  assert.throws(() => verifyPct({ scale: 1e308 }, [-1e9, 0], [1e9, 0], 1e-300, 'm'), /verify/, 'verify: % overflows');
  assert.throws(() => verifyPct({ scale: NaN }, [0, 0], [200, 0], 10, 'm'), /verify/, 'verify: bad stored scale');
  for (const p of [[NaN, 0], [0, Infinity], null, [1]]) assert.throws(() => calibrationFor(cals, p), /point/, 'calibrationFor ' + JSON.stringify(p));
}

// ---- manual measurements (lib/takeoff/manual.js, UMD): the same cases in Node and in a browser-like vm context ----
{
  const MANUAL = path.join(__dirname, 'lib', 'takeoff', 'manual.js');
  const node = require(MANUAL);
  // the browser path: a plain script with no module/require, which sets window.TakeoffManual
  const vm = require('vm'), sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(MANUAL, 'utf8'), sandbox, { filename: 'manual.js' });
  const browser = sandbox.window.TakeoffManual;
  assert.ok(browser && typeof browser.manualQty === 'function', 'the UMD sets window.TakeoffManual');
  assert.strictEqual(sandbox.module, undefined); assert.strictEqual(typeof sandbox.require, 'undefined');
  const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  for (const [where, M] of [['node', node], ['vm', browser]]) {
    const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${where} ${msg}: ${a} vs ${b}`);
    const plain = v => JSON.parse(JSON.stringify(v));   // vm objects come from another realm
    const q = (g, o) => plain(M.manualQty(g, o));
    const throwsMsg = (fn, re, msg) => { let err = null; try { fn(); } catch (e) { err = e; } assert.ok(err && re.test(err.message), `${where} ${msg}: ${err ? err.message : 'no throw'}`); };
    const poly = { tool: 'polyline', pts: [[0, 0], [30, 40], [30, 100]] };

    // polyline 50 + 60 = 110 units × 0.1 → 11 m
    let r = q(poly, { scale: 0.1 });
    near(r.base, 11, 'polyline base'); near(r.qty, 11, 'polyline qty'); assert.strictEqual(r.unit, 'm'); assert.strictEqual(r.qty_unit, 'm');
    r = q({ tool: 'line', pts: [[0, 0], [0, 250]] }, { scale: 0.02 });
    near(r.qty, 5, 'line'); assert.strictEqual(r.qty_unit, 'm');
    // area 100×100 minus a 20×20 hole at 0.05 m/unit → (10000 − 400) × 0.0025 = 24 m²
    const area = { tool: 'area', outer: sq(0, 0, 100), holes: [sq(40, 40, 20)] };
    r = q(area, { scale: 0.05 });
    near(r.base, 24, 'area base'); near(r.qty, 24, 'area qty'); assert.strictEqual(r.unit, 'm2'); assert.strictEqual(r.qty_unit, 'm2');
    near(r.perimeter, 24, 'an area also reports its perimeter');
    // the same outline drawn clockwise: same area
    near(q({ tool: 'area', outer: sq(0, 0, 100).reverse(), holes: [sq(40, 40, 20)] }, { scale: 0.05 }).qty, 24, 'clockwise');
    // metric perimeter: outer + holes = (400 + 80) × 0.05 = 24 m
    r = q(area, { scale: 0.05, metric: 'perimeter' });
    near(r.qty, 24, 'perimeter'); assert.strictEqual(r.qty_unit, 'm');
    // width on a length → m2; width + depth → m3; depth on an area → m3; factor; deduct → negative
    r = q(poly, { scale: 0.1, width: 0.5 }); near(r.base, 11, 'base before width'); near(r.qty, 5.5, 'width'); assert.strictEqual(r.qty_unit, 'm2');
    r = q(poly, { scale: 0.1, width: 0.5, depth: 2 }); near(r.qty, 11, 'width × depth'); assert.strictEqual(r.qty_unit, 'm3');
    r = q(area, { scale: 0.05, depth: 0.25 }); near(r.qty, 6, 'area × depth'); assert.strictEqual(r.qty_unit, 'm3');
    r = q(area, { scale: 0.05, depth: 0.25, factor: 2 }); near(r.qty, 12, 'factor 2');
    r = q(area, { scale: 0.05, factor: 2, deduct: true }); near(r.qty, -48, 'deduct'); near(r.base, 24, 'the base stays positive'); assert.strictEqual(r.qty_unit, 'm2');
    throwsMsg(() => M.manualQty(area, { scale: 0.05, width: 2 }), /depth, not width/, 'width on an area');
    throwsMsg(() => M.manualQty(poly, { scale: 0.1, depth: 2 }), /depth needs a width/, 'depth without width');
    // rect: corners in any order; area or perimeter
    r = q({ tool: 'rect', p1: [50, 30], p2: [10, 10] }, { scale: 0.5 }); near(r.qty, 200, 'rect 40×20 × 0.25'); assert.strictEqual(r.qty_unit, 'm2');
    near(q({ tool: 'rect', p1: [50, 30], p2: [10, 10] }, { scale: 0.5, metric: 'perimeter' }).qty, 60, 'rect perimeter');
    // count: the number of points; scale plays no part; width/depth refused
    r = q({ tool: 'count', pts: [[1, 1], [5, 5], [9, 1]] }, { scale: 0.05, factor: 2 });
    near(r.base, 3, 'count base'); near(r.qty, 6, 'count × factor'); assert.strictEqual(r.qty_unit, 'nr');
    throwsMsg(() => M.manualQty({ tool: 'count', pts: [[1, 1]] }, { scale: 0.05, width: 1 }), /width and depth do not apply to a count/, 'count with width');
    throwsMsg(() => M.manualQty({ tool: 'count', pts: [[1, 1]] }, { scale: 0.05, depth: 1 }), /count/, 'count with depth');
    throwsMsg(() => M.manualQty(poly, { scale: 0.1, metric: 'area' }), /metric/, 'metric on a line');
    // options
    for (const o of [{}, { scale: 0 }, { scale: -1 }, { scale: NaN }, { scale: Infinity }, { scale: '0.1' }]) throwsMsg(() => M.manualQty(poly, o), /scale/, 'scale ' + JSON.stringify(o));
    for (const k of ['width', 'depth', 'factor']) for (const v of [0, -1, NaN, Infinity, '1']) throwsMsg(() => M.manualQty(k === 'depth' ? area : poly, { scale: 0.1, [k]: v }), new RegExp(k), k + ' ' + String(v));
    throwsMsg(() => M.manualQty(poly, { scale: 0.1, deduct: 'yes' }), /deduct/, 'deduct must be a boolean');
    throwsMsg(() => M.manualQty(area, { scale: 0.05, metric: 'volume' }), /metric/, 'unknown metric');
    throwsMsg(() => M.manualQty(poly, { scale: 1e300, width: 1e6, depth: 1e6 }), /out of range/, 'overflow');

    // validateGeom: outlines that self-intersect (proper, through a vertex, T, along a collinear stretch)
    const outer = pts => ({ tool: 'area', outer: pts, holes: [] });
    throwsMsg(() => M.validateGeom(outer([[0, 0], [10, 10], [10, 0], [0, 10]])), /self-intersect/, 'bowtie');
    throwsMsg(() => M.validateGeom(outer([[0, 0], [5, 5], [10, 10], [10, 0], [5, 5], [0, 10]])), /self-intersect/, 'bowtie crossing through a vertex');
    throwsMsg(() => M.validateGeom(outer([[0, 0], [10, 0], [10, 5], [5, 0], [5, -5], [0, -5]])), /self-intersect/, 'T crossing: a vertex on an edge');
    throwsMsg(() => M.validateGeom(outer([[0, 0], [10, 0], [10, -4], [8, -4], [8, 0], [2, 0], [2, -4], [0, -4]])), /self-intersect/, 'collinear overlap (conservative rule)');
    throwsMsg(() => M.manualQty(outer([[0, 0], [10, 10], [10, 0], [0, 10]]), { scale: 1 }), /self-intersect/, 'manualQty validates');
    // touching at one vertex without crossing (batch-1 rule: not a crossing) → the two lobes' area
    near(q(outer([[0, 0], [4, 0], [5, 5], [6, 0], [10, 0], [10, 10], [6, 10], [5, 5], [4, 10], [0, 10]]), { scale: 1 }).qty, 90, 'pinched outline');
    throwsMsg(() => M.validateGeom(outer([[0, 0], [10, 0], [20, 0]])), /self-intersect/, 'a flat outline (it doubles back)');
    // holes: strictly inside, never touching the outline or each other, never nested, never self-intersecting
    const withHoles = holes => ({ tool: 'area', outer: sq(0, 0, 100), holes });
    throwsMsg(() => M.validateGeom(withHoles([sq(200, 200, 10)])), /hole 1 lies outside the outline/, 'a hole outside');
    throwsMsg(() => M.validateGeom(withHoles([sq(90, 40, 20)])), /hole 1 touches or crosses the outline/, 'a hole crossing the outline');
    throwsMsg(() => M.validateGeom(withHoles([sq(0, 40, 20)])), /hole 1 touches or crosses the outline/, 'a hole along the outline');
    throwsMsg(() => M.validateGeom(withHoles([[[0, 50], [20, 40], [20, 60]]])), /hole 1 touches or crosses the outline/, 'a hole touching the outline at a vertex');
    throwsMsg(() => M.validateGeom(withHoles([sq(10, 10, 20), sq(25, 25, 20)])), /holes 1 and 2 touch or cross/, 'overlapping holes');
    throwsMsg(() => M.validateGeom(withHoles([sq(10, 10, 20), sq(30, 10, 20)])), /holes 1 and 2 touch or cross/, 'holes sharing an edge');
    throwsMsg(() => M.validateGeom(withHoles([sq(10, 10, 40), sq(20, 20, 10)])), /hole 2 lies inside hole 1/, 'a hole inside a hole');
    throwsMsg(() => M.validateGeom(withHoles([[[10, 10], [20, 20], [20, 10], [10, 20]]])), /hole 1 must not self-intersect/, 'a bowtie hole');
    near(q(withHoles([sq(10, 10, 20), sq(50, 50, 20)]), { scale: 1 }).qty, 10000 - 800, 'two holes');
    // rect, points, sizes
    throwsMsg(() => M.validateGeom({ tool: 'rect', p1: [5, 5], p2: [5, 50] }), /size/, 'a rect of zero width');
    throwsMsg(() => M.validateGeom({ tool: 'rect', p1: [5, 5], p2: [5, 5] }), /size/, 'a rect of zero size');
    throwsMsg(() => M.validateGeom({ tool: 'polyline', pts: [[0, 0], [1, 1], [1, 1], [2, 0]] }), /repeated point/, 'repeated consecutive points');
    throwsMsg(() => M.validateGeom(outer([[0, 0], [10, 0], [10, 10], [0, 0]])), /repeated point/, 'an outline whose last point repeats the first');
    throwsMsg(() => M.validateGeom({ tool: 'count', pts: [[3, 3], [3, 3]] }), /repeated point/, 'the same count point twice');
    for (const p of [[0, NaN], [0, Infinity], [0, 1e9 + 1], [0], [0, '1'], null, [0, 1, 2]]) throwsMsg(() => M.validateGeom({ tool: 'polyline', pts: [[0, 0], p] }), /point/, 'point ' + JSON.stringify(p));
    near(q({ tool: 'line', pts: [[-1e9, 0], [1e9, 0]] }, { scale: 1e-9 }).qty, 2, '±1e9 is allowed');
    throwsMsg(() => M.validateGeom({ tool: 'polyline', pts: [[0, 0]] }), /at least 2/, 'one point');
    throwsMsg(() => M.validateGeom({ tool: 'line', pts: [[0, 0], [1, 0], [2, 0]] }), /line/, 'a line has 2 points');
    throwsMsg(() => M.validateGeom(outer([[0, 0], [1, 0]])), /at least 3/, 'outer of 2 points');
    throwsMsg(() => M.validateGeom(withHoles([[[10, 10], [20, 10]]])), /at least 3/, 'hole of 2 points');
    throwsMsg(() => M.validateGeom({ tool: 'count', pts: [] }), /at least 1/, 'no count point');
    throwsMsg(() => M.validateGeom({ tool: 'polyline', pts: Array.from({ length: 10001 }, (_, i) => [i, i % 2]) }), /at most 10000/, 'too many points (R13)');
    throwsMsg(() => M.validateGeom({ tool: 'area', outer: sq(0, 0, 1000), holes: Array.from({ length: 2500 }, (_, i) => sq(10 + (i % 50) * 19, 10 + Math.floor(i / 50) * 19, 5)) }), /at most 10000/, 'outer + holes over 10000');
    // R15: count points all distinct; rings never double back along themselves (a polyline may)
    throwsMsg(() => M.validateGeom({ tool: 'count', pts: [[1, 1], [2, 2], [1, 1]] }), /repeated point/, 'a count point repeated later');
    for (const ring of [[[0, 0], [10, 0], [10, 10], [6, 10], [6, 20], [6, 10], [0, 10]], [[0, 0], [10, 0], [10, 10], [6, 10], [6, 15], [6, 11], [0, 10]], [[0, 0], [10, 0], [5, 0], [5, 5]]]) {
      throwsMsg(() => M.validateGeom(outer(ring)), /self-intersect/, 'spike ' + JSON.stringify(ring));
      throwsMsg(() => M.validateGeom(withHoles([ring.map(([x, y]) => [x + 40, y + 40])])), /hole 1 must not self-intersect/, 'spike hole ' + JSON.stringify(ring));
    }
    throwsMsg(() => M.validateGeom(outer([[5, 0], [10, 0], [10, 10], [0, 10], [0, 0], [8, 0]])), /self-intersect/, 'a spike on the closing edge');
    near(q({ tool: 'polyline', pts: [[0, 0], [10, 0], [5, 0]] }, { scale: 1 }).qty, 15, 'a polyline may double back');
    for (const g of [null, [], 'x', { tool: 'circle' }, { tool: 'polyline' }, { tool: 'polyline', pts: [[0, 0], [1, 1]], extra: 1 }, { tool: 'area', outer: sq(0, 0, 1), holes: 'x' }])
      throwsMsg(() => M.validateGeom(g), /geom|tool|pts|outer|holes|unknown/, 'bad geom ' + JSON.stringify(g));
    // a large hand-drawn outline (a 10000-gon) validates and measures as a circle; a 10000-point comb (long teeth: the
    // worst case for a sweep along x) validates quickly (R13)
    {
      const comb = []; for (let k = 0; k < 2500; k++) comb.push([1, 2 * k], [1000, 2 * k], [1000, 2 * k + 1], [1, 2 * k + 1]);
      comb[0] = [0, 0]; comb[comb.length - 1] = [0, 4999];
      const t1 = Date.now(); M.validateGeom({ tool: 'area', outer: comb, holes: [] });
      assert.ok(Date.now() - t1 < 1500, `${where} 10000-point comb validated in ${Date.now() - t1} ms`);
      const n = 10000, R = 1000, ring = Array.from({ length: n }, (_, i) => [R * Math.cos(2 * Math.PI * i / n), R * Math.sin(2 * Math.PI * i / n)]);
      const t0 = Date.now(), a = q({ tool: 'area', outer: ring, holes: [] }, { scale: 1 }).qty;
      assert.ok(Math.abs(a - Math.PI * R * R) / (Math.PI * R * R) < 1e-6, `${where} 10000-gon area ${a}`);
      assert.ok(Date.now() - t0 < 1500, `${where} 10000-gon validated in ${Date.now() - t0} ms`);
    }

    // the validated path (R13): same result, no second validation
    assert.strictEqual(JSON.stringify(M.manualQty(area, { scale: 0.05 }, true)), JSON.stringify(M.manualQty(area, { scale: 0.05 })), `${where} validated path`);
    throwsMsg(() => M.manualQty(outer([[0, 0], [10, 10], [10, 0], [0, 10]]), { scale: 1 }, 'yes'), /self-intersect/, 'only true skips validation');
    // geomKey: identical geometry whatever the start point, direction, rect/area form or noise below 1e-6
    const k = g => M.geomKey(g);
    const ring = [[0, 0], [100, 0], [100, 50], [0, 50]];
    assert.strictEqual(k(outer(ring)), k(outer([ring[2], ring[3], ring[0], ring[1]])), `${where} rotated ring`);
    assert.strictEqual(k(outer(ring)), k(outer(ring.slice().reverse())), `${where} reversed ring`);
    assert.strictEqual(k(outer(ring)), k({ tool: 'rect', p1: [100, 50], p2: [0, 0] }), `${where} a rect = the same outline`);
    assert.strictEqual(k(outer(ring)), k(outer(ring.map(([x, y]) => [x + 1e-8, y - 1e-8]))), `${where} below 1e-6`);
    assert.notStrictEqual(k(outer(ring)), k(outer(ring.map(([x, y]) => [x + 1e-3, y]))), `${where} a real shift`);
    assert.strictEqual(k({ tool: 'area', outer: sq(0, 0, 100), holes: [sq(10, 10, 5), sq(50, 50, 5)] }), k({ tool: 'area', outer: sq(0, 0, 100), holes: [sq(50, 50, 5).reverse(), sq(10, 10, 5)] }), `${where} holes in any order`);
    assert.notStrictEqual(k(outer(sq(0, 0, 100))), k({ tool: 'area', outer: sq(0, 0, 100), holes: [sq(10, 10, 5)] }), `${where} a hole makes it different`);
    assert.strictEqual(k(poly), k({ tool: 'polyline', pts: poly.pts.slice().reverse() }), `${where} a reversed polyline`);
    assert.strictEqual(k({ tool: 'line', pts: [[0, 0], [5, 5]] }), k({ tool: 'polyline', pts: [[5, 5], [0, 0]] }), `${where} line = polyline`);
    assert.notStrictEqual(k({ tool: 'polyline', pts: [[0, 0], [5, 0], [5, 5]] }), k(outer([[0, 0], [5, 0], [5, 5]])), `${where} an open path is not an outline`);
    assert.strictEqual(k({ tool: 'count', pts: [[1, 1], [2, 2]] }), k({ tool: 'count', pts: [[2, 2], [1, 1]] }), `${where} count points in any order`);
    assert.deepStrictEqual(plain(M.firstPoint(area)), [0, 0]); assert.deepStrictEqual(plain(M.firstPoint({ tool: 'rect', p1: [7, 8], p2: [1, 1] })), [7, 8]);
    assert.strictEqual(M.pointCount(area), 8); assert.strictEqual(M.pointCount({ tool: 'rect', p1: [7, 8], p2: [1, 1] }), 2);
  }
  // node and browser give bit-identical results
  for (const [g, o] of [[{ tool: 'polyline', pts: [[0.1, 0.2], [30.3, 40.7], [31, 100.9]] }, { scale: 0.0123, width: 0.37, factor: 1.1 }],
    [{ tool: 'area', outer: [[0, 0], [97.3, 1.1], [101, 77.7], [3, 66.6]], holes: [[[10, 10], [20, 11], [15, 19]]] }, { scale: 0.0371, depth: 0.15 }]])
    assert.strictEqual(JSON.stringify(browser.manualQty(g, o)), JSON.stringify(node.manualQty(g, o)));
}

// ---- batch 4 Task 2: compare a measurement with the drawing that replaces it (lib/takeoff/compare.js), hand-built tables ----
{
  const C = require('./lib/takeoff/compare.js');
  // the new drawing's layer table in metres (as scaledTable gives it): KERB kept, ASPHALT renamed PAVING, MH with one more MH1
  const layers = [
    { layer: 'KERB', open_length: 5, closed_perimeter: 0, area: 0, blocks: [] },
    { layer: 'MH', open_length: 0, closed_perimeter: 0, area: 0, blocks: [{ name: 'MH1', top: 2, nested: 1 }, { name: 'MH2', top: 0, nested: 3 }, { name: 'GULLY', top: 1, nested: 0 }] },
    { layer: 'PAVING', open_length: 0, closed_perimeter: 40, area: 100, blocks: [] },
    { layer: 'TEXT', open_length: 0, closed_perimeter: 0, area: 0, blocks: [] },
    { layer: 'PITS', open_length: 0, closed_perimeter: 0, area: 0, blocks: [{ name: 'MH9', top: 4, nested: 0 }, { name: 'PIT', top: 1, nested: 0 }] },
  ];
  const m = (id, o) => ({ id, row_id: 1, tool: 'dxf_layer', label: null, qty: 5, qty_unit: 'm', metric: 'open_length', layer: 'KERB', block: null, nested: 0, ...o });
  // same layer and metric → its base; the item is `same` when the qty is unchanged
  assert.deepStrictEqual(C.layerMatch(layers, m(1)), { base: 5 });
  let it = C.item(m(1), { new_qty: 5 });
  assert.deepStrictEqual(it, { measurement_id: 1, row_id: 1, tool: 'dxf_layer', label: null, old_qty: 5, new_qty: 5, qty_unit: 'm', status: 'same', options: [] });
  assert.strictEqual(C.item(m(1), { new_qty: 6 }).status, 'changed');
  // layer renamed → blocked layer_missing, relink choices = the new layers with that metric > 0 (other names)
  const asph = m(2, { layer: 'ASPHALT', metric: 'area', qty: 90, qty_unit: 'm2' });
  assert.deepStrictEqual(C.layerMatch(layers, asph), { reason: 'layer_missing', relink_choices: ['PAVING'] });
  it = C.item(asph, C.layerMatch(layers, asph));
  assert.deepStrictEqual(it, { measurement_id: 2, row_id: 1, tool: 'dxf_layer', label: null, old_qty: 90, new_qty: null, qty_unit: 'm2', status: 'blocked', reason: 'layer_missing',
    options: ['delete', 'relink'], relink_choices: ['PAVING'] });
  // the layer is there but has none of the metric → blocked layer_empty (relink to one that has it)
  assert.deepStrictEqual(C.layerMatch(layers, m(3, { layer: 'TEXT' })), { reason: 'layer_empty', relink_choices: ['KERB'] });
  // nothing to relink to → delete only
  const none = C.item(m(4, { layer: 'GONE', metric: 'closed_perimeter' }), C.layerMatch([layers[0]], m(4, { layer: 'GONE', metric: 'closed_perimeter' })));
  assert.deepStrictEqual([none.status, none.reason, none.options, none.relink_choices], ['blocked', 'layer_missing', ['delete'], []]);
  // block count changed → `changed`; nested adds the nested inserts
  const blk = m(5, { tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count', qty: 1, qty_unit: 'nr' });
  assert.deepStrictEqual(C.blockMatch(layers, blk), { base: 2 });
  assert.deepStrictEqual(C.blockMatch(layers, { ...blk, nested: 1 }), { base: 3 });
  assert.strictEqual(C.item(blk, { new_qty: 2 }).status, 'changed');
  // a block gone from its layer → blocked block_missing; relink to the other blocks counted on its layer (MH2 has nested
  // inserts only) and to the same block name on any other layer (PITS/MH9), never to unrelated pairs (PITS/PIT)
  const b2 = { ...blk, block: 'MH9' };
  assert.deepStrictEqual(C.blockMatch(layers, b2), { reason: 'block_missing', relink_choices: [{ layer: 'MH', block: 'GULLY' }, { layer: 'MH', block: 'MH1' }, { layer: 'PITS', block: 'MH9' }] });
  assert.deepStrictEqual(C.blockMatch(layers, { ...b2, nested: 1 }).relink_choices.map(x => x.block), ['GULLY', 'MH1', 'MH2', 'MH9']);
  // the layer renamed (MANHOLES → MH): the same block name on any layer
  assert.deepStrictEqual(C.blockMatch(layers, { ...blk, layer: 'MANHOLES' }), { reason: 'block_missing', relink_choices: [{ layer: 'MH', block: 'MH1' }] });
  assert.deepStrictEqual(C.blockMatch(layers, { ...b2, layer: 'NOPE', block: 'NONE' }), { reason: 'block_missing', relink_choices: [] });
  assert.deepStrictEqual(C.item(b2, C.blockMatch(layers, b2)).options, ['delete', 'relink']);
  // selection: matched by handle AND geomKey. One handle reused for different geometry → not matched, geometry_changed
  const stored = [{ handle: 'A', geom_key: 'ka' }, { handle: 'B', geom_key: 'kb' }, { handle: 'C', geom_key: 'kc' }];
  assert.deepStrictEqual(C.selectionMatch(stored, new Map([['A', 'ka'], ['B', 'kb'], ['C', 'kc']]), 0), { all: true, matched: ['A', 'B', 'C'], reason: null });
  assert.deepStrictEqual(C.selectionMatch(stored, new Map([['A', 'ka'], ['B', 'kX'], ['C', 'kc']]), 0), { all: false, matched: ['A', 'C'], reason: 'geometry_changed' });
  // a handle no longer in the drawing → handles_missing
  assert.deepStrictEqual(C.selectionMatch(stored, new Map([['A', 'ka'], ['C', 'kc']]), 1), { all: false, matched: ['A', 'C'], reason: 'handles_missing' });
  // a stored row without its geomKey never matches (it cannot be told apart from a reused handle)
  assert.deepStrictEqual(C.selectionMatch([{ handle: 'A', geom_key: null }], new Map([['A', 'ka']]), 0), { all: false, matched: [], reason: 'geometry_changed' });
  const sel = m(6, { tool: 'dxf_selection', layer: null, qty: 7 });
  it = C.item(sel, { reason: 'geometry_changed', keep_matched_qty: 4 });
  assert.deepStrictEqual(it, { measurement_id: 6, row_id: 1, tool: 'dxf_selection', label: null, old_qty: 7, new_qty: null, qty_unit: 'm', status: 'blocked', reason: 'geometry_changed',
    options: ['delete', 'keep_matched'], keep_matched_qty: 4 });
  // nothing still matches → delete only
  assert.deepStrictEqual(C.item(sel, { reason: 'handles_missing', keep_matched_qty: null }).options, ['delete']);
  // manual → review manual_check (not blocking), with its recomputed qty; a missing page → blocked page_missing
  const man = m(7, { tool: 'manual', layer: null, qty: 2, label: 'Fake line' });
  assert.deepStrictEqual(C.item(man, { review: true, new_qty: 2 }), { measurement_id: 7, row_id: 1, tool: 'manual', label: 'Fake line', old_qty: 2, new_qty: 2, qty_unit: 'm',
    status: 'review', reason: 'manual_check', options: ['mark_reviewed'] });
  assert.deepStrictEqual(C.item(man, { reason: 'page_missing' }), { measurement_id: 7, row_id: 1, tool: 'manual', label: 'Fake line', old_qty: 2, new_qty: null, qty_unit: 'm',
    status: 'blocked', reason: 'page_missing', options: ['delete'] });
  // R7: a creation gate that fires on the new drawing and was never confirmed → blocked confirm_needed (which gates),
  // options delete / confirm, with the qty it gets when confirmed; a gate confirmed at creation (stored flag 1) stays quiet
  const flags = { incomplete: 0, duplicate: 0, mixed: 0 };
  assert.deepStrictEqual(C.gatesToConfirm({ incomplete: false, duplicate: false, mixed_blocks: false }, flags), []);
  assert.deepStrictEqual(C.gatesToConfirm({ incomplete: true, duplicate: true, mixed_blocks: true }, flags), ['incomplete', 'duplicate', 'mixed_blocks']);
  assert.deepStrictEqual(C.gatesToConfirm({ incomplete: true, duplicate: true, mixed_blocks: false }, { ...flags, duplicate: 1 }), ['incomplete']);
  assert.deepStrictEqual(C.gatesToConfirm({ incomplete: true, duplicate: false, mixed_blocks: true }, { incomplete: 1, duplicate: 0, mixed: 1 }), []);
  assert.deepStrictEqual(C.item(m(13), { reason: 'confirm_needed', gates: ['duplicate'], new_qty: 8 }), { measurement_id: 13, row_id: 1, tool: 'dxf_layer', label: null, old_qty: 5, new_qty: 8,
    qty_unit: 'm', status: 'blocked', reason: 'confirm_needed', gates: ['duplicate'], options: ['delete', 'confirm'] });
  // R11 (Task 3): the gate counts on the old drawing (was): a confirmed gate stays confirmed only while it did not grow
  const n0 = { incomplete: 0, duplicate: 0, mixed_blocks: 0 };
  assert.deepStrictEqual(C.gatesToConfirm({ ...n0, duplicate: 20 }, { ...flags, duplicate: 1 }, { ...n0, duplicate: 2 }), ['duplicate'], '2 → 20 duplicates');
  assert.deepStrictEqual(C.gatesToConfirm({ incomplete: 3, duplicate: 2, mixed_blocks: 2 }, { incomplete: 1, duplicate: 1, mixed: 1 }, { incomplete: 3, duplicate: 2, mixed_blocks: 2 }), [], 'unchanged');
  assert.deepStrictEqual(C.gatesToConfirm({ incomplete: 1, duplicate: 1, mixed_blocks: 0 }, { incomplete: 1, duplicate: 1, mixed: 0 }, { incomplete: 4, duplicate: 0, mixed_blocks: 0 }), ['duplicate'], 'fewer is fine');
  assert.deepStrictEqual(C.gatesToConfirm({ ...n0, mixed_blocks: 3 }, { ...flags, mixed: 1 }, { ...n0, mixed_blocks: 2 }), ['mixed_blocks']);
  // an unconfirmed gate needs confirm whatever its old count
  assert.deepStrictEqual(C.gatesToConfirm({ ...n0, incomplete: 1 }, flags, { ...n0, incomplete: 1 }), ['incomplete']);
  // the item shows the old and new counts of the gates it lists
  assert.deepStrictEqual(C.item(m(13), { reason: 'confirm_needed', gates: ['duplicate'], gate_counts: { duplicate: { old: 2, new: 20 } }, new_qty: 8 }), { measurement_id: 13, row_id: 1, tool: 'dxf_layer',
    label: null, old_qty: 5, new_qty: 8, qty_unit: 'm', status: 'blocked', reason: 'confirm_needed', gates: ['duplicate'], gate_counts: { duplicate: { old: 2, new: 20 } }, options: ['delete', 'confirm'] });
  // Task 3: a resolution sent with accept is checked against the item it resolves (null: valid). R12 shapes for relink.
  {
    const R = C.resolutionError;
    const lay = C.item(asph, C.layerMatch(layers, asph)), blkI = C.item(b2, C.blockMatch(layers, b2));
    const selI = C.item(sel, { reason: 'geometry_changed', keep_matched_qty: 4 }), conf = C.item(m(13), { reason: 'confirm_needed', gates: ['duplicate'], new_qty: 8 });
    const same = C.item(m(1), { new_qty: 5 }), gone = C.item(man, { reason: 'page_missing' });
    assert.strictEqual(R(lay, { new_qty: null }), 'needs a resolution');
    assert.strictEqual(R(lay, { resolution: 'delete', new_qty: null }), null);
    assert.strictEqual(R(lay, { resolution: 'delete', new_qty: 0 }), 'a deleted measurement has new_qty null');
    assert.strictEqual(R(lay, { resolution: 'relink', to: 'PAVING', new_qty: 100 }), null);
    assert.strictEqual(R(lay, { resolution: 'relink', to: 'PAVING', new_qty: null }), null, 'qty not known yet: answered by the 409 table');
    assert.strictEqual(R(lay, { resolution: 'relink', to: 'PAVING', new_qty: 100, confirm: ['duplicate', 'overlap'] }), null);
    assert.strictEqual(R(lay, { resolution: 'relink', to: 'KERB', new_qty: 1 }), 'relink to must be one of its relink_choices');
    assert.strictEqual(R(lay, { resolution: 'relink', new_qty: 1 }), 'relink to must be one of its relink_choices');
    assert.strictEqual(R(lay, { resolution: 'relink', to: { layer: 'PAVING', block: null }, new_qty: 1 }), 'relink to must be one of its relink_choices');
    assert.strictEqual(R(lay, { resolution: 'keep_matched', new_qty: 1 }), 'cannot be resolved by keep_matched (options: delete, relink)');
    assert.strictEqual(R(lay, { resolution: 'confirm', new_qty: 1 }), 'cannot be resolved by confirm (options: delete, relink)');
    assert.strictEqual(R(blkI, { resolution: 'relink', to: { layer: 'PITS', block: 'MH9' }, new_qty: 4 }), null);
    for (const to of ['MH9', { layer: 'PITS' }, { layer: 'PITS', block: 'MH9', nested: 1 }, { layer: 'PITS', block: 'PIT' }, ['PITS', 'MH9'], null])
      assert.strictEqual(R(blkI, { resolution: 'relink', to, new_qty: 4 }), 'relink to must be one of its relink_choices', JSON.stringify(to));
    assert.strictEqual(R(selI, { resolution: 'keep_matched', new_qty: 4 }), null);
    assert.strictEqual(R(selI, { resolution: 'keep_matched', new_qty: 4, confirm: ['overlap'] }), null);
    assert.strictEqual(R(selI, { resolution: 'keep_matched', to: 'X', new_qty: 4 }), 'to goes with relink only');
    assert.strictEqual(R(selI, { resolution: 'relink', to: 'X', new_qty: 4 }), 'cannot be resolved by relink (options: delete, keep_matched)');
    assert.strictEqual(R(C.item(sel, { reason: 'handles_missing', keep_matched_qty: null }), { resolution: 'keep_matched', new_qty: 4 }), 'cannot be resolved by keep_matched (options: delete)');
    assert.strictEqual(R(conf, { resolution: 'confirm', new_qty: 8 }), null);
    assert.strictEqual(R(conf, { resolution: 'confirm', new_qty: 8, confirm: ['duplicate'] }), 'confirm goes with relink or keep_matched (resolution confirm confirms the gates of the item)');
    assert.strictEqual(R(conf, { resolution: 'delete', new_qty: null, confirm: ['duplicate'] }), 'confirm goes with relink or keep_matched (resolution confirm confirms the gates of the item)');
    assert.strictEqual(R(gone, { resolution: 'delete', new_qty: null }), null);
    assert.strictEqual(R(same, { new_qty: 5 }), null);
    assert.strictEqual(R(same, { resolution: 'delete', new_qty: null }), 'is not blocked: send it without a resolution');
    assert.strictEqual(R(same, { new_qty: 5, to: 'KERB' }), 'to and confirm go with a resolution');
    assert.strictEqual(R(same, { new_qty: 5, confirm: [] }), 'to and confirm go with a resolution');
  }
  // R9: a shape off the new page, or a qty that cannot be recomputed → blocked, delete only
  for (const reason of ['off_page', 'cannot_recompute']) {
    assert.deepStrictEqual(C.item(man, { reason }), { measurement_id: 7, row_id: 1, tool: 'manual', label: 'Fake line', old_qty: 2, new_qty: null, qty_unit: 'm', status: 'blocked', reason, options: ['delete'] });
    assert.deepStrictEqual(C.item(sel, { reason }).options, ['delete']);
  }
  // row totals per row and unit (R10: m never added to m2): Σ old and Σ new of the drawing's items (first seen first);
  // new is null while an item of the row and unit is blocked; unlinked measurements have no row
  const items = [C.item(m(1), { new_qty: 6 }), C.item(m(8, { row_id: 2, qty: 3 }), { new_qty: 3 }), C.item(m(9, { qty: 1.5 }), { review: true, new_qty: 1.25 }),
    C.item(m(10, { row_id: 3 }), { reason: 'layer_missing', relink_choices: [] }), C.item(m(11, { row_id: 3, qty: 1 }), { new_qty: 2 }), C.item(m(12, { row_id: null }), { new_qty: 9 }),
    C.item(m(14, { qty: 4, qty_unit: 'm2' }), { new_qty: 5 })];
  assert.deepStrictEqual(C.rowTotals(items), [{ row_id: 1, qty_unit: 'm', old: 6.5, new: 7.25 }, { row_id: 2, qty_unit: 'm', old: 3, new: 3 }, { row_id: 3, qty_unit: 'm', old: 6, new: null },
    { row_id: 1, qty_unit: 'm2', old: 4, new: 5 }]);
  assert.deepStrictEqual(C.rowTotals([]), []);
}

console.log('takeoff ok');
