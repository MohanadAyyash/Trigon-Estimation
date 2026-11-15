// worker_threads entry: parse one stored DXF file off the main thread.
// In: workerData { file }. Out: one message { ok: true, cache, summary, render, suggested_units } or { ok: false, error }.
// cache = gzipped JSON { version, header, layers, ignored, warnings, flat }; summary = gzipped JSON { version, header, ignored, warnings,
// layers, raw, render } with raw = layerTable(flat, layers, 'm'), i.e. factor 1 = drawing units; render = the gzipped display file
// (render.js), or null when it could not be built: the summary then says render: { ok: false, error } and the quantities are
// unaffected. All are transferred ArrayBuffers.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs'), zlib = require('zlib');
const { decodeDxf } = require('./decode.js');
const { parseDxf } = require('./parse.js');
const { flatten } = require('./geometry.js');
const { layerTable, PARSER_VERSION } = require('./summary.js');
const { buildRender } = require('./render.js');
const { insunitsToUnit } = require('../units.js');
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const gz = v => ab(zlib.gzipSync(JSON.stringify(v)));

const FLAT_KEYS = ['handle', 'layer', 'type', 'kind', 'length', 'area', 'block', 'depth', 'count', 'approx', 'bbox', 'geomKey'];

try {
  const doc = parseDxf(decodeDxf(fs.readFileSync(workerData.file)));
  const full = flatten(doc, { withSegs: true });   // flatten adds its warnings to doc.warnings
  // a display file that cannot be built (too large, out of memory) never blocks the quantities
  let render = null, renderInfo = { ok: true };
  try { render = ab(zlib.gzipSync(buildRender(doc, full, { maxPoints: Number(process.env.DRAWINGS_RENDER_MAX_POINTS) || undefined }))); }
  catch (e) { renderInfo = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
  const flat = full.map(e => { const o = {}; for (const k of FLAT_KEYS) o[k] = e[k]; return o; });
  const summary = gz({ version: PARSER_VERSION, header: doc.header, ignored: doc.ignored, warnings: doc.warnings, layers: doc.layers, raw: layerTable(flat, doc.layers, 'm'), render: renderInfo });
  const cache = gz({ version: PARSER_VERSION, header: doc.header, layers: doc.layers, ignored: doc.ignored, warnings: doc.warnings, flat });
  parentPort.postMessage({ ok: true, cache, summary, render, suggested_units: insunitsToUnit(doc.header.insunits) }, render ? [cache, summary, render] : [cache, summary]);
} catch (e) {
  // file-system errors carry the server path: say what happened in plain words instead
  const error = e && e.code === 'ENOENT' ? 'the stored drawing file is missing'
    : e && e.syscall ? 'could not read the stored drawing file (' + e.code + ')' : String((e && e.message) || e);
  parentPort.postMessage({ ok: false, error });
}
