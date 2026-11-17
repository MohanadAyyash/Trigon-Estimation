// Synthetic take-off fixtures, built in memory (R6: no real drawings). Used by test-takeoff.js, test-drawings.js and the UI tests.
// makePdf(): a tiny uncompressed 2-page PDF with a correct xref. Page 1 is 595×842 (rotation 0), page 2 is 842×595 with
// /Rotate 90. Each page has one filled rectangle (PDF_RECTS, in PDF user space: y up, points).
// makeOffsetPdf(): one page whose box does not start at 0 (OFFSET_PAGE: MediaBox [1000 2000 1595 2842], /Rotate 270) with one
// filled rectangle (OFFSET_RECT, absolute user space): page points stay absolute (R16).
// makePng(w, h, rgb): a real RGB PNG of one colour. pngHeader(w, h): signature + IHDR only (for size checks).
// jpegHeader(w, h, sof): SOI, APP0 (JFIF), DQT, SOFn and EOI: enough for the size reader, not a decodable image.
const zlib = require('zlib');

const PDF_PAGES = [{ page: 1, width: 595, height: 842, rotation: 0 }, { page: 2, width: 842, height: 595, rotation: 90 }];
const PDF_RECTS = [{ page: 1, x: 100, y: 100, w: 200, h: 150, rgb: [0.2, 0.4, 0.8] }, { page: 2, x: 300, y: 200, w: 250, h: 120, rgb: [0.8, 0.2, 0.2] }];

// pages: [{ box: [x0, y0, x1, y1], rotate, rect }] -> an uncompressed PDF with a correct xref (page i: objects 3+2i, 4+2i)
function buildPdf(pages) {
  const content = r => `${r.rgb.join(' ')} rg ${r.x} ${r.y} ${r.w} ${r.h} re f\n`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((p, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((p, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${p.box.join(' ')}]${p.rotate ? ' /Rotate ' + p.rotate : ''} /Resources << >> /Contents ${4 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${content(p.rect).length} >>\nstream\n${content(p.rect)}endstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');   // ASCII only: string offsets are byte offsets
}
const makePdf = () => buildPdf([{ box: [0, 0, 595, 842], rotate: 0, rect: PDF_RECTS[0] }, { box: [0, 0, 842, 595], rotate: 90, rect: PDF_RECTS[1] }]);
const OFFSET_PAGE = { page: 1, width: 595, height: 842, rotation: 270, x0: 1000, y0: 2000 };
const OFFSET_RECT = { page: 1, x: 1100, y: 2100, w: 200, h: 150, rgb: [0.2, 0.6, 0.2] };
const makeOffsetPdf = () => buildPdf([{ box: [1000, 2000, 1595, 2842], rotate: 270, rect: OFFSET_RECT }]);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunk = (type, data) => {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = (w, h) => { const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = 2; return chunk('IHDR', b); };   // 8-bit RGB
const pngHeader = (w, h) => Buffer.concat([PNG_SIG, ihdr(w, h)]);
function makePng(w, h, rgb = [40, 120, 200]) {
  const row = Buffer.alloc(1 + 3 * w);   // filter 0, then RGB
  for (let x = 0; x < w; x++) row.set(rgb, 1 + 3 * x);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([PNG_SIG, ihdr(w, h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function jpegHeader(w, h, sof = 0xc2) {
  const seg = (marker, data) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(data.length + 2, 2); return Buffer.concat([b, data]); };
  const app0 = seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));   // "JFIF\0" v1.1, no thumbnail
  const dqt = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
  const f = Buffer.alloc(15); f[0] = 8; f.writeUInt16BE(h, 1); f.writeUInt16BE(w, 3); f[5] = 3;
  for (let i = 0; i < 3; i++) { f[6 + 3 * i] = i + 1; f[7 + 3 * i] = 0x11; f[8 + 3 * i] = 0; }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, seg(sof, f), Buffer.from([0xff, 0xd9])]);
}

module.exports = { makePdf, PDF_PAGES, PDF_RECTS, makeOffsetPdf, OFFSET_PAGE, OFFSET_RECT, makePng, pngHeader, jpegHeader };
