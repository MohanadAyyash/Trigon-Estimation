// Browser UI: static files, i18n key coverage, Playwright smoke (skipped when playwright is not installed): node --no-warnings test-ui.js
// UI_SCREENSHOT=/path/to/file.png saves a screenshot of a tender's Summary tab.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'est-ui-'));
process.env.ERP_SYNC_DISABLED = '1';

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

    let pw = null;
    try { pw = require('playwright'); } catch (e) { console.log('ui: playwright not installed, browser smoke skipped'); }
    if (!pw) { console.log('ui ok'); process.exit(0); }

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

    // a submitted tender: read-only (no upload, link, delete or units controls), numbers still shown
    await ok(call('POST', `tenders/${dwg}/submit`, null, admin), 'submit drawings tender');
    await page.click('#tab-info'); await page.waitForSelector('#tab-body-info');
    await page.click('#tab-drawings'); await page.waitForSelector(D + ' #dw-layers[data-units="mm"]');
    for (const s of ['#dw-upload', '#dw-confirm-units', '.lk-btn', '.m-delete']) assert.strictEqual(await page.$(D + ' ' + s), null, 'read-only: no ' + s);
    assert.ok((await page.textContent(D + ' tr[data-layer="KERB"] td.m-open_length')).includes('5.00'), 'read-only still shows the numbers');

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

    assert.deepStrictEqual(errors, [], 'no console errors');
    await browser.close();
    console.log('ui ok'); process.exit(0);
  } catch (e) { console.error(e); if (browser) await browser.close().catch(() => {}); process.exit(1); }
});
