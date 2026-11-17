// Drawings: raw DXF upload into a sha256 file store, parse in a worker thread into a gzipped JSON cache,
// units confirmation and the per-layer table. Spec 5.1-5.2; plan Task 4.
// PDF and image drawings (batch 3): stored as <sha256>.pdf / .png / .jpg, never parsed on the server; the browser reads a
// PDF's pages with pdf.js and registers them (POST /drawings/:id/pages).
// Files live in DATA_DIR/drawings as <sha256>.dxf, <sha256>.json.gz (full cache, for later batches) and
// <sha256>.summary.json.gz (what the GET routes read) and <sha256>.render.bin.gz (the viewer's display file, lib/dxf/render.js),
// never in the database.
const fs = require('fs'), fsp = require('fs/promises'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { Worker } = require('worker_threads');
const { UNIT_TO_M, normUom } = require('../lib/units');
const { PARSER_VERSION } = require('../lib/dxf/summary.js');
const { imageSize } = require('../lib/takeoff/imagesize.js');
const calib = require('../lib/takeoff/calib.js');
const manual = require('../lib/takeoff/manual.js');
const compare = require('../lib/takeoff/compare.js');

const MAX_QTY = 1e12;                          // the same cap as an imported or edited row qty (tenders.js MAX)
const MAX_BYTES = 100 * 1024 * 1024;           // the only route above the 20 MB JSON limit (DXF and PDF)
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;      // PNG / JPEG
const IMAGE_HEAD = 1024 * 1024;                // bytes kept while streaming for the image size (the whole file is read when its header is longer)
// stored file type by magic bytes; anything else is taken as an ASCII DXF (as before batch 3)
const MAGIC = [['pdf', Buffer.from('%PDF-', 'latin1')], ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], ['jpg', Buffer.from([0xff, 0xd8, 0xff])]];
const sniff = head => (MAGIC.find(([, m]) => head.length >= m.length && head.subarray(0, m.length).equals(m)) || ['dxf'])[0];
// a name ending in one of these says what the file is; content that does not match is refused
const NAME_EXT = { pdf: 'pdf', png: 'png', jpg: 'jpg', jpeg: 'jpg', dxf: 'dxf' };
const EXT_LABEL = { pdf: 'a PDF', png: 'a PNG image', jpg: 'a JPEG image', dxf: 'a DXF drawing' };
const MIME = { dxf: 'application/dxf', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg' };
const MAX_PAGES = 2000, MAX_PAGE_PT = 14400, MAX_PAGE_ORIGIN = 1e7;   // pages in one PDF; a page side in points (200 in)
const MAX_NAME = 200;                          // a drawing name (also a generated page-row name)
const BINARY = Buffer.from('AutoCAD Binary DXF', 'latin1');
const BINARY_MSG = 'binary DXF is not supported — save as ASCII DXF';
const PARSE_TIMEOUT_MS = 10 * 60e3;
const HEAP_MB = Number(process.env.DRAWINGS_PARSE_HEAP_MB) || 4096;   // worker heap cap (override only for tests)
const TOO_LARGE = 'drawing too large to parse — PURGE unused objects or split the drawing in AutoCAD, then save as DXF again';
const SUMMARY_LRU = 8;
const WORKER = path.join(__dirname, '..', 'lib', 'dxf', 'worker.js');
const SELECT_WORKER = path.join(__dirname, '..', 'lib', 'dxf', 'select-worker.js');
const MAX_HANDLES = 200000;                    // entities in one selection

module.exports = ctx => {
  const { db, send, bad, need, audit, DATA_DIR } = ctx;
  db.exec(`
CREATE TABLE IF NOT EXISTS drawings(id INTEGER PRIMARY KEY AUTOINCREMENT, tender_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'dxf' /* dxf|pdf|image */, name TEXT, sha256 TEXT, bytes INTEGER,
  units TEXT, suggested_units TEXT, status TEXT /* parsing|ready|failed (dxf); pages (a pdf whose pages are not registered yet) */, error TEXT, rev INTEGER DEFAULT 1, replaced_by INTEGER, created TEXT, created_by TEXT);
CREATE INDEX IF NOT EXISTS drawings_tender ON drawings(tender_id);
CREATE INDEX IF NOT EXISTS drawings_sha ON drawings(sha256);
CREATE TABLE IF NOT EXISTS measurements(id INTEGER PRIMARY KEY AUTOINCREMENT, drawing_id INTEGER NOT NULL, tender_id INTEGER NOT NULL, row_id INTEGER /* NULL = unlinked */,
  tool TEXT, layer TEXT, block TEXT, metric TEXT, nested INTEGER DEFAULT 0, width REAL, depth REAL, factor REAL NOT NULL DEFAULT 1, label TEXT, color TEXT,
  qty REAL, qty_unit TEXT, handles_count INTEGER, review_needed INTEGER DEFAULT 0, created TEXT, created_by TEXT);
CREATE INDEX IF NOT EXISTS measurements_drawing ON measurements(drawing_id);
CREATE INDEX IF NOT EXISTS measurements_row ON measurements(row_id);
`);
  // the PARSER_VERSION whose parse failed (status 'failed'); a newer parser tries the file once more (NULL: failed before
  // this column, so also tried once more)
  if (!db.prepare('PRAGMA table_info(drawings)').all().some(c => c.name === 'failed_version')) db.exec('ALTER TABLE drawings ADD COLUMN failed_version INTEGER');
  // PDF / image (batch 3): the page number (NULL: a PDF whose pages are not registered yet), its size in page units (PDF
  // points, image pixels), the PDF page /Rotate, and for pages 2..n the drawing row of page 1 (same file)
  // page_x0/page_y0 (R16): a PDF page box's lower-left corner in user space (page.view[0], [1]); points stay absolute
  for (const [c, type] of [['page', 'INTEGER'], ['page_w', 'REAL'], ['page_h', 'REAL'], ['rotation', 'INTEGER'], ['parent_id', 'INTEGER'], ['page_x0', 'REAL NOT NULL DEFAULT 0'], ['page_y0', 'REAL NOT NULL DEFAULT 0']])
    if (!db.prepare('PRAGMA table_info(drawings)').all().some(x => x.name === c)) db.exec(`ALTER TABLE drawings ADD COLUMN ${c} ${type}`);
  // a new version of a drawing (batch 4, spec 6.5): pending = 1 until it is accepted or cancelled; replaces_id = the drawing
  // row it replaces (a PDF page row: the old row of the same page number, NULL for a page the old file did not have)
  for (const [c, type] of [['pending', 'INTEGER NOT NULL DEFAULT 0'], ['replaces_id', 'INTEGER']])
    if (!db.prepare('PRAGMA table_info(drawings)').all().some(x => x.name === c)) db.exec(`ALTER TABLE drawings ADD COLUMN ${c} ${type}`);
  // 1 = saved with confirm_uom: the user accepted that qty_unit differs from the row's unit
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'uom_confirmed')) db.exec('ALTER TABLE measurements ADD COLUMN uom_confirmed INTEGER NOT NULL DEFAULT 0');
  // 1 = saved with confirm_incomplete: its layer had shapes with no area (area) or approximated curves
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'incomplete')) db.exec('ALTER TABLE measurements ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0');
  // 1 = saved with confirm_duplicate: its layer (or block) had possible duplicates, counted in the total
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'duplicate')) db.exec('ALTER TABLE measurements ADD COLUMN duplicate INTEGER NOT NULL DEFAULT 0');
  // the layer metric or block count the qty was computed from (before width/depth/factor), for the formula shown with it;
  // NULL on measurements saved before this column (the UI then derives it from qty and the factors)
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'base')) db.exec('ALTER TABLE measurements ADD COLUMN base REAL');
  // dxf_selection: JSON { metric, by_layer: { layer: entities used }, skipped, nested?, blocks?: [{ layer, block, top, nested, count }] }
  // for display and the overlap check of later layer/block measurements (a count: top / nested = the selected inserts at the
  // top level / inside blocks, count = what the qty took; summaries saved before this have { layer, block, count }); NULL
  // for the other tools. measurements.nested = 1: a selection count that included nested inserts.
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'selection_summary')) db.exec('ALTER TABLE measurements ADD COLUMN selection_summary TEXT');
  // 1 = a selection count over more than one block name, saved with confirm_mixed_blocks
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'mixed')) db.exec('ALTER TABLE measurements ADD COLUMN mixed INTEGER NOT NULL DEFAULT 0');
  // calibration of a PDF page or an image (one drawing row each): region NULL = the page (at most one), or JSON
  // [minx,miny,maxx,maxy] in page units (regions never overlap); scale = metres per page unit (lib/takeoff/calib.js)
  db.exec(`CREATE TABLE IF NOT EXISTS calibrations(id INTEGER PRIMARY KEY AUTOINCREMENT, drawing_id INTEGER NOT NULL, region TEXT, p1x REAL NOT NULL, p1y REAL NOT NULL,
  p2x REAL NOT NULL, p2y REAL NOT NULL, real REAL NOT NULL, unit TEXT NOT NULL, scale REAL NOT NULL, verify_pct REAL, created TEXT, created_by TEXT);
CREATE INDEX IF NOT EXISTS calibrations_drawing ON calibrations(drawing_id);
CREATE UNIQUE INDEX IF NOT EXISTS calibrations_page ON calibrations(drawing_id) WHERE region IS NULL;`);
  // R15: copied_from = the calibration of the previous version this one was copied from at accept (NULL: made on this
  // page); verifying it or calibrating again on the new page clears it
  if (!db.prepare('PRAGMA table_info(calibrations)').all().some(c => c.name === 'copied_from')) db.exec('ALTER TABLE calibrations ADD COLUMN copied_from INTEGER');
  // the calibration a manual measurement on a PDF page or an image was computed with (NULL on a DXF: its units)
  if (!db.prepare('PRAGMA table_info(measurements)').all().some(c => c.name === 'calibration_id')) db.exec('ALTER TABLE measurements ADD COLUMN calibration_id INTEGER');
  // tool 'manual' (lib/takeoff/manual.js): geom = the shape drawn, JSON { tool: line|polyline|area|rect|count, … } in
  // drawing units (DXF) or page units (PDF points, image pixels); metric = length|area|perimeter|count; deduct = 1: a
  // deduction (its qty is negative). NULL / 0 for the DXF tools.
  for (const [c, type] of [['geom', 'TEXT'], ['deduct', 'INTEGER NOT NULL DEFAULT 0']])
    if (!db.prepare('PRAGMA table_info(measurements)').all().some(x => x.name === c)) db.exec(`ALTER TABLE measurements ADD COLUMN ${c} ${type}`);
  // dxf_selection: the handles of the entities that made its qty (written, copied and deleted with the measurement)
  db.exec('CREATE TABLE IF NOT EXISTS measurement_handles(measurement_id INTEGER NOT NULL, handle TEXT NOT NULL, PRIMARY KEY(measurement_id, handle))');
  // the entity's geomKey: an exact copy measured by another selection on the same row needs confirm_duplicate
  if (!db.prepare('PRAGMA table_info(measurement_handles)').all().some(c => c.name === 'geom_key')) db.exec('ALTER TABLE measurement_handles ADD COLUMN geom_key TEXT');
  const DIR = path.join(DATA_DIR, 'drawings');
  fs.mkdirSync(DIR, { recursive: true });
  // temp uploads left by a stopped server are never valid: remove them
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('tmp-')) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) { /* in use or gone */ } }
  const dxfFile = sha => path.join(DIR, sha + '.dxf'), cacheFile = sha => path.join(DIR, sha + '.json.gz'), summaryFile = sha => path.join(DIR, sha + '.summary.json.gz');
  const renderFile = sha => path.join(DIR, sha + '.render.bin.gz');
  const storedFile = (sha, ext) => path.join(DIR, sha + '.' + ext);   // the uploaded file: ext dxf | pdf | png | jpg
  // the stored file type of a drawing row (an image is .png or .jpg: the same content always has the same name)
  const extOf = d => d.kind === 'pdf' ? 'pdf' : d.kind === 'image' ? (fs.existsSync(storedFile(d.sha256, 'png')) ? 'png' : 'jpg') : 'dxf';
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
  // Review Focus 3: while a new version of a drawing waits to be accepted or cancelled, nothing on the old one (any page of
  // it) is measured, edited, deleted, relinked, calibrated or changed in units, so the compare it was reviewed against
  // stays true; and nothing is measured or calibrated on the pending one (its measurements arrive by accept).
  const pendingFor = d => db.prepare('SELECT id FROM drawings WHERE replaces_id=? AND pending=1 AND parent_id IS NULL').get(d.parent_id ?? d.id) || null;
  const notReplacing = d => { if (pendingFor(d)) bad('a replacement is pending: accept or cancel it first', 409); };
  const notPending = d => { if (d.pending) bad('this drawing is a pending replacement: accept or cancel it first', 409); };
  // an accepted replacement keeps the old drawing (every page row of it) as read-only history
  const notReplaced = d => { if (d.replaced_by !== null) bad('this drawing has been replaced by a newer version: it is kept as history only', 409); };
  const canMeasure = d => { notPending(d); notReplacing(d); notReplaced(d); };

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
  // revise: copy the drawings rows (same sha256, no file copy), their calibrations and the measurements with drawing,
  // row and calibration ids remapped. A pending replacement (not accepted) is not copied: the Rev has accepted history only.
  const cloneForTender = (oldTid, newTid, rowIdMap) => {
    const dmap = new Map(), parsing = [];
    const insD = db.prepare(`INSERT INTO drawings(tender_id,kind,name,sha256,bytes,units,suggested_units,status,error,failed_version,page,page_w,page_h,rotation,page_x0,page_y0,parent_id,rev,replaced_by,created,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?,?)`);
    const olds = db.prepare('SELECT * FROM drawings WHERE tender_id=? AND pending=0 ORDER BY id').all(oldTid);
    for (const d of olds) {
      const nid = Number(insD.run(newTid, d.kind, d.name, d.sha256, d.bytes, d.units, d.suggested_units, d.status, d.error, d.failed_version, d.page, d.page_w, d.page_h, d.rotation, d.page_x0, d.page_y0,
        d.rev, d.created, d.created_by).lastInsertRowid);
      dmap.set(d.id, nid);
      if (d.status === 'parsing') parsing.push([nid, d.sha256]);
    }
    for (const d of olds) if (d.replaced_by !== null && dmap.has(d.replaced_by)) db.prepare('UPDATE drawings SET replaced_by=? WHERE id=?').run(dmap.get(d.replaced_by), dmap.get(d.id));
    for (const d of olds) if (d.replaces_id !== null && dmap.has(d.replaces_id)) db.prepare('UPDATE drawings SET replaces_id=? WHERE id=?').run(dmap.get(d.replaces_id), dmap.get(d.id));
    // a PDF page row keeps its page 1 row (never detached silently)
    for (const d of olds) if (d.parent_id !== null) {
      if (!dmap.has(d.parent_id)) bad(`drawing ${d.id}: its page 1 is not in this tender`, 409);
      db.prepare('UPDATE drawings SET parent_id=? WHERE id=?').run(dmap.get(d.parent_id), dmap.get(d.id));
    }
    // calibrations in id order, so the lower-id rule between regions sharing an edge picks the same one in the copy
    const cmap = new Map();
    // copied_from (R15) points at the Rev's copy of the source (copied before it: a lower id); a source not in the Rev: NULL
    const insC = db.prepare('INSERT INTO calibrations(drawing_id,region,p1x,p1y,p2x,p2y,real,unit,scale,verify_pct,copied_from,created,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const c of db.prepare('SELECT c.* FROM calibrations c JOIN drawings d ON d.id=c.drawing_id WHERE d.tender_id=? AND d.pending=0 ORDER BY c.id').all(oldTid))
      cmap.set(c.id, Number(insC.run(dmap.get(c.drawing_id), c.region, c.p1x, c.p1y, c.p2x, c.p2y, c.real, c.unit, c.scale, c.verify_pct,
        c.copied_from === null ? null : cmap.get(c.copied_from) ?? null, c.created, c.created_by).lastInsertRowid));
    const insM = db.prepare(`INSERT INTO measurements(drawing_id,tender_id,row_id,tool,layer,block,metric,nested,width,depth,factor,label,color,qty,qty_unit,handles_count,review_needed,uom_confirmed,incomplete,duplicate,mixed,base,selection_summary,geom,deduct,calibration_id,created,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insH = db.prepare('INSERT INTO measurement_handles(measurement_id, handle, geom_key) SELECT ?, handle, geom_key FROM measurement_handles WHERE measurement_id=? ORDER BY rowid');
    let n = 0;
    for (const m of db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(oldTid)) {
      // never drop or detach a measurement silently: a broken link stops the revision
      if (!dmap.has(m.drawing_id)) bad(`measurement ${m.id}: its drawing is not in this tender`, 409);
      if (m.row_id !== null && !rowIdMap.has(m.row_id)) bad(`measurement ${m.id}: its row is not in this tender`, 409);
      if (m.calibration_id !== null && !cmap.has(m.calibration_id)) bad(`measurement ${m.id}: its calibration is not in this tender`, 409);
      const nid = Number(insM.run(dmap.get(m.drawing_id), newTid, m.row_id === null ? null : rowIdMap.get(m.row_id), m.tool, m.layer, m.block, m.metric, m.nested, m.width, m.depth, m.factor, m.label, m.color,
        m.qty, m.qty_unit, m.handles_count, m.review_needed, m.uom_confirmed, m.incomplete, m.duplicate, m.mixed, m.base, m.selection_summary,
        m.geom, m.deduct, m.calibration_id === null ? null : cmap.get(m.calibration_id), m.created, m.created_by).lastInsertRowid);
      if (m.tool === 'dxf_selection') insH.run(nid, m.id);
      n++;
    }
    // a copy taken while its file was still parsing gets its own result once the caller's transaction is over
    if (parsing.length) setTimeout(() => { for (const [id, sha] of parsing) { const d = drawingRow(id); if (d && d.sha256 === sha && d.status === 'parsing') startParse(id, sha); } }, 0);
    return { drawings: dmap.size, measurements: n, calibrations: cmap.size };
  };
  // delete a draft tender: its drawings (pending replacements too) and measurements rows go too (files stay: they are
  // shared by sha256)
  const deleteForTender = tid => ({
    handles: Number(db.prepare('DELETE FROM measurement_handles WHERE measurement_id IN (SELECT id FROM measurements WHERE tender_id=?)').run(tid).changes),
    measurements: Number(db.prepare('DELETE FROM measurements WHERE tender_id=?').run(tid).changes),
    calibrations: Number(db.prepare('DELETE FROM calibrations WHERE drawing_id IN (SELECT id FROM drawings WHERE tender_id=?)').run(tid).changes),
    drawings: Number(db.prepare('DELETE FROM drawings WHERE tender_id=?').run(tid).changes),
  });
  const workers = { alive: 0, peak: 0, started: 0 };   // test hook: parse workers alive now / at most / ever started
  // test hook: hooks.beforeUnitTx(attempt), when a test sets it, runs (awaited) between a unit change's async recomputation
  // and its tx, so a test can change measurements inside that window. null (nothing runs) unless a test sets it.
  // hooks.beforeMeasureTx (same idea): runs between a layer/block measurement's summary read and its tx.
  // hooks.beforeAcceptTx (same idea): runs between a replacement accept's async comparison and its tx.
  const hooks = { beforeUnitTx: null, beforeMeasureTx: null, beforeAcceptTx: null };
  // R8: a tender with a drawing replacement waiting for accept or cancel is not submitted or approved (tenders.js)
  const hasPendingReplacement = tid => !!db.prepare('SELECT 1 FROM drawings WHERE tender_id=? AND pending=1 LIMIT 1').get(tid);
  // the Excel take-off report (tenders.js): the measurement list as GET /tenders/:id/measurements returns it, and the
  // tender's drawings (not a pending replacement) with their page calibration scale and number of calibrated regions
  const reportData = t => ({
    list: tenderMeasurements(t),
    drawings: db.prepare(`SELECT d.*, (SELECT c.scale FROM calibrations c WHERE c.drawing_id=d.id AND c.region IS NULL) AS page_scale,
      (SELECT COUNT(*) FROM calibrations c WHERE c.drawing_id=d.id AND c.region IS NOT NULL) AS regions FROM drawings d WHERE d.tender_id=? AND d.pending=0 ORDER BY d.id`).all(t.id),
  });
  ctx.drawings = { hasMeasurements, rowMeasuredQty, rowMeasurements, unlinkRows, cloneForTender, deleteForTender, hasPendingReplacement, reportData, _workers: workers, _summaries: () => summaries, _hooks: hooks };   // _ = test hooks

  // ---- upload: stream to a temp file while hashing; 413 the moment the limit is passed -----------------------
  // a received file is held until its drawing row is written; a file that ends with no drawing row (the tender was
  // deleted or stopped being a draft while the body arrived) and no other holder, parse or row is removed
  const holds = new Map();
  const hold = sha => holds.set(sha, (holds.get(sha) || 0) + 1);
  function release(sha, used, ext = 'dxf') {
    const n = (holds.get(sha) || 1) - 1;
    if (n > 0) holds.set(sha, n); else holds.delete(sha);
    if (used || n > 0 || inflight.has(sha) || db.prepare('SELECT 1 FROM drawings WHERE sha256=? LIMIT 1').get(sha)) return;
    try { fs.unlinkSync(storedFile(sha, ext)); } catch (e) { /* gone already */ }
  }
  const httpErr = (msg, status) => Object.assign(new Error(msg), { status });
  // expect: the type the name says (NAME_EXT) or null. Resolves { sha, bytes, ext, size } (size: an image's pixels).
  function receive(req, expect) {
    const tmp = tmpName();
    const out = fs.createWriteStream(tmp, { flags: 'wx' }), hash = crypto.createHash('sha256');
    let bytes = 0, head = Buffer.alloc(0), done = false, ext = null, first = [], firstLen = 0;
    return new Promise((ok, no) => {
      const fail = err => {
        if (done) return; done = true;
        req.removeListener('data', onData); req.pause();
        out.destroy();
        out.once('close', () => fsp.unlink(tmp).catch(() => {}).then(() => no(err)));
      };
      // the type is known once the head is complete (or at the end of a shorter file); it must match the name
      const typed = () => {
        ext = sniff(head);
        if (expect && expect !== ext) { fail(httpErr(`the file does not match its name: it is not ${EXT_LABEL[expect]}`, 400)); return false; }
        return true;
      };
      const onData = chunk => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return fail(httpErr('the drawing is larger than 100 MB', 413));
        if (head.length < BINARY.length) {
          head = Buffer.concat([head, chunk.subarray(0, BINARY.length - head.length)]);
          if (head.length === BINARY.length && head.equals(BINARY)) return fail(httpErr(BINARY_MSG, 400));
          if (head.length === BINARY.length && !typed()) return;
        }
        if ((ext === 'png' || ext === 'jpg') && bytes > MAX_IMAGE_BYTES) return fail(httpErr('the image is larger than 50 MB', 413));
        if (ext !== 'dxf' && ext !== 'pdf' && firstLen < IMAGE_HEAD) { const c = chunk.subarray(0, IMAGE_HEAD - firstLen); first.push(c); firstLen += c.length; }
        hash.update(chunk);
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => { if (!done) req.resume(); }); }
      };
      req.on('data', onData);
      req.on('end', () => {
        if (done) return;
        if (bytes === 0) return fail(httpErr('the file is empty', 400));
        if (ext === null && !typed()) return;
        out.end();
      });
      req.on('aborted', () => fail(httpErr('upload aborted', 400)));
      req.on('error', () => fail(httpErr('upload failed', 400)));
      req.on('close', () => { if (!req.complete) fail(httpErr('upload aborted', 400)); });
      out.on('error', e => fail(httpErr('could not store the upload (' + (e.code || 'error') + ')', 500)));
      out.on('finish', async () => {
        if (done) return; done = true;
        const sha = hash.digest('hex');
        let size = null;
        if (ext === 'png' || ext === 'jpg') {
          // the pixel size from the header; a header longer than the kept head (large metadata) is read from the file
          try { size = imageSize(Buffer.concat(first)); }
          catch (e) {
            try {
              if (e.message === 'not a PNG or JPEG image' && bytes > firstLen) size = imageSize(await fsp.readFile(tmp)); else throw e;
            } catch (e2) { await fsp.unlink(tmp).catch(() => {}); return no(httpErr(e2.code ? 'could not read the upload (' + e2.code + ')' : e2.message, e2.code ? 500 : 400)); }
          }
        }
        hold(sha);   // released by upload(): until then no clean-up removes this file
        try {
          // same content -> same name: keep one copy
          const dest = storedFile(sha, ext);
          if (fs.existsSync(dest)) await fsp.unlink(tmp); else await place(tmp, dest);
          ok({ sha, bytes, ext, size });
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
    job.run().then(job.resolve, e => job.resolve({ ok: false, transient: true, error: String(e && e.message || e) })).finally(() => { busy = false; pump(); });
  };
  // every worker (parse or selection total) goes through this one queue
  const enqueueJob = run => new Promise(resolve => { queue.push({ run, resolve }); pump(); });
  const enqueue = sha => enqueueJob(() => runWorker(sha));
  // settles only after the worker has exited, so the next one never overlaps it. `msg` names what failed in plain words.
  function spawnWorker(file, workerData, accept, msg) {
    return new Promise(resolve => {
      let result = null;
      const set = r => { if (!result) result = r; };
      const w = new Worker(file, { workerData, resourceLimits: { maxOldGenerationSizeMb: HEAP_MB } });
      workers.alive++; workers.started++; workers.peak = Math.max(workers.peak, workers.alive);
      const timer = setTimeout(() => { set({ ok: false, transient: true, error: msg.timeout }); w.terminate(); }, PARSE_TIMEOUT_MS);
      w.on('message', m => { set(m && typeof m === 'object' ? accept(m) : { ok: false, transient: true, error: msg.bad }); w.terminate(); });
      w.on('error', e => set({ ok: false, transient: true, error: e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? msg.oom : msg.stopped + ': ' + (e && e.message || e) }));
      w.on('exit', code => { clearTimeout(timer); workers.alive--; resolve(result || { ok: false, transient: true, error: msg.stopped + ' (exit code ' + code + ')' }); });
    });
  }
  // the worker says whether its failure is transient (the file could not be read) or about the file itself
  const runWorker = sha => spawnWorker(WORKER, { file: dxfFile(sha) }, m => m.ok === false ? { ...m, transient: m.transient === true } : m,
    { timeout: 'parse timed out', bad: 'bad parser reply', oom: TOO_LARGE, stopped: 'the parser stopped unexpectedly' });
  // a selection total: never changes a drawing's status (any failure is reported to the caller only)
  const runSelect = (sha, handles, metric, nested) => spawnWorker(SELECT_WORKER, { file: cacheFile(sha), handles, metric, nested: !!nested }, m => m,
    { timeout: 'the selection total timed out', bad: 'bad reply from the selection total', oom: 'the selection is too large to total', stopped: 'the selection total stopped unexpectedly' });
  async function writeGz(bytes, dest) {
    const tmp = tmpName('.json.gz');
    try { await fsp.writeFile(tmp, Buffer.from(bytes)); } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
    await place(tmp, dest);
  }
  function parseSha(sha) {
    if (inflight.has(sha)) return inflight.get(sha);
    const p = enqueue(sha).then(async r => {
      if (!r.ok) return { ok: false, transient: !!r.transient, error: String(r.error || 'parse failed') };
      // the summary last: a current summary means the other files are there too
      // no display file (the summary says why): a stale one of an earlier parse is removed
      try {
        if (r.render) await writeGz(r.render, renderFile(sha)); else await fsp.unlink(renderFile(sha)).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await writeGz(r.cache, cacheFile(sha)); await writeGz(r.summary, summaryFile(sha));
      }
      catch (e) { return { ok: false, transient: true, error: 'could not save the parse result (' + (e.code || 'error') + ')' }; }
      summaries.delete(sha);
      return { ok: true, suggested_units: r.suggested_units ?? null };
    }).catch(e => ({ ok: false, transient: true, error: String(e && e.message || e) })).finally(() => inflight.delete(sha));
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
            if (db.prepare("UPDATE drawings SET status='failed', error=?, failed_version=? WHERE id=? AND status='parsing'").run(error, PARSER_VERSION, id).changes) audit('system', 'parse_failed', 'drawings', id, { error });
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
  // the display file written with a summary is there, or the summary records why there is none
  const renderDone = (v, sha) => (v.render && v.render.ok === false) || fs.existsSync(renderFile(sha));
  // true when the stored summary was written by this parser version (never reuse another version's numbers) and is complete
  const summaryCurrent = async sha => { try { const v = await loadSummary(sha); return v.version === PARSER_VERSION && renderDone(v, sha); } catch (e) { return false; } };
  // parse the stored .dxf again (shared queue). A failure is recorded on the drawings that were 'ready', so later views
  // answer with it at once instead of queueing the same parse again.
  async function reparse(sha) {
    const r = await parseSha(sha);
    if (!r.ok) {
      const error = plain(r.error).slice(0, 500);
      // only a deterministic failure (the file itself cannot be parsed) is recorded; a timeout, out-of-memory, crash or
      // save error may pass on a later try, so the status stays as it is
      if (!r.transient) try {
        tx(() => {
          for (const d of db.prepare("SELECT id FROM drawings WHERE sha256=? AND status='ready'").all(sha))
            if (db.prepare("UPDATE drawings SET status='failed', error=?, failed_version=? WHERE id=? AND status='ready'").run(error, PARSER_VERSION, d.id).changes) audit('system', 'parse_failed', 'drawings', d.id, { error });
        });
      } catch (e) { console.error('drawings: could not record the failed re-parse of drawing file ' + sha, e); }
      bad('the drawing could not be read again: ' + error, 409);
    }
  }
  async function readSummary(sha) {
    if (summaries.has(sha)) { const v = summaries.get(sha); summaries.delete(sha); summaries.set(sha, v); return v; }
    const gone = () => bad('the parsed drawing is missing: upload the drawing again', 409);
    let v = null;
    try { v = await loadSummary(sha); } catch (e) { if (!fs.existsSync(dxfFile(sha))) gone(); }   // missing or unreadable summary: rebuild it when the .dxf is still there
    if (!v || v.version !== PARSER_VERSION || !renderDone(v, sha)) {   // missing, unreadable, another parser version, or no display file: parse the file again
      if (!fs.existsSync(dxfFile(sha))) bad('the parsed drawing is out of date: upload the drawing again', 409);
      await reparse(sha);
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
  // old: the drawing row this upload is a new version of (POST /drawings/:id/replace), null for a new drawing
  async function upload(req, res, url, t, me, old = null) {
    // every refusal here comes before the body is read; server.js closes the connection so the client stops sending
    need(me, 'admin', 'qs'); mustDraft(t);
    const name = String(url.searchParams.get('name') || '').trim();
    if (!name) bad('name is required');
    if (name.length > MAX_NAME) bad(`name must be at most ${MAX_NAME} characters`);
    if (Number(req.headers['content-length']) > MAX_BYTES) bad('the drawing is larger than 100 MB', 413);
    const named = NAME_EXT[(/\.([a-z]+)$/i.exec(name) || [])[1]?.toLowerCase()] || null;
    if ((named === 'png' || named === 'jpg') && Number(req.headers['content-length']) > MAX_IMAGE_BYTES) bad('the image is larger than 50 MB', 413);
    if (old && named) sameFamily(old, named);
    // a DXF, a PDF (status 'pages' until the browser registers them) or a PNG/JPEG image (one page, ready), by magic bytes
    const got = await receive(req, named);
    let used = false;
    try {
      // the tender can be deleted or change status while the body arrives
      const stillDraft = () => { const cur = tenderRow(t.id); if (!cur) bad('tender not found', 404); mustDraft(cur); };
      stillDraft();
      const kind = got.ext === 'dxf' ? 'dxf' : got.ext === 'pdf' ? 'pdf' : 'image';
      if (old) sameFamily(old, got.ext);
      // the same file already parsed (and not being parsed again) -> reuse its cache, ready at once
      const prev = kind === 'dxf' && !inflight.has(got.sha) && fs.existsSync(cacheFile(got.sha)) && await summaryCurrent(got.sha)
        ? db.prepare("SELECT suggested_units FROM drawings WHERE sha256=? AND status='ready' ORDER BY id DESC LIMIT 1").get(got.sha) : null;
      const status = kind === 'pdf' ? 'pages' : kind === 'image' || prev ? 'ready' : 'parsing';
      const img = kind === 'image' ? got.size : null;
      const id = tx(() => {
        stillDraft();
        const o = old ? replaceable(old.id) : null;   // still replaceable once the body is in (one pending replacement)
        const did = Number(db.prepare('INSERT INTO drawings(tender_id,kind,name,sha256,bytes,suggested_units,status,page,page_w,page_h,rotation,rev,pending,replaces_id,created,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(t.id, kind, name, got.sha, got.bytes, prev ? prev.suggested_units : null, status, img ? 1 : null, img ? img.width : null, img ? img.height : null, img ? 0 : null,
            o ? o.rev + 1 : 1, o ? 1 : 0, o ? o.id : null, new Date().toISOString(), me.username).lastInsertRowid);
        audit(me, 'upload', 'drawings', did, { name, bytes: got.bytes, sha256: got.sha, ...(kind !== 'dxf' ? { kind } : {}), ...(img ? { width: img.width, height: img.height } : {}), ...(o ? { replaces: o.id } : {}) });
        return did;
      });
      used = true;
      if (status === 'parsing') startParse(id, got.sha);
      return reply(res, 202, { id });
    } finally { release(got.sha, used, got.ext); }
  }

  // ---- a new version of a drawing (batch 4, spec 6.5): uploaded as a pending row, compared, then accepted or cancelled ----
  // a DXF is replaced by a DXF; a PDF or an image by a PDF or an image (ext: the stored file type)
  const sameFamily = (old, ext) => {
    if ((old.kind === 'dxf') !== (ext === 'dxf')) bad(old.kind === 'dxf' ? 'a new version of a DXF drawing must be a DXF file' : 'a new version of a PDF or an image must be a PDF or an image');
  };
  // the drawing row `id` can take a new version: not pending itself, a whole drawing (a PDF by its first page), not
  // replaced already, and no other replacement pending. Checked before the body is read and again in the upload's tx.
  function replaceable(id) {
    const o = drawingRow(id);
    if (!o) bad('drawing not found', 404);
    notPending(o);
    if (o.parent_id !== null) bad('replace the whole PDF: use its first page');
    if (o.replaced_by !== null) bad('this drawing has been replaced already: replace its newest version', 409);
    if (o.status !== 'ready') bad(`drawing is ${o.status}: a new version can be uploaded once it is ready`, 409);
    if (pendingFor(o)) bad('this drawing already has a pending replacement: accept or cancel it first', 409);
    return o;
  }

  // POST /drawings/:id/pages { pages: [{ page, width, height, rotation }] }: what pdf.js read in the browser (the server
  // cannot read a PDF, so it checks the values only). Once, on a PDF row in status 'pages': page 1 is this row, pages 2..n
  // new rows on the same file (parent_id = this row). All end 'ready'.
  async function registerPages(req, res, d, t, me) {
    need(me, 'admin', 'qs'); mustDraft(t);
    if (d.kind !== 'pdf') bad('pages apply to a PDF drawing');
    const b = await ctx.readBody(req);
    for (const k of Object.keys(b)) if (k !== 'pages') bad('unknown field: ' + k);
    if (!Array.isArray(b.pages) || b.pages.length < 1 || b.pages.length > MAX_PAGES) bad(`pages must be a list of 1 to ${MAX_PAGES} pages`);
    const n = b.pages.length, seen = new Set();
    const size = (p, k) => { if (!finNum(p[k]) || !(p[k] > 0) || p[k] > MAX_PAGE_PT) bad(`page ${k} must be a number > 0 and ≤ ${MAX_PAGE_PT} (points)`); return p[k]; };
    // R16: the page box origin (optional, 0 when absent): a finite number within ±1e7 points
    const origin = (p, k) => { if (p[k] === undefined) return 0; if (!finNum(p[k]) || Math.abs(p[k]) > MAX_PAGE_ORIGIN) bad(`page ${k} must be a number within ±${MAX_PAGE_ORIGIN} (points)`); return p[k]; };
    const pages = b.pages.map(p => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) bad('each page must be { page, width, height, rotation }');
      for (const k of Object.keys(p)) if (!['page', 'width', 'height', 'rotation', 'x0', 'y0'].includes(k)) bad('unknown field in a page: ' + k);
      if (!Number.isInteger(p.page)) bad('page must be a page number');
      if (p.page < 1 || p.page > n || seen.has(p.page)) bad(`pages 1 to ${n} must each be listed exactly once`);
      seen.add(p.page);
      if (![0, 90, 180, 270].includes(p.rotation)) bad('page rotation must be 0, 90, 180 or 270');
      return { page: p.page, width: size(p, 'width'), height: size(p, 'height'), rotation: p.rotation, x0: origin(p, 'x0'), y0: origin(p, 'y0') };
    }).sort((a, c) => a.page - c.page);
    const ids = tx(() => {
      mustDraft(tenderRow(t.id));
      const cur = drawingRow(d.id);
      if (!cur || cur.status !== 'pages') bad('the pages of this drawing are already registered', 409);
      const [p1] = pages, now = new Date().toISOString();
      db.prepare("UPDATE drawings SET status='ready', page=?, page_w=?, page_h=?, rotation=?, page_x0=?, page_y0=? WHERE id=? AND status='pages'").run(p1.page, p1.width, p1.height, p1.rotation, p1.x0, p1.y0, cur.id);
      const ins = db.prepare("INSERT INTO drawings(tender_id,kind,name,sha256,bytes,status,page,page_w,page_h,rotation,page_x0,page_y0,parent_id,rev,pending,replaces_id,created,created_by) VALUES(?,'pdf',?,?,?,'ready',?,?,?,?,?,?,?,?,?,?,?,?)");
      // a pending new version: its page n row is pending too and replaces the old drawing's page n row (none: NULL)
      const was = cur.pending && cur.replaces_id !== null ? drawingRow(cur.replaces_id) : null;
      const oldPage = n => !was ? null : was.page === n ? was.id : (db.prepare('SELECT id FROM drawings WHERE parent_id=? AND page=?').get(was.id, n) || { id: null }).id;
      const out = [cur.id];
      for (const p of pages.slice(1))
        out.push(Number(ins.run(cur.tender_id, pageName(cur.name, p.page), cur.sha256, cur.bytes, p.page, p.width, p.height, p.rotation, p.x0, p.y0, cur.id, cur.rev, cur.pending ? 1 : 0, oldPage(p.page), now, me.username).lastInsertRowid));
      audit(me, 'pages', 'drawings', cur.id, { pages: n });
      return out;
    });
    return reply(res, 200, { drawings: ids.map(drawingRow) });
  }

  // "<name> — p<n>" within MAX_NAME characters: the name is cut (never inside a surrogate pair), the suffix kept
  function pageName(name, n) {
    const suffix = ` — p${n}`;
    let base = name.slice(0, Math.max(0, MAX_NAME - suffix.length));
    if (base.length < name.length && /[\uD800-\uDBFF]$/.test(base)) base = base.slice(0, -1);
    return base + suffix;
  }

  // ---- calibration (PDF pages and images): page and regions, verify -------------------------------------------
  const calView = c => ({ id: c.id, drawing_id: c.drawing_id, region: c.region === null ? null : JSON.parse(c.region), p1: [c.p1x, c.p1y], p2: [c.p2x, c.p2y],
    real: c.real, unit: c.unit, scale: c.scale, verify_pct: c.verify_pct, copied_from: c.copied_from, created: c.created, created_by: c.created_by });
  // the page calibration first, then the regions by id
  const calibrationsOf = drawingId => db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY region IS NOT NULL, id').all(drawingId).map(calView);
  // how many measurements were computed with this calibration (they stop its deletion)
  const calibrationUsers = calId => db.prepare('SELECT COUNT(*) n FROM measurements WHERE calibration_id=?').get(calId).n;
  // The manual measurements of this drawing whose qty or calibration changes when `next` ({ region, scale }: the
  // calibration about to be stored) replaces `replaced` (the stored calibration row, or null when `next` is new), each
  // with the qty and base it would get: [{ measurement_id, row_id, old_qty, new_qty, base }]. Runs inside the tx.
  // - a count never (R14: it does not depend on scale and keeps calibration_id NULL);
  // - saved with the replaced calibration: listed when their qty changes;
  // - any other: listed when its first point would resolve to `next` (a new region over measurements that used the page
  //   calibration). The apply path sets calibration_id to the stored calibration's id for every one listed.
  function calibrationChanges(d, replaced, next) {
    const nextCal = { id: replaced ? replaced.id : Infinity, region: next.region, scale: next.scale };   // a new one: the highest id
    const cals = db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(d.id);
    const after = replaced ? cals.map(c => c.id === replaced.id ? nextCal : c) : [...cals, nextCal];
    const out = [];
    for (const m of db.prepare("SELECT * FROM measurements WHERE drawing_id=? AND (tool='manual' OR calibration_id IS NOT NULL) ORDER BY id").all(d.id)) {
      if (m.tool === 'manual' && m.metric === 'count') continue;
      const kept = replaced !== null && m.calibration_id === replaced.id;
      if (!kept) {
        let fp = null;
        try { fp = calib.checkPoint(manual.firstPoint(parseGeom(m.geom))); } catch (e) { /* unreadable: refused below */ }
        if (fp === null) cannotRescale(m);
        if (calib.calibrationFor(after, fp) !== nextCal) continue;
      }
      const q = manualRescale(m, nextCal);
      if (kept && q.qty === m.qty && q.base === m.base) continue;
      out.push({ measurement_id: m.id, row_id: m.row_id, old_qty: m.qty, new_qty: q.qty, base: q.base });
    }
    return out;
  }
  // a quantity that cannot be recomputed the same way: 409 for a calibration or unit change; in a replacement compare,
  // the one item is blocked cannot_recompute (rescale: true marks these errors)
  const rescaleFail = msg => { throw Object.assign(new Error(msg), { status: 409, rescale: true }); };
  const cannotRescale = m => rescaleFail(`measurement ${m.id} cannot be recomputed at the new scale (calibration or units)`);
  // { qty, base } of a stored manual measurement under the calibration `cal`: manualQty on its stored geometry with its
  // own width/depth/factor/deduct. The geometry was validated when it was saved, so it is not validated again (R13);
  // anything that cannot be recomputed exactly the same way stops the change (409).
  function manualRescale(m, cal) {
    const g = m.tool === 'manual' ? parseGeom(m.geom) : null;
    if (!g) cannotRescale(m);
    let q;
    try { q = manual.manualQty(g, manualOpts(g, m, cal.scale), true); } catch (e) { cannotRescale(m); }
    if (q.qty_unit !== m.qty_unit || !(Math.abs(q.qty) <= MAX_QTY)) cannotRescale(m);
    return { qty: q.qty, base: q.base };
  }
  const CAL_FIELDS = ['region', 'p1', 'p2', 'real', 'unit', 'apply', 'expect'];
  // R18: apply carries the change set the user reviewed, [{ measurement_id, new_qty }]; it is applied only when the server
  // finds exactly that set (the same ids, each new_qty equal within 1e-9 relative), so a measurement saved or changed by
  // someone else meanwhile is never rescaled unseen
  function cleanExpect(b, apply) {
    if (!apply) { if (b.expect !== undefined) bad('expect goes with apply: true'); return null; }
    if (!Array.isArray(b.expect)) bad('apply needs expect: the reviewed changes [{ measurement_id, new_qty }]');
    if (b.expect.length > 100000) bad('expect is too long');
    const out = new Map();
    for (const x of b.expect) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) bad('each expect entry must be { measurement_id, new_qty }');
      for (const k of Object.keys(x)) if (k !== 'measurement_id' && k !== 'new_qty') bad('unknown field in expect: ' + k);
      if (!Number.isInteger(x.measurement_id) || x.measurement_id <= 0) bad('expect measurement_id must be a measurement id');
      if (!finNum(x.new_qty)) bad('expect new_qty must be a number');
      if (out.has(x.measurement_id)) bad('duplicate measurement_id in expect');
      out.set(x.measurement_id, x.new_qty);
    }
    return out;
  }
  const sameQty = (a, b) => a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  const reviewed = (expect, changes) => changes.length === expect.size && changes.every(c => expect.has(c.measurement_id) && sameQty(expect.get(c.measurement_id), c.new_qty));
  // the calibration routes apply to a PDF page or an image (a DXF has confirmed units instead)
  const rasterOnly = d => { if (d.kind !== 'pdf' && d.kind !== 'image') bad('calibration applies to PDF and image drawings only'); };
  const calibOf = (d, cidStr) => {
    const cid = idOf(cidStr), c = cid === null ? null : db.prepare('SELECT * FROM calibrations WHERE id=? AND drawing_id=?').get(cid, d.id);
    if (!c) bad('calibration not found', 404);
    return c;
  };
  // R12/R16: a point of a PDF page (unrotated user space, points, absolute) or an image (pixels) lies within
  // [x0 − w, x0 + 2w] × [y0 − h, y0 + 2h] (x0/y0: the PDF page box origin, 0 for an image); anything further out was taken
  // in another coordinate space. named: [[name, [x, y]], …] (already finite).
  const inPage = (d, p) => {
    const w = d.page_w, h = d.page_h, x0 = d.page_x0 || 0, y0 = d.page_y0 || 0;
    return p[0] >= x0 - w && p[0] <= x0 + 2 * w && p[1] >= y0 - h && p[1] <= y0 + 2 * h;
  };
  const onPage = (d, named) => {
    if (d.kind !== 'pdf' && d.kind !== 'image') return;
    if (!(d.page_w > 0) || !(d.page_h > 0)) bad('the page size of this drawing is not known yet', 409);
    for (const [name, p] of named) if (!inPage(d, p)) bad(`${name} is outside the page (${d.page_w} × ${d.page_h}): points must lie within −1 to 2 page widths and heights`);
  };
  // a pure-function refusal (lib/takeoff/calib.js, lib/takeoff/manual.js) is a 400 with its message
  const calc = fn => { try { return fn(); } catch (e) { if (e.status) throw e; bad(e.message); } };

  async function calibrationApi(req, res, parts, d, t, me) {
    const method = req.method;
    if (parts.length === 3 && method === 'GET') {
      need(me, 'admin', 'qs', 'viewer'); rasterOnly(d);
      return reply(res, 200, { calibrations: calibrationsOf(d.id) });
    }
    if (parts.length === 3 && method === 'POST') return calibrate(req, res, d, t, me);
    if (parts.length === 5 && parts[4] === 'verify' && method === 'POST') {
      need(me, 'admin', 'qs'); mustDraft(t); rasterOnly(d); canMeasure(d);
      const c = calibOf(d, parts[3]), b = await ctx.readBody(req);
      for (const k of Object.keys(b)) if (!['p1', 'p2', 'real', 'unit'].includes(k)) bad('unknown field: ' + k);
      const pct = calc(() => calib.verifyPct(c, b.p1, b.p2, b.real, b.unit)), warning = Math.abs(pct) > 1;
      onPage(d, [['p1', b.p1], ['p2', b.p2]]);
      tx(() => {
        mustDraft(tenderRow(t.id)); canMeasure(drawingRow(d.id));
        // the line checks this calibration only where it applies: both points resolve to it (the page outside every
        // region, a region inside it), as a measurement's first point would
        const cals = db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(d.id), at = p => calib.calibrationFor(cals, p);
        if (![at(b.p1), at(b.p2)].every(x => x && x.id === c.id)) bad('both verify points must lie where this calibration applies (inside its region, or for the page outside every region)');
        if (!db.prepare('UPDATE calibrations SET verify_pct=?, copied_from=NULL WHERE id=? AND scale=?').run(pct, c.id, c.scale).changes) bad('the calibration changed: verify again', 409);
        audit(me, 'calibration_verify', 'calibrations', c.id, { drawing_id: d.id, calibration_id: c.id, pct, warning });
      });
      return reply(res, 200, { pct, warning });
    }
    if (parts.length === 4 && method === 'DELETE') {
      need(me, 'admin', 'qs'); mustDraft(t); rasterOnly(d); canMeasure(d);
      const c = calibOf(d, parts[3]);
      tx(() => {
        mustDraft(tenderRow(t.id)); canMeasure(drawingRow(d.id));
        const cur = db.prepare('SELECT * FROM calibrations WHERE id=?').get(c.id);
        if (!cur) bad('calibration not found', 404);
        const n = calibrationUsers(cur.id);
        if (n) bad(`measurements use this calibration (${n}): delete them first`, 409);
        db.prepare('DELETE FROM calibrations WHERE id=?').run(cur.id);
        audit(me, 'calibration_delete', 'calibrations', cur.id, { drawing_id: d.id, region: cur.region !== null, scale: cur.scale, real: cur.real, unit: cur.unit });
      });
      return reply(res, 200, { ok: 1 });
    }
    return false;
  }

  // POST /drawings/:id/calibrations { region?, p1, p2, real, unit, apply? }: the page calibration (created or replaced)
  // or a region's (the same rectangle again replaces it; another rectangle must not overlap any region). Measurements
  // whose qty would change: 409 with the before/after list, applied only with apply: true (one tx, rows recomputed).
  async function calibrate(req, res, d, t, me) {
    need(me, 'admin', 'qs'); mustDraft(t); rasterOnly(d);
    if (d.status !== 'ready') bad('register the pages of this PDF first', 409);
    canMeasure(d);
    const b = await ctx.readBody(req);
    for (const k of Object.keys(b)) if (!CAL_FIELDS.includes(k)) bad('unknown field: ' + k);
    const apply = optBool(b, 'apply'), expect = cleanExpect(b, apply);
    const region = b.region === undefined || b.region === null ? null : calc(() => calib.normRect(b.region));
    const scale = calc(() => calib.scaleOf(b.p1, b.p2, b.real, b.unit));
    if (!(scale > 0) || !Number.isFinite(scale)) bad('the calibration gives no usable scale');
    // a region is calibrated by a known length inside it (edges included)
    if (region !== null && ![b.p1, b.p2].every(p => p[0] >= region[0] && p[0] <= region[2] && p[1] >= region[1] && p[1] <= region[3])) bad('the calibration points must lie inside the region');
    onPage(d, [['p1', b.p1], ['p2', b.p2], ...(region === null ? [] : [['region', [region[0], region[1]]], ['region', [region[2], region[3]]]])]);
    const regionText = region === null ? null : JSON.stringify(region);
    const out = tx(() => {
      mustDraft(tenderRow(t.id));
      const cur = drawingRow(d.id);
      if (!cur || cur.status !== 'ready') bad('the drawing changed: try again', 409);
      canMeasure(cur);
      let replaced;
      if (region === null) replaced = db.prepare('SELECT * FROM calibrations WHERE drawing_id=? AND region IS NULL').get(d.id) || null;
      else {
        replaced = null;
        for (const c of db.prepare('SELECT * FROM calibrations WHERE drawing_id=? AND region IS NOT NULL ORDER BY id').all(d.id)) {
          const r = calib.normRect(JSON.parse(c.region));
          if (r.every((v, i) => v === region[i])) replaced = c;
          else if (calib.rectsOverlap(r, region)) bad('the region overlaps another calibrated region', 409);
        }
      }
      const changes = calibrationChanges(d, replaced, { region, scale });
      const listed = () => changes.map(({ measurement_id, row_id, old_qty, new_qty }) => ({ measurement_id, row_id, old_qty, new_qty }));
      if (changes.length && !apply) conflictBody({ error: 'calibration changes measured quantities', changes: listed() });
      if (apply && !reviewed(expect, changes)) conflictBody({ error: 'the measured quantities changed: review the changes again', changes: listed() });
      const now = new Date().toISOString(), [p1x, p1y] = b.p1, [p2x, p2y] = b.p2;
      let id;
      if (replaced) {
        db.prepare('UPDATE calibrations SET p1x=?, p1y=?, p2x=?, p2y=?, real=?, unit=?, scale=?, verify_pct=NULL, copied_from=NULL, created=?, created_by=? WHERE id=?')
          .run(p1x, p1y, p2x, p2y, b.real, b.unit, scale, now, me.username, replaced.id);
        id = replaced.id;
      } else {
        id = Number(db.prepare('INSERT INTO calibrations(drawing_id,region,p1x,p1y,p2x,p2y,real,unit,scale,created,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(d.id, regionText, p1x, p1y, p2x, p2y, b.real, b.unit, scale, now, me.username).lastInsertRowid);
      }
      const upd = db.prepare('UPDATE measurements SET qty=?, base=?, calibration_id=? WHERE id=?');
      for (const c of changes) upd.run(c.new_qty, c.base, id, c.measurement_id);
      const rows = [...new Set(changes.map(c => c.row_id).filter(r => r !== null))];
      for (const r of rows) recompute(r);
      audit(me, 'calibrate', 'calibrations', id, { drawing_id: d.id, region: region !== null, scale, real: b.real, unit: b.unit, replaced: !!replaced, changed: changes.length, rows: rows.length });
      return { calibration: calView(db.prepare('SELECT * FROM calibrations WHERE id=?').get(id)), replaced: !!replaced,
        changes: changes.map(({ measurement_id, row_id, old_qty, new_qty }) => ({ measurement_id, row_id, old_qty, new_qty })) };
    });
    return reply(res, 200, out);
  }

  // ---- DXF units (spec 6.6): set before measuring; changed after measuring only through before/after (R18) --------
  // Every non-count measurement of the drawing with the qty and base it gets under the units `to`, recomputed by the code
  // that created it: a layer metric from the scaled layer table (scaledTable), a selection by totalling its stored handles
  // again (select worker, selectionBase), both through dxfQty; a manual shape through manualRescale (manualQty). So a
  // length moves by k, an area by k², and width/depth (metres) never scale. Counts (dxf_blocks, count selections and
  // manual counts) do not depend on the units and are never listed. Anything that cannot be recomputed the same way → 409.
  // Async (summary, workers): runs outside the tx; the caller checks inside its tx that nothing changed meanwhile.
  async function unitChanges(d, to) {
    const f = UNIT_TO_M[to], out = [];
    let lt = null;
    for (const m of db.prepare("SELECT * FROM measurements WHERE drawing_id=? AND (metric IS NULL OR metric<>'count') ORDER BY id").all(d.id)) {
      let q;
      if (m.tool === 'manual') q = manualRescale(m, { scale: f });
      else if (m.tool === 'dxf_layer') {
        if (!lt) lt = scaledTable((await readSummary(d.sha256)).raw, to);
        const l = lt.layers.find(x => x.layer === m.layer);
        q = dxfRescale(m, l ? l[m.metric] : null);
      } else if (m.tool === 'dxf_selection') {
        const handles = db.prepare('SELECT handle FROM measurement_handles WHERE measurement_id=? ORDER BY rowid').all(m.id).map(x => x.handle);
        const sel = await totalSelection(d.sha256, handles, m.metric, !!m.nested);
        if (sel.unknown || sel.used !== m.handles_count) cannotRescale(m);
        q = dxfRescale(m, selectionBase(sel.base, m.metric, f));
      } else cannotRescale(m);
      out.push({ measurement_id: m.id, row_id: m.row_id, old_qty: m.qty, new_qty: q.qty, base: q.base });
    }
    return out;
  }
  function dxfRescale(m, base) {
    if (!finNum(base) || !(base > 0)) cannotRescale(m);
    const qty = dxfQty(base, m);
    if (!Number.isFinite(qty) || qty > MAX_QTY) rescaleFail(`measurement ${m.id}: the quantity ${qty} would be out of range: it must be at most ${MAX_QTY}`);
    return { qty, base };
  }
  // what unitChanges read: a measurement saved, edited or deleted meanwhile changes it
  const unitInputs = did => JSON.stringify(db.prepare('SELECT * FROM measurements WHERE drawing_id=? ORDER BY id').all(did));

  // PUT /drawings/:id/units { units, apply?, expect? }. No measurement listed (none yet, counts only, the same units): set.
  // Otherwise 409 with the before/after list; apply: true with the reviewed list (R18) stores the units, the listed
  // quantities and the rows' totals in one tx (an imported row keeps its client qty; its measured total is checked).
  async function setUnits(req, res, d, t, me) {
    const b = await ctx.readBody(req);
    for (const k of Object.keys(b)) if (!['units', 'apply', 'expect'].includes(k)) bad('unknown field: ' + k);
    if (!hasUnit(b.units)) bad('units must be one of ' + Object.keys(UNIT_TO_M).join(', '));
    const apply = optBool(b, 'apply'), expect = cleanExpect(b, apply);
    const listed = changes => changes.map(({ measurement_id, row_id, old_qty, new_qty }) => ({ measurement_id, row_id, old_qty, new_qty }));
    // the recomputation is async: if a measurement or the drawing changed before the tx, it is done again
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = drawingRow(d.id);
      if (!before) bad('drawing not found', 404);
      if (before.status !== 'ready') bad(`drawing is ${before.status}: units can be set once it is ready`, 409);
      const seen = unitInputs(d.id);
      const changes = before.units === b.units ? [] : await unitChanges(before, b.units);
      if (hooks.beforeUnitTx) await hooks.beforeUnitTx(attempt);
      const out = tx(() => {
        mustDraft(tenderRow(t.id));
        const cur = drawingRow(d.id);
        if (!cur || cur.status !== 'ready') bad(`drawing is ${cur ? cur.status : 'gone'}: units can be set once it is ready`, 409);
        notReplacing(cur); notReplaced(cur);   // the pending one itself takes its units (needed for the compare)
        if (cur.units !== before.units || cur.sha256 !== before.sha256 || unitInputs(d.id) !== seen) return null;
        const body = error => ({ error, from: cur.units, to: b.units, changes: listed(changes) });
        if (changes.length && !apply) conflictBody(body('unit change changes measured quantities'));
        if (apply && !reviewed(expect, changes)) conflictBody(body('the measured quantities changed: review the changes again'));
        if (cur.units === b.units) return { ...cur, changes: [] };   // the same units: nothing to store or audit
        db.prepare('UPDATE drawings SET units=? WHERE id=?').run(b.units, d.id);
        const upd = db.prepare('UPDATE measurements SET qty=?, base=? WHERE id=?');
        for (const c of changes) upd.run(c.new_qty, c.base, c.measurement_id);
        const rows = [...new Set(changes.map(c => c.row_id).filter(r => r !== null))];
        for (const r of rows) recompute(r);
        audit(me, 'units', 'drawings', d.id, { from: cur.units, to: b.units, ...(changes.length ? { changed: changes.length, rows: rows.length } : {}) });
        return { ...drawingRow(d.id), changes: listed(changes) };
      });
      if (out) return reply(res, 200, out);
    }
    bad('the drawing kept changing while its quantities were recomputed: try again', 409);
  }

  // ---- GET /drawings/:newId/compare (spec 6.5): every measurement of the old drawing against the pending new version, read
  // only. Each new qty is computed by the code that created the measurement: a layer metric or block count from the new
  // drawing's scaled layer table, a selection by totalling its handles on the new cache (select worker, selectionBase),
  // all through dxfQty (dxfRescale); a manual shape by manualQty on its stored geometry (manualRescale) with the new
  // drawing's units (DXF) or the calibration it was saved with, copied to the same page at accept (PDF/image).
  // The creation gates are evaluated on the new drawing by the create code (layerGates, selectionGates): one that fires
  // and was never confirmed blocks the item (confirm_needed, R7). A manual shape on a PDF page or an image must lie on
  // the new page (onPage's bounds, R12/R16), else off_page (R9). A qty that cannot be recomputed blocks its item only
  // (cannot_recompute, R9). What matches and the status, reason and options come from lib/takeoff/compare.js.
  // R11: the gate counts of a layer or block measurement (from layerGates) and of a selection (selectionGates on its worker
  // totals), the same on the old and the new drawing; a gate fires when its count is > 0
  const NO_GATES = { incomplete: 0, duplicate: 0, mixed_blocks: 0 };
  const layerCounts = g => ({ incomplete: g.incomplete ? g.incomplete.area_excluded + g.incomplete.approx + g.incomplete.dropped : 0, duplicate: g.duplicates, mixed_blocks: 0 });
  const selCounts = (sel, g) => ({ incomplete: sel.dropped + sel.area_null + sel.approx, duplicate: g.duplicates, mixed_blocks: g.mixed ? Object.keys(g.mixed).length : 0 });
  // a matched DXF item (q: its new { qty, base, handles_count? }): its new qty, or blocked confirm_needed when a gate fires
  // now that it never confirmed (R7) or whose count grew since the old drawing (R11: now / was are gate counts), with both
  const gated = (m, now, was, q) => {
    const gates = compare.gatesToConfirm(now, m, was), out = { new_qty: q.qty, base: q.base, handles_count: q.handles_count };
    return gates.length ? { reason: 'confirm_needed', gates, gate_counts: Object.fromEntries(gates.map(g => [g, { old: was[g], new: now[g] }])), ...out } : out;
  };
  const pendingTop = d => { if (!d.pending || d.parent_id !== null || d.replaces_id === null) bad('this drawing is not a pending replacement', 409); };
  // { body: the compare table, plan: measurement id → { m: its row, x: what compare.item was built from (with the new
  // base; keep: the matched subset's totals) }, old, lt: the new layer table (DXF), newPages: page → row (PDF/image) }
  async function compareFull(nd) {
    const old = drawingRow(nd.replaces_id);
    if (!old) bad('the drawing this version replaces is missing', 409);
    let lt = null, newPages = null;
    const items = [], plan = new Map();
    const result = (ready, its, extra = {}) => ({ body: { ready, ...extra, items: its, totals: { rows: compare.rowTotals(its) } }, plan, old, lt, newPages });
    // one item: r() gives its compare.item input; a rescale failure blocks this item only
    const add = async (m, r) => {
      let x;
      try { x = await r(); } catch (e) { if (!e.rescale) throw e; x = { reason: 'cannot_recompute' }; }
      items.push(compare.item(m, x));
      plan.set(m.id, { m, x });
    };
    if (nd.kind === 'dxf') {
      // the units are pre-filled from the old drawing's (old_units); the user confirms them on the new one
      const units = { needs_units: nd.units === null, old_units: old.units };
      if (nd.status === 'failed') bad('the new version could not be read: ' + nd.error, 409);
      if (nd.status !== 'ready') return result(false, [], units);
      if (nd.units === null) return result(true, [], units);
      const f = UNIT_TO_M[nd.units];
      let olt = null;
      const newTable = async () => lt || (lt = scaledTable((await readSummary(nd.sha256)).raw, nd.units));
      const oldTable = async () => olt || (olt = scaledTable((await readSummary(old.sha256)).raw, old.units));
      for (const m of db.prepare('SELECT * FROM measurements WHERE drawing_id=? ORDER BY id').all(old.id)) {
        await add(m, async () => {
          if (m.tool === 'manual') {
            const q = m.metric === 'count' ? { qty: m.qty, base: m.base } : manualRescale(m, { scale: f });
            return { review: true, new_qty: q.qty, base: q.base };
          }
          if (m.tool === 'dxf_layer' || m.tool === 'dxf_blocks') {
            const t = await newTable(), x = (m.tool === 'dxf_layer' ? compare.layerMatch : compare.blockMatch)(t.layers, m);
            if (x.base === undefined) return x;
            const ot = await oldTable(), ol = ot.layers.find(l => l.layer === m.layer), nl = t.layers.find(l => l.layer === m.layer);
            // handles_count as the create path stores it: the layer's entities, or the block count
            return gated(m, layerCounts(layerGates(t, nl, m)), ol ? layerCounts(layerGates(ot, ol, m)) : NO_GATES,
              { ...dxfRescale(m, x.base), handles_count: m.tool === 'dxf_layer' ? nl.entities : x.base });
          }
          if (m.tool === 'dxf_selection') return compareSelection(m, old, nd, f);
          return cannotRescale(m);
        });
      }
      return result(true, items, { needs_units: false });
    }
    // PDF / image: page n of the old file is page n of the new one
    if (nd.status !== 'ready') return result(false, [], { needs_units: false, new_pages: [] });
    newPages = new Map(db.prepare('SELECT * FROM drawings WHERE id=? OR parent_id=? ORDER BY page').all(nd.id, nd.id).map(x => [x.page, x]));
    const oldPages = new Set(db.prepare('SELECT page FROM drawings WHERE id=? OR parent_id=?').all(old.id, old.id).map(x => x.page));
    for (const m of db.prepare(`SELECT m.*, d.page AS on_page FROM measurements m JOIN drawings d ON d.id=m.drawing_id
      WHERE d.id=? OR d.parent_id=? ORDER BY m.id`).all(old.id, old.id)) {
      await add(m, () => {
        const page = newPages.get(m.on_page);
        if (!page) return { reason: 'page_missing' };
        const g = parseGeom(m.geom);
        let pts = null;
        try { pts = manual.points(g); } catch (e) { /* unreadable: below */ }
        if (!pts) return cannotRescale(m);
        if (!(page.page_w > 0) || !(page.page_h > 0) || !pts.every(p => inPage(page, p))) return { reason: 'off_page' };
        let q = { qty: m.qty, base: m.base };
        if (m.metric !== 'count') {
          const c = m.calibration_id === null ? null : db.prepare('SELECT scale FROM calibrations WHERE id=? AND drawing_id=?').get(m.calibration_id, m.drawing_id);
          if (!c) cannotRescale(m);
          q = manualRescale(m, c);
        }
        return { review: true, new_qty: q.qty, base: q.base };
      });
    }
    // R10: pages of the new file with no old counterpart (information only)
    return result(true, items, { needs_units: false, new_pages: [...newPages.keys()].filter(p => !oldPages.has(p)) });
  }
  // a selection on the new drawing: each stored handle must be there with its stored geomKey (compare.selectionMatch).
  // All matched (and the same number of entities used) → its total on the new cache, gated like a new selection
  // (selectionGates: incomplete, duplicates within it, mixed blocks); otherwise blocked, with the qty of the handles that
  // still match (keep_matched_qty, null when none; keep: its totals, which accept stores and gates when it is kept). A
  // stored row without a geomKey (saved before batch 2) takes its key from the old drawing's cache when that cache gives
  // the stored selection back exactly; otherwise it never matches. The same old totals give the gate counts on the old
  // drawing (R11; when the old cache cannot vouch for the selection, every gate that fires counts as grown). Nothing is
  // written.
  async function compareSelection(m, old, nd, f) {
    const stored = db.prepare('SELECT handle, geom_key FROM measurement_handles WHERE measurement_id=? ORDER BY rowid').all(m.id).map(h => ({ ...h }));
    const handles = stored.map(h => h.handle), total = hs => totalSelection(nd.sha256, hs, m.metric, !!m.nested);
    const oldTotal = async () => {
      let o = null;
      try { o = await totalSelection(old.sha256, handles, m.metric, !!m.nested); } catch (e) { if (!e.status) throw e; }
      return o && !o.unknown && o.used === m.handles_count ? o : null;
    };
    const legacy = stored.some(h => h.geom_key === null);
    let o = legacy ? await oldTotal() : null;
    if (o) {
      const k = new Map(o.used_handles.map((h, i) => [h, o.used_keys[i]]));
      for (const h of stored) if (h.geom_key === null && k.has(h.handle)) h.geom_key = k.get(h.handle);
    }
    const sel = await total(handles);
    const x = compare.selectionMatch(stored, new Map(sel.used_handles.map((h, i) => [h, sel.used_keys[i]])), sel.unknown);
    if (x.all && sel.used === m.handles_count) {
      if (!legacy) o = await oldTotal();
      // duplicates with other selections on the row (crossDuplicates) are by geomKey: unchanged when every key matches
      return gated(m, selCounts(sel, selectionGates(sel)), o ? selCounts(o, selectionGates(o)) : NO_GATES, dxfRescale(m, selectionBase(sel.base, m.metric, f)));
    }
    let keep = null;
    if (x.matched.length) {
      const k = await total(x.matched);
      if (k.used) keep = { total: k, ...dxfRescale(m, selectionBase(k.base, m.metric, f)) };
    }
    return { reason: x.reason || 'geometry_changed', keep_matched_qty: keep ? keep.qty : null, keep };
  }

  // ---- POST /drawings/:newId/accept { expect } (spec 6.5, Task 3): the reviewed table is applied in one tx (R18) ---------
  // expect lists every item of the compare table once: { measurement_id, new_qty, resolution?, to?, confirm? }.
  // - new_qty: the qty the measurement has after accept (null for delete; null for relink / keep_matched while that qty
  //   is not known yet: the 409 lists it in `resolved`).
  // - resolution, only on a blocked item and one of its options: delete | relink (to: one of its relink_choices, R12) |
  //   keep_matched | confirm (confirms the item's gates).
  // - confirm, with relink / keep_matched only: the checks that fire on the new content (incomplete, duplicate,
  //   mixed_blocks, overlap with the other measurements of the row; R7), e.g. { resolution: 'relink', to: 'PAVING',
  //   new_qty: 25, confirm: ['overlap'] }. The 409 lists the ones each resolution needs (resolved[].gates).
  // 400: a malformed body, a blocked item without a resolution, a resolution the item does not offer. 409 with the fresh
  // table: another id set or qty (R18), unconfirmed checks, or the drawings changed while the comparison ran.
  const RESOLUTIONS = ['delete', 'relink', 'keep_matched', 'confirm'], CHECKS = ['incomplete', 'duplicate', 'mixed_blocks', 'overlap'];
  const REVIEW_AGAIN = 'the measured quantities changed: review the changes again';
  // R14: a relink / keep_matched sent with new_qty null (its qty not known yet) is a probe, answered by a 409 of its own:
  // `resolved` gives each resolution's qty and checks, which the user sees and then accepts with a second click
  const PREVIEW = 'check what the chosen resolutions give, then accept again';
  const isProbe = e => e.new_qty === null && (e.resolution === 'relink' || e.resolution === 'keep_matched');
  function cleanAccept(b) {
    for (const k of Object.keys(b)) if (k !== 'expect') bad('unknown field: ' + k);
    if (!Array.isArray(b.expect)) bad('accept needs expect: the reviewed table [{ measurement_id, new_qty, resolution?, to?, confirm? }]');
    if (b.expect.length > 100000) bad('expect is too long');
    const out = new Map();
    for (const x of b.expect) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) bad('each expect entry must be { measurement_id, new_qty, resolution?, to?, confirm? }');
      for (const k of Object.keys(x)) if (!['measurement_id', 'new_qty', 'resolution', 'to', 'confirm'].includes(k)) bad('unknown field in expect: ' + k);
      if (!Number.isInteger(x.measurement_id) || x.measurement_id <= 0) bad('expect measurement_id must be a measurement id');
      if (x.new_qty !== null && !finNum(x.new_qty)) bad('expect new_qty must be a number (null: deleted, or not known yet)');
      if (x.resolution !== undefined && !RESOLUTIONS.includes(x.resolution)) bad('resolution must be one of ' + RESOLUTIONS.join(', '));
      if (x.to !== undefined && typeof x.to !== 'string' && !(x.to && typeof x.to === 'object' && !Array.isArray(x.to))) bad('to must be a layer name or { layer, block }');
      if (x.confirm !== undefined && (!Array.isArray(x.confirm) || x.confirm.some(g => !CHECKS.includes(g)) || new Set(x.confirm).size !== x.confirm.length))
        bad('confirm must be a list of distinct checks: ' + CHECKS.join(', '));
      if (out.has(x.measurement_id)) bad('duplicate measurement_id in expect');
      out.set(x.measurement_id, x);
    }
    return out;
  }
  // what the comparison read (both drawings and their page rows, the old drawing's measurements, handles and
  // calibrations): anything changed before the tx → the comparison is stale
  const acceptInputs = (newId, oldId) => JSON.stringify([
    db.prepare('SELECT * FROM drawings WHERE id IN (?, ?) OR parent_id IN (?, ?) ORDER BY id').all(newId, oldId, newId, oldId),
    db.prepare('SELECT m.* FROM measurements m JOIN drawings d ON d.id=m.drawing_id WHERE d.id=? OR d.parent_id=? ORDER BY m.id').all(oldId, oldId),
    db.prepare(`SELECT h.measurement_id, h.handle, h.geom_key FROM measurement_handles h JOIN measurements m ON m.id=h.measurement_id JOIN drawings d ON d.id=m.drawing_id
      WHERE d.id=? OR d.parent_id=? ORDER BY h.rowid`).all(oldId, oldId),
    db.prepare('SELECT c.* FROM calibrations c JOIN drawings d ON d.id=c.drawing_id WHERE d.id=? OR d.parent_id=? ORDER BY c.id').all(oldId, oldId)]);
  async function acceptReplacement(req, res, d, t, me) {
    need(me, 'admin', 'qs'); mustDraft(t); pendingTop(d);
    const expect = cleanAccept(await ctx.readBody(req));
    const seen = acceptInputs(d.id, d.replaces_id);
    const nd = drawingRow(d.id);
    if (!nd) bad('drawing not found', 404);
    pendingTop(nd);
    const full = await compareFull(nd);   // async (summaries, workers): checked against `seen` inside the tx
    if (hooks.beforeAcceptTx) await hooks.beforeAcceptTx();
    const out = tx(() => {
      mustDraft(tenderRow(t.id));
      const cur = drawingRow(d.id);
      if (!cur) bad('drawing not found', 404);
      pendingTop(cur);
      if (acceptInputs(d.id, d.replaces_id) !== seen) return null;
      return applyAccept(cur, full, expect, t, me);
    });
    if (out) return reply(res, 200, out);
    const cur = drawingRow(d.id);
    if (!cur) bad('drawing not found', 404);
    pendingTop(cur);
    conflictBody({ error: 'the drawings changed while the replacement was compared: review the changes again', ...(await compareFull(cur)).body });
  }
  // inside the tx, with the comparison `full` still current
  function applyAccept(nd, full, expect, t, me) {
    const { body, plan, old, lt, newPages } = full, items = body.items;
    if (!body.ready) conflictBody({ error: 'the new version is not ready yet: accept it once it is', ...body });
    if (body.needs_units) conflictBody({ error: 'confirm the units of the new version first', ...body });
    if (items.length !== expect.size || items.some(it => !expect.has(it.measurement_id))) conflictBody({ error: REVIEW_AGAIN, ...body });
    const missing = items.filter(it => it.status === 'blocked' && expect.get(it.measurement_id).resolution === undefined).map(it => it.measurement_id);
    if (missing.length) failBody(400, { error: 'blocked items need a resolution: ' + missing.join(', '), ids: missing, ...body });
    for (const it of items) {
      const why = compare.resolutionError(it, expect.get(it.measurement_id));
      if (why) failBody(400, { error: `measurement ${it.measurement_id}: ${why}`, ...body });
    }
    // PDF/image: the old pages' calibrations are copied to the page of the same number (to be verified there again;
    // copied_from: the source, R15)
    const cmap = new Map();
    if (nd.kind !== 'dxf') {
      const insC = db.prepare('INSERT INTO calibrations(drawing_id,region,p1x,p1y,p2x,p2y,real,unit,scale,verify_pct,copied_from,created,created_by) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?)');
      for (const c of db.prepare('SELECT c.*, d.page AS on_page FROM calibrations c JOIN drawings d ON d.id=c.drawing_id WHERE d.id=? OR d.parent_id=? ORDER BY c.id').all(old.id, old.id)) {
        const np = newPages.get(c.on_page);
        if (np) cmap.set(c.id, Number(insC.run(np.id, c.region, c.p1x, c.p1y, c.p2x, c.p2y, c.real, c.unit, c.scale, c.id, c.created, c.created_by).lastInsertRowid));
      }
    }
    const set = (id, f) => { const ks = Object.keys(f); db.prepare(`UPDATE measurements SET ${ks.map(k => k + '=?').join(', ')} WHERE id=?`).run(...ks.map(k => f[k]), id); };
    const counts = { kept: 0, deleted: 0, relinked: 0, kept_matched: 0, confirmed: 0, review: 0 };
    const rows = [], resolved = [], checked = [], qtyOf = new Map();
    // 1. every measurement: deleted, or moved to the new drawing (its page) with its new content
    for (const it of items) {
      const e = expect.get(it.measurement_id), { m, x } = plan.get(it.measurement_id);
      if (m.row_id !== null && !rows.includes(m.row_id)) rows.push(m.row_id);
      if (e.resolution === 'delete') {
        db.prepare('DELETE FROM measurement_handles WHERE measurement_id=?').run(m.id);
        db.prepare('DELETE FROM measurements WHERE id=?').run(m.id);
        counts.deleted++;
        resolved.push({ measurement_id: m.id, resolution: 'delete', new_qty: null, gates: [] });
        continue;
      }
      counts.kept++;
      const page = nd.kind === 'dxf' ? nd : newPages.get(m.on_page);
      if (!page) bad(`measurement ${m.id}: its page is not in the new version`, 409);   // page_missing: delete only
      if (m.calibration_id !== null && !cmap.has(m.calibration_id)) bad(`measurement ${m.id}: its calibration is not on its page`, 409);
      const moved = { drawing_id: page.id, calibration_id: m.calibration_id === null ? null : cmap.get(m.calibration_id) };
      if (m.tool === 'manual') { moved.review_needed = 1; counts.review++; }
      let qty;
      if (e.resolution === 'relink') {
        const r = relinkTo(m, e.to, lt);
        set(m.id, { ...moved, ...r.set });
        checked.push({ e, mv: { ...m, ...r.set }, fired: r.fired });
        qty = r.set.qty; counts.relinked++;
      } else if (e.resolution === 'keep_matched') {
        const k = x.keep, sel = k.total, g = selectionGates(sel);
        const summary = JSON.stringify({ metric: m.metric, by_layer: sel.by_layer, skipped: sel.skipped, ...(m.metric === 'count' ? { nested: !!m.nested, blocks: sel.blocks } : {}) });
        set(m.id, { ...moved, qty: k.qty, base: k.base, handles_count: sel.used, selection_summary: summary });
        db.prepare('DELETE FROM measurement_handles WHERE measurement_id=?').run(m.id);
        const insH = db.prepare('INSERT INTO measurement_handles(measurement_id, handle, geom_key) VALUES(?,?,?)');
        for (let i = 0; i < sel.used_handles.length; i++) insH.run(m.id, sel.used_handles[i], sel.used_keys[i]);
        const sv = { handles: new Set(sel.used_handles), keys: new Set(sel.used_keys), layers: new Set(Object.keys(sel.by_layer)), pairs: new Set(g.counted.map(c => c.layer + '\0' + c.block)) };
        checked.push({ e, mv: { ...m, sel: sv }, fired: [...(g.incomplete ? ['incomplete'] : []), ...(g.duplicates > 0 ? ['duplicate'] : []), ...(g.mixed ? ['mixed_blocks'] : [])] });
        qty = k.qty; counts.kept_matched++;
      } else {
        // same / changed / review, or confirm: the compared qty; a confirmation records its gates on the measurement
        const conf = e.resolution === 'confirm' ? Object.fromEntries(it.gates.map(g => [g === 'mixed_blocks' ? 'mixed' : g, 1])) : {};
        set(m.id, { ...moved, qty: x.new_qty, base: x.base, ...(x.handles_count !== undefined ? { handles_count: x.handles_count } : {}), ...conf });
        qty = x.new_qty;
        if (e.resolution === 'confirm') { counts.confirmed++; resolved.push({ measurement_id: m.id, resolution: 'confirm', new_qty: qty, gates: it.gates }); }
      }
      qtyOf.set(m.id, qty);
    }
    // 2. relink / keep_matched: the checks on the new content, against the row as it is now (R7): overlap with the other
    // measurements of the row (and, for a selection, exact copies held by other selections); the flags record them
    for (const gt of checked) {
      const mv = gt.mv, fired = new Set(gt.fired);
      if (mv.row_id !== null) {
        if (overlapCount(mv, nd.sha256, t.id, mv.id)) fired.add('overlap');
        if (mv.tool === 'dxf_selection' && crossDuplicates(mv, nd.sha256, t.id, mv.id)) fired.add('duplicate');
      }
      gt.gates = CHECKS.filter(g => fired.has(g));
      set(mv.id, { incomplete: fired.has('incomplete') ? 1 : 0, duplicate: fired.has('duplicate') ? 1 : 0, ...(mv.tool === 'dxf_selection' ? { mixed: fired.has('mixed_blocks') ? 1 : 0 } : {}) });
    }
    for (const gt of checked) resolved.push({ measurement_id: gt.mv.id, resolution: gt.e.resolution, ...(gt.e.to !== undefined ? { to: gt.e.to } : {}), new_qty: qtyOf.get(gt.mv.id), gates: gt.gates });
    const order = new Map(items.map((it, i) => [it.measurement_id, i]));
    resolved.sort((a, b) => order.get(a.measurement_id) - order.get(b.measurement_id));
    // 3. R18: every qty as reviewed, every check of a resolution confirmed (else 409: the tx rolls back)
    // a table where only probes differ is a preview (R14); any other difference is a stale table
    const differ = items.map(it => expect.get(it.measurement_id)).filter(e => e.resolution !== 'delete' && (e.new_qty === null || !sameQty(e.new_qty, qtyOf.get(e.measurement_id))));
    // R18b: a preview also gives the row totals the chosen resolutions make (rowTotals with the resolved qtys, delete = 0)
    const resolvedTotals = () => ({ rows: compare.rowTotals(items.map(it => {
      const e = expect.get(it.measurement_id);
      return it.status !== 'blocked' ? it : { ...it, status: 'resolved', new_qty: e.resolution === 'delete' ? 0 : qtyOf.get(it.measurement_id) };
    })) });
    if (differ.length) conflictBody(differ.every(isProbe) ? { error: PREVIEW, code: 'resolution_preview', ...body, resolved, resolved_totals: resolvedTotals() } : { error: REVIEW_AGAIN, ...body, resolved });
    if (checked.some(gt => gt.gates.some(g => !(gt.e.confirm || []).includes(g))))
      conflictBody({ error: 'confirm the checks of the chosen resolutions', code: 'confirm_checks', ...body, resolved, resolved_totals: resolvedTotals() });
    // 4. the rows (an imported row keeps its client qty; its measured total must not go below 0), then the drawings
    const rowQty = rows.map(r => ({ row_id: r, qty: recompute(r) }));
    db.prepare('UPDATE drawings SET pending=0 WHERE id=? OR parent_id=?').run(nd.id, nd.id);
    for (const o of db.prepare('SELECT id, page FROM drawings WHERE id=? OR parent_id=?').all(old.id, old.id))
      db.prepare('UPDATE drawings SET replaced_by=? WHERE id=?').run(o.id === old.id || !newPages ? nd.id : (newPages.get(o.page) || nd).id, o.id);
    audit(me, 'replace_accept', 'drawings', nd.id, { replaced: old.id, by: nd.id, ...counts, changed_rows: rows.length });
    return { id: nd.id, replaced: old.id, ...counts, rows: rowQty };
  }
  // a layer or block measurement relinked to `to` (one of its relink_choices) on the new layer table: what is stored
  // (by the creation code: base from the table, dxfQty) and the gates that fire there (layerGates)
  function relinkTo(m, to, lt) {
    const layer = m.tool === 'dxf_layer' ? to : to.layer, block = m.tool === 'dxf_layer' ? null : to.block;
    const l = lt.layers.find(x => x.layer === layer);
    if (!l) bad(`measurement ${m.id}: layer ${layer} is not in the new version`, 409);
    let base, handles;
    if (m.tool === 'dxf_layer') { base = l[m.metric]; handles = l.entities; }
    else { const b = (l.blocks || []).find(x => x.name === block); base = b ? b.top + (m.nested ? b.nested : 0) : null; handles = base; }
    const q = dxfRescale(m, base), g = layerGates(lt, l, { ...m, layer, block });
    return { set: { layer, block, qty: q.qty, base: q.base, handles_count: handles }, fired: [...(g.incomplete ? ['incomplete'] : []), ...(g.duplicates > 0 ? ['duplicate'] : [])] };
  }

  // DELETE /drawings/:newId while pending = cancel the replacement: that row and its page rows go (nothing is measured or
  // calibrated on them); the old drawing is measurable again. Files stay (shared by sha256, as on tender delete).
  function cancelReplacement(res, d, t, me) {
    need(me, 'admin', 'qs'); mustDraft(t);
    if (!d.pending) bad('only a pending new version can be cancelled', 409);
    if (d.parent_id !== null) bad('cancel the whole new version: use its first page');
    tx(() => {
      mustDraft(tenderRow(t.id));
      const cur = drawingRow(d.id);
      if (!cur || !cur.pending) bad('only a pending new version can be cancelled', 409);
      const ids = db.prepare('SELECT id FROM drawings WHERE id=? OR parent_id=?').all(cur.id, cur.id).map(x => x.id), marks = ids.map(() => '?').join(',');
      // never drop a quantity silently (the guards keep these at 0)
      if (db.prepare(`SELECT 1 FROM measurements WHERE drawing_id IN (${marks}) UNION ALL SELECT 1 FROM calibrations WHERE drawing_id IN (${marks}) LIMIT 1`).get(...ids, ...ids))
        bad('the new version has measurements or calibrations: it cannot be cancelled', 409);
      db.prepare(`DELETE FROM drawings WHERE id IN (${marks})`).run(...ids);
      audit(me, 'replace_cancel', 'drawings', cur.id, { replaces: cur.replaces_id, pages: ids.length });
    });
    return reply(res, 200, { ok: 1 });
  }

  // POST /measurements/:id/reviewed: clears review_needed (set on manual measurements carried to a new version)
  function markReviewed(res, parts, me) {
    need(me, 'admin', 'qs');
    const m = idOf(parts[1]) === null ? null : db.prepare('SELECT * FROM measurements WHERE id=?').get(idOf(parts[1]));
    const t = m ? tenderRow(m.tender_id) : null;
    if (!m || !t) bad('measurement not found', 404);
    mustDraft(t);
    tx(() => {
      mustDraft(tenderRow(t.id));
      const cur = db.prepare('SELECT * FROM measurements WHERE id=?').get(m.id);
      if (!cur) bad('measurement not found', 404);
      const d = drawingRow(cur.drawing_id);
      if (d) canMeasure(d);
      if (cur.review_needed) {
        db.prepare('UPDATE measurements SET review_needed=0 WHERE id=?').run(cur.id);
        audit(me, 'measure_reviewed', 'measurements', cur.id, { drawing_id: cur.drawing_id, row_id: cur.row_id, tool: cur.tool });
      }
    });
    return reply(res, 200, { ok: 1, id: m.id, review_needed: 0 });
  }

  // the file's download name: the drawing name with its extension, percent-encoded (RFC 5987/8187: ' ( ) * too), so no
  // name can break the header
  const dispositionName = (name, ext) => {
    const n = String(name || 'drawing'), has = new RegExp('\\.' + (ext === 'jpg' ? 'jpe?g' : ext) + '$', 'i').test(n);
    return encodeURIComponent(has ? n : n + '.' + ext).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  };
  // GET /drawings/:id/file: the uploaded bytes as they are (a page row: the shared file). Any reader. no-cache + ETag (the
  // content never changes for a sha256, the browser asks every time and gets 304). Never shown as a page of this site: a
  // download (attachment) in a sandbox (CSP); the viewer reads it with fetch (pdf.js, createImageBitmap).
  async function serveFile(req, res, d, me) {
    need(me, 'admin', 'qs', 'viewer');
    const ext = extOf(d), etag = `"${d.sha256}"`;
    let fh;
    try { fh = await fsp.open(storedFile(d.sha256, ext), 'r'); } catch (e) { bad('the stored drawing file is missing: upload the drawing again', 409); }
    const tags = String(req.headers['if-none-match'] || '').split(',').map(x => x.trim().replace(/^W\//, ''));
    const head = { ETag: etag, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox',
      'Content-Disposition': `attachment; filename="drawing.${ext}"; filename*=UTF-8''${dispositionName(d.name, ext)}` };
    if (tags.includes(etag) || tags.includes('*')) { await fh.close().catch(() => {}); res.writeHead(304, head); res.end(); return true; }
    let size;
    try { size = (await fh.stat()).size; } catch (e) { await fh.close().catch(() => {}); throw e; }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': size, ...head });
    const rs = fh.createReadStream();   // closes the file when done
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
    return true;
  }

  // a drawing that failed under another parser version: parse it again, once (this version's failure, if any, sticks).
  // Runs on every read of a drawing; the guarded UPDATE lets only one request queue it. Returns the current row.
  function retryFailed(d) {
    if (d.status !== 'failed' || d.failed_version === PARSER_VERSION) return d;
    const queued = tx(() => {
      const n = db.prepare("UPDATE drawings SET status='parsing', error=NULL WHERE id=? AND status='failed' AND (failed_version IS NULL OR failed_version<>?)").run(d.id, PARSER_VERSION).changes;
      if (n) audit('system', 'parse_retry', 'drawings', d.id, { failed_version: d.failed_version, parser_version: PARSER_VERSION });
      return n > 0;
    });
    if (queued) startParse(d.id, d.sha256);
    return drawingRow(d.id);
  }

  async function drawingApi(req, res, url, parts, me) {
    const [, idStr, sub] = parts, method = req.method;
    let d = drawingRow(idOf(idStr));
    if (!d) bad('drawing not found', 404);
    const t = tenderRow(d.tender_id);
    if (!t) bad('drawing not found', 404);
    if (method === 'GET') d = retryFailed(d);
    // the DXF parse results (layers, display file, units, DXF measurements) do not apply to a PDF or an image
    const dxfOnly = () => { if (d.kind !== 'dxf') bad('this applies to DXF drawings only'); };
    if (sub === undefined && parts.length === 2 && method === 'GET') {
      need(me, 'admin', 'qs', 'viewer');
      const c = d.kind === 'dxf' && d.status === 'ready' ? await readSummary(d.sha256) : null;
      // unit_to_m: the server's unit table (lib/units.js), for the browser preview and the calibration units (no copy there)
      return reply(res, 200, { ...d, header: c && c.header, ignored: c && c.ignored, warnings: c && c.warnings, calibrations: d.kind === 'dxf' ? null : calibrationsOf(d.id), unit_to_m: UNIT_TO_M });
    }
    if (sub === 'layers' && parts.length === 3 && method === 'GET') {
      need(me, 'admin', 'qs', 'viewer'); dxfOnly();
      if (d.status !== 'ready') bad(`drawing is ${d.status}: no layers yet`, 409);
      const c = await readSummary(d.sha256), lt = scaledTable(c.raw, d.units);
      return reply(res, 200, { units: d.units, units_confirmed: d.units !== null, layers: lt.layers, warnings: [...c.warnings, ...lt.warnings] });
    }
    if (sub === 'render' && parts.length === 3 && method === 'GET') { need(me, 'admin', 'qs', 'viewer'); dxfOnly(); return serveRender(req, res, d, me); }
    if (sub === 'file' && parts.length === 3 && method === 'GET') return serveFile(req, res, d, me);
    if (sub === 'pages' && parts.length === 3 && method === 'POST') return registerPages(req, res, d, t, me);
    if (sub === 'calibrations' && parts.length >= 3 && parts.length <= 5) return calibrationApi(req, res, parts, d, t, me);
    if (sub === 'units' && parts.length === 3 && method === 'PUT') { need(me, 'admin', 'qs'); mustDraft(t); dxfOnly(); notReplacing(d); notReplaced(d); return setUnits(req, res, d, t, me); }
    if (sub === 'measurements' && parts.length === 3 && method === 'POST') return createMeasurement(req, res, d, t, me);
    if (sub === 'replace' && parts.length === 3 && method === 'POST') { need(me, 'admin', 'qs'); mustDraft(t); return upload(req, res, url, t, me, replaceable(d.id)); }
    if (sub === 'compare' && parts.length === 3 && method === 'GET') {
      need(me, 'admin', 'qs', 'viewer');
      pendingTop(d);
      return reply(res, 200, (await compareFull(d)).body);
    }
    if (sub === 'accept' && parts.length === 3 && method === 'POST') return acceptReplacement(req, res, d, t, me);
    if (sub === undefined && parts.length === 2 && method === 'DELETE') return cancelReplacement(res, d, t, me);
    return false;
  }

  // the display file, gzipped bytes as stored. Geometry is not a quantity: served before units are confirmed.
  // no-cache: the browser keeps it but asks every time (ETag, 304), so a re-parsed file is never shown from a stale copy.
  async function serveRender(req, res, d, me) {
    need(me, 'admin', 'qs', 'viewer');
    if (d.status !== 'ready') bad(`drawing is ${d.status}: nothing to show yet`, 409);
    const sha = d.sha256, etag = `"${sha}-${PARSER_VERSION}"`;
    if (!fs.existsSync(renderFile(sha))) summaries.delete(sha);   // readSummary then parses the file again
    const v = await readSummary(sha);
    if (v.render && v.render.ok === false) bad('display not available for this drawing: ' + plain(v.render.error), 409);   // recorded: no re-parse
    const tags = String(req.headers['if-none-match'] || '').split(',').map(t => t.trim().replace(/^W\//, ''));
    if (tags.includes(etag) || tags.includes('*')) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' }); res.end(); return true; }
    let fh;
    try { fh = await fsp.open(renderFile(sha), 'r'); } catch (e) { bad('the parsed drawing is missing: upload the drawing again', 409); }
    let size;
    try { size = (await fh.stat()).size; } catch (e) { await fh.close().catch(() => {}); throw e; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': size, ETag: etag, 'Cache-Control': 'private, no-cache' });
    const rs = fh.createReadStream();   // closes the file when done
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
    return true;
  }

  // ---- measurements: a layer metric or a block count linked to a tender row -----------------------------------
  // qty = base × (width ?? 1) × (depth ?? 1) × factor, base from the same scaled layer table as GET layers.
  const LAYER_METRICS = ['open_length', 'closed_perimeter', 'area'];
  const SELECTION_METRICS = ['open_length', 'closed_perimeter', 'area', 'count'];
  // metrics that can count the same geometry twice on one row: lengths with each other, areas, counts
  const FAMILY = { open_length: ['open_length', 'closed_perimeter'], closed_perimeter: ['open_length', 'closed_perimeter'], area: ['area'], count: ['count'] };
  const MFIELDS = ['row_id', 'tool', 'layer', 'metric', 'block', 'nested', 'handles', 'width', 'depth', 'factor', 'label', 'color', 'confirm_uom', 'confirm_overlap', 'confirm_incomplete', 'confirm_duplicate', 'confirm_mixed_blocks'];
  const finNum = v => typeof v === 'number' && Number.isFinite(v);
  // the DXF tools' qty from their base (metres, m2 or nr): base × (width ?? 1) × (depth ?? 1) × factor (width/depth in metres)
  const dxfQty = (base, m) => base * (m.width ?? 1) * (m.depth ?? 1) * m.factor;
  // a selection's base from its total in drawing units: lengths × f, areas × f², counts as they are (f = UNIT_TO_M[units])
  const selectionBase = (raw, metric, f) => metric === 'count' ? raw : metric === 'area' ? raw * f * f : raw * f;
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
    if (!['dxf_layer', 'dxf_blocks', 'dxf_selection'].includes(m.tool)) bad('tool must be manual, dxf_layer, dxf_blocks or dxf_selection');
    if (m.tool === 'dxf_selection') {
      if (b.layer !== undefined || b.block !== undefined) bad('layer and block do not apply to a selection');
      if (!SELECTION_METRICS.includes(m.metric)) bad('metric must be one of ' + SELECTION_METRICS.join(', '));
      if (b.nested !== undefined && m.metric !== 'count') bad('nested applies to a count only');
      const h = b.handles;
      if (!Array.isArray(h) || h.length < 1 || h.length > MAX_HANDLES) bad(`handles must be a list of 1 to ${MAX_HANDLES} entity handles`);
      for (const x of h) if (typeof x !== 'string' || !x || x.length > 1000) bad('handles must be entity handles (text)');
      if (new Set(h).size !== h.length) bad('duplicate handle in selection');
      m.handles = h; m.layer = null; m.block = null; m.nested = optBool(b, 'nested');   // count: include inserts nested in blocks
    } else {
      if (b.handles !== undefined) bad('handles belong to dxf_selection');
      if (typeof b.layer !== 'string' || !b.layer || b.layer.length > 255) bad('layer is required');
      m.layer = b.layer;
    }
    if (m.tool === 'dxf_layer') {
      if (!LAYER_METRICS.includes(m.metric)) bad('metric must be one of ' + LAYER_METRICS.join(', '));
      if (b.block !== undefined || b.nested !== undefined) bad('block and nested belong to dxf_blocks');
      m.block = null; m.nested = false;
    } else if (m.tool === 'dxf_blocks') {
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
    m.confirm_duplicate = optBool(b, 'confirm_duplicate'); m.confirm_mixed_blocks = optBool(b, 'confirm_mixed_blocks');
    return m;
  }
  // a selection's audit summary: counts only, never its handles; a manual one: its shape and point count, never coordinates
  const summaryOf = m => m.tool === 'manual' ? manualSummary(m) : m.tool === 'dxf_selection'
    ? { drawing_id: m.drawing_id, row_id: m.row_id, tool: m.tool, metric: m.metric, ...(m.metric === 'count' ? { nested: !!m.nested } : {}), used: m.handles_count, qty: m.qty, qty_unit: m.qty_unit }
    : { drawing_id: m.drawing_id, row_id: m.row_id, tool: m.tool, layer: m.layer, ...(m.tool === 'dxf_blocks' ? { block: m.block, nested: !!m.nested } : {}), metric: m.metric, qty: m.qty, qty_unit: m.qty_unit };
  const parseSummary = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

  // ---- manual measurements (lib/takeoff/manual.js): shapes drawn on a DXF, a PDF page or an image -----------------
  // qty = manualQty(geom, { scale, width, depth, factor, deduct, metric }) — the one formula, also the browser preview's.
  // scale: UNIT_TO_M[confirmed units] (DXF) or the calibration of the region containing the first point, else the
  // page's (PDF/image); the calibration used is stored (calibration_id) so a re-calibration lists what it changes.
  const MANUAL_FIELDS = ['tool', 'geom', 'row_id', 'width', 'depth', 'factor', 'deduct', 'metric', 'label', 'color', 'confirm_uom', 'confirm_overlap'];
  const MANUAL_EDIT = ['row_id', 'width', 'depth', 'factor', 'deduct', 'label'];
  const parseGeom = s => { try { const g = typeof s === 'string' ? JSON.parse(s) : null; return g && typeof g === 'object' && !Array.isArray(g) ? g : null; } catch (e) { return null; } };
  const isClosed = g => g.tool === 'area' || g.tool === 'rect';
  // manualQty options of a measurement (stored row or cleaned request) at a scale
  const manualOpts = (g, m, scale) => ({ scale, width: m.width, depth: m.depth, factor: m.factor, deduct: m.deduct === true || m.deduct === 1, metric: isClosed(g) ? m.metric : undefined });
  function manualSummary(m) {
    const g = typeof m.geom === 'string' ? parseGeom(m.geom) : m.geom;
    let points = null;
    try { points = manual.pointCount(g); } catch (e) { /* unreadable geometry: no count */ }
    return { drawing_id: m.drawing_id, row_id: m.row_id, tool: 'manual', shape: g && typeof g.tool === 'string' ? g.tool : null, metric: m.metric, points,
      qty: m.qty, qty_unit: m.qty_unit, deduct: m.deduct === true || m.deduct === 1, calibration_id: m.calibration_id };
  }
  function cleanManual(b) {
    for (const k of Object.keys(b)) if (!MANUAL_FIELDS.includes(k)) bad('unknown field: ' + k);
    const m = { tool: 'manual', row_id: rowIdOf(b.row_id) };
    calc(() => manual.validateGeom(b.geom));
    m.geom = b.geom;
    m.width = dim(b, 'width'); m.depth = dim(b, 'depth');
    const f = dim(b, 'factor'); m.factor = f === null ? 1 : f;
    m.deduct = optBool(b, 'deduct');
    m.metric = b.metric === undefined ? null : b.metric;   // checked by manualQty below
    m.label = optText(b, 'label', 200); m.color = optText(b, 'color', 32);
    m.confirm_uom = optBool(b, 'confirm_uom'); m.confirm_overlap = optBool(b, 'confirm_overlap');
    // every option is checked before the calibration lookup: the shape at scale 1 (its units and combinations); the
    // geometry was validated just above, once for the whole request (R13)
    m.metric = calc(() => manual.manualQty(m.geom, { ...manualOpts(m.geom, m, 1), metric: m.metric }, true)).metric;
    return m;
  }
  // the scale a stored manual measurement was computed with: the drawing units (DXF) or its calibration (PDF/image);
  // null for a count (R14: no scale)
  function storedScale(cur, d) {
    if (cur.metric === 'count') return null;
    if (d.kind === 'dxf') { if (!hasUnit(d.units)) bad('the drawing units are not confirmed', 409); return UNIT_TO_M[d.units]; }
    const c = cur.calibration_id === null ? null : db.prepare('SELECT scale FROM calibrations WHERE id=? AND drawing_id=?').get(cur.calibration_id, d.id);
    if (!c) bad(`measurement ${cur.id} has no calibration: delete it and measure again`, 409);
    return c.scale;
  }
  // how many manual measurements on the row have the identical geometry (normalised, manual.geomKey) on the same page of
  // the same file. An unreadable stored geometry counts (never assume no overlap). Runs inside the tx.
  function manualOverlaps(m, d, tenderId, selfId) {
    const key = manual.geomKey(m.geom);
    let n = 0;
    for (const o of db.prepare(`SELECT m.geom FROM measurements m JOIN drawings d ON d.id=m.drawing_id
      WHERE m.row_id=? AND m.tender_id=? AND m.id<>? AND m.tool='manual' AND d.sha256=? AND d.page IS ?`).all(m.row_id, tenderId, selfId, d.sha256, d.page)) {
      let k = null;
      try { k = manual.geomKey(parseGeom(o.geom)); } catch (e) { /* unreadable */ }
      if (k === null || k === key) n++;
    }
    return n;
  }
  function createManual(res, d, t, me, m) {
    if (d.status !== 'ready') bad(`drawing is ${d.status}: nothing to measure yet`, 409);
    if (d.kind === 'dxf' && d.units === null) bad('confirm the drawing units first', 409);
    onPage(d, manual.points(m.geom).map((p, i) => ['point ' + (i + 1), p]));
    m.drawing_id = d.id;
    const out = tx(() => {
      mustDraft(tenderRow(t.id));
      const cur = drawingRow(d.id);
      if (!cur || cur.status !== 'ready' || cur.units !== d.units || cur.sha256 !== d.sha256) bad('the drawing changed: try again', 409);
      canMeasure(cur);
      // R14: a count does not depend on scale, so it needs no calibration (calibration_id NULL)
      let scale = null, cal = null;
      if (m.metric === 'count') { /* no scale */ }
      else if (d.kind === 'dxf') scale = UNIT_TO_M[d.units];
      else {
        cal = calib.calibrationFor(db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(d.id), manual.firstPoint(m.geom));
        if (!cal) bad('calibrate this page first', 409);
        scale = cal.scale;
      }
      const q = calc(() => manual.manualQty(m.geom, manualOpts(m.geom, m, scale), true));
      if (!(Math.abs(q.qty) <= MAX_QTY)) bad(`the quantity ${q.qty} is out of range: it must be at most ${MAX_QTY}`);
      Object.assign(m, { qty: q.qty, qty_unit: q.qty_unit, base: q.base, metric: q.metric, calibration_id: cal ? cal.id : null });
      const ch = checkRow(me, m, d.sha256, t.id, -1, m.confirm_uom, m.confirm_overlap, {}, manualOverlaps(m, d, t.id, -1));
      const id = Number(db.prepare(`INSERT INTO measurements(drawing_id,tender_id,row_id,tool,metric,width,depth,factor,label,color,qty,qty_unit,uom_confirmed,base,geom,deduct,calibration_id,created,created_by)
        VALUES(?,?,?,'manual',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.id, t.id, m.row_id, m.metric, m.width, m.depth, m.factor, m.label, m.color, m.qty, m.qty_unit, ch.uomConfirmed,
        m.base, JSON.stringify(m.geom), m.deduct ? 1 : 0, m.calibration_id, new Date().toISOString(), me.username).lastInsertRowid);
      const sum = summaryOf(m);
      audit(me, 'measure', 'measurements', id, sum);
      if (ch.uomConfirmed) audit(me, 'measure_uom_confirmed', 'measurements', id, { ...sum, row_unit: ch.row.unit });
      if (ch.overlaps) audit(me, 'measure_overlap_confirmed', 'measurements', id, { ...sum, overlaps: ch.overlaps });
      return { id, qty: m.qty, qty_unit: m.qty_unit, base: m.base, calibration_id: m.calibration_id, row_qty: recompute(m.row_id) };
    });
    return reply(res, 200, out);
  }
  // PUT /measurements/:id on a manual measurement: row_id (null unlinks it), width, depth, factor, deduct, label (the geometry never
  // changes: delete and redraw). qty is recomputed with the calibration (or units) it was saved with; the unit and
  // overlap gates run when the row or the unit changes; both rows are recomputed in the tx.
  async function editManual(req, res, m, t, me) {
    const b = await ctx.readBody(req);
    for (const k of Object.keys(b)) if (![...MANUAL_EDIT, 'confirm_uom', 'confirm_overlap'].includes(k)) bad('unknown field: ' + k);
    if (!MANUAL_EDIT.some(k => b[k] !== undefined)) bad('nothing to change: send row_id, width, depth, factor, deduct or label');
    const set = {};
    if (b.row_id !== undefined) set.row_id = b.row_id === null ? null : rowIdOf(b.row_id);   // null: unlinked (kept, as after a re-import)
    if (b.width !== undefined) set.width = dim(b, 'width');
    if (b.depth !== undefined) set.depth = dim(b, 'depth');
    if (b.factor !== undefined) { const f = dim(b, 'factor'); set.factor = f === null ? 1 : f; }
    if (b.deduct !== undefined) set.deduct = optBool(b, 'deduct') ? 1 : 0;
    if (b.label !== undefined) set.label = optText(b, 'label', 200);
    const confirmUom = optBool(b, 'confirm_uom'), confirmOverlap = optBool(b, 'confirm_overlap');
    const out = tx(() => {
      mustDraft(tenderRow(t.id));
      const cur = db.prepare('SELECT * FROM measurements WHERE id=?').get(m.id);
      if (!cur) bad('measurement not found', 404);
      const d = drawingRow(cur.drawing_id);
      if (!d) bad('the drawing of this measurement is missing', 409);
      canMeasure(d);
      const g = parseGeom(cur.geom);
      if (!g) bad(`the shape of measurement ${cur.id} cannot be read: delete it and measure again`, 409);
      const next = { ...cur, ...set };
      const q = calc(() => manual.manualQty(g, manualOpts(g, next, storedScale(cur, d)), true));   // validated when saved
      if (!(Math.abs(q.qty) <= MAX_QTY)) bad(`the quantity ${q.qty} is out of range: it must be at most ${MAX_QTY}`);
      Object.assign(next, { qty: q.qty, qty_unit: q.qty_unit, base: q.base, geom: g });
      const moved = next.row_id !== cur.row_id;
      let ch = null;
      if (next.row_id !== null && (moved || next.qty_unit !== cur.qty_unit)) {
        ch = checkRow(me, next, d.sha256, t.id, cur.id, confirmUom, confirmOverlap, {}, moved ? manualOverlaps(next, d, t.id, cur.id) : 0);
        next.uom_confirmed = ch.uomConfirmed;
      }
      db.prepare('UPDATE measurements SET row_id=?, width=?, depth=?, factor=?, deduct=?, label=?, qty=?, qty_unit=?, base=?, uom_confirmed=? WHERE id=?')
        .run(next.row_id, next.width, next.depth, next.factor, next.deduct, next.label, next.qty, next.qty_unit, next.base, next.uom_confirmed, cur.id);
      const sum = { ...summaryOf(next), width: next.width, depth: next.depth, factor: next.factor, ...(moved ? { from_row_id: cur.row_id } : {}) };
      audit(me, 'measure_edit', 'measurements', cur.id, sum);
      if (ch && ch.uomConfirmed) audit(me, 'measure_uom_confirmed', 'measurements', cur.id, { ...sum, row_unit: ch.row.unit });
      if (ch && ch.overlaps) audit(me, 'measure_overlap_confirmed', 'measurements', cur.id, { ...sum, overlaps: ch.overlaps });
      return { ok: 1, id: cur.id, qty: next.qty, qty_unit: next.qty_unit, base: next.base, row_qty: recompute(next.row_id), ...(moved ? { old_row_qty: recompute(cur.row_id) } : {}) };
    });
    return reply(res, 200, out);
  }
  // how many measurements already on the row count some of the same geometry (same file). Runs inside the tx.
  // A selection (m.sel = { handles: Set, layers: Set, pairs: Set of layer\0block }) overlaps: another selection of the
  // same metric family holding one of its handles; a dxf_layer measurement of that family on a layer it uses; a
  // dxf_blocks count of a block it counts on that layer. A layer or block measurement overlaps: the same link (batch 1
  // rule), or a selection of that family using its layer (or counting its block on its layer).
  function overlapCount(m, sha, tenderId, selfId) {
    const fam = FAMILY[m.metric] || [m.metric];
    const others = db.prepare(`SELECT m.id, m.tool, m.layer, m.block, m.metric, m.selection_summary FROM measurements m JOIN drawings d ON d.id=m.drawing_id
      WHERE m.row_id=? AND m.tender_id=? AND m.id<>? AND d.sha256=? AND m.metric IN (${fam.map(() => '?').join(',')}) ORDER BY m.id`).all(m.row_id, tenderId, selfId, sha, ...fam);
    let n = 0;
    for (const o of others) {
      if (m.tool === 'dxf_selection') {
        // its own summary unreadable (layers unknown): every layer/block measurement of the family counts
        if (o.tool === 'dxf_layer') { if (m.sel.unreadable || m.sel.layers.has(o.layer)) n++; }
        else if (o.tool === 'dxf_blocks') { if (m.sel.unreadable || m.sel.pairs.has(o.layer + '\0' + o.block)) n++; }
        else if (o.tool === 'dxf_selection') {
          for (const h of db.prepare('SELECT handle FROM measurement_handles WHERE measurement_id=?').iterate(o.id)) if (m.sel.handles.has(h.handle)) { n++; break; }
        }
      } else if (o.tool === 'dxf_selection') {
        const s = parseSummary(o.selection_summary);
        if (!s) { n++; continue; }   // unreadable summary: never assume no overlap
        if (m.tool === 'dxf_layer' && Object.hasOwn(s.by_layer || {}, m.layer)) n++;
        if (m.tool === 'dxf_blocks' && (s.blocks || []).some(x => x.layer === m.layer && x.block === m.block && x.count > 0)) n++;
      } else if (o.tool === m.tool && o.metric === m.metric && o.layer === m.layer && o.block === m.block) n++;
    }
    return n;
  }
  // the same geometry (geomKey) as an entity another selection of the family on the row holds under another handle:
  // how many such stored entities. The same handle is an overlap, not a duplicate. Runs inside the tx.
  function crossDuplicates(m, sha, tenderId, selfId) {
    const fam = FAMILY[m.metric];
    const others = db.prepare(`SELECT m.id FROM measurements m JOIN drawings d ON d.id=m.drawing_id
      WHERE m.row_id=? AND m.tender_id=? AND m.id<>? AND d.sha256=? AND m.tool='dxf_selection' AND m.metric IN (${fam.map(() => '?').join(',')})`).all(m.row_id, tenderId, selfId, sha, ...fam);
    let n = 0;
    for (const o of others)
      for (const h of db.prepare('SELECT handle, geom_key FROM measurement_handles WHERE measurement_id=?').iterate(o.id))
        if (h.geom_key !== null && m.sel.keys.has(h.geom_key) && !m.sel.handles.has(h.handle)) n++;
    return n;
  }
  // a stored selection's handles, geomKeys, layers and block pairs, for the checks of a relink
  const storedSel = cur => {
    const s = parseSummary(cur.selection_summary);
    const hs = db.prepare('SELECT handle, geom_key FROM measurement_handles WHERE measurement_id=?').all(cur.id);
    return { handles: new Set(hs.map(x => x.handle)), keys: new Set(hs.map(x => x.geom_key).filter(k => k !== null)), unreadable: !s,
      layers: new Set(Object.keys((s && s.by_layer) || {})), pairs: new Set(((s && s.blocks) || []).filter(x => x.count > 0).map(x => x.layer + '\0' + x.block)) };
  };
  // the row checks shared by create and relink. Runs inside the tx.
  // Units: a known row unit must equal qty_unit (no override: m is never added into m2). Only a row whose unit text
  // normUom does not recognise may take a measurement with confirm_uom (uom_confirmed = 1), and then in one unit only.
  // extra: counts added to a selection's 409 bodies; overlaps: the overlap count when the caller already has it
  function checkRow(me, m, sha, tenderId, selfId, confirmUom, confirmOverlap, extra = {}, overlaps = null) {
    const row = db.prepare('SELECT * FROM tender_rows WHERE id=?').get(m.row_id);
    if (!row || row.tender_id !== tenderId) bad('row not found in this tender');
    if (row.is_heading) bad('a heading row cannot take measurements');
    const ru = normUom(row.unit);
    if (ru === 'ls') bad('a lump-sum (LS) row cannot take measurements');
    let uomConfirmed = 0;
    if (ru === null) {
      if (!confirmUom) conflictBody({ error: 'unit mismatch', row_unit: row.unit, qty_unit: m.qty_unit, ...extra });
      const other = db.prepare('SELECT DISTINCT qty_unit u FROM measurements WHERE row_id=? AND id<>?').all(m.row_id, selfId).map(x => x.u).filter(u => u !== m.qty_unit);
      if (other.length) failBody(400, { error: `the row already has measurements in ${other.join(', ')}: one unit per row`, row_unit: row.unit, qty_unit: m.qty_unit });
      uomConfirmed = 1;
    } else if (ru !== m.qty_unit) failBody(400, { error: 'unit mismatch — add width/depth', row_unit: row.unit, qty_unit: m.qty_unit });
    // the same geometry already on this row: same file (sha256), tool, layer, block (top and nested both count the
    // top inserts, so nested is not part of the key) and metric; and selections of the same geometry (overlapCount)
    const over = overlaps === null ? overlapCount(m, sha, tenderId, selfId) : overlaps;
    if (over && !confirmOverlap) conflictBody({ error: 'already measured on this row', ...extra });
    return { row, uomConfirmed, overlaps: over };
  }
  const recompute = rowId => rowId === null ? null : ctx.tenders.recomputeTakeoffQty(rowId);

  async function createMeasurement(req, res, d, t, me) {
    need(me, 'admin', 'qs'); mustDraft(t); canMeasure(d);
    const b = await ctx.readBody(req);
    if (b.tool === 'manual') return createManual(res, d, t, me, cleanManual(b));
    const m = cleanMeasure(b);
    if (d.kind !== 'dxf') bad('the DXF tools apply to DXF drawings only');
    if (d.status !== 'ready') bad(`drawing is ${d.status}: nothing to measure yet`, 409);
    if (d.units === null) bad('confirm the drawing units first', 409);
    if (m.tool === 'dxf_selection') return createSelection(res, d, t, me, m);
    const c = await readSummary(d.sha256), lt = scaledTable(c.raw, d.units);
    const layer = lt.layers.find(l => l.layer === m.layer);
    if (!layer) bad('layer not found in this drawing: ' + m.layer);
    let base, handles;
    if (m.tool === 'dxf_layer') { base = layer[m.metric]; handles = layer.entities; }
    else {
      const bl = (layer.blocks || []).find(x => x.name === m.block);
      if (!bl) bad(`block ${m.block} not found on layer ${m.layer}`);
      base = bl.top + (m.nested ? bl.nested : 0); handles = base;
    }
    const { incomplete, duplicates } = layerGates(lt, layer, m);
    if (incomplete && !m.confirm_incomplete) conflictBody({ error: 'layer quantity is incomplete', ...incomplete });
    if (duplicates && !m.confirm_duplicate) conflictBody({ error: 'possible duplicates on this layer', duplicates });
    if (!finNum(base) || !(base > 0)) bad(`nothing to measure: ${m.layer} ${m.block ? m.block + ' ' : ''}${m.metric} is ${base}`);
    m.qty = dxfQty(base, m);
    if (!Number.isFinite(m.qty) || m.qty > MAX_QTY) bad(`the quantity ${m.qty} is out of range: it must be at most ${MAX_QTY}`);
    m.drawing_id = d.id;
    if (hooks.beforeMeasureTx) await hooks.beforeMeasureTx();
    const out = tx(() => {
      mustDraft(tenderRow(t.id));
      // the table read above must still describe this drawing (units could change before the first measurement)
      const cur = drawingRow(d.id);
      if (!cur || cur.status !== 'ready' || cur.units !== d.units || cur.sha256 !== d.sha256) bad('the drawing changed: try again', 409);
      canMeasure(cur);
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

  // The creation gates of a layer or block measurement (shared by create and the replacement compare), from the scaled
  // layer table lt and the measurement's layer row:
  // - incomplete: shapes on the layer the parser could not measure (dropped: every metric, a block count too), closed
  //   shapes left out of an area, approximated curves (a layer metric): the total is not the whole story;
  // - duplicates: the same geometry twice on the layer (or the same block twice at one point), counted in the total.
  //   Layer metrics take the layer's warnings, a block count its block's.
  function layerGates(lt, layer, m) {
    const dropped = layer.dropped || 0;
    let incomplete = null;
    if (m.tool === 'dxf_layer') {
      const area_excluded = m.metric === 'area' ? layer.area_excluded || 0 : 0, approx = layer.approx || 0;
      if (area_excluded || approx || dropped) incomplete = { area_excluded, approx, dropped };
    } else if (dropped) incomplete = { area_excluded: 0, approx: 0, dropped };
    const duplicates = (lt.warnings || []).filter(w => w.code === 'possible_duplicate' && w.detail && w.detail.layer === m.layer
      && (m.tool === 'dxf_blocks' ? w.detail.block === m.block : w.detail.block === undefined)).reduce((s, w) => s + w.detail.count, 0);
    return { incomplete, duplicates };
  }
  // the creation gates of a selection from its worker totals (shared by create and the replacement compare): incomplete
  // (dropped, closed shapes without area, approximated curves), duplicates within the selection, and a count over several
  // block names (mixed: { name: count } sorted, or null). counted: the block pairs that took part in a count.
  function selectionGates(sel) {
    const counted = sel.blocks.filter(x => x.count > 0), byName = new Map();
    for (const x of counted) byName.set(x.block, (byName.get(x.block) || 0) + x.count);
    const mixed = byName.size > 1 ? Object.fromEntries([...byName].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) : null;
    return { incomplete: sel.dropped > 0 || sel.area_null > 0 || sel.approx > 0, duplicates: sel.duplicates, mixed, counted };
  }

  // ---- selections: totals from the full parse cache, in a worker through the parse queue (never on this thread) ----
  async function totalSelection(sha, handles, metric, nested) {
    for (let attempt = 0; ; attempt++) {
      const r = await enqueueJob(() => runSelect(sha, handles, metric, nested));
      if (r.ok) return r;
      // the cache is missing, unreadable or of another parser version: parse the stored .dxf again, once
      if (r.stale && attempt === 0) {
        if (!fs.existsSync(dxfFile(sha))) bad('the parsed drawing is missing: upload the drawing again', 409);
        await reparse(sha);
        continue;
      }
      bad('could not total the selection: ' + plain(r.error).slice(0, 300), 409);
    }
  }
  // qty = base × (width ?? 1) × (depth ?? 1) × factor with base = Σ in drawing units × f (lengths), × f² (areas), counts as they are
  async function createSelection(res, d, t, me, m) {
    const sel = await totalSelection(d.sha256, m.handles, m.metric, m.nested);
    if (sel.unknown) bad('selection contains entities not in this drawing');
    if (!sel.used) bad('nothing in the selection can be measured as ' + m.metric);
    const base = selectionBase(sel.base, m.metric, UNIT_TO_M[d.units]);
    m.handles_count = sel.used; m.drawing_id = d.id;
    // spec 6.4: a count is by block name; a count over several names (DOOR + WINDOW, or DOOR + its nested HINGE) is confirmed
    const gates = selectionGates(sel), { counted, mixed } = gates;
    m.sel = { handles: new Set(sel.used_handles), keys: new Set(sel.used_keys), layers: new Set(Object.keys(sel.by_layer)), pairs: new Set(counted.map(x => x.layer + '\0' + x.block)) };
    const summary = JSON.stringify({ metric: m.metric, by_layer: sel.by_layer, skipped: sel.skipped, ...(m.metric === 'count' ? { nested: m.nested, blocks: sel.blocks } : {}) });
    const out = tx(() => {
      mustDraft(tenderRow(t.id));
      // the totals must still describe this drawing (units could change before the first measurement)
      const cur = drawingRow(d.id);
      if (!cur || cur.status !== 'ready' || cur.units !== d.units || cur.sha256 !== d.sha256) bad('the drawing changed: try again', 409);
      canMeasure(cur);
      const overlapping = overlapCount(m, d.sha256, t.id, -1);
      // exact copies within the selection, and copies of entities other selections on the row already measured
      const duplicates = gates.duplicates + crossDuplicates(m, d.sha256, t.id, -1);
      const counts = { dropped: sel.dropped, area_null: sel.area_null, approx: sel.approx, duplicates, overlapping };
      // the batch 1 gates and bodies (the link form keys on them), with the selection's counts added
      const incomplete = gates.incomplete;
      if (incomplete && !m.confirm_incomplete) conflictBody({ error: 'layer quantity is incomplete', area_excluded: sel.area_null, approx: sel.approx, dropped: sel.dropped, ...counts });
      if (duplicates && !m.confirm_duplicate) conflictBody({ error: 'possible duplicates on this layer', ...counts });
      if (mixed && !m.confirm_mixed_blocks) conflictBody({ error: 'selection contains several blocks', blocks: mixed });
      if (!finNum(base) || !(base > 0)) bad('nothing in the selection can be measured as ' + m.metric);
      m.qty = dxfQty(base, m);
      if (!Number.isFinite(m.qty) || m.qty > MAX_QTY) bad(`the quantity ${m.qty} is out of range: it must be at most ${MAX_QTY}`);
      const ch = checkRow(me, m, d.sha256, t.id, -1, m.confirm_uom, m.confirm_overlap, counts, overlapping);
      const id = Number(db.prepare(`INSERT INTO measurements(drawing_id,tender_id,row_id,tool,layer,block,metric,nested,width,depth,factor,label,color,qty,qty_unit,handles_count,uom_confirmed,incomplete,duplicate,mixed,base,selection_summary,created,created_by)
        VALUES(?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.id, t.id, m.row_id, m.tool, m.metric, m.nested ? 1 : 0, m.width, m.depth, m.factor, m.label, m.color,
        m.qty, m.qty_unit, sel.used, ch.uomConfirmed, incomplete ? 1 : 0, duplicates ? 1 : 0, mixed ? 1 : 0, base, summary, new Date().toISOString(), me.username).lastInsertRowid);
      const insH = db.prepare('INSERT INTO measurement_handles(measurement_id, handle, geom_key) VALUES(?,?,?)');
      for (let i = 0; i < sel.used_handles.length; i++) insH.run(id, sel.used_handles[i], sel.used_keys[i]);
      const sum = summaryOf(m), short = { drawing_id: d.id, row_id: m.row_id, tool: m.tool, metric: m.metric };
      audit(me, 'measure', 'measurements', id, sum);
      if (ch.uomConfirmed) audit(me, 'measure_uom_confirmed', 'measurements', id, { ...sum, row_unit: ch.row.unit });
      if (ch.overlaps) audit(me, 'measure_overlap_confirmed', 'measurements', id, { ...sum, overlaps: ch.overlaps });
      if (duplicates) audit(me, 'measure_duplicate_confirmed', 'measurements', id, { ...short, duplicates });
      if (incomplete) audit(me, 'measure_incomplete_confirmed', 'measurements', id, { ...short, dropped: sel.dropped, area_null: sel.area_null, approx: sel.approx });
      if (mixed) audit(me, 'measure_mixed_blocks_confirmed', 'measurements', id, { ...short, blocks: mixed });
      return { id, qty: m.qty, qty_unit: m.qty_unit, row_qty: recompute(m.row_id), incomplete, duplicate: !!duplicates, handles_count: sel.used, skipped: sel.skipped,
        ...(m.metric === 'count' ? { nested: m.nested, mixed: !!mixed, blocks: sel.blocks } : {}) };
    });
    return reply(res, 200, out);
  }

  // GET /api/measurements/:id/handles: a selection's handles, for the viewer to highlight
  function measurementHandles(res, parts, me) {
    need(me, 'admin', 'qs', 'viewer');
    const m = idOf(parts[1]) === null ? null : db.prepare('SELECT id, tool, tender_id FROM measurements WHERE id=?').get(idOf(parts[1]));
    if (!m || !tenderRow(m.tender_id)) bad('measurement not found', 404);
    if (m.tool !== 'dxf_selection') bad('only a selection measurement has handles');
    const handles = db.prepare('SELECT handle FROM measurement_handles WHERE measurement_id=? ORDER BY rowid LIMIT ?').all(m.id, MAX_HANDLES).map(x => x.handle);
    return reply(res, 200, { id: m.id, count: handles.length, handles });
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
    const md = drawingRow(m.drawing_id);
    if (md) canMeasure(md);
    if (method === 'DELETE') {
      const out = tx(() => {
        mustDraft(tenderRow(t.id));
        const cur = db.prepare('SELECT * FROM measurements WHERE id=?').get(m.id);
        if (!cur) bad('measurement not found', 404);
        const cd = drawingRow(cur.drawing_id);
        if (cd) canMeasure(cd);
        db.prepare('DELETE FROM measurement_handles WHERE measurement_id=?').run(m.id);
        db.prepare('DELETE FROM measurements WHERE id=?').run(m.id);
        audit(me, 'measure_delete', 'measurements', m.id, summaryOf(cur));
        return { ok: 1, row_qty: recompute(cur.row_id) };
      });
      return reply(res, 200, out);
    }
    if (method === 'PUT' && m.tool === 'manual') return editManual(req, res, m, t, me);
    if (method === 'PUT') {
      const b = await ctx.readBody(req);
      for (const k of Object.keys(b)) if (!['row_id', 'confirm_uom', 'confirm_overlap', 'confirm_duplicate'].includes(k)) bad('unknown field: ' + k);
      const rowId = rowIdOf(b.row_id), confirmUom = optBool(b, 'confirm_uom'), confirmOverlap = optBool(b, 'confirm_overlap');
      const confirmDuplicate = optBool(b, 'confirm_duplicate');   // a selection next to an exact copy on the target row
      const out = tx(() => {
        mustDraft(tenderRow(t.id));
        const cur = db.prepare('SELECT * FROM measurements WHERE id=?').get(m.id);
        if (!cur) bad('measurement not found', 404);
        if (cur.row_id === rowId) bad('the measurement is already linked to this row');
        const d = drawingRow(cur.drawing_id);
        if (!d) bad('the drawing of this measurement is missing', 409);
        canMeasure(d);
        const isSel = cur.tool === 'dxf_selection';
        const mv = { ...cur, row_id: rowId, ...(isSel ? { sel: storedSel(cur) } : {}) };
        const overlaps = overlapCount(mv, d.sha256, t.id, cur.id);
        const dups = isSel ? crossDuplicates(mv, d.sha256, t.id, cur.id) : 0;
        if (dups && !confirmDuplicate) conflictBody({ error: 'possible duplicates on this layer', duplicates: dups, overlapping: overlaps });
        const ch = checkRow(me, mv, d.sha256, t.id, cur.id, confirmUom, confirmOverlap, isSel ? { overlapping: overlaps } : {}, overlaps);
        db.prepare('UPDATE measurements SET row_id=?, uom_confirmed=? WHERE id=?').run(rowId, ch.uomConfirmed, cur.id);
        if (dups) db.prepare('UPDATE measurements SET duplicate=1 WHERE id=?').run(cur.id);
        const sum = { ...summaryOf({ ...cur, row_id: rowId }), from_row_id: cur.row_id };
        audit(me, 'measure_relink', 'measurements', cur.id, sum);
        if (ch.uomConfirmed) audit(me, 'measure_uom_confirmed', 'measurements', cur.id, { ...sum, row_unit: ch.row.unit });
        if (ch.overlaps) audit(me, 'measure_overlap_confirmed', 'measurements', cur.id, { ...sum, overlaps: ch.overlaps });
        if (dups) audit(me, 'measure_duplicate_confirmed', 'measurements', cur.id, { drawing_id: cur.drawing_id, row_id: rowId, tool: cur.tool, metric: cur.metric, duplicates: dups });
        return { ok: 1, old_row_qty: recompute(cur.row_id), row_qty: recompute(rowId) };
      });
      return reply(res, 200, out);
    }
    return false;
  }

  function tenderMeasurements(t) {
    const all = db.prepare(`SELECT m.*, d.name AS drawing_name, d.kind AS drawing_kind, d.units AS drawing_units, r.no AS row_no, r.description AS row_description, r.unit AS row_unit,
      c.region AS cal_region, c.scale AS cal_scale, c.verify_pct AS cal_verify_pct, c.copied_from AS cal_copied_from,
      (SELECT COUNT(*) FROM calibrations c2 WHERE c2.drawing_id=c.drawing_id AND c2.region IS NOT NULL AND c2.id<=c.id) AS cal_region_no
      FROM measurements m JOIN drawings d ON d.id=m.drawing_id LEFT JOIN tender_rows r ON r.id=m.row_id LEFT JOIN calibrations c ON c.id=m.calibration_id WHERE m.tender_id=? ORDER BY m.id`).all(t.id);
    for (const x of all) {
      x.selection_summary = parseSummary(x.selection_summary);   // handles_count and this; never the handle list
      x.geom = parseGeom(x.geom);   // a manual measurement's shape, for the viewer
      // which calibration a PDF/image quantity used (page or region n: the drawing's regions by id from 1, as the
      // browser's scale line numbers them) and its verify %
      x.calibration = x.calibration_id === null || x.cal_scale === null ? null
        : { id: x.calibration_id, region: x.cal_region !== null, region_no: x.cal_region !== null ? x.cal_region_no : null, scale: x.cal_scale, verify_pct: x.cal_verify_pct, copied_from: x.cal_copied_from };
      delete x.cal_region; delete x.cal_scale; delete x.cal_verify_pct; delete x.cal_region_no; delete x.cal_copied_from;
      // a manual quantity's scale (metres per drawing/page unit), as the server used it: its calibration, or the DXF units
      x.scale = x.tool !== 'manual' || x.metric === 'count' ? null : x.calibration ? x.calibration.scale
        : x.drawing_kind === 'dxf' && hasUnit(x.drawing_units) ? UNIT_TO_M[x.drawing_units] : null;
    }
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
    if (parts[0] === 'measurements' && parts.length === 3 && parts[2] === 'handles' && method === 'GET') return measurementHandles(res, parts, me);
    if (parts[0] === 'measurements' && parts.length === 3 && parts[2] === 'reviewed' && method === 'POST') return markReviewed(res, parts, me);
    if (parts[0] === 'tenders' && parts[2] === 'drawings' && parts.length === 3) {
      const t = tenderRow(idOf(parts[1]));
      if (!t) bad('tender not found', 404);
      if (method === 'GET') {
        need(me, 'admin', 'qs', 'viewer');
        // a pending new version is not a drawing of the tender yet: it is shown under the row it replaces
        const pend = new Map(db.prepare('SELECT * FROM drawings WHERE tender_id=? AND pending=1 AND replaces_id IS NOT NULL ORDER BY id').all(t.id).map(x => [x.replaces_id, x]));
        return reply(res, 200, db.prepare('SELECT * FROM drawings WHERE tender_id=? AND pending=0 ORDER BY id').all(t.id).map(x => ({ ...x, pending_replacement: pend.get(x.id) || null })));
      }
      if (method === 'POST') return upload(req, res, url, t, me);
      return false;
    }
    if (parts[0] === 'drawings' && parts.length >= 2) return drawingApi(req, res, url, parts, me);
    return false;
  }

  return { handle };
};
