// Bytes -> text for ASCII DXF files (UTF-8 for AC1021+, code page for older files).
function decodeDxf(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length >= 18 && buf.subarray(0, 18).toString('latin1') === 'AutoCAD Binary DXF')
    throw new Error('binary DXF is not supported — save as ASCII DXF');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { /* not UTF-8 */ }
  const latin = buf.toString('latin1');
  const m = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\r\n]*)/.exec(latin);
  const cp = m ? m[1].trim().toUpperCase() : '';
  if (cp === 'ANSI_1256') return new TextDecoder('windows-1256').decode(buf);
  if (cp === 'ANSI_1252') return new TextDecoder('windows-1252').decode(buf);
  return latin;
}
module.exports = { decodeDxf };
