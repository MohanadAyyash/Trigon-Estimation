// Take-off (batch 3) pure tests: image size reader, synthetic fixtures, vendored pdf.js: node --no-warnings test-takeoff.js
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { imageSize } = require('./lib/takeoff/imagesize.js');
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

console.log('takeoff ok');
