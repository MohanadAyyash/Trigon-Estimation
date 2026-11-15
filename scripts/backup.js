// Daily copy of data/estimation.db to data/backups/estimation-YYYYMMDD.db; keeps the last 14. Run by Estimation-Start.bat
// each time the app starts (at most one copy per day). The copy is written to a .tmp file and renamed, so a failed run
// never leaves a half-written backup under the real name. A failure is appended to data/backups/backup-errors.log
// and the script exits non-zero.
const fs = require('fs'), path = require('path');
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const src = path.join(dir, 'estimation.db');
if (!fs.existsSync(src)) process.exit(0);
const out = path.join(dir, 'backups');
try {
  fs.mkdirSync(out, { recursive: true });
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const dest = path.join(out, `estimation-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.db`), tmp = dest + '.tmp';
  // VACUUM INTO gives a consistent copy even while the app is writing (WAL mode); the source is only read
  const { DatabaseSync } = require('node:sqlite');
  if (!fs.existsSync(dest)) {
    fs.rmSync(tmp, { force: true });   // a leftover from an interrupted run
    const db = new DatabaseSync(src, { readOnly: true });
    try { db.prepare('VACUUM INTO ?').run(tmp); } finally { db.close(); }
    fs.renameSync(tmp, dest);
  }
  const old = fs.readdirSync(out).filter(f => /^estimation-\d{8}\.db$/.test(f)).sort().slice(0, -14);
  for (const f of old) fs.unlinkSync(path.join(out, f));
} catch (e) {
  const msg = `${new Date().toISOString()} backup failed: ${String(e && e.message || e).replace(/\s+/g, ' ')}`;
  try { fs.mkdirSync(out, { recursive: true }); fs.appendFileSync(path.join(out, 'backup-errors.log'), msg + '\n'); } catch (e2) { /* reported below */ }
  console.error(msg);
  process.exit(1);
}
