// worker_threads entry: parse one stored DXF file off the main thread.
// In: workerData { file }. Out: one message { ok: true, cache, summary, render, suggested_units } or { ok: false, transient, error }:
// transient = the stored file could not be read (it may work later; the drawing keeps its status), false = the file itself
// cannot be parsed.
// cache = gzipped JSON { version, header, layers, ignored, warnings, flat }; summary = gzipped JSON { version, header, ignored, warnings,
// layers, raw, render } with raw = layerTable(flat, layers, 'm'), i.e. factor 1 = drawing units; render = the gzipped display file
// (render.js), or null when it could not be built: the summary then says render: { ok: false, error } and the quantities are
// unaffected. All are transferred ArrayBuffers.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs'), zlib = require('zlib'), v8 = require('v8');
const { decodeDxf } = require('./decode.js');
const { parseDxf } = require('./parse.js');
const { flatten } = require('./geometry.js');
const { layerTable, PARSER_VERSION } = require('./summary.js');
const { buildRender } = require('./render.js');
const { insunitsToUnit } = require('../units.js');
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const gz = v => ab(zlib.gzipSync(JSON.stringify(v)));

// Our own heap cap. Some Node versions (seen on 22.23.4) ignore the Worker resourceLimits, so the worker also checks its
// heap between stages and stops with { ok: false, oom: true } once it is over workerData.heapMb.
const HEAP_LIMIT = Number(workerData.heapMb) > 0 ? Number(workerData.heapMb) * 1048576 : Infinity;
const heapCheck = () => { if (v8.getHeapStatistics().used_heap_size > HEAP_LIMIT) { const e = new Error('out of memory'); e.oom = true; throw e; } };

const FLAT_KEYS = ['handle', 'layer', 'type', 'kind', 'length', 'area', 'block', 'depth', 'count', 'approx', 'bbox', 'geomKey'];

try {
  const text = decodeDxf(fs.readFileSync(workerData.file)); heapCheck();
  const doc = parseDxf(text); heapCheck();
  const full = flatten(doc, { withSegs: true }); heapCheck();   // flatten adds its warnings to doc.warnings
  // a display file that cannot be built (too large, out of memory) never blocks the quantities
  let render = null, renderInfo = { ok: true };
  try { render = ab(zlib.gzipSync(buildRender(doc, full, { maxPoints: Number(process.env.DRAWINGS_RENDER_MAX_POINTS) || undefined }))); }
  catch (e) { if (e && e.oom) throw e; renderInfo = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
  heapCheck();
  const flat = full.map(e => { const o = {}; for (const k of FLAT_KEYS) o[k] = e[k]; return o; });
  const summary = gz({ version: PARSER_VERSION, header: doc.header, ignored: doc.ignored, warnings: doc.warnings, layers: doc.layers, raw: layerTable(flat, doc.layers, 'm'), render: renderInfo });
  const cache = gz({ version: PARSER_VERSION, header: doc.header, layers: doc.layers, ignored: doc.ignored, warnings: doc.warnings, flat });
  heapCheck();
  parentPort.postMessage({ ok: true, cache, summary, render, suggested_units: insunitsToUnit(doc.header.insunits) }, render ? [cache, summary, render] : [cache, summary]);
} catch (e) {
  if (e && e.oom) { parentPort.postMessage({ ok: false, oom: true }); return; }
  // file-system errors carry the server path: say what happened in plain words instead
  const io = !!(e && (e.code === 'ENOENT' || e.syscall));
  const error = e && e.code === 'ENOENT' ? 'the stored drawing file is missing'
    : io ? 'could not read the stored drawing file (' + e.code + ')' : String((e && e.message) || e);
  parentPort.postMessage({ ok: false, transient: io, error });
}
