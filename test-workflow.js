// Tender workflow: submit / approve / return / revise / reprice / result, frozen prices, stale snapshots: node --no-warnings test-workflow.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'est-workflow-'));
process.env.ERP_SYNC_DISABLED = '1';
const { server, db } = require('./server.js');

const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const SNAP = {
  work_days: 26, work_hours: 8, oh_monthly: 20000, w_monthly: 500000, months_covered: 12,
  trades: [{ trade: 'Foreman', group: 'Site', rate: 40, headcount: 1, overridden: false }, { trade: 'Labourer', group: 'Site', rate: 15, headcount: 4, overridden: false }],
  groups: [{ group: 'Site', rate: 20, headcount: 5 }], equipment: [], po_prices: [], unmapped: { categories: [], designations: [] }, warnings: [],
};
const addSnap = (data, created = new Date().toISOString()) => Number(db.prepare('INSERT INTO snapshots(created,ok,error,data) VALUES(?,1,NULL,?)').run(created, JSON.stringify(data)).lastInsertRowid);

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  const call = async (m, u, b, ck) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || '' }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie');
    return { s: r.status, j: await r.json().catch(() => null), ck: sc ? sc.split(';')[0] : '' };
  };
  const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
  const audited = (action, id) => db.prepare("SELECT 1 FROM audit_log WHERE entity='tenders' AND action=? AND entity_id=?").get(action, String(id));
  try {
    const admin = (await call('POST', 'setup', { username: 'admin', password: 'secret12' })).ck;
    const mk = async (u, role) => { await call('POST', 'users', { username: u, password: 'secret12', role }, admin); return (await call('POST', 'login', { username: u, password: 'secret12' })).ck; };
    const qs = await mk('qs1', 'qs'), viewer = await mk('view1', 'viewer');

    const mat = (await call('POST', 'costs/materials', { name_en: 'Test Concrete', unit: 'm3' }, admin)).j.id;
    await ok(call('POST', `costs/materials/${mat}/quotes`, { date: day(1), rate: 300, supplier: 'Fake Supplier LLC' }, admin), 'quote');
    const snap1 = addSnap(SNAP);
    const sec = (await call('GET', 'library/sections', null, qs)).j[0].id;
    const itemBody = { code: 'W-1', section_id: sec, uom: 'm3', name_en: 'Test item', name_ar: 'بند', rework_pct: 0,
      parts: [{ kind: 'material', material_id: mat, qty: 1, waste_pct: 0 }, { kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: 8 }, { kind: 'fixed', amount: 5 }] };
    const item = (await ok(call('POST', 'library/items', itemBody, qs), 'item')).id;
    const v1id = db.prepare('SELECT id FROM item_versions WHERE item_id=? AND version=1').get(item).id;

    const info = { title: 'Test Workflow Road', client: 'Fake Client LLC', kind: 'direct', M: 4, adv_pct: 0, ret_pct: 5, collection_days: 45, retention_months: 6 };
    // a tender with one take-off row linked to the item; hidden items answered unless `leave` is set
    const makeTender = async (leave) => {
      const id = (await ok(call('POST', 'tenders', info, qs), 'create')).id;
      const row = (await ok(call('POST', `tenders/${id}/rows`, { no: '1', description: 'Test concrete works', unit: 'm3' }, qs), 'row')).id;
      await ok(call('POST', `tenders/${id}/rows/${row}/lines`, { description: 'slab', l: 10, w: 5, d: 0.2, count: 2 }, qs), 'line');
      await ok(call('PUT', `tenders/${id}/rows/${row}/links`, { links: [{ item_id: item, share: 1 }] }, qs), 'link');
      const hid = (await call('GET', `tenders/${id}/hidden`, null, qs)).j;
      for (const h of hid.slice(leave ? 1 : 0)) await ok(call('PUT', `tenders/${id}/hidden/${h.id}`, { status: 'na' }, qs), 'answer');
      return { id, row, hidden: hid };
    };

    // ---- blocked approval ------------------------------------------------------------------------
    const A = await makeTender(true);
    assert.strictEqual((await call('POST', `tenders/${A.id}/approve`, {}, admin)).s, 409, 'approve needs submitted');
    assert.strictEqual((await call('POST', `tenders/${A.id}/submit`, null, viewer)).s, 403);
    await ok(call('POST', `tenders/${A.id}/submit`, null, qs), 'submit');
    assert.ok(audited('submit', A.id));
    assert.strictEqual((await call('GET', `tenders/${A.id}`, null, qs)).j.status, 'submitted');
    assert.strictEqual((await call('POST', `tenders/${A.id}/submit`, null, qs)).s, 409, 'submit twice');
    assert.strictEqual((await call('PUT', `tenders/${A.id}/hidden/${A.hidden[0].id}`, { status: 'na' }, qs)).s, 409, 'no edits while submitted');
    assert.strictEqual((await call('POST', `tenders/${A.id}/approve`, { margin_pct: 10 }, qs)).s, 403, 'qs cannot approve');
    const blocked = await call('POST', `tenders/${A.id}/approve`, { margin_pct: 10 }, admin);
    assert.strictEqual(blocked.s, 409); assert.ok(blocked.j.error);
    assert.deepStrictEqual(blocked.j.blocking, [{ code: 'hidden_unanswered', hidden_id: A.hidden[0].id }]);
    assert.strictEqual((await call('POST', `tenders/${A.id}/approve`, { margin_pct: 100 }, admin)).s, 400, 'bad margin');
    assert.strictEqual((await call('POST', `tenders/${A.id}/return`, null, qs)).s, 403, 'only admin returns');
    await ok(call('POST', `tenders/${A.id}/return`, null, admin), 'return');
    assert.ok(audited('return', A.id));
    await ok(call('PUT', `tenders/${A.id}/hidden/${A.hidden[0].id}`, { status: 'na' }, qs), 'answer after return');

    // ---- clean approval freezes the price ------------------------------------------------------------
    await ok(call('POST', `tenders/${A.id}/submit`, null, qs), 'submit again');
    const before = await ok(call('GET', `tenders/${A.id}/price?margin_pct=10`, null, admin), 'price before');
    assert.deepStrictEqual(before.blocking, []);
    const ap = await ok(call('POST', `tenders/${A.id}/approve`, { margin_pct: 10 }, admin), 'approve');
    assert.ok(ap.frozen.P > 0); assert.strictEqual(ap.frozen.P, before.result.P);
    assert.strictEqual(ap.frozen.snapshot_id, snap1); assert.strictEqual(ap.frozen.margin_pct, 10);
    assert.deepStrictEqual(ap.frozen.item_versions, [{ row_id: A.row, item_id: item, version: 1, version_id: v1id, share: 1 }]);
    assert.ok(audited('approve', A.id));
    const tA = (await call('GET', `tenders/${A.id}`, null, viewer)).j;
    assert.strictEqual(tA.status, 'approved'); assert.strictEqual(tA.approved_by, 'admin'); assert.ok(tA.approved_at); assert.strictEqual(tA.approved_P, ap.frozen.P);
    const frozenRaw = db.prepare('SELECT frozen FROM tenders WHERE id=?').get(A.id).frozen;

    // a later sync and a library edit never change an approved price
    const snap2 = addSnap({ ...SNAP, oh_monthly: 35000, trades: SNAP.trades.map(t => ({ ...t, rate: t.rate * 2 })) });
    await ok(call('PUT', `library/items/${item}`, { parts: [{ kind: 'fixed', amount: 999 }] }, qs), 'library edit');
    for (const ck of [admin, qs]) {
      const after = await ok(call('GET', `tenders/${A.id}/price`, null, ck), 'price after');
      assert.strictEqual(after.frozen.P, ap.frozen.P); assert.strictEqual(after.frozen.snapshot_id, snap1);
      assert.strictEqual(after.result, undefined, 'approved: frozen only, never recomputed');
    }
    const qv = (await call('GET', `tenders/${A.id}/price`, null, qs)).j;
    assert.strictEqual(qv.frozen.rows[0].links[0].parts[1].cost, null, 'frozen view hides small-trade labour from qs');
    assert.strictEqual(qv.frozen.rows[0].links[0].parts[1].hidden, true);
    assert.ok(!JSON.stringify(qv).includes('"hide"'));
    assert.strictEqual((await call('GET', `tenders/${A.id}/price`, null, admin)).j.frozen.rows[0].links[0].parts[1].cost, 40);

    // no edits, no delete after draft
    assert.strictEqual((await call('PUT', `tenders/${A.id}/rows/${A.row}`, { description: 'changed' }, qs)).s, 409);
    const r409 = await call('PUT', `tenders/${A.id}/rows/${A.row}/links`, { links: [] }, qs);
    assert.strictEqual(r409.s, 409); assert.ok(r409.j.error);
    assert.strictEqual((await call('PUT', `tenders/${A.id}`, { title: 'changed' }, qs)).s, 409);
    assert.strictEqual((await call('PUT', `tenders/${A.id}/hidden/${A.hidden[0].id}`, { status: 'na' }, qs)).s, 409);
    assert.strictEqual((await call('POST', `tenders/${A.id}/rows`, { description: 'new' }, qs)).s, 409);
    assert.strictEqual((await call('POST', `tenders/${A.id}/rows/${A.row}/lines`, { l: 1 }, qs)).s, 409);
    assert.strictEqual((await call('POST', `tenders/${A.id}/import`, { file_b64: '' }, qs)).s, 409);
    assert.strictEqual((await call('POST', `tenders/${A.id}/reprice`, null, qs)).s, 409);
    assert.strictEqual((await call('DELETE', `tenders/${A.id}`, null, admin)).s, 409);
    assert.strictEqual((await call('POST', `tenders/${A.id}/approve`, { margin_pct: 10 }, admin)).s, 409, 'approve twice');
    assert.strictEqual(db.prepare('SELECT frozen FROM tenders WHERE id=?').get(A.id).frozen, frozenRaw, 'frozen untouched');

    // ---- revise -------------------------------------------------------------------------------------------
    assert.strictEqual((await call('POST', `tenders/${A.id}/revise`, null, viewer)).s, 403);
    const rv = await ok(call('POST', `tenders/${A.id}/revise`, null, qs), 'revise');
    const B = (await call('GET', `tenders/${rv.id}`, null, qs)).j;
    assert.strictEqual(B.rev, 2); assert.strictEqual(B.status, 'draft'); assert.strictEqual(B.root_id, A.id); assert.strictEqual(B.snapshot_id, snap2);
    assert.strictEqual(B.approved_by, null); assert.strictEqual(B.approved_P, null);
    const tA2 = (await call('GET', `tenders/${A.id}`, null, qs)).j;
    assert.strictEqual(tA2.status, 'approved'); assert.strictEqual(tA2.rev, 1);
    assert.strictEqual(db.prepare('SELECT frozen FROM tenders WHERE id=?').get(A.id).frozen, frozenRaw, 'original untouched');
    const bRows = (await call('GET', `tenders/${B.id}/rows`, null, qs)).j;
    assert.strictEqual(bRows.length, 1); assert.notStrictEqual(bRows[0].id, A.row);
    assert.strictEqual(bRows[0].qty, 20); assert.strictEqual(bRows[0].lines.length, 1); assert.deepStrictEqual(bRows[0].links.map(l => [l.item_id, l.share]), [[item, 1]]);
    const bHid = (await call('GET', `tenders/${B.id}/hidden`, null, qs)).j;
    assert.strictEqual(bHid.length, 11); assert.ok(bHid.every(h => h.status === 'na'));
    assert.ok(audited('revise', B.id));
    // the revision prices on the latest snapshot and the current item version; rev 1 keeps its frozen price
    const pB = await ok(call('GET', `tenders/${B.id}/price`, null, qs), 'price rev 2');
    assert.strictEqual(pB.rows[0].direct_unit, 999); assert.notStrictEqual(pB.result.P, ap.frozen.P);
    const rv3 = await ok(call('POST', `tenders/${A.id}/revise`, null, qs), 'revise again');
    assert.strictEqual((await call('GET', `tenders/${rv3.id}`, null, qs)).j.rev, 3, 'rev counts per root');
    assert.strictEqual((await call('POST', `tenders/${B.id}/revise`, null, qs)).s, 409, 'only approved/sent tenders are revised');

    // ---- send / result -----------------------------------------------------------------------------------------
    assert.strictEqual((await call('PUT', `tenders/${B.id}/result`, { result: 'won' }, qs)).s, 409, 'result needs an approved tender');
    assert.strictEqual((await call('PUT', `tenders/${A.id}/result`, { result: 'won' }, qs)).s, 409, 'result needs a sent tender');
    await ok(call('POST', `tenders/${A.id}/send`, null, qs), 'send');
    assert.strictEqual((await call('GET', `tenders/${A.id}`, null, qs)).j.status, 'sent');
    assert.strictEqual((await call('PUT', `tenders/${A.id}/result`, { result: 'maybe' }, qs)).s, 400);
    assert.strictEqual((await call('PUT', `tenders/${A.id}/result`, { result: 'lost', winner_price: -1 }, qs)).s, 400);
    assert.strictEqual((await call('PUT', `tenders/${A.id}/result`, { result: 'won', winner_price: 5 }, qs)).s, 400, 'winner price only when lost');
    assert.strictEqual((await call('PUT', `tenders/${A.id}/result`, { result: 'lost' }, viewer)).s, 403);
    await ok(call('PUT', `tenders/${A.id}/result`, { result: 'lost', winner_price: '123,456.50' }, qs), 'result');
    const tL = (await call('GET', `tenders/${A.id}`, null, qs)).j;
    assert.strictEqual(tL.status, 'lost'); assert.strictEqual(tL.result, 'lost'); assert.strictEqual(tL.winner_price, 123456.5);
    assert.ok(audited('send', A.id)); assert.ok(audited('result', A.id));
    assert.strictEqual((await call('PUT', `tenders/${A.id}/result`, { result: 'won' }, qs)).s, 409, 'won/lost are final');
    assert.strictEqual((await call('GET', `tenders/${A.id}`, null, qs)).j.result, 'lost');
    assert.strictEqual((await call('GET', `tenders/${A.id}/price`, null, qs)).j.frozen.P, ap.frozen.P);

    // ---- stale snapshot: approval blocked unless the admin overrides (Review Focus 3) ------------------------------
    await ok(call('PUT', `library/items/${item}`, itemBody, qs), 'restore item');
    const C = await makeTender(false);
    assert.strictEqual((await call('GET', `tenders/${C.id}`, null, qs)).j.snapshot_id, snap2);
    db.prepare('UPDATE snapshots SET created=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), snap2);
    await ok(call('POST', `tenders/${C.id}/submit`, null, qs), 'submit C');
    const st = await call('POST', `tenders/${C.id}/approve`, { margin_pct: 12 }, admin);
    assert.strictEqual(st.s, 409); assert.deepStrictEqual(st.j.blocking.map(b => b.code), ['snapshot_stale']);
    assert.strictEqual((await call('POST', `tenders/${C.id}/approve`, { margin_pct: 12, override_stale: 'yes' }, admin)).s, 400);
    const so = await ok(call('POST', `tenders/${C.id}/approve`, { margin_pct: 12, override_stale: true }, admin), 'approve stale');
    assert.ok(so.frozen.P > 0); assert.strictEqual(so.frozen.override_stale, true);
    assert.ok(audited('approve_stale', C.id), 'audited as approve_stale');

    // ---- a newer sync never silently changes an open tender (Review Focus 3) ---------------------------------------
    const snap3 = addSnap(SNAP);
    const D = await makeTender(false);
    assert.strictEqual((await call('GET', `tenders/${D.id}`, null, qs)).j.snapshot_id, snap3);
    const d0 = await ok(call('GET', `tenders/${D.id}/price`, null, qs), 'price D');
    assert.strictEqual(d0.newer_snapshot, false); assert.deepStrictEqual(d0.blocking, []);
    const snap4 = addSnap({ ...SNAP, oh_monthly: 60000 });
    const d1 = await ok(call('GET', `tenders/${D.id}/price`, null, qs), 'price D after sync');
    assert.strictEqual(d1.newer_snapshot, true); assert.strictEqual(d1.result.P, d0.result.P); assert.strictEqual(d1.snapshot_id, snap3);
    assert.strictEqual((await call('POST', `tenders/${D.id}/reprice`, null, viewer)).s, 403);
    const rp = await ok(call('POST', `tenders/${D.id}/reprice`, null, qs), 'reprice');
    assert.strictEqual(rp.old_P, d0.result.P); assert.ok(rp.new_P > rp.old_P); assert.strictEqual(rp.old_snapshot_id, snap3); assert.strictEqual(rp.snapshot_id, snap4);
    const d2 = await ok(call('GET', `tenders/${D.id}/price`, null, qs), 'price D after reprice');
    assert.strictEqual(d2.newer_snapshot, false); assert.strictEqual(d2.result.P, rp.new_P);
    assert.ok(audited('reprice', D.id));
    assert.strictEqual(rp.old_complete, true); assert.strictEqual(rp.new_complete, true); assert.deepStrictEqual(rp.blocking, []);
    // reprice on a partial tender says so
    const E = await makeTender(true);
    const rpE = await ok(call('POST', `tenders/${E.id}/reprice`, null, qs), 'reprice partial');
    assert.strictEqual(rpE.old_complete, false); assert.strictEqual(rpE.new_complete, false);
    assert.ok(rpE.blocking.some(b => b.code === 'hidden_unanswered' && b.hidden_id === E.hidden[0].id));

    // ---- work hours come from the tender's snapshot, never from today's setting -------------------------------------
    const W = await makeTender(false);
    const w0 = await ok(call('GET', `tenders/${W.id}/price`, null, admin), 'price W');
    const libUnit = async () => (await call('GET', 'library/items', null, admin)).j.find(i => i.id === item).unit;
    const lib0 = await libUnit();
    await ok(call('PUT', 'settings', { work_hours: 10 }, admin), 'change work hours');
    const w1 = await ok(call('GET', `tenders/${W.id}/price`, null, admin), 'price W after setting change');
    assert.strictEqual(w1.result.P, w0.result.P, 'a settings change after the sync does not change the tender price');
    assert.strictEqual(await libUnit(), lib0, 'library unit cost uses the snapshot hours too');
    assert.ok(!w1.snapshot_warnings.some(w => w.code === 'snapshot_no_work_hours'));
    // an old snapshot without stored hours: falls back to the setting and says so
    const { work_days: _wd, work_hours: _wh, ...oldSnap } = SNAP;
    addSnap(oldSnap);
    const O = await makeTender(false);
    const o1 = await ok(call('GET', `tenders/${O.id}/price`, null, admin), 'price on an old snapshot');
    assert.ok(o1.snapshot_warnings.some(w => w.code === 'snapshot_no_work_hours'), 'old snapshot warned');
    assert.strictEqual(o1.rows[0].links[0].parts[1].cost, 40 * 10 / 8, 'old snapshot: labour priced on the setting (10 h)');
    await ok(call('PUT', 'settings', { work_hours: 8 }, admin), 'restore work hours');
    console.log('workflow ok'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
