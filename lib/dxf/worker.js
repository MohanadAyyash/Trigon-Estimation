// worker_threads entry: parse one stored DXF file off the main thread.
// In: workerData { file }. Out: one message { ok: true, cache, summary, suggested_units } or { ok: false, error }.
// cache = gzipped JSON { header, layers, ignored, warnings, flat }; summary = gzipped JSON { header, ignored, warnings,
// layers, raw } with raw = layerTable(flat, layers, 'm'), i.e. factor 1 = drawing units. Both are transferred ArrayBuffers.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs'), zlib = require('zlib');
const { decodeDxf } = require('./decode.js');
const { parseDxf } = require('./parse.js');
const { flatten } = require('./geometry.js');
const { layerTable } = require('./summary.js');
const { insunitsToUnit } = require('../units.js');
const gz = v => { const b = zlib.gzipSync(JSON.stringify(v)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const FLAT_KEYS = ['handle', 'layer', 'type', 'kind', 'length', 'area', 'block', 'depth', 'count', 'approx', 'bbox', 'geomKey'];

try {
  const doc = parseDxf(decodeDxf(fs.readFileSync(workerData.file)));
  const flat = flatten(doc).map(e => { const o = {}; for (const k of FLAT_KEYS) o[k] = e[k]; return o; }); // flatten adds its warnings to doc.warnings
  const summary = gz({ header: doc.header, ignored: doc.ignored, warnings: doc.warnings, layers: doc.layers, raw: layerTable(flat, doc.layers, 'm') });
  const cache = gz({ header: doc.header, layers: doc.layers, ignored: doc.ignored, warnings: doc.warnings, flat });
  parentPort.postMessage({ ok: true, cache, summary, suggested_units: insunitsToUnit(doc.header.insunits) }, [cache, summary]);
} catch (e) {
  // file-system errors carry the server path: say what happened in plain words instead
  const error = e && e.code === 'ENOENT' ? 'the stored drawing file is missing'
    : e && e.syscall ? 'could not read the stored drawing file (' + e.code + ')' : String((e && e.message) || e);
  parentPort.postMessage({ ok: false, error });
}
