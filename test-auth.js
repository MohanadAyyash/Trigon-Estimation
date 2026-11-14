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
    // lockout: 5 failures per username -> 429, even with the right password
    for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', 'login', { username: 'qs1', password: 'nope' })).s, 401);
    assert.strictEqual((await call('POST', 'login', { username: 'qs1', password: 'secret12' })).s, 429);
    // logout
    assert.strictEqual((await call('POST', 'logout', null, admin)).s, 200);
    assert.strictEqual((await call('GET', 'settings', null, admin)).s, 401);
    console.log('auth ok'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
