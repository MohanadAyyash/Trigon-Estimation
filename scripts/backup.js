// Daily copy of data/estimation.db to data/backups/estimation-YYYYMMDD.db; keeps the last 14. Run by Estimation-Start.bat.
const fs = require('fs'), path = require('path');
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const src = path.join(dir, 'estimation.db');
if (!fs.existsSync(src)) process.exit(0);
const out = path.join(dir, 'backups');
fs.mkdirSync(out, { recursive: true });
const d = new Date(), p = n => String(n).padStart(2, '0');
const dest = path.join(out, `estimation-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.db`);
// VACUUM INTO gives a consistent copy even while the app is writing (WAL mode)
const { DatabaseSync } = require('node:sqlite');
if (!fs.existsSync(dest)) {
  const db = new DatabaseSync(src);
  try { db.prepare('VACUUM INTO ?').run(dest); } finally { db.close(); }
}
const old = fs.readdirSync(out).filter(f => /^estimation-\d{8}\.db$/.test(f)).sort().slice(0, -14);
for (const f of old) fs.unlinkSync(path.join(out, f));
