// Tenders API (rows, import, take-off, links, hidden items, pricing): node --no-warnings test-tenders.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'est-tenders-'));
process.env.ERP_SYNC_DISABLED = '1';
const { server, db } = require('./server.js');
const { writeXlsx } = require('./lib/xlsx.js');

const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-6, `${msg}: expected ≈${b}, got ${a}`);
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);   // a date n days before now
const b64 = rows => writeXlsx(rows).toString('base64');
const SNAP = {
  oh_monthly: 20000, w_monthly: 500000, months_covered: 12,
  trades: [{ trade: 'Foreman', group: 'Site', rate: 40, headcount: 1, overridden: false }, { trade: 'Labourer', group: 'Site', rate: 15, headcount: 4, overridden: false }],
  groups: [{ group: 'Site', rate: 20, headcount: 5 }], equipment: [{ id: 'asset:3', name: 'Test Excavator', rate: 120, source: 'owned', overridden: false }],
  po_prices: [], unmapped: { categories: [], designations: [] }, warnings: [],
};
const addSnap = (data, created = new Date().toISOString()) => Number(db.prepare('INSERT INTO snapshots(created,ok,error,data) VALUES(?,1,NULL,?)').run(created, JSON.stringify(data)).lastInsertRowid);
// every object in a JSON value
const walk = (v, f) => { if (v && typeof v === 'object') { f(v); for (const k in v) walk(v[k], f); } };

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  const call = async (m, u, b, ck) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || '' }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie');
    return { s: r.status, j: await r.json().catch(() => null), ck: sc ? sc.split(';')[0] : '' };
  };
  const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
  try {
    const admin = (await call('POST', 'setup', { username: 'admin', password: 'secret12' })).ck;
    const mk = async (u, role) => { await call('POST', 'users', { username: u, password: 'secret12', role }, admin); return (await call('POST', 'login', { username: u, password: 'secret12' })).ck; };
    const qs = await mk('qs1', 'qs'), viewer = await mk('view1', 'viewer');

    // ---- hidden templates: seeded, names only ------------------------------------------
    const tpl = await ok(call('GET', 'hidden-templates', null, viewer), 'templates');
    assert.strictEqual(tpl.length, 11);
    assert.deepStrictEqual(tpl.map(t => [t.name_en, t.kind]), [
      ['RTA permits & NOCs', 'fixed'], ['Permit deposit', 'locked'], ['Traffic diversion (TMP)', 'monthly'], ['Security/guarding', 'monthly'],
      ['Lab testing', 'fixed'], ['Consultant', 'fixed'], ['CAR insurance', 'pct'], ['Performance bond', 'locked'], ['Waste disposal', 'fixed'],
      ['Extra accommodation & transport', 'monthly'], ['Site office', 'monthly']]);
    assert.ok(tpl.every(t => t.name_ar && t.active === 1));
    assert.ok(tpl.every(t => !('amount' in t) && !('pct' in t)), 'names only, no amounts');
    assert.strictEqual((await call('POST', 'hidden-templates', { name_en: 'X', name_ar: 'س', kind: 'fixed' }, qs)).s, 403);
    assert.strictEqual((await call('POST', 'hidden-templates', { name_en: 'X', name_ar: 'س', kind: 'weird' }, admin)).s, 400);

    // ---- tender without any snapshot: no_snapshot, never a 500 --------------------------------
    const tInfo = { title: 'Test Road Works', client: 'Fake Client LLC', kind: 'rta', M: 6, adv_pct: 10, ret_pct: 10, collection_days: 60, retention_months: 12 };
    const t0 = (await ok(call('POST', 'tenders', tInfo, qs), 'create without snapshot')).id;
    const p0 = await ok(call('GET', `tenders/${t0}/price`, null, qs), 'price without snapshot');
    assert.strictEqual(p0.result, null); assert.ok(p0.blocking.some(b => b.code === 'no_snapshot'));

    // ---- fixtures: materials, snapshot, items ---------------------------------------------
    const mat = (await call('POST', 'costs/materials', { name_en: 'Test Concrete', unit: 'm3' }, admin)).j.id;
    await ok(call('POST', `costs/materials/${mat}/quotes`, { date: day(1), rate: 300, supplier: 'Fake Supplier LLC' }, admin), 'quote');
    const oldMat = (await call('POST', 'costs/materials', { name_en: 'Test Old Sand', unit: 'ton' }, admin)).j.id;
    await ok(call('POST', `costs/materials/${oldMat}/quotes`, { date: day(100), rate: 50, supplier: 'Fake Supplier LLC' }, admin), 'old quote');
    const snap1 = addSnap(SNAP);
    const sec = (await call('GET', 'library/sections', null, qs)).j[0].id;
    const item = async (code, parts) => (await ok(call('POST', 'library/items', { code, section_id: sec, uom: 'm3', name_en: 'Test ' + code, name_ar: 'بند ' + code, rework_pct: 0, parts }, qs), 'item ' + code)).id;
    const i1 = await item('T-1', [{ kind: 'material', material_id: mat, qty: 1, waste_pct: 0 }, { kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }, { trade: 'Labourer', count: 4 }], output_per_day: 20 }, { kind: 'fixed', amount: 5 }]);
    const i2 = await item('T-2', [{ kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: 8 }, { kind: 'fixed', amount: 2 }]);
    const i3 = await item('T-3', [{ kind: 'material', material_id: oldMat, qty: 1, waste_pct: 0 }]);
    const i4 = await item('T-4', [{ kind: 'labour', crew: [{ trade: 'Nobody', count: 1 }], output_per_day: 8 }]);
    const units = Object.fromEntries((await call('GET', 'library/items', null, admin)).j.map(i => [i.id, i.unit]));
    near(units[i1], 300 + (40 + 60) * 8 / 20 + 5, 'u1'); near(units[i2], 40 + 2, 'u2');

    // ---- create / validation -------------------------------------------------------------
    assert.strictEqual((await call('POST', 'tenders', tInfo, viewer)).s, 403);
    const badInfo = [{ ...tInfo, title: '' }, { ...tInfo, kind: 'other' }, { ...tInfo, M: 0 }, { ...tInfo, M: 1.5 }, { ...tInfo, M: -2 }, { ...tInfo, adv_pct: 100 },
      { ...tInfo, adv_pct: -1 }, { ...tInfo, ret_pct: 100 }, { ...tInfo, adv_pct: 60, ret_pct: 40 }, { ...tInfo, collection_days: -1 }, { ...tInfo, collection_days: 'x' },
      { ...tInfo, retention_months: 1.5 }, { ...tInfo, retention_months: -1 }, { ...tInfo, submit_date: '2026-02-30' }];
    for (const [i, b] of badInfo.entries()) assert.strictEqual((await call('POST', 'tenders', b, qs)).s, 400, 'bad info #' + i);
    for (const m of [100, -1, 'abc']) assert.strictEqual((await call('POST', 'tenders', { ...tInfo, margin_pct: m }, admin)).s, 400, 'bad margin ' + m);
    assert.strictEqual((await call('POST', 'tenders', { ...tInfo, margin_pct: 10 }, qs)).s, 403, 'only admin sets the margin');
    const tid = (await ok(call('POST', 'tenders', tInfo, qs), 'create')).id;
    const t = await ok(call('GET', `tenders/${tid}`, null, viewer), 'get');
    assert.strictEqual(t.status, 'draft'); assert.strictEqual(t.rev, 1); assert.strictEqual(t.root_id, tid); assert.strictEqual(t.snapshot_id, snap1);
    assert.strictEqual(t.M, 6); assert.ok(!('frozen' in t));
    assert.strictEqual((await call('PUT', `tenders/${tid}`, { adv_pct: 95 }, qs)).s, 400, 'adv + ret ≥ 100 after merge');
    assert.strictEqual((await call('PUT', `tenders/${tid}`, { M: 0 }, qs)).s, 400);
    assert.strictEqual((await call('PUT', `tenders/${tid}`, { title: 'x' }, viewer)).s, 403);
    await ok(call('PUT', `tenders/${tid}`, { submit_date: '2026-12-01', client: 'Fake Client 2 LLC' }, qs), 'put');
    assert.strictEqual((await call('GET', `tenders/${tid}`, null, qs)).j.client, 'Fake Client 2 LLC');
    assert.ok((await ok(call('GET', 'tenders', null, viewer), 'list')).some(x => x.id === tid));

    // hidden items copied from active templates, unanswered
    let hid = await ok(call('GET', `tenders/${tid}/hidden`, null, viewer), 'hidden');
    assert.strictEqual(hid.length, 11); assert.ok(hid.every(h => h.status === null));

    // ---- import -------------------------------------------------------------------------------
    const boq = [
      { name: 'Cover', rows: [['Fake Project'], ['Prepared for test']] },
      { name: 'BOQ', rows: [
        ['Bill of Quantities'], [],
        ['No', 'Description', 'Unit', 'Qty'],
        ['1', 'أعمال الحفر', null, null],                       // heading (Arabic)
        ['1.1', 'حفر التربة Excavation', 'm3', '1,250.50'],      // number stored as text with a comma
        [null, '', null, null],                                    // empty row
        ['1.2', 'ردم Backfill', 'm3', 300, null, null],            // trailing nulls
        ['', 'ملاحظة: الأسعار شاملة', '', ''],                      // note row -> heading
      ] }];
    const pv = await ok(call('POST', `tenders/${tid}/import/preview`, { file_b64: b64(boq) }, qs), 'preview');
    assert.deepStrictEqual(pv.sheets.map(s => s.name), ['Cover', 'BOQ']);
    assert.strictEqual(pv.sheets[1].rows[4][3], '1,250.50');
    const many = Array.from({ length: 50 }, (_, i) => [String(i), 'row ' + i, 'm', i]);
    assert.strictEqual((await ok(call('POST', `tenders/${tid}/import/preview`, { file_b64: b64([{ name: 'S', rows: many }]) }, qs), 'preview 50')).sheets[0].rows.length, 30);
    assert.strictEqual((await call('POST', `tenders/${tid}/import/preview`, { file_b64: Buffer.from('not a zip at all, sorry').toString('base64') }, qs)).s, 400);
    assert.strictEqual((await call('POST', `tenders/${tid}/import/preview`, {}, qs)).s, 400);

    const imp = { file_b64: b64(boq), sheet: 'BOQ', header_row: 3, cols: { no: 'A', desc: 1, unit: 'c', qty: 3 } };
    assert.strictEqual((await call('POST', `tenders/${tid}/import`, imp, viewer)).s, 403);
    for (const bad of [{ ...imp, sheet: 'Nope' }, { ...imp, header_row: -1 }, { ...imp, header_row: 1.5 }, { ...imp, cols: { desc: 1 } }, { ...imp, cols: { desc: 'A1', qty: 3 } }, { ...imp, cols: { desc: -1, qty: 3 } }])
      assert.strictEqual((await call('POST', `tenders/${tid}/import`, bad, qs)).s, 400, 'bad import ' + JSON.stringify(bad.cols || bad.sheet || bad.header_row));
    await ok(call('POST', `tenders/${tid}/import`, imp, qs), 'import');
    let rows = await ok(call('GET', `tenders/${tid}/rows`, null, viewer), 'rows');
    assert.deepStrictEqual(rows.map(r => [r.no, r.description, r.unit, r.qty, r.is_heading, r.source]), [
      ['1', 'أعمال الحفر', null, null, 1, 'import'],
      ['1.1', 'حفر التربة Excavation', 'm3', 1250.5, 0, 'import'],
      ['1.2', 'ردم Backfill', 'm3', 300, 0, 'import'],
      [null, 'ملاحظة: الأسعار شاملة', null, null, 1, 'import']]);
    // a non-numeric quantity is an error naming the row, and nothing changes
    const badQty = structuredClone(boq); badQty[1].rows.push(['1.3', 'Bad', 'm', 'about 5']);
    const bq = await call('POST', `tenders/${tid}/import`, { ...imp, file_b64: b64(badQty) }, qs);
    assert.strictEqual(bq.s, 400); assert.ok(/row 9/.test(bq.j.error), bq.j.error);
    const negQty = structuredClone(boq); negQty[1].rows.push(['1.3', 'Neg', 'm', -5]);
    assert.strictEqual((await call('POST', `tenders/${tid}/import`, { ...imp, file_b64: b64(negQty) }, qs)).s, 400);
    assert.strictEqual((await call('POST', `tenders/${tid}/import`, { ...imp, header_row: 50 }, qs)).s, 400, 'no data rows');
    assert.strictEqual((await call('GET', `tenders/${tid}/rows`, null, qs)).j.length, 4, 'failed import changed nothing');

    // ---- take-off --------------------------------------------------------------------------------
    const tr = (await ok(call('POST', `tenders/${tid}/rows`, { no: '2.1', description: 'Kerb take-off', unit: 'm2' }, qs), 'takeoff row')).id;
    await ok(call('POST', `tenders/${tid}/rows/${tr}/lines`, { description: 'Side A', l: 10, w: 2, d: null, count: 1 }, qs), 'line 1');
    await ok(call('POST', `tenders/${tid}/rows/${tr}/lines`, { description: 'Opening', l: 3, w: 1, count: 1, deduct: true }, qs), 'line 2');
    const blank = (await ok(call('POST', `tenders/${tid}/rows/${tr}/lines`, { description: 'all blank', count: 5 }, qs), 'blank line')).id;
    let trow = (await call('GET', `tenders/${tid}/rows`, null, qs)).j.find(r => r.id === tr);
    assert.strictEqual(trow.qty, 17); assert.strictEqual(trow.source, 'takeoff'); assert.strictEqual(trow.lines.length, 3);
    assert.strictEqual((await call('POST', `tenders/${tid}/rows/${tr}/lines`, { l: 100, deduct: true }, qs)).s, 400, 'negative total rejected');
    assert.strictEqual((await call('POST', `tenders/${tid}/rows/${tr}/lines`, { l: -1 }, qs)).s, 400);
    await ok(call('PUT', `tenders/${tid}/rows/${tr}/lines/${blank}`, { l: 2 }, qs), 'line put');   // 2 x 1 x 1 x 5 = 10
    assert.strictEqual((await call('GET', `tenders/${tid}/rows`, null, qs)).j.find(r => r.id === tr).qty, 27);
    await ok(call('DELETE', `tenders/${tid}/rows/${tr}/lines/${blank}`, null, qs), 'line delete');
    assert.strictEqual((await call('GET', `tenders/${tid}/rows`, null, qs)).j.find(r => r.id === tr).qty, 17);
    assert.strictEqual((await call('PUT', `tenders/${tid}/rows/${tr}`, { qty: 5 }, qs)).s, 400, 'take-off qty comes from lines');
    const r11 = rows[1].id, r12 = rows[2].id, head = rows[0].id;
    assert.strictEqual((await call('POST', `tenders/${tid}/rows/${r11}/lines`, { l: 1 }, qs)).s, 400, 'lines only under take-off rows');
    // re-import replaces imported rows only, keeps order, take-off row stays after them
    await ok(call('POST', `tenders/${tid}/import`, imp, qs), 're-import');
    rows = await ok(call('GET', `tenders/${tid}/rows`, null, qs), 'rows');
    assert.strictEqual(rows.length, 5); assert.strictEqual(rows[4].id, tr); assert.strictEqual(rows[4].qty, 17);
    assert.deepStrictEqual(rows.map(r => r.seq), [1, 2, 3, 4, 5]);
    const [h1, a1, a2] = rows;

    // ---- links / manual unit / blocking -----------------------------------------------------------
    assert.ok(!rows.some(r => [r11, r12, head].includes(r.id)), 'old imported rows replaced');
    for (const bad of [[{ item_id: i1, share: 0.6 }, { item_id: i2, share: 0.3 }], [{ item_id: 9999, share: 1 }], [{ item_id: i1, share: 0 }, { item_id: i2, share: 1 }], [{ item_id: i1, share: 0.5 }, { item_id: i1, share: 0.5 }]])
      assert.strictEqual((await call('PUT', `tenders/${tid}/rows/${a1.id}/links`, { links: bad }, qs)).s, 400, 'bad links ' + JSON.stringify(bad));
    assert.strictEqual((await call('PUT', `tenders/${tid}/rows/${h1.id}/links`, { links: [{ item_id: i1, share: 1 }] }, qs)).s, 400, 'no links on a heading');
    await ok(call('PUT', `tenders/${tid}/rows/${a1.id}/links`, { links: [{ item_id: i1, share: 0.6 }, { item_id: i2, share: 0.4 }] }, qs), 'links');
    let pr = await ok(call('GET', `tenders/${tid}/price`, null, qs), 'price');
    const pa1 = pr.rows.find(r => r.id === a1.id);
    near(pa1.direct_unit, 0.6 * units[i1] + 0.4 * units[i2], 'direct_unit = Σ share × unit');
    assert.ok(pr.blocking.some(b => b.code === 'row_unlinked' && b.row_id === a2.id), 'row_unlinked for 1.2');
    assert.ok(pr.blocking.some(b => b.code === 'row_unlinked' && b.row_id === tr), 'row_unlinked for take-off row');
    assert.ok(!pr.blocking.some(b => b.row_id === h1.id), 'headings never block');
    assert.ok(pr.blocking.some(b => b.code === 'hidden_unanswered'), 'hidden_unanswered');
    assert.strictEqual(pr.blocking.filter(b => b.code === 'hidden_unanswered').length, 11);
    assert.strictEqual(pr.newer_snapshot, false);
    assert.ok(pr.result && pr.result.P > 0, 'pricing possible with blocking');
    // a partial price is marked as such
    assert.strictEqual(pr.complete, false); assert.strictEqual(pr.result.partial, true);
    assert.deepStrictEqual(pr.excluded_rows.sort(), [a2.id, tr].sort()); assert.strictEqual(pr.unanswered_hidden.length, 11);

    // manual unit
    assert.strictEqual((await call('PUT', `tenders/${tid}/rows/${a2.id}`, { manual_unit: -1 }, qs)).s, 400);
    assert.strictEqual((await call('PUT', `tenders/${tid}/rows/${h1.id}`, { manual_unit: 5 }, qs)).s, 400);
    await ok(call('PUT', `tenders/${tid}/rows/${a2.id}`, { manual_unit: 50 }, qs), 'manual unit');
    // stale material and missing trade
    await ok(call('PUT', `tenders/${tid}/rows/${tr}/links`, { links: [{ item_id: i3, share: 1 }] }, qs), 'link stale');
    pr = await ok(call('GET', `tenders/${tid}/price`, null, qs), 'price');
    near(pr.rows.find(r => r.id === a2.id).direct_unit, 50, 'manual unit used');
    assert.ok(!pr.blocking.some(b => b.code === 'row_unlinked'));
    assert.ok(pr.blocking.some(b => b.code === 'material_stale' && b.row_id === tr), 'material_stale');
    await ok(call('PUT', `tenders/${tid}/rows/${tr}/links`, { links: [{ item_id: i4, share: 1 }] }, qs), 'link unpriced');
    pr = await ok(call('GET', `tenders/${tid}/price`, null, qs), 'price');
    assert.ok(pr.blocking.some(b => b.code === 'row_unpriced' && b.row_id === tr && /trade:Nobody/.test(b.detail)), 'row_unpriced');
    assert.strictEqual(pr.rows.find(r => r.id === tr).rate, null, 'unpriced row has no rate');
    await ok(call('PUT', `tenders/${tid}/rows/${tr}/links`, { links: [{ item_id: i1, share: 1 }] }, qs), 'link ok');

    // ---- hidden items ------------------------------------------------------------------------------
    hid = (await call('GET', `tenders/${tid}/hidden`, null, qs)).j;
    const byName = n => hid.find(h => h.name_en === n).id;
    assert.strictEqual((await call('PUT', `tenders/${tid}/hidden/${byName('Consultant')}`, { status: 'applies' }, qs)).s, 400, 'applies needs an amount');
    assert.strictEqual((await call('PUT', `tenders/${tid}/hidden/${byName('CAR insurance')}`, { status: 'applies', pct: 100 }, qs)).s, 400, 'pct < 100');
    assert.strictEqual((await call('PUT', `tenders/${tid}/hidden/${byName('Permit deposit')}`, { status: 'applies', amount: 1000, months: 6 }, qs)).s, 400, 'locked needs fee and loss');
    assert.strictEqual((await call('PUT', `tenders/${tid}/hidden/${byName('Consultant')}`, { status: 'maybe' }, qs)).s, 400);
    assert.strictEqual((await call('PUT', `tenders/${tid}/hidden/${byName('Consultant')}`, { status: 'na' }, viewer)).s, 403);
    for (const h of hid) await ok(call('PUT', `tenders/${tid}/hidden/${h.id}`, { status: 'na' }, qs), 'answer');
    await ok(call('PUT', `tenders/${tid}/hidden/${byName('Consultant')}`, { status: 'applies', amount: 10000 }, qs), 'consultant');
    await ok(call('PUT', `tenders/${tid}/hidden/${byName('CAR insurance')}`, { status: 'applies', pct: 0.5 }, qs), 'car');
    await ok(call('PUT', `tenders/${tid}/hidden/${byName('Permit deposit')}`, { status: 'applies', amount: 20000, months: 6, bank_fee_pct: 1, loss_pct: 5 }, qs), 'deposit');
    await ok(call('PUT', `tenders/${tid}/hidden/${byName('Waste disposal')}`, { status: 'included', note: 'in item 1.1' }, qs), 'included');
    const extra = (await ok(call('POST', `tenders/${tid}/hidden`, { name_en: 'Test extra', name_ar: 'إضافي', kind: 'monthly' }, qs), 'custom hidden')).id;
    assert.strictEqual((await call('DELETE', `tenders/${tid}/hidden/${byName('Site office')}`, null, qs)).s, 400, 'template items are answered, not deleted');
    pr = await ok(call('GET', `tenders/${tid}/price`, null, qs), 'price');
    assert.deepStrictEqual(pr.blocking.map(b => [b.code, b.hidden_id]), [['hidden_unanswered', extra]]);
    await ok(call('DELETE', `tenders/${tid}/hidden/${extra}`, null, qs), 'delete custom hidden');

    // ---- clean pricing ----------------------------------------------------------------------------------
    pr = await ok(call('GET', `tenders/${tid}/price`, null, qs), 'price');
    assert.deepStrictEqual(pr.blocking, []);
    assert.strictEqual(pr.complete, true); assert.strictEqual(pr.result.partial, false);
    assert.deepStrictEqual(pr.excluded_rows, []); assert.deepStrictEqual(pr.unanswered_hidden, []);
    const { priceTender } = require('./lib/pricing.js');
    const expect = priceTender({ rows: [{ id: a1.id, qty: 1250.5, direct_unit: 0.6 * units[i1] + 0.4 * units[i2] }, { id: a2.id, qty: 300, direct_unit: 50 }, { id: tr, qty: 17, direct_unit: units[i1] }],
      hidden: [{ kind: 'locked', amount: 20000, months: 6, bank_fee_pct: 1, loss_pct: 5 }, { kind: 'fixed', amount: 10000 }, { kind: 'pct', pct: 0.5 }],
      M: 6, oh_monthly: 20000, w_monthly: 500000, finance_rate_pct: 8, margin_pct: 12, min_profit_pct: 5, adv_pct: 10, ret_pct: 10, collection_days: 60, retention_months: 12 });
    near(pr.result.P, expect.P, 'P'); near(pr.result.total, expect.total, 'total');
    assert.strictEqual(pr.margin_pct, 12, 'settings default margin');
    assert.deepStrictEqual(pr.rows.map(r => r.rate), [null, ...expect.rows.map(r => r.rate).slice(0, 2), null, expect.rows[2].rate]);
    const what = await ok(call('GET', `tenders/${tid}/price?margin_pct=20`, null, qs), 'what-if');
    assert.strictEqual(what.margin_pct, 20); assert.ok(what.result.P > pr.result.P);
    for (const m of ['100', '-1', 'abc']) assert.strictEqual((await call('GET', `tenders/${tid}/price?margin_pct=${m}`, null, qs)).s, 400, 'bad what-if ' + m);
    assert.strictEqual((await call('GET', `tenders/${tid}/price`, null, qs)).j.margin_pct, 12, 'what-if is not saved');
    await ok(call('PUT', `tenders/${tid}`, { margin_pct: 15 }, admin), 'admin sets margin');
    assert.strictEqual((await call('GET', `tenders/${tid}/price`, null, qs)).j.margin_pct, 15);

    // ---- privacy: qs never sees a small trade's rate (Review Focus 4) -------------------------------------
    for (const [ck, who] of [[qs, 'qs'], [viewer, 'viewer']]) {
      const v = await ok(call('GET', `tenders/${tid}/price`, null, ck), 'price ' + who);
      walk(v, o => {
        assert.ok(!('headcount' in o), who + ': no headcounts');
        if (o.trade === 'Foreman') assert.strictEqual(o.rate, null, who + ': no small-trade rate');
      });
      const lk = v.rows.find(r => r.id === a1.id).links.find(l => l.item_id === i2);
      assert.strictEqual(lk.parts[0].cost, null, who + ': single small-trade labour part hidden'); assert.strictEqual(lk.parts[0].hidden, true);
      assert.ok(!('hide' in lk.parts[0]));
      near(lk.parts[1].cost, 2, who + ': fixed part visible');
      assert.ok(!JSON.stringify(v).includes('"hide"'));
    }
    const av = await ok(call('GET', `tenders/${tid}/price`, null, admin), 'price admin');
    near(av.rows.find(r => r.id === a1.id).links.find(l => l.item_id === i2).parts[0].cost, 40, 'admin sees the part');

    // ---- overhead missing: blocking, result null, not a crash ---------------------------------------------
    addSnap({ ...SNAP, oh_monthly: null });
    const tOh = (await ok(call('POST', 'tenders', tInfo, qs), 'create oh')).id;
    const ohRow = (await ok(call('POST', `tenders/${tOh}/rows`, { description: 'Manual row' }, qs), 'row')).id;
    await ok(call('POST', `tenders/${tOh}/rows/${ohRow}/lines`, { l: 5 }, qs), 'line');
    await ok(call('PUT', `tenders/${tOh}/rows/${ohRow}`, { manual_unit: 10 }, qs), 'manual');
    for (const h of (await call('GET', `tenders/${tOh}/hidden`, null, qs)).j) await ok(call('PUT', `tenders/${tOh}/hidden/${h.id}`, { status: 'na' }, qs), 'answer');
    const pOh = await ok(call('GET', `tenders/${tOh}/price`, null, qs), 'price oh');
    assert.strictEqual(pOh.result, null); assert.ok(pOh.blocking.some(b => b.code === 'overhead_missing'));

    // a tender with nothing to price and no blocking: clear 400, not a 500
    addSnap(SNAP);
    const tEmpty = (await ok(call('POST', 'tenders', tInfo, qs), 'create empty')).id;
    for (const h of (await call('GET', `tenders/${tEmpty}/hidden`, null, qs)).j) await ok(call('PUT', `tenders/${tEmpty}/hidden/${h.id}`, { status: 'na' }, qs), 'answer');
    const pe = await call('GET', `tenders/${tEmpty}/price`, null, qs);
    assert.strictEqual(pe.s, 400); assert.ok(/D/.test(pe.j.error));

    // ---- zero qty, missing item version, links removed by re-import ---------------------------------------
    const tZ = (await ok(call('POST', 'tenders', tInfo, qs), 'create z')).id;
    const zr = await ok(call('POST', `tenders/${tZ}/import`, imp, qs), 'import z');
    assert.strictEqual(zr.links_removed, 0);
    const zRows = (await call('GET', `tenders/${tZ}/rows`, null, qs)).j;
    await ok(call('PUT', `tenders/${tZ}/rows/${zRows[1].id}/links`, { links: [{ item_id: i1, share: 1 }] }, qs), 'link z');
    await ok(call('PUT', `tenders/${tZ}/rows/${zRows[2].id}/links`, { links: [{ item_id: i1, share: 0.5 }, { item_id: i2, share: 0.5 }] }, qs), 'link z2');
    assert.strictEqual((await ok(call('POST', `tenders/${tZ}/import`, imp, qs), 're-import z')).links_removed, 3);
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE entity='tenders' AND action='import' AND entity_id=? AND detail LIKE '%\"links_removed\":3%'").get(String(tZ)));
    const zManual = (await ok(call('POST', `tenders/${tZ}/rows`, { description: 'No lines yet' }, qs), 'zero row')).id;
    await ok(call('PUT', `tenders/${tZ}/rows/${zManual}`, { manual_unit: 10 }, qs), 'zero manual');
    const zLinked = (await ok(call('POST', `tenders/${tZ}/rows`, { description: 'No lines, linked' }, qs), 'zero row 2')).id;
    await ok(call('PUT', `tenders/${tZ}/rows/${zLinked}/links`, { links: [{ item_id: i1, share: 1 }] }, qs), 'zero link');
    let pz = await ok(call('GET', `tenders/${tZ}/price`, null, qs), 'price z');
    assert.deepStrictEqual(pz.blocking.filter(b => b.code === 'row_zero_qty').map(b => b.row_id), [zManual, zLinked]);
    const i5 = await item('T-5', [{ kind: 'fixed', amount: 7 }]);
    const zRows2 = (await call('GET', `tenders/${tZ}/rows`, null, qs)).j;
    await ok(call('PUT', `tenders/${tZ}/rows/${zRows2[1].id}/links`, { links: [{ item_id: i5, share: 1 }] }, qs), 'link i5');
    db.prepare('DELETE FROM item_versions WHERE item_id=?').run(i5);
    pz = await ok(call('GET', `tenders/${tZ}/price`, null, qs), 'price with a missing version');
    assert.ok(pz.blocking.some(b => b.code === 'row_unpriced' && b.row_id === zRows2[1].id && /version/.test(b.detail)), 'missing version → row_unpriced');
    assert.ok(pz.excluded_rows.includes(zRows2[1].id));

    // ---- templates: deactivation never changes existing tenders -----------------------------------------
    const site = tpl.find(x => x.name_en === 'Site office').id;
    await ok(call('PUT', `hidden-templates/${site}`, { active: 0 }, admin), 'deactivate');
    await ok(call('POST', 'hidden-templates', { name_en: 'Test template', name_ar: 'قالب', kind: 'fixed', sort: 99 }, admin), 'new template');
    assert.ok((await call('GET', `tenders/${tid}/hidden`, null, qs)).j.some(h => h.name_en === 'Site office'), 'existing tender keeps it');
    const tNew = (await ok(call('POST', 'tenders', tInfo, qs), 'create new')).id;
    const hn = (await call('GET', `tenders/${tNew}/hidden`, null, qs)).j.map(h => h.name_en);
    assert.strictEqual(hn.length, 11); assert.ok(!hn.includes('Site office')); assert.ok(hn.includes('Test template'));

    // ---- rows CRUD + delete tender ---------------------------------------------------------------------------
    assert.strictEqual((await call('DELETE', `tenders/${tid}/rows/${a2.id}`, null, viewer)).s, 403);
    await ok(call('DELETE', `tenders/${tNew}`, null, qs), 'delete draft');
    assert.strictEqual((await call('GET', `tenders/${tNew}`, null, qs)).s, 404);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM tender_hidden WHERE tender_id=?').get(tNew).n, 0);
    for (const [entity, action] of [['tenders', 'create'], ['tenders', 'update'], ['tenders', 'import'], ['tenders', 'delete'], ['tender_rows', 'create'], ['tender_rows', 'update'],
      ['tender_rows', 'links'], ['takeoff_lines', 'create'], ['takeoff_lines', 'update'], ['takeoff_lines', 'delete'], ['tender_hidden', 'create'], ['tender_hidden', 'update'],
      ['tender_hidden', 'delete'], ['hidden_templates', 'create'], ['hidden_templates', 'update']])
      assert.ok(db.prepare('SELECT 1 FROM audit_log WHERE entity=? AND action=?').get(entity, action), `audited: ${entity} ${action}`);
    console.log('tenders ok'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
