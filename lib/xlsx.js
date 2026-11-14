// Dependency-free xlsx reader/writer (ZIP via node:zlib, SpreadsheetML via small regex scans).
const zlib = require('zlib');

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NOT_XLSX = 'not an xlsx file';

// ---------- ZIP ----------
// entries: [{ name, data: string|Buffer, method?: 0|8 }] (default 8). Fixed DOS timestamp keeps output deterministic.
function buildZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method === 0 ? 0 : 8;
    const data = method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // 1980-01-01 00:00
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Returns Map name -> () => Buffer (lazy, verifies CRC). Throws Error('not an xlsx file') if not a ZIP.
function openZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error(NOT_XLSX);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(NOT_XLSX);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported');
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(NOT_XLSX);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    files.set(name, () => {
      if (flags & 1) throw new Error(`encrypted zip entry: ${name}`);
      if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error(NOT_XLSX);
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const comp = buf.subarray(start, start + csize);
      if (comp.length !== csize) throw new Error(`truncated zip entry: ${name}`);
      let raw;
      if (method === 0) raw = comp;
      else if (method === 8) raw = zlib.inflateRawSync(comp);
      else throw new Error(`unsupported zip compression method ${method} in ${name}`);
      if (raw.length !== usize || zlib.crc32(raw) !== crc) throw new Error(`zip crc mismatch in ${name}`);
      return raw;
    });
  }
  return files;
}

// ---------- XML helpers ----------
const decodeXml = s => s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (m, hex, dec, named) => {
  if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named];
  const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
});
const escXml = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1]] = decodeXml(m[2] !== undefined ? m[2] : m[3]);
  return o;
}
// Concatenated text of every <t> in a fragment (rich text runs included, phonetic <rPh> excluded).
function textOf(xml) {
  let out = '';
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += decodeXml(m[1] || '');
  return out;
}
const colIndex = letters => { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colLetters = i => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };

// ---------- reader ----------
function readXlsx(buf) {
  const files = openZip(buf);
  const get = n => files.has(n) ? files.get(n)().toString('utf8').replace(/^﻿/, '') : null;
  const wb = get('xl/workbook.xml');
  if (wb === null) throw new Error(NOT_XLSX);

  const rels = {};
  for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.Id && a.Target) rels[a.Id] = a.Target.startsWith('/') ? a.Target.slice(1) : 'xl/' + a.Target.replace(/^\.\//, '');
  }
  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(textOf(m[1] || ''));

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const rid = a['r:id'] || a.id;
    const target = rels[rid];
    if (a.name === undefined || !target) throw new Error(`workbook sheet "${a.name}" has no relationship target`);
    const xml = get(target);
    if (xml === null) throw new Error(`worksheet part missing: ${target}`);
    sheets.push({ name: a.name, rows: readSheet(xml, shared, a.name) });
  }
  if (!sheets.length) throw new Error('no sheets found in workbook');
  return { sheets };
}

function readSheet(xml, shared, sheetName) {
  const rows = [];
  let nextRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]);
    const ri = ra.r ? parseInt(ra.r, 10) - 1 : nextRow;
    if (!(ri >= 0)) throw new Error(`bad row index in sheet "${sheetName}"`);
    nextRow = ri + 1;
    const row = rows[ri] || (rows[ri] = []);
    let nextCol = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      let ci = nextCol;
      if (ca.r) { const r = /^([A-Za-z]+)\d+$/.exec(ca.r); if (!r) throw new Error(`bad cell ref ${ca.r} in sheet "${sheetName}"`); ci = colIndex(r[1].toUpperCase()); }
      nextCol = ci + 1;
      const body = cm[2] || '';
      const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(body);
      const vt = v ? decodeXml(v[1] || '') : null;
      if (/<f\b/.test(body) && (vt === null || vt === '') && ca.t !== 'inlineStr') {
        throw new Error(`formula without cached value at ${sheetName}!${ca.r || colLetters(ci) + (ri + 1)} \u2014 open and save the file in Excel first`);
      }
      let val = null;
      switch (ca.t) {
        case 's': {
          if (vt === null) break;
          const idx = Number(vt);
          if (!Number.isInteger(idx) || idx < 0 || idx >= shared.length) throw new Error(`bad shared string index ${vt} at ${ca.r} in sheet "${sheetName}"`);
          val = shared[idx]; break;
        }
        case 'inlineStr': val = textOf(body); break;
        case 'str': case 'e': val = vt; break;
        case 'b': val = vt === null ? null : (vt.trim() === '1' || vt.trim().toLowerCase() === 'true' ? 1 : 0); break;
        default: { // 'n' or absent
          if (vt === null || vt.trim() === '') break;
          val = Number(vt);
          if (!Number.isFinite(val)) throw new Error(`bad number "${vt}" at ${ca.r} in sheet "${sheetName}"`);
        }
      }
      row[ci] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null; // fill gaps
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// ---------- writer ----------
function sheetXml(sheet) {
  const cols = Array.isArray(sheet.colWidths) && sheet.colWidths.length
    ? `<cols>${sheet.colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(w) > 0 ? Number(w) : 10}" customWidth="1"/>`).join('')}</cols>` : '';
  let data = '';
  (sheet.rows || []).forEach((row, ri) => {
    if (!row || !row.length) return; // empty rows are implied by the row index of the next one
    let cells = '';
    row.forEach((v, ci) => {
      const ref = colLetters(ci) + (ri + 1);
      if (v === null || v === undefined) cells += `<c r="${ref}"/>`;
      else if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new TypeError(`cannot write non-finite number at ${ref} in sheet "${sheet.name}"`);
        cells += `<c r="${ref}" t="n"><v>${v}</v></c>`;
      } else if (typeof v === 'string') cells += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
      else throw new TypeError(`unsupported cell value (${typeof v}) at ${ref} in sheet "${sheet.name}": use string, number or null`);
    });
    data += `<row r="${ri + 1}">${cells}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS_MAIN}"><sheetViews><sheetView workbookViewId="0"/></sheetViews>${cols}<sheetData>${data}</sheetData></worksheet>`;
}

function writeXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new TypeError('writeXlsx needs at least one sheet');
  const seen = new Set();
  for (const s of sheets) {
    const n = s && s.name;
    if (typeof n !== 'string' || !n.length) throw new Error('invalid sheet name: must be a non-empty string');
    if (n.length > 31) throw new Error(`invalid sheet name "${n}": longer than 31 characters`);
    if (/[:\\/?*[\]]/.test(n)) throw new Error(`invalid sheet name "${n}": contains one of : \\ / ? * [ ]`);
    if (n.startsWith("'") || n.endsWith("'")) throw new Error(`invalid sheet name "${n}": starts or ends with an apostrophe`);
    if (seen.has(n.toLowerCase())) throw new Error(`duplicate sheet name "${n}" (names are case-insensitive)`);
    seen.add(n.toLowerCase());
  }
  const H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const parts = [
    { name: '[Content_Types].xml', data: `${H}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `${H}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${H}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${sheets.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${H}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return buildZip(parts);
}

module.exports = { readXlsx, writeXlsx, buildZip };
