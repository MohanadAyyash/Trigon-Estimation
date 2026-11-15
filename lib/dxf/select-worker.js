// worker_threads entry: total a selection off the main thread (the full parse cache is never read there).
// In: workerData { file, handles, metric } with file = <sha>.json.gz. Out: one message { ok: true, ...selectionTotals }
// or { ok: false, stale, error }. stale = the cache is missing, unreadable or of another parser version: a re-parse
// rebuilds it.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs'), zlib = require('zlib');
const { selectionTotals } = require('./select.js');
const { PARSER_VERSION } = require('./summary.js');

function run() {
  let cache;
  try { cache = JSON.parse(zlib.gunzipSync(fs.readFileSync(workerData.file)).toString('utf8')); }
  catch (e) {
    // never the server path in a message
    return { ok: false, stale: true, error: e && e.code === 'ENOENT' ? 'the parsed drawing is missing' : 'could not read the parsed drawing (' + ((e && e.code) || 'error') + ')' };
  }
  if (!cache || cache.version !== PARSER_VERSION || !Array.isArray(cache.flat)) return { ok: false, stale: true, error: 'the parsed drawing is out of date' };
  return { ok: true, ...selectionTotals(cache.flat, workerData.handles, workerData.metric) };
}
let out;
try { out = run(); } catch (e) { out = { ok: false, stale: false, error: String((e && e.message) || e) }; }
parentPort.postMessage(out);
