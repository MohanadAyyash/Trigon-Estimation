// Costs API, ERP sync, material prices: node --no-warnings test-sync.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-sync-'));
process.env.DATA_DIR = path.join(dir, 'data');
process.env.ERP_SYNC_DISABLED = '1';
const { server, db, ctx } = require('./server.js');
const { makeErp } = require('./test/fixtures/make-erp.js');

const erpFile = path.join(dir, 'erp.db');
makeErp(erpFile, {
  employees: [
    { id: 11, name: 'Test Mason A', designation: 'Mason' }, { id: 12, name: 'Test Mason B', designation: 'Mason' },
    { id: 13, name: 'Test Mason C', designation: 'Mason' }, { id: 14, name: 'Test Foreman D', designation: 'Foreman' },
  ],
  payroll: [11, 12, 13].map((e, i) => ({ id: i + 1, month: '2026-10', employee_id: e, gross: 3000, status: 'final' }))
    .concat([{ id: 4, month: '2026-10', employee_id: 14, gross: 6000, status: 'final' }]),
  bills: [{ id: 1, date: '2026-10-01', category: 'Rent', amount: 10000 }],
  purchase_orders: [{ id: 1, date: '2026-09-01', status: 'approved', items: JSON.stringify([{ description: 'Interlock Tile 80mm ', unit: 'm2', rate: 30 }, { description: 'Other', unit: 'bag', rate: 9 }]) }],
  projects: [{ id: 1, name: 'Fake Project One', contract_value: 1200000, start_date: '2026-01-01', end_date: '2026-12-31', status: 'active' }],
});

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  const call = async (m, u, b, ck) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || '' }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie');
    return { s: r.status, j: await r.json().catch(() => null), ck: sc ? sc.split(';')[0] : '' };
  };
  try {
    const admin = (await call('POST', 'setup', { username: 'admin', password: 'secret12' })).ck;
    await call('POST', 'users', { username: 'qs1', password: 'secret12', role: 'qs' }, admin);
    const qs = (await call('POST', 'login', { username: 'qs1', password: 'secret12' })).ck;
    await call('PUT', 'settings', { erp_db_path: erpFile }, admin);

    // no snapshot yet
    assert.strictEqual((await call('GET', 'costs/snapshot', null, admin)).s, 404);
    let st = (await call('GET', 'costs/status', null, qs)).j;
    assert.strictEqual(st.last_ok, null); assert.strictEqual(st.stale, true);

    // config: admin only
    assert.strictEqual((await call('PUT', 'costs/config', { trade_map: { Mason: 'Mason', Foreman: 'Foreman' } }, qs)).s, 403);
    assert.strictEqual((await call('GET', 'costs/config', null, qs)).s, 403);
    assert.strictEqual((await call('PUT', 'costs/config', { trade_map: [1] }, admin)).s, 400);
    assert.strictEqual((await call('PUT', 'costs/config', { nope: {} }, admin)).s, 400);
    const cfg = await call('PUT', 'costs/config', { category_map: { Rent: 'overhead' }, trade_map: { Mason: 'Mason', Foreman: 'Foreman' }, trade_groups: { Mason: 'Site', Foreman: 'Site' } }, admin);
    assert.strictEqual(cfg.s, 200); assert.strictEqual(cfg.j.trade_map.Mason, 'Mason'); assert.deepStrictEqual(cfg.j.overrides, {});
    assert.strictEqual((await call('GET', 'costs/config', null, admin)).j.category_map.Rent, 'overhead');

    // sync only by admin
    assert.strictEqual((await call('POST', 'costs/sync', null, qs)).s, 403);
    const ok = await call('POST', 'costs/sync', null, admin);
    assert.strictEqual(ok.s, 200, JSON.stringify(ok.j)); assert.ok(ok.j.id);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM snapshots WHERE ok=1 AND id=?').get(ok.j.id).n, 1, 'HTTP sync wrote an ok row');
    // every content assertion below runs on a snapshot built at a fixed clock, so the suite does not depend on today's date
    assert.strictEqual((await ctx.costs.sync({ now: new Date('2026-11-14T10:00:00Z') })).ok, true);
    const snapA = await call('GET', 'costs/snapshot', null, admin);
    assert.strictEqual(snapA.s, 200);
    assert.ok(Array.isArray(snapA.j.trades) && snapA.j.trades.length >= 1, 'admin snapshot has trades');
    assert.ok(snapA.j.oh_parts, 'admin sees oh_parts');
    // QS view goes through viewSnapshot
    const snapQ = await call('GET', 'costs/snapshot', null, qs);
    assert.strictEqual(snapQ.s, 200); assert.strictEqual(snapQ.j.oh_parts, undefined);
    const foreman = snapQ.j.trades.find(t => t.trade === 'Foreman'); assert.strictEqual(foreman.headcount, undefined);
    // privacy: no names stored
    const stored = db.prepare('SELECT data FROM snapshots').all().map(r => r.data).join('');
    assert.ok(stored.length > 100 && !stored.includes('Test Mason A'), 'no employee names in stored snapshot');

    st = (await call('GET', 'costs/status', null, qs)).j;
    assert.ok(st.last_ok && st.last_attempt && st.last_error === null);
    const lastOk = st.last_ok, okId = st.last_ok_id;

    // failed sync: missing file -> 502, previous snapshot stays
    await call('PUT', 'settings', { erp_db_path: path.join(dir, 'missing.db') }, admin);
    const bad = await call('POST', 'costs/sync', null, admin);
    assert.strictEqual(bad.s, 502); assert.ok(/ERP database not found/.test(bad.j.error)); assert.ok(!/\n\s+at /.test(bad.j.error));
    st = (await call('GET', 'costs/status', null, admin)).j;
    assert.strictEqual(st.last_ok, lastOk); assert.strictEqual(st.last_ok_id, okId);
    assert.ok(/ERP database not found/.test(st.last_error));
    assert.deepStrictEqual((await call('GET', 'costs/snapshot', null, admin)).j, snapA.j, 'old snapshot still served');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM snapshots WHERE ok=0').get().n, 1);
    assert.strictEqual(ctx.costs.latest().id, okId);
    assert.strictEqual(ctx.costs.get(okId).id, okId);
    assert.strictEqual(ctx.costs.get(okId + 1), null, 'failed rows are not snapshots');
    const lg = (await call('GET', 'audit', null, admin)).j.map(a => a.action);
    assert.ok(lg.includes('sync') && lg.includes('sync_failed') && lg.includes('config'));
    // ctx.costs.sync with no overlap + recovery
    await call('PUT', 'settings', { erp_db_path: erpFile }, admin);
    const r = await ctx.costs.sync({ now: new Date('2026-11-14T10:00:00Z') });
    assert.strictEqual(r.ok, true);
    st = (await call('GET', 'costs/status', null, admin)).j; assert.strictEqual(st.last_error, null);

    // scheduler is off under ERP_SYNC_DISABLED=1
    let rows = db.prepare('SELECT COUNT(*) n FROM snapshots').get().n;
    ctx.costs.startScheduler();
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, rows, 'startScheduler does nothing when disabled');
    // overlap guard: two concurrent syncs -> one runs, the other is refused, one row written
    const fixed = new Date('2026-11-14T10:00:00Z');
    const res2 = await Promise.all([ctx.costs.sync({ now: fixed }), ctx.costs.sync({ now: fixed })]);
    assert.deepStrictEqual(res2.map(x => x.ok).sort(), [false, true], 'exactly one concurrent sync runs');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, rows + 1, 'only one row written');
    assert.strictEqual((await ctx.costs.sync({ now: fixed })).ok, true, 'guard released afterwards');

    // config values are validated
    for (const bodyBad of [{ category_map: { Rent: 'overheads' } }, { trade_map: { Mason: '' } }, { trade_groups: { Mason: '' } }])
      assert.strictEqual((await call('PUT', 'costs/config', bodyBad, admin)).s, 400, JSON.stringify(bodyBad));
    for (const v of ['overhead', 'labour_oncost', 'equipment', 'project', 'ignore'])
      assert.strictEqual((await call('PUT', 'costs/config', { category_map: { Rent: v } }, admin)).s, 200, v);
    await call('PUT', 'costs/config', { category_map: { Rent: 'overhead' } }, admin);

    // non-admin status hides the server path
    await call('PUT', 'settings', { erp_db_path: path.join(dir, 'missing2.db') }, admin);
    await call('POST', 'costs/sync', null, admin);
    const sq = (await call('GET', 'costs/status', null, qs)).j, sa = (await call('GET', 'costs/status', null, admin)).j;
    assert.strictEqual(sq.last_error, 'ERP sync failed'); assert.ok(/missing2\.db/.test(sa.last_error));
    await call('PUT', 'settings', { erp_db_path: erpFile }, admin);
    assert.strictEqual((await ctx.costs.sync({ now: fixed })).ok, true);

    // materials: CRUD + permissions
    assert.strictEqual((await call('POST', 'costs/materials', { name_en: 'Tile', unit: 'm2' }, null)).s, 401);
    assert.strictEqual((await call('POST', 'costs/materials', { unit: 'm2' }, qs)).s, 400);
    const m = await call('POST', 'costs/materials', { code: 'T80', name_en: 'Interlock tile 80mm', name_ar: 'بلاط', unit: 'm2' }, qs);
    assert.strictEqual(m.s, 200); const mid = m.j.id;
    const m2 = (await call('POST', 'costs/materials', { name_en: 'Empty', unit: 'm' }, admin)).j.id;
    assert.strictEqual((await call('GET', 'costs/materials', null, qs)).j.length, 2);
    assert.strictEqual((await call('PUT', `costs/materials/${mid}`, { name_en: 'Interlock tile 80 mm' }, qs)).s, 200);
    assert.strictEqual((await call('GET', 'costs/materials', null, qs)).j.find(x => x.id === mid).name_en, 'Interlock tile 80 mm');
    assert.strictEqual((await call('GET', `costs/materials/9999/links`, null, qs)).s, 404);

    // links + quotes
    assert.strictEqual(ctx.costs.materialPrice(mid, ctx.costs.latest().data, new Date('2026-11-14T00:00:00Z')), null, 'no links, no quotes -> null');
    const lk = await call('POST', `costs/materials/${mid}/links`, { description: '  INTERLOCK  Tile 80mm', unit: 'M2' }, qs);
    assert.strictEqual(lk.s, 200);
    assert.strictEqual((await call('POST', `costs/materials/${mid}/links`, { description: 'interlock tile 80mm', unit: 'm2' }, qs)).s, 400, 'duplicate link');
    const snap = ctx.costs.latest().data, now = new Date('2026-11-14T00:00:00Z');
    let p = ctx.costs.materialPrice(mid, snap, now);
    assert.strictEqual(p.rate, 30); assert.strictEqual(p.source, 'po'); assert.strictEqual(p.stale, true, 'PO of 2026-09-01 is 74 days old');
    assert.strictEqual(ctx.costs.materialPrice(mid, snap, now).avg, 30);
    assert.strictEqual((await call('POST', `costs/materials/${mid}/quotes`, { date: '2026-10-15', supplier: 'Fake Supplier LLC', rate: 0 }, qs)).s, 400);
    assert.strictEqual((await call('POST', `costs/materials/${mid}/quotes`, { date: '2026-13-45', supplier: 'Fake Supplier LLC', rate: 32 }, qs)).s, 400);
    const q = await call('POST', `costs/materials/${mid}/quotes`, { date: '2026-10-15', supplier: 'Fake Supplier LLC', rate: 32 }, qs);
    assert.strictEqual(q.s, 200);
    p = ctx.costs.materialPrice(mid, snap, now);
    assert.strictEqual(p.rate, 32); assert.strictEqual(p.source, 'quote'); assert.strictEqual(p.date, '2026-10-15');
    assert.strictEqual(p.avg, 31); assert.strictEqual(p.min, 30); assert.strictEqual(p.max, 32); assert.strictEqual(p.stale, false);
    assert.strictEqual(ctx.costs.materialPrice(mid, snap, new Date('2027-01-01T00:00:00Z')).stale, true, 'stale on 2027-01-01');
    // tie on date prefers the quote; older quote does not win
    await call('POST', `costs/materials/${mid}/quotes`, { date: '2026-09-01', supplier: 'Fake Supplier LLC', rate: 28 }, qs);
    await call('DELETE', `costs/materials/${mid}/quotes/${q.j.id}`, null, qs);
    p = ctx.costs.materialPrice(mid, snap, now); assert.strictEqual(p.source, 'quote'); assert.strictEqual(p.rate, 28);
    assert.strictEqual(p.avg, 29); assert.strictEqual(p.min, 28); assert.strictEqual(p.max, 30);
    ctx.setSetting('material_stale_days', 'abc');   // NaN must not make stale silently false
    assert.strictEqual(ctx.costs.materialPrice(mid, snap, new Date('2027-01-01T00:00:00Z')).stale, true, 'bad stale setting falls back to 60');
    ctx.setSetting('material_stale_days', 60);
    assert.strictEqual(ctx.costs.materialPrice(m2, snap, now), null);
    assert.strictEqual(ctx.costs.materialPrice(mid, null, now).rate, 28, 'works without a snapshot (quotes only)');
    assert.strictEqual((await call('GET', `costs/materials/${mid}/links`, null, qs)).j.length, 1);
    assert.strictEqual((await call('DELETE', `costs/materials/${mid}/links/${lk.j.id}`, null, qs)).s, 200);
    assert.strictEqual((await call('GET', `costs/materials/${mid}/quotes`, null, qs)).j.length, 1);
    assert.strictEqual((await call('DELETE', `costs/materials/${mid}`, null, qs)).s, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM material_quotes WHERE material_id=?').get(mid).n, 0);
    const acts = (await call('GET', 'audit', null, admin)).j.filter(a => a.entity === 'materials' || a.entity === 'material_quotes' || a.entity === 'material_po_links').map(a => a.action + ':' + a.entity);
    for (const x of ['create:materials', 'update:materials', 'delete:materials', 'create:material_quotes', 'delete:material_quotes', 'create:material_po_links', 'delete:material_po_links']) assert.ok(acts.includes(x), 'audit ' + x);
    console.log('sync ok'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
