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
// timing caps: TEST_LATENCY_MS (an /api/status answer during a parse), TEST_WAIT_MS (waiting for a parse); raise on slow machines
const LATENCY_MS = Number(process.env.TEST_LATENCY_MS) || 500, WAIT_MS = Number(process.env.TEST_WAIT_MS) || 10000;
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
      if (Date.now() - t0 > WAIT_MS) throw new Error('drawing ' + id + ' still parsing after ' + WAIT_MS + ' ms');
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
    assert.deepStrictEqual(dirFiles(), [d.sha256 + '.dxf', d.sha256 + '.json.gz', d.sha256 + '.render.bin.gz', d.sha256 + '.summary.json.gz']);
    // the cache holds flat entries without codes
    const cache = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(DDIR, d.sha256 + '.json.gz'))));
    assert.deepStrictEqual(Object.keys(cache).sort(), ['flat', 'header', 'ignored', 'layers', 'version', 'warnings']);
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

    // ---- display file: GET /drawings/:id/render → the stored gz bytes as they are, ETag, 304; any reader, before units ----
    {
      const port = server.address().port, { PARSER_VERSION } = require('./lib/dxf/summary.js');
      const getRaw = (u, ck, headers = {}) => new Promise((ok, no) => {
        http.get({ port, path: '/api/' + u, headers: { cookie: ck, ...headers } }, rs => { const b = []; rs.on('data', c => b.push(c)); rs.on('end', () => ok({ s: rs.statusCode, h: rs.headers, b: Buffer.concat(b) })); }).on('error', no);
      });
      const rf = path.join(DDIR, d.sha256 + '.render.bin.gz');
      const r1 = await getRaw(`drawings/${id}/render`, viewer);
      assert.strictEqual(r1.s, 200, r1.b.toString());
      assert.strictEqual(r1.h['content-type'], 'application/octet-stream'); assert.strictEqual(r1.h['content-encoding'], 'gzip');
      assert.strictEqual(r1.h.etag, `"${d.sha256}-${PARSER_VERSION}"`); assert.strictEqual(r1.h['cache-control'], 'private, max-age=86400');
      assert.ok(r1.b.equals(fs.readFileSync(rf)), 'the stored gz bytes as they are');
      assert.strictEqual(Number(r1.h['content-length']), r1.b.length);
      const raw = zlib.gunzipSync(r1.b), header = JSON.parse(raw.subarray(4, 4 + raw.readUInt32LE(0)).toString('utf8'));
      assert.strictEqual(header.version, 2);
      assert.deepStrictEqual(header.handles, cache.flat.map(f => f.handle), 'one entity per cache entry, same order');
      assert.ok(header.layers.some(l => l.name === 'أسفلت'), 'Arabic layer name round-trips');
      assert.deepStrictEqual(header.blocks, ['MH1']);
      const r2 = await getRaw(`drawings/${id}/render`, qs, { 'If-None-Match': r1.h.etag });
      assert.strictEqual(r2.s, 304); assert.strictEqual(r2.b.length, 0); assert.strictEqual(r2.h.etag, r1.h.etag);
      assert.strictEqual((await getRaw(`drawings/${id}/render`, qs, { 'If-None-Match': '"other", ' + r1.h.etag })).s, 304, 'a list of tags');
      assert.strictEqual((await getRaw(`drawings/${id}/render`, qs, { 'If-None-Match': `"${d.sha256}-1"` })).s, 200, 'another parser version: full body');
      assert.strictEqual((await getRaw(`drawings/${id}/render`, '')).s, 401);
      assert.strictEqual((await getRaw('drawings/99999/render', qs)).s, 404);
      // before units are confirmed: geometry is not a quantity
      const units = db.prepare('SELECT units FROM drawings WHERE id=?').get(id).units;
      db.prepare('UPDATE drawings SET units=NULL WHERE id=?').run(id);
      assert.strictEqual((await getRaw(`drawings/${id}/render`, viewer)).s, 200, 'served before units are confirmed');
      db.prepare('UPDATE drawings SET units=? WHERE id=?').run(units, id);
      // not ready → 409
      for (const st of ['failed', 'parsing']) {
        const nid = Number(db.prepare("INSERT INTO drawings(tender_id,name,sha256,bytes,status,created) VALUES(?,?,?,1,?,'x')").run(tid, 'nr', 'f'.repeat(64), st).lastInsertRowid);
        const r = await getRaw(`drawings/${nid}/render`, qs);
        assert.strictEqual(r.s, 409, st); assert.match(JSON.parse(r.b).error, new RegExp('drawing is ' + st));
        db.prepare('DELETE FROM drawings WHERE id=?').run(nid);
      }
      // the display file is missing (a parse by an older version): parsed again through the shared queue, then served
      fs.unlinkSync(rf);
      const w = ctx.drawings._workers, started = w.started;
      const r3 = await getRaw(`drawings/${id}/render`, qs);
      assert.strictEqual(r3.s, 200, r3.b.toString()); assert.strictEqual(w.started - started, 1, 'one re-parse');
      assert.ok(fs.existsSync(rf)); assert.ok(zlib.gunzipSync(r3.b).equals(raw), 'the same display file');
      // a display file that cannot be built (cap lowered for the test) never blocks the quantities: ready, layers with
      // numbers; GET render → 409 with the reason, recorded in the summary, and no re-parse however often it is asked
      process.env.DRAWINGS_RENDER_MAX_POINTS = '3';
      const big = await upload(tid, 'too big to show', Buffer.from(FIXTURE.replace('NOTE', 'NOTE-NODISPLAY')), qs);
      const db2 = await waitDone(big.j.id, qs);
      delete process.env.DRAWINGS_RENDER_MAX_POINTS;
      assert.strictEqual(db2.status, 'ready', db2.error);
      assert.ok(!fs.existsSync(path.join(DDIR, db2.sha256 + '.render.bin.gz')), 'no display file');
      const sm = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DDIR, db2.sha256 + '.summary.json.gz'))));
      assert.deepStrictEqual(sm.render, { ok: false, error: 'drawing too large to display' });
      assert.strictEqual((await call('PUT', `drawings/${big.j.id}/units`, { units: 'mm' }, qs)).s, 200);
      const bl = await call('GET', `drawings/${big.j.id}/layers`, null, qs);
      assert.strictEqual(bl.s, 200); assert.ok(Math.abs(bl.j.layers.find(l => l.layer === 'KERB').open_length - 5) < 1e-9, 'quantities unaffected');
      const s0 = w.started;
      for (let i = 0; i < 2; i++) {
        ctx.drawings._summaries().clear();
        const g = await getRaw(`drawings/${big.j.id}/render`, viewer);
        assert.strictEqual(g.s, 409); assert.deepStrictEqual(JSON.parse(g.b), { error: 'display not available for this drawing: drawing too large to display' });
      }
      assert.strictEqual(w.started - s0, 0, 'a recorded display failure is not parsed again');
      // the same file uploaded again: the complete summary (with its recorded failure) is reused at once
      const again = await upload(tid, 'too big again', Buffer.from(FIXTURE.replace('NOTE', 'NOTE-NODISPLAY')), qs);
      assert.strictEqual(db.prepare('SELECT status FROM drawings WHERE id=?').get(again.j.id).status, 'ready'); assert.strictEqual(w.started - s0, 0);
      // leave the store as the tests below expect it (one .dxf)
      db.prepare('DELETE FROM drawings WHERE id IN (?, ?)').run(big.j.id, again.j.id);
      for (const f of dirFiles()) if (f.startsWith(db2.sha256)) fs.unlinkSync(path.join(DDIR, f));
    }

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

    // ---- the tender is deleted while the body arrives → 404; the new file is removed, a shared one kept --------
    {
      const port = server.address().port;
      const slowUpload = (tenderId, name, data, between) => new Promise((res2, rej) => {
        const q = http.request({ port, method: 'POST', path: `/api/tenders/${tenderId}/drawings?name=${name}`, headers: { cookie: qs, 'Content-Type': 'application/octet-stream', 'Content-Length': data.length } }, rs => {
          let b = ''; rs.on('data', c => b += c); rs.on('end', () => res2({ s: rs.statusCode, j: JSON.parse(b) }));
        });
        q.on('error', rej);
        q.write(data.subarray(0, 10));   // the route has passed its checks and is reading the body
        setTimeout(() => { try { between(); q.end(data.subarray(10)); } catch (e) { rej(e); } }, 200);
      });
      for (const [what, body, kept] of [['new file', FIXTURE.replace('K2\n8\nKERB', 'K7\n8\nKERB'), false], ['shared file', FIXTURE, true]]) {
        const gone = (await call('POST', 'tenders', { title: 'Test Gone', kind: 'rta' }, qs)).j.id;
        const n0 = nDrawings();
        const r = await slowUpload(gone, 'gone', Buffer.from(body), () => db.prepare('DELETE FROM tenders WHERE id=?').run(gone));
        assert.strictEqual(r.s, 404, what + ': ' + JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'tender not found');
        assert.strictEqual(nDrawings(), n0, what + ': no drawing row');
        const sha = require('crypto').createHash('sha256').update(body).digest('hex');
        assert.strictEqual(fs.existsSync(path.join(DDIR, sha + '.dxf')), kept, what + ': file ' + (kept ? 'kept (another drawing uses it)' : 'removed'));
        assert.ok(!dirFiles().some(f => f.startsWith('tmp-')), what + ': no temp file');
      }
    }

    // ---- PARSER_VERSION: a summary written by an older parser is never reused: it is parsed again ---------------
    {
      const { PARSER_VERSION } = require('./lib/dxf/summary.js');
      assert.ok(Number.isInteger(PARSER_VERSION) && PARSER_VERSION > 1);
      const F3 = FIXTURE.replace('K2\n8\nKERB', 'K4\n8\nKERB');
      const u = await upload(tid, 'versioned', Buffer.from(F3), qs);
      assert.strictEqual(u.s, 202);
      // wait in the database: a GET would load the summary into the server's memory
      for (const t0 = Date.now(); db.prepare('SELECT status FROM drawings WHERE id=?').get(u.j.id).status === 'parsing';) {
        if (Date.now() - t0 > WAIT_MS) throw new Error('still parsing'); await new Promise(f => setTimeout(f, 20));
      }
      const sha = db.prepare('SELECT sha256 FROM drawings WHERE id=?').get(u.j.id).sha256, sf = path.join(DDIR, sha + '.summary.json.gz');
      const readV = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(sf))).version;
      assert.strictEqual(readV(), PARSER_VERSION, 'the summary carries the parser version');
      assert.strictEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DDIR, sha + '.json.gz')))).version, PARSER_VERSION, 'the cache too');
      // a summary from before the version field (stubbed: same content, no version, no dropped counts)
      const stale = () => { const v = JSON.parse(zlib.gunzipSync(fs.readFileSync(sf))); delete v.version; for (const l of v.raw.layers) delete l.dropped; fs.writeFileSync(sf, zlib.gzipSync(JSON.stringify(v))); };
      stale();
      const w = ctx.drawings._workers; let started = w.started;
      const ly = await call('GET', `drawings/${u.j.id}/layers`, null, qs);
      assert.strictEqual(ly.s, 200, JSON.stringify(ly.j));
      assert.strictEqual(w.started - started, 1, 'GET layers: an old summary is parsed again');
      assert.strictEqual(readV(), PARSER_VERSION); assert.ok(ly.j.layers.every(l => 'dropped' in l), 'the new parse is served');
      // the same file uploaded again: an old summary is not reused
      stale(); started = w.started;
      const u2 = await upload(tid, 'versioned again', Buffer.from(F3), qs);
      assert.strictEqual((await waitDone(u2.j.id, qs)).status, 'ready');
      assert.strictEqual(w.started - started, 1, 'upload: an old summary is parsed again, not reused');
      assert.strictEqual(readV(), PARSER_VERSION);
      // a current summary is reused at once (no parse)
      started = w.started;
      const u3 = await upload(tid, 'versioned third', Buffer.from(F3), qs);
      assert.strictEqual(db.prepare('SELECT status FROM drawings WHERE id=?').get(u3.j.id).status, 'ready', 'current summary: ready at once');
      assert.strictEqual(w.started - started, 0);
    }

    // ---- a missing summary is rebuilt from the stored .dxf; with the .dxf gone too: 409 and no parse ----------
    {
      const w = ctx.drawings._workers;
      const up = async (name, body) => { const r = await upload(tid, name, Buffer.from(body), qs); assert.strictEqual(r.s, 202); assert.strictEqual((await waitDone(r.j.id, qs)).status, 'ready'); return r.j.id; };
      const shaOf = id => db.prepare('SELECT sha256 FROM drawings WHERE id=?').get(id).sha256;
      const rm = (sha, ...ext) => { for (const e of ext) fs.rmSync(path.join(DDIR, sha + e), { force: true }); };
      const id1 = await up('rebuild', FIXTURE.replace('NOTE', 'NOTE-REBUILD')), sha1 = shaOf(id1);
      assert.strictEqual((await call('PUT', `drawings/${id1}/units`, { units: 'm' }, qs)).s, 200);
      const before = (await call('GET', `drawings/${id1}/layers`, null, qs)).j;
      rm(sha1, '.summary.json.gz', '.json.gz'); ctx.drawings._summaries().clear();   // as after a restart: nothing in memory
      let started = w.started;
      const again = await call('GET', `drawings/${id1}/layers`, null, qs);
      assert.strictEqual(again.s, 200, JSON.stringify(again.j));
      assert.deepStrictEqual(again.j.layers, before.layers, 'the rebuilt summary gives the same totals');
      assert.strictEqual(w.started - started, 1, 'rebuilt by one parse');
      assert.ok(fs.existsSync(path.join(DDIR, sha1 + '.summary.json.gz')) && fs.existsSync(path.join(DDIR, sha1 + '.json.gz')) && fs.existsSync(path.join(DDIR, sha1 + '.render.bin.gz')), 'all caches rewritten');
      // the .dxf is gone as well: the old 409, and no worker starts, however often it is asked
      const id2 = await up('rebuild gone', FIXTURE.replace('NOTE', 'NOTE-GONE')), sha2 = shaOf(id2);
      rm(sha2, '.summary.json.gz', '.json.gz', '.dxf'); ctx.drawings._summaries().clear();
      started = w.started;
      for (let i = 0; i < 2; i++) {
        const g = await call('GET', `drawings/${id2}`, null, qs);
        assert.strictEqual(g.s, 409, JSON.stringify(g.j)); assert.match(g.j.error, /upload the drawing again/);
      }
      assert.strictEqual(w.started - started, 0, 'no worker without a .dxf');
      // a stored .dxf that no longer parses: the first view records the failure, later views do not queue it again
      const id3 = await up('rebuild corrupt', FIXTURE.replace('NOTE', 'NOTE-BAD')), sha3 = shaOf(id3);
      rm(sha3, '.summary.json.gz', '.json.gz'); ctx.drawings._summaries().clear();
      fs.writeFileSync(path.join(DDIR, sha3 + '.dxf'), FIXTURE.slice(0, FIXTURE.indexOf('0\nEOF')));
      started = w.started;
      const f1 = await call('GET', `drawings/${id3}`, null, qs);
      assert.strictEqual(f1.s, 409, JSON.stringify(f1.j)); assert.match(f1.j.error, /truncated/);
      assert.strictEqual(w.started - started, 1);
      const row = db.prepare('SELECT status, error FROM drawings WHERE id=?').get(id3);
      assert.strictEqual(row.status, 'failed'); assert.match(row.error, /truncated/);
      assert.ok(!row.error.includes(process.env.DATA_DIR), 'no server path in the message');
      const f2 = await call('GET', `drawings/${id3}`, null, qs);
      assert.strictEqual(f2.s, 200); assert.strictEqual(f2.j.status, 'failed');
      assert.strictEqual((await call('GET', `drawings/${id3}/layers`, null, qs)).s, 409);
      assert.strictEqual(w.started - started, 1, 'a recorded failure is not parsed again');
    }

    // ---- Fix round 1: unreadable summary rebuilt; old summary + no .dxf; transient failures do not stick ---------
    {
      const w = ctx.drawings._workers;
      const up = async (name, body) => { const r = await upload(tid, name, Buffer.from(body), qs); assert.strictEqual(r.s, 202); assert.strictEqual((await waitDone(r.j.id, qs)).status, 'ready'); return r.j.id; };
      const shaOf = id => db.prepare('SELECT sha256 FROM drawings WHERE id=?').get(id).sha256;
      const P = (sha, e) => path.join(DDIR, sha + e), clear = () => ctx.drawings._summaries().clear();
      // a corrupt summary file is treated like a missing one
      const id1 = await up('garbled', FIXTURE.replace('NOTE', 'NOTE-GARBLED')), sha1 = shaOf(id1);
      fs.writeFileSync(P(sha1, '.summary.json.gz'), 'not gzip at all'); clear();
      let started = w.started;
      assert.strictEqual((await call('GET', `drawings/${id1}/layers`, null, qs)).s, 200, 'garbled summary rebuilt');
      assert.strictEqual(w.started - started, 1);
      // an old-version summary with the .dxf gone: 409, no worker
      const stale = sha => { const v = JSON.parse(zlib.gunzipSync(fs.readFileSync(P(sha, '.summary.json.gz')))); v.version = 1; fs.writeFileSync(P(sha, '.summary.json.gz'), zlib.gzipSync(JSON.stringify(v))); };
      const id2 = await up('old gone', FIXTURE.replace('NOTE', 'NOTE-OLDGONE')), sha2 = shaOf(id2);
      stale(sha2); fs.rmSync(P(sha2, '.dxf')); clear(); started = w.started;
      const g = await call('GET', `drawings/${id2}/layers`, null, qs);
      assert.strictEqual(g.s, 409, JSON.stringify(g.j)); assert.match(g.j.error, /upload the drawing again/);
      assert.strictEqual(w.started - started, 0, 'no worker without a .dxf');
      assert.strictEqual(db.prepare('SELECT status FROM drawings WHERE id=?').get(id2).status, 'ready');
      // a transient failure (the result cannot be saved): 409 with the message, the drawing stays ready, and works once the cause is gone
      const id3 = await up('transient', FIXTURE.replace('NOTE', 'NOTE-TRANSIENT')), sha3 = shaOf(id3);
      fs.rmSync(P(sha3, '.summary.json.gz')); clear();
      const realWrite = fs.promises.writeFile;   // the disk is full while the result is saved
      fs.promises.writeFile = async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
      let t1; try { t1 = await call('GET', `drawings/${id3}/layers`, null, qs); } finally { fs.promises.writeFile = realWrite; }
      assert.strictEqual(t1.s, 409, JSON.stringify(t1.j)); assert.match(t1.j.error, /could not save the parse result \(ENOSPC\)/);
      assert.strictEqual(db.prepare('SELECT status FROM drawings WHERE id=?').get(id3).status, 'ready', 'transient: status unchanged');
      clear();
      assert.strictEqual((await call('GET', `drawings/${id3}/layers`, null, qs)).s, 200, 'recovers once the cause is gone');
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
        assert.strictEqual(st.s, 200); assert.ok(ms < LATENCY_MS, '/api/status took ' + Math.round(ms) + ' ms during a parse (cap ' + LATENCY_MS + ' ms)');
        observed++;
        if (Date.now() - t0 > 3 * WAIT_MS) throw new Error('100k parse still running after ' + 3 * WAIT_MS + ' ms');
      }
      assert.ok(observed > 0, 'no /api/status call overlapped the 100k parse');
      console.log('responsiveness: ' + observed + ' /api/status call(s) answered < ' + LATENCY_MS + ' ms during the parse');
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
      assert.deepStrictEqual(ctx.drawings.rowMeasuredQty(rowA), { qty: 7.5, unit: 'm', count: 2, units: [{ unit: 'm', qty: 7.5, count: 2 }], incomplete: false, duplicate: false });
      ins.run(id, tid, rowB, 1, 'm'); ins.run(id, tid, rowB, 1, 'm2');
      assert.deepStrictEqual(ctx.drawings.rowMeasuredQty(rowB), { qty: null, unit: null, count: 2, units: [{ unit: 'm', qty: 1, count: 1 }, { unit: 'm2', qty: 1, count: 1 }], incomplete: false, duplicate: false }, 'mixed units: never one total');
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

    // ---- Task 5: measurements from layers and blocks, linked to tender rows ---------------------------------
    {
      const SNAP = {
        work_days: 26, work_hours: 8, oh_monthly: 20000, w_monthly: 500000, months_covered: 12,
        trades: [{ trade: 'Foreman', group: 'Site', rate: 40, headcount: 1, overridden: false }], groups: [{ group: 'Site', rate: 20, headcount: 1 }],
        equipment: [], po_prices: [], unmapped: { categories: [], designations: [] }, warnings: [],
      };
      db.prepare('INSERT INTO snapshots(created,ok,error,data) VALUES(?,1,NULL,?)').run(new Date().toISOString(), JSON.stringify(SNAP));
      const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}: expected ≈${b}, got ${a}`);
      const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
      const audits = action => db.prepare("SELECT detail FROM audit_log WHERE action=? ORDER BY id").all(action).map(a => JSON.parse(a.detail));
      const ins5 = (h, x, y) => [[0, 'INSERT'], [5, h], [8, 'MH'], [2, 'MH1'], [10, x], [20, y]];
      // the Task 4 fixture plus an ASPHALT layer (one 10 m square = 100 m2) and a second MH1 insert; BOW: a 2 m square and a
      // self-intersecting bowtie (no area: excluded); CURVE: a SPLINE (approximated)
      const FIX5 = dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]),
        ...tables([layerRec('KERB'), layerRec('MH'), layerRec('ASPHALT'), layerRec('BOW'), layerRec('CURVE'), layerRec('DROP'), layerRec('DROPB'), layerRec('DUPL'), layerRec('DUPB')]),
        ...sec('BLOCKS', [[0, 'BLOCK'], [2, 'MH1'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK']]),
        ...sec('ENTITIES', [...lwp('K1', sq(0, 0, 1000), true, 'KERB'), ...line('K2', 'KERB', 0, 0, 3000, 4000), ...ins5('M1', 0, 0), ...ins5('M2', 5000, 0),
          ...lwp('A1', sq(0, 0, 10000), true, 'ASPHALT'), ...lwp('B1', sq(20000, 0, 2000), true, 'BOW'), ...lwp('B2', [[0, 20000], [1000, 21000], [1000, 20000], [0, 21000]], true, 'BOW'),
          [0, 'SPLINE'], [5, 'S1'], [8, 'CURVE'], [70, 8], [71, 1], [72, 4], [73, 2], [40, 0], [40, 0], [40, 1], [40, 1], [10, 0], [20, 0], [10, 3000], [20, 4000],
          // DROP: a 2 m square and a HATCH with a spline edge (not measured: dropped); DROPB: an MH1 insert and an MLINE (unsupported: dropped)
          ...lwp('Q1', sq(40000, 0, 2000), true, 'DROP'), [0, 'HATCH'], [5, 'QH'], [8, 'DROP'], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, 'SOLID'], [70, 1], [71, 0],
          [91, 1], [92, 1], [93, 1], [72, 4], [94, 3], [73, 0], [74, 0], [95, 8], [96, 4], [97, 0], [75, 0], [76, 1], [98, 0],
          [0, 'INSERT'], [5, 'QI'], [8, 'DROPB'], [2, 'MH1'], [10, 0], [20, 50000], [0, 'MLINE'], [5, 'QM'], [8, 'DROPB'],
          // DUPL: the same 3 m line drawn twice (possible duplicate); DUPB: two MH1 inserts at one point
          ...line('U1', 'DUPL', 0, 60000, 3000, 60000), ...line('U2', 'DUPL', 3000, 60000, 0, 60000),
          [0, 'INSERT'], [5, 'UI1'], [8, 'DUPB'], [2, 'MH1'], [10, 0], [20, 70000], [0, 'INSERT'], [5, 'UI2'], [8, 'DUPB'], [2, 'MH1'], [10, 0], [20, 70000]])]);
      const { writeXlsx } = require('./lib/xlsx.js');
      const boq = rows => ({ file_b64: writeXlsx([{ name: 'BOQ', rows: [['No', 'Description', 'Unit', 'Qty'], ...rows] }]).toString('base64'), sheet: 'BOQ', header_row: 1, cols: { no: 'A', desc: 'B', unit: 'C', qty: 'D' } });
      const BOQ = boq([['1', 'ROADS', null, null], ['1.1', 'ASPHALT surfacing', 'm2', 95], ['1.2', 'Mobilisation', 'LS', 1]]);
      const info = { title: 'Test Measured Road', client: 'Fake Client LLC', kind: 'direct', M: 4, adv_pct: 0, ret_pct: 5, collection_days: 45, retention_months: 6 };
      const T = (await ok(call('POST', 'tenders', info, qs), 'tender')).id;
      await ok(call('POST', `tenders/${T}/import`, BOQ, qs), 'import');
      const rowsOf = async (tid2) => (await ok(call('GET', `tenders/${tid2}/rows`, null, viewer), 'rows'));
      const byDesc = (rows, d) => rows.find(r => r.description === d);
      let rows = await rowsOf(T);
      const heading = byDesc(rows, 'ROADS'), asph = byDesc(rows, 'ASPHALT surfacing'), ls = byDesc(rows, 'Mobilisation');
      const newRow = async (description, unit) => (await ok(call('POST', `tenders/${T}/rows`, { description, unit }, qs), 'row ' + description)).id;
      const rM = await newRow('Kerb', 'm'), rM2 = await newRow('Kerb face', 'm2'), rNr = await newRow('Manholes', 'nr');
      const qtyOf = async id => (await rowsOf(T)).find(x => x.id === id).qty;
      const up5 = await upload(T, 'Measured plan', Buffer.from(FIX5), qs);
      assert.strictEqual(up5.s, 202);
      const D = up5.j.id;
      assert.strictEqual((await waitDone(D, qs)).status, 'ready');
      const measure = (b, ck = qs, did = D) => call('POST', `drawings/${did}/measurements`, b, ck);
      const kerb = { tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' };

      // units not confirmed → 409, nothing saved
      let r = await measure({ row_id: rM, ...kerb });
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'confirm the drawing units first');
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurements WHERE tender_id=?').get(T).n, 0);
      await ok(call('PUT', `drawings/${D}/units`, { units: 'mm' }, qs), 'units');

      // take-off row in m: KERB open_length → 5; a take-off line 2 → 7; delete the measurement → 2
      assert.strictEqual((await measure({ row_id: rM, ...kerb }, viewer)).s, 403, 'viewer cannot measure');
      const m1 = await ok(measure({ row_id: rM, ...kerb }), 'measure KERB');
      near(m1.qty, 5, 'KERB qty'); assert.strictEqual(m1.qty_unit, 'm'); near(m1.row_qty, 5, 'row qty after measuring');
      near(await qtyOf(rM), 5, 'row qty 5');
      const ma = audits('measure').at(-1);
      assert.deepStrictEqual(Object.keys(ma).sort(), ['drawing_id', 'layer', 'metric', 'qty', 'qty_unit', 'row_id', 'tool'], 'audit is a summary');
      assert.strictEqual(ma.row_id, rM); assert.strictEqual(ma.layer, 'KERB'); near(ma.qty, 5, 'audit qty');
      await ok(call('POST', `tenders/${T}/rows/${rM}/lines`, { description: 'extra', l: 2 }, qs), 'line');
      near(await qtyOf(rM), 7, 'measurement + take-off line');
      const del = await ok(call('DELETE', `measurements/${m1.id}`, null, qs), 'delete measurement');
      near(del.row_qty, 2, 'delete returns the row qty'); near(await qtyOf(rM), 2, 'measurement removed');
      assert.ok(audits('measure_delete').length === 1);
      assert.strictEqual((await call('DELETE', `measurements/${m1.id}`, null, qs)).s, 404);
      // role check before the lookup: a viewer gets 403 whether or not the id exists; GET is not served (405)
      assert.strictEqual((await call('DELETE', `measurements/${m1.id}`, null, viewer)).s, 403);
      assert.strictEqual((await call('DELETE', 'measurements/999999', null, viewer)).s, 403);
      assert.strictEqual((await call('PUT', 'measurements/999999', { row_id: rM }, viewer)).s, 403);
      assert.strictEqual((await call('GET', `measurements/${m1.id}`, null, qs)).s, 405);

      // take-off row in m2: × width 0.5 → 2.5 m2; a length (m) on it → 400, and confirm_uom cannot override a known unit
      const m2 = await ok(measure({ row_id: rM2, ...kerb, width: 0.5 }), 'width');
      near(m2.qty, 2.5, 'KERB × 0.5'); assert.strictEqual(m2.qty_unit, 'm2'); near(await qtyOf(rM2), 2.5, 'row m2');
      // the base (the layer metric before width/depth/factor) is stored for the formula shown with the measurement
      near(db.prepare('SELECT base FROM measurements WHERE id=?').get(m2.id).base, 5, 'base stored');
      near((await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list')).measurements.find(x => x.id === m2.id).base, 5, 'base listed');
      for (const extra of [{}, { confirm_uom: true }]) {
        r = await measure({ row_id: rM2, tool: 'dxf_layer', layer: 'KERB', metric: 'closed_perimeter', ...extra });
        assert.strictEqual(r.s, 400, 'known unit mismatch ' + JSON.stringify(extra)); assert.deepStrictEqual(r.j, { error: 'unit mismatch — add width/depth', row_unit: 'm2', qty_unit: 'm' });
      }
      near(await qtyOf(rM2), 2.5, 'refused: row qty unchanged');
      assert.strictEqual(audits('measure_uom_confirmed').length, 0);
      // a row unit normUom does not recognise: 409 unit mismatch unless confirm_uom (audited), then one unit only
      const rU = await newRow('Kerb (odd unit)', 'lin.ft');
      r = await measure({ row_id: rU, ...kerb });
      assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'unit mismatch', row_unit: 'lin.ft', qty_unit: 'm' });
      const m3 = await ok(measure({ row_id: rU, ...kerb, confirm_uom: true }), 'confirm_uom');
      near(m3.qty, 5, 'KERB'); assert.strictEqual(m3.qty_unit, 'm'); near(await qtyOf(rU), 5, 'confirmed measurement counts');
      assert.strictEqual(audits('measure_uom_confirmed').length, 1);
      assert.strictEqual(db.prepare('SELECT uom_confirmed FROM measurements WHERE id=?').get(m3.id).uom_confirmed, 1);
      r = await measure({ row_id: rU, tool: 'dxf_layer', layer: 'KERB', metric: 'closed_perimeter', width: 0.5, confirm_uom: true });
      assert.strictEqual(r.s, 400, 'a second unit on the row'); assert.match(r.j.error, /one unit per row/);
      near(await qtyOf(rU), 5, 'never m + m2');
      assert.strictEqual((await call('PUT', `tenders/${T}/rows/${rU}`, { unit: 'lin. ft' }, qs)).s, 409, 'an unrecognised unit text cannot change under a confirmation');

      // imported row ASPHALT m2 (client qty 95): measuring never changes qty; measured 100 → diff 5.263 %
      const p0 = await ok(call('GET', `tenders/${T}/price`, null, qs), 'price before');
      assert.deepStrictEqual(p0.measure_warnings, []);
      const ma1 = await ok(measure({ row_id: asph.id, tool: 'dxf_layer', layer: 'ASPHALT', metric: 'area' }), 'asphalt area');
      near(ma1.qty, 100, 'asphalt area'); assert.strictEqual(ma1.qty_unit, 'm2'); assert.strictEqual(ma1.row_qty, null, 'imported row: qty not recomputed');
      const va = (await rowsOf(T)).find(x => x.id === asph.id);
      assert.strictEqual(va.qty, 95, 'client qty unchanged');
      near(va.measured_qty, 100, 'measured_qty'); assert.strictEqual(va.measured_unit, 'm2');
      assert.ok(Math.abs(va.measured_diff_pct - 5.263157894736842) < 1e-6, 'diff ' + va.measured_diff_pct); assert.strictEqual(va.measure_diff, true);
      const p1 = await ok(call('GET', `tenders/${T}/price`, null, qs), 'price after');
      assert.strictEqual(p1.measure_warnings.length, 1); assert.strictEqual(p1.measure_warnings[0].row_id, asph.id);
      assert.ok(Math.abs(p1.measure_warnings[0].diff_pct - 5.263157894736842) < 1e-6);
      assert.deepStrictEqual(p1.blocking, p0.blocking, 'measure warnings never block');
      assert.ok(!p1.blocking.some(b => /measure/.test(b.code)));
      assert.strictEqual(p1.rows.find(x => x.id === asph.id).qty, 95, 'priced on the client qty');

      // block row nr: MH1 count → 2; width on a count → 400
      const mh = { tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count' };
      assert.strictEqual((await measure({ row_id: rNr, ...mh, width: 2 })).s, 400, 'width on a count');
      const mb = await ok(measure({ row_id: rNr, ...mh }), 'blocks');
      assert.strictEqual(mb.qty, 2); assert.strictEqual(mb.qty_unit, 'nr'); assert.strictEqual(await qtyOf(rNr), 2);
      // overlap: the same link twice → 409; nested on the same block also counts the top inserts again → 409; confirm_overlap doubles, audited
      r = await measure({ row_id: rNr, ...mh });
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'already measured on this row');
      assert.strictEqual((await measure({ row_id: rNr, ...mh, nested: true })).s, 409, 'nested re-counts the top inserts');
      assert.strictEqual(await qtyOf(rNr), 2, 'refused overlap: qty unchanged');
      assert.strictEqual(audits('measure_overlap_confirmed').length, 0);
      await ok(measure({ row_id: rNr, ...mh, confirm_overlap: true }), 'confirm_overlap');
      assert.strictEqual(await qtyOf(rNr), 4, 'confirmed overlap doubles');
      assert.strictEqual(audits('measure_overlap_confirmed').length, 1);
      // the same file uploaded again is the same geometry: linking it to the same row is an overlap too
      const upB = await upload(T, 'Measured plan again', Buffer.from(FIX5), qs);
      assert.strictEqual((await waitDone(upB.j.id, qs)).status, 'ready');
      await ok(call('PUT', `drawings/${upB.j.id}/units`, { units: 'mm' }, qs), 'units B');
      assert.strictEqual((await measure({ row_id: rM2, ...kerb, width: 0.5 }, qs, upB.j.id)).s, 409, 'same sha256 → overlap');

      // a layer total that leaves shapes out (bowtie: no area) or approximates curves (SPLINE): 409 unless confirm_incomplete
      {
        const lyr = (await ok(call('GET', `drawings/${D}/layers`, null, qs), 'layers')).layers;
        assert.strictEqual(lyr.find(l => l.layer === 'BOW').area_excluded, 1); assert.ok(lyr.find(l => l.layer === 'CURVE').approx > 0);
        const rA = await newRow('Paving', 'm2'), rC = await newRow('Edge', 'm');
        r = await measure({ row_id: rA, tool: 'dxf_layer', layer: 'BOW', metric: 'area' });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'layer quantity is incomplete', area_excluded: 1, approx: 0, dropped: 0 });
        assert.strictEqual(await qtyOf(rA), 0, 'refused: nothing saved');
        assert.strictEqual(audits('measure_incomplete_confirmed').length, 0);
        const bi = await ok(measure({ row_id: rA, tool: 'dxf_layer', layer: 'BOW', metric: 'area', confirm_incomplete: true }), 'confirm_incomplete area');
        near(bi.qty, 4, 'the square only'); assert.strictEqual(bi.incomplete, true); near(await qtyOf(rA), 4, 'row qty');
        // the perimeter of the same layer is complete (no approximation): no confirmation needed
        const bp = await ok(measure({ row_id: rC, tool: 'dxf_layer', layer: 'BOW', metric: 'closed_perimeter' }), 'perimeter');
        assert.strictEqual(bp.incomplete, false);
        r = await measure({ row_id: rC, tool: 'dxf_layer', layer: 'CURVE', metric: 'open_length' });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'layer quantity is incomplete'); assert.strictEqual(r.j.area_excluded, 0); assert.ok(r.j.approx > 0);
        const ci = await ok(measure({ row_id: rC, tool: 'dxf_layer', layer: 'CURVE', metric: 'open_length', confirm_incomplete: true }), 'confirm_incomplete spline');
        near(ci.qty, 5, 'spline length');
        const ia = audits('measure_incomplete_confirmed');
        assert.strictEqual(ia.length, 2);
        assert.deepStrictEqual(ia[0], { drawing_id: D, row_id: rA, layer: 'BOW', metric: 'area', area_excluded: 1, approx: 0, dropped: 0 }, 'counts only');
        const vr = await rowsOf(T);
        assert.strictEqual(vr.find(x => x.id === rA).measured_incomplete, true); assert.strictEqual(vr.find(x => x.id === rC).measured_incomplete, true);
        assert.strictEqual(vr.find(x => x.id === rM2).measured_incomplete, false);
        const il = (await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list')).measurements;
        assert.strictEqual(il.find(x => x.id === bi.id).incomplete, 1); assert.strictEqual(il.find(x => x.id === bp.id).incomplete, 0);
        // relink keeps the flag
        const rA2 = await newRow('Paving 2', 'm2');
        await ok(call('PUT', `measurements/${bi.id}`, { row_id: rA2 }, qs), 'relink incomplete');
        assert.strictEqual(db.prepare('SELECT incomplete FROM measurements WHERE id=?').get(bi.id).incomplete, 1);
        assert.strictEqual((await rowsOf(T)).find(x => x.id === rA2).measured_incomplete, true);
        // shapes on the layer that were not measured (dropped): every metric, a block count too, needs confirm_incomplete
        const dl = lyr.find(l => l.layer === 'DROP'), db2 = lyr.find(l => l.layer === 'DROPB');
        assert.strictEqual(dl.dropped, 1); near(dl.area, 4, 'DROP area: the square only'); assert.strictEqual(dl.area_excluded, 0); assert.strictEqual(dl.approx, 0);
        assert.strictEqual(db2.dropped, 1); assert.deepStrictEqual(db2.blocks, [{ name: 'MH1', top: 1, nested: 0 }]);
        assert.strictEqual(lyr.find(l => l.layer === 'KERB').dropped, 0);
        const rNr2 = await newRow('Manholes (drop)', 'nr');
        for (const [rowId, b] of [[rA, { tool: 'dxf_layer', layer: 'DROP', metric: 'area' }], [rC, { tool: 'dxf_layer', layer: 'DROP', metric: 'closed_perimeter' }],
          [rNr2, { tool: 'dxf_blocks', layer: 'DROPB', block: 'MH1', metric: 'count' }]]) {
          r = await measure({ row_id: rowId, ...b });
          assert.strictEqual(r.s, 409, 'dropped ' + b.metric); assert.deepStrictEqual(r.j, { error: 'layer quantity is incomplete', area_excluded: 0, approx: 0, dropped: 1 }, b.metric);
        }
        const before3 = await qtyOf(rA);
        const dd = await ok(measure({ row_id: rA, tool: 'dxf_layer', layer: 'DROP', metric: 'area', confirm_incomplete: true }), 'confirm dropped');
        near(dd.qty, 4, 'DROP area'); assert.strictEqual(dd.incomplete, true); near(await qtyOf(rA), before3 + 4, 'row qty');
        const dc = await ok(measure({ row_id: rNr2, tool: 'dxf_blocks', layer: 'DROPB', block: 'MH1', metric: 'count', confirm_incomplete: true }), 'confirm dropped count');
        assert.strictEqual(dc.qty, 1); assert.strictEqual(dc.incomplete, true);
        assert.deepStrictEqual(audits('measure_incomplete_confirmed').slice(-2), [{ drawing_id: D, row_id: rA, layer: 'DROP', metric: 'area', area_excluded: 0, approx: 0, dropped: 1 },
          { drawing_id: D, row_id: rNr2, layer: 'DROPB', metric: 'count', area_excluded: 0, approx: 0, dropped: 1 }]);
        assert.strictEqual((await rowsOf(T)).find(x => x.id === rNr2).measured_incomplete, true);
        for (const id of [dd.id, dc.id]) await ok(call('DELETE', `measurements/${id}`, null, qs), 'tidy');
        await ok(call('DELETE', `tenders/${T}/rows/${rNr2}`, null, qs), 'tidy row');
        // tidy up: these rows are not part of the checks below
        for (const id of [bi.id, bp.id, ci.id]) await ok(call('DELETE', `measurements/${id}`, null, qs), 'tidy');
        for (const id of [rA, rA2, rC]) await ok(call('DELETE', `tenders/${T}/rows/${id}`, null, qs), 'tidy row');
      }

      // refusals: LS, heading, another tender's row, bad numbers, unknown fields, unknown layer/block
      const LS = await measure({ row_id: ls.id, ...kerb });
      assert.strictEqual(LS.s, 400, 'LS row'); assert.match(LS.j.error, /lump/i);
      assert.strictEqual((await measure({ row_id: heading.id, ...kerb })).s, 400, 'heading');
      assert.strictEqual((await measure({ row_id: 999999, ...kerb })).s, 400, 'missing row');
      const other = (await ok(call('POST', 'tenders', info, qs), 'other')).id;
      const oRow = (await ok(call('POST', `tenders/${other}/rows`, { description: 'Other kerb', unit: 'm' }, qs), 'other row')).id;
      assert.strictEqual((await measure({ row_id: oRow, ...kerb })).s, 400, "another tender's row");
      for (const bad of [{ width: 0 }, { width: -1 }, { width: 1e6 + 1 }, { width: '0.5' }, { factor: 0 }, { factor: 'x' }, { factor: 1e7 }, { depth: 0.2 }, { nested: true }, { block: 'MH1' },
        { metric: 'count' }, { layer: 'NOPE' }, { tool: 'dxf_selection' }, { metric: 'volume' }, { extra: 1 }, { confirm_uom: 'yes' }])
        assert.strictEqual((await measure({ row_id: rM, ...kerb, ...bad })).s, 400, 'bad ' + JSON.stringify(bad));
      assert.strictEqual((await measure({ row_id: rNr, ...mh, block: 'NOPE' })).s, 400, 'unknown block');
      assert.strictEqual((await measure({ row_id: rM2, ...kerb, width: 0.5, depth: 0.2, confirm_overlap: true, confirm_uom: true })).s, 400, 'm3 on an m2 row → unit mismatch');
      // the quantity is capped like an imported qty (1e12): 5 m × 1e6 × 1e6 = 5e12 → 400; 5e11 → saved
      r = await measure({ row_id: rM2, ...kerb, width: 1e6, factor: 1e6, confirm_overlap: true });
      assert.strictEqual(r.s, 400, 'qty over 1e12'); assert.match(r.j.error, /at most 1000000000000/);
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurements WHERE qty > 1e12').get().n, 0);
      const capped = await ok(measure({ row_id: rM2, ...kerb, width: 1e6, factor: 1e5, confirm_overlap: true }), 'qty under 1e12');
      assert.ok(Math.abs(capped.qty - 5e11) < 1, 'under the cap ' + capped.qty); await ok(call('DELETE', `measurements/${capped.id}`, null, qs), 'tidy');
      assert.strictEqual(await qtyOf(rM), 2, 'refusals saved nothing');

      // a row with measurements: delete → 409; its unit cannot change; it cannot become a heading
      r = await call('DELETE', `tenders/${T}/rows/${rNr}`, null, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'remove its measurements first');
      assert.strictEqual((await call('PUT', `tenders/${T}/rows/${rNr}`, { unit: 'm' }, qs)).s, 409, 'unit change with measurements');
      assert.strictEqual((await call('PUT', `tenders/${T}/rows/${asph.id}`, { qty: '' }, qs)).s, 409, 'heading with measurements');
      assert.strictEqual((await call('PUT', `tenders/${T}/rows/${rNr}`, { description: 'Manholes type A' }, qs)).s, 200, 'other edits allowed');

      // re-import: the imported row's measurement is kept, unlinked, and listed as unlinked
      const ri = await ok(call('POST', `tenders/${T}/import`, BOQ, qs), 're-import');
      assert.strictEqual(ri.measurements_unlinked, 1);
      assert.strictEqual(db.prepare('SELECT row_id FROM measurements WHERE id=?').get(ma1.id).row_id, null);
      let ml = await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list');
      assert.deepStrictEqual(ml.unlinked.map(x => x.id), [ma1.id]);
      assert.ok(!ml.measurements.some(x => x.id === ma1.id) && ml.measurements.length === 4);
      assert.deepStrictEqual((await ok(call('GET', `tenders/${T}/price`, null, qs), 'price')).measure_warnings, [], 'unlinked: no warning');
      // relink: the same validation as create; both rows recomputed
      rows = await rowsOf(T);
      const asph2 = byDesc(rows, 'ASPHALT surfacing');
      for (const extra of [{}, { confirm_uom: true }]) {
        r = await call('PUT', `measurements/${ma1.id}`, { row_id: rM, ...extra }, qs);
        assert.strictEqual(r.s, 400, 'relink: known unit mismatch'); assert.strictEqual(r.j.error, 'unit mismatch — add width/depth');
      }
      assert.strictEqual(db.prepare('SELECT row_id FROM measurements WHERE id=?').get(ma1.id).row_id, null);
      assert.strictEqual((await call('PUT', `measurements/${ma1.id}`, { row_id: byDesc(rows, 'Mobilisation').id }, qs)).s, 400, 'relink: LS');
      assert.strictEqual((await call('PUT', `measurements/${ma1.id}`, { row_id: asph2.id }, viewer)).s, 403);
      await ok(call('PUT', `measurements/${ma1.id}`, { row_id: asph2.id }, qs), 'relink');
      assert.strictEqual((await rowsOf(T)).find(x => x.id === asph2.id).measure_diff, true);
      assert.strictEqual(audits('measure_relink').at(-1).row_id, asph2.id);
      // moving a take-off measurement recomputes both rows
      const rM2b = await newRow('Kerb face 2', 'm2');
      await ok(call('PUT', `measurements/${m2.id}`, { row_id: rM2b }, qs), 'move m2 → other m2 row');
      near(await qtyOf(rM2), 0, 'old row recomputed'); near(await qtyOf(rM2b), 2.5, 'new row recomputed');
      // overlap on relink: the same link already on the target row → 409; confirm_overlap moves it, audited
      const dup = await ok(measure({ row_id: rM2, ...kerb, width: 0.5 }), 'same link on rM2');
      const overBefore = audits('measure_overlap_confirmed').length;
      r = await call('PUT', `measurements/${dup.id}`, { row_id: rM2b }, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'already measured on this row');
      near(await qtyOf(rM2b), 2.5, 'refused relink: qty unchanged');
      await ok(call('PUT', `measurements/${dup.id}`, { row_id: rM2b, confirm_overlap: true }, qs), 'relink confirm_overlap');
      assert.strictEqual(audits('measure_overlap_confirmed').length, overBefore + 1);
      assert.strictEqual(audits('measure_overlap_confirmed').at(-1).row_id, rM2b);
      near(await qtyOf(rM2b), 5, 'confirmed overlap'); near(await qtyOf(rM2), 0, 'source row');
      await ok(call('PUT', `measurements/${m2.id}`, { row_id: rM2 }, qs), 'move back');
      near(await qtyOf(rM2), 2.5, 'back'); near(await qtyOf(rM2b), 2.5, 'back');
      // a negative total through a measurement path → 400, rolled back (qty and link unchanged)
      {
        const rN = await newRow('Kerb net', 'm');
        const mn = await ok(measure({ row_id: rN, ...kerb }), 'measure net');
        const dl = await ok(call('POST', `tenders/${T}/rows/${rN}/lines`, { description: 'gap', l: 3, deduct: true }, qs), 'deduct line');
        near(dl.row_qty, 2, '5 − 3');
        r = await call('DELETE', `measurements/${mn.id}`, null, qs);
        assert.strictEqual(r.s, 400); assert.match(r.j.error, /deductions exceed/);
        r = await call('PUT', `measurements/${mn.id}`, { row_id: rM }, qs);
        assert.strictEqual(r.s, 400, 'relink leaving −3'); assert.match(r.j.error, /deductions exceed/);
        near(await qtyOf(rN), 2, 'rolled back'); near(await qtyOf(rM), 2, 'target unchanged');
        assert.strictEqual(db.prepare('SELECT row_id FROM measurements WHERE id=?').get(mn.id).row_id, rN, 'measurement still present and linked');
        // a take-off line DELETE goes through the same recompute: lines + measurements
        near((await ok(call('DELETE', `tenders/${T}/rows/${rN}/lines/${dl.id}`, null, qs), 'line delete')).row_qty, 5, 'line delete keeps the measurement');
        near(await qtyOf(rN), 5, 'line delete');
        await ok(call('DELETE', `measurements/${mn.id}`, null, qs), 'tidy');
        await ok(call('DELETE', `tenders/${T}/rows/${rN}`, null, qs), 'tidy row');
      }
      // a row PUT never writes back a stale qty: a measurement committed while its body was being read is kept
      {
        const port = server.address().port;
        const slowPut = (u, body, ck, between) => new Promise((res2, rej) => {
          const data = Buffer.from(JSON.stringify(body));
          const q = http.request({ port, method: 'PUT', path: '/api/' + u, headers: { cookie: ck, 'Content-Type': 'application/json', 'Content-Length': data.length } }, rs => {
            let b = ''; rs.on('data', c => b += c); rs.on('end', () => res2({ s: rs.statusCode, j: JSON.parse(b) }));
          });
          q.on('error', rej);
          q.write(data.subarray(0, 5));   // the server has read the row and waits for the rest of the body
          setTimeout(() => { try { between(); q.end(data.subarray(5)); } catch (e) { rej(e); } }, 200);
        });
        near(await qtyOf(rM), 2, 'line only');
        let injected;
        const pr = await slowPut(`tenders/${T}/rows/${rM}`, { description: 'Kerb renamed' }, qs, () => {
          // what a measurement write does, committed in between
          injected = Number(db.prepare("INSERT INTO measurements(drawing_id,tender_id,row_id,tool,layer,metric,qty,qty_unit,created,created_by) VALUES(?,?,?,'dxf_layer','KERB','open_length',5,'m','x','qs1')").run(D, T, rM).lastInsertRowid);
          db.prepare('UPDATE tender_rows SET qty=7 WHERE id=?').run(rM);
        });
        assert.strictEqual(pr.s, 200, JSON.stringify(pr.j));
        assert.strictEqual(pr.j.description, 'Kerb renamed'); near(pr.j.qty, 7, 'qty not overwritten with the stale 2');
        near(await qtyOf(rM), 7, 'lines + measurement');
        near((await ok(call('DELETE', `measurements/${injected}`, null, qs), 'tidy')).row_qty, 2, 'tidy');
      }
      // possible duplicates on the source layer (or block): 409 unless confirm_duplicate; stored, audited, shown, carried on relink
      {
        const rD = await newRow('Dup kerb', 'm'), rD2 = await newRow('Dup kerb 2', 'm'), rDn = await newRow('Dup manholes', 'nr');
        const dupl = { tool: 'dxf_layer', layer: 'DUPL', metric: 'open_length' }, dupb = { tool: 'dxf_blocks', layer: 'DUPB', block: 'MH1', metric: 'count' };
        r = await measure({ row_id: rD, ...dupl });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'possible duplicates on this layer', duplicates: 1 });
        r = await measure({ row_id: rDn, ...dupb });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'possible duplicates on this layer', duplicates: 1 }, 'block');
        assert.strictEqual(await qtyOf(rD), 0, 'refused: nothing saved'); assert.strictEqual(audits('measure_duplicate_confirmed').length, 0);
        const md = await ok(measure({ row_id: rD, ...dupl, confirm_duplicate: true }), 'confirm_duplicate');
        near(md.qty, 6, 'both lines counted (never merged)'); near(await qtyOf(rD), 6, 'row qty');
        const mdb = await ok(measure({ row_id: rDn, ...dupb, confirm_duplicate: true }), 'confirm_duplicate block');
        assert.strictEqual(mdb.qty, 2);
        assert.strictEqual(db.prepare('SELECT duplicate FROM measurements WHERE id=?').get(md.id).duplicate, 1);
        assert.deepStrictEqual(audits('measure_duplicate_confirmed'), [{ drawing_id: D, row_id: rD, layer: 'DUPL', metric: 'open_length', duplicates: 1 },
          { drawing_id: D, row_id: rDn, layer: 'DUPB', block: 'MH1', metric: 'count', duplicates: 1 }], 'counts only');
        // a layer without duplicates needs no confirmation and is not flagged
        const vr = await rowsOf(T);
        assert.strictEqual(vr.find(x => x.id === rD).measured_duplicate, true); assert.strictEqual(vr.find(x => x.id === rM2).measured_duplicate, false);
        const dl = (await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list')).measurements;
        assert.strictEqual(dl.find(x => x.id === md.id).duplicate, 1); assert.strictEqual(dl.find(x => x.id === m2.id).duplicate, 0);
        // relink keeps the flag; the measurement stays for the revision below
        await ok(call('PUT', `measurements/${md.id}`, { row_id: rD2 }, qs), 'relink duplicate');
        assert.strictEqual(db.prepare('SELECT duplicate FROM measurements WHERE id=?').get(md.id).duplicate, 1);
        assert.strictEqual((await rowsOf(T)).find(x => x.id === rD2).measured_duplicate, true);
        await ok(call('DELETE', `measurements/${mdb.id}`, null, qs), 'tidy');
        for (const id of [rD, rDn]) await ok(call('DELETE', `tenders/${T}/rows/${id}`, null, qs), 'tidy row');
      }
      // a second re-import leaves it unlinked for the revision below
      assert.strictEqual((await ok(call('POST', `tenders/${T}/import`, BOQ, qs), 're-import 2')).measurements_unlinked, 1);

      // deleting a draft tender deletes its drawings and measurements rows (the shared file stays)
      {
        const T6 = (await ok(call('POST', 'tenders', info, qs), 't6')).id;
        const r6 = (await ok(call('POST', `tenders/${T6}/rows`, { description: 'Kerb', unit: 'm' }, qs), 'r6')).id;
        const u6 = await upload(T6, 'plan', Buffer.from(FIX5), qs);
        assert.strictEqual((await waitDone(u6.j.id, qs)).status, 'ready');
        await ok(call('PUT', `drawings/${u6.j.id}/units`, { units: 'mm' }, qs), 'units 6');
        await ok(measure({ row_id: r6, ...kerb }, qs, u6.j.id), 'measure 6');
        const sha = db.prepare('SELECT sha256 FROM drawings WHERE id=?').get(u6.j.id).sha256;
        await ok(call('DELETE', `tenders/${T6}`, null, qs), 'delete tender');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE tender_id=?').get(T6).n, 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurements WHERE tender_id=?').get(T6).n, 0);
        assert.ok(fs.existsSync(path.join(DDIR, sha + '.dxf')), 'the shared file stays');
      }

      // submit, approve; the frozen price never carries live measured data; writes → 409
      rows = await rowsOf(T);
      for (const x of rows.filter(x => !x.is_heading)) await ok(call('PUT', `tenders/${T}/rows/${x.id}`, { manual_unit: 10 }, qs), 'manual unit');
      for (const h of (await call('GET', `tenders/${T}/hidden`, null, qs)).j) await ok(call('PUT', `tenders/${T}/hidden/${h.id}`, { status: 'na' }, qs), 'hidden');
      await ok(call('POST', `tenders/${T}/submit`, null, qs), 'submit');
      assert.strictEqual((await measure({ row_id: rM, ...kerb })).s, 409, 'submitted → 409');
      const shown = await ok(call('GET', `tenders/${T}/price`, null, admin), 'price shown');
      assert.deepStrictEqual(shown.blocking, []);
      await ok(call('POST', `tenders/${T}/approve`, { expected_P: shown.result.P }, admin), 'approve');
      const before = db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(T).map(x => ({ ...x }));
      const fp = await ok(call('GET', `tenders/${T}/price`, null, qs), 'frozen price');
      assert.deepStrictEqual(Object.keys(fp).sort(), ['frozen', 'status', 'tender_id'], 'frozen response unchanged');
      assert.ok(!JSON.stringify(fp).includes('measure'));
      r = await measure({ row_id: rM, tool: 'dxf_layer', layer: 'ASPHALT', metric: 'area', confirm_uom: true });
      assert.strictEqual(r.s, 409, 'approved → POST 409');
      assert.strictEqual((await call('DELETE', `measurements/${m2.id}`, null, qs)).s, 409, 'approved → DELETE 409');
      assert.strictEqual((await call('PUT', `measurements/${ma1.id}`, { row_id: rM }, qs)).s, 409, 'approved → PUT 409');

      // revise: the Rev gets the drawings (same sha256) and the measurements on its own row ids; the original is unchanged
      const rv = await ok(call('POST', `tenders/${T}/revise`, null, qs), 'revise');
      const odr = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(T), ndr = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(rv.id);
      assert.strictEqual(ndr.length, odr.length);
      ndr.forEach((x, i) => { assert.strictEqual(x.sha256, odr[i].sha256); assert.strictEqual(x.units, odr[i].units); assert.strictEqual(x.status, odr[i].status); assert.notStrictEqual(x.id, odr[i].id); });
      const oRows = await rowsOf(T), nRows = await rowsOf(rv.id);
      const seqOf = new Map(oRows.map(x => [x.id, x.seq])), nBySeq = new Map(nRows.map(x => [x.seq, x.id]));
      const nm = db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(rv.id);
      assert.strictEqual(nm.length, before.length);
      nm.forEach((x, i) => {
        const o = before[i];
        assert.strictEqual(x.drawing_id, ndr[odr.findIndex(d => d.id === o.drawing_id)].id, 'drawing remapped');
        assert.strictEqual(x.row_id, o.row_id === null ? null : nBySeq.get(seqOf.get(o.row_id)), 'row remapped');
        for (const k of ['tool', 'layer', 'block', 'metric', 'nested', 'width', 'depth', 'factor', 'qty', 'qty_unit', 'uom_confirmed', 'incomplete', 'duplicate', 'base']) assert.strictEqual(x[k], o[k], k);
      });
      assert.ok(nm.some(x => x.duplicate === 1), 'the duplicate flag is carried into the Rev');
      assert.ok(nm.some(x => x.base === 5), 'the base is carried into the Rev');
      assert.strictEqual(nm.filter(x => x.row_id === null).length, 1, 'an unlinked measurement stays unlinked');
      assert.deepStrictEqual(db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(T).map(x => ({ ...x })), before, 'original measurements unchanged');
      for (const o of oRows) assert.strictEqual(nRows.find(x => x.seq === o.seq).qty, o.qty, 'Rev row qty = original');
      // the Rev is a draft: its measurements work and recompute its own rows only
      const nM = nBySeq.get(seqOf.get(rM));
      const del2 = await ok(call('DELETE', `measurements/${nm.find(x => x.row_id === nBySeq.get(seqOf.get(rU))).id}`, null, qs), 'rev delete');
      near(del2.row_qty, 0, 'rev row recomputed'); near(await qtyOf(rU), 5, 'original row untouched');
      assert.ok(nM);
      assert.ok(audits('revise').at(-1).measurements_copied === before.length);
      // a drawing copied while it is still parsing gets its own parse in the Rev
      {
        const X = (await ok(call('POST', 'tenders', info, qs), 'x')).id;
        const sha = odr[0].sha256;
        const px = Number(db.prepare("INSERT INTO drawings(tender_id,name,sha256,bytes,status,created) VALUES(?,'still parsing',?,1,'parsing','x')").run(X, sha).lastInsertRowid);
        db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(X);   // as if approved while the parse ran (uploads need a draft)
        const rx = await ok(call('POST', `tenders/${X}/revise`, null, qs), 'revise x');
        const copy = db.prepare('SELECT id, status FROM drawings WHERE tender_id=?').all(rx.id);
        assert.strictEqual(copy.length, 1); assert.strictEqual(copy[0].status, 'parsing', 'copied as parsing');
        const fin = await waitDone(copy[0].id, qs);
        assert.strictEqual(fin.status, 'ready', fin.error); assert.strictEqual(fin.suggested_units, 'mm'); assert.strictEqual(fin.sha256, sha);
        assert.strictEqual(db.prepare('SELECT status FROM drawings WHERE id=?').get(px).status, 'parsing', 'the original row is not touched by the copy');
      }

      // ---- batch 2 Task 3: a selection of DXF entities (by handle) measured and linked to a row ----------------
      {
        const TS = (await ok(call('POST', 'tenders', info, qs), 'selection tender')).id;
        const rowS = async (description, unit) => (await ok(call('POST', `tenders/${TS}/rows`, { description, unit }, qs), 'row ' + description)).id;
        const qtyS = async id => (await ok(call('GET', `tenders/${TS}/rows`, null, viewer), 'rows')).find(x => x.id === id).qty;
        const nMeas = () => db.prepare('SELECT COUNT(*) n FROM measurements WHERE tender_id=?').get(TS).n;
        const handlesOf = id => db.prepare('SELECT handle FROM measurement_handles WHERE measurement_id=? ORDER BY rowid').all(id).map(x => x.handle);
        const us = await upload(TS, 'Selection plan', Buffer.from(FIX5), qs);
        assert.strictEqual(us.s, 202);
        const DS = us.j.id;
        assert.strictEqual((await waitDone(DS, qs)).status, 'ready');
        const sel = (b, ck = qs, did = DS) => call('POST', `drawings/${did}/measurements`, { tool: 'dxf_selection', ...b }, ck);
        const lay = b => call('POST', `drawings/${DS}/measurements`, b, qs);
        const rK = await rowS('Kerb (selection)', 'm');
        let r = await sel({ row_id: rK, handles: ['K2'], metric: 'open_length' });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'confirm the drawing units first');
        await ok(call('PUT', `drawings/${DS}/units`, { units: 'mm' }, qs), 'units');
        assert.strictEqual((await sel({ row_id: rK, handles: ['K2'], metric: 'open_length' }, viewer)).s, 403, 'viewer cannot measure');
        // a drawing that is not ready → 409
        db.prepare("UPDATE drawings SET status='failed' WHERE id=?").run(DS);
        r = await sel({ row_id: rK, handles: ['K2'], metric: 'open_length' });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'drawing is failed: nothing to measure yet');
        db.prepare("UPDATE drawings SET status='ready' WHERE id=?").run(DS);

        // validation: 400 and nothing saved
        for (const [b, msg] of [[{ handles: ['K2', 'K2'] }, /^duplicate handle in selection$/], [{ handles: ['K2', 'NOPE'] }, /^selection contains entities not in this drawing$/],
          [{ handles: ['K2'], metric: 'count' }, /^nothing in the selection can be measured as count$/], [{ handles: [] }, /handles/], [{ handles: 'K2' }, /handles/], [{ handles: [7] }, /handles/],
          [{ handles: [''] }, /handles/], [{ handles: ['K2'], layer: 'KERB' }, /layer/], [{ handles: ['K2'], metric: 'volume' }, /metric/], [{ handles: ['M1'], metric: 'count', width: 1 }, /width/],
          [{ handles: ['K2'], block: 'MH1' }, /block/], [{ handles: new Array(200001).fill(0).map((_, i) => 'Z' + i) }, /handles/]]) {
          r = await sel({ row_id: rK, metric: 'open_length', ...b });
          assert.strictEqual(r.s, 400, JSON.stringify(b).slice(0, 80)); assert.match(r.j.error, msg);
        }
        assert.strictEqual(nMeas(), 0, 'refusals saved nothing');

        // one KERB line (5 m) onto a take-off row in m → 5
        const s1 = await ok(sel({ row_id: rK, handles: ['K2'], metric: 'open_length' }), 'select K2');
        near(s1.qty, 5, 'K2'); assert.strictEqual(s1.qty_unit, 'm'); near(s1.row_qty, 5, 'row qty'); near(await qtyS(rK), 5, 'row');
        assert.strictEqual(s1.skipped, 0, 'skipped in the response');
        const m1 = db.prepare('SELECT * FROM measurements WHERE id=?').get(s1.id);
        assert.deepStrictEqual([m1.tool, m1.layer, m1.block, m1.metric, m1.handles_count, m1.incomplete, m1.duplicate, m1.uom_confirmed], ['dxf_selection', null, null, 'open_length', 1, 0, 0, 0]);
        near(m1.base, 5, 'base stored in metres');
        assert.deepStrictEqual(JSON.parse(m1.selection_summary), { metric: 'open_length', by_layer: { KERB: 1 }, skipped: 0 });
        assert.deepStrictEqual(handlesOf(s1.id), ['K2']);
        assert.ok(db.prepare('SELECT geom_key FROM measurement_handles WHERE measurement_id=?').get(s1.id).geom_key, 'the geomKey is stored with the handle');
        assert.deepStrictEqual(audits('measure').at(-1), { drawing_id: DS, row_id: rK, tool: 'dxf_selection', metric: 'open_length', used: 1, qty: s1.qty, qty_unit: 'm' }, 'audit: counts, never handles');
        // listed with handles_count and the summary, never the handle list; GET handles for the viewer
        const li = (await ok(call('GET', `tenders/${TS}/measurements`, null, viewer), 'list')).measurements.find(x => x.id === s1.id);
        assert.strictEqual(li.handles_count, 1); assert.deepStrictEqual(li.selection_summary, { metric: 'open_length', by_layer: { KERB: 1 }, skipped: 0 }); assert.ok(!('handles' in li));
        assert.deepStrictEqual(await ok(call('GET', `measurements/${s1.id}/handles`, null, viewer), 'handles'), { id: s1.id, count: 1, handles: ['K2'] });
        assert.strictEqual((await call('GET', 'measurements/999999/handles', null, viewer)).s, 404);
        assert.strictEqual((await call('GET', `measurements/${s1.id}/handles`, null, '')).s, 401);

        // the same handle again on the row → 409 already measured; confirmed → saved and audited
        r = await sel({ row_id: rK, handles: ['K2'], metric: 'open_length' });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'already measured on this row', dropped: 0, area_null: 0, approx: 0, duplicates: 0, overlapping: 1 });
        // the length family: closed_perimeter of the same handles is still a length on the same row (K2 is open: nothing to measure)
        assert.strictEqual(nMeas(), 1);
        const ov0 = audits('measure_overlap_confirmed').length;
        const s2 = await ok(sel({ row_id: rK, handles: ['K2'], metric: 'open_length', confirm_overlap: true }), 'confirm overlap');
        near(await qtyS(rK), 10, 'counted twice once confirmed');
        assert.deepStrictEqual(audits('measure_overlap_confirmed').slice(ov0), [{ drawing_id: DS, row_id: rK, tool: 'dxf_selection', metric: 'open_length', used: 1, qty: s2.qty, qty_unit: 'm', overlaps: 1 }]);
        // delete → its handles are gone too
        await ok(call('DELETE', `measurements/${s2.id}`, null, qs), 'delete s2');
        assert.deepStrictEqual(handlesOf(s2.id), []); near(await qtyS(rK), 5, 'row after delete');
        assert.deepStrictEqual(audits('measure_delete').at(-1), { drawing_id: DS, row_id: rK, tool: 'dxf_selection', metric: 'open_length', used: 1, qty: s2.qty, qty_unit: 'm' });

        // part of a layer already linked to the row by a dxf_layer measurement (same metric family, same file) → 409
        const rL = await rowS('Kerb (layer)', 'm');
        const ml = await ok(lay({ row_id: rL, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' }), 'layer KERB');
        r = await sel({ row_id: rL, handles: ['K2'], metric: 'open_length' });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'already measured on this row', dropped: 0, area_null: 0, approx: 0, duplicates: 0, overlapping: 1 });
        r = await sel({ row_id: rL, handles: ['K1'], metric: 'closed_perimeter' });
        assert.strictEqual(r.s, 409, 'closed_perimeter is in the length family'); assert.strictEqual(r.j.error, 'already measured on this row');
        // another layer on that row is no overlap
        const sa = await ok(sel({ row_id: rL, handles: ['A1'], metric: 'closed_perimeter' }), 'ASPHALT perimeter');
        near(sa.qty, 40, 'A1 perimeter');
        const ovL = audits('measure_overlap_confirmed').length;
        const s3 = await ok(sel({ row_id: rL, handles: ['K2'], metric: 'open_length', confirm_overlap: true }), 'confirmed overlap with layer');
        assert.strictEqual(audits('measure_overlap_confirmed').length, ovL + 1); assert.strictEqual(audits('measure_overlap_confirmed').at(-1).row_id, rL);
        // the other way round: a layer measurement onto a row whose selection already covers that layer → 409
        r = await lay({ row_id: rK, tool: 'dxf_layer', layer: 'KERB', metric: 'closed_perimeter' });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'already measured on this row' });
        assert.strictEqual((await lay({ row_id: rK, tool: 'dxf_layer', layer: 'KERB', metric: 'area', width: undefined })).s, 400, 'area on an m row: unit first');
        for (const id of [s3.id, sa.id, ml.id]) await ok(call('DELETE', `measurements/${id}`, null, qs), 'tidy');

        // blocks: a dxf_blocks count of MH1 on MH overlaps a selected MH1 insert on MH; the count is Σ count of inserts
        const rN = await rowS('Manholes (blocks)', 'nr'), rN2 = await rowS('Manholes (selection)', 'nr');
        const mb = await ok(lay({ row_id: rN, tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count' }), 'blocks');
        r = await sel({ row_id: rN, handles: ['M1'], metric: 'count' });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'already measured on this row');
        const sc = await ok(sel({ row_id: rN2, handles: ['M1', 'M2', 'K2'], metric: 'count' }), 'count');
        assert.strictEqual(sc.qty, 2); assert.strictEqual(sc.qty_unit, 'nr');
        assert.deepStrictEqual(JSON.parse(db.prepare('SELECT selection_summary s FROM measurements WHERE id=?').get(sc.id).s),
          { metric: 'count', by_layer: { MH: 2 }, skipped: 1, nested: false, blocks: [{ layer: 'MH', block: 'MH1', top: 2, nested: 0, count: 2 }] });
        assert.strictEqual(sc.skipped, 1, 'the KERB line is not a count');
        assert.deepStrictEqual(handlesOf(sc.id), ['M1', 'M2'], 'only the entities that contributed are stored');
        r = await lay({ row_id: rN2, tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count' });
        assert.strictEqual(r.s, 409, 'blocks onto a row whose selection has that block'); assert.strictEqual(r.j.error, 'already measured on this row');
        await ok(call('DELETE', `measurements/${mb.id}`, null, qs), 'tidy');

        // final review item 1 (spec 6.4): a count is the top-level INSERTs by name; nested inserts only with nested: true,
        // reported apart per block; more than one block name in the count needs confirm_mixed_blocks. Preview = saved.
        // The probe: 10 DOOR inserts, each DOOR block holding 2 HINGE inserts; one WINDOW elsewhere.
        {
          const TV = require('./public/viewer/core.js');
          const doors = [];
          for (let i = 0; i < 10; i++) doors.push([0, 'INSERT'], [5, 'D' + i], [8, 'DR'], [2, 'DOOR'], [10, i * 1000], [20, 0]);
          const FIXD = dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...sec('BLOCKS', [
            [0, 'BLOCK'], [2, 'HINGE'], [70, 0], [10, 0], [20, 0], ...line('HL', '0', 500, 0, 600, 0), [0, 'ENDBLK'],
            [0, 'BLOCK'], [2, 'DOOR'], [70, 0], [10, 0], [20, 0], ...line('DL', '0', 0, 0, 900, 0),
            [0, 'INSERT'], [5, 'H1'], [8, '0'], [2, 'HINGE'], [10, 0], [20, 0], [0, 'INSERT'], [5, 'H2'], [8, '0'], [2, 'HINGE'], [10, 0], [20, 2000], [0, 'ENDBLK'],
            [0, 'BLOCK'], [2, 'WINDOW'], [70, 0], [10, 0], [20, 0], ...line('WL', '0', 0, 0, 1200, 0), [0, 'ENDBLK']]),
          ...sec('ENTITIES', [...doors, [0, 'INSERT'], [5, 'W1'], [8, 'DR'], [2, 'WINDOW'], [10, 0], [20, 50000]])]);
          const ud = await upload(TS, 'Doors plan', Buffer.from(FIXD), qs);
          assert.strictEqual(ud.s, 202);
          const DD = ud.j.id, dd = await waitDone(DD, qs);
          assert.strictEqual(dd.status, 'ready', dd.error);
          await ok(call('PUT', `drawings/${DD}/units`, { units: 'mm' }, qs), 'units doors');
          const flatD = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DDIR, dd.sha256 + '.json.gz')))).flat;
          const allD = flatD.map(f => f.handle), doorHs = allD.filter(h => h !== 'W1' && !h.startsWith('W1/'));
          // the preview the viewer shows for the same handles (display file, decoded as the browser does)
          const rr = await fetch(base + `drawings/${DD}/render`, { headers: { cookie: qs } });
          assert.strictEqual(rr.status, 200);
          const RD = TV.decodeRender(await rr.arrayBuffer()), idxOf = new Map(RD.handles.map((h, i) => [h, i]));
          const preview = (hs, nested) => TV.previewTotal(RD, hs.map(h => idxOf.get(h)), 'count', 0.001, { nested }).value;
          const flagsOf = id => db.prepare('SELECT nested, mixed FROM measurements WHERE id=?').get(id);
          const DOOR = { layer: 'DR', block: 'DOOR', top: 10, nested: 0, count: 10 };

          // default: the 10 DOORs; the 20 nested HINGEs are reported, not counted
          const rDoor = await rowS('Doors', 'nr');
          const d1 = await ok(sel({ row_id: rDoor, handles: doorHs, metric: 'count' }, qs, DD), 'doors');
          assert.strictEqual(d1.qty, 10, 'top-level DOOR inserts only'); assert.strictEqual(preview(doorHs, false), d1.qty, 'preview = saved (default)');
          assert.deepStrictEqual(d1.blocks, [DOOR, { layer: 'DR', block: 'HINGE', top: 0, nested: 20, count: 0 }]); assert.strictEqual(d1.nested, false);
          assert.strictEqual(d1.skipped, 50, 'door lines, hinge lines and nested hinges');
          assert.deepStrictEqual({ ...flagsOf(d1.id) }, { nested: 0, mixed: 0 });
          assert.deepStrictEqual(handlesOf(d1.id), doorHs.filter(h => /^D\d$/.test(h)));
          assert.deepStrictEqual(JSON.parse(db.prepare('SELECT selection_summary s FROM measurements WHERE id=?').get(d1.id).s).blocks, d1.blocks, 'breakdown stored');
          // nested: true → DOOR and HINGE are two block names: 409 with the per-name counts, then saved with the confirmation
          const rDoorN = await rowS('Doors and hinges', 'nr');
          r = await sel({ row_id: rDoorN, handles: doorHs, metric: 'count', nested: true }, qs, DD);
          assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'selection contains several blocks', blocks: { DOOR: 10, HINGE: 20 } });
          const mx0 = audits('measure_mixed_blocks_confirmed').length;
          const d2 = await ok(sel({ row_id: rDoorN, handles: doorHs, metric: 'count', nested: true, confirm_mixed_blocks: true }, qs, DD), 'doors + hinges');
          assert.strictEqual(d2.qty, 30, 'with nested: 10 DOOR + 20 HINGE'); assert.strictEqual(preview(doorHs, true), d2.qty, 'preview = saved (nested)');
          assert.deepStrictEqual(d2.blocks, [DOOR, { layer: 'DR', block: 'HINGE', top: 0, nested: 20, count: 20 }]); assert.strictEqual(d2.nested, true);
          assert.deepStrictEqual({ ...flagsOf(d2.id) }, { nested: 1, mixed: 1 });
          assert.deepStrictEqual(audits('measure_mixed_blocks_confirmed').slice(mx0), [{ drawing_id: DD, row_id: rDoorN, tool: 'dxf_selection', metric: 'count', blocks: { DOOR: 10, HINGE: 20 } }], 'audit: counts only');
          assert.strictEqual(audits('measure').at(-1).nested, true);
          // DOOR + WINDOW at the top level → 409 mixed; preview of the same handles = 11
          const rDW = await rowS('Doors and windows', 'nr');
          r = await sel({ row_id: rDW, handles: allD, metric: 'count' }, qs, DD);
          assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'selection contains several blocks', blocks: { DOOR: 10, WINDOW: 1 } });
          const d3 = await ok(sel({ row_id: rDW, handles: allD, metric: 'count', confirm_mixed_blocks: true }, qs, DD), 'doors + window');
          assert.strictEqual(d3.qty, 11); assert.strictEqual(preview(allD, false), d3.qty, 'preview = saved (mixed)');
          // nested belongs to a count; one block name needs no confirmation
          r = await sel({ row_id: rDoor, handles: ['D0/DL'], metric: 'open_length', nested: true }, qs, DD);
          assert.strictEqual(r.s, 400); assert.match(r.j.error, /nested/);
          for (const id of [d1.id, d2.id, d3.id]) await ok(call('DELETE', `measurements/${id}`, null, qs), 'tidy');
        }

        // incomplete: a bowtie (no area), a spline (approx), a dropped shape → 409 with counts, then saved with confirm, flag stored
        const rA = await rowS('Paving (selection)', 'm2'), rC = await rowS('Edge (selection)', 'm');
        r = await sel({ row_id: rA, handles: ['B1', 'B2'], metric: 'area' });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'layer quantity is incomplete', area_excluded: 1, approx: 0, dropped: 0, area_null: 1, duplicates: 0, overlapping: 0 });
        r = await sel({ row_id: rC, handles: ['S1'], metric: 'open_length' });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'layer quantity is incomplete', area_excluded: 0, approx: 1, dropped: 0, area_null: 0, duplicates: 0, overlapping: 0 });
        r = await sel({ row_id: rA, handles: ['Q1', 'QH'], metric: 'area' });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'layer quantity is incomplete', area_excluded: 0, approx: 0, dropped: 1, area_null: 0, duplicates: 0, overlapping: 0 });
        assert.strictEqual((await sel({ row_id: rA, handles: ['QH'], metric: 'area' })).s, 400, 'only a dropped shape: nothing to measure');
        assert.strictEqual(nMeas(), 2, 'refused: nothing saved');
        const inc0 = audits('measure_incomplete_confirmed').length;
        const si = await ok(sel({ row_id: rA, handles: ['B1', 'B2'], metric: 'area', confirm_incomplete: true }), 'confirm incomplete');
        near(si.qty, 4, 'the square only'); assert.strictEqual(si.incomplete, true);
        assert.strictEqual(db.prepare('SELECT incomplete FROM measurements WHERE id=?').get(si.id).incomplete, 1);
        assert.deepStrictEqual(audits('measure_incomplete_confirmed').slice(inc0), [{ drawing_id: DS, row_id: rA, tool: 'dxf_selection', metric: 'area', dropped: 0, area_null: 1, approx: 0 }]);
        assert.strictEqual((await ok(call('GET', `tenders/${TS}/rows`, null, viewer), 'rows')).find(x => x.id === rA).measured_incomplete, true);
        // duplicates: the same line twice → 409, then saved with confirm (both counted), flag stored
        const rD = await rowS('Dup (selection)', 'm');
        r = await sel({ row_id: rD, handles: ['U1', 'U2'], metric: 'open_length' });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'possible duplicates on this layer', dropped: 0, area_null: 0, approx: 0, duplicates: 1, overlapping: 0 });
        const dup0 = audits('measure_duplicate_confirmed').length;
        const sd = await ok(sel({ row_id: rD, handles: ['U1', 'U2'], metric: 'open_length', confirm_duplicate: true }), 'confirm duplicate');
        near(sd.qty, 6, 'both counted'); assert.strictEqual(sd.duplicate, true);
        assert.strictEqual(db.prepare('SELECT duplicate FROM measurements WHERE id=?').get(sd.id).duplicate, 1);
        assert.deepStrictEqual(audits('measure_duplicate_confirmed').slice(dup0), [{ drawing_id: DS, row_id: rD, tool: 'dxf_selection', metric: 'open_length', duplicates: 1 }]);

        // relink revalidates the overlap from the stored handles
        const rK2 = await rowS('Kerb 2 (selection)', 'm');
        const s4 = await ok(sel({ row_id: rK2, handles: ['K2'], metric: 'open_length' }), 'K2 on rK2');
        r = await call('PUT', `measurements/${s4.id}`, { row_id: rK }, qs);
        assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'already measured on this row', overlapping: 1 });
        const mlD = await ok(lay({ row_id: rD, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length', confirm_overlap: true }), 'KERB layer on rD');
        r = await call('PUT', `measurements/${s4.id}`, { row_id: rD }, qs);
        assert.strictEqual(r.s, 409, 'relink onto a row with that layer linked'); assert.strictEqual(r.j.error, 'already measured on this row');
        await ok(call('DELETE', `measurements/${mlD.id}`, null, qs), 'tidy');
        await ok(call('PUT', `measurements/${s4.id}`, { row_id: rD }, qs), 'relink to rD');
        near(await qtyS(rD), 11, 'rD: 6 + 5'); near(await qtyS(rK2), 0, 'rK2 emptied');
        assert.deepStrictEqual(handlesOf(s4.id), ['K2'], 'handles kept on relink');

        // Fix round 1 item 3: a line plus a text → skipped 1, in the response and the summary
        {
          // the Task 4 fixture: K2 a 5 m line and T9 an MTEXT on KERB
          const uf = await upload(TS, 'Plan with a note', Buffer.from(FIXTURE), qs);
          assert.strictEqual((await waitDone(uf.j.id, qs)).status, 'ready');
          await ok(call('PUT', `drawings/${uf.j.id}/units`, { units: 'mm' }, qs), 'units fixture');
          const rT = await rowS('Kerb + note', 'm');
          const st = await ok(sel({ row_id: rT, handles: ['K2', 'T9'], metric: 'open_length' }, qs, uf.j.id), 'line + text');
          assert.strictEqual(st.skipped, 1); near(st.qty, 5, 'the text adds nothing');
          assert.strictEqual(JSON.parse(db.prepare('SELECT selection_summary s FROM measurements WHERE id=?').get(st.id).s).skipped, 1);
          await ok(call('DELETE', `measurements/${st.id}`, null, qs), 'tidy');
        }
        // Fix round 1 item 1: a line and its exact copy in two separate selections on one row → the second needs confirm_duplicate
        {
          const rU = await rowS('Dup across selections', 'm'), rU2 = await rowS('Dup across selections 2', 'm');
          const a1 = await ok(sel({ row_id: rU, handles: ['U1'], metric: 'open_length' }), 'U1');
          assert.strictEqual(a1.duplicate, false);
          r = await sel({ row_id: rU, handles: ['U2'], metric: 'open_length' });
          assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'possible duplicates on this layer', dropped: 0, area_null: 0, approx: 0, duplicates: 1, overlapping: 0 });
          r = await sel({ row_id: rU, handles: ['U2'], metric: 'closed_perimeter' });
          assert.strictEqual(r.s, 400, 'U2 is open: no perimeter (nothing measured)');
          near(await qtyS(rU), 3, 'refused: one line only');
          const dup1 = audits('measure_duplicate_confirmed').length;
          const a2 = await ok(sel({ row_id: rU, handles: ['U2'], metric: 'open_length', confirm_duplicate: true }), 'U2 confirmed');
          assert.strictEqual(a2.duplicate, true); assert.strictEqual(db.prepare('SELECT duplicate FROM measurements WHERE id=?').get(a2.id).duplicate, 1);
          near(await qtyS(rU), 6, 'both counted once confirmed');
          assert.deepStrictEqual(audits('measure_duplicate_confirmed').slice(dup1), [{ drawing_id: DS, row_id: rU, tool: 'dxf_selection', metric: 'open_length', duplicates: 1 }]);
          // relink: U2 alone on another row, then back next to U1 → 409 unless confirm_duplicate
          const a3 = await ok(sel({ row_id: rU2, handles: ['U2'], metric: 'open_length' }), 'U2 on rU2');
          await ok(call('DELETE', `measurements/${a2.id}`, null, qs), 'tidy');
          r = await call('PUT', `measurements/${a3.id}`, { row_id: rU }, qs);
          assert.strictEqual(r.s, 409); assert.deepStrictEqual(r.j, { error: 'possible duplicates on this layer', duplicates: 1, overlapping: 0 });
          assert.strictEqual(db.prepare('SELECT row_id FROM measurements WHERE id=?').get(a3.id).row_id, rU2, 'refused relink: not moved');
          await ok(call('PUT', `measurements/${a3.id}`, { row_id: rU, confirm_duplicate: true }, qs), 'relink confirmed');
          assert.strictEqual(db.prepare('SELECT duplicate FROM measurements WHERE id=?').get(a3.id).duplicate, 1);
          assert.strictEqual(audits('measure_duplicate_confirmed').at(-1).row_id, rU);
          assert.strictEqual((await call('PUT', `measurements/${a1.id}`, { row_id: rU2, confirm_duplicate: 'yes' }, qs)).s, 400);
          for (const id of [a1.id, a3.id]) await ok(call('DELETE', `measurements/${id}`, null, qs), 'tidy');
        }
        // Fix round 1 item 2: a selection whose stored summary cannot be read overlaps any layer/block measurement of its family on the target row
        {
          const rX = await rowS('Unreadable summary', 'm'), rY = await rowS('Target with a layer', 'm');
          const x = await ok(sel({ row_id: rX, handles: ['K2'], metric: 'open_length' }), 'K2 on rX');
          const ly = await ok(lay({ row_id: rY, tool: 'dxf_layer', layer: 'ASPHALT', metric: 'closed_perimeter' }), 'other layer on rY');
          db.prepare("UPDATE measurements SET selection_summary='{not json' WHERE id=?").run(x.id);
          r = await call('PUT', `measurements/${x.id}`, { row_id: rY }, qs);
          assert.strictEqual(r.s, 409, 'unreadable summary: never assume no overlap'); assert.deepStrictEqual(r.j, { error: 'already measured on this row', overlapping: 1 });
          db.prepare('UPDATE measurements SET selection_summary=? WHERE id=?').run(JSON.stringify({ metric: 'open_length', by_layer: { KERB: 1 }, skipped: 0 }), x.id);
          await ok(call('PUT', `measurements/${x.id}`, { row_id: rY }, qs), 'readable again: ASPHALT is no overlap');
          for (const id of [x.id, ly.id]) await ok(call('DELETE', `measurements/${id}`, null, qs), 'tidy');
        }

        // the full parse cache missing: parsed again from the stored .dxf, then totalled
        const shaS = db.prepare('SELECT sha256 FROM drawings WHERE id=?').get(DS).sha256;
        fs.unlinkSync(path.join(DDIR, shaS + '.json.gz'));
        const s5 = await ok(sel({ row_id: rK2, handles: ['K2'], metric: 'open_length' }), 'cache rebuilt');
        near(s5.qty, 5, 'after rebuild'); assert.ok(fs.existsSync(path.join(DDIR, shaS + '.json.gz')));

        // 100k handles: every entity of the 100k-LINE drawing, totalled in a worker through the parse queue;
        // /api/status answers within the cap meanwhile, and the qty is exact
        {
          const ub = await upload(TS, 'big (selection)', Buffer.from(BIG), qs);
          const DB = ub.j.id;
          assert.strictEqual((await waitDone(DB, qs)).status, 'ready');
          await ok(call('PUT', `drawings/${DB}/units`, { units: 'm' }, qs), 'units big');
          const rB = await rowS('Kerb (100k)', 'm');
          const handles = Array.from({ length: 100000 }, (_, i) => 'H' + i);
          const w = ctx.drawings._workers; w.peak = w.alive;
          const started = w.started;
          let settled = false;
          const pr = sel({ row_id: rB, handles, metric: 'open_length' }, qs, DB).finally(() => { settled = true; });
          // a parse queued at the same time waits its turn: never two workers
          const up = upload(TS, 'QS', Buffer.from(bigLines(20000, 'QS')), qs);
          let observed = 0, worst = 0;
          while (!settled) {
            const a = performance.now(); const st = await call('GET', 'status', null, qs); const ms = performance.now() - a;
            assert.strictEqual(st.s, 200); worst = Math.max(worst, ms);
            assert.ok(ms < LATENCY_MS, '/api/status took ' + Math.round(ms) + ' ms during a 100k selection (cap ' + LATENCY_MS + ' ms)');
            if (!settled) observed++;
          }
          const big = await pr;
          assert.strictEqual(big.s, 200, JSON.stringify(big.j));
          assert.ok(observed > 0, 'no /api/status call overlapped the 100k selection');
          console.log('selection: ' + observed + ' /api/status call(s) answered during a 100k selection (worst ' + Math.round(worst) + ' ms, cap ' + LATENCY_MS + ' ms)');
          assert.strictEqual(big.j.qty, 500000, 'exact'); assert.strictEqual(big.j.qty_unit, 'm');
          assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurement_handles WHERE measurement_id=?').get(big.j.id).n, 100000);
          assert.strictEqual(db.prepare('SELECT handles_count FROM measurements WHERE id=?').get(big.j.id).handles_count, 100000);
          const hb = await ok(call('GET', `measurements/${big.j.id}/handles`, null, viewer), 'handles 100k');
          assert.strictEqual(hb.count, 100000); assert.strictEqual(hb.handles.length, 100000); assert.strictEqual(hb.handles[99999], 'H99999');
          assert.ok(!JSON.stringify(audits('measure').at(-1)).includes('H1'), 'the audit carries no handles');
          const u = await up; assert.strictEqual(u.s, 202); assert.strictEqual((await waitDone(u.j.id, qs)).status, 'ready');
          assert.ok(w.started - started >= 2, 'the selection ran in a worker'); assert.strictEqual(w.peak, 1, 'never more than one worker alive');
        }

        // approved tender → 409; revise → the Rev has the selections with the same handles
        const before = db.prepare("SELECT * FROM measurements WHERE tender_id=? AND tool='dxf_selection' ORDER BY id").all(TS);
        db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(TS);
        assert.strictEqual((await sel({ row_id: rK, handles: ['K1'], metric: 'closed_perimeter' })).s, 409, 'approved → 409');
        assert.strictEqual((await call('DELETE', `measurements/${s1.id}`, null, qs)).s, 409, 'approved → DELETE 409');
        const rv = await ok(call('POST', `tenders/${TS}/revise`, null, qs), 'revise');
        const after = db.prepare("SELECT * FROM measurements WHERE tender_id=? AND tool='dxf_selection' ORDER BY id").all(rv.id);
        assert.strictEqual(after.length, before.length);
        after.forEach((x, i) => {
          assert.notStrictEqual(x.id, before[i].id);
          for (const k of ['metric', 'handles_count', 'base', 'qty', 'qty_unit', 'incomplete', 'duplicate', 'selection_summary']) assert.strictEqual(x[k], before[i][k], k);
          assert.deepStrictEqual(handlesOf(x.id), handlesOf(before[i].id), 'same handles');
          const keysOf = id => db.prepare('SELECT handle, geom_key FROM measurement_handles WHERE measurement_id=? ORDER BY rowid').all(id).map(y => ({ ...y }));
          assert.deepStrictEqual(keysOf(x.id), keysOf(before[i].id), 'same geomKeys');
        });
        // the Rev is a draft: delete one of its selections → its handles go, the original's stay
        const ri = after.findIndex(x => x.handles_count === 1);
        await ok(call('DELETE', `measurements/${after[ri].id}`, null, qs), 'rev delete');
        assert.deepStrictEqual(handlesOf(after[ri].id), []); assert.strictEqual(handlesOf(before[ri].id).length, 1);
        // deleting the draft Rev removes its handles
        const revIds = after.map(x => x.id);
        await ok(call('DELETE', `tenders/${rv.id}`, null, qs), 'delete rev');
        assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM measurement_handles WHERE measurement_id IN (${revIds.join(',')})`).get().n, 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurement_handles WHERE measurement_id NOT IN (SELECT id FROM measurements)').get().n, 0, 'no orphan handles');
      }
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
          if (r.every(x => x.status !== 'parsing') || Date.now() - t0 > ${WAIT_MS}) { console.log(JSON.stringify(r)); process.exit(0); } setTimeout(tick, 50); };
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
          if (r.status !== 'parsing' || Date.now() - t0 > ${2 * WAIT_MS}) { console.log(JSON.stringify(r)); process.exit(0); } setTimeout(tick, 50); };
        tick();`], { env: { ...process.env, DATA_DIR: dir3, DRAWINGS_PARSE_HEAP_MB: '16' }, encoding: 'utf8' });
      assert.strictEqual(e.status, 0, e.stderr);
      assert.deepStrictEqual(JSON.parse(e.stdout.trim()), { status: 'failed', error: 'drawing too large to parse — PURGE unused objects or split the drawing in AutoCAD, then save as DXF again' });
    }

    console.log('drawings ok'); done(0);
  } catch (e) { console.error(e); done(1); }
});
