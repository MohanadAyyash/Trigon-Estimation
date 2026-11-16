// The pixel size of a PNG or JPEG, from its header only (nothing is decoded). Plan batch 3 Task 2.
// PNG: the IHDR chunk right after the signature (width at offset 16, height at 20).
// JPEG: walk the marker segments from SOI to the first frame header SOF0-3, SOF5-7, SOF9-11, SOF13-15.
// Truncated, damaged or other input throws 'not a PNG or JPEG image'; a side above 20000 px throws 'image too large'.
const MAX_SIDE = 20000;
const NOT_IMAGE = 'not a PNG or JPEG image';
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// SOFn: C0-CF except C4 (DHT), C8 (JPG, reserved) and CC (DAC)
const isSof = m => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function imageSize(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(0);
  const u16 = i => (b[i] << 8) | b[i + 1], u32 = i => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const no = () => { throw new Error(NOT_IMAGE); };
  const sized = (type, width, height) => {
    if (!(width > 0) || !(height > 0)) no();
    if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(`image too large (max ${MAX_SIDE} px per side)`);
    return { type, width, height };
  };
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) {
    // length 13, then 'IHDR'
    if (b.length < 24 || u32(8) !== 13 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') no();
    return sized('png', u32(16), u32(20));
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    for (;;) {
      if (i >= b.length || b[i] !== 0xff) no();
      while (i < b.length && b[i] === 0xff) i++;   // fill bytes
      if (i >= b.length) no();
      const m = b[i++];
      if (m === 0xd8 || m === 0xd9 || m === 0xda || m === 0x00) no();   // SOI again, EOI or scan before a frame header
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;           // TEM, RSTn: no length
      if (i + 2 > b.length) no();
      const len = u16(i);
      if (len < 2 || i + len > b.length) no();
      if (isSof(m)) { if (len < 7) no(); return sized('jpeg', u16(i + 5), u16(i + 3)); }   // P, Y (height), X (width)
      i += len;
    }
  }
  return no();
}

module.exports = { imageSize, MAX_SIDE };
