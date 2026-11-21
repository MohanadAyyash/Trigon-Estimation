// Child-process entry (see worker.js and child.js): total a selection outside the server process (the full parse cache is
// never read there). In: the first IPC message { file, handles, metric, nested, heapMb } with file = <sha>.json.gz. Out: one message { ok: true, ...selectionTotals }
// or { ok: false, stale, error }. stale = the cache is missing, unreadable or of another parser version: a re-parse
// rebuilds it.
const fs = require('fs'), zlib = require('zlib'), v8 = require('v8');
const { serve } = require('./child.js');
const { selectionTotals } = require('./select.js');
const { PARSER_VERSION } = require('./summary.js');

function run(workerData) {
  // second line of defence after --max-old-space-size: see worker.js
  const HEAP_LIMIT = Number(workerData.heapMb) > 0 ? Number(workerData.heapMb) * 1048576 : Infinity;
  const overHeap = () => v8.getHeapStatistics().used_heap_size > HEAP_LIMIT;
  let cache;
  try { cache = JSON.parse(zlib.gunzipSync(fs.readFileSync(workerData.file)).toString('utf8')); }
  catch (e) {
    // never the server path in a message
    return { ok: false, stale: true, error: e && e.code === 'ENOENT' ? 'the parsed drawing is missing' : 'could not read the parsed drawing (' + ((e && e.code) || 'error') + ')' };
  }
  if (overHeap()) return { ok: false, oom: true };
  if (!cache || cache.version !== PARSER_VERSION || !Array.isArray(cache.flat)) return { ok: false, stale: true, error: 'the parsed drawing is out of date' };
  const totals = selectionTotals(cache.flat, workerData.handles, workerData.metric, { nested: workerData.nested });
  if (overHeap()) return { ok: false, oom: true };
  return { ok: true, ...totals };
}
serve((workerData, reply) => {
  let out;
  try { out = run(workerData); } catch (e) { out = { ok: false, stale: false, error: String((e && e.message) || e) }; }
  reply(out);
});
