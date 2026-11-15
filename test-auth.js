// Auth, users, settings, audit, money helpers: node --no-warnings test-auth.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'est-auth-'));
const { server } = require('./server.js');
const { round2, num } = require('./lib/money.js');

assert.strictEqual(num('1,250.50'), 1250.5);
assert.strictEqual(num(' 1 250 '), 1250);
assert.strictEqual(num(''), null);
assert.strictEqual(num(null), null);
assert.strictEqual(num('abc'), null);
assert.strictEqual(num(7), 7);
assert.strictEqual(round2(1.005), 1.01);

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  const call = async (m, u, b, ck) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || '' }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie');
    return { s: r.status, j: await r.json().catch(() => null), ck: sc ? sc.split(';')[0] : '', raw: sc };
  };
  try {
    assert.strictEqual((await call('GET', 'status')).j.setup, true);
    assert.strictEqual((await call('GET', 'settings')).s, 401);
    // two concurrent first-admin setups: exactly one wins
    const race = await Promise.all([call('POST', 'setup', { username: 'admin', password: 'secret12' }), call('POST', 'setup', { username: 'admin2', password: 'secret12' })]);
    assert.deepStrictEqual(race.map(r => r.s).sort(), [200, 403], 'concurrent setup: one 200, one 403');
    assert.strictEqual(require('./server.js').db.prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'exactly one user');
    const su = race.find(r => r.s === 200);
    // non-object JSON bodies are 400, not 500
    for (const raw of ['null', '[]', '5']) assert.strictEqual((await fetch(base + 'login', { method: 'POST', body: raw })).status, 400, 'body ' + raw);
    assert.ok(/HttpOnly/.test(su.raw) && /SameSite=Strict/.test(su.raw), 'cookie flags');
    const admin = su.ck;
    assert.strictEqual((await call('POST', 'setup', { username: 'x', password: 'secret12' })).s, 403);
    assert.strictEqual((await call('POST', 'login', { username: 'admin', password: 'wrong' })).s, 401);
    assert.strictEqual((await call('POST', 'users', { username: 'qs1', password: 'secret12', role: 'qs' }, admin)).s, 200);
    assert.strictEqual((await call('POST', 'users', { username: 'qs1', password: 'secret12', role: 'qs' }, admin)).s, 400, 'duplicate');
    assert.strictEqual((await call('POST', 'users', { username: 'bad', password: 'secret12', role: 'root' }, admin)).s, 400, 'bad role');
    const l = await call('POST', 'login', { username: 'qs1', password: 'secret12' });
    assert.strictEqual(l.s, 200); const qs = l.ck;
    assert.strictEqual((await call('PUT', 'settings', { work_days: 20 }, qs)).s, 403);
    const g = await call('GET', 'settings', null, qs);
    assert.strictEqual(g.s, 200); assert.strictEqual(g.j.work_days, 26);
    assert.strictEqual((await call('GET', 'users', null, qs)).s, 403);
    assert.strictEqual((await call('GET', 'audit', null, qs)).s, 403);
    assert.strictEqual((await call('PUT', 'settings', { work_days: 24 }, admin)).s, 200);
    assert.strictEqual((await call('GET', 'settings', null, qs)).j.work_days, 24);
    const au = await call('GET', 'audit', null, admin);
    assert.strictEqual(au.s, 200);
    assert.ok(au.j.some(e => e.action === 'create' && e.entity === 'users'), 'audit has users create');
    assert.ok(!JSON.stringify(au.j).includes('secret12'), 'no password in audit');
    assert.ok(!JSON.stringify((await call('GET', 'users', null, admin)).j).match(/"pw"|"salt"/), 'no hash leaked');
    // ---- user management: role, disable, password reset (admin only); sessions end on every change ----
    const db = require('./server.js').db;
    const login = async (u, pw) => call('POST', 'login', { username: u, password: pw });
    assert.strictEqual((await call('POST', 'users', { username: 'qs2', password: 'secret12', role: 'qs' }, admin)).s, 200);
    const qs2Id = db.prepare("SELECT id FROM users WHERE username='qs2'").get().id, adminId = db.prepare("SELECT id FROM users WHERE username=?").get(su === race[0] ? 'admin' : 'admin2').id;
    let qs2 = (await login('qs2', 'secret12')).ck;
    assert.strictEqual((await call('GET', 'settings', null, qs2)).s, 200);
    assert.strictEqual((await call('PUT', `users/${qs2Id}`, { role: 'viewer' }, qs2)).s, 403, 'only admin manages users');
    assert.strictEqual((await call('PUT', 'users/99999', { role: 'viewer' }, admin)).s, 404);
    for (const b of [{ role: 'root' }, { disabled: 'yes' }, { password: '123' }, { username: 'x' }, {}])
      assert.strictEqual((await call('PUT', `users/${qs2Id}`, b, admin)).s, 400, 'bad user change ' + JSON.stringify(b));
    // role change: sessions end, audited
    assert.strictEqual((await call('PUT', `users/${qs2Id}`, { role: 'viewer' }, admin)).s, 200);
    assert.strictEqual((await call('GET', 'settings', null, qs2)).s, 401, 'role change ends the sessions');
    qs2 = (await login('qs2', 'secret12')).ck;
    assert.strictEqual((await call('GET', 'status', null, qs2)).j.user.role, 'viewer');
    // password reset: sessions end, old password refused, new one works; never in the audit log
    assert.strictEqual((await call('PUT', `users/${qs2Id}`, { password: 'newpass99' }, admin)).s, 200);
    assert.strictEqual((await call('GET', 'settings', null, qs2)).s, 401, 'password reset ends the sessions');
    assert.strictEqual((await login('qs2', 'secret12')).s, 401);
    qs2 = (await login('qs2', 'newpass99')).ck;
    assert.strictEqual((await call('GET', 'settings', null, qs2)).s, 200);
    // disable: sessions end, cannot sign in; enable again
    assert.strictEqual((await call('PUT', `users/${qs2Id}`, { disabled: true }, admin)).s, 200);
    assert.strictEqual((await call('GET', 'settings', null, qs2)).s, 401, 'disabling ends the sessions');
    assert.strictEqual((await login('qs2', 'newpass99')).s, 403, 'a disabled user cannot sign in');
    assert.strictEqual((await call('GET', 'users', null, admin)).j.find(u => u.id === qs2Id).disabled, 1);
    assert.strictEqual((await call('PUT', `users/${qs2Id}`, { disabled: false }, admin)).s, 200);
    assert.strictEqual((await login('qs2', 'newpass99')).s, 200);
    const ua = db.prepare("SELECT detail FROM audit_log WHERE entity='users' AND action='update' AND entity_id=? ORDER BY id").all(String(qs2Id)).map(r => JSON.parse(r.detail));
    assert.deepStrictEqual(ua.map(d => Object.keys(d.after || {}).sort().join()), ['role', 'password_reset', 'disabled', 'disabled']);
    assert.ok(!JSON.stringify(ua).includes('newpass99'), 'no password in the audit log');
    // the last active admin cannot demote or disable themselves; with a second admin they can be changed
    const lastAdmin = await call('PUT', `users/${adminId}`, { role: 'qs' }, admin);
    assert.strictEqual(lastAdmin.s, 409, 'last admin cannot be demoted'); assert.ok(/admin/.test(lastAdmin.j.error));
    assert.strictEqual((await call('PUT', `users/${adminId}`, { disabled: true }, admin)).s, 409, 'last admin cannot be disabled');
    assert.strictEqual((await call('GET', 'settings', null, admin)).s, 200, 'refused change ends nothing');
    assert.strictEqual((await call('POST', 'users', { username: 'admin3', password: 'secret12', role: 'admin' }, admin)).s, 200);
    const a3 = db.prepare("SELECT id FROM users WHERE username='admin3'").get().id;
    assert.strictEqual((await call('PUT', `users/${a3}`, { disabled: true }, admin)).s, 200, 'another admin can be disabled while one stays active');
    assert.strictEqual((await call('PUT', `users/${adminId}`, { role: 'qs' }, admin)).s, 409, 'a disabled admin does not count');
    // expired sessions are purged on login
    db.prepare('INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)').run('ab'.repeat(24), qs2Id, Date.now() - 31 * 864e5);
    await login('qs2', 'newpass99');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM sessions WHERE token=?').get('ab'.repeat(24)).n, 0, 'expired session purged');

    // the audit row is written in the same transaction as the change: if it cannot be written, nothing changes
    const auditDown = async (entities, fn) => {
      db.exec(`CREATE TRIGGER audit_down BEFORE INSERT ON audit_log WHEN NEW.entity IN (${entities.map(e => `'${e}'`).join(',')}) BEGIN SELECT RAISE(ABORT, 'test: audit log down'); END;`);
      const ce = console.error; console.error = () => {};   // the expected 500s would log a stack
      try { await fn(); } finally { console.error = ce; db.exec('DROP TRIGGER audit_down'); }
    };
    await auditDown(['settings'], async () => { assert.strictEqual((await call('PUT', 'settings', { work_days: 22 }, admin)).s, 500); });
    assert.strictEqual((await call('GET', 'settings', null, admin)).j.work_days, 24, 'settings unchanged without the audit row');

    // lockout: 5 failures per username -> 429, even with the right password
    for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', 'login', { username: 'qs1', password: 'nope' })).s, 401);
    assert.strictEqual((await call('POST', 'login', { username: 'qs1', password: 'secret12' })).s, 429);
    // logout
    assert.strictEqual((await call('POST', 'logout', null, admin)).s, 200);
    assert.strictEqual((await call('GET', 'settings', null, admin)).s, 401);
    console.log('auth ok'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
