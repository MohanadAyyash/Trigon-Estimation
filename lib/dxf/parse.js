// ASCII DXF text -> layers, blocks and raw model-space entities (no geometry here).
const SUPPORTED = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE', 'INSERT', 'HATCH', 'TEXT', 'MTEXT']);

function first(codes, code) { for (const p of codes) if (p[0] === code) return p[1]; return undefined; }
// Absent -> dflt. Present but empty/garbage -> throws (a corrupt file must never become a silent 0).
function numOf(codes, code, dflt, what) {
  const v = first(codes, code);
  if (v === undefined) return dflt;
  const s = v.trim(), n = s === '' ? NaN : Number(s);
  if (!Number.isFinite(n)) throw new Error('corrupt DXF: bad value for group code ' + code + ' in ' + (what || 'entity'));
  return n;
}

function parseDxf(text) {
  const lines = text.split('\n');
  const header = { insunits: null, codepage: null, acadver: null };
  const layers = [], blocks = Object.create(null), entities = [], ignored = Object.create(null), warnings = [];
  let sawSection = false, sawEof = false;
  let section = null, curBlock = null, paper = 0, counter = 0, poly = null;
  let tableType = null;

  const finishPoly = () => { poly = null; };
  const raw = (type, codes) => {
    const idx = counter++;
    let h = first(codes, 5);
    h = h === undefined ? 'nohandle:' + idx : h.trim();
    const l = first(codes, 8);
    return { type, handle: h, layer: l === undefined ? '0' : l, codes };
  };

  const onRecord = (type, codes) => {
    if (section === 'HEADER') return;
    if (section === 'TABLES') {
      if (type === 'TABLE') tableType = (first(codes, 2) || '').trim();
      else if (type === 'ENDTAB') tableType = null;
      else if (type === 'LAYER' && tableType === 'LAYER') {
        const what = 'LAYER ' + (first(codes, 2) || ''), color = numOf(codes, 62, 7, what), flag = numOf(codes, 70, 0, what);
        layers.push({ name: first(codes, 2) || '', color, off: color < 0, frozen: (flag & 1) === 1 });
      }
      return;
    }
    if (section !== 'BLOCKS' && section !== 'ENTITIES') return;
    const target = section === 'BLOCKS' ? (curBlock && curBlock.entities) : entities;
    if (section === 'BLOCKS') {
      if (type === 'BLOCK') {
        finishPoly();
        const name = first(codes, 2) || '';
        const what = 'BLOCK ' + name;
        const flag = numOf(codes, 70, 0, what);
        curBlock = blocks[name] = { base: [numOf(codes, 10, 0, what), numOf(codes, 20, 0, what)], flag, entities: [] };
        if (flag & 4) warnings.push({ code: 'xref', detail: name });
        return;
      }
      if (type === 'ENDBLK') { finishPoly(); curBlock = null; return; }
      if (!target) return;
    }
    // R12 POLYLINE folding
    if (poly) {
      if (type === 'VERTEX') {
        if (!poly.skip) {
          const what = 'VERTEX of POLYLINE ' + poly.handle;
          const flag = numOf(codes, 70, 0, what);
          if (flag & (128 | 16)) return; // polyface face record / spline frame point
          const x = numOf(codes, 10, NaN, what), y = numOf(codes, 20, NaN, what);
          if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('corrupt DXF: missing coordinate in ' + what);
          poly.vertices.push([x, y, numOf(codes, 42, 0, what), flag]);
        }
        return;
      }
      if (type === 'SEQEND') { finishPoly(); return; }
      finishPoly();
    }
    if (section === 'ENTITIES' && numOf(codes, 67, 0, type) === 1) {
      paper++;
      if (type === 'POLYLINE') poly = { skip: true };
      return;
    }
    if (!SUPPORTED.has(type)) { if (section === 'ENTITIES') ignored[type] = (ignored[type] || 0) + 1; return; }
    const e = raw(type, codes);
    if (type === 'POLYLINE') {
      e.vertices = []; e.closed = (numOf(codes, 70, 0, 'POLYLINE ' + e.handle) & 1) === 1;
      poly = e;
    }
    if (type === 'LWPOLYLINE') {
      for (const [c, val] of codes) {
        if ((c === 10 || c === 20 || c === 42) && !Number.isFinite(val.trim() === '' ? NaN : Number(val.trim())))
          throw new Error('corrupt DXF: bad value for group code ' + c + ' in LWPOLYLINE ' + e.handle);
      }
    }
    target.push(e);
  };

  // tokenise into group-code pairs and split into records at code 0
  let rec = null;
  const flush = () => {
    if (!rec) return;
    const { type, codes } = rec; rec = null;
    if (type === 'SECTION') {
      sawSection = true;
      finishPoly();
      section = (first(codes, 2) || '').trim();
      if (section === 'HEADER') readHeader(codes);
      curBlock = null; tableType = null;
    } else if (type === 'ENDSEC') { finishPoly(); section = null; curBlock = null; }
    else onRecord(type, codes);
  };
  const readHeader = codes => {
    for (let i = 0; i < codes.length; i++) {
      if (codes[i][0] !== 9) continue;
      const name = codes[i][1].trim(), val = codes[i + 1];
      if (!val) continue;
      if (name === '$INSUNITS') { const n = Number(val[1].trim()); header.insunits = Number.isFinite(n) ? n : null; }
      else if (name === '$DWGCODEPAGE') header.codepage = val[1].trim();
      else if (name === '$ACADVER') header.acadver = val[1].trim();
    }
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const cl = lines[i].trim();
    if (!/^-?\d+$/.test(cl)) {
      if (!sawSection && !rec) throw new Error('not a DXF file');
      throw new Error('corrupt DXF: bad group code ' + JSON.stringify(cl.slice(0, 40)) + ' at line ' + (i + 1));
    }
    const code = parseInt(cl, 10);
    let value = lines[i + 1];
    if (value.charCodeAt(value.length - 1) === 13) value = value.slice(0, -1);
    if (code === 0) {
      flush();
      const t = value.trim();
      if (t === 'EOF') { sawEof = true; break; }
      rec = { type: t, codes: [] };
    } else if (rec) rec.codes.push([code, value]);
  }
  flush();
  if (!sawSection) throw new Error('not a DXF file');
  if (!sawEof) throw new Error('DXF file is truncated (no EOF)');

  if (!layers.some(l => l.name === '0')) layers.push({ name: '0', color: 7, off: false, frozen: false });
  if (paper) warnings.push({ code: 'paper_space', detail: paper + ' paper-space entities skipped' });
  return { header, layers, blocks, entities, ignored, warnings };
}
module.exports = { parseDxf };
