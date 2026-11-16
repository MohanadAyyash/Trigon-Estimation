// Daily backup script (scripts/backup.js): node --no-warnings test-backup.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const script = path.join(__dirname, 'scripts', 'backup.js');
const run = dataDir => spawnSync(process.execPath, ['--no-warnings', script], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
const d = new Date(), p = n => String(n).padStart(2, '0');
const today = `estimation-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.db`;

// the source is opened read-only (a backup must never be able to change the live database)
assert.ok(/new DatabaseSync\(src, \{ readOnly: true \}\)/.test(fs.readFileSync(script, 'utf8')), 'backup opens the source read-only');

// no database yet (fresh install): nothing to do, success
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-backup-'));
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
}

// normal run: a consistent copy, no temp file left behind
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-backup-'));
  const db = new DatabaseSync(path.join(dir, 'estimation.db'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x TEXT); INSERT INTO t VALUES('Test row');");
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = path.join(dir, 'backups');
  assert.deepStrictEqual(fs.readdirSync(out), [today], 'one backup, no .tmp left');
  const b = new DatabaseSync(path.join(out, today), { readOnly: true });
  assert.strictEqual(b.prepare('SELECT x FROM t').get().x, 'Test row');
  b.close(); db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// failure: non-zero exit, a line in backups/backup-errors.log, no half-written backup under the real name
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-backup-'));
  const db = new DatabaseSync(path.join(dir, 'estimation.db'));
  db.exec("CREATE TABLE t(x TEXT); INSERT INTO t VALUES('Test row');");
  db.close();
  const out = path.join(dir, 'backups');
  fs.mkdirSync(path.join(out, today + '.tmp'), { recursive: true });   // the temp path is blocked: the copy cannot be written
  const r = run(dir);
  assert.notStrictEqual(r.status, 0, 'a failed backup exits non-zero');
  assert.strictEqual(fs.existsSync(path.join(out, today)), false, 'no backup under the final name');
  const log = fs.readFileSync(path.join(out, 'backup-errors.log'), 'utf8').trim().split('\n');
  assert.strictEqual(log.length, 1); assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(log[0]) && /backup failed/.test(log[0]), log[0]);
  run(dir);
  assert.strictEqual(fs.readFileSync(path.join(out, 'backup-errors.log'), 'utf8').trim().split('\n').length, 2, 'appended, not overwritten');
  fs.rmSync(dir, { recursive: true, force: true });
}
// drawings: every <sha>.dxf is mirrored into backups/drawings; only missing ones are copied; nothing is ever deleted there
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-backup-'));
  const db = new DatabaseSync(path.join(dir, 'estimation.db'));
  db.exec("CREATE TABLE t(x TEXT); INSERT INTO t VALUES('Test row');"); db.close();
  const dd = path.join(dir, 'drawings'), bd = path.join(dir, 'backups', 'drawings');
  fs.mkdirSync(dd);
  const name = c => c.repeat(64);
  fs.writeFileSync(path.join(dd, name('a') + '.dxf'), 'first drawing');
  fs.writeFileSync(path.join(dd, name('b') + '.dxf'), 'second drawing');
  for (const f of [name('a') + '.json.gz', name('a') + '.summary.json.gz', name('a') + '.render.bin.gz', 'tmp-123.dxf', name('c') + '.dxf.tmp', 'notes.dxf', 'ABC.dxf']) fs.writeFileSync(path.join(dd, f), 'cache or junk');
  let r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(bd).sort(), [name('a') + '.dxf', name('b') + '.dxf'], 'only the .dxf files, no caches, no temp files');
  assert.strictEqual(fs.readFileSync(path.join(bd, name('a') + '.dxf'), 'utf8'), 'first drawing');
  // second run: nothing new is copied (mtime unchanged)
  const old = new Date(Date.now() - 3600e3); fs.utimesSync(path.join(bd, name('a') + '.dxf'), old, old);
  const m = f => fs.statSync(path.join(bd, f)).mtimeMs;
  const ma = m(name('a') + '.dxf'), mb = m(name('b') + '.dxf');
  r = run(dir); assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(m(name('a') + '.dxf'), ma, 'an existing copy is not rewritten'); assert.strictEqual(m(name('b') + '.dxf'), mb);
  // a drawing added later is copied; deleting a source leaves its backup in place
  fs.writeFileSync(path.join(dd, name('d') + '.dxf'), 'third drawing');
  fs.rmSync(path.join(dd, name('a') + '.dxf'));
  r = run(dir); assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(bd).sort(), [name('a') + '.dxf', name('b') + '.dxf', name('d') + '.dxf'], 'new one copied, the one deleted at the source is kept');
  fs.rmSync(dir, { recursive: true, force: true });
}

