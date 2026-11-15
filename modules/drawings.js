// Drawings: raw DXF upload into a sha256 file store, parse in a worker thread into a gzipped JSON cache,
// units confirmation and the per-layer table. Spec 5.1-5.2; plan Task 4.
// Files live in DATA_DIR/drawings as <sha256>.dxf, <sha256>.json.gz (full cache, for later batches) and
// <sha256>.summary.json.gz (what the GET routes read), never in the database.
const fs = require('fs'), fsp = require('fs/promises'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { Worker } = require('worker_threads');
const { UNIT_TO_M, normUom } = require('../lib/units');
const { PARSER_VERSION } = require('../lib/dxf/summary.js');

const MAX_QTY = 1e12;                          // the same cap as an imported or edited row qty (tenders.js MAX)
const MAX_BYTES = 100 * 1024 * 1024;           // the only route above the 20 MB JSON limit
const BINARY = Buffer.from('AutoCAD Binary DXF', 'latin1');
const BINARY_MSG = 'binary DXF is not supported — save as ASCII DXF';
const PARSE_TIMEOUT_MS = 10 * 60e3;
const HEAP_MB = Number(process.env.DRAWINGS_PARSE_HEAP_MB) || 4096;   // worker heap cap (override only for tests)
const TOO_LARGE = 'drawing too large to parse — PURGE unused objects or split the drawing in AutoCAD, then save as DXF again';
const SUMMARY_LRU = 8;
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
  // 1 = saved with confirm_uom: the user accepted that qty_unit differs from the row's unit
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'uom_confirmed')) db.exec('ALTER TABLE measurements ADD COLUMN uom_confirmed INTEGER NOT NULL DEFAULT 0');
  // 1 = saved with confirm_incomplete: its layer had shapes with no area (area) or approximated curves
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'incomplete')) db.exec('ALTER TABLE measurements ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0');
  // 1 = saved with confirm_duplicate: its layer (or block) had possible duplicates, counted in the total
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'duplicate')) db.exec('ALTER TABLE measurements ADD COLUMN duplicate INTEGER NOT NULL DEFAULT 0');
  // the layer metric or block count the qty was computed from (before width/depth/factor), for the formula shown with it;
  // NULL on measurements saved before this column (the UI then derives it from qty and the factors)
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'base')) db.exec('ALTER TABLE measurements ADD COLUMN base REAL');
  const DIR = path.join(DATA_DIR, 'drawings');
  fs.mkdirSync(DIR, { recursive: true });
  // temp uploads left by a stopped server are never valid: remove them
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('tmp-')) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) { /* in use or gone */ } }
  const dxfFile = sha => path.join(DIR, sha + '.dxf'), cacheFile = sha => path.join(DIR, sha + '.json.gz'), summaryFile = sha => path.join(DIR, sha + '.summary.json.gz');
  const tmpName = (ext = '') => path.join(DIR, 'tmp-' + crypto.randomBytes(12).toString('hex') + ext);
  // tmp -> dest. Content-addressed, so an existing dest is the same content: on Windows rename onto it can fail
  // (EPERM/EEXIST); then the tmp copy is dropped and the existing file kept.
  const place = async (tmp, dest) => {
    try { await fsp.rename(tmp, dest); }
    catch (e) { if (!fs.existsSync(dest)) { await fsp.unlink(tmp).catch(() => {}); throw e; } await fsp.unlink(tmp).catch(() => {}); }
  };
  // stored and shown errors never carry a server path
  const plain = msg => String(msg).split(DIR).join('').split(DATA_DIR).join('');

  const reply = (...a) => { send(...a); return true; };
  const idOf = s => /^\d+$/.test(s || '') ? Number(s) : null;
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const tenderRow = id => id === null ? null : db.prepare('SELECT * FROM tenders WHERE id=?').get(id);
  const drawingRow = id => id === null ? null : db.prepare('SELECT * FROM drawings WHERE id=?').get(id);
  const mustDraft = t => { if (t.status !== 'draft') bad(`tender is ${t.status}: only a draft can be changed`, 409); };
  const hasUnit = u => typeof u === 'string' && Object.hasOwn(UNIT_TO_M, u);

  // ---- hooks for tenders.js (R1). Callers run them inside their own transaction. ------------------------------
  const hasMeasurements = rowId => !!db.prepare('SELECT 1 FROM measurements WHERE row_id=? LIMIT 1').get(rowId);
  // Σ qty per unit of the measurements linked to a row; qty/unit only when they share one unit (never add m to m2)
  const rowMeasuredQty = rowId => {
    const rows = db.prepare('SELECT qty_unit unit, SUM(qty) qty, COUNT(*) count, MAX(incomplete) inc, MAX(duplicate) dup FROM measurements WHERE row_id=? GROUP BY qty_unit ORDER BY qty_unit').all(rowId);
    if (!rows.length) return null;
    const units = rows.map(u => ({ unit: u.unit, qty: u.qty, count: u.count })), one = units.length === 1;
    return { qty: one ? units[0].qty : null, unit: one ? units[0].unit : null, count: units.reduce((s, u) => s + u.count, 0), units, incomplete: rows.some(u => u.inc === 1), duplicate: rows.some(u => u.dup === 1) };
  };
  // what a take-off row's qty is built from (tenders.js applies the unit rule)
  const rowMeasurements = rowId => db.prepare('SELECT id, qty, qty_unit, uom_confirmed FROM measurements WHERE row_id=? ORDER BY id').all(rowId);
  // re-import: measurements of the replaced rows are kept, unlinked (row_id NULL); returns how many
  const unlinkRows = rowIds => {
    const st = db.prepare('UPDATE measurements SET row_id=NULL WHERE row_id=?');
    let n = 0;
    for (const id of rowIds) n += Number(st.run(id).changes);
    return n;
  };
  // revise: copy the drawings rows (same sha256, no file copy) and the measurements with row ids remapped
  const cloneForTender = (oldTid, newTid, rowIdMap) => {
    const dmap = new Map(), parsing = [];
    const insD = db.prepare('INSERT INTO drawings(tender_id,kind,name,sha256,bytes,units,suggested_units,status,error,rev,replaced_by,created,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)');
    const olds = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(oldTid);
    for (const d of olds) {
      const nid = Number(insD.run(newTid, d.kind, d.name, d.sha256, d.bytes, d.units, d.suggested_units, d.status, d.error, d.rev, d.created, d.created_by).lastInsertRowid);
      dmap.set(d.id, nid);
      if (d.status === 'parsing') parsing.push([nid, d.sha256]);
    }
    for (const d of olds) if (d.replaced_by !== null && dmap.has(d.replaced_by)) db.prepare('UPDATE drawings SET replaced_by=? WHERE id=?').run(dmap.get(d.replaced_by), dmap.get(d.id));
    const insM = db.prepare(`INSERT INTO measurements(drawing_id,tender_id,row_id,tool,layer,block,metric,nested,width,depth,factor,label,color,qty,qty_unit,handles_count,review_needed,uom_confirmed,incomplete,duplicate,base,created,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let n = 0;
    for (const m of db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(oldTid)) {
      // never drop or detach a measurement silently: a broken link stops the revision
      if (!dmap.has(m.drawing_id)) bad(`measurement ${m.id}: its drawing is not in this tender`, 409);
      if (m.row_id !== null && !rowIdMap.has(m.row_id)) bad(`measurement ${m.id}: its row is not in this tender`, 409);
      insM.run(dmap.get(m.drawing_id), newTid, m.row_id === null ? null : rowIdMap.get(m.row_id), m.tool, m.layer, m.block, m.metric, m.nested, m.width, m.depth, m.factor, m.label, m.color,
        m.qty, m.qty_unit, m.handles_count, m.review_needed, m.uom_confirmed, m.incomplete, m.duplicate, m.base, m.created, m.created_by);
      n++;
    }
    // a copy taken while its file was still parsing gets its own result once the caller's transaction is over
    if (parsing.length) setTimeout(() => { for (const [id, sha] of parsing) { const d = drawingRow(id); if (d && d.sha256 === sha && d.status === 'parsing') startParse(id, sha); } }, 0);
    return { drawings: dmap.size, measurements: n };
  };
  // delete a draft tender: its drawings and measurements rows go too (files stay: they are shared by sha256)
  const deleteForTender = tid => ({
    measurements: Number(db.prepare('DELETE FROM measurements WHERE tender_id=?').run(tid).changes),
    drawings: Number(db.prepare('DELETE FROM drawings WHERE tender_id=?').run(tid).changes),
  });
  const workers = { alive: 0, peak: 0, started: 0 };   // test hook: parse workers alive now / at most / ever started
  ctx.drawings = { hasMeasurements, rowMeasuredQty, rowMeasurements, unlinkRows, cloneForTender, deleteForTender, _workers: workers };

  // ---- upload: stream to a temp file while hashing; 413 the moment the limit is passed -----------------------
  // a received file is held until its drawing row is written; a file that ends with no drawing row (the tender was
  // deleted or stopped being a draft while the body arrived) and no other holder, parse or row is removed
  const holds = new Map();
  const hold = sha => holds.set(sha, (holds.get(sha) || 0) + 1);
  function release(sha, used) {
    const n = (holds.get(sha) || 1) - 1;
    if (n > 0) holds.set(sha, n); else holds.delete(sha);
    if (used || n > 0 || inflight.has(sha) || db.prepare('SELECT 1 FROM drawings WHERE sha256=? LIMIT 1').get(sha)) return;
    try { fs.unlinkSync(dxfFile(sha)); } catch (e) { /* gone already */ }
  }
  const httpErr = (msg, status) => Object.assign(new Error(msg), { status });
  function receive(req) {
    const tmp = tmpName();
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
      req.on('error', () => fail(httpErr('upload failed', 400)));
      req.on('close', () => { if (!req.complete) fail(httpErr('upload aborted', 400)); });
      out.on('error', e => fail(httpErr('could not store the upload (' + (e.code || 'error') + ')', 500)));
      out.on('finish', async () => {
        if (done) return; done = true;
        const sha = hash.digest('hex');
        hold(sha);   // released by upload(): until then no clean-up removes this file
        try {
          // same content -> same name: keep one copy
          if (fs.existsSync(dxfFile(sha))) await fsp.unlink(tmp); else await place(tmp, dxfFile(sha));
          ok({ sha, bytes });
        } catch (e) { release(sha, true); await fsp.unlink(tmp).catch(() => {}); no(httpErr('could not store the upload (' + (e.code || 'error') + ')', 500)); }
      });
    });
  }
  // ---- parse: a FIFO queue runs one worker at a time (memory); drawings of the same file share one result -------
  const inflight = new Map();   // sha256 -> Promise<{ ok, suggested_units?, error? }>
  const queue = []; let busy = false;
  const pump = () => {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    runWorker(job.sha).then(job.resolve, e => job.resolve({ ok: false, error: String(e && e.message || e) })).finally(() => { busy = false; pump(); });
  };
  const enqueue = sha => new Promise(resolve => { queue.push({ sha, resolve }); pump(); });
  // settles only after the worker has exited, so the next one never overlaps it
  function runWorker(sha) {
    return new Promise(resolve => {
      let result = null;
      const set = r => { if (!result) result = r; };
      const w = new Worker(WORKER, { workerData: { file: dxfFile(sha) }, resourceLimits: { maxOldGenerationSizeMb: HEAP_MB } });
      workers.alive++; workers.started++; workers.peak = Math.max(workers.peak, workers.alive);
      const timer = setTimeout(() => { set({ ok: false, error: 'parse timed out' }); w.terminate(); }, PARSE_TIMEOUT_MS);
      w.on('message', m => { set(m && typeof m === 'object' ? m : { ok: false, error: 'bad parser reply' }); w.terminate(); });
      w.on('error', e => set({ ok: false, error: e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? TOO_LARGE : 'the parser stopped unexpectedly: ' + (e && e.message || e) }));
      w.on('exit', code => { clearTimeout(timer); workers.alive--; resolve(result || { ok: false, error: 'the parser stopped unexpectedly (exit code ' + code + ')' }); });
    });
  }
  async function writeGz(bytes, dest) {
    const tmp = tmpName('.json.gz');
    try { await fsp.writeFile(tmp, Buffer.from(bytes)); } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
    await place(tmp, dest);
  }
  function parseSha(sha) {
    if (inflight.has(sha)) return inflight.get(sha);
    const p = enqueue(sha).then(async r => {
      if (!r.ok) return { ok: false, error: String(r.error || 'parse failed') };
      try { await writeGz(r.cache, cacheFile(sha)); await writeGz(r.summary, summaryFile(sha)); }
      catch (e) { return { ok: false, error: 'could not save the parse result (' + (e.code || 'error') + ')' }; }
      summaries.delete(sha);
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
            const error = plain(r.error).slice(0, 500);
            if (db.prepare("UPDATE drawings SET status='failed', error=? WHERE id=? AND status='parsing'").run(error, id).changes) audit('system', 'parse_failed', 'drawings', id, { error });
          }
        });
      } catch (e) { console.error('drawings: could not record the parse result for drawing ' + id, e); }
    });
  }
  // drawings left 'parsing' by a stopped server are parsed again
  for (const d of db.prepare("SELECT id, sha256 FROM drawings WHERE status='parsing'").all()) startParse(d.id, d.sha256);

  // ---- summaries: { header, ignored, warnings, layers, raw } where raw = layerTable in drawing units (factor 1) -----
  const gunzip = require('util').promisify(zlib.gunzip);
  const summaries = new Map();   // sha256 -> parsed summary, least recently used first
  const loadSummary = async sha => {
    let buf;
    try { buf = await fsp.readFile(summaryFile(sha)); } catch (e) { bad('the parsed drawing is missing: upload the drawing again', 409); }
    return JSON.parse((await gunzip(buf)).toString('utf8'));
  };
  // true when the stored summary was written by this parser version (never reuse another version's numbers)
  const summaryCurrent = async sha => { try { return (await loadSummary(sha)).version === PARSER_VERSION; } catch (e) { return false; } };
  async function readSummary(sha) {
    if (summaries.has(sha)) { const v = summaries.get(sha); summaries.delete(sha); summaries.set(sha, v); return v; }
    let v = await loadSummary(sha);
    if (v.version !== PARSER_VERSION) {   // written by another parser version: parse the file again
      const r = await parseSha(sha);
      if (!r.ok) bad('the drawing could not be read again: ' + plain(r.error), 409);
      v = await loadSummary(sha);
      if (v.version !== PARSER_VERSION) bad('the parsed drawing is out of date: upload the drawing again', 409);
    }
    summaries.set(sha, v);
    while (summaries.size > SUMMARY_LRU) summaries.delete(summaries.keys().next().value);
    return v;
  }
  // the raw table scaled to metres: lengths × f, areas × f²; counts as they are. No units → no numbers (as layerTable).
  function scaledTable(raw, unit) {
    if (unit === null) return { layers: raw.layers.map(l => ({ layer: l.layer, off: l.off, frozen: l.frozen, open_length: null, closed_perimeter: null, area: null, area_excluded: null, blocks: null, entities: null, approx: null, dropped: null })), warnings: [] };
    if (!hasUnit(unit)) throw new Error('unknown unit ' + unit);
    const f = UNIT_TO_M[unit];
    return { layers: raw.layers.map(l => ({ ...l, open_length: l.open_length * f, closed_perimeter: l.closed_perimeter * f, area: l.area * f * f })), warnings: raw.warnings };
  }

  // ---- HTTP -----------------------------------------------------------------------------------------------
  async function upload(req, res, url, t, me) {
    // every refusal here comes before the body is read; server.js closes the connection so the client stops sending
    need(me, 'admin', 'qs'); mustDraft(t);
    const name = String(url.searchParams.get('name') || '').trim();
    if (!name) bad('name is required');
    if (name.length > 200) bad('name must be at most 200 characters');
    if (Number(req.headers['content-length']) > MAX_BYTES) bad('the drawing is larger than 100 MB', 413);
    const got = await receive(req);
    let used = false;
    try {
      // the tender can be deleted or change status while the body arrives
      const stillDraft = () => { const cur = tenderRow(t.id); if (!cur) bad('tender not found', 404); mustDraft(cur); };
      stillDraft();
      // the same file already parsed (and not being parsed again) -> reuse its cache, ready at once
      const prev = !inflight.has(got.sha) && fs.existsSync(cacheFile(got.sha)) && await summaryCurrent(got.sha)
        ? db.prepare("SELECT suggested_units FROM drawings WHERE sha256=? AND status='ready' ORDER BY id DESC LIMIT 1").get(got.sha) : null;
      const id = tx(() => {
        stillDraft();
        const did = Number(db.prepare('INSERT INTO drawings(tender_id,kind,name,sha256,bytes,suggested_units,status,rev,created,created_by) VALUES(?,?,?,?,?,?,?,1,?,?)')
          .run(t.id, 'dxf', name, got.sha, got.bytes, prev ? prev.suggested_units : null, prev ? 'ready' : 'parsing', new Date().toISOString(), me.username).lastInsertRowid);
        audit(me, 'upload', 'drawings', did, { name, bytes: got.bytes, sha256: got.sha });
        return did;
      });
      used = true;
      if (!prev) startParse(id, got.sha);
      return reply(res, 202, { id });
    } finally { release(got.sha, used); }
  }

  async function drawingApi(req, res, parts, me) {
    const [, idStr, sub] = parts, method = req.method;
    const d = drawingRow(idOf(idStr));
    if (!d) bad('drawing not found', 404);
    const t = tenderRow(d.tender_id);
    if (!t) bad('drawing not found', 404);
    if (sub === undefined && parts.length === 2 && method === 'GET') {
      need(me, 'admin', 'qs', 'viewer');
      const c = d.status === 'ready' ? await readSummary(d.sha256) : null;
      return reply(res, 200, { ...d, header: c && c.header, ignored: c && c.ignored, warnings: c && c.warnings });
    }
    if (sub === 'layers' && parts.length === 3 && method === 'GET') {
      need(me, 'admin', 'qs', 'viewer');
      if (d.status !== 'ready') bad(`drawing is ${d.status}: no layers yet`, 409);
      const c = await readSummary(d.sha256), lt = scaledTable(c.raw, d.units);
      return reply(res, 200, { units: d.units, units_confirmed: d.units !== null, layers: lt.layers, warnings: [...c.warnings, ...lt.warnings] });
    }
    if (sub === 'units' && parts.length === 3 && method === 'PUT') {
      need(me, 'admin', 'qs'); mustDraft(t);
      const b = await ctx.readBody(req);
      for (const k of Object.keys(b)) if (k !== 'units') bad('unknown field: ' + k);
      if (!hasUnit(b.units)) bad('units must be one of ' + Object.keys(UNIT_TO_M).join(', '));
      tx(() => {
        mustDraft(tenderRow(t.id));
        const st = drawingRow(d.id).status;
        if (st !== 'ready') bad(`drawing is ${st}: units can be set once it is ready`, 409);
        if (db.prepare('SELECT 1 FROM measurements WHERE drawing_id=? LIMIT 1').get(d.id)) bad('units cannot change after measuring (batch 4 adds a before/after flow)', 409);
        const from = drawingRow(d.id).units;
        db.prepare('UPDATE drawings SET units=? WHERE id=?').run(b.units, d.id);
        audit(me, 'units', 'drawings', d.id, { from, to: b.units });
      });
      return reply(res, 200, drawingRow(d.id));
    }
    if (sub === 'measurements' && parts.length === 3 && method === 'POST') return createMeasurement(req, res, d, t, me);
    return false;
  }

  // ---- measurements: a layer metric or a block count linked to a tender row -----------------------------------
  // qty = base × (width ?? 1) × (depth ?? 1) × factor, base from the same scaled layer table as GET layers.
  const LAYER_METRICS = ['open_length', 'closed_perimeter', 'area'];
  const MFIELDS = ['row_id', 'tool', 'layer', 'metric', 'block', 'nested', 'width', 'depth', 'factor', 'label', 'color', 'confirm_uom', 'confirm_overlap', 'confirm_incomplete', 'confirm_duplicate'];
  const finNum = v => typeof v === 'number' && Number.isFinite(v);
  const optBool = (b, k) => { if (b[k] !== undefined && typeof b[k] !== 'boolean') bad(k + ' must be true or false'); return b[k] === true; };
  const optText = (b, k, max) => {
    if (b[k] === undefined || b[k] === null) return null;
    if (typeof b[k] !== 'string' || b[k].length > max) bad(`${k} must be text of at most ${max} characters`);
    return b[k].trim() || null;
  };
  const dim = (b, k) => {
    if (b[k] === undefined || b[k] === null) return null;
    if (!finNum(b[k]) || !(b[k] > 0) || b[k] > 1e6) bad(k + ' must be a number > 0 and ≤ 1000000');
    return b[k];
  };
  const rowIdOf = v => { if (!Number.isInteger(v) || v <= 0) bad('row_id must be a row id'); return v; };
  // a 409 whose body carries more than an error message
  const failBody = (status, body) => { throw Object.assign(new Error(body.error), { status, body }); };
  const conflictBody = body => failBody(409, body);
  function cleanMeasure(b) {
    for (const k of Object.keys(b)) if (!MFIELDS.includes(k)) bad('unknown field: ' + k);
    const m = { row_id: rowIdOf(b.row_id), tool: b.tool, metric: b.metric };
    if (!['dxf_layer', 'dxf_blocks'].includes(m.tool)) bad('tool must be dxf_layer or dxf_blocks');
    if (typeof b.layer !== 'string' || !b.layer || b.layer.length > 255) bad('layer is required');
    m.layer = b.layer;
    if (m.tool === 'dxf_layer') {
      if (!LAYER_METRICS.includes(m.metric)) bad('metric must be one of ' + LAYER_METRICS.join(', '));
      if (b.block !== undefined || b.nested !== undefined) bad('block and nested belong to dxf_blocks');
      m.block = null; m.nested = false;
    } else {
      if (m.metric !== 'count') bad('metric must be count for dxf_blocks');
      if (typeof b.block !== 'string' || !b.block) bad('block is required');
      m.block = b.block; m.nested = optBool(b, 'nested');
    }
    m.width = dim(b, 'width'); m.depth = dim(b, 'depth');
    const f = dim(b, 'factor'); m.factor = f === null ? 1 : f;
    // m → ×width m2 → ×width×depth m3; m2 → ×depth m3; nr takes neither
    if (m.metric === 'count' && (m.width !== null || m.depth !== null)) bad('width and depth do not apply to a count');
    if (m.metric === 'area' && m.width !== null) bad('an area takes depth, not width');
    if ((m.metric === 'open_length' || m.metric === 'closed_perimeter') && m.depth !== null && m.width === null) bad('depth needs a width');
    m.qty_unit = m.metric === 'count' ? 'nr' : ['m', 'm2', 'm3'][(m.metric === 'area' ? 1 : 0) + (m.width !== null) + (m.depth !== null)];
    m.label = optText(b, 'label', 200); m.color = optText(b, 'color', 32);
    m.confirm_uom = optBool(b, 'confirm_uom'); m.confirm_overlap = optBool(b, 'confirm_overlap'); m.confirm_incomplete = optBool(b, 'confirm_incomplete');
    m.confirm_duplicate = optBool(b, 'confirm_duplicate');
    return m;
  }
  const summaryOf = m => ({ drawing_id: m.drawing_id, row_id: m.row_id, tool: m.tool, layer: m.layer, ...(m.tool === 'dxf_blocks' ? { block: m.block, nested: !!m.nested } : {}), metric: m.metric, qty: m.qty, qty_unit: m.qty_unit });
  // the row checks shared by create and relink. Runs inside the tx.
  // Units: a known row unit must equal qty_unit (no override: m is never added into m2). Only a row whose unit text
  // normUom does not recognise may take a measurement with confirm_uom (uom_confirmed = 1), and then in one unit only.
  function checkRow(me, m, sha, tenderId, selfId, confirmUom, confirmOverlap) {
    const row = db.prepare('SELECT * FROM tender_rows WHERE id=?').get(m.row_id);
    if (!row || row.tender_id !== tenderId) bad('row not found in this tender');
    if (row.is_heading) bad('a heading row cannot take measurements');
    const ru = normUom(row.unit);
    if (ru === 'ls') bad('a lump-sum (LS) row cannot take measurements');
    let uomConfirmed = 0;
    if (ru === null) {
      if (!confirmUom) conflictBody({ error: 'unit mismatch', row_unit: row.unit, qty_unit: m.qty_unit });
      const other = db.prepare('SELECT DISTINCT qty_unit u FROM measurements WHERE row_id=? AND id<>?').all(m.row_id, selfId).map(x => x.u).filter(u => u !== m.qty_unit);
      if (other.length) failBody(400, { error: `the row already has measurements in ${other.join(', ')}: one unit per row`, row_unit: row.unit, qty_unit: m.qty_unit });
      uomConfirmed = 1;
    } else if (ru !== m.qty_unit) failBody(400, { error: 'unit mismatch — add width/depth', row_unit: row.unit, qty_unit: m.qty_unit });
    // the same geometry already on this row: same file (sha256), tool, layer, block (top and nested both count the
    // top inserts, so nested is not part of the key) and metric
    const over = db.prepare(`SELECT m.id FROM measurements m JOIN drawings d ON d.id=m.drawing_id
      WHERE m.row_id=? AND m.id<>? AND d.sha256=? AND m.tool=? AND m.layer=? AND m.block IS ? AND m.metric=?`).all(m.row_id, selfId, sha, m.tool, m.layer, m.block, m.metric);
    if (over.length && !confirmOverlap) conflictBody({ error: 'already measured on this row' });
    return { row, uomConfirmed, overlaps: over.length };
  }
  const recompute = rowId => rowId === null ? null : ctx.tenders.recomputeTakeoffQty(rowId);

  async function createMeasurement(req, res, d, t, me) {
    need(me, 'admin', 'qs'); mustDraft(t);
    const m = cleanMeasure(await ctx.readBody(req));
    if (d.status !== 'ready') bad(`drawing is ${d.status}: nothing to measure yet`, 409);
    if (d.units === null) bad('confirm the drawing units first', 409);
    const c = await readSummary(d.sha256), lt = scaledTable(c.raw, d.units);
    const layer = lt.layers.find(l => l.layer === m.layer);
    if (!layer) bad('layer not found in this drawing: ' + m.layer);
    let base, handles, incomplete = null;
    // shapes on the layer that the parser could not measure (dropped): no metric of that layer is the whole story
    const dropped = layer.dropped || 0;
    if (m.tool === 'dxf_layer') {
      base = layer[m.metric]; handles = layer.entities;
      // closed shapes left out of the area, or approximated curves: the layer total is not the whole story
      const area_excluded = m.metric === 'area' ? layer.area_excluded || 0 : 0, approx = layer.approx || 0;
      if (area_excluded || approx || dropped) incomplete = { area_excluded, approx, dropped };
    } else {
      if (dropped) incomplete = { area_excluded: 0, approx: 0, dropped };
      const bl = (layer.blocks || []).find(x => x.name === m.block);
      if (!bl) bad(`block ${m.block} not found on layer ${m.layer}`);
      base = bl.top + (m.nested ? bl.nested : 0); handles = base;
    }
    if (incomplete && !m.confirm_incomplete) conflictBody({ error: 'layer quantity is incomplete', ...incomplete });
    // the same geometry drawn twice on the source layer (or the same block twice at one point): counted in the total,
    // never merged, so the user confirms it. Layer metrics take the layer's warnings, a block count its block's.
    const duplicates = (lt.warnings || []).filter(w => w.code === 'possible_duplicate' && w.detail && w.detail.layer === m.layer
      && (m.tool === 'dxf_blocks' ? w.detail.block === m.block : w.detail.block === undefined)).reduce((s, w) => s + w.detail.count, 0);
    if (duplicates && !m.confirm_duplicate) conflictBody({ error: 'possible duplicates on this layer', duplicates });
    if (!finNum(base) || !(base > 0)) bad(`nothing to measure: ${m.layer} ${m.block ? m.block + ' ' : ''}${m.metric} is ${base}`);
    m.qty = base * (m.width ?? 1) * (m.depth ?? 1) * m.factor;
    if (!Number.isFinite(m.qty) || m.qty > MAX_QTY) bad(`the quantity ${m.qty} is out of range: it must be at most ${MAX_QTY}`);
    m.drawing_id = d.id;
    const out = tx(() => {
      mustDraft(tenderRow(t.id));
      // the table read above must still describe this drawing (units could change before the first measurement)
      const cur = drawingRow(d.id);
      if (!cur || cur.status !== 'ready' || cur.units !== d.units || cur.sha256 !== d.sha256) bad('the drawing changed: try again', 409);
      const ch = checkRow(me, m, d.sha256, t.id, -1, m.confirm_uom, m.confirm_overlap);
      const id = Number(db.prepare(`INSERT INTO measurements(drawing_id,tender_id,row_id,tool,layer,block,metric,nested,width,depth,factor,label,color,qty,qty_unit,handles_count,uom_confirmed,incomplete,duplicate,base,created,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.id, t.id, m.row_id, m.tool, m.layer, m.block, m.metric, m.nested ? 1 : 0, m.width, m.depth, m.factor, m.label, m.color,
        m.qty, m.qty_unit, handles, ch.uomConfirmed, incomplete ? 1 : 0, duplicates ? 1 : 0, base, new Date().toISOString(), me.username).lastInsertRowid);
      const sum = summaryOf(m);
      audit(me, 'measure', 'measurements', id, sum);
      if (ch.uomConfirmed) audit(me, 'measure_uom_confirmed', 'measurements', id, { ...sum, row_unit: ch.row.unit });
      if (ch.overlaps) audit(me, 'measure_overlap_confirmed', 'measurements', id, { ...sum, overlaps: ch.overlaps });
      if (duplicates) audit(me, 'measure_duplicate_confirmed', 'measurements', id, { drawing_id: d.id, row_id: m.row_id, layer: m.layer, ...(m.block ? { block: m.block } : {}), metric: m.metric, duplicates });
      if (incomplete) audit(me, 'measure_incomplete_confirmed', 'measurements', id, { drawing_id: d.id, row_id: m.row_id, layer: m.layer, metric: m.metric, ...incomplete });
      return { id, qty: m.qty, qty_unit: m.qty_unit, row_qty: recompute(m.row_id), incomplete: !!incomplete, duplicate: !!duplicates };
    });
    return reply(res, 200, out);
  }

  async function measurementApi(req, res, parts, me) {
    const method = req.method;
    if (method !== 'PUT' && method !== 'DELETE') bad('method not allowed', 405);
    need(me, 'admin', 'qs');   // before the lookup: a viewer learns nothing about which ids exist
    const m = idOf(parts[1]) === null ? null : db.prepare('SELECT * FROM measurements WHERE id=?').get(idOf(parts[1]));
    if (!m) bad('measurement not found', 404);
    const t = tenderRow(m.tender_id);
    if (!t) bad('measurement not found', 404);
    mustDraft(t);
    if (method === 'DELETE') {
      const out = tx(() => {
        mustDraft(tenderRow(t.id));
        const cur = db.prepare('SELECT * FROM measurements WHERE id=?').get(m.id);
        if (!cur) bad('measurement not found', 404);
        db.prepare('DELETE FROM measurements WHERE id=?').run(m.id);
        audit(me, 'measure_delete', 'measurements', m.id, summaryOf(cur));
        return { ok: 1, row_qty: recompute(cur.row_id) };
      });
      return reply(res, 200, out);
    }
    if (method === 'PUT') {
      const b = await ctx.readBody(req);
      for (const k of Object.keys(b)) if (!['row_id', 'confirm_uom', 'confirm_overlap'].includes(k)) bad('unknown field: ' + k);
      const rowId = rowIdOf(b.row_id), confirmUom = optBool(b, 'confirm_uom'), confirmOverlap = optBool(b, 'confirm_overlap');
      const out = tx(() => {
        mustDraft(tenderRow(t.id));
        const cur = db.prepare('SELECT * FROM measurements WHERE id=?').get(m.id);
        if (!cur) bad('measurement not found', 404);
        if (cur.row_id === rowId) bad('the measurement is already linked to this row');
        const d = drawingRow(cur.drawing_id);
        if (!d) bad('the drawing of this measurement is missing', 409);
        const ch = checkRow(me, { ...cur, row_id: rowId }, d.sha256, t.id, cur.id, confirmUom, confirmOverlap);
        db.prepare('UPDATE measurements SET row_id=?, uom_confirmed=? WHERE id=?').run(rowId, ch.uomConfirmed, cur.id);
        const sum = { ...summaryOf({ ...cur, row_id: rowId }), from_row_id: cur.row_id };
        audit(me, 'measure_relink', 'measurements', cur.id, sum);
        if (ch.uomConfirmed) audit(me, 'measure_uom_confirmed', 'measurements', cur.id, { ...sum, row_unit: ch.row.unit });
        if (ch.overlaps) audit(me, 'measure_overlap_confirmed', 'measurements', cur.id, { ...sum, overlaps: ch.overlaps });
        return { ok: 1, old_row_qty: recompute(cur.row_id), row_qty: recompute(rowId) };
      });
      return reply(res, 200, out);
    }
    return false;
  }

  function tenderMeasurements(t) {
    const all = db.prepare(`SELECT m.*, d.name AS drawing_name, r.no AS row_no, r.description AS row_description, r.unit AS row_unit
      FROM measurements m JOIN drawings d ON d.id=m.drawing_id LEFT JOIN tender_rows r ON r.id=m.row_id WHERE m.tender_id=? ORDER BY m.id`).all(t.id);
    return { measurements: all.filter(x => x.row_id !== null), unlinked: all.filter(x => x.row_id === null) };
  }

  async function handle(req, res, url, parts, me) {
    try { return await route(req, res, url, parts, me); }
    catch (e) { if (e.body) return reply(res, e.status, e.body); throw e; }
  }
  async function route(req, res, url, parts, me) {
    const method = req.method;
    if (parts[0] === 'tenders' && parts[2] === 'measurements' && parts.length === 3 && method === 'GET') {
      const t = tenderRow(idOf(parts[1]));
      if (!t) bad('tender not found', 404);
      need(me, 'admin', 'qs', 'viewer');
      return reply(res, 200, tenderMeasurements(t));
    }
    if (parts[0] === 'measurements' && parts.length === 2) return measurementApi(req, res, parts, me);
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
