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
  assert.ok(/backup failed/.test(fs.readFileSync(path.join(out, 'backup-errors.log'), 'utf8')), 'logged');
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('backup ok');
