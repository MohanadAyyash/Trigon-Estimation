// Drawings: raw DXF upload, worker parse, units, layer table: node --no-warnings test-drawings.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), { spawnSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'est-drawings-'));
process.env.ERP_SYNC_DISABLED = '1';
const { server, db, ctx } = require('./server.js');
const { layerTable } = require('./lib/dxf/summary.js');
const http = require('http'), zlib = require('zlib');
const TMP_DIRS = [process.env.DATA_DIR];
const done = code => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); process.exit(code); };
const DDIR = path.join(process.env.DATA_DIR, 'drawings');

// DXF fixtures are built as strings (same builders as test-dxf.js)
const dxf = pairs => [...pairs, [0, 'EOF']].map(([c, v]) => c + '\n' + v).join('\n') + '\n';
const sec = (name, pairs) => [[0, 'SECTION'], [2, name], ...pairs, [0, 'ENDSEC']];
const layerRec = (name, color = 7, flag = 0) => [[0, 'LAYER'], [2, name], [70, flag], [62, color], [6, 'CONTINUOUS']];
const tables = layers => sec('TABLES', [[0, 'TABLE'], [2, 'LAYER'], [70, layers.length], ...layers.flat(), [0, 'ENDTAB']]);
const line = (h, layer, x1, y1, x2, y2) => [[0, 'LINE'], [5, h], [8, layer], [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]];
const lwp = (h, pts, closed, layer) => [[0, 'LWPOLYLINE'], [5, h], [8, layer], [90, pts.length], [70, closed ? 1 : 0], ...pts.flatMap(([x, y]) => [[10, x], [20, y]])];
const sq = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
const insert = (h, name, layer) => [[0, 'INSERT'], [5, h], [8, layer], [2, name], [10, 0], [20, 0]];
const FIXTURE = dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]),
  ...tables([layerRec('KERB'), layerRec('MH'), layerRec('أسفلت')]),
  ...sec('BLOCKS', [[0, 'BLOCK'], [2, 'MH1'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK']]),
  ...sec('ENTITIES', [...lwp('K1', sq(0, 0, 1000), true, 'KERB'), ...line('K2', 'KERB', 0, 0, 3000, 4000), ...insert('M1', 'MH1', 'MH'), [0, 'MTEXT'], [5, 'T9'], [8, 'KERB'], [10, 0], [20, 0], [1, 'NOTE'], [0, 'XLINE'], [5, 'X1'], [8, 'KERB']])]);
const BIG = (() => {
  const parts = ['0\nSECTION\n2\nENTITIES'];
  for (let i = 0; i < 100000; i++) parts.push('0\nLINE\n5\nH' + i + '\n8\nL' + (i % 20) + '\n10\n' + i + '\n20\n0\n30\n0\n11\n' + (i + 3) + '\n21\n4\n31\n0');
  parts.push('0\nENDSEC\n0\nEOF\n');
  return parts.join('\n');
})();
const bigLines = (n, tag) => { const p = ['0\nSECTION\n2\nENTITIES']; for (let i = 0; i < n; i++) p.push('0\nLINE\n5\n' + tag + i + '\n8\nL' + (i % 7) + '\n10\n' + i + '\n20\n0\n11\n' + (i + 3) + '\n21\n4'); p.push('0\nENDSEC\n0\nEOF\n'); return p.join('\n'); };
// a lazy 300 MiB request body: tells how much the client really sent before the server stopped it
const bigStream = () => {
  const chunk = Buffer.from('0\n'.repeat(512 * 1024)), o = { sent: 0 };
  o.stream = new ReadableStream({ pull(c) { if (o.sent >= 300 * 1024 * 1024) return c.close(); o.sent += chunk.length; c.enqueue(chunk); } });
  return o;
};
const dirFiles = () => fs.existsSync(DDIR) ? fs.readdirSync(DDIR).sort() : [];

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api/`;
  const call = async (m, u, b, ck) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck || '' }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie');
    return { s: r.status, j: await r.json().catch(() => null), ck: sc ? sc.split(';')[0] : '' };
  };
  const upload = async (tid, name, body, ck, extra = {}) => {
    const r = await fetch(base + `tenders/${tid}/drawings?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: ck }, body, ...extra });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const waitDone = async (id, ck) => {
    const t0 = Date.now();
    for (;;) {
      const r = await call('GET', `drawings/${id}`, null, ck);
      assert.strictEqual(r.s, 200, JSON.stringify(r.j));
      if (r.j.status !== 'parsing') return r.j;
      if (Date.now() - t0 > 10000) throw new Error('drawing ' + id + ' still parsing after 10 s');
      await new Promise(f => setTimeout(f, 50));
    }
  };
  try {
    const admin = (await call('POST', 'setup', { username: 'admin', password: 'secret12' })).ck;
    assert.strictEqual((await call('POST', 'users', { username: 'qs1', password: 'secret12', role: 'qs' }, admin)).s, 200);
    assert.strictEqual((await call('POST', 'users', { username: 'view1', password: 'secret12', role: 'viewer' }, admin)).s, 200);
    const qs = (await call('POST', 'login', { username: 'qs1', password: 'secret12' })).ck;
    const viewer = (await call('POST', 'login', { username: 'view1', password: 'secret12' })).ck;
    const tid = (await call('POST', 'tenders', { title: 'Test Road Works', kind: 'rta' }, qs)).j.id;
    assert.ok(tid);
    const nDrawings = () => db.prepare('SELECT COUNT(*) n FROM drawings').get().n;

    // ---- over 100 MB: 413 while streaming, nothing left on disk, no row --------------------------------------
    {
      const before = dirFiles();
      const chunk = Buffer.from('0\n'.repeat(512 * 1024)); // 1 MiB
      let sent = 0;
      // the client would send 300 MiB; the server must answer 413 and drop the connection long before that
      const stream = new ReadableStream({ pull(c) { if (sent >= 300 * 1024 * 1024) return c.close(); sent += chunk.length; c.enqueue(chunk); } });
      const r = await upload(tid, 'huge', stream, qs, { duplex: 'half' });
      assert.strictEqual(r.s, 413, 'over 100 MB → 413');
      console.log('413 after the client sent ' + Math.round(sent / 1048576) + ' MiB of 300');
      assert.ok(sent < 300 * 1024 * 1024, 'the client was stopped before sending everything (sent ' + sent + ')');
      assert.deepStrictEqual(dirFiles(), before, 'no file left in DATA_DIR/drawings');
      assert.strictEqual(nDrawings(), 0);
    }
    // a Content-Length over the limit → 413 at once; a refusal before the body is read closes the connection
    {
      const port = server.address().port;
      const rawPost = (u, ck, headers) => new Promise((ok, no) => {
        const q = http.request({ port, method: 'POST', path: '/api/' + u, headers: { cookie: ck, 'Content-Type': 'application/octet-stream', ...headers } }, res => {
          let b = ''; res.on('data', c => b += c); res.on('end', () => ok({ s: res.statusCode, conn: res.headers.connection, b }));
        });
        q.on('error', no);
        q.setTimeout(5000, () => { q.destroy(); no(new Error('no answer within 5 s to ' + u)); });
        q.write('0\n');   // the rest is never sent: the answer must come anyway
      });
      const r = await rawPost(`tenders/${tid}/drawings?name=x`, qs, { 'Content-Length': 100 * 1024 * 1024 + 1 });
      assert.strictEqual(r.s, 413, 'Content-Length > 100 MB → 413 immediately'); assert.strictEqual(r.conn, 'close');
      const v = await rawPost(`tenders/${tid}/drawings?name=x`, viewer, { 'Transfer-Encoding': 'chunked' });
      assert.strictEqual(v.s, 403); assert.strictEqual(v.conn, 'close', 'a pre-body refusal closes the connection');
      const n = await rawPost(`tenders/${tid}/drawings?name=x`, '', { 'Transfer-Encoding': 'chunked' });
      assert.strictEqual(n.s, 401); assert.strictEqual(n.conn, 'close', '401 before the body closes the connection');
    }
    // refusals before the body is read stop the client too (Connection: close)
    {
      const t2 = (await call('POST', 'tenders', { title: 'Approved Works', kind: 'rta' }, qs)).j.id;
      db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(t2);
      for (const [what, tenderId, name, ck, status] of [['no session', tid, 'x', '', 401], ['viewer', tid, 'x', viewer, 403], ['missing tender', 99999, 'x', qs, 404],
        ['approved tender', t2, 'x', qs, 409], ['no name', tid, '', qs, 400]]) {
        const b = bigStream();
        const r = await upload(tenderId, name, b.stream, ck, { duplex: 'half' });
        assert.strictEqual(r.s, status, what);
        assert.ok(b.sent < 300 * 1024 * 1024, what + ': the client was stopped (sent ' + b.sent + ')');
      }
      assert.strictEqual(nDrawings(), 0);
    }
    // an upload the client aborts leaves no temp file
    {
      const before = dirFiles(), ac = new AbortController(), b = bigStream();
      const p = upload(tid, 'aborted', b.stream, qs, { duplex: 'half', signal: ac.signal }).catch(e => e);
      while (b.sent < 8 * 1024 * 1024) await new Promise(f => setTimeout(f, 5));
      ac.abort(); await p;
      const t0 = Date.now();
      while (JSON.stringify(dirFiles()) !== JSON.stringify(before) && Date.now() - t0 < 3000) await new Promise(f => setTimeout(f, 20));
      assert.deepStrictEqual(dirFiles(), before, 'aborted upload: temp file removed');
      assert.strictEqual(nDrawings(), 0);
    }

    // ---- bad uploads: binary DXF, empty body, no name, roles, status --------------------------------------
    {
      const before = dirFiles();
      const bin = Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1'), Buffer.alloc(4096, 1)]);
      const r = await upload(tid, 'bin', bin, qs);
      assert.strictEqual(r.s, 400); assert.match(r.j.error, /binary DXF is not supported — save as ASCII DXF/);
      assert.strictEqual(nDrawings(), 0, 'binary: no row'); assert.deepStrictEqual(dirFiles(), before, 'binary: no file left');
      const e = await upload(tid, 'empty', Buffer.alloc(0), qs);
      assert.strictEqual(e.s, 400, 'empty body'); assert.strictEqual(nDrawings(), 0);
      assert.strictEqual((await upload(tid, '', Buffer.from(FIXTURE), qs)).s, 400, 'name is required');
      assert.strictEqual((await upload(tid, 'v', Buffer.from(FIXTURE), viewer)).s, 403, 'viewer POST → 403');
      assert.strictEqual((await upload(tid, 'x', Buffer.from(FIXTURE), '')).s, 401);
      assert.strictEqual((await upload(99999, 'x', Buffer.from(FIXTURE), qs)).s, 404, 'missing tender');
      assert.deepStrictEqual(dirFiles(), before, 'refused uploads leave no file');
    }

    // ---- upload the fixture → 202, parse in the worker → ready ------------------------------------------
    const up = await upload(tid, 'Site plan', Buffer.from(FIXTURE), qs);
    assert.strictEqual(up.s, 202, JSON.stringify(up.j));
    const id = up.j.id;
    const d = await waitDone(id, viewer);
    assert.strictEqual(d.status, 'ready', d.error);
    assert.strictEqual(d.kind, 'dxf'); assert.strictEqual(d.name, 'Site plan'); assert.strictEqual(d.tender_id, tid);
    assert.strictEqual(d.suggested_units, 'mm'); assert.strictEqual(d.units, null);
    assert.strictEqual(d.bytes, Buffer.byteLength(FIXTURE));
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(d.sha256, require('crypto').createHash('sha256').update(FIXTURE).digest('hex'));
    assert.strictEqual(d.header.insunits, 4);
    assert.strictEqual(d.ignored.XLINE, 1, 'ignored entity types are reported');
    assert.ok(Array.isArray(d.warnings));
    assert.deepStrictEqual(dirFiles(), [d.sha256 + '.dxf', d.sha256 + '.json.gz', d.sha256 + '.summary.json.gz']);
    // the cache holds flat entries without codes
    const cache = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(DDIR, d.sha256 + '.json.gz'))));
    assert.deepStrictEqual(Object.keys(cache).sort(), ['flat', 'header', 'ignored', 'layers', 'warnings']);
    assert.ok(cache.flat.length >= 3 && cache.flat.every(f => !('codes' in f) && 'geomKey' in f && 'bbox' in f));
    // the GET routes read only the small summary: they work with the full cache gone, and match layerTable(full flat)
    const expectLayers = unit => { const lt = layerTable(cache.flat, cache.layers, unit); return { units: unit, units_confirmed: unit !== null, layers: lt.layers, warnings: [...cache.warnings, ...lt.warnings] }; };
    fs.unlinkSync(path.join(DDIR, d.sha256 + '.json.gz'));
    const au = (await call('GET', 'audit', null, admin)).j.find(a => a.action === 'upload' && a.entity === 'drawings');
    assert.deepStrictEqual(JSON.parse(au.detail), { name: 'Site plan', bytes: d.bytes, sha256: d.sha256 });

    // list
    const list = await call('GET', `tenders/${tid}/drawings`, null, viewer);
    assert.strictEqual(list.s, 200); assert.deepStrictEqual(list.j.map(x => x.id), [id]);

    // layers before units: no numbers, not confirmed
    let ly = await call('GET', `drawings/${id}/layers`, null, viewer);
    assert.strictEqual(ly.s, 200);
    assert.deepStrictEqual(ly.j, expectLayers(null), 'layers (no units) = layerTable(full flat, null)');
    assert.deepStrictEqual((await call('GET', `drawings/${id}`, null, viewer)).j.header, cache.header);
    assert.strictEqual(ly.j.units_confirmed, false); assert.strictEqual(ly.j.units, null);
    const kerb0 = ly.j.layers.find(l => l.layer === 'KERB');
    assert.strictEqual(kerb0.open_length, null); assert.strictEqual(kerb0.area, null);
    assert.strictEqual(ly.j.layers.find(l => l.layer === 'MH').blocks, null);
    assert.ok(ly.j.layers.some(l => l.layer === 'أسفلت'), 'Arabic layer name round-trips');

    // units: validation, roles, then confirm
    assert.strictEqual((await call('PUT', `drawings/${id}/units`, { units: 'yd' }, qs)).s, 400, 'invalid unit');
    assert.strictEqual((await call('PUT', `drawings/${id}/units`, { units: 'constructor' }, qs)).s, 400, 'inherited key');
    assert.strictEqual((await call('PUT', `drawings/${id}/units`, {}, qs)).s, 400);
    assert.strictEqual((await call('PUT', `drawings/${id}/units`, { units: 'mm' }, viewer)).s, 403, 'viewer cannot set units');
    const pu = await call('PUT', `drawings/${id}/units`, { units: 'mm' }, qs);
    assert.strictEqual(pu.s, 200, JSON.stringify(pu.j)); assert.strictEqual(pu.j.units, 'mm');
    ly = await call('GET', `drawings/${id}/layers`, null, qs);
    assert.strictEqual(ly.j.units_confirmed, true); assert.strictEqual(ly.j.units, 'mm');
    assert.deepStrictEqual(ly.j, expectLayers('mm'), 'layers in mm = layerTable(full flat, mm)');
    const kerb = ly.j.layers.find(l => l.layer === 'KERB');
    assert.ok(Math.abs(kerb.open_length - 5) < 1e-9, 'KERB open_length 5 m: ' + kerb.open_length);
    assert.ok(Math.abs(kerb.closed_perimeter - 4) < 1e-9); assert.ok(Math.abs(kerb.area - 1) < 1e-9);
    assert.deepStrictEqual(ly.j.layers.find(l => l.layer === 'MH').blocks, [{ name: 'MH1', top: 1, nested: 0 }]);
    const ua = (await call('GET', 'audit', null, admin)).j.find(a => a.action === 'units');
    assert.deepStrictEqual(JSON.parse(ua.detail), { from: null, to: 'mm' });
    assert.strictEqual((await call('PUT', `drawings/${id}/units`, { units: 'm' }, admin)).j.units, 'm', 'admin may change units before measuring');
    assert.deepStrictEqual((await call('GET', `drawings/${id}/layers`, null, qs)).j, expectLayers('m'), 'layers in m = layerTable(full flat, m)');
    assert.ok(!fs.existsSync(path.join(DDIR, d.sha256 + '.json.gz')), 'the full cache was not needed');
    assert.strictEqual((await call('PUT', `drawings/${id}/units`, { units: 'mm' }, qs)).s, 200);

    // missing drawing → 404
    assert.strictEqual((await call('GET', 'drawings/99999', null, qs)).s, 404);
    assert.strictEqual((await call('GET', 'drawings/abc/layers', null, qs)).s, 404);
    assert.strictEqual((await call('PUT', 'drawings/99999/units', { units: 'mm' }, qs)).s, 404);

    // ---- same file twice → one .dxf on disk, both ready ---------------------------------------------------
    const up2 = await upload(tid, 'Site plan copy', Buffer.from(FIXTURE), qs);
    assert.strictEqual(up2.s, 202);
    const d2 = await waitDone(up2.j.id, qs);
    assert.strictEqual(d2.status, 'ready'); assert.strictEqual(d2.sha256, d.sha256); assert.strictEqual(d2.suggested_units, 'mm');
    assert.strictEqual(d2.units, null, 'units are confirmed per drawing');
    assert.strictEqual(dirFiles().filter(f => f.endsWith('.dxf')).length, 1, 'one .dxf on disk');
    // two concurrent uploads of a new file share one parse and both end ready
    {
      const F2 = FIXTURE.replace('K2\n8\nKERB', 'K3\n8\nKERB');
      const [a, b] = await Promise.all([upload(tid, 'a', Buffer.from(F2), qs), upload(tid, 'b', Buffer.from(F2), qs)]);
      assert.deepStrictEqual([a.s, b.s], [202, 202]);
      const [da, dbb] = [await waitDone(a.j.id, qs), await waitDone(b.j.id, qs)];
      assert.deepStrictEqual([da.status, dbb.status], ['ready', 'ready']); assert.strictEqual(da.sha256, dbb.sha256);
      assert.strictEqual(dirFiles().filter(f => f.endsWith('.dxf')).length, 2);
      assert.ok(!dirFiles().some(f => f.includes('tmp')), 'no temp files left');
    }

    // ---- a corrupt file → failed with the parser's message, audited --------------------------------------
    {
      const trunc = FIXTURE.slice(0, FIXTURE.indexOf('0\nEOF'));
      const r = await upload(tid, 'truncated', Buffer.from(trunc), qs);
      assert.strictEqual(r.s, 202);
      const f = await waitDone(r.j.id, qs);
      assert.strictEqual(f.status, 'failed'); assert.match(f.error, /truncated/);
      assert.strictEqual((await call('GET', `drawings/${r.j.id}/layers`, null, qs)).s, 409, 'no layers for a failed drawing');
      assert.strictEqual((await call('PUT', `drawings/${r.j.id}/units`, { units: 'm' }, qs)).s, 409, 'units need a ready drawing');
      const pf = (await call('GET', 'audit', null, admin)).j.find(a => a.action === 'parse_failed');
      assert.ok(pf && /truncated/.test(JSON.parse(pf.detail).error));
    }

    // ---- responsiveness: the server answers while a 100,000-LINE parse runs ------------------------------
    {
      const r = await upload(tid, 'big', Buffer.from(BIG), qs);
      assert.strictEqual(r.s, 202);
      let observed = 0;
      const t0 = Date.now();
      for (;;) {
        const s = await call('GET', `drawings/${r.j.id}`, null, qs);
        if (s.j.status !== 'parsing') { assert.strictEqual(s.j.status, 'ready', s.j.error); break; }
        const a = performance.now(); const st = await call('GET', 'status', null, qs); const ms = performance.now() - a;
        assert.strictEqual(st.s, 200); assert.ok(ms < 500, '/api/status took ' + Math.round(ms) + ' ms during a parse');
        observed++;
        if (Date.now() - t0 > 30000) throw new Error('100k parse still running after 30 s');
      }
      assert.ok(observed > 0, 'no /api/status call overlapped the 100k parse');
      console.log('responsiveness: ' + observed + ' /api/status call(s) answered < 500 ms during the parse');
      await call('PUT', `drawings/${r.j.id}/units`, { units: 'm' }, qs);
      const bl = (await call('GET', `drawings/${r.j.id}/layers`, null, qs)).j;
      assert.strictEqual(bl.layers.reduce((s, l) => s + l.entities, 0), 100000);
      assert.strictEqual(bl.layers.reduce((s, l) => s + l.open_length, 0), 500000);
    }

    // ---- one parse at a time: three uploads at once never run two workers, and all end ready ----------------
    {
      const w = ctx.drawings._workers; w.peak = w.alive;
      const started = w.started;
      const ups = await Promise.all(['QA', 'QB', 'QC'].map(tag => upload(tid, tag, Buffer.from(bigLines(20000, tag)), qs)));
      assert.deepStrictEqual(ups.map(u => u.s), [202, 202, 202]);
      for (const u of ups) assert.strictEqual((await waitDone(u.j.id, qs)).status, 'ready');
      assert.strictEqual(w.started - started, 3, 'three parses');
      assert.strictEqual(w.peak, 1, 'never more than one worker alive');
      assert.strictEqual(w.alive, 0);
    }

    // ---- ctx.drawings hooks; units cannot change after measuring ------------------------------------------
    {
      assert.strictEqual(typeof ctx.drawings.hasMeasurements, 'function');
      const rowA = 501, rowB = 502;
      assert.strictEqual(ctx.drawings.hasMeasurements(rowA), false);
      assert.strictEqual(ctx.drawings.rowMeasuredQty(rowA), null);
      const ins = db.prepare("INSERT INTO measurements(drawing_id,tender_id,row_id,tool,layer,metric,qty,qty_unit,created,created_by) VALUES(?,?,?,'dxf_layer','KERB','open_length',?,?,'2026-11-15','qs1')");
      ins.run(id, tid, rowA, 5, 'm'); ins.run(id, tid, rowA, 2.5, 'm'); ins.run(id, tid, null, 9, 'm');
      assert.strictEqual(ctx.drawings.hasMeasurements(rowA), true);
      assert.deepStrictEqual(ctx.drawings.rowMeasuredQty(rowA), { qty: 7.5, unit: 'm', count: 2 });
      ins.run(id, tid, rowB, 1, 'm'); ins.run(id, tid, rowB, 1, 'm2');
      assert.deepStrictEqual(ctx.drawings.rowMeasuredQty(rowB), { qty: 2, unit: null, count: 2 }, 'mixed units: unit null');
      const r = await call('PUT', `drawings/${id}/units`, { units: 'm' }, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'units cannot change after measuring (batch 4 adds a before/after flow)');
      // the second drawing (same file) has no measurements: its units can still be set
      assert.strictEqual((await call('PUT', `drawings/${up2.j.id}/units`, { units: 'mm' }, qs)).s, 200);
    }

    // ---- a tender that is not draft: writes 409 (before the body is read), reads allowed -----------------
    {
      db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(tid);
      const before = dirFiles();
      const r = await upload(tid, 'late', Buffer.from(FIXTURE + ' '), qs);
      assert.strictEqual(r.s, 409, 'approved tender → POST 409');
      assert.deepStrictEqual(dirFiles(), before, 'no file written for a refused upload');
      assert.strictEqual((await call('PUT', `drawings/${up2.j.id}/units`, { units: 'm' }, qs)).s, 409, 'units on approved tender → 409');
      assert.strictEqual((await call('GET', `drawings/${up2.j.id}/layers`, null, viewer)).s, 200, 'reads still allowed');
      assert.strictEqual((await call('GET', `tenders/${tid}/drawings`, null, viewer)).s, 200);
    }

    // ---- restart while parsing: a drawing left 'parsing' is parsed again on start --------------------------
    {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'est-drawings-restart-'));
      const env = { ...process.env, DATA_DIR: dir2 };
      const src = path.join(dir2, 'fixture.dxf'); fs.writeFileSync(src, FIXTURE);
      const sha = d.sha256;
      // first run: a row is left 'parsing' (as if the server stopped mid-parse)
      const a = spawnSync(process.execPath, ['--no-warnings', '-e', `
        const fs = require('fs'), path = require('path');
        const { db } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
        fs.copyFileSync(${JSON.stringify(src)}, path.join(process.env.DATA_DIR, 'drawings', ${JSON.stringify(sha + '.dxf')}));
        db.prepare("INSERT INTO tenders(title,kind,status,created) VALUES('T','rta','draft','x')").run();
        db.prepare("INSERT INTO drawings(tender_id,name,sha256,bytes,status,created) VALUES(1,'p',?,1,'parsing','x')").run(${JSON.stringify(sha)});
        db.prepare("INSERT INTO drawings(tender_id,name,sha256,bytes,status,created) VALUES(1,'gone',?,1,'parsing','x')").run('0'.repeat(64));
        process.exit(0);`], { env, encoding: 'utf8' });
      assert.strictEqual(a.status, 0, a.stderr);
      // second run: the module re-queues the parse
      const b = spawnSync(process.execPath, ['--no-warnings', '-e', `
        const { db } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
        const t0 = Date.now();
        const tick = () => { const r = db.prepare('SELECT status, suggested_units, error FROM drawings ORDER BY id').all();
          if (r.every(x => x.status !== 'parsing') || Date.now() - t0 > 10000) { console.log(JSON.stringify(r)); process.exit(0); } setTimeout(tick, 50); };
        tick();`], { env, encoding: 'utf8' });
      assert.strictEqual(b.status, 0, b.stderr);
      const rows = JSON.parse(b.stdout.trim());
      assert.deepStrictEqual(rows[0], { status: 'ready', suggested_units: 'mm', error: null });
      assert.strictEqual(rows[1].status, 'failed'); assert.strictEqual(rows[1].error, 'the stored drawing file is missing', 'no server path in the error');
      TMP_DIRS.push(dir2);
    }
    // a parse that runs out of memory fails with a clear message (small heap for the test)
    {
      const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'est-drawings-oom-')); TMP_DIRS.push(dir3);
      const src = path.join(dir3, 'big.dxf'); fs.writeFileSync(src, BIG);
      const c = spawnSync(process.execPath, ['--no-warnings', '-e', `
        const fs = require('fs'), path = require('path');
        const { db } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
        fs.copyFileSync(${JSON.stringify(src)}, path.join(process.env.DATA_DIR, 'drawings', '${'a'.repeat(64)}.dxf'));
        db.prepare("INSERT INTO tenders(title,kind,status,created) VALUES('T','rta','draft','x')").run();
        db.prepare("INSERT INTO drawings(tender_id,name,sha256,bytes,status,created) VALUES(1,'p',?,1,'parsing','x')").run('${'a'.repeat(64)}');
        process.exit(0);`], { env: { ...process.env, DATA_DIR: dir3 }, encoding: 'utf8' });
      assert.strictEqual(c.status, 0, c.stderr);
      const e = spawnSync(process.execPath, ['--no-warnings', '-e', `
        const { db } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
        const t0 = Date.now();
        const tick = () => { const r = db.prepare('SELECT status, error FROM drawings WHERE id=1').get();
          if (r.status !== 'parsing' || Date.now() - t0 > 20000) { console.log(JSON.stringify(r)); process.exit(0); } setTimeout(tick, 50); };
        tick();`], { env: { ...process.env, DATA_DIR: dir3, DRAWINGS_PARSE_HEAP_MB: '16' }, encoding: 'utf8' });
      assert.strictEqual(e.status, 0, e.stderr);
      assert.deepStrictEqual(JSON.parse(e.stdout.trim()), { status: 'failed', error: 'drawing too large to parse — PURGE unused objects or split the drawing in AutoCAD, then save as DXF again' });
    }

    console.log('drawings ok'); done(0);
  } catch (e) { console.error(e); done(1); }
});
