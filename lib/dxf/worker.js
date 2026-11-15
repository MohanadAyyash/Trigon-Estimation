// worker_threads entry: parse one stored DXF file off the main thread.
// In: workerData { file }. Out: one message { ok: true, cache, suggested_units } where cache is the gzipped JSON
// { header, layers, ignored, warnings, flat } (an ArrayBuffer, transferred), or { ok: false, error }.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs'), zlib = require('zlib');
const { decodeDxf } = require('./decode.js');
const { parseDxf } = require('./parse.js');
const { flatten } = require('./geometry.js');
const { insunitsToUnit } = require('../units.js');

const FLAT_KEYS = ['handle', 'layer', 'type', 'kind', 'length', 'area', 'block', 'depth', 'count', 'approx', 'bbox', 'geomKey'];

try {
  const doc = parseDxf(decodeDxf(fs.readFileSync(workerData.file)));
  const flat = flatten(doc).map(e => { const o = {}; for (const k of FLAT_KEYS) o[k] = e[k]; return o; }); // flatten adds its warnings to doc.warnings
  const gz = zlib.gzipSync(JSON.stringify({ header: doc.header, layers: doc.layers, ignored: doc.ignored, warnings: doc.warnings, flat }));
  const cache = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  parentPort.postMessage({ ok: true, cache, suggested_units: insunitsToUnit(doc.header.insunits) }, [cache]);
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