// a drawings failure keeps the database copy that already succeeded, is logged, and exits non-zero
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-backup-'));
  const db = new DatabaseSync(path.join(dir, 'estimation.db'));
  db.exec("CREATE TABLE t(x TEXT); INSERT INTO t VALUES('Test row');"); db.close();
  const dd = path.join(dir, 'drawings'), bd = path.join(dir, 'backups', 'drawings'), out = path.join(dir, 'backups');
  fs.mkdirSync(dd); fs.mkdirSync(bd, { recursive: true });
  const n1 = '1'.repeat(64) + '.dxf', n2 = '2'.repeat(64) + '.dxf';
  fs.writeFileSync(path.join(dd, n1), 'one'); fs.writeFileSync(path.join(dd, n2), 'two');
  fs.mkdirSync(path.join(bd, n1 + '.tmp'));   // blocks the temp path of the first copy
  const r = run(dir);
  assert.notStrictEqual(r.status, 0, 'a failed drawings copy exits non-zero');
  assert.ok(fs.existsSync(path.join(out, today)), 'the database copy is kept');
  assert.strictEqual(fs.existsSync(path.join(bd, n1)), false, 'no half-written drawing under the real name');
  assert.ok(/drawing backup of 1{64}\.dxf failed/.test(fs.readFileSync(path.join(out, 'backup-errors.log'), 'utf8')), 'logged');
  assert.strictEqual(fs.readFileSync(path.join(bd, n2), 'utf8'), 'two', 'a bad first file does not stop the rest');
  fs.rmSync(dir, { recursive: true, force: true });
}
// a damaged copy (different size) is replaced via .tmp; an intact one is left alone
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-backup-'));
  const db = new DatabaseSync(path.join(dir, 'estimation.db'));
  db.exec("CREATE TABLE t(x TEXT)"); db.close();
  const dd = path.join(dir, 'drawings'), bd = path.join(dir, 'backups', 'drawings'), f = '9'.repeat(64) + '.dxf';
  fs.mkdirSync(dd); fs.mkdirSync(bd, { recursive: true });
  fs.writeFileSync(path.join(dd, f), 'complete drawing content'); fs.writeFileSync(path.join(bd, f), 'complete dra');
  const r = run(dir); assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(bd, f), 'utf8'), 'complete drawing content', 'truncated copy repaired');
  assert.deepStrictEqual(fs.readdirSync(bd), [f], 'no .tmp left');
  fs.rmSync(dir, { recursive: true, force: true });
}
// final review item 2: a stopped server leaves no WAL to replay. On SIGINT / SIGTERM the server checkpoints the WAL into
// estimation.db (TRUNCATE) and closes the database, so a restore that replaces estimation.db never meets a stale -wal.
(async () => {
  const { spawn } = require('child_process'), net = require('net');
  const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-backup-wal-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'server.js')],
      { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ERP_SYNC_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    const exited = new Promise(ok => child.on('exit', (code, signal) => ok({ code, signal })));
    for (const t0 = Date.now(); !out.includes('Trigon Estimation on');) {
      if (Date.now() - t0 > 10000) { child.kill('SIGKILL'); throw new Error('server did not start: ' + out); }
      await new Promise(f => setTimeout(f, 20));
    }
    // a write through the server: the WAL holds frames that are not in estimation.db yet
    const r = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret12' }) });
    assert.strictEqual(r.status, 200, sig + ' setup');
    const wal = path.join(dir, 'estimation.db-wal');
    assert.ok(fs.existsSync(wal) && fs.statSync(wal).size > 0, sig + ': the WAL has frames while the server runs');
    child.kill(sig);
    const ex = await exited;
    assert.strictEqual(ex.code, 0, sig + ': clean exit ' + JSON.stringify(ex) + ' ' + out);
    assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, sig + ': WAL checkpointed (size ' + (fs.existsSync(wal) ? fs.statSync(wal).size : 'absent') + ')');
    // estimation.db alone (no -wal, no -shm) has the data
    for (const f of ['estimation.db-wal', 'estimation.db-shm']) fs.rmSync(path.join(dir, f), { force: true });
    const b = new DatabaseSync(path.join(dir, 'estimation.db'), { readOnly: true });
    assert.strictEqual(b.prepare("SELECT COUNT(*) n FROM users WHERE username='admin'").get().n, 1, sig + ': the write is in estimation.db');
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // R9: PDF and image originals uploaded through the app are mirrored too (<sha>.pdf / .png / .jpg), byte for byte
  {
    const { makePdf, makePng, jpegHeader } = require('./test/fixtures/make-takeoff.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-backup-pdf-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'server.js')],
      { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ERP_SYNC_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    const exited = new Promise(ok => child.on('exit', ok));
    try {
      for (const t0 = Date.now(); !out.includes('Trigon Estimation on');) {
        if (Date.now() - t0 > 10000) throw new Error('server did not start: ' + out);
        await new Promise(f => setTimeout(f, 20));
      }
      const api = `http://127.0.0.1:${port}/api/`;
      const s = await fetch(api + 'setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret12' }) });
      assert.strictEqual(s.status, 200);
      const cookie = s.headers.get('set-cookie').split(';')[0];
      const t = await fetch(api + 'tenders', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ title: 'Test Backup Plans', kind: 'rta' }) });
      assert.strictEqual(t.status, 200);
      const tid = (await t.json()).id;
      const files = [[makePdf(), '.pdf'], [makePng(32, 24), '.png'], [jpegHeader(640, 480), '.jpg']];
      for (const [body, ext] of files) {
        const u = await fetch(api + `tenders/${tid}/drawings?name=plan${ext}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie }, body });
        assert.strictEqual(u.status, 202, ext + ' upload: ' + await u.text());
      }
      child.kill('SIGTERM');
      await exited;
      const r = run(dir);
      assert.strictEqual(r.status, 0, r.stderr);
      const sha = b => require('crypto').createHash('sha256').update(b).digest('hex');
      const bd = path.join(dir, 'backups', 'drawings');
      assert.deepStrictEqual(fs.readdirSync(bd).sort(), files.map(([b, ext]) => sha(b) + ext).sort(), 'each original mirrored under its content-addressed name');
      for (const [b, ext] of files) assert.ok(fs.readFileSync(path.join(bd, sha(b) + ext)).equals(b), ext + ': same bytes');
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('backup ok');
})().catch(e => { console.error(e); process.exit(1); });
