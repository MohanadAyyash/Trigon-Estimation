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
}

console.log('takeoff ok');
