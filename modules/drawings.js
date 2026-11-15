// Drawings: raw DXF upload into a sha256 file store, parse in a worker thread into a gzipped JSON cache,
// units confirmation and the per-layer table. Spec 5.1-5.2; plan Task 4.
// Files live in DATA_DIR/drawings as <sha256>.dxf and <sha256>.json.gz, never in the database.
const fs = require('fs'), fsp = require('fs/promises'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { Worker } = require('worker_threads');
const { layerTable } = require('../lib/dxf/summary');
const { UNIT_TO_M } = require('../lib/units');

const MAX_BYTES = 100 * 1024 * 1024;           // the only route above the 20 MB JSON limit
const BINARY = Buffer.from('AutoCAD Binary DXF', 'latin1');
const BINARY_MSG = 'binary DXF is not supported — save as ASCII DXF';
const PARSE_TIMEOUT_MS = 10 * 60e3;
const WORKER = path.join(__dirname, '..', 'lib', 'dxf', 'worker.js');

module.exports = ctx => {
  const { db, send, bad, need, audit, DATA_DIR } = ctx;
  db.exec(`
CREATE TABLE IF NOT EXISTS drawings(id INTEGER PRIMARY KEY AUTOINCREMENT, tender_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'dxf', name TEXT, sha256 TEXT, bytes INTEGER,
  units TEXT, suggested_units TEXT, status TEXT /* parsing|ready|failed */, error TEXT, rev INTEGER DEFAULT 1, replaced_by INTEGER, created TEXT, created_by TEXT);
CREATE INDEX IF NOT EXISTS drawings_tender ON drawings(tender_id);
CREATE INDEX IF NOT EXISTS drawings_sha ON drawings(sha256);
CREATE TABLE IF NOT EXISTS measurements(id INTEGER PRIMARY KEY AUTOINCREMENT, drawing_id INTEGER NOT NULL, tender_id INTEGER NOT NULL, row_id INTEGER /* NULL = unlinked */,
  tool TEXT, layer TEXT, block TEXT, metric TEXT, nested INTEGER DEFAULT 0, width REAL, depth REAL, factor REAL NOT NULL DEFAULT 1, label TEXT, color TEXT,
  qty REAL, qty_unit TEXT, handles_count INTEGER, review_needed INTEGER DEFAULT 0, created TEXT, created_by TEXT);
CREATE INDEX IF NOT EXISTS measurements_drawing ON measurements(drawing_id);
CREATE INDEX IF NOT EXISTS measurements_row ON measurements(row_id);
`);
  const DIR = path.join(DATA_DIR, 'drawings');
  fs.mkdirSync(DIR, { recursive: true });
  // temp uploads left by a stopped server are never valid: remove them
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('tmp-')) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) { /* in use or gone */ } }
  const dxfFile = sha => path.join(DIR, sha + '.dxf'), cacheFile = sha => path.join(DIR, sha + '.json.gz');

  const reply = (...a) => { send(...a); return true; };
  const idOf = s => /^\d+$/.test(s || '') ? Number(s) : null;
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const tenderRow = id => id === null ? null : db.prepare('SELECT * FROM tenders WHERE id=?').get(id);
  const drawingRow = id => id === null ? null : db.prepare('SELECT * FROM drawings WHERE id=?').get(id);
  const mustDraft = t => { if (t.status !== 'draft') bad(`tender is ${t.status}: only a draft can be changed`, 409); };
  const hasUnit = u => typeof u === 'string' && Object.hasOwn(UNIT_TO_M, u);

  // ---- hooks for tenders.js (R1: cloneForTender / unlinkRows arrive in Task 5) --------------------------------
  const hasMeasurements = rowId => !!db.prepare('SELECT 1 FROM measurements WHERE row_id=? LIMIT 1').get(rowId);
  // Σ qty of the measurements linked to a row; unit is null when they do not share one unit (never add m to m2)
  const rowMeasuredQty = rowId => {
    const r = db.prepare('SELECT COUNT(*) n, SUM(qty) q, COUNT(DISTINCT qty_unit) nu, MIN(qty_unit) u FROM measurements WHERE row_id=?').get(rowId);
    if (!r.n) return null;
    return { qty: r.q, unit: r.nu === 1 ? r.u : null, count: r.n };
  };
  ctx.drawings = { hasMeasurements, rowMeasuredQty };

  // ---- upload: stream to a temp file while hashing; 413 the moment the limit is passed -----------------------
  const httpErr = (msg, status) => Object.assign(new Error(msg), { status });
  function receive(req) {
    const tmp = path.join(DIR, 'tmp-' + crypto.randomBytes(12).toString('hex'));
    const out = fs.createWriteStream(tmp, { flags: 'wx' }), hash = crypto.createHash('sha256');
    let bytes = 0, head = Buffer.alloc(0), done = false;
    return new Promise((ok, no) => {
      const fail = err => {
        if (done) return; done = true;
        req.removeListener('data', onData); req.pause();
        out.destroy();
        out.once('close', () => fsp.unlink(tmp).catch(() => {}).then(() => no(err)));
      };
      const onData = chunk => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return fail(httpErr('the drawing is larger than 100 MB', 413));
        if (head.length < BINARY.length) {
          head = Buffer.concat([head, chunk.subarray(0, BINARY.length - head.length)]);
          if (head.length === BINARY.length && head.equals(BINARY)) return fail(httpErr(BINARY_MSG, 400));
        }
        hash.update(chunk);
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => { if (!done) req.resume(); }); }
      };
      req.on('data', onData);
      req.on('end', () => {
        if (done) return;
        if (bytes === 0) return fail(httpErr('the file is empty', 400));
        out.end();
      });
      req.on('aborted', () => fail(httpErr('upload aborted', 400)));
      req.on('error', e => fail(httpErr('upload failed: ' + e.message, 400)));
      out.on('error', e => fail(e));
      out.on('finish', async () => {
        if (done) return; done = true;
        const sha = hash.digest('hex');
        try {
          // same content -> same name: keep one copy
          if (fs.existsSync(dxfFile(sha))) await fsp.unlink(tmp); else await fsp.rename(tmp, dxfFile(sha));
          ok({ sha, bytes });
        } catch (e) { await fsp.unlink(tmp).catch(() => {}); no(e); }
      });
    });
  }
  // a refused stream: answer, then drop the connection so the client stops sending
  const refuse = (req, res, e) => {
    if (res.headersSent) return req.destroy();
    res.on('finish', () => setImmediate(() => req.destroy()));
    send(res, e.status, { error: e.message }, { Connection: 'close' });
  };

  // ---- parse: one worker per sha256 at a time; drawings of the same file share the result ----------------------
  const inflight = new Map();   // sha256 -> Promise<{ ok, suggested_units?, error? }>
  function runWorker(sha) {
    return new Promise(resolve => {
      let settled = false;
      const w = new Worker(WORKER, { workerData: { file: dxfFile(sha) } });
      const end = r => { if (settled) return; settled = true; clearTimeout(timer); w.terminate().catch(() => {}); resolve(r); };
      const timer = setTimeout(() => end({ ok: false, error: 'parse timed out' }), PARSE_TIMEOUT_MS);
      w.on('message', m => end(m && typeof m === 'object' ? m : { ok: false, error: 'bad worker reply' }));
      w.on('error', e => end({ ok: false, error: 'parser crashed: ' + (e && e.message || e) }));
      w.on('exit', code => end({ ok: false, error: 'parser stopped (exit code ' + code + ')' }));
    });
  }
  function parseSha(sha) {
    if (inflight.has(sha)) return inflight.get(sha);
    const p = runWorker(sha).then(async r => {
      if (!r.ok) return { ok: false, error: String(r.error || 'parse failed') };
      const gz = cacheFile(sha), tmp = path.join(DIR, 'tmp-' + crypto.randomBytes(12).toString('hex') + '.json.gz');
      try { await fsp.writeFile(tmp, Buffer.from(r.cache)); await fsp.rename(tmp, gz); }
      catch (e) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, error: 'could not write the cache: ' + e.message }; }
      return { ok: true, suggested_units: r.suggested_units ?? null };
    }).catch(e => ({ ok: false, error: String(e && e.message || e) })).finally(() => inflight.delete(sha));
    inflight.set(sha, p);
    return p;
  }
  function startParse(id, sha) {
    parseSha(sha).then(r => {
      try {
        tx(() => {
          if (r.ok) db.prepare("UPDATE drawings SET status='ready', suggested_units=?, error=NULL WHERE id=? AND status='parsing'").run(r.suggested_units, id);
          else {
            const error = r.error.slice(0, 500);
            db.prepare("UPDATE drawings SET status='failed', error=? WHERE id=? AND status='parsing'").run(error, id);
            audit('system', 'parse_failed', 'drawings', id, { error });
          }
        });
      } catch (e) { console.error('drawings: could not record the parse result for drawing ' + id, e); }
    });
  }
  // drawings left 'parsing' by a stopped server are parsed again
  for (const d of db.prepare("SELECT id, sha256 FROM drawings WHERE status='parsing'").all()) startParse(d.id, d.sha256);

  const gunzip = require('util').promisify(zlib.gunzip);
  const readCache = async sha => JSON.parse((await gunzip(await fsp.readFile(cacheFile(sha)))).toString('utf8'));

  // ---- HTTP -----------------------------------------------------------------------------------------------
  async function upload(req, res, url, t, me) {
    need(me, 'admin', 'qs'); mustDraft(t);
    const name = String(url.searchParams.get('name') || '').trim();
    if (!name) bad('name is required');
    if (name.length > 200) bad('name must be at most 200 characters');
    let got;
    try { got = await receive(req); } catch (e) { if (!e.status) throw e; refuse(req, res, e); return true; }
    const cur = tenderRow(t.id);
    if (cur.status !== 'draft') bad(`tender is ${cur.status}: only a draft can be changed`, 409);   // changed while receiving
    // the same file already parsed (and not being parsed again) -> reuse its cache, ready at once
    const prev = !inflight.has(got.sha) && fs.existsSync(cacheFile(got.sha))
      ? db.prepare("SELECT suggested_units FROM drawings WHERE sha256=? AND status='ready' ORDER BY id DESC LIMIT 1").get(got.sha) : null;
    const id = tx(() => {
      const did = Number(db.prepare('INSERT INTO drawings(tender_id,kind,name,sha256,bytes,suggested_units,status,rev,created,created_by) VALUES(?,?,?,?,?,?,?,1,?,?)')
        .run(t.id, 'dxf', name, got.sha, got.bytes, prev ? prev.suggested_units : null, prev ? 'ready' : 'parsing', new Date().toISOString(), me.username).lastInsertRowid);
      audit(me, 'upload', 'drawings', did, { name, bytes: got.bytes, sha256: got.sha });
      return did;
    });
    if (!prev) startParse(id, got.sha);
    return reply(res, 202, { id });
  }

  async function drawingApi(req, res, parts, me) {
    const [, idStr, sub] = parts, method = req.method;
    const d = drawingRow(idOf(idStr));
    if (!d) bad('drawing not found', 404);
    const t = tenderRow(d.tender_id);
    if (!t) bad('drawing not found', 404);
    if (sub === undefined && parts.length === 2 && method === 'GET') {
      need(me, 'admin', 'qs', 'viewer');
      const c = d.status === 'ready' ? await readCache(d.sha256) : null;
      return reply(res, 200, { ...d, header: c && c.header, ignored: c && c.ignored, warnings: c && c.warnings });
    }
    if (sub === 'layers' && parts.length === 3 && method === 'GET') {
      need(me, 'admin', 'qs', 'viewer');
      if (d.status !== 'ready') bad(`drawing is ${d.status}: no layers yet`, 409);
      const c = await readCache(d.sha256), lt = layerTable(c.flat, c.layers, d.units);
      return reply(res, 200, { units: d.units, units_confirmed: d.units !== null, layers: lt.layers, warnings: [...c.warnings, ...lt.warnings] });
    }
    if (sub === 'units' && parts.length === 3 && method === 'PUT') {
      need(me, 'admin', 'qs'); mustDraft(t);
      const b = await ctx.readBody(req);
      for (const k of Object.keys(b)) if (k !== 'units') bad('unknown field: ' + k);
      if (!hasUnit(b.units)) bad('units must be one of ' + Object.keys(UNIT_TO_M).join(', '));
      tx(() => {
        mustDraft(tenderRow(t.id));
        if (db.prepare('SELECT 1 FROM measurements WHERE drawing_id=? LIMIT 1').get(d.id)) bad('units cannot change after measuring (batch 4 adds a before/after flow)', 409);
        const from = drawingRow(d.id).units;
        db.prepare('UPDATE drawings SET units=? WHERE id=?').run(b.units, d.id);
        audit(me, 'units', 'drawings', d.id, { from, to: b.units });
      });
      return reply(res, 200, drawingRow(d.id));
    }
    return false;
  }

  async function handle(req, res, url, parts, me) {
    const method = req.method;
    if (parts[0] === 'tenders' && parts[2] === 'drawings' && parts.length === 3) {
      const t = tenderRow(idOf(parts[1]));
      if (!t) bad('tender not found', 404);
      if (method === 'GET') { need(me, 'admin', 'qs', 'viewer'); return reply(res, 200, db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(t.id)); }
      if (method === 'POST') return upload(req, res, url, t, me);
      return false;
    }
    if (parts[0] === 'drawings' && parts.length >= 2) return drawingApi(req, res, parts, me);
    return false;
  }

  return { handle };
};
