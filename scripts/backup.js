// Daily copy of data/estimation.db to data/backups/estimation-YYYYMMDD.db; keeps the last 14. Run by Estimation-Start.bat
// each time the app starts (at most one copy per day). The copy is written to a .tmp file and renamed, so a failed run
// never leaves a half-written backup under the real name. A failure is appended to data/backups/backup-errors.log
// and the script exits non-zero.
// The drawings (data/drawings/<sha>.dxf, content-addressed and immutable) are mirrored into data/backups/drawings: only files
// that are missing there are copied (via .tmp + rename) and nothing in the mirror is ever deleted. Caches are not copied; they are rebuilt.
// A failure in one part does not stop the other.
const fs = require('fs'), path = require('path');
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const src = path.join(dir, 'estimation.db');
if (!fs.existsSync(src)) process.exit(0);
const out = path.join(dir, 'backups');
const fail = [];
const note = (what, e) => fail.push(`${new Date().toISOString()} ${what} failed: ${String(e && e.message || e).replace(/\s+/g, ' ')}`);
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
} catch (e) { note('backup', e); }
try {
  const from = path.join(dir, 'drawings'), to = path.join(out, 'drawings');
  if (fs.existsSync(from)) {
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from).filter(f => /^[0-9a-f]{64}\.dxf$/.test(f))) {
      try {   // one bad file must not stop the rest
        const dest = path.join(to, f);
        // content-addressed: a copy of a different size is damaged and is replaced (via .tmp, never deleted first)
        if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(path.join(from, f)).size) continue;
        fs.rmSync(dest + '.tmp', { force: true });   // a leftover from an interrupted run
        fs.copyFileSync(path.join(from, f), dest + '.tmp');
        fs.renameSync(dest + '.tmp', dest);
      } catch (e) { note('drawing backup of ' + f, e); }
    }
  }
} catch (e) { note('drawings backup', e); }
if (fail.length) {
  try { fs.mkdirSync(out, { recursive: true }); fs.appendFileSync(path.join(out, 'backup-errors.log'), fail.join('\n') + '\n'); } catch (e2) { /* reported below */ }
  console.error(fail.join('\n'));
  process.exit(1);
}
