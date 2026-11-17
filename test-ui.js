// Browser UI: static files, i18n key coverage, Playwright smoke (skipped when playwright is not installed): node --no-warnings test-ui.js
// UI_SCREENSHOT=/path/to/file.png saves a screenshot of a tender's Summary tab.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'est-ui-'));
process.env.ERP_SYNC_DISABLED = '1';
// every exit removes the temp DATA_DIR
const done = code => { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); process.exit(code); };

// ---- i18n key coverage (no server needed) -------------------------------------------------------------------
const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const I18N = require('./public/i18n.js');
assert.ok(I18N.en && I18N.ar, 'i18n.js exports en and ar');
// every t( call takes a literal key, so the regex below sees every key in use
const nonLiteral = app.match(/\bt\((?!')[^)]{0,40}/g);
assert.strictEqual(nonLiteral, null, 't() must be called with a literal key: ' + JSON.stringify(nonLiteral));
const used = [...new Set([...app.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]))];
assert.ok(used.length > 50, 'app.js uses t() keys');
for (const k of used) for (const l of ['en', 'ar']) assert.ok(typeof I18N[l][k] === 'string' && I18N[l][k].trim(), `key "${k}" missing in ${l}`);
assert.deepStrictEqual(Object.keys(I18N.ar).sort(), Object.keys(I18N.en).sort(), 'ar and en have the same keys');
// batch-2 carry-over: the imperative of «عدّ» is «عُدّ» (not «اعدّ»)
assert.ok(I18N.ar.tv_confirm_mixed.includes('عُدّ') && !I18N.ar.tv_confirm_mixed.includes('اعدّ'), 'AR tv_confirm_mixed: ' + I18N.ar.tv_confirm_mixed);
assert.ok(I18N.en.lk_hint_nested.includes('Include nested inserts') && I18N.ar.lk_hint_nested.includes(I18N.ar.lk_nested), 'the nested hint names the box');
assert.ok(!/innerHTML\s*=(?!\s*'')/.test(app), 'no innerHTML assignments with content (BOQ text is untrusted)');

const { server, db } = require('./server.js');
const SNAP = {
  oh_monthly: 20000, oh_overridden: false, oh_parts: { bills: 120000, payroll: 100000, depreciation: 20000 }, w_monthly: 500000, months_covered: 12,
  trades: [{ trade: 'Foreman', group: 'Site', rate: 40, headcount: 1, overridden: false }, { trade: 'Labourer', group: 'Site', rate: 15, headcount: 4, overridden: false }],
  groups: [{ group: 'Site', rate: 20, headcount: 5 }], equipment: [{ id: 'asset:3', name: 'Test Excavator', rate: 120, source: 'owned', overridden: false }],
  po_prices: [], unmapped: { categories: ['Test Unmapped Category'], designations: [] }, warnings: [{ code: 'short_history', detail: '11 month(s) of bills' }],
};
const addSnap = (data, created = new Date().toISOString()) => Number(db.prepare('INSERT INTO snapshots(created,ok,error,data) VALUES(?,1,NULL,?)').run(created, JSON.stringify(data)).lastInsertRowid);

server.listen(0, async () => {
  const origin = `http://localhost:${server.address().port}`, base = origin + '/api/';
  const call = async (m, u, b, ck) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || '' }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie');
    return { s: r.status, j: await r.json().catch(() => null), ck: sc ? sc.split(';')[0] : '' };
  };
  const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
  let browser = null;
  try {
    // ---- static files -----------------------------------------------------------------------------------
    const idx = await fetch(origin + '/');
    assert.strictEqual(idx.status, 200);
    const html = await idx.text();
    assert.ok(html.includes('<html') && html.includes('app.js') && html.includes('i18n.js') && html.includes('style.css'), 'index.html loads the app');
    for (const f of ['/app.js', '/i18n.js', '/style.css']) assert.strictEqual((await fetch(origin + f)).status, 200, f);
    // the viewer scripts sit in a sub-folder of public/ and are served as JavaScript, loaded by index.html
    for (const f of ['/viewer/core.js', '/viewer/aci.js', '/viewer/canvas.js']) {
      const r = await fetch(origin + f);
      assert.strictEqual(r.status, 200, f); assert.match(r.headers.get('content-type') || '', /^text\/javascript/, f + ' content type');
      assert.ok(html.includes('src="' + f + '"'), 'index.html loads ' + f);
    }

    let pw = null;
    try { pw = require('playwright'); } catch (e) { console.log('ui: playwright not installed, browser smoke skipped'); }
    if (!pw) { console.log('ui ok'); done(0); }

    // ---- fixture: admin, snapshot, material, item, a complete tender and a partial one ------------------
    const admin = (await call('POST', 'setup', { username: 'admin', password: 'secret12' })).ck;
    addSnap(SNAP);
    const mat = (await ok(call('POST', 'costs/materials', { name_en: 'Test Concrete', unit: 'm3' }, admin), 'material')).id;
    await ok(call('POST', `costs/materials/${mat}/quotes`, { date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), rate: 300, supplier: 'Fake Supplier LLC' }, admin), 'quote');
    const sec = (await call('GET', 'library/sections', null, admin)).j[0].id;
    const item = (await ok(call('POST', 'library/items', { code: 'T-1', section_id: sec, uom: 'm3', name_en: 'Test concrete item', name_ar: 'بند خرسانة تجريبي', rework_pct: 0,
      parts: [{ kind: 'material', material_id: mat, qty: 1, waste_pct: 0 }, { kind: 'labour', crew: [{ trade: 'Foreman', count: 1 }], output_per_day: 8 }, { kind: 'fixed', amount: 5 }] }, admin), 'item')).id;
    const info = { title: 'Test UI Road', ref: 'UI-1', client: 'Fake Client LLC', kind: 'direct', M: 4, adv_pct: 0, ret_pct: 5, collection_days: 45, retention_months: 6 };
    const makeTender = async (title, unlinked, zeroQty) => {
      const id = (await ok(call('POST', 'tenders', { ...info, title }, admin), 'tender')).id;
      await ok(call('POST', `tenders/${id}/rows`, { no: 'A', description: 'Test heading section', is_heading: true }, admin), 'heading');
      const row = (await ok(call('POST', `tenders/${id}/rows`, { no: '1', description: 'Test <b id="xss">concrete</b> works', unit: 'm3' }, admin), 'row')).id;
      await ok(call('POST', `tenders/${id}/rows/${row}/lines`, { description: 'slab', l: 10, w: 5, d: 0.2, count: 2 }, admin), 'line');
      await ok(call('PUT', `tenders/${id}/rows/${row}/links`, { links: [{ item_id: item, share: 1 }] }, admin), 'link');
      if (unlinked) await ok(call('POST', `tenders/${id}/rows`, { no: '2', description: 'Test unlinked row', unit: 'm2' }, admin), 'unlinked row');
      if (zeroQty) {   // linked but no take-off lines yet: priced (complete) yet blocked by row_zero_qty
        const z = (await ok(call('POST', `tenders/${id}/rows`, { no: '3', description: 'Test zero qty row', unit: 'm3' }, admin), 'zero row')).id;
        await ok(call('PUT', `tenders/${id}/rows/${z}/links`, { links: [{ item_id: item, share: 1 }] }, admin), 'zero link');
      }
      for (const h of (await call('GET', `tenders/${id}/hidden`, null, admin)).j) await ok(call('PUT', `tenders/${id}/hidden/${h.id}`, { status: 'na' }, admin), 'answer');
      return id;
    };
    const full = await makeTender('Test UI Complete', false), partial = await makeTender('Test UI Partial', true), blocked = await makeTender('Test UI Blocked', false, true);
    const bound = (await call('GET', `tenders/${full}`, null, admin)).j.snapshot_id;
    const latestSnap = addSnap({ ...SNAP, oh_monthly: 30000 });   // a newer sync: every tender now has newer_snapshot
    // the last sync attempt failed: red banner with the last good time
    db.prepare('INSERT INTO snapshots(created,ok,error,data) VALUES(?,0,?,NULL)').run(new Date().toISOString(), 'test: ERP file not found');

    // ---- browser smoke ----------------------------------------------------------------------------------
    browser = await pw.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    page.on('dialog', d => d.accept());
    await page.goto(origin + '/');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'secret12');
    await page.click('#login-submit');
    await page.waitForSelector('#page-home');
    assert.strictEqual(await page.evaluate(() => document.dir), 'ltr');
    const banner = await page.textContent('#sync-banner .banner-red');
    assert.ok(banner && /\d{4}-\d{2}-\d{2}/.test(banner), 'red sync banner shows the last good sync time: ' + banner);

    // create a tender through the UI, then its Summary tab renders (no price yet: blocked, not a number)
    await page.click('#new-tender');
    await page.fill('#nt-title', 'Test UI New Tender');
    await page.click('#nt-save');
    await page.waitForSelector('#page-tender');
    await page.click('#tab-summary');
    await page.waitForSelector('#summary');
    assert.ok(await page.isVisible('#price-banner'), 'a tender without a price shows the blocked banner');
    assert.ok(await page.isVisible('#blocking-list'), 'blocking list is shown');

    // complete tender: the three numbers, no partial banner, newer-costs banner, what-if is not saved
    await page.goto(`${origin}/#/tender/${full}/summary`);
    await page.waitForSelector(`#summary[data-tender="${full}"] #num-P`);
    assert.strictEqual(await page.$('#price-banner'), null, 'complete price: no partial banner');
    assert.ok(await page.isVisible('#newer-banner'), 'newer snapshot banner');
    const pr = (await call('GET', `tenders/${full}/price`, null, admin)).j;
    const shownP = (await page.textContent('#num-P')).trim();
    assert.strictEqual(shownP, pr.result.P.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), 'P shown with 2 decimals');
    assert.ok(await page.isVisible('#waterfall'), 'waterfall');
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT, fullPage: true });
    await page.fill('#wi-margin', '20');
    await page.fill('#wi-M', '8');
    await page.click('#wi-apply');
    await page.waitForSelector('#whatif-note');
    assert.notStrictEqual((await page.textContent('#num-P')).trim(), shownP, 'what-if changes P on screen');
    const after = (await call('GET', `tenders/${full}`, null, admin)).j;
    assert.strictEqual(after.margin_pct, null); assert.strictEqual(after.M, 4, 'what-if saves nothing');

    // reprice: the difference is shown first and nothing changes until Apply (spec 7.8)
    await page.click('#reprice');
    await page.waitForSelector('#reprice-preview-box');
    const preview = (await call('GET', `tenders/${full}/price?snapshot=latest`, null, admin)).j;
    const f2 = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.ok((await page.textContent('#reprice-old')).includes(f2(pr.result.P)), 'preview shows the old P');
    assert.ok((await page.textContent('#reprice-new')).includes(f2(preview.result.P)), 'preview shows the new P');
    assert.notStrictEqual(preview.result.P, pr.result.P);
    assert.strictEqual((await call('GET', `tenders/${full}`, null, admin)).j.snapshot_id, bound, 'the preview does not rebind the tender');
    await page.click('#reprice-apply');
    await page.waitForSelector('#reprice-result');
    assert.strictEqual((await call('GET', `tenders/${full}`, null, admin)).j.snapshot_id, latestSnap, 'Apply rebinds to the latest costs');

    // approval only at the margin of the numbers on screen
    await ok(call('POST', `tenders/${full}/submit`, null, admin), 'submit');
    await page.click('#tab-info'); await page.waitForSelector('#tab-body-info');
    await page.click('#tab-summary'); await page.waitForSelector(`#summary[data-tender="${full}"] #ap-approve`);
    // the snapshot has a warning: it is listed, and approval waits for the acknowledgement
    assert.ok((await page.textContent('#snapshot-warnings')).includes('short_history'), 'snapshot warnings listed on the Summary');
    assert.strictEqual(await page.isEnabled('#ap-approve'), false, 'approve waits for the warnings acknowledgement');
    await page.check('#ap-ack');
    assert.strictEqual(await page.isEnabled('#ap-approve'), true, 'approve enabled at the shown margin');
    await page.fill('#ap-margin', '20');
    assert.ok(await page.isVisible('#ap-margin-changed'), 'changed margin warns');
    assert.strictEqual(await page.isEnabled('#ap-approve'), false, 'changed margin blocks approve');
    await page.click('#ap-reprice');
    await page.waitForSelector('#whatif-note');
    const at20 = (await call('GET', `tenders/${full}/price?margin_pct=20`, null, admin)).j.result.P;
    assert.strictEqual((await page.textContent('#num-P')).trim(), f2(at20), 'priced at the typed margin');
    await page.check('#ap-ack');
    assert.strictEqual(await page.isEnabled('#ap-approve'), true, 'approve enabled once priced at that margin');
    await page.click('#ap-approve');
    await page.waitForSelector('#summary .banner-ok');
    assert.ok((await page.textContent('#frozen-warnings')).includes('short_history'), 'frozen Summary shows the acknowledged warnings');
    const fb = await page.textContent('#summary .banner-ok');
    assert.ok(fb.includes('Margin: ') && !fb.includes('Margin %'), 'margin label without a second %: ' + fb);
    assert.ok(!(await page.textContent('#summary')).includes('Margin %'), 'no "Margin %: 12 %" on the frozen Summary');
    const ap = (await call('GET', `tenders/${full}`, null, admin)).j;
    assert.strictEqual(ap.status, 'approved'); assert.strictEqual(ap.margin_pct, 20); assert.strictEqual(ap.approved_P, at20, 'approved P is the P that was shown');

    // complete but blocked: BLOCKED, not PARTIAL
    await page.goto(`${origin}/#/tender/${blocked}/summary`);
    await page.waitForSelector(`#summary[data-tender="${blocked}"] #num-P`);
    const bb = await page.textContent('#price-banner');
    assert.ok(bb.includes('BLOCKED — not a tender price') && !bb.includes('PARTIAL'), 'blocked banner: ' + bb);

    // partial tender: P is shown under the PARTIAL banner, the blocking row links to its row
    await page.goto(`${origin}/#/tender/${partial}/summary`);
    await page.waitForSelector(`#summary[data-tender="${partial}"] #num-P`);
    const pb = await page.textContent('#price-banner');
    assert.ok(pb.includes('PARTIAL — not a tender price'), 'partial banner: ' + pb);
    assert.ok(await page.isVisible('#blocking-list a'), 'blocking item links to the row');

    // Links tab of a partial tender: no plain per-row rate
    await page.click('#tab-links'); await page.waitForSelector('#tab-body-links');
    const pp = (await call('GET', `tenders/${partial}/price`, null, admin)).j;
    const linkedRow = pp.rows.find(r => r.rate !== null);
    const rateTxt = await page.textContent(`#row-${linkedRow.id} .rate`);
    assert.ok(rateTxt.includes('—') && rateTxt.includes('PARTIAL — not a tender price'), 'partial rate marked: ' + rateTxt);
    assert.ok(!rateTxt.includes(f2(linkedRow.rate)), 'partial rate not shown as a number');

    // other tabs, BOQ text is escaped, headings are marked
    for (const tab of ['info', 'quantities', 'links', 'hidden']) { await page.click('#tab-' + tab); await page.waitForSelector('#tab-body-' + tab); }
    await page.click('#tab-quantities'); await page.waitForSelector('#tab-body-quantities');
    assert.strictEqual(await page.$('#xss'), null, 'BOQ description is inserted as text');
    assert.ok((await page.textContent('#tab-body-quantities')).includes('<b id="xss">concrete</b>'), 'BOQ description shown literally');
    assert.ok(await page.$('#tab-body-quantities tr.heading'), 'heading rows are marked');

    // ---- Drawings tab: upload a DXF, confirm units, link layers to rows, measured vs client qty ----------------
    // fixture (mm): KERB = one 3000×4000 line (5 m open length in plan; its Z differs → z_ignored); أسفلت = a 10 m square (100 m2);
    // MH = three MH1 inserts, two at the same point (a possible duplicate); CURVE = a SPLINE (approximated);
    // BOW = a 2 m square (4 m2) and a self-intersecting bowtie (excluded from the area)
    const dxf = pairs => [...pairs, [0, 'EOF']].map(([c, v]) => c + '\n' + v).join('\n') + '\n';
    const dsec = (name, pairs) => [[0, 'SECTION'], [2, name], ...pairs, [0, 'ENDSEC']];
    const layerRec = name => [[0, 'LAYER'], [2, name], [70, 0], [62, 7], [6, 'CONTINUOUS']];
    const lwp = (hd, pts, layer) => [[0, 'LWPOLYLINE'], [5, hd], [8, layer], [90, pts.length], [70, 1], ...pts.flatMap(([x, y]) => [[10, x], [20, y]])];
    const ins = (hd, x) => [[0, 'INSERT'], [5, hd], [8, 'MH'], [2, 'MH1'], [10, x], [20, 0]];
    const FIX = dxf([...dsec('HEADER', [[9, '$INSUNITS'], [70, 4]]),
      ...dsec('TABLES', [[0, 'TABLE'], [2, 'LAYER'], [70, 6], ...layerRec('KERB'), ...layerRec('MH'), ...layerRec('أسفلت'), ...layerRec('CURVE'), ...layerRec('BOW'), ...layerRec('DROP'), [0, 'ENDTAB']]),
      ...dsec('BLOCKS', [[0, 'BLOCK'], [2, 'MH1'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK']]),
      ...dsec('ENTITIES', [[0, 'LINE'], [5, 'K1'], [8, 'KERB'], [10, 0], [20, 0], [30, 0], [11, 3000], [21, 4000], [31, 500],
        ...lwp('A1', [[0, 0], [10000, 0], [10000, 10000], [0, 10000]], 'أسفلت'), ...ins('M1', 0), ...ins('M2', 5000), ...ins('M3', 0),
        ...lwp('B1', [[20000, 0], [22000, 0], [22000, 2000], [20000, 2000]], 'BOW'), ...lwp('B2', [[0, 20000], [1000, 21000], [1000, 20000], [0, 21000]], 'BOW'),
        [0, 'SPLINE'], [5, 'S1'], [8, 'CURVE'], [70, 8], [71, 1], [72, 4], [73, 2], [40, 0], [40, 0], [40, 1], [40, 1], [10, 0], [20, 0], [10, 3000], [20, 4000],
        [0, 'XLINE'], [5, 'X1'], [8, 'KERB'], ...lwp('Q1', [[40000, 0], [42000, 0], [42000, 2000], [40000, 2000]], 'DROP'), [0, 'MLINE'], [5, 'QM'], [8, 'DROP']])]);
    const { writeXlsx } = require('./lib/xlsx.js');
    const dwg = (await ok(call('POST', 'tenders', { ...info, title: 'Test UI Drawings' }, admin), 'drawings tender')).id;
    await ok(call('POST', `tenders/${dwg}/import`, { file_b64: writeXlsx([{ name: 'BOQ', rows: [['No', 'Description', 'Unit', 'Qty'], ['1', 'Test asphalt', 'm2', 95], ['3', 'Test legacy row', 'm2', 10]] }]).toString('base64'),
      sheet: 'BOQ', header_row: 1, cols: { no: 'A', desc: 'B', unit: 'C', qty: 'D' } }, admin), 'import');
    const kerbRow = (await ok(call('POST', `tenders/${dwg}/rows`, { no: '2', description: 'Test kerb', unit: 'm' }, admin), 'kerb row')).id;
    const kerbRowB = (await ok(call('POST', `tenders/${dwg}/rows`, { no: '4', description: 'Test kerb B', unit: 'm' }, admin), 'kerb row B')).id;
    const bowRow = (await ok(call('POST', `tenders/${dwg}/rows`, { no: '5', description: 'Test bow', unit: 'm2' }, admin), 'bow row')).id;
    const mhRow = (await ok(call('POST', `tenders/${dwg}/rows`, { no: '6', description: 'Test manholes', unit: 'nr' }, admin), 'manhole row')).id;
    const imported = (await call('GET', `tenders/${dwg}/rows`, null, admin)).j;
    const asphRow = imported.find(r => r.description === 'Test asphalt').id, legacyRow = imported.find(r => r.description === 'Test legacy row').id;
    const mCount = async () => { const j = (await call('GET', `tenders/${dwg}/measurements`, null, admin)).j; return j.measurements.length + j.unlinked.length; };
    const D = `#drawings[data-tender="${dwg}"]`;
    await page.goto(`${origin}/#/tender/${dwg}/drawings`);
    await page.waitForSelector(D + ' #dw-upload');
    assert.ok((await page.textContent('.tabs')).match(/Quantities\s*Drawings\s*Links/), 'Drawings tab sits between Quantities and Links');
    await page.fill('#dw-name', 'Test site plan');
    await page.setInputFiles('#dw-file', { name: 'plan.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from(FIX, 'utf8') });
    await page.click('#dw-upload');
    // parsed → the drawing opens with its units panel; nothing measured before the units are confirmed
    await page.waitForSelector(D + ' #dw-confirm-units');
    assert.strictEqual(await page.inputValue('#dw-unit-select'), 'mm', 'suggested units pre-selected');
    const kerbBefore = await page.textContent(D + ' tr[data-layer="KERB"]');
    assert.ok(kerbBefore.includes('—') && !kerbBefore.includes('5.00'), 'no quantity before the units are confirmed: ' + kerbBefore);
    assert.strictEqual(await page.$(D + ' .lk-btn'), null, 'no Link buttons before the units are confirmed');
    assert.ok((await page.textContent(D + ' #dw-ignored')).includes('XLINE × 1'), 'ignored entity types listed');
    await page.click('#dw-confirm-units');
    await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
    assert.ok((await page.textContent(D + ' tr[data-layer="KERB"] td.m-open_length')).includes('5.00'), 'KERB open length 5.00 m');
    assert.strictEqual((await page.textContent(D + ' tr[data-layer="أسفلت"] td.layer-name')).trim(), 'أسفلت', 'Arabic layer name unchanged');
    assert.ok((await page.textContent(D + ' tr[data-layer="MH"] td.m-blocks')).includes('MH1: 3 / 0'), 'block counts top / nested');
    assert.ok((await page.textContent(D + ' tr[data-layer="MH"] td.notes')).includes('MH1: possible duplicates: 1 (counted in the total)'), 'duplicate warning next to its layer');
    assert.ok((await page.textContent(D + ' tr[data-layer="CURVE"] td.notes')).includes('approximated curves: 1'), 'approx tag next to its layer');
    assert.ok((await page.textContent(D + ' tr[data-layer="BOW"] td.notes')).includes('shapes excluded from area: 1'), 'area_excluded tag next to its layer');
    assert.ok((await page.textContent(D + ' tr[data-layer="DROP"] td.notes')).includes('shapes not measured: 1'), 'dropped tag next to its layer');
    assert.ok(!(await page.textContent(D + ' tr[data-layer="KERB"] td.notes')).includes('not measured'), 'annotation (XLINE) is not a dropped shape');
    assert.ok((await page.textContent(D + ' #dw-warnings li[data-code="z_ignored"]')).includes('Height (Z) differences ignored'), 'drawing warning in plain words');

    // link KERB open length to the take-off row (m)
    const linkTo = async (layer, metric, rowId) => {
      await page.click(`${D} tr[data-layer="${layer}"] td.m-${metric} .lk-btn`);
      await page.waitForSelector(D + ' #lk-form');
      await page.selectOption('#lk-row', String(rowId));
      await page.click('#lk-save');
    };
    await linkTo('KERB', 'open_length', kerbRow);
    await page.waitForSelector(`${D} #dw-measurements tr[data-row="${kerbRow}"]`);
    // the same layer on the same row again: the server's 409 with a confirm checkbox; untick → nothing saved
    await linkTo('KERB', 'open_length', kerbRow);
    await page.waitForSelector(D + ' #lk-confirm-overlap');
    assert.ok((await page.textContent(D + ' #lk-msg')).includes('already measured on this row'), 'overlap message shown');
    assert.strictEqual(await page.$(D + ' #lk-confirm-uom'), null, 'no unit checkbox for an overlap');
    // a tick belongs to the row it was given for: switching the row clears it, and row B (also measured) gets its own 409
    const dId = (await call('GET', `tenders/${dwg}/drawings`, null, admin)).j[0].id;
    await ok(call('POST', `drawings/${dId}/measurements`, { row_id: kerbRowB, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' }, admin), 'KERB on row B');
    await page.check('#lk-confirm-overlap');
    await page.selectOption('#lk-row', String(kerbRowB));
    assert.strictEqual(await page.$(D + ' #lk-confirm-overlap'), null, 'row change clears the confirmation');
    assert.strictEqual((await page.textContent(D + ' #lk-msg')).trim(), '', 'row change clears the server message');
    await page.click('#lk-save');
    await page.waitForSelector(D + ' #lk-confirm-overlap');
    assert.strictEqual(await page.isChecked('#lk-confirm-overlap'), false, 'fresh, unticked confirmation for row B');
    assert.strictEqual(await mCount(), 2, 'nothing saved without a confirmation for row B');
    // a known unit mismatch (m into m2): message and the width/depth hint, no checkbox
    await page.selectOption('#lk-row', String(asphRow));
    await page.click('#lk-save');
    await page.waitForFunction(() => (document.querySelector('#lk-msg') || {}).textContent.includes('unit mismatch'));
    assert.ok(await page.$(D + ' #lk-hint-width'), 'width/depth hint for a unit mismatch');
    assert.strictEqual(await page.$(D + ' #lk-confirm-uom'), null, 'no override for known units');
    // a comma in a width is refused here, never read as 15
    await page.fill('#lk-width', '1,5');
    await page.click('#lk-save');
    await page.waitForFunction(() => (document.querySelector('#lk-msg') || {}).textContent.includes('is not a number'));
    assert.ok((await page.textContent(D + ' #lk-msg')).includes('1,5'), 'the typed value is quoted');
    assert.strictEqual(await mCount(), 2, 'nothing sent for "1,5"');
    await page.click('#lk-cancel');
    // an incomplete layer total (the bowtie has no area): 409 with its confirm box; ticked → saved and flagged
    await linkTo('BOW', 'area', bowRow);
    await page.waitForSelector(D + ' #lk-confirm-incomplete');
    assert.ok((await page.textContent(D + ' #lk-msg')).includes('layer quantity is incomplete'), 'incomplete message shown');
    await page.check('#lk-confirm-incomplete');
    await page.click('#lk-save');
    await page.waitForSelector(`${D} #dw-measurements tr[data-row="${bowRow}"]`);
    assert.ok((await page.textContent(`${D} #dw-measurements tr[data-row="${bowRow}"]`)).includes('incomplete'), 'incomplete flag in the measurement list');
    // the browser logs the refusals asked for above (3 × 409, 400 unit mismatch); nothing else may be logged
    for (const code of ['409 (Conflict)', '409 (Conflict)', '409 (Conflict)', '400 (Bad Request)']) {
      const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes(code));
      assert.ok(i >= 0, 'expected refusal logged: ' + code); errors.splice(i, 1);
    }
    // the Arabic asphalt layer's area → the imported m2 row (100 vs client 95: +5.26 %)
    await linkTo('أسفلت', 'area', asphRow);
    await page.waitForSelector(`${D} #dw-measurements tr[data-row="${asphRow}"]`);
    assert.strictEqual((await call('GET', `tenders/${dwg}/measurements`, null, admin)).j.measurements.length, 4, 'four measurements saved');
    // MH1 twice at one point (possible duplicate): 409 with its own confirm box; ticked → saved and flagged
    await page.click(`${D} tr[data-layer="MH"] td.m-blocks .lk-btn`);
    await page.waitForSelector(D + ' #lk-form');
    await page.selectOption('#lk-row', String(mhRow));
    await page.click('#lk-save');
    await page.waitForSelector(D + ' #lk-confirm-duplicate');
    assert.ok((await page.textContent(D + ' #lk-msg')).includes('possible duplicates on this layer'), 'duplicate message shown');
    await page.check('#lk-confirm-duplicate');
    await page.click('#lk-save');
    await page.waitForSelector(`${D} #dw-measurements tr[data-row="${mhRow}"]`);
    assert.ok((await page.textContent(`${D} #dw-measurements tr[data-row="${mhRow}"]`)).includes('possible duplicates'), 'duplicate flag in the measurement list');
    { const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes('409 (Conflict)')); assert.ok(i >= 0, 'duplicate refusal logged'); errors.splice(i, 1); }
    if (process.env.DRAWINGS_SCREENSHOT) await page.screenshot({ path: process.env.DRAWINGS_SCREENSHOT, fullPage: true });
    // legacy data (before the one-unit rule): a row measured in two units is shown as mixed, never summed
    const legacy = db.prepare("INSERT INTO measurements(drawing_id,tender_id,row_id,tool,layer,metric,qty,qty_unit,created) VALUES(?,?,?,'dxf_layer','KERB',?,?,?,?)");
    legacy.run(dId, dwg, legacyRow, 'area', 3, 'm2', new Date().toISOString()); legacy.run(dId, dwg, legacyRow, 'open_length', 2, 'm', new Date().toISOString());
    // a volume: KERB 5 m × width 0.5 × depth 0.2 × factor 2 = 1 m3 (its formula is checked in the measurement list below)
    const faceRow = (await ok(call('POST', `tenders/${dwg}/rows`, { no: '7', description: 'Test kerb bedding', unit: 'm3' }, admin), 'm3 row')).id;
    await ok(call('POST', `drawings/${dId}/measurements`, { row_id: faceRow, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length', width: 0.5, depth: 0.2, factor: 2, confirm_overlap: true }, admin), 'm3 measurement');

    // Quantities: the take-off row qty is the measurement; the imported row keeps 95 and shows measured 100 with a warning badge
    await page.click('#tab-quantities'); await page.waitForSelector('#tab-body-quantities');
    assert.strictEqual(Number((await page.textContent(`#row-${kerbRow} td.qty`)).trim()), 5, 'take-off row qty 5 from the drawing');
    assert.strictEqual((await page.textContent(`#row-${kerbRow} td.measured .from-drawings`)).trim(), 'includes 5 m from drawings', 'take-off row: what the drawings contribute');
    assert.strictEqual((await page.textContent(`#row-${faceRow} td.measured .from-drawings`)).trim(), 'includes 1 m3 from drawings');
    assert.strictEqual(await page.$(`#row-${asphRow} td.measured .from-drawings`), null, 'an imported row shows measured vs client instead');
    const mtxt = await page.textContent(`#row-${asphRow} td.measured`);
    assert.ok(mtxt.includes('100') && mtxt.includes('+5.26 %'), 'measured qty and diff on the imported row: ' + mtxt);
    assert.ok(await page.$(`#row-${asphRow} td.measured .tag.bad`), 'diff above 5 % in the warning colour');
    assert.ok((await page.textContent(`#row-${bowRow} td.measured`)).includes('incomplete'), 'measured_incomplete badge');
    assert.ok((await page.textContent(`#row-${mhRow} td.measured`)).includes('possible duplicates'), 'measured_duplicate badge');
    const lg = await page.textContent(`#row-${legacyRow} td.measured`);
    assert.ok(lg.includes('mixed units') && !/\b5\b/.test(lg), 'mixed units, not a sum: ' + lg);
    assert.ok((await page.textContent(`#row-${asphRow} td.qty`)).includes('95') || await page.inputValue(`#row-${asphRow} td.qty input`) === '95', 'client qty unchanged');
    // Summary lists the measure warning (not blocking)
    await page.click('#tab-summary'); await page.waitForSelector(`#summary[data-tender="${dwg}"]`);
    const mw = await page.textContent('#measure-warnings');
    assert.ok(mw.includes('Test asphalt') && mw.includes('+5.26 %'), 'measure warning listed: ' + mw);
    await page.click('#measure-warnings a');
    await page.waitForSelector(`#tab-body-quantities #row-${asphRow}.focus`);

    // delete a measurement from the list → the row qty goes back to 0
    await page.click('#tab-drawings'); await page.waitForSelector(`${D} #dw-measurements tr[data-row="${kerbRow}"]`);
    // every measurement shows its formula with the inputs; one saved before the base column derives it from qty
    const formula = async r => (await page.textContent(`${D} #dw-measurements tr[data-row="${r}"] td.m-formula`)).trim();
    assert.strictEqual(await formula(faceRow), 'open length 5.00 m × width 0.5 × depth 0.2 × factor 2 = 1.00 m3');
    assert.strictEqual(await formula(kerbRow), 'open length 5.00 m = 5.00 m', 'no width/depth/factor: base and qty only');
    assert.deepStrictEqual(await page.$$eval(`${D} #dw-measurements tr[data-row="${legacyRow}"] td.m-formula`, x => x.map(e => e.textContent.trim())),
      ['area 3.00 m2 = 3.00 m2', 'open length 2.00 m = 2.00 m'], 'legacy rows (no base): derived from qty');
    await page.click(`${D} #dw-measurements tr[data-row="${kerbRow}"] .m-delete`);
    await page.waitForFunction(r => !document.querySelector(`#dw-measurements tr[data-row="${r}"]`), kerbRow);
    assert.strictEqual((await call('GET', `tenders/${dwg}/rows`, null, admin)).j.find(r => r.id === kerbRow).qty, 0, 'row qty after delete');

    // a ready drawing whose parsed summary is missing on disk: a banner on that drawing; upload and measurements still work
    {
      const body = FIX.replace('K1\n8\nKERB', 'K8\n8\nKERB');
      const up = await fetch(`${base}tenders/${dwg}/drawings?name=broken`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: admin }, body: Buffer.from(body) });
      assert.strictEqual(up.status, 202);
      const bid = (await up.json()).id;
      for (const t0 = Date.now(); db.prepare('SELECT status FROM drawings WHERE id=?').get(bid).status === 'parsing';) {
        if (Date.now() - t0 > 10000) throw new Error('still parsing'); await new Promise(f => setTimeout(f, 20));
      }
      const sha = db.prepare('SELECT sha256 FROM drawings WHERE id=?').get(bid).sha256;
      // summary and .dxf both gone (with only the summary missing the server rebuilds it, see test-drawings.js)
      for (const e of ['.summary.json.gz', '.dxf']) fs.unlinkSync(path.join(process.env.DATA_DIR, 'drawings', sha + e));
      const nErr = errors.length;
      await page.goto(`${origin}/#/tender/${dwg}/drawings/${bid}`);
      await page.waitForSelector(D + ' #dw-panel-error');
      assert.ok((await page.textContent(D + ' #dw-panel-error')).includes('the parsed drawing is missing'), 'banner says why');
      assert.ok(await page.$(D + ' #dw-upload'), 'the upload panel is still there');
      assert.ok(await page.$(`${D} #dw-measurements tr[data-row="${faceRow}"]`), 'the measurement list is still there');
      const added = errors.splice(nErr);
      assert.ok(added.length > 0 && added.every(x => x.startsWith('Failed to load resource') && x.includes('409 (Conflict)')), 'only the refused reads are logged: ' + JSON.stringify(added));
      db.prepare('DELETE FROM drawings WHERE id=?').run(bid);   // not part of the checks below
      await page.goto(`${origin}/#/tender/${dwg}/drawings`); await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
    }

    // ---- viewer: the drawing on a canvas; click/window selection, preview totals, link a selection ----------------
    // screen point of a world point (drawing units), in page coordinates, from the page's own view transform
    const at = (x, y) => page.evaluate(([x, y]) => {
      const v = window.__tvViewer, [sx, sy] = TV.toScreen(v.view(), x, y), r = v.canvas.getBoundingClientRect();
      return [r.left + sx, r.top + sy];
    }, [x, y]);
    const frame = () => page.evaluate(() => new Promise(f => requestAnimationFrame(() => requestAnimationFrame(f))));
    const nSel = async () => Number(await page.getAttribute('#tv-selected', 'data-n'));
    const clickAt = async (x, y, mods) => {
      await page.locator('#tv-canvas').scrollIntoViewIfNeeded();   // a click elsewhere (Link) may have scrolled the page
      const [sx, sy] = await at(x, y);
      if (mods) await page.keyboard.down(mods);
      await page.mouse.click(sx, sy);
      if (mods) await page.keyboard.up(mods);
      await frame();
    };
    const openViewer = async () => {
      await page.click(D + ' #tv-open');
      await page.waitForSelector(D + ' #tv-canvas[data-ready="1"]');
      await page.locator('#tv-canvas').scrollIntoViewIfNeeded();
      await frame();
    };
    // a display file the server refuses (409): its reason in a banner, the rest of the tab keeps working
    await page.route('**/api/drawings/*/render', r => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'display not available for this drawing: test reason' }) }));
    await page.click(D + ' #tv-open');
    await page.waitForSelector(D + ' #tv-error');
    assert.ok((await page.textContent(D + ' #tv-error')).includes('display not available for this drawing: test reason'), 'refusal shown');
    assert.ok(await page.$(D + ' #dw-layers') && await page.isEnabled(D + ' #tv-open'), 'the tab keeps working; Open can be tried again');
    await page.unroute('**/api/drawings/*/render');
    { const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes('409 (Conflict)')); assert.ok(i >= 0, 'display refusal logged'); errors.splice(i, 1); }
    // final review item 10: a 500 from render, or a failure while the viewer is built: back to Open with the message
    await page.route('**/api/drawings/*/render', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal error' }) }));
    await page.click(D + ' #tv-open');
    await page.waitForSelector(D + ' #tv-error');
    assert.ok((await page.textContent(D + ' #tv-error')).includes('internal error'), '500 shown');
    assert.ok(await page.isEnabled(D + ' #tv-open'), 'Open can be tried again after a 500');
    await page.unroute('**/api/drawings/*/render');
    { const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes('500')); assert.ok(i >= 0, '500 logged'); errors.splice(i, 1); }
    await page.evaluate(() => { window.__tvCreateReal = TVCanvas.create; TVCanvas.create = () => { throw new Error('test engine failure'); }; });
    await page.click(D + ' #tv-open');
    await page.waitForSelector(D + ' #tv-error');
    assert.ok((await page.textContent(D + ' #tv-error')).includes('test engine failure'), 'a failure after the download is shown too');
    assert.ok(await page.isEnabled(D + ' #tv-open'), 'no stuck disabled Open'); assert.strictEqual(await page.$(D + ' #tv-loading'), null, 'not stuck loading');
    await page.evaluate(() => { TVCanvas.create = window.__tvCreateReal; });
    await openViewer();
    assert.strictEqual(await page.$(D + ' #tv-error'), null, 'banner gone once shown');
    assert.ok(await page.evaluate(() => typeof window.__tvLastFrameMs === 'number'), 'a frame was drawn');
    assert.strictEqual((await page.textContent('#tv-sel-notes')).trim(), '', 'no notes without a selection');
    assert.strictEqual(await nSel(), 0, 'nothing selected at first');
    assert.strictEqual((await page.textContent('#tv-preview [data-metric="open_length"] .v')).trim(), '—', 'no preview without a selection');
    // KERB alone: the SPLINE on CURVE is the same line, and the asphalt square around it would take a click inside it
    await page.click('#tv-none');
    await page.check('#tv-layers [data-layer="KERB"] input');
    await clickAt(1500, 2000);
    assert.strictEqual(await nSel(), 1, '1 selected');
    assert.strictEqual((await page.textContent('#tv-preview [data-metric="open_length"] .v')).trim(), '5.00 m', 'preview open length 5.00');
    assert.match(await page.textContent('#tv-preview'), /preview/i, 'labelled preview');
    assert.ok((await page.textContent('#tv-hover')).includes('K1'), 'hovered entity handle shown');
    // link the selection to the take-off row (m): the server's qty, the selection cleared, the list refreshed (viewer stays open)
    await page.click('#tv-link');
    await page.waitForSelector(D + ' #lk-form #lk-metric');
    await page.selectOption('#lk-metric', 'open_length');
    await page.selectOption('#lk-row', String(kerbRow));
    await page.click('#lk-save');
    await page.waitForSelector(`${D} #dw-measurements tr[data-row="${kerbRow}"] .m-sel`);
    assert.ok((await page.textContent('#tv-saved')).includes('5.00 m'), 'the server qty is shown: ' + await page.textContent('#tv-saved'));
    assert.strictEqual(await nSel(), 0, 'selection cleared after the save');
    assert.strictEqual(await page.$(D + ' #lk-form'), null, 'link form closed after the save');
    assert.strictEqual((await call('GET', `tenders/${dwg}/rows`, null, admin)).j.find(r => r.id === kerbRow).qty, 5, 'row qty 5 from the selection');
    assert.ok(await page.$(D + ' #tv-canvas'), 'viewer still open');
    // the same line on the same row again: overlap 409 in selection words, with its checkbox; a new selection drops it
    await clickAt(1500, 2000);
    await page.click('#tv-link');
    await page.waitForSelector(D + ' #lk-form #lk-metric');
    await page.selectOption('#lk-metric', 'open_length');
    await page.selectOption('#lk-row', String(kerbRow));
    await page.click('#lk-save');
    await page.waitForSelector(D + ' #lk-confirm-overlap');
    assert.ok((await page.textContent(D + ' #lk-msg')).includes('already measured on this row'), 'selection overlap message: ' + await page.textContent(D + ' #lk-msg'));
    assert.ok((await page.textContent(D + ' #lk-counts')).includes('already on this row: 1'), 'server counts shown');
    assert.strictEqual(await page.$(D + ' #lk-confirm-incomplete'), null, 'only the confirmable refusal gets a box');
    await clickAt(1500, 2000, 'Shift');   // Shift+click toggles it off: the selection changed
    assert.strictEqual(await nSel(), 0, 'shift+click toggles');
    assert.strictEqual(await page.$(D + ' #lk-confirm-overlap'), null, 'a selection change clears the confirmation');
    assert.strictEqual((await page.textContent(D + ' #lk-msg')).trim(), '', 'and the message');
    // metric change clears it too
    await clickAt(1500, 2000);
    await page.click('#lk-save');
    await page.waitForSelector(D + ' #lk-confirm-overlap');
    await page.selectOption('#lk-metric', 'count');
    assert.strictEqual(await page.$(D + ' #lk-confirm-overlap'), null, 'a metric change clears the confirmation');
    assert.strictEqual(await page.isVisible('#lk-width'), false, 'no width for a count');
    // the selection changes while the save is on its way: its 409 belongs to the old selection, so no box, "save again"
    await page.selectOption('#lk-metric', 'open_length');
    await page.route('**/api/drawings/*/measurements', async r => { await new Promise(f => setTimeout(f, 800)); await r.continue(); });
    const posted = page.waitForRequest(r => r.url().includes('/measurements') && r.method() === 'POST');
    await page.click('#lk-save');
    await posted;
    await clickAt(1500, 2000, 'Shift');
    await page.waitForSelector(D + ' #lk-changed');
    assert.strictEqual(await page.$(D + ' #lk-confirm-overlap'), null, 'no confirm box for a reply to an older selection');
    assert.ok((await page.textContent(D + ' #lk-msg')).includes('changed while saving'), 'save-again message');
    await page.unroute('**/api/drawings/*/measurements');
    await clickAt(1500, 2000);
    for (let k = 0; k < 3; k++) { const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes('409 (Conflict)')); assert.ok(i >= 0, 'selection refusal logged'); errors.splice(i, 1); }
    await page.click('#lk-cancel');
    // the KERB layer off: the same spot selects nothing (and a hidden layer leaves the selection)
    await page.uncheck('#tv-layers [data-layer="KERB"] input');
    assert.strictEqual(await nSel(), 0, 'hidden layer leaves the selection');
    await clickAt(1500, 2000);
    assert.strictEqual(await nSel(), 0, 'a hidden layer is not selectable');
    // window around the asphalt square selects it; crossing through its edge too; Clear empties
    await page.click('#tv-all');
    await page.uncheck('#tv-layers [data-layer="CURVE"] input');
    await page.click('#tv-mode-window');
    const band = async (a, b) => { await page.locator('#tv-canvas').scrollIntoViewIfNeeded(); const p0 = await at(...a), p1 = await at(...b); await page.mouse.move(p0[0], p0[1]); await page.mouse.down(); await page.mouse.move((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2); await page.mouse.move(p1[0], p1[1]); await page.mouse.up(); await frame(); };
    await band([-500, -500], [10500, 10500]);
    const winSel = await page.evaluate(() => Array.from(window.__tvViewer.selectedHandles()).sort());
    assert.deepStrictEqual(winSel, ['A1', 'K1', 'M1', 'M2', 'M3'], 'window: entities fully inside');
    assert.strictEqual((await page.textContent('#tv-preview [data-metric="area"] .v')).trim(), '100.00 m2', 'area preview');
    assert.strictEqual((await page.textContent('#tv-preview [data-metric="count"] .v')).trim(), '3 nr', 'count preview');
    await page.click('#tv-mode-crossing');
    await band([9000, 9000], [11000, 11000]);
    assert.deepStrictEqual(await page.evaluate(() => Array.from(window.__tvViewer.selectedHandles())), ['A1'], 'crossing: touching the edge');
    // snapping: a marker at the nearest endpoint
    await page.check('#tv-snap');
    { const [sx, sy] = await at(10000, 10000); await page.mouse.move(sx + 3, sy + 2); await frame(); }
    assert.deepStrictEqual(await page.evaluate(() => window.__tvViewer.snapPoint()), { x: 10000, y: 10000, kind: 'end' }, 'snap marker at the corner');
    await page.click('#tv-clear');
    assert.strictEqual(await nSel(), 0, 'Clear');
    // "Show" on the selection measurement highlights its entities (read only: nothing selected)
    // Open, then Show while the display file is still loading: one load, one engine
    await page.click('#tv-close');
    const created = await page.evaluate(() => window.__tvCreated);
    await page.route('**/api/drawings/*/render', async r => { await new Promise(f => setTimeout(f, 500)); await r.continue(); });
    await page.click(D + ' #tv-open');
    await page.click(`${D} #dw-measurements tr[data-row="${kerbRow}"] .m-show`);
    await page.waitForFunction(() => /entities: 1\b/.test((document.querySelector('#tv-highlight') || {}).textContent || ''));
    await page.unroute('**/api/drawings/*/render');
    assert.strictEqual(await page.evaluate(() => window.__tvCreated), created + 1, 'a second open while loading makes no second engine');
    assert.deepStrictEqual(await page.evaluate(() => Array.from(window.__tvViewer.highlightedHandles())), ['K1'], 'highlighted K1');
    assert.strictEqual(await nSel(), 0, 'a highlight is not a selection');
    // Show turns on a hidden layer of the highlighted entities, and says so
    await page.uncheck('#tv-layers [data-layer="KERB"] input');
    await page.click(`${D} #dw-measurements tr[data-row="${kerbRow}"] .m-show`);
    await page.waitForFunction(() => ((document.querySelector('#tv-highlight') || {}).textContent || '').includes('layers turned on'));
    assert.ok(await page.isChecked('#tv-layers [data-layer="KERB"] input'), 'KERB turned on by Show');
    assert.ok((await page.textContent('#tv-highlight')).includes('KERB'), 'the layer is named');
    // a window released outside the canvas stops at its edge: BOW's square, just off the left edge, is not taken
    await page.click('#tv-fit'); await frame();
    await page.click('#tv-mode-window');
    {
      await page.locator('#tv-canvas').scrollIntoViewIfNeeded();
      const rect = await page.locator('#tv-canvas').boundingBox(), [bx] = await at(22000, 0), cy = rect.y + rect.height / 2;
      await page.mouse.move(rect.x + rect.width / 2, cy); await page.mouse.down({ button: 'middle' });
      await page.mouse.move(rect.x + rect.width / 2 - (bx - rect.x + 30), cy, { steps: 3 }); await page.mouse.up({ button: 'middle' }); await frame();
      const [, y0] = await at(0, -600), [, y1] = await at(0, 2600);
      await page.mouse.move(rect.x + 40, y0); await page.mouse.down();
      await page.mouse.move(rect.x - 60, y1, { steps: 3 }); await page.mouse.move(rect.x - 180, y1); await page.mouse.up(); await frame();
      assert.deepStrictEqual(await page.evaluate(() => window.__tvViewer.selectedHandles()), [], 'nothing off screen selected by a band released outside');
    }
    await page.click('#tv-mode-select');
    if (process.env.VIEWER_SCREENSHOT) { await page.locator('#tv-panel').scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.VIEWER_SCREENSHOT }); }
    // leaving the tab detaches the viewer
    await page.click('#tab-info'); await page.waitForSelector('#tab-body-info');
    assert.strictEqual(await page.evaluate(() => window.__tvViewer), null, 'viewer detached on route change');
    await page.click('#tab-drawings'); await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');

    // ---- final review: block counts by name (items 1), no quantity before units (8), "n of m found" (5), repeated handles (6) ----
    {
      const insD = (hd, layer, name, x, y) => [[0, 'INSERT'], [5, hd], [8, layer], [2, name], [10, x], [20, y]];
      const lineD = (hd, layer, x0, y0, x1, y1) => [[0, 'LINE'], [5, hd], [8, layer], [10, x0], [20, y0], [11, x1], [21, y1]];
      const doors = [];
      for (let i = 0; i < 10; i++) doors.push(...insD('D' + i, 'DR', 'DOOR', i * 1000, 0));
      // no $INSUNITS: the units are chosen by the user. 10 DOOR inserts each holding 2 HINGE inserts; a WINDOW; two lines that
      // share the handle DUP (a malformed file)
      const FIXD = dxf([...dsec('BLOCKS', [[0, 'BLOCK'], [2, 'HINGE'], [70, 0], [10, 0], [20, 0], ...lineD('HL', '0', 500, 0, 600, 0), [0, 'ENDBLK'],
        [0, 'BLOCK'], [2, 'DOOR'], [70, 0], [10, 0], [20, 0], ...lineD('DL', '0', 0, 0, 900, 0), ...insD('H1', '0', 'HINGE', 0, 0), ...insD('H2', '0', 'HINGE', 0, 2000), [0, 'ENDBLK'],
        [0, 'BLOCK'], [2, 'WINDOW'], [70, 0], [10, 0], [20, 0], ...lineD('WL', '0', 0, 0, 1200, 0), [0, 'ENDBLK']]),
      ...dsec('ENTITIES', [...doors, ...insD('W1', 'DR', 'WINDOW', 0, 50000), ...lineD('DUP', 'LN', 100000, 0, 101000, 0), ...lineD('DUP', 'LN', 100000, 10, 101000, 10)])]);
      const doorRow = (await ok(call('POST', `tenders/${dwg}/rows`, { no: '6', description: 'Test doors', unit: 'nr' }, admin), 'door row')).id;
      const dupRow = (await ok(call('POST', `tenders/${dwg}/rows`, { no: '7', description: 'Test lines', unit: 'm' }, admin), 'dup row')).id;
      const up = await fetch(`${base}tenders/${dwg}/drawings?name=doors`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: admin }, body: Buffer.from(FIXD) });
      assert.strictEqual(up.status, 202);
      const did = (await up.json()).id;
      for (const t0 = Date.now(); db.prepare('SELECT status FROM drawings WHERE id=?').get(did).status === 'parsing';) {
        if (Date.now() - t0 > 10000) throw new Error('still parsing'); await new Promise(f => setTimeout(f, 20));
      }
      assert.strictEqual(db.prepare('SELECT status, units FROM drawings WHERE id=?').get(did).units, null);
      await page.goto(`${origin}/#/tender/${dwg}/drawings/${did}`);
      await page.waitForSelector(D + ' #dw-confirm-units');
      const v = sel => page.textContent(`#tv-preview [data-metric="${sel}"] .v`).then(x => x.trim());
      // item 8: units not confirmed: the viewer selects, but shows no number and offers no Link
      await openViewer();
      await page.click('#tv-mode-window');
      await band([-1000, -1000], [10000, 2500]);
      assert.ok(await nSel() > 0, 'selection works before the units are confirmed');
      for (const mt of ['open_length', 'closed_perimeter', 'area', 'count']) assert.strictEqual(await v(mt), '—', 'no preview before units: ' + mt);
      // a manual shape before the units are confirmed: "—" and why
      await page.click('#tl-polyline');
      { const [ax, ay] = await at(0, 0), [bx, by] = await at(5000, 0); await page.mouse.click(ax, ay + 40); await page.mouse.click(bx, by + 40); }
      { const pt = await page.textContent('#tl-preview'); assert.ok(pt.includes('—') && pt.includes('confirm units'), 'DXF before units: ' + pt); }
      await page.keyboard.press('Escape');
      assert.strictEqual((await page.textContent('#tv-blocks')).trim(), '', 'no block counts before units');
      assert.strictEqual(await page.$(D + ' #tv-link'), null, 'no Link before the units are confirmed');
      await page.click('#tv-close');
      await page.selectOption('#dw-unit-select', 'mm');
      await page.click('#dw-confirm-units');
      await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
      // item 1: a window over the doors: 10 DOOR counted; the 20 nested HINGE shown apart, not counted
      await openViewer();
      await page.click('#tv-mode-window');
      await band([-500, -500], [10000, 2500]);
      assert.strictEqual(await v('count'), '10 nr', 'count preview: top-level inserts only');
      assert.strictEqual((await page.textContent('#tv-blocks')).trim(), 'Blocks: DOOR 10 · HINGE 20 nested (not counted)');
      assert.ok((await page.textContent('#tv-sel-blocks')).includes('DOOR 10 · HINGE 20 nested (not counted)'), 'status bar breakdown');
      await page.click('#tv-link');
      await page.waitForSelector(D + ' #lk-form #lk-metric');
      assert.strictEqual(await page.isVisible('#lk-nested'), false, 'nested only for a count');
      await page.selectOption('#lk-metric', 'count');
      await page.selectOption('#lk-row', String(doorRow));
      await page.check('#lk-nested');
      assert.strictEqual(await v('count'), '30 nr', 'with nested: the preview counts the hinges too');
      assert.strictEqual((await page.textContent('#tv-blocks')).trim(), 'Blocks: DOOR 10 · HINGE 20 nested');
      await page.click('#lk-save');
      await page.waitForSelector(D + ' #lk-confirm-mixed-blocks');
      assert.ok((await page.textContent(D + ' #lk-msg')).includes('more than one block'), 'mixed blocks in words: ' + await page.textContent(D + ' #lk-msg'));
      assert.strictEqual((await page.textContent(D + ' #lk-blocks')).trim(), 'DOOR 10 · HINGE 20');
      await page.uncheck('#lk-nested');
      assert.strictEqual(await page.$(D + ' #lk-confirm-mixed-blocks'), null, 'changing nested drops the confirmation');
      assert.strictEqual(await v('count'), '10 nr');
      await page.check('#lk-nested');
      await page.click('#lk-save');
      await page.waitForSelector(D + ' #lk-confirm-mixed-blocks');
      await page.check('#lk-confirm-mixed-blocks');
      await page.click('#lk-save');
      await page.waitForSelector(`${D} #dw-measurements tr[data-row="${doorRow}"] .m-sel`);
      assert.ok((await page.textContent('#tv-saved')).includes('30.00 nr'), 'saved 30: ' + await page.textContent('#tv-saved'));
      assert.strictEqual((await page.textContent(`${D} #dw-measurements tr[data-row="${doorRow}"] .m-blocks`)).trim(), 'DOOR 10 · HINGE 20 nested', 'stored breakdown listed');
      assert.ok((await page.textContent(`${D} #dw-measurements tr[data-row="${doorRow}"]`)).includes('several blocks'), 'mixed flag listed');
      assert.strictEqual(await v('count'), '—', 'nested box gone with the form; selection cleared');
      for (let k = 0; k < 2; k++) { const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes('409 (Conflict)')); assert.ok(i >= 0, 'mixed refusal logged'); errors.splice(i, 1); }
      // batch-2 carry-over: only nested inserts selected (the HINGE row of the doors) with nested off: the refusal says to tick the box
      await band([-500, 1500], [10000, 2500]);
      assert.ok(await nSel() > 0, 'hinges selected');
      assert.strictEqual(await v('count'), '—', 'nothing at the top level');
      await page.click('#tv-link');
      await page.waitForSelector(D + ' #lk-form #lk-metric');
      await page.selectOption('#lk-metric', 'count');
      await page.selectOption('#lk-row', String(doorRow));
      await page.click('#lk-save');
      await page.waitForSelector(D + ' #lk-hint-nested');
      assert.ok((await page.textContent(D + ' #lk-msg')).includes('nothing in the selection can be measured as count'), 'refusal: ' + await page.textContent(D + ' #lk-msg'));
      assert.ok((await page.textContent(D + ' #lk-hint-nested')).includes('Include nested inserts'), 'hint names the box');
      { const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes('400 (Bad Request)')); assert.ok(i >= 0, 'nested-only refusal logged'); errors.splice(i, 1); }
      await page.check('#lk-nested');
      assert.strictEqual(await page.$(D + ' #lk-hint-nested'), null, 'ticking the box clears the hint');
      await page.click('#lk-cancel');
      // item 6: two lines with one handle: the selection sends it once and the server counts both (as the preview)
      await band([99000, -500], [102000, 500]);
      assert.strictEqual(await nSel(), 2);
      assert.deepStrictEqual(await page.evaluate(() => window.__tvViewer.selectedHandles()), ['DUP'], 'repeated handle sent once');
      assert.strictEqual(await v('open_length'), '2.00 m');
      await page.click('#tv-link');
      await page.waitForSelector(D + ' #lk-form #lk-metric');
      await page.selectOption('#lk-metric', 'open_length');
      await page.selectOption('#lk-row', String(dupRow));
      await page.click('#lk-save');
      await page.waitForSelector(`${D} #dw-measurements tr[data-row="${dupRow}"] .m-sel`);
      assert.ok((await page.textContent('#tv-saved')).includes('2.00 m'), 'saved 2 m: ' + await page.textContent('#tv-saved'));
      // item 5: Show finds all of a selection's entities, or says how many of them it found
      await page.click(`${D} #dw-measurements tr[data-row="${dupRow}"] .m-show`);
      await page.waitForFunction(() => /entities: 2\b/.test((document.querySelector('#tv-highlight') || {}).textContent || ''));
      const mid = Number(await page.getAttribute(`${D} #dw-measurements tr[data-row="${doorRow}"]`, 'data-measurement'));
      db.prepare("INSERT INTO measurement_handles(measurement_id, handle, geom_key) VALUES(?, 'GONE', NULL)").run(mid);
      db.prepare('UPDATE measurements SET handles_count=handles_count+1 WHERE id=?').run(mid);
      await page.reload();
      await page.waitForSelector(`${D} #dw-measurements tr[data-row="${doorRow}"] .m-show`);
      await page.click(`${D} #dw-measurements tr[data-row="${doorRow}"] .m-show`);
      await page.waitForFunction(() => ((document.querySelector('#tv-highlight') || {}).textContent || '').includes('found'));
      assert.ok((await page.textContent('#tv-highlight')).includes('30 of 31 entities found'), 'partial Show: ' + await page.textContent('#tv-highlight'));
      await page.click('#tv-close');
      // leave the tender as the checks below expect it (the site plan is the drawing shown)
      for (const r of [doorRow, dupRow]) await ok(call('DELETE', 'measurements/' + db.prepare('SELECT id FROM measurements WHERE row_id=?').get(r).id, null, admin), 'tidy');
      db.prepare('DELETE FROM drawings WHERE id=?').run(did);
      await page.goto(`${origin}/#/tender/${dwg}/drawings`); await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
    }

    // ---- PDF and image viewer (batch 3 Task 5): pages read by the browser, rendered by the vendored pdf.js ----------
    {
      const { makePdf, PDF_RECTS, makePng, makeOffsetPdf, OFFSET_RECT } = require('./test/fixtures/make-takeoff.js');
      for (const f of ['/viewer/raster.js']) assert.ok(html.includes('src="' + f + '"'), 'index.html loads ' + f);
      const pt = (await ok(call('POST', 'tenders', { ...info, title: 'Test UI PDF' }, admin), 'pdf tender')).id;
      const DP = `#drawings[data-tender="${pt}"]`;
      await page.goto(`${origin}/#/tender/${pt}/drawings`);
      await page.waitForSelector(DP + ' #dw-upload');
      await page.setInputFiles('#dw-file', { name: 'sheets.pdf', mimeType: 'application/pdf', buffer: makePdf() });
      await page.click('#dw-upload');
      // the upload is one row in 'pages'; this browser reads the 2 pages with pdf.js and registers them: 2 ready rows
      await page.waitForSelector(DP + ' #tv-panel[data-kind="pdf"]');
      const pages = db.prepare('SELECT id, kind, status, page, page_w, page_h, rotation, parent_id FROM drawings WHERE tender_id=? ORDER BY page').all(pt).map(r => ({ ...r }));
      assert.deepStrictEqual(pages.map(r => [r.kind, r.status, r.page, r.page_w, r.page_h, r.rotation]), [['pdf', 'ready', 1, 595, 842, 0], ['pdf', 'ready', 2, 842, 595, 90]],
        'pages registered by the browser with their unrotated size and rotation');
      assert.strictEqual(pages[1].parent_id, pages[0].id);
      assert.strictEqual(await page.$$eval(DP + ' a[href*="/drawings/"]', a => a.length), 2, 'two rows listed');
      const idle = () => page.evaluate(() => window.__tvViewer.whenIdle());
      // [r, g, b, a] of the canvas pixel under a page point
      const pixel = (x, y) => page.evaluate(([x, y]) => {
        const e = window.__tvViewer, s = e.toScreen(x, y), d = window.devicePixelRatio || 1;
        return Array.from(e.canvas.getContext('2d').getImageData(Math.floor(s[0] * d), Math.floor(s[1] * d), 1, 1).data);
      }, [x, y]);
      const near = (got, want, msg) => assert.ok(want.every((v, k) => Math.abs(got[k] - v) <= 3), msg + ': ' + JSON.stringify(got) + ' ≈ ' + JSON.stringify(want));
      const rgb = r => r.rgb.map(v => Math.round(v * 255));
      // page 2 (/Rotate 90): portrait on screen, its filled rectangle where the page coordinates say
      await page.goto(`${origin}/#/tender/${pt}/drawings/${pages[1].id}`);
      await page.waitForSelector(`${DP} #tv-panel[data-drawing="${pages[1].id}"] #tv-open`);
      assert.ok((await page.textContent('#tv-page-info')).includes('rotation 90°'), 'page info: ' + await page.textContent('#tv-page-info'));
      await page.click(DP + ' #tv-open');
      await page.waitForSelector(DP + ' #tv-canvas[data-ready="1"]');
      await page.locator('#tv-canvas').scrollIntoViewIfNeeded();
      await idle();
      const R2 = PDF_RECTS[1];
      assert.deepStrictEqual(await page.evaluate(() => window.__tvViewer.size()), [595, 842], 'rotated 90: shown portrait');
      near(await pixel(R2.x + R2.w / 2, R2.y + R2.h / 2), [...rgb(R2), 255], 'rotated page: the rectangle is rendered under its page point');
      near(await pixel(R2.x - 40, R2.y + R2.h / 2), [255, 255, 255, 255], 'rotated page: white beside it');
      // wheel zoom at the cursor keeps the page point under it; the visible part is rendered again, sharp at the new zoom
      {
        // the mouse at whole client pixels (as the browser reports it) near the rectangle's left edge
        const [mx, my, cx, cy] = await page.evaluate(([x, y]) => {
          const e = window.__tvViewer, s = e.toScreen(x, y), r = e.canvas.getBoundingClientRect(), mx = Math.round(r.left + s[0]), my = Math.round(r.top + s[1]);
          return [mx, my, mx - r.left, my - r.top];
        }, [R2.x, R2.y + R2.h / 2]);
        await page.mouse.move(mx, my);
        const before = await page.evaluate(([x, y]) => window.__tvViewer.toPage(x, y), [cx, cy]);
        const s0 = await page.evaluate(() => window.__tvViewer.view().scale);
        for (let k = 0; k < 4; k++) await page.mouse.wheel(0, -500);
        await page.waitForFunction(s => window.__tvViewer.view().scale > s * 10, s0);
        const after = await page.evaluate(([x, y]) => window.__tvViewer.toPage(x, y), [cx, cy]);
        assert.ok(Math.abs(after[0] - before[0]) < 1e-6 && Math.abs(after[1] - before[1]) < 1e-6, 'zoom keeps the point under the cursor: ' + before + ' / ' + after);
        await idle();
        const step = 2 / await page.evaluate(() => window.__tvViewer.view().scale);   // 2 screen px in page units
        near(await pixel(R2.x + step, R2.y + R2.h / 2), [...rgb(R2), 255], 'zoomed: just inside the edge is the fill (re-rendered, not a blurred bitmap)');
        near(await pixel(R2.x - step, R2.y + R2.h / 2), [255, 255, 255, 255], 'zoomed: just outside the edge is white');
      }
      // every rotation: toPage/toScreen are exact inverses, a page length is the same on screen, the fill is under its point
      const rots = await page.evaluate(async ([id, R]) => {
        const out = [];
        for (const rotation of [0, 90, 180, 270]) {
          const div = document.createElement('div');
          div.style.cssText = 'width:400px;height:300px';
          document.body.append(div);
          const e = TVRaster.create(div, { kind: 'pdf', url: `/api/drawings/${id}/file`, page: 2, pageW: 842, pageH: 595, rotation });
          e.canvas.style.cssText = 'display:block;width:100%;height:100%';
          await e.ready;
          const a = [R.x, R.y], b = [R.x + R.w, R.y + R.h], sa = e.toScreen(...a), sb = e.toScreen(...b), back = e.toPage(...e.toScreen(123.25, 456.5));
          const c = e.toScreen(R.x + R.w / 2, R.y + R.h / 2), d = window.devicePixelRatio || 1;
          out.push({ rotation, size: e.size(), len: Math.hypot(sb[0] - sa[0], sb[1] - sa[1]) / e.view().scale, back,
            fill: Array.from(e.canvas.getContext('2d').getImageData(Math.floor(c[0] * d), Math.floor(c[1] * d), 1, 1).data) });
          e.destroy(); div.remove();
        }
        return out;
      }, [pages[1].id, R2]);
      for (const r of rots) {
        assert.ok(Math.abs(r.back[0] - 123.25) < 1e-9 && Math.abs(r.back[1] - 456.5) < 1e-9, 'round trip at rotation ' + r.rotation + ': ' + r.back);
        assert.ok(Math.abs(r.len - Math.hypot(R2.w, R2.h)) < 1e-9, 'a page length does not depend on rotation ' + r.rotation + ': ' + r.len);
        assert.deepStrictEqual(r.size, r.rotation % 180 ? [595, 842] : [842, 595], 'shown size at rotation ' + r.rotation);
        near(r.fill, [...rgb(R2), 255], 'fill under its page point at rotation ' + r.rotation);
      }
      await page.click('#tv-fit');
      // page 1 (no rotation)
      await page.goto(`${origin}/#/tender/${pt}/drawings/${pages[0].id}`);
      await page.waitForSelector(`${DP} #tv-panel[data-drawing="${pages[0].id}"] #tv-open`);
      assert.strictEqual(await page.evaluate(() => window.__tvViewer), null, 'the viewer is detached on route change');
      await page.click(DP + ' #tv-open');
      await page.waitForSelector(DP + ' #tv-canvas[data-ready="1"]');
      await page.locator('#tv-canvas').scrollIntoViewIfNeeded();
      await idle();
      const R1 = PDF_RECTS[0];
      near(await pixel(R1.x + R1.w / 2, R1.y + R1.h / 2), [...rgb(R1), 255], 'page 1: the rectangle under its page point');
      near(await pixel(R1.x + R1.w / 2, R1.y + R1.h + 20), [255, 255, 255, 255], 'page 1: white above it (y up)');
      // a PNG: uploaded through the UI, ready at once; pixels y down from the top-left, drawn as stored
      await page.setInputFiles('#dw-file', { name: 'photo.png', mimeType: 'image/png', buffer: makePng(64, 48, [40, 120, 200]) });
      await page.click('#dw-upload');
      await page.waitForSelector(DP + ' #tv-panel[data-kind="image"]');
      assert.ok((await page.textContent('#tv-page-info')).includes('64 × 48 px'), 'image size shown');
      assert.ok(db.prepare("SELECT 1 FROM drawings WHERE tender_id=? AND kind='image' AND name='photo'").get(pt), 'the default title drops .png');
      await page.click(DP + ' #tv-open');
      await page.waitForSelector(DP + ' #tv-canvas[data-ready="1"]');
      await page.locator('#tv-canvas').scrollIntoViewIfNeeded();
      await idle();
      near(await pixel(32, 24), [40, 120, 200, 255], 'image pixel drawn');
      near(await pixel(-1, -1), [30, 30, 30, 255], 'outside the image: the background');
      assert.ok(await page.evaluate(() => { const e = window.__tvViewer; return e.toScreen(0, 0)[1] < e.toScreen(0, 48)[1]; }), 'image y down');
      const back = await page.evaluate(() => { const e = window.__tvViewer; return e.toPage(...e.toScreen(12.5, 33.25)); });
      assert.ok(Math.abs(back[0] - 12.5) < 1e-9 && Math.abs(back[1] - 33.25) < 1e-9, 'image round trip');
      await page.click('#tv-close');
      assert.strictEqual(await page.evaluate(() => window.__tvViewer), null, 'closed');

      // ---- fix round 1 ----
      // R16: a page box that does not start at 0 (MediaBox [1000 2000 1595 2842], /Rotate 270): its origin is registered,
      // points stay absolute
      await page.setInputFiles('#dw-file', { name: 'offset.pdf', mimeType: 'application/pdf', buffer: makeOffsetPdf() });
      await page.click('#dw-upload');
      await page.waitForFunction(() => /offset/.test((document.querySelector('#tv-panel[data-kind="pdf"] h2') || {}).textContent || ''));
      const po = db.prepare("SELECT page_w, page_h, rotation, page_x0, page_y0, name FROM drawings WHERE tender_id=? AND name='offset'").get(pt);
      assert.deepStrictEqual({ ...po }, { page_w: 595, page_h: 842, rotation: 270, page_x0: 1000, page_y0: 2000, name: 'offset' }, 'origin registered; .pdf dropped from the title');
      await page.click(DP + ' #tv-open');
      await page.waitForSelector(DP + ' #tv-canvas[data-ready="1"]');
      await page.locator('#tv-canvas').scrollIntoViewIfNeeded();
      await idle();
      assert.deepStrictEqual(await page.evaluate(() => window.__tvViewer.size()), [842, 595], 'rotated 270: landscape');
      const ob = await page.evaluate(() => { const e = window.__tvViewer; return e.toPage(...e.toScreen(1123.25, 2456.5)); });
      assert.ok(Math.abs(ob[0] - 1123.25) < 1e-9 && Math.abs(ob[1] - 2456.5) < 1e-9, 'offset page round trip: ' + ob);
      near(await pixel(OFFSET_RECT.x + OFFSET_RECT.w / 2, OFFSET_RECT.y + OFFSET_RECT.h / 2), [...rgb(OFFSET_RECT), 255], 'offset page: the fill under its absolute point');
      near(await pixel(OFFSET_RECT.x - 30, OFFSET_RECT.y + OFFSET_RECT.h / 2), [255, 255, 255, 255], 'offset page: white beside it');
      await page.click('#tv-close');

      // R17: a JPEG the browser shows turned (EXIF orientation 6 on 40 × 20) is refused in words; orientation 3 (same size) opens
      const exifJpeg = orientation => page.evaluate(o => {
        const c = document.createElement('canvas'); c.width = 40; c.height = 20;
        const g = c.getContext('2d'); g.fillStyle = '#c00'; g.fillRect(0, 0, 20, 20); g.fillStyle = '#00c'; g.fillRect(20, 0, 20, 20);
        const b = Uint8Array.from(atob(c.toDataURL('image/jpeg', 0.95).split(',')[1]), ch => ch.charCodeAt(0));
        // APP1 "Exif": big-endian TIFF, one IFD entry: Orientation (0x0112), SHORT, 1, o
        const app1 = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
        const out = new Uint8Array(b.length + app1.length);
        out.set(b.subarray(0, 2)); out.set(app1, 2); out.set(b.subarray(2), 2 + app1.length);
        let s = ''; for (const x of out) s += String.fromCharCode(x);
        return btoa(s);
      }, orientation).then(x => Buffer.from(x, 'base64'));
      await page.setInputFiles('#dw-file', { name: 'turned.jpg', mimeType: 'image/jpeg', buffer: await exifJpeg(6) });
      await page.click('#dw-upload');
      await page.waitForFunction(() => /turned/.test((document.querySelector('#tv-panel[data-kind="image"] h2') || {}).textContent || ''));
      assert.ok((await page.textContent('#tv-page-info')).includes('40 × 20 px'), 'stored size from the file header');
      await page.click(DP + ' #tv-open');
      await page.waitForSelector(DP + ' #tv-error');
      const frameMsg = await page.textContent(DP + ' #tv-error');
      assert.ok(frameMsg.includes('20 × 40 px') && frameMsg.includes('Save the image upright') && !frameMsg.includes('≠'), 'translated refusal: ' + frameMsg);
      assert.ok(await page.isEnabled(DP + ' #tv-open'), 'Open can be tried again');
      await page.setInputFiles('#dw-file', { name: 'flipped.jpg', mimeType: 'image/jpeg', buffer: await exifJpeg(3) });
      await page.click('#dw-upload');
      await page.waitForFunction(() => /flipped/.test((document.querySelector('#tv-panel[data-kind="image"] h2') || {}).textContent || ''));
      await page.click(DP + ' #tv-open');
      await page.waitForSelector(DP + ' #tv-canvas[data-ready="1"]');
      await page.click('#tv-close');

      // an image over 50 MB is refused before the upload, naming the image limit
      const bigPng = path.join(process.env.DATA_DIR, 'big.png');   // a sparse file in the temp DATA_DIR (removed at exit)
      fs.writeFileSync(bigPng, ''); fs.truncateSync(bigPng, 50 * 1024 * 1024 + 1);
      await page.setInputFiles('#dw-file', bigPng);
      await page.click('#dw-upload');
      assert.ok((await page.textContent('#dw-progress')).includes('50 MB'), 'image limit named: ' + await page.textContent('#dw-progress'));
      await page.setInputFiles('#dw-file', []);

      // reading pages: a refusal that is not "already registered" is shown; a PDF pdf.js cannot read is shown once and
      // not downloaded again on every redraw (until a reload)
      {
        const upPdf = async (name, body) => {
          const r = await fetch(`${base}tenders/${pt}/drawings?name=${name}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: admin }, body });
          assert.strictEqual(r.status, 202); return (await r.json()).id;
        };
        const refused = await upPdf('refused', makePdf());
        await page.route('**/api/drawings/*/pages', r => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'test refusal' }) }));
        await page.goto(`${origin}/#/tender/${pt}/drawings/${refused}`);
        await page.waitForSelector(DP + ' #dw-pages-error');
        assert.ok((await page.textContent(DP + ' #dw-pages-error')).includes('test refusal'), 'a 409 that is not "already registered" is shown');
        assert.ok((await page.textContent(DP + ' #dw-pages-error')).includes('Reload the page to try again'), 'reload hint (Task 5 carry-over)');
        assert.strictEqual(await page.$(DP + ' #dw-pages-wait'), null, 'no "reading pages…" once it failed');
        await page.unroute('**/api/drawings/*/pages');
        { const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes('409 (Conflict)')); assert.ok(i >= 0, 'refusal logged'); errors.splice(i, 1); }
        await page.reload();
        await page.waitForSelector(`${DP} #tv-panel[data-drawing="${refused}"]`);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE id=? OR parent_id=?').get(refused, refused).n, 2, 'after a reload the pages are read again');
        const broken = await upPdf('broken', Buffer.from('%PDF-1.4\nnot really a pdf\n', 'latin1'));
        let reads = 0;
        const onReq = q => { if (q.url().endsWith(`/api/drawings/${broken}/file`)) reads++; };
        page.on('request', onReq);
        await page.goto(`${origin}/#/tender/${pt}/drawings/${broken}`);
        await page.waitForSelector(DP + ' #dw-pages-error');
        assert.match(await page.textContent(DP + ' #dw-pages-error'), /could not be read/, 'translated failure');
        await page.click('#tab-info'); await page.waitForSelector('#tab-body-info');
        await page.goto(`${origin}/#/tender/${pt}/drawings/${broken}`); await page.waitForSelector(DP + ' #dw-pages-error');
        assert.match(await page.textContent(DP + ' #dw-pages-error'), /Invalid PDF structure/, 'the remembered reason');
        assert.strictEqual(await page.$(DP + ' #dw-pages-wait'), null, 'still no "reading pages…"');
        page.off('request', onReq);
        assert.strictEqual(reads, 1, 'the PDF is not downloaded again on a redraw');
        db.prepare('DELETE FROM drawings WHERE id=?').run(broken);
      }
      await page.goto(`${origin}/#/tender/${dwg}/drawings`); await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
    }

    // ---- manual measuring and calibration tools (batch 3 Task 6) ----------------------------------------------------
    {
      const { makePdf } = require('./test/fixtures/make-takeoff.js');
      for (const f of ['/viewer/tools.js', '/lib/takeoff/manual.js']) assert.ok(html.includes('src="' + f + '"'), 'index.html loads ' + f);
      const mt = (await ok(call('POST', 'tenders', { ...info, title: 'Test UI Measure' }, admin), 'measure tender')).id;
      const rowM = (await ok(call('POST', `tenders/${mt}/rows`, { no: '1', description: 'Test kerb line', unit: 'm' }, admin), 'm row')).id;
      const rowA = (await ok(call('POST', `tenders/${mt}/rows`, { no: '2', description: 'Test paving', unit: 'm2' }, admin), 'm2 row')).id;
      const up = await fetch(`${base}tenders/${mt}/drawings?name=sheet`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: admin }, body: makePdf() });
      assert.strictEqual(up.status, 202);
      const pdfId = (await up.json()).id;
      await ok(call('POST', `drawings/${pdfId}/pages`, { pages: [{ page: 1, width: 595, height: 842, rotation: 0 }, { page: 2, width: 842, height: 595, rotation: 90 }] }, admin), 'pages');
      const DM = `#drawings[data-tender="${mt}"]`;
      const rowQty = async r => (await call('GET', `tenders/${mt}/rows`, null, admin)).j.find(x => x.id === r).qty;
      const listed = async () => (await call('GET', `tenders/${mt}/measurements`, null, admin)).j.measurements;
      const idleM = () => page.evaluate(() => window.__tvViewer.whenIdle());
      // whole client pixels of a page point (as the browser reports a click)
      const scr = (x, y) => page.evaluate(([x, y]) => { const e = window.__tvViewer; e.canvas.scrollIntoView({ block: 'nearest' }); const s = e.toScreen(x, y), r = e.canvas.getBoundingClientRect(); return [Math.round(r.left + s[0]), Math.round(r.top + s[1])]; }, [x, y]);
      const clickPage = async (x, y, mods) => { const [sx, sy] = await scr(x, y); if (mods) await page.keyboard.down(mods); await page.mouse.click(sx, sy); if (mods) await page.keyboard.up(mods); };
      // an exact page point through the tools' own click handler (a mouse click lands on whole pixels)
      const pick = (x, y) => page.evaluate(([x, y]) => window.__tvTools.pick([x, y]), [x, y]);
      const pv = async () => { const v = await page.getAttribute('#tl-preview .v', 'data-qty'); return v === null ? null : Number(v); };
      const expectQty = () => page.evaluate(() => TakeoffManual.manualQty(window.__tvTools.geom(), { scale: 0.05 }).qty);
      const openM = async () => {
        await page.click(DM + ' #tv-open');
        await page.waitForSelector(DM + ' #tv-canvas[data-ready="1"]');
        await page.locator('#tv-canvas').scrollIntoViewIfNeeded();
        await idleM();
      };
      await page.goto(`${origin}/#/tender/${mt}/drawings/${pdfId}`);
      await page.waitForSelector(`${DM} #tv-panel[data-drawing="${pdfId}"] #tv-open`);
      await openM();
      for (const b of ['line', 'polyline', 'area', 'rect', 'count', 'calibrate', 'verify', 'region', 'undo', 'finish', 'cancel']) assert.ok(await page.$('#tl-' + b), 'tool button ' + b);
      assert.ok((await page.textContent('#tl-scale')).includes('not calibrated'), 'scale line: ' + await page.textContent('#tl-scale'));
      // 1.1 before calibrating: "—" and why; the left drag does not pan while a tool is active (carry-over)
      await page.click('#tl-polyline');
      assert.strictEqual(await page.isVisible('#tl-hole'), false, 'Hole only while an area is open');
      const v0 = await page.evaluate(() => ({ ...window.__tvViewer.view() }));
      { const [sx, sy] = await scr(300, 300); await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 60, sy + 40, { steps: 4 }); await page.mouse.up(); }
      assert.deepStrictEqual(await page.evaluate(() => ({ ...window.__tvViewer.view() })), v0, 'no left-drag pan while a tool is active');
      await clickPage(100, 600); await clickPage(300, 600);
      let pt = await page.textContent('#tl-preview');
      assert.ok(pt.includes('—') && pt.includes('calibrate first') && /preview/i.test(pt), 'no number before calibrating: ' + pt);
      assert.strictEqual(await pv(), null);
      // 4. Esc cancels (the shape and the tool)
      await page.keyboard.press('Escape');
      assert.deepStrictEqual(await page.evaluate(() => [window.__tvTools.tool(), window.__tvTools.pointCount()]), [null, 0], 'Esc cancels');
      // a count needs no calibration (R14)
      await page.click('#tl-count'); await clickPage(400, 400); await clickPage(450, 400);
      assert.ok((await page.textContent('#tl-preview .v')).includes('2 nr'), 'count without calibration: ' + await page.textContent('#tl-preview'));
      await page.click('#tl-cancel');
      // 1.2 calibrate: two points 100 page units apart = 5 m
      await page.click('#tl-calibrate');
      await pick(100, 700); await pick(200, 700);
      await page.waitForSelector(DM + ' #cal-form');
      await page.fill('#cal-real', '5'); await page.selectOption('#cal-unit', 'm');
      await page.click('#cal-save');
      await page.waitForFunction(() => /1 pt = 0\.05 m/.test(document.querySelector('#tl-scale').textContent));
      assert.strictEqual(db.prepare('SELECT scale FROM calibrations WHERE drawing_id=? AND region IS NULL').get(pdfId).scale, 0.05);
      // 1.3 a polyline of 3 points clicked by the mouse: the preview is manualQty on those points (the server's formula)
      await page.click('#tl-polyline');
      await clickPage(100, 600); await clickPage(300, 600); await clickPage(300, 450);
      const got = await page.evaluate(() => window.__tvTools.points());
      [[100, 600], [300, 600], [300, 450]].forEach((p, k) => assert.ok(Math.hypot(got[k][0] - p[0], got[k][1] - p[1]) < 2, 'clicked point ' + k + ': ' + got[k]));
      const want = await expectQty();
      assert.strictEqual(await pv(), want, 'preview = manualQty');
      assert.ok(Math.abs(want - 17.5) < 0.2 && (await page.textContent('#tl-preview')).includes(f2(want) + ' m'), 'preview shown: ' + await page.textContent('#tl-preview'));
      // 3. Undo point: the last point goes and the preview follows
      await page.click('#tl-undo');
      assert.strictEqual((await page.evaluate(() => window.__tvTools.points())).length, 2);
      assert.strictEqual(await pv(), await expectQty(), 'preview after undo');
      await clickPage(300, 450);
      const want3 = await expectQty(), sent = await page.evaluate(() => window.__tvTools.points());
      // 1.4 Enter finishes; link to the m row → the row qty is the server's qty, equal to the preview
      await page.keyboard.press('Enter');
      await page.waitForSelector(DM + ' #lk-form');
      assert.ok(!(await page.$(DM + ' #lk-metric')), 'no metric choice for a length');
      await page.selectOption('#lk-row', String(rowM));
      await page.click('#lk-save');
      await page.waitForSelector(`${DM} #dw-measurements tr[data-row="${rowM}"]`);
      let ms = await listed();
      const mPoly = ms.find(m => m.row_id === rowM);
      assert.strictEqual(mPoly.qty, want3, 'server qty = preview'); assert.strictEqual(await rowQty(rowM), mPoly.qty, 'row qty = server qty');
      assert.deepStrictEqual(mPoly.geom, { tool: 'polyline', pts: sent }, 'the points drawn are the points saved');
      // 1.5 the list: formula with its inputs, and which calibration
      const fm = (await page.textContent(`${DM} #dw-measurements tr[data-row="${rowM}"] td.m-formula`)).trim();
      assert.ok(fm.startsWith(`length ${f2(mPoly.base / 0.05)} pt × 0.05 m/pt = ${f2(mPoly.base)} m`), 'formula: ' + fm);
      assert.ok(fm.includes('page calibration') && fm.includes('not verified'), 'calibration used: ' + fm);
      assert.deepStrictEqual(await page.evaluate(() => [window.__tvTools.tool(), window.__tvTools.pointCount()]), ['polyline', 0], 'saved: the tool stays, the shape goes');
      // R15: a polyline that doubles back is allowed, with a warning; Shift keeps the next point horizontal
      await clickPage(100, 500); await clickPage(250, 500, 'Shift'); await clickPage(200, 500, 'Shift');
      const sp = await page.evaluate(() => window.__tvTools.points());
      assert.ok(sp[1][1] === sp[0][1] && sp[2][1] === sp[0][1], 'Shift: horizontal, exactly: ' + JSON.stringify(sp));
      assert.ok((await page.textContent('#tl-warn')).includes('doubles back'), 'doubling back warned: ' + await page.textContent('#tl-warn'));
      assert.ok(await pv() > 0, 'still measured');
      await page.click('#tl-cancel');
      // 2. an area with a hole → the m2 row: 24
      await page.click('#tl-area');
      for (const [x, y] of [[100, 100], [200, 100], [200, 220], [100, 220]]) await pick(x, y);
      assert.ok(await page.isVisible('#tl-hole'), 'Hole shown for an area');
      await page.click('#tl-hole');
      for (const [x, y] of [[120, 120], [160, 120], [160, 180], [120, 180]]) await pick(x, y);
      assert.ok(Math.abs(await pv() - 24) < 1e-9, 'area preview 24: ' + await pv());
      await page.click('#tl-finish');
      await page.waitForSelector(DM + ' #lk-form #lk-metric');
      await page.selectOption('#lk-row', String(rowA));
      await page.click('#lk-save');
      await page.waitForSelector(`${DM} #dw-measurements tr[data-row="${rowA}"]`);
      assert.ok(Math.abs(await rowQty(rowA) - 24) < 1e-9, 'm2 row 24');
      // a self-intersecting outline: refused in words before it is sent
      await page.click('#tl-area');
      for (const [x, y] of [[400, 100], [500, 200], [500, 100], [400, 200]]) await pick(x, y);
      assert.ok((await page.textContent('#tl-warn')).includes('crosses'), 'bowtie: ' + await page.textContent('#tl-warn'));
      await page.click('#tl-finish');
      assert.ok(!(await page.$(DM + ' #lk-form')), 'no link form for a shape the server refuses');
      await page.click('#tl-cancel');
      // edit a saved measurement: factor 2 and a label → the row doubles
      await page.click(`${DM} #dw-measurements tr[data-row="${rowM}"] .m-edit`);
      await page.waitForSelector(DM + ' #ed-form');
      await page.fill('#ed-factor', '2'); await page.fill('#ed-label', 'Fake kerb');
      await page.click('#ed-save');
      await page.waitForFunction(r => /factor 2/.test((document.querySelector(`#dw-measurements tr[data-row="${r}"] td.m-formula`) || {}).textContent || ''), rowM);
      assert.strictEqual(await rowQty(rowM), mPoly.qty * 2, 'edited factor');
      assert.ok(await page.$(DM + ' #tv-canvas'), 'the viewer stays open after an edit');
      // the saved measurements are drawn with their label and qty
      await page.evaluate(() => window.__tvViewer.requestDraw()); await idleM();
      const ovl = await page.evaluate(() => window.__tvTools.overlay());
      assert.strictEqual(ovl.length, 2, 'two overlays'); assert.ok(ovl.some(x => x.text.startsWith('Fake kerb · ' + f2(mPoly.qty * 2))), JSON.stringify(ovl));
      // 5. verify off by 2 %: a 200 pt line (10 m at this scale) said to be 9.8 m → +2.04 %, in the warning colour
      await page.click('#tl-verify');
      await pick(100, 650); await pick(300, 650);
      await page.waitForSelector(DM + ' #cal-form');
      await page.fill('#cal-real', '9.8');
      await page.click('#cal-save');
      await page.waitForSelector(DM + ' #vf-result');
      assert.ok((await page.textContent('#vf-result')).includes('+2.04 %'), 'verify %: ' + await page.textContent('#vf-result'));
      assert.ok(await page.$('#vf-result .pct-warn'), 'above 1 %: warning colour');
      assert.notStrictEqual(await page.$eval('#vf-result .pct-warn', e => getComputedStyle(e).color), await page.$eval('#tl-scale', e => getComputedStyle(e).color), 'a colour of its own');
      assert.ok((await page.textContent('#tl-scale')).replace(/[\u2066-\u2069]/g, '').includes('verified +2.04 %'), 'the scale line shows it');
      // a region: dragged, then calibrated inside it; a verify line inside it verifies the region, one across it is refused
      await page.click('#tl-region');
      { const [ax, ay] = await scr(400, 300), [bx, by] = await scr(560, 500); await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps: 5 }); await page.mouse.up(); }
      await page.waitForFunction(() => window.__tvTools.tool() === 'calibrate');
      assert.ok((await page.textContent('#tl-msg')).includes('inside it'), 'region: calibrate inside it');
      await pick(420, 400); await pick(520, 400);
      await page.waitForSelector(DM + ' #cal-form');
      await page.fill('#cal-real', '2'); await page.click('#cal-save');
      await page.waitForFunction(() => /Region 1: 1 pt = 0\.02 m/.test(document.querySelector('#tl-scale').textContent));
      const regCal = db.prepare('SELECT * FROM calibrations WHERE drawing_id=? AND region IS NOT NULL').get(pdfId);
      assert.strictEqual(regCal.scale, 0.02);
      await page.click('#tl-verify'); await pick(420, 350); await pick(520, 350);
      await page.waitForSelector(DM + ' #cal-form'); await page.fill('#cal-real', '2'); await page.click('#cal-save');
      await page.waitForFunction(() => /\+?0\.00 %/.test((document.querySelector('#vf-result') || {}).textContent || ''));
      assert.ok(await page.$('#vf-result .pct-ok'), 'within 1 %');
      assert.strictEqual(db.prepare('SELECT verify_pct FROM calibrations WHERE id=?').get(regCal.id).verify_pct, 0, 'the region was verified');
      await page.click('#tl-verify'); await pick(500, 350); await pick(580, 350);
      assert.ok((await page.textContent('#tl-msg')).includes('inside one region'), 'a verify line across a region edge: ' + await page.textContent('#tl-msg'));
      assert.ok(!(await page.$(DM + ' #cal-form')), 'no verify form for it');
      // the preview uses the region of the first point (as the server)
      await page.click('#tl-line'); await pick(420, 450); await pick(520, 450);
      await page.waitForSelector(DM + ' #lk-form');
      assert.ok(Math.abs(await pv() - 2) < 1e-12, 'region scale in the preview: ' + await pv());
      await page.keyboard.press('Escape');
      assert.ok(!(await page.$(DM + ' #lk-form')), 'Esc closes the form with the shape');
      // 6. re-calibrate with measurements: before/after, nothing changes until Apply
      const beforeM = await rowQty(rowM);
      await page.click('#tl-calibrate'); await pick(100, 700); await pick(200, 700);
      await page.waitForSelector(DM + ' #cal-form');
      await page.fill('#cal-real', '10'); await page.click('#cal-save');
      await page.waitForSelector(DM + ' #cal-changes');
      const tbl = await page.textContent('#cal-changes');
      assert.ok(tbl.includes(f2(beforeM)) && tbl.includes(f2(beforeM * 2)) && tbl.includes(f2(24)) && tbl.includes(f2(96)), 'before/after: ' + tbl);
      assert.strictEqual(await rowQty(rowM), beforeM, 'nothing changed before Apply');
      { const i = errors.findIndex(x => x.startsWith('Failed to load resource') && x.includes('409 (Conflict)')); assert.ok(i >= 0, 're-calibration 409 logged'); errors.splice(i, 1); }
      await page.click('#cal-apply');
      await page.waitForFunction(() => /Page: 1 pt = 0\.1 m/.test(document.querySelector('#tl-scale').textContent));
      assert.ok(Math.abs(await rowQty(rowM) - beforeM * 2) < 1e-9 && Math.abs(await rowQty(rowA) - 96) < 1e-9, 'Apply changed the rows');
      assert.ok((await page.textContent(`${DM} #dw-measurements tr[data-row="${rowA}"] td.m-formula`)).includes('(0.1 m/pt)²'), 'list follows the new scale');
      // 10. screenshot (deviceScaleFactor 2): a shape being drawn over the saved ones
      if (process.env.MEASURE_SCREENSHOT) {
        const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 2 });
        const [ck, cv] = admin.split('=');
        await ctx2.addCookies([{ name: ck, value: cv, url: origin }]);
        const p2 = await ctx2.newPage();
        p2.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); p2.on('pageerror', e => errors.push(String(e)));
        await p2.goto(`${origin}/#/tender/${mt}/drawings/${pdfId}`);
        await p2.click(DM + ' #tv-open'); await p2.waitForSelector(DM + ' #tv-canvas[data-ready="1"]');
        await p2.evaluate(() => window.__tvViewer.whenIdle());
        await p2.click('#tl-polyline');
        for (const p of [[250, 300], [380, 300], [380, 420]]) await p2.evaluate(q => window.__tvTools.pick(q), p);
        await p2.evaluate(() => window.__tvViewer.whenIdle());
        await p2.locator('#tv-panel').screenshot({ path: process.env.MEASURE_SCREENSHOT });
        await ctx2.close();
      }
      // 8. approved: no tools; the scale, the overlays and the list still work
      await page.click('#tv-close');
      // approved (a test shortcut: this tender has no priced rows to approve through the API; it takes the frozen price of
      // the tender approved above, so the tender page reads like any approved one)
      db.prepare("UPDATE tenders SET status='approved', frozen=(SELECT frozen FROM tenders WHERE id=?) WHERE id=?").run(full, mt);
      await page.click('#tab-info'); await page.waitForSelector('#tab-body-info');   // the same hash again would not draw the tab anew
      await page.goto(`${origin}/#/tender/${mt}/drawings/${pdfId}`);
      await page.waitForSelector(`${DM} #tv-panel[data-drawing="${pdfId}"] #tv-open`);
      await openM();
      assert.ok(!(await page.$(DM + ' #tl-tools')), 'read-only: no tools');
      assert.ok(!(await page.$(DM + ' .m-edit')), 'read-only: no edit');
      assert.ok((await page.textContent('#tl-scale')).includes('1 pt = 0.1 m'), 'read-only: the scale is shown');
      await page.evaluate(() => window.__tvViewer.requestDraw()); await idleM();
      assert.strictEqual((await page.evaluate(() => window.__tvTools.overlay())).length, 2, 'read-only: overlays drawn');
      assert.ok((await page.textContent(`${DM} #dw-measurements tr[data-row="${rowA}"] td.m-formula`)).includes('page calibration'), 'read-only: the list');
      await page.click('#tv-close');

      // 7. DXF: the polyline tool snaps to true vertices (the marker shows); the saved length is the exact distance
      await page.goto(`${origin}/#/tender/${dwg}/drawings`); await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
      await openViewer();
      assert.ok((await page.textContent('#tl-scale')).includes('1 mm = 0.001 m'), 'DXF scale line: ' + await page.textContent('#tl-scale'));
      assert.ok(!(await page.$('#tl-calibrate')), 'a DXF is calibrated by its units');
      await page.click('#tl-polyline');
      assert.ok(await page.isChecked('#tv-snap'), 'snap on with a tool');
      { const [sx, sy] = await at(0, 0); await page.mouse.move(sx + 3, sy - 2); await frame(); }
      assert.deepStrictEqual(await page.evaluate(() => window.__tvViewer.snapPoint()), { x: 0, y: 0, kind: 'end' }, 'snap marker at the vertex');
      { const [sx, sy] = await at(0, 0); await page.mouse.click(sx + 3, sy - 2); }
      // a double-click on the last point finishes (its second click is the same point, not a new one)
      { const [sx, sy] = await at(3000, 4000); await page.mouse.move(sx - 2, sy + 3); await frame(); await page.mouse.dblclick(sx - 2, sy + 3); }
      await page.waitForSelector(D + ' #lk-form');
      assert.deepStrictEqual(await page.evaluate(() => window.__tvTools.geom()), { tool: 'polyline', pts: [[0, 0], [3000, 4000]] }, 'exact true vertices');
      assert.strictEqual(await pv(), 5, 'preview 5 m');
      await page.selectOption('#lk-row', String(kerbRowB));
      await page.click('#lk-save');
      await page.waitForFunction(() => /Saved: 5\.00 m/.test((document.querySelector('#tl-msg') || {}).textContent || ''));
      const dm = (await call('GET', `tenders/${dwg}/measurements`, null, admin)).j.measurements.find(m => m.tool === 'manual');
      assert.deepStrictEqual([dm.qty, dm.geom.pts], [5, [[0, 0], [3000, 4000]]], 'saved length = the exact distance');
      assert.ok((await page.textContent(`${D} #dw-measurements tr[data-measurement="${dm.id}"] td.m-formula`)).includes('length 5,000.00 mm × 0.001 m/mm = 5.00 m'), 'DXF formula');
      await page.click(`${D} #dw-measurements tr[data-measurement="${dm.id}"] .m-delete`);
      await page.waitForFunction(id => !document.querySelector(`#dw-measurements tr[data-measurement="${id}"]`), dm.id);
      await page.goto(`${origin}/#/tender/${dwg}/drawings`); await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
    }

    // a submitted tender: read-only (no upload, link, delete or units controls), numbers still shown
    await ok(call('POST', `tenders/${dwg}/submit`, null, admin), 'submit drawings tender');
    await page.click('#tab-info'); await page.waitForSelector('#tab-body-info');
    await page.click('#tab-drawings'); await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
    for (const s of ['#dw-upload', '#dw-confirm-units', '.lk-btn', '.m-delete']) assert.strictEqual(await page.$(D + ' ' + s), null, 'read-only: no ' + s);
    assert.ok((await page.textContent(D + ' tr[data-layer="KERB"] td.m-open_length')).includes('5.00'), 'read-only still shows the numbers');
    await openViewer();
    assert.strictEqual(await page.$(D + ' #tv-link'), null, 'read-only: no Link selection');
    assert.ok(!(await page.$(D + ' #tl-tools')), 'read-only: no measuring tools');
    assert.ok((await page.textContent('#tl-scale')).includes('1 mm = 0.001 m'), 'read-only: the scale line');
    await page.click('#tv-none'); await page.check('#tv-layers [data-layer="KERB"] input');
    await clickAt(1500, 2000);
    assert.strictEqual(await nSel(), 1, 'read-only: selection still works');
    assert.strictEqual((await page.textContent('#tv-preview [data-metric="open_length"] .v')).trim(), '5.00 m', 'read-only: preview still works');

    // 100k entities: the viewer opens and each zoom frame stays under TEST_FRAME_MS
    {
      const FRAME_MS = Number(process.env.TEST_FRAME_MS) || 500;
      const big = (await ok(call('POST', 'tenders', { ...info, title: 'Test UI 100k' }, admin), '100k tender')).id;
      const parts = ['0\nSECTION\n2\nENTITIES'];
      for (let i = 0; i < 100000; i++) parts.push('0\nLINE\n5\nH' + i + '\n8\nL' + (i % 20) + '\n10\n' + i + '\n20\n0\n30\n0\n11\n' + (i + 3) + '\n21\n4\n31\n0');
      parts.push('0\nENDSEC\n0\nEOF\n');
      const up = await fetch(`${base}tenders/${big}/drawings?name=big`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: admin }, body: Buffer.from(parts.join('\n')) });
      assert.strictEqual(up.status, 202);
      const bid = (await up.json()).id;
      for (const t0 = Date.now(); db.prepare('SELECT status FROM drawings WHERE id=?').get(bid).status === 'parsing';) {
        if (Date.now() - t0 > 60000) throw new Error('100k still parsing'); await new Promise(f => setTimeout(f, 50));
      }
      await ok(call('PUT', `drawings/${bid}/units`, { units: 'm' }, admin), '100k units');
      const DB = `#drawings[data-tender="${big}"]`;
      await page.goto(`${origin}/#/tender/${big}/drawings/${bid}`);
      await page.waitForSelector(DB + ' #tv-open');
      await page.click(DB + ' #tv-open');
      await page.waitForSelector(DB + ' #tv-canvas[data-ready="1"]', { timeout: 60000 });
      await page.locator('#tv-canvas').scrollIntoViewIfNeeded();
      await frame();
      const box = await page.locator('#tv-canvas').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // the frame after an action: settle two frames first, so an earlier frame is not read
      const timed = async act => {
        await frame();
        await page.evaluate(() => { window.__tvLastFrameMs = undefined; });
        await act();
        await page.waitForFunction(() => typeof window.__tvLastFrameMs === 'number');
        return page.evaluate(() => window.__tvLastFrameMs);
      };
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2, times = [];
      for (let k = 0; k < 5; k++) times.push(['zoom in', await timed(() => page.mouse.wheel(0, -120))]);
      times.push(['fit (all 100k)', await timed(() => page.click('#tv-fit'))]);
      await page.mouse.move(cx, cy);
      times.push(['zoom out at fit', await timed(() => page.mouse.wheel(0, 120))]);
      times.push(['pan', await timed(async () => { await page.mouse.down({ button: 'middle' }); await page.mouse.move(cx - 150, cy - 40, { steps: 3 }); await page.mouse.up({ button: 'middle' }); })]);
      console.log('viewer: 100k frames (ms): ' + times.map(([k, ms]) => k + ' ' + Math.round(ms)).join(', ') + ' (cap ' + FRAME_MS + ')');
      for (const [k, ms] of times) assert.ok(ms < FRAME_MS, '100k ' + k + ' frame took ' + Math.round(ms) + ' ms (cap ' + FRAME_MS + ' ms)');
      assert.ok(await page.evaluate(() => window.__tvViewer.view().scale > 0), 'zoomed');
    }

    // other screens
    for (const [hash, sel] of [['#/costs', '#page-costs'], ['#/library', '#page-library'], ['#/settings', '#page-settings'], ['#/', '#page-home']]) {
      await page.goto(origin + '/' + hash); await page.waitForSelector(sel);
    }

    // Settings → Users: role, active and password reset per user
    await page.goto(origin + '/#/settings'); await page.waitForSelector('#page-settings');
    assert.ok(await page.$('#user-1 select') && await page.$('#user-1 input[type=checkbox]') && await page.$('#user-1 input[type=password]'), 'user row has role, active and reset password');
    await page.goto(origin + '/#/'); await page.waitForSelector('#page-home');

    // Arabic: rtl, kept after reload
    await page.click('#lang-toggle');
    await page.waitForFunction(() => document.dir === 'rtl');
    assert.strictEqual(await page.evaluate(() => document.documentElement.lang), 'ar');
    await page.reload(); await page.waitForSelector('#page-home');
    assert.strictEqual(await page.evaluate(() => document.dir), 'rtl', 'language kept after reload');
    await page.goto(`${origin}/#/tender/${partial}/summary`);
    await page.waitForSelector(`#summary[data-tender="${partial}"] #num-P`);
    assert.ok((await page.textContent('#price-banner')).includes('سعر ناقص — ليس سعر المناقصة'), 'Arabic partial banner');
    await page.goto(`${origin}/#/tender/${dwg}/drawings`);
    await page.waitForSelector(`#drawings[data-tender="${dwg}"] #dw-layers[data-units="mm"]`);
    assert.strictEqual((await page.textContent('#tab-drawings')).trim(), 'المخططات', 'Arabic tab label');
    assert.strictEqual((await page.textContent(`#drawings tr[data-layer="أسفلت"] td.layer-name`)).trim(), 'أسفلت', 'Arabic layer name in the Arabic UI');
    await openViewer();
    const arName = page.locator('#tv-layers [data-layer="أسفلت"] .tv-lname');
    assert.strictEqual((await arName.textContent()).trim(), 'أسفلت', 'Arabic layer name in the viewer panel unchanged');
    assert.strictEqual(await arName.getAttribute('dir'), 'auto', 'layer name isolated (dir=auto)');
    assert.ok((await page.textContent('#tv-preview')).includes('معاينة'), 'Arabic preview label');

    assert.deepStrictEqual(errors, [], 'no console errors');
    await browser.close();
    console.log('ui ok'); done(0);
  } catch (e) { console.error(e); if (browser) await browser.close().catch(() => {}); done(1); }
});
