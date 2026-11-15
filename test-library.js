// Item library API: node --no-warnings test-library.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'est-lib-'));
process.env.ERP_SYNC_DISABLED = '1';
const { server, db } = require('./server.js');

const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-6, `${msg}: expected ≈${b}, got ${a}`);

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  const call = async (m, u, b, ck) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || '' }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie');
    return { s: r.status, j: await r.json().catch(() => null), ck: sc ? sc.split(';')[0] : '' };
  };
  try {
    const admin = (await call('POST', 'setup', { username: 'admin', password: 'secret12' })).ck;
    const mk = async (u, role) => { await call('POST', 'users', { username: u, password: 'secret12', role }, admin); return (await call('POST', 'login', { username: u, password: 'secret12' })).ck; };
    const qs = await mk('qs1', 'qs'), viewer = await mk('view1', 'viewer');

    // seeded sections
    const secs = await call('GET', 'library/sections', null, qs);
    assert.strictEqual(secs.s, 200); assert.strictEqual(secs.j.length, 11);
    assert.ok(secs.j.every(s => s.name_ar && s.name_en), 'both languages');
    assert.ok(secs.j.some(s => s.name_en === 'Asphalt'));
    const asphalt = secs.j.find(s => s.name_en === 'Asphalt').id;
    assert.strictEqual((await call('GET', 'library/sections', null, viewer)).s, 200);

    // sections CRUD
    assert.strictEqual((await call('POST', 'library/sections', { name_en: 'X', name_ar: 'س' }, viewer)).s, 403);
    assert.strictEqual((await call('POST', 'library/sections', { name_en: 'X', name_ar: 'س', default_rework_pct: -1 }, qs)).s, 400);
    assert.strictEqual((await call('POST', 'library/sections', { name_en: 'X', name_ar: 'س', parent_id: 9999 }, qs)).s, 400);
    const ns = await call('POST', 'library/sections', { name_en: 'Test Section', name_ar: 'قسم', default_rework_pct: 3 }, qs);
    assert.strictEqual(ns.s, 200);
    assert.strictEqual((await call('PUT', `library/sections/${ns.j.id}`, { name_en: 'Test Section 2' }, qs)).s, 200);
    assert.strictEqual((await call('GET', 'library/sections', null, qs)).j.find(s => s.id === ns.j.id).name_en, 'Test Section 2');
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE entity='sections' AND action='create'").get(), 'section create audited');
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE entity='sections' AND action='update'").get(), 'section update audited');

    // materials + snapshot fixtures
    const mat = (await call('POST', 'costs/materials', { name_en: 'Test Asphalt Mix', unit: 'ton' }, admin)).j.id;
    await call('POST', `costs/materials/${mat}/quotes`, { date: '2026-11-01', rate: 300, supplier: 'Fake Supplier LLC' }, admin);
    const snapData = {
      trades: [{ trade: 'Foreman', group: 'Site', rate: 40, headcount: 1, overridden: false }, { trade: 'Labourer', group: 'Site', rate: 15, headcount: 4, overridden: false }, { trade: 'Mason', group: 'Site', rate: 20, headcount: 3, overridden: false }],
      equipment: [{ id: 'asset:3', name: 'Test Excavator', rate: 120, source: 'asset', overridden: false }], warnings: [],
    };

    const good = { code: 'T-001', section_id: asphalt, uom: 'm2', name_en: 'Test item', name_ar: 'بند', rework_pct: 2, condition_factor: 1.25,
      parts: [{ kind: 'material', material_id: mat, qty: 1, waste_pct: 5 }, { kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }, { trade: 'Labourer', count: 4 }], output_per_day: 20 }, { kind: 'equipment', equipment_id: 'asset:3', output_per_hour: 10 }, { kind: 'fixed', amount: 5 }] };

    // access + validation
    assert.strictEqual((await call('POST', 'library/items', good, viewer)).s, 403);
    const badBodies = [
      { ...good, code: '' }, { ...good, section_id: 9999 }, { ...good, uom: '' }, { ...good, unit: 'm2' }, { ...good, name_en: '', name_ar: '' },
      { ...good, parts: [] }, { ...good, parts: 'x' }, { ...good, rework_pct: -1 }, { ...good, condition_factor: 0.9 }, { ...good, condition_factor: 'abc' },
      { ...good, parts: [{ kind: 'magic' }] },
      { ...good, parts: [{ kind: 'material', material_id: 9999, qty: 1, waste_pct: 0 }] },
      { ...good, parts: [{ kind: 'material', material_id: mat, qty: -1, waste_pct: 0 }] },
      { ...good, parts: [{ kind: 'material', material_id: mat, qty: 1, waste_pct: -5 }] },
      // waste % is required: a missing waste is never taken as 0
      { ...good, parts: [{ kind: 'material', material_id: mat, qty: 1 }] },
      { ...good, parts: [{ kind: 'material', material_id: mat, qty: 1, waste_pct: null }] },
      { ...good, parts: [{ kind: 'material', material_id: mat, qty: 1, waste_pct: '5' }] },
      { ...good, parts: [{ kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: 0 }] },
      { ...good, parts: [{ kind: 'labour', crew: [], output_per_day: 5 }] },
      { ...good, parts: [{ kind: 'labour', crew: [{ trade: 'Foreman', count: 1.5 }], output_per_day: 5 }] },
      { ...good, parts: [{ kind: 'labour', crew: [{ trade: 'Foreman', count: 0 }], output_per_day: 5 }] },
      { ...good, parts: [{ kind: 'equipment', equipment_id: 'asset:3', output_per_hour: 0 }] },
      { ...good, parts: [{ kind: 'equipment', equipment_id: 5, output_per_hour: 1 }] },
      { ...good, parts: [{ kind: 'material', material_id: mat, qty: 1e10, waste_pct: 0 }] },
      { ...good, parts: [{ kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: 1e10 }] },
      { ...good, parts: [{ kind: 'sub', rate: 1e10 }] }, { ...good, parts: [{ kind: 'fixed', amount: 1e10 }] },
      { ...good, parts: [{ kind: 'sub', rate: -1 }] }, { ...good, parts: [{ kind: 'fixed', amount: 'x' }] },
    ];
    for (const [i, b] of badBodies.entries()) assert.strictEqual((await call('POST', 'library/items', b, qs)).s, 400, 'bad body #' + i);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM items').get().n, 0, 'no partial rows from rejected requests');

    // create, PUT twice -> versions 1,2,3; v1 unchanged
    const c = await call('POST', 'library/items', good, qs);
    assert.strictEqual(c.s, 200); const id = c.j.id;
    assert.strictEqual((await call('POST', 'library/items', { ...good, name_en: 'dup' }, qs)).s, 400, 'duplicate code');
    const v1raw = db.prepare('SELECT data FROM item_versions WHERE item_id=? AND version=1').get(id).data;
    assert.strictEqual((await call('PUT', `library/items/${id}`, { ...good, name_en: 'Test item v2', parts: [...good.parts, { kind: 'sub', rate: 10 }] }, qs)).s, 200);
    assert.strictEqual((await call('PUT', `library/items/${id}`, { ...good, uom: 'm3', rework_pct: 0 }, qs)).s, 200);
    assert.strictEqual((await call('PUT', `library/items/${id}`, good, viewer)).s, 403);
    const vs = await call('GET', `library/items/${id}/versions`, null, viewer);
    assert.deepStrictEqual(vs.j.map(v => v.version), [1, 2, 3]);
    assert.strictEqual(JSON.stringify(vs.j[0].data), JSON.stringify(JSON.parse(v1raw)), 'version 1 data unchanged');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM item_versions WHERE item_id=?').get(id).n, 3);
    assert.strictEqual(db.prepare('SELECT current_version v FROM items WHERE id=?').get(id).v, 3);
    assert.strictEqual(db.prepare('SELECT unit FROM items WHERE id=?').get(id).unit, 'm3');
    // duplicate code on PUT; missing item
    await call('POST', 'library/items', { ...good, code: 'T-002' }, qs);
    assert.strictEqual((await call('PUT', `library/items/${id}`, { ...good, code: 'T-002' }, qs)).s, 400);
    assert.strictEqual((await call('PUT', 'library/items/9999', good, qs)).s, 404);
    assert.strictEqual((await call('GET', 'library/items/9999/versions', null, qs)).s, 404);
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE entity='items' AND action='create'").get());
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity='items' AND action='update'").get().n >= 2);

    // frozen head fields and rework in each version
    assert.deepStrictEqual(vs.j[0].data.head, { code: 'T-001', uom: 'm2', name_ar: 'بند', name_en: 'Test item', section_id: asphalt });
    assert.strictEqual(vs.j[1].data.head.name_en, 'Test item v2'); assert.strictEqual(vs.j[2].data.head.uom, 'm3');
    assert.strictEqual(vs.j[2].data.rework_pct, 0);

    // no snapshot yet: unit null + missing ['snapshot']
    let list = await call('GET', 'library/items', null, qs);
    let it = list.j.find(i => i.id === id);
    assert.strictEqual(it.unit, null); assert.deepStrictEqual(it.missing, ['snapshot']);

    // with a snapshot
    db.prepare('INSERT INTO snapshots(created,ok,error,data) VALUES(?,1,NULL,?)').run(new Date().toISOString(), JSON.stringify(snapData));
    await call('PUT', `library/items/${id}`, good, admin);   // v4 = original good data
    list = await call('GET', 'library/items', null, qs);
    it = list.j.find(i => i.id === id);
    near(it.unit, 392.7, 'unit from latest snapshot'); assert.deepStrictEqual(it.missing, []);
    assert.deepStrictEqual(it.parts.map(p => p.kind), ['material', 'labour', 'equipment', 'fixed']);
    assert.strictEqual(it.version, 4);
    near(it.parts[0].cost, 315, 'material part');
    near(it.parts[1].cost, 50, 'multi-trade crew part visible');

    // section default rework applies when the version omits rework_pct
    const { rework_pct, ...noRework } = good;
    const d = await call('POST', 'library/items', { ...noRework, code: 'T-003', section_id: ns.j.id }, qs);
    near((await call('GET', 'library/items', null, qs)).j.find(i => i.id === d.j.id).unit, 392.7 / 1.02 * 1.03, 'section default rework');

    // a section edit never changes a saved version's cost; the version froze its rework
    assert.strictEqual(JSON.parse(db.prepare('SELECT data FROM item_versions WHERE item_id=? AND version=1').get(d.j.id).data).rework_pct, 3);
    await call('PUT', `library/sections/${ns.j.id}`, { default_rework_pct: 50 }, qs);
    near((await call('GET', 'library/items', null, qs)).j.find(i => i.id === d.j.id).unit, 392.7 / 1.02 * 1.03, 'unit unchanged after section edit');
    // a list row cannot be round-tripped into PUT (cost is in `unit`)
    const rt = (await call('GET', 'library/items', null, qs)).j.find(i => i.id === d.j.id);
    const rr = await call('PUT', `library/items/${d.j.id}`, rt, qs);
    assert.strictEqual(rr.s, 400); assert.ok(/uom/.test(rr.j.error));

    // privacy: single small trade labour part hides its cost from non-admin
    const priv = { code: 'T-004', section_id: asphalt, uom: 'm', name_en: 'Priv', name_ar: 'خاص',
      parts: [{ kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: 8 }, { kind: 'labour', crew: [{ trade: 'Mason', count: 1 }], output_per_day: 8 }, { kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }, { trade: 'Mason', count: 1 }], output_per_day: 8 }, { kind: 'fixed', amount: 1 }] };
    const p = await call('POST', 'library/items', priv, qs);
    for (const [ck, who] of [[qs, 'qs'], [viewer, 'viewer']]) {
      const row = (await call('GET', 'library/items', null, ck)).j.find(i => i.id === p.j.id);
      near(row.unit, 40 + 20 + 60 + 1, who + ' unit stays true');
      assert.strictEqual(row.parts[0].cost, null, who + ' small trade hidden'); assert.strictEqual(row.parts[0].hidden, true);
      near(row.parts[1].cost, 20, who + ' trade with headcount 3 visible');
      near(row.parts[2].cost, 60, who + ' mixed crew visible');
      assert.ok(!('hidden' in row.parts[2]) && !('hidden' in row.parts[3]));
      for (const part of row.parts) assert.deepStrictEqual(Object.keys(part).sort(), 'hidden' in part ? ['cost', 'hidden', 'kind'] : ['cost', 'kind']);
      assert.ok(!/headcount|rate/.test(JSON.stringify(row)), who + ' no trade rates/headcounts in the list');
    }
    const arow = (await call('GET', 'library/items', null, admin)).j.find(i => i.id === p.j.id);
    near(arow.parts[0].cost, 40, 'admin sees everything'); assert.ok(!('hidden' in arow.parts[0]));

    // missing trade/equipment shows up as missing
    const m = await call('POST', 'library/items', { ...priv, code: 'T-005', parts: [{ kind: 'labour', crew: [{ trade: 'Nobody', count: 1 }], output_per_day: 8 }] }, qs);
    const mrow = (await call('GET', 'library/items', null, qs)).j.find(i => i.id === m.j.id);
    assert.strictEqual(mrow.unit, null); assert.deepStrictEqual(mrow.missing, ['trade:Nobody']);
    // the audit row is written in the same transaction as the change: if it cannot be written, nothing changes
    const auditDown = async (entities, fn) => {
      db.exec(`CREATE TRIGGER audit_down BEFORE INSERT ON audit_log WHEN NEW.entity IN (${entities.map(e => `'${e}'`).join(',')}) BEGIN SELECT RAISE(ABORT, 'test: audit log down'); END;`);
      const ce = console.error; console.error = () => {};   // the expected 500s would log a stack
      try { await fn(); } finally { console.error = ce; db.exec('DROP TRIGGER audit_down'); }
    };
    const emptySec = (await call('POST', 'library/sections', { name_en: 'Test Empty Section', name_ar: 'قسم فارغ' }, qs)).j.id;
    const counts = () => ['sections', 'items', 'item_versions'].map(tb => db.prepare(`SELECT COUNT(*) n FROM ${tb}`).get().n);
    const c0 = counts(), asph0 = db.prepare('SELECT * FROM sections WHERE id=?').get(asphalt), itm0 = db.prepare('SELECT * FROM items WHERE id=?').get(p.j.id);
    await auditDown(['sections', 'items'], async () => {
      assert.strictEqual((await call('POST', 'library/sections', { name_en: 'Test Audit Section', name_ar: 'س' }, qs)).s, 500);
      assert.strictEqual((await call('PUT', `library/sections/${asphalt}`, { default_rework_pct: 77 }, qs)).s, 500);
      assert.strictEqual((await call('DELETE', `library/sections/${emptySec}`, null, qs)).s, 500);
      assert.strictEqual((await call('POST', 'library/items', { ...priv, code: 'T-AUD' }, qs)).s, 500);
      assert.strictEqual((await call('PUT', `library/items/${p.j.id}`, { name_en: 'Test changed' }, qs)).s, 500);
    });
    assert.deepStrictEqual(counts(), c0, 'no section/item/version written without its audit row');
    assert.deepStrictEqual(db.prepare('SELECT * FROM sections WHERE id=?').get(asphalt), asph0, 'section unchanged');
    assert.deepStrictEqual(db.prepare('SELECT * FROM items WHERE id=?').get(p.j.id), itm0, 'item unchanged');
    console.log('library ok'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
