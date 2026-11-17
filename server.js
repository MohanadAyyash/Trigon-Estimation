// Trigon Estimation: HTTP server, schema, auth, users, settings, audit. No framework, no dependencies.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { round2, num } = require('./lib/money');

const PORT = +process.env.PORT || 3100, HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'estimation.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT);
`);
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');

const ROLES = ['admin', 'qs', 'viewer'];
const DEFAULTS = { erp_db_path: '..\\Trigon-ERP\\data\\erp.db', work_days: 26, work_hours: 8, finance_rate_pct: 8, min_profit_pct: 5, default_margin_pct: 12, stale_days: 7, material_stale_days: 60, sync_minutes: 60 };

// ---- helpers ----------------------------------------------------------------
const bad = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }); };
const need = (me, ...roles) => { if (!me || !roles.includes(me.role)) bad('forbidden', 403); };
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const readBody = (req, max = 20e6) => req._body !== undefined ? Promise.resolve(req._body) : new Promise((ok, no) => {
  let b = '', over = false;
  req.on('data', c => { if (over) return; b += c; if (b.length > max) { over = true; b = ''; no(Object.assign(new Error('the request is too large'), { status: 413 })); req.resume(); } });
  req.on('end', () => { if (over) return; try { const j = b ? JSON.parse(b) : {}; if (!j || typeof j !== 'object' || Array.isArray(j)) throw 0; ok(req._body = j); } catch (e) { no(Object.assign(new Error('invalid request body'), { status: 400 })); } });
  req.on('error', no);
});
// a reply sent before the request body has fully arrived (a refusal): close the connection once it is sent, so a
// large upload stops instead of being read and thrown away
const closeEarly = (req, res) => { if (req.complete) return {}; res.once('finish', () => setImmediate(() => req.destroy())); return { Connection: 'close' }; };
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const audit = (user, action, entity, id, detail) => db.prepare('INSERT INTO audit_log(at,user,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)')
  .run(new Date().toISOString(), user && user.username || (typeof user === 'string' ? user : null), action, entity || null, id == null ? null : String(id), detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
const getSettings = () => {
  const s = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key,value FROM settings').all()) {
    if (!(r.key in DEFAULTS)) continue;
    s[r.key] = typeof DEFAULTS[r.key] === 'number' ? Number(r.value) : r.value;
  }
  return s;
};
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

const ctx = { db, send, bad, need, readBody, audit, getSettings, setSetting, round2, num, ROLES, DATA_DIR };

// ---- auth -------------------------------------------------------------------
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || process.env.SECURE_COOKIES === '1';
const cookie = (req, token, maxAge) => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const pwMatches = (pw, u) => { const a = Buffer.from(hashPw(String(pw || ''), u.salt)), b = Buffer.from(u.pw); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const FAIL_MAX = 5, LOCK_MS = 15 * 60e3, fails = new Map();   // username -> [timestamps of failed logins]
const recentFails = key => { const t = (fails.get(key) || []).filter(x => Date.now() - x < LOCK_MS); if (t.length) fails.set(key, t); else fails.delete(key); return t; };
const locked = key => recentFails(key).length >= FAIL_MAX;
const createSession = userId => { const token = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)').run(token, userId, Date.now()); return token; };
const sessionToken = req => { const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); return m ? m[1] : null; };
function sessionUser(req) {
  const t = sessionToken(req); if (!t) return null;
  const s = db.prepare('SELECT user_id FROM sessions WHERE token=? AND created>?').get(t, Date.now() - 30 * 864e5);
  return s ? db.prepare('SELECT id,username,role FROM users WHERE id=? AND disabled=0').get(s.user_id) || null : null;
}
const newSalt = () => crypto.randomBytes(16).toString('hex');
const checkPw = password => { if (typeof password !== 'string' || password.length < 6) bad('password must be at least 6 characters'); };
const createUser = (username, password, role) => {
  username = String(username || '').trim();
  if (!username) bad('username is required');
  if (!ROLES.includes(role)) bad('role must be one of ' + ROLES.join(', '));
  checkPw(password);
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) bad('username already exists');
  const salt = newSalt();
  return db.prepare('INSERT INTO users(username,pw,salt,role,created) VALUES(?,?,?,?,?)').run(username, hashPw(password, salt), salt, role, new Date().toISOString()).lastInsertRowid;
};

// admin: change a user's role, disable/enable, reset the password. Every change ends that user's sessions; the change
// that would leave no active admin is refused.
async function updateUser(req, idStr, me) {
  const u = /^\d+$/.test(idStr) ? db.prepare('SELECT * FROM users WHERE id=?').get(Number(idStr)) : null;
  if (!u) bad('user not found', 404);
  const b = await readBody(req);
  for (const k of Object.keys(b)) if (!['role', 'disabled', 'password'].includes(k)) bad('unknown field: ' + k);
  if (!Object.keys(b).length) bad('nothing to change: role, disabled or password');
  const after = {};
  if ('role' in b) { if (!ROLES.includes(b.role)) bad('role must be one of ' + ROLES.join(', ')); after.role = b.role; }
  if ('disabled' in b) { if (typeof b.disabled !== 'boolean') bad('disabled must be true or false'); after.disabled = b.disabled ? 1 : 0; }
  if ('password' in b) { checkPw(b.password); after.password_reset = true; }
  const role = after.role ?? u.role, disabled = after.disabled ?? u.disabled;
  tx(() => {
    if (u.role === 'admin' && !u.disabled && (role !== 'admin' || disabled)
      && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0 AND id<>?").get(u.id).n === 0) bad('the last active admin cannot be demoted or disabled', 409);
    if ('password' in b) { const salt = newSalt(); db.prepare('UPDATE users SET pw=?, salt=? WHERE id=?').run(hashPw(b.password, salt), salt, u.id); }
    db.prepare('UPDATE users SET role=?, disabled=? WHERE id=?').run(role, disabled, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    audit(me, 'update', 'users', u.id, { username: u.username, before: { role: u.role, disabled: u.disabled }, after });
  });
  return db.prepare('SELECT id,username,role,disabled,created FROM users WHERE id=?').get(u.id);
}

// ---- modules (later tasks append require('./modules/x') here) -------------------
const MODULES = [require('./modules/costs'), require('./modules/library'), require('./modules/tenders'), require('./modules/drawings')].map(f => f(ctx));

async function api(req, res, url) {
  const parts = url.pathname.split('/').slice(2), [a] = parts, method = req.method;
  if (a === 'status' && method === 'GET') return send(res, 200, { setup: db.prepare('SELECT COUNT(*) n FROM users').get().n === 0, user: sessionUser(req) });
  if (a === 'setup' && method === 'POST') {
    if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return send(res, 403, { error: 'already set up' });
    const { username, password } = await readBody(req);
    // re-check after the await, in the same synchronous block as the insert (two concurrent setups must not both win)
    if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return send(res, 403, { error: 'already set up' });
    const id = createUser(username, password, 'admin');
    audit({ username: String(username).trim() }, 'create', 'users', id, { role: 'admin', setup: true });
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': cookie(req, createSession(id), 2592000) });
  }
  if (a === 'login' && method === 'POST') {
    const { username, password } = await readBody(req), key = String(username || '').toLowerCase();
    if (locked(key)) return send(res, 429, { error: 'too many failed attempts, try again in 15 minutes' });
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || ''));
    if (!u || !pwMatches(password, u)) { recentFails(key); fails.set(key, [...(fails.get(key) || []), Date.now()]); return send(res, 401, { error: 'invalid credentials' }); }
    fails.delete(key);
    if (u.disabled) return send(res, 403, { error: 'this account is disabled' });
    db.prepare('DELETE FROM sessions WHERE created<=?').run(Date.now() - 30 * 864e5);   // expired sessions
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': cookie(req, createSession(u.id), 2592000) });
  }
  if (a === 'logout' && method === 'POST') {
    const t = sessionToken(req); if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': cookie(req, '', 0) });
  }

  const me = sessionUser(req);
  if (!me) return send(res, 401, { error: 'unauthorized' }, closeEarly(req, res));
  if (a === 'users') {
    need(me, 'admin');
    if (parts.length === 1 && method === 'GET') return send(res, 200, db.prepare('SELECT id,username,role,disabled,created FROM users ORDER BY id').all());
    if (parts.length === 1 && method === 'POST') {
      const b = await readBody(req);
      const id = tx(() => {
        const uid = createUser(b.username, b.password, b.role);
        audit(me, 'create', 'users', uid, { username: String(b.username).trim(), role: b.role });
        return uid;
      });
      return send(res, 200, { id });
    }
    if (parts.length === 2 && method === 'PUT') return send(res, 200, await updateUser(req, parts[1], me));
  }
  if (a === 'settings') {
    if (method === 'GET') {
      const s = getSettings();
      if (me.role !== 'admin') delete s.erp_db_path;   // a server file path is for the admin only
      return send(res, 200, s);
    }
    if (method === 'PUT') {
      need(me, 'admin');
      const b = await readBody(req), changed = {};
      for (const k of Object.keys(b)) {
        if (!(k in DEFAULTS)) bad('unknown setting: ' + k);
        let v = b[k];
        if (typeof DEFAULTS[k] === 'number') { v = num(v); if (v === null || v < 0) bad(`${k} must be a non-negative number`); }
        else v = String(v);
        changed[k] = v;
      }
      tx(() => {
        for (const k in changed) setSetting(k, changed[k]);
        audit(me, 'update', 'settings', null, changed);
      });
      return send(res, 200, getSettings());
    }
  }
  if (a === 'audit' && method === 'GET') {
    need(me, 'admin');
    const ex = url.searchParams.get('exclude');
    if (ex !== null && ex !== 'sync') bad("exclude must be 'sync'");
    // ?exclude=sync leaves out the hourly ERP sync rows (successful and failed) so the other changes are readable
    return send(res, 200, db.prepare(`SELECT * FROM audit_log ${ex === 'sync' ? "WHERE action NOT IN ('sync','sync_failed') " : ''}ORDER BY id DESC LIMIT 500`).all());
  }
  for (const m of MODULES) if (await m.handle(req, res, url, parts, me)) return;
  return send(res, 404, { error: 'not found' });
}

// ---- static files -------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const PUB = path.join(__dirname, 'public');
// server code the browser also runs, served from its one source file (never copied under public/): the manual take-off
// formulas (UMD) behind the measuring tools' preview, and a measurement's formula text (the list and the Excel report)
const SHARED = { '/lib/takeoff/manual.js': path.join(__dirname, 'lib', 'takeoff', 'manual.js'), '/lib/takeoff/formula.js': path.join(__dirname, 'lib', 'takeoff', 'formula.js') };
function serveStatic(req, res, url) {
  let rel; try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'bad request'); }
  if (rel === '/') rel = '/index.html';
  const file = Object.hasOwn(SHARED, rel) ? SHARED[rel] : path.join(PUB, rel);
  if (!Object.hasOwn(SHARED, rel) && file !== PUB && !file.startsWith(PUB + path.sep)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => err ? send(res, 404, 'not found') : send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : e.message }, closeEarly(req, res));
    else if (!req.complete) req.destroy();
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Trigon Estimation on http://${HOST}:${PORT}`);
    ctx.costs.startScheduler();   // once now, then every sync_minutes (skipped when ERP_SYNC_DISABLED=1)
  });
  // stopped (Ctrl+C, a service stop, Ctrl+Break, or the command window closed on Windows: SIGHUP): fold the WAL into
  // estimation.db and close it, so the data folder holds the whole database in one file. Best effort: the restore steps
  // in README.md still delete a leftover -wal / -shm.
  const stop = () => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('could not checkpoint the database: ' + e.message); }
    try { db.close(); } catch (e) { console.error('could not close the database: ' + e.message); }
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, stop);
}
module.exports = { server, db, ctx };
