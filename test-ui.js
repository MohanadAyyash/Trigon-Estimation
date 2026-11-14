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
    assert.strictEqual(await page.isEnabled('#ap-approve'), true, 'approve enabled at the shown margin');
    await page.fill('#ap-margin', '20');
    assert.ok(await page.isVisible('#ap-margin-changed'), 'changed margin warns');
    assert.strictEqual(await page.isEnabled('#ap-approve'), false, 'changed margin blocks approve');
    await page.click('#ap-reprice');
    await page.waitForSelector('#whatif-note');
    const at20 = (await call('GET', `tenders/${full}/price?margin_pct=20`, null, admin)).j.result.P;
    assert.strictEqual((await page.textContent('#num-P')).trim(), f2(at20), 'priced at the typed margin');
    assert.strictEqual(await page.isEnabled('#ap-approve'), true, 'approve enabled once priced at that margin');
    await page.click('#ap-approve');
    await page.waitForSelector('#summary .banner-ok');
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

    // other screens
    for (const [hash, sel] of [['#/costs', '#page-costs'], ['#/library', '#page-library'], ['#/settings', '#page-settings'], ['#/', '#page-home']]) {
      await page.goto(origin + '/' + hash); await page.waitForSelector(sel);
    }

    // Arabic: rtl, kept after reload
    await page.click('#lang-toggle');
    await page.waitForFunction(() => document.dir === 'rtl');
    assert.strictEqual(await page.evaluate(() => document.documentElement.lang), 'ar');
    await page.reload(); await page.waitForSelector('#page-home');
    assert.strictEqual(await page.evaluate(() => document.dir), 'rtl', 'language kept after reload');
    await page.goto(`${origin}/#/tender/${partial}/summary`);
    await page.waitForSelector(`#summary[data-tender="${partial}"] #num-P`);
    assert.ok((await page.textContent('#price-banner')).includes('سعر ناقص — ليس سعر المناقصة'), 'Arabic partial banner');

    assert.deepStrictEqual(errors, [], 'no console errors');
    await browser.close();
    console.log('ui ok'); process.exit(0);
  } catch (e) { console.error(e); if (browser) await browser.close().catch(() => {}); process.exit(1); }
});
