// Drawings: raw DXF upload, worker parse, units, layer table: node --no-warnings test-drawings.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), { spawnSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'est-drawings-'));
process.env.ERP_SYNC_DISABLED = '1';
const { server, db, ctx } = require('./server.js');
const { layerTable } = require('./lib/dxf/summary.js');
const http = require('http'), zlib = require('zlib');
const TMP_DIRS = [process.env.DATA_DIR];
// close the database and the server before removing the folders: Windows cannot delete files that are still open (EPERM)
const done = code => {
  try { server.close(); } catch (e) { /* not listening */ }
  try { db.close(); } catch (e) { /* closed already */ }
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.error('could not remove ' + d + ': ' + e.code); } }
  process.exit(code);
};
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
      assert.strictEqual(r1.h.etag, `"${d.sha256}-${PARSER_VERSION}"`); assert.strictEqual(r1.h['cache-control'], 'private, no-cache', 'revalidated with the ETag every time');
      assert.ok(r1.b.equals(fs.readFileSync(rf)), 'the stored gz bytes as they are');
      assert.strictEqual(Number(r1.h['content-length']), r1.b.length);
      const raw = zlib.gunzipSync(r1.b), header = JSON.parse(raw.subarray(4, 4 + raw.readUInt32LE(0)).toString('utf8'));
      assert.strictEqual(header.version, 3);
      assert.deepStrictEqual(header.handles, cache.flat.map(f => f.handle), 'one entity per cache entry, same order');
      assert.ok(header.layers.some(l => l.name === 'أسفلت'), 'Arabic layer name round-trips');
      assert.deepStrictEqual(header.blocks, ['MH1']);
      const r2 = await getRaw(`drawings/${id}/render`, qs, { 'If-None-Match': r1.h.etag });
      assert.strictEqual(r2.s, 304); assert.strictEqual(r2.b.length, 0); assert.strictEqual(r2.h.etag, r1.h.etag); assert.strictEqual(r2.h['cache-control'], 'private, no-cache');
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
        // failed by this parser version (an older version's failure is parsed again: see the corrupt-file test)
        const nid = Number(db.prepare("INSERT INTO drawings(tender_id,name,sha256,bytes,status,failed_version,created) VALUES(?,?,?,1,?,?,'x')").run(tid, 'nr', 'f'.repeat(64), st, st === 'failed' ? PARSER_VERSION : null).lastInsertRowid);
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
      // final review item 3: the failure keeps the parser version that failed; a newer parser tries the file once more
      const { PARSER_VERSION: PV } = require('./lib/dxf/summary.js'), w = ctx.drawings._workers, fid = r.j.id;
      assert.strictEqual(db.prepare('SELECT failed_version FROM drawings WHERE id=?').get(fid).failed_version, PV, 'failed_version stored');
      let s0 = w.started;
      assert.strictEqual((await call('GET', `drawings/${fid}`, null, qs)).j.status, 'failed');
      assert.strictEqual(w.started - s0, 0, 'failed by this parser version: not parsed again');
      db.prepare('UPDATE drawings SET failed_version=? WHERE id=?').run(PV - 1, fid);   // as if an older parser had failed
      const g1 = await call('GET', `drawings/${fid}`, null, qs);
      assert.strictEqual(g1.s, 200); assert.strictEqual(g1.j.status, 'parsing', 'an older version\'s failure is queued again');
      const f2 = await waitDone(fid, qs);
      assert.strictEqual(f2.status, 'failed'); assert.match(f2.error, /truncated/); assert.strictEqual(w.started - s0, 1, 'one re-parse');
      assert.strictEqual(db.prepare('SELECT failed_version FROM drawings WHERE id=?').get(fid).failed_version, PV);
      s0 = w.started;
      assert.strictEqual((await call('GET', `drawings/${fid}`, null, qs)).j.status, 'failed'); assert.strictEqual(w.started - s0, 0, 'once only');
      // a file an older parser could not read and this one can (failed_version NULL: failed before the column): ready again
      const oid = Number(db.prepare("INSERT INTO drawings(tender_id,name,sha256,bytes,status,error,created) VALUES(?,'old failure',?,1,'failed','old parser error','x')").run(tid, d.sha256).lastInsertRowid);
      assert.strictEqual((await call('GET', `drawings/${oid}`, null, viewer)).j.status, 'parsing');
      const o2 = await waitDone(oid, qs);
      assert.strictEqual(o2.status, 'ready', o2.error); assert.strictEqual(o2.error, null);
      const pr = (await call('GET', 'audit', null, admin)).j.filter(a => a.action === 'parse_retry').map(a => [Number(a.entity_id), JSON.parse(a.detail)]);
      assert.deepStrictEqual(pr, [[oid, { failed_version: null, parser_version: PV }], [fid, { failed_version: PV - 1, parser_version: PV }]], 'retries audited');
      db.prepare('DELETE FROM drawings WHERE id=?').run(oid);
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

    // ---- ctx.drawings hooks; units cannot change unseen after measuring ---------------------------------------
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
      // batch 4: no longer refused outright: the before/after list (Task 1 section below)
      const r = await call('PUT', `drawings/${id}/units`, { units: 'm' }, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'unit change changes measured quantities');
      assert.strictEqual(r.j.changes.length, 5, 'every measurement listed');
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

    // ---- batch 3 Task 2: PDF and image drawings, pages registered by the browser, the file endpoint ---------------
    {
      const { makePdf, PDF_PAGES, makePng, jpegHeader, pngHeader } = require('./test/fixtures/make-takeoff.js');
      const sha256 = b => require('crypto').createHash('sha256').update(b).digest('hex');
      const T = (await call('POST', 'tenders', { title: 'Test Plans PDF', kind: 'rta' }, qs)).j.id;
      const row = id => ({ ...db.prepare('SELECT * FROM drawings WHERE id=?').get(id) });
      const getFile = async (id, ck, headers = {}) => { const r = await fetch(base + `drawings/${id}/file`, { headers: { cookie: ck, ...headers } }); return { s: r.status, h: r.headers, b: Buffer.from(await r.arrayBuffer()) }; };
      const PDF = makePdf(), psha = sha256(PDF);

      // a PDF: kind pdf, status pages, page NULL; stored as <sha>.pdf; no parse
      const up = await upload(T, 'Plans', PDF, qs);
      assert.strictEqual(up.s, 202, JSON.stringify(up.j));
      let d = row(up.j.id);
      assert.strictEqual(d.kind, 'pdf'); assert.strictEqual(d.status, 'pages'); assert.strictEqual(d.page, null); assert.strictEqual(d.sha256, psha);
      assert.strictEqual(d.bytes, PDF.length); assert.strictEqual(d.parent_id, null);
      assert.ok(fs.existsSync(path.join(DDIR, psha + '.pdf')), 'stored as <sha>.pdf'); assert.ok(!fs.existsSync(path.join(DDIR, psha + '.dxf')));
      const ga = await call('GET', `drawings/${up.j.id}`, null, viewer);
      assert.strictEqual(ga.s, 200); assert.strictEqual(ga.j.status, 'pages'); assert.strictEqual(ga.j.header, null);
      // the DXF routes do not apply
      assert.strictEqual((await call('GET', `drawings/${up.j.id}/layers`, null, qs)).s, 400, 'no layers for a PDF');
      assert.strictEqual((await call('GET', `drawings/${up.j.id}/render`, null, qs)).s, 400, 'no display file for a PDF');
      assert.strictEqual((await call('PUT', `drawings/${up.j.id}/units`, { units: 'm' }, qs)).s, 400, 'no units for a PDF');

      // the file: the original bytes, application/pdf, private no-cache, ETag → 304; any reader, also before the pages
      let f = await getFile(up.j.id, viewer);
      assert.strictEqual(f.s, 200); assert.ok(f.b.equals(PDF), 'bytes equal');
      assert.strictEqual(f.h.get('content-type'), 'application/pdf'); assert.strictEqual(f.h.get('cache-control'), 'private, no-cache');
      assert.strictEqual(f.h.get('x-content-type-options'), 'nosniff');
      // final review M5: never shown as a page of this site (a download, sandboxed); pdf.js and the image viewer fetch it
      assert.strictEqual(f.h.get('content-disposition'), `attachment; filename="drawing.pdf"; filename*=UTF-8''Plans.pdf`);
      assert.strictEqual(f.h.get('content-security-policy'), 'sandbox');
      const etag = f.h.get('etag'); assert.ok(etag && etag.includes(psha));
      assert.strictEqual((await getFile(up.j.id, viewer, { 'If-None-Match': etag })).s, 304);
      assert.strictEqual((await getFile(up.j.id, '')).s, 401);
      assert.strictEqual((await getFile(999999, qs)).s, 404);

      // POST pages: roles, draft, validation (nothing changes on a refusal)
      const pages = PDF_PAGES.map(p => ({ ...p }));
      assert.strictEqual((await call('POST', `drawings/${up.j.id}/pages`, { pages }, viewer)).s, 403, 'viewer POST pages → 403');
      const badPages = [
        [{}, /pages/], [{ pages: [] }, /1 to 2000/], [{ pages, extra: 1 }, /unknown field/],
        [{ pages: [{ ...pages[0], width: 0 }, pages[1]] }, /width/], [{ pages: [{ ...pages[0], height: 14401 }, pages[1]] }, /height/],
        [{ pages: [{ ...pages[0], width: '595' }, pages[1]] }, /width/], [{ pages: [{ ...pages[0], rotation: 45 }, pages[1]] }, /rotation/],
        [{ pages: [pages[0], { ...pages[1], page: 1 }] }, /exactly once/], [{ pages: [pages[0], { ...pages[1], page: 3 }] }, /exactly once/],
        [{ pages: [{ ...pages[0], page: 1.5 }] }, /page/], [{ pages: [{ ...pages[0], note: 'x' }] }, /unknown field/],
        [{ pages: [{ ...pages[0], x0: '1000' }, pages[1]] }, /x0/], [{ pages: [{ ...pages[0], y0: -1e7 - 1 }, pages[1]] }, /y0/], [{ pages: [pages[0], { ...pages[1], x0: null }] }, /x0/],
        [{ pages: Array.from({ length: 2001 }, (_, i) => ({ page: i + 1, width: 10, height: 10, rotation: 0 })) }, /1 to 2000/],
      ];
      for (const [b, re] of badPages) { const r = await call('POST', `drawings/${up.j.id}/pages`, b, qs); assert.strictEqual(r.s, 400, JSON.stringify(b).slice(0, 80)); assert.match(r.j.error, re); }
      assert.deepStrictEqual(row(up.j.id), d, 'refusals change nothing');
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE parent_id=?').get(up.j.id).n, 0);

      // 2 pages (595×842 rot 0, 842×595 rot 90), sent in any order → 2 rows, ready
      const pr = await call('POST', `drawings/${up.j.id}/pages`, { pages: [pages[1], pages[0]] }, qs);
      assert.strictEqual(pr.s, 200, JSON.stringify(pr.j));
      const all = db.prepare('SELECT * FROM drawings WHERE id=? OR parent_id=? ORDER BY page').all(up.j.id, up.j.id);
      assert.strictEqual(all.length, 2);
      assert.deepStrictEqual(all.map(x => [x.id === up.j.id, x.kind, x.status, x.page, x.page_w, x.page_h, x.rotation, x.parent_id, x.sha256, x.name, x.tender_id]), [
        [true, 'pdf', 'ready', 1, 595, 842, 0, null, psha, 'Plans', T],
        [false, 'pdf', 'ready', 2, 842, 595, 90, up.j.id, psha, 'Plans — p2', T]]);
      assert.deepStrictEqual(pr.j.drawings.map(x => x.id), all.map(x => x.id), 'the reply lists the page rows');
      assert.deepStrictEqual(all.map(x => [x.page_x0, x.page_y0]), [[0, 0], [0, 0]], 'no x0/y0: the page box starts at 0');
      const pa = db.prepare("SELECT detail FROM audit_log WHERE action='pages' AND entity_id=?").get(String(up.j.id));
      assert.deepStrictEqual(JSON.parse(pa.detail), { pages: 2 });
      // a second pages call → 409 (also on a page row)
      assert.strictEqual((await call('POST', `drawings/${up.j.id}/pages`, { pages }, qs)).s, 409, 'second pages call → 409');
      assert.strictEqual((await call('POST', `drawings/${all[1].id}/pages`, { pages: [pages[0]] }, qs)).s, 409, 'a page row → 409');
      // a child page serves the shared file
      f = await getFile(all[1].id, viewer);
      assert.strictEqual(f.s, 200); assert.ok(f.b.equals(PDF)); assert.strictEqual(f.h.get('content-type'), 'application/pdf');

      // a one-page registration only updates the row
      {
        const one = await upload(T, 'Single', PDF, qs);
        assert.strictEqual(one.s, 202);
        assert.strictEqual((await call('POST', `drawings/${one.j.id}/pages`, { pages: [{ page: 1, width: 420.5, height: 297.25, rotation: 270, x0: 12.5, y0: -7.25 }] }, qs)).s, 200);
        const o = row(one.j.id);
        assert.deepStrictEqual([o.status, o.page, o.page_w, o.page_h, o.rotation, o.page_x0, o.page_y0], ['ready', 1, 420.5, 297.25, 270, 12.5, -7.25], 'the page box origin is stored (R16)');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE parent_id=?').get(one.j.id).n, 0);
      }

      {
        const odd = await upload(T, `Fake "plan" (A)'s* مخطط.pdf`, PDF, qs);
        assert.strictEqual(odd.s, 202);
        const o = await getFile(odd.j.id, viewer);
        assert.strictEqual(o.s, 200);
        assert.strictEqual(o.h.get('content-disposition'), `attachment; filename="drawing.pdf"; filename*=UTF-8''Fake%20%22plan%22%20%28A%29%27s%2A%20%D9%85%D8%AE%D8%B7%D8%B7.pdf`);
        db.prepare('DELETE FROM drawings WHERE id=?').run(odd.j.id);
      }

      // images: PNG and JPEG by magic → one ready row with the pixel size; stored as <sha>.png / <sha>.jpg
      const PNG = makePng(64, 48), JPG = jpegHeader(1200, 900);
      for (const [buf, ext, type, w, h] of [[PNG, 'png', 'image/png', 64, 48], [JPG, 'jpg', 'image/jpeg', 1200, 900]]) {
        const u = await upload(T, 'Photo ' + ext, buf, qs);
        assert.strictEqual(u.s, 202, JSON.stringify(u.j));
        const x = row(u.j.id);
        assert.deepStrictEqual([x.kind, x.status, x.page, x.page_w, x.page_h, x.rotation, x.bytes], ['image', 'ready', 1, w, h, 0, buf.length]);
        assert.ok(fs.existsSync(path.join(DDIR, sha256(buf) + '.' + ext)));
        const g = await getFile(u.j.id, viewer);
        assert.strictEqual(g.s, 200); assert.ok(g.b.equals(buf)); assert.strictEqual(g.h.get('content-type'), type);
        assert.strictEqual(g.h.get('content-disposition'), `attachment; filename="drawing.${ext}"; filename*=UTF-8''Photo%20${ext}.${ext}`);
        assert.strictEqual(g.h.get('content-security-policy'), 'sandbox');
        assert.strictEqual((await call('POST', `drawings/${u.j.id}/pages`, { pages: [pages[0]] }, qs)).s, 400, 'pages apply to a PDF');
        assert.strictEqual((await call('GET', `drawings/${u.j.id}/layers`, null, qs)).s, 400, 'no layers for an image');
      }
      const upAudit = db.prepare("SELECT detail FROM audit_log WHERE action='upload' ORDER BY id DESC LIMIT 1").get();
      assert.strictEqual(JSON.parse(upAudit.detail).kind, 'image');

      // wrong magic → 400, nothing stored: a name that says PDF/PNG/JPEG/DXF over other content; an image whose header is
      // unreadable or too large
      {
        const n0 = nDrawings(), before = dirFiles();
        for (const [name, body, re] of [
          ['plan.pdf', Buffer.from(FIXTURE), /not a PDF/], ['photo.png', PDF, /not a PNG/], ['photo.JPG', PNG, /not a JPEG/], ['photo.jpeg', Buffer.from(FIXTURE), /not a JPEG/],
          ['plan.dxf', PDF, /not a DXF/], ['broken', pngHeader(640, 480).subarray(0, 20), /not a PNG or JPEG image/],
          ['broken jpeg', jpegHeader(1200, 900).subarray(0, 30), /not a PNG or JPEG image/], ['huge', pngHeader(30000, 100), /image too large \(max 20000 px per side\)/]]) {
          const r = await upload(T, name, body, qs);
          assert.strictEqual(r.s, 400, name + ': ' + JSON.stringify(r.j)); assert.match(r.j.error, re, name);
        }
        assert.strictEqual(nDrawings(), n0, 'no row'); assert.deepStrictEqual(dirFiles(), before, 'no file left');
        // the right names are fine
        assert.strictEqual((await upload(T, 'plan.pdf', PDF, qs)).s, 202); assert.strictEqual((await upload(T, 'photo.jpeg', JPG, qs)).s, 202);
      }
      // an image over 50 MB → 413 while streaming (a PDF may be up to 100 MB)
      {
        const big = Buffer.concat([PNG, Buffer.alloc(50 * 1024 * 1024 + 1 - PNG.length)]);
        const r = await upload(T, 'big', big, qs);
        assert.strictEqual(r.s, 413); assert.match(r.j.error, /50 MB/);
        assert.ok(!dirFiles().some(x => x.startsWith('tmp-')), 'no temp file');
      }

      // the file of a missing stored file → 409, never a server path
      {
        const c = db.prepare("INSERT INTO drawings(tender_id,kind,name,sha256,bytes,status,page,created) VALUES(?,'image','gone',?,1,'ready',1,'x')").run(T, 'b'.repeat(64)).lastInsertRowid;
        const r = await call('GET', `drawings/${c}/file`, null, qs);
        assert.strictEqual(r.s, 409); assert.ok(!r.j.error.includes(DDIR));
        db.prepare('DELETE FROM drawings WHERE id=?').run(c);
      }

      // Rev clone: the page rows go along with parent_id remapped; tender delete removes them (the file stays)
      {
        const n = db.prepare('SELECT COUNT(*) n FROM drawings WHERE tender_id=?').get(T).n;
        db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(T);
        // pages and file reads on a non-draft tender: writes 409, reads allowed
        const late = await upload(T, 'late', PDF, qs); assert.strictEqual(late.s, 409);
        const pend = db.prepare("SELECT id FROM drawings WHERE tender_id=? AND status='pages' LIMIT 1").get(T).id;
        assert.strictEqual((await call('POST', `drawings/${pend}/pages`, { pages }, qs)).s, 409, 'approved → pages 409');
        assert.strictEqual((await getFile(up.j.id, viewer)).s, 200);
        const rv = await call('POST', `tenders/${T}/revise`, null, qs);
        assert.strictEqual(rv.s, 200, JSON.stringify(rv.j));
        const nd = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(rv.j.id), od = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(T);
        assert.strictEqual(nd.length, n);
        nd.forEach((x, i) => {
          for (const k of ['kind', 'name', 'sha256', 'bytes', 'status', 'page', 'page_w', 'page_h', 'rotation', 'page_x0', 'page_y0']) assert.strictEqual(x[k], od[i][k], k);
          assert.strictEqual(x.parent_id, od[i].parent_id === null ? null : nd[od.findIndex(o => o.id === od[i].parent_id)].id, 'parent_id remapped');
        });
        assert.ok(nd.some(x => x.page_x0 === 12.5 && x.page_y0 === -7.25), 'the page box origin is copied (R16)');
        const child = nd.find(x => x.parent_id !== null);
        assert.ok(child && nd.find(x => x.id === child.parent_id).tender_id === rv.j.id);
        // the copied 'pages' row can register its pages in the draft Rev
        const cp = nd.find(x => x.status === 'pages');
        assert.strictEqual((await call('POST', `drawings/${cp.id}/pages`, { pages }, qs)).s, 200);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE parent_id=?').get(cp.id).n, 1);
        const del = await call('DELETE', `tenders/${rv.j.id}`, null, qs);
        assert.strictEqual(del.s, 200, JSON.stringify(del.j));
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE tender_id=?').get(rv.j.id).n, 0, 'page rows deleted');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM drawings)').get().n, 0, 'no orphan page rows');
        assert.ok(fs.existsSync(path.join(DDIR, psha + '.pdf')), 'the shared file stays');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE tender_id=?').get(T).n, n, 'original unchanged');
      }

      // the vendored pdf.js is served as text/javascript
      for (const fn of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
        const r = await fetch(`http://localhost:${server.address().port}/vendor/pdfjs/${fn}`);
        assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/javascript/);
        assert.ok(Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(path.join(__dirname, 'public', 'vendor', 'pdfjs', fn))));
      }
    }

    // ---- batch 3 Task 3: calibration of a PDF page or an image (page and regions), verify; carry-overs ------------
    {
      const { makePdf, PDF_PAGES, makePng } = require('./test/fixtures/make-takeoff.js');
      const T = (await call('POST', 'tenders', { title: 'Test Calibration', kind: 'rta' }, qs)).j.id;
      const pdfUp = await upload(T, 'Sheets', makePdf(), qs);
      assert.strictEqual(pdfUp.s, 202);
      const cpath = id => `drawings/${id}/calibrations`;
      // a PDF whose pages are not registered yet has no page to calibrate
      const pre = await call('POST', cpath(pdfUp.j.id), { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs);
      assert.strictEqual(pre.s, 409, JSON.stringify(pre.j)); assert.match(pre.j.error, /pages/);
      const pg = await call('POST', `drawings/${pdfUp.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs);
      assert.strictEqual(pg.s, 200);
      const [P1, P2] = pg.j.drawings.map(x => x.id);
      const calRows = id => db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(id);
      const lastAudit = action => { const a = db.prepare('SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1').get(action); return a && { ...a, detail: JSON.parse(a.detail) }; };

      let g = await call('GET', cpath(P1), null, viewer);
      assert.strictEqual(g.s, 200); assert.deepStrictEqual(g.j, { calibrations: [] });
      assert.deepStrictEqual((await call('GET', `drawings/${P1}`, null, viewer)).j.calibrations, []);
      assert.strictEqual((await call('GET', cpath(P1), null, '')).s, 401);
      assert.strictEqual((await call('GET', cpath(999999), null, qs)).s, 404);

      // roles and validation: nothing stored on a refusal
      const good = { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' };
      assert.strictEqual((await call('POST', cpath(P1), good, viewer)).s, 403, 'viewer → 403');
      for (const [b, re] of [
        [{ ...good, p1: undefined }, /p1/], [{ ...good, p2: [5, 0] }, /at least 10/], [{ ...good, p2: [100, '0'] }, /p2/], [{ ...good, real: 0 }, /real length/],
        [{ ...good, real: '5' }, /real length/], [{ ...good, unit: 'yd' }, /unit/], [{ ...good, scale: 2 }, /unknown field/], [{ ...good, apply: 'yes' }, /apply/],
        [{ ...good, region: [0, 0, 10] }, /region/], [{ ...good, region: [0, 0, 0, 10] }, /size/], [{ ...good, region: 'all' }, /region/]]) {
        const r = await call('POST', cpath(P1), b, qs);
        assert.strictEqual(r.s, 400, JSON.stringify(b)); assert.match(r.j.error, re, JSON.stringify(b));
      }
      assert.strictEqual(calRows(P1).length, 0);

      // page calibration: 100 units = 5 m → 0.05 m/unit; shown by GET (calibrations and the drawing detail)
      let r = await call('POST', cpath(P1), good, qs);
      assert.strictEqual(r.s, 200, JSON.stringify(r.j));
      const pageId = r.j.calibration.id;
      assert.deepStrictEqual({ ...r.j.calibration, created: null }, { id: pageId, drawing_id: P1, region: null, p1: [0, 0], p2: [100, 0], real: 5, unit: 'm', scale: 0.05, verify_pct: null, copied_from: null, created: null, created_by: 'qs1' });
      assert.strictEqual(r.j.replaced, false); assert.deepStrictEqual(r.j.changes, []);
      g = await call('GET', cpath(P1), null, viewer);
      assert.deepStrictEqual(g.j.calibrations, [r.j.calibration]);
      assert.deepStrictEqual((await call('GET', `drawings/${P1}`, null, viewer)).j.calibrations, [r.j.calibration]);
      let a = lastAudit('calibrate');
      assert.strictEqual(a.entity, 'calibrations'); assert.strictEqual(a.entity_id, String(pageId));
      assert.deepStrictEqual(a.detail, { drawing_id: P1, region: false, scale: 0.05, real: 5, unit: 'm', replaced: false, changed: 0, rows: 0 }, 'summary only, no coordinates');

      // a second page calibration replaces the first (same id, verify cleared); at most one per drawing
      r = await call('POST', cpath(P1), { p1: [0, 0], p2: [0, 200], real: 20000, unit: 'mm' }, qs);
      assert.strictEqual(r.s, 200); assert.strictEqual(r.j.calibration.id, pageId); assert.strictEqual(r.j.replaced, true);
      assert.strictEqual(r.j.calibration.scale, 0.1);
      assert.strictEqual(calRows(P1).filter(c => c.region === null).length, 1);
      assert.throws(() => db.prepare("INSERT INTO calibrations(drawing_id,region,p1x,p1y,p2x,p2y,real,unit,scale) VALUES(?,NULL,0,0,100,0,1,'m',0.01)").run(P1), /UNIQUE/, 'the database refuses a second page calibration');
      assert.deepStrictEqual(lastAudit('calibrate').detail, { drawing_id: P1, region: false, scale: 0.1, real: 20000, unit: 'mm', replaced: true, changed: 0, rows: 0 });

      // regions: normalised to [minx, miny, maxx, maxy]; an overlap is refused, touching at an edge is not an overlap
      r = await call('POST', cpath(P1), { region: [300, 300, 100, 100], p1: [100, 100], p2: [100, 300], real: 2, unit: 'm' }, qs);
      assert.strictEqual(r.s, 200, JSON.stringify(r.j));
      const regA = r.j.calibration;
      assert.deepStrictEqual(regA.region, [100, 100, 300, 300]); assert.strictEqual(regA.scale, 0.01);
      assert.strictEqual(calRows(P1).find(c => c.id === regA.id).region, '[100,100,300,300]');
      const n0 = calRows(P1).length;
      for (const rg of [[250, 250, 400, 400], [150, 150, 200, 200], [0, 0, 500, 500], [299, 0, 400, 101]]) {
        const o = await call('POST', cpath(P1), { region: rg, p1: [rg[0], rg[1]], p2: [rg[0] + 40, rg[1]], real: 1, unit: 'm' }, qs);
        assert.strictEqual(o.s, 409, JSON.stringify(rg)); assert.match(o.j.error, /overlap/);
      }
      assert.strictEqual(calRows(P1).length, n0, 'nothing stored');
      r = await call('POST', cpath(P1), { region: [300, 100, 400, 300], p1: [300, 100], p2: [400, 100], real: 1, unit: 'm' }, qs);
      assert.strictEqual(r.s, 200, 'sharing an edge is fine');
      const regB = r.j.calibration;
      assert.strictEqual((await call('POST', cpath(P1), { region: [400, 300, 500, 400], p1: [400, 300], p2: [450, 300], real: 1, unit: 'm' }, qs)).s, 200, 'sharing a corner is fine');
      // Task 6 fix: a region is calibrated by points inside it
      for (const pts of [{ p1: [0, 0], p2: [450, 300] }, { p1: [400, 300], p2: [501, 300] }]) {
        const x = await call('POST', cpath(P1), { region: [500, 500, 600, 600], ...pts, real: 1, unit: 'm' }, qs);
        assert.strictEqual(x.s, 400, JSON.stringify(pts)); assert.match(x.j.error, /inside the region/);
      }
      // the same rectangle again (corners in another order) replaces that region's calibration
      r = await call('POST', cpath(P1), { region: [100, 300, 300, 100], p1: [100, 100], p2: [300, 100], real: 4, unit: 'm' }, qs);
      assert.strictEqual(r.s, 200); assert.strictEqual(r.j.calibration.id, regA.id); assert.strictEqual(r.j.replaced, true); assert.strictEqual(r.j.calibration.scale, 0.02);
      assert.strictEqual(calRows(P1).length, 4);
      assert.deepStrictEqual(lastAudit('calibrate').detail, { drawing_id: P1, region: true, scale: 0.02, real: 4, unit: 'm', replaced: true, changed: 0, rows: 0 });
      // the list: page first, then the regions by id
      g = await call('GET', cpath(P1), null, viewer);
      assert.deepStrictEqual(g.j.calibrations.map(c => c.id), [pageId, regA.id, regB.id, regB.id + 1]);
      // page 2 is calibrated on its own (its regions may overlap those of page 1)
      assert.strictEqual((await call('POST', cpath(P2), { region: [0, 0, 500, 500], p1: [0, 0], p2: [0, 100], real: 1, unit: 'm' }, qs)).s, 200);
      assert.strictEqual((await call('POST', cpath(P2), good, qs)).s, 200);
      assert.strictEqual(calRows(P2).length, 2); assert.strictEqual(calRows(P1).length, 4);

      // verify: a second known line → (measured − real) / real × 100, stored; a warning above 1 %
      assert.strictEqual((await call('POST', cpath(P1), good, qs)).s, 200);   // back to 0.05 m/unit
      const vpath = cid => `${cpath(P1)}/${cid}/verify`;
      assert.strictEqual((await call('POST', vpath(pageId), { p1: [0, 0], p2: [200, 0], real: 10.2, unit: 'm' }, viewer)).s, 403);
      let v = await call('POST', vpath(pageId), { p1: [0, 0], p2: [200, 0], real: 10.2, unit: 'm' }, qs);
      assert.strictEqual(v.s, 200, JSON.stringify(v.j));
      assert.ok(Math.abs(v.j.pct - (10 - 10.2) / 10.2 * 100) < 1e-9 && Math.abs(v.j.pct + 1.96) < 0.005, String(v.j.pct)); assert.strictEqual(v.j.warning, true);
      assert.strictEqual(calRows(P1).find(c => c.id === pageId).verify_pct, v.j.pct);
      assert.deepStrictEqual(lastAudit('calibration_verify').detail, { drawing_id: P1, calibration_id: pageId, pct: v.j.pct, warning: true });
      v = await call('POST', vpath(pageId), { p1: [0, 0], p2: [0, 200], real: 10050, unit: 'mm' }, qs);
      assert.strictEqual(v.s, 200); assert.ok(Math.abs(v.j.pct) < 1); assert.strictEqual(v.j.warning, false);
      assert.strictEqual((await call('GET', cpath(P1), null, viewer)).j.calibrations[0].verify_pct, v.j.pct);
      for (const [b, re] of [[{ p1: [0, 0], p2: [5, 0], real: 1, unit: 'm' }, /at least 10/], [{ p1: [0, 0], p2: [50, 0], real: -1, unit: 'm' }, /real length/],
        [{ p1: [0, 0], p2: [50, 0], real: 1, unit: 'm', apply: true }, /unknown field/], [{ p1: [0, 0], p2: [200, 0], real: 1e306, unit: 'km' }, /real length/]]) {
        const pctBefore = calRows(P1).find(c => c.id === pageId).verify_pct;
        const x = await call('POST', vpath(pageId), b, qs);
        assert.strictEqual(x.s, 400, JSON.stringify(b)); assert.match(x.j.error, re);
        assert.strictEqual(calRows(P1).find(c => c.id === pageId).verify_pct, pctBefore, 'verify_pct unchanged');
      }
      // final review M1: both verify points must resolve to the calibration verified (the page outside every region, a
      // region inside it); nothing stored on a refusal
      {
        const pctOf = id => calRows(P1).find(c => c.id === id).verify_pct, before = [pctOf(pageId), pctOf(regA.id)];
        for (const [cid, b] of [[pageId, { p1: [150, 150], p2: [250, 150] }], [pageId, { p1: [0, 0], p2: [150, 150] }], [regA.id, { p1: [150, 150], p2: [150, 50] }], [regA.id, { p1: [0, 0], p2: [0, 50] }]]) {
          const x = await call('POST', vpath(cid), { ...b, real: 1, unit: 'm' }, qs);
          assert.strictEqual(x.s, 400, cid + ' ' + JSON.stringify(b) + ' ' + JSON.stringify(x.j)); assert.match(x.j.error, /where this calibration applies/);
        }
        assert.deepStrictEqual([pctOf(pageId), pctOf(regA.id)], before, 'verify_pct unchanged');
        const y = await call('POST', vpath(regA.id), { p1: [150, 150], p2: [250, 150], real: 2, unit: 'm' }, qs);
        assert.strictEqual(y.s, 200, JSON.stringify(y.j)); assert.ok(Math.abs(y.j.pct) < 1e-9, 'a region verified inside it: ' + y.j.pct);
      }
      const p2cal = calRows(P2)[0].id;
      assert.strictEqual((await call('POST', vpath(p2cal), { p1: [0, 0], p2: [200, 0], real: 10, unit: 'm' }, qs)).s, 404, 'a calibration of another drawing');
      assert.strictEqual((await call('POST', vpath(999999), { p1: [0, 0], p2: [200, 0], real: 10, unit: 'm' }, qs)).s, 404);

      // delete: refused while a measurement uses the calibration; otherwise removed with an audit entry
      assert.strictEqual((await call('DELETE', `${cpath(P1)}/${regB.id}`, null, viewer)).s, 403);
      const fakeM = Number(db.prepare("INSERT INTO measurements(drawing_id,tender_id,tool,qty,qty_unit,calibration_id,created) VALUES(?,?,'manual',1,'m',?,'x')").run(P1, T, regB.id).lastInsertRowid);
      let x = await call('DELETE', `${cpath(P1)}/${regB.id}`, null, qs);
      assert.strictEqual(x.s, 409); assert.match(x.j.error, /measurements use/);
      assert.ok(calRows(P1).some(c => c.id === regB.id));
      // re-calibrating it while a measurement uses it: 409 with or without apply (no manual recompute before Task 4),
      // the measurement and the calibration unchanged
      {
        const mBefore = db.prepare('SELECT * FROM measurements WHERE id=?').get(fakeM), cBefore = calRows(P1);
        for (const apply of [undefined, true]) {
          const y = await call('POST', cpath(P1), { region: [300, 100, 400, 300], p1: [300, 100], p2: [400, 100], real: 2, unit: 'm', ...(apply ? { apply, expect: [] } : {}) }, qs);
          assert.strictEqual(y.s, 409, 'apply ' + apply + ': ' + JSON.stringify(y.j)); assert.match(y.j.error, /recomputed/);
        }
        assert.deepStrictEqual(db.prepare('SELECT * FROM measurements WHERE id=?').get(fakeM), mBefore, 'measurement unchanged');
        assert.deepStrictEqual(calRows(P1), cBefore, 'calibrations unchanged');
      }
      db.prepare('DELETE FROM measurements WHERE id=?').run(fakeM);
      x = await call('DELETE', `${cpath(P1)}/${regB.id}`, null, qs);
      assert.strictEqual(x.s, 200, JSON.stringify(x.j));
      assert.ok(!calRows(P1).some(c => c.id === regB.id));
      assert.deepStrictEqual(lastAudit('calibration_delete').detail, { drawing_id: P1, region: true, scale: 0.01, real: 1, unit: 'm' });
      assert.strictEqual((await call('DELETE', `${cpath(P1)}/${regB.id}`, null, qs)).s, 404);
      assert.strictEqual((await call('DELETE', `${cpath(P1)}/${p2cal}`, null, qs)).s, 404, 'a calibration of another drawing');

      // an image is calibrated the same way; a DXF → 400
      const img = await upload(T, 'Photo', makePng(640, 480), qs);
      assert.strictEqual((await call('POST', cpath(img.j.id), good, qs)).s, 200);
      const dxfUp = await upload(T, 'Site', FIXTURE, qs);
      assert.strictEqual(dxfUp.s, 202);
      for (const [m, u, b] of [['POST', cpath(dxfUp.j.id), good], ['GET', cpath(dxfUp.j.id), null]]) {
        const y = await call(m, u, b, qs);
        assert.strictEqual(y.s, 400, m); assert.match(y.j.error, /PDF/);
      }
      assert.strictEqual((await waitDone(dxfUp.j.id, qs)).calibrations, null, 'a DXF detail has no calibrations');

      // an approved tender: every change → 409, reads allowed
      db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(T);
      const before = db.prepare('SELECT * FROM calibrations ORDER BY id').all();
      for (const [m, u, b] of [['POST', cpath(P1), good], ['POST', cpath(P1), { ...good, region: [600, 600, 700, 700] }], ['POST', vpath(pageId), good], ['DELETE', `${cpath(P1)}/${regA.id}`, null]]) {
        const y = await call(m, u, b, qs);
        assert.strictEqual(y.s, 409, m + ' ' + u); assert.match(y.j.error, /approved/);
      }
      assert.deepStrictEqual(db.prepare('SELECT * FROM calibrations ORDER BY id').all(), before, 'nothing changed');
      assert.strictEqual((await call('GET', cpath(P1), null, viewer)).s, 200);

      // a deleted draft tender takes its calibrations along
      {
        const T2 = (await call('POST', 'tenders', { title: 'Test Calibration Delete', kind: 'rta' }, qs)).j.id;
        const im = await upload(T2, 'Photo', makePng(64, 48), qs);
        assert.strictEqual((await call('POST', cpath(im.j.id), good, qs)).s, 200);
        assert.strictEqual((await call('DELETE', `tenders/${T2}`, null, qs)).s, 200);
        assert.strictEqual(calRows(im.j.id).length, 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM calibrations WHERE drawing_id NOT IN (SELECT id FROM drawings)').get().n, 0, 'no orphan calibrations');
      }

      // carry-over (a): a name that says PNG/JPEG with a Content-Length over 50 MB → 413 before the body is read
      {
        const port = server.address().port;
        const rawPost = (u, headers) => new Promise((ok, no) => {
          const q = http.request({ port, method: 'POST', path: '/api/' + u, headers: { cookie: qs, 'Content-Type': 'application/octet-stream', ...headers } }, res => {
            let b = ''; res.on('data', c => b += c); res.on('end', () => ok({ s: res.statusCode, conn: res.headers.connection, b }));
          });
          q.on('error', no);
          q.setTimeout(5000, () => { q.destroy(); no(new Error('no answer within 5 s to ' + u)); });
          q.write('\x89PNG');   // the rest is never sent: the answer must come anyway
        });
        const T4 = (await call('POST', 'tenders', { title: 'Test Early Refusal', kind: 'rta' }, qs)).j.id;
        for (const name of ['big.png', 'big.JPG', 'big.jpeg']) {
          const y = await rawPost(`tenders/${T4}/drawings?name=${name}`, { 'Content-Length': 50 * 1024 * 1024 + 1 });
          assert.strictEqual(y.s, 413, name); assert.match(JSON.parse(y.b).error, /50 MB/); assert.strictEqual(y.conn, 'close');
        }
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE tender_id=?').get(T4).n, 0);
        assert.ok(!dirFiles().some(f => f.startsWith('tmp-')), 'no temp file');
      }
      // carry-over (c): page-row names stay within 200 characters, the page suffix kept
      {
        const T5 = (await call('POST', 'tenders', { title: 'Test Long Names', kind: 'rta' }, qs)).j.id;
        const long = 'N'.repeat(200), u5 = await upload(T5, long, makePdf(), qs);
        assert.strictEqual(u5.s, 202);
        const pages = Array.from({ length: 12 }, (_, i) => ({ page: i + 1, width: 595, height: 842, rotation: 0 }));
        const y = await call('POST', `drawings/${u5.j.id}/pages`, { pages }, qs);
        assert.strictEqual(y.s, 200);
        const names = y.j.drawings.map(z => z.name);
        assert.strictEqual(names[0], long);
        assert.strictEqual(names[1], 'N'.repeat(200 - ' — p2'.length) + ' — p2');
        assert.strictEqual(names[11], 'N'.repeat(200 - ' — p12'.length) + ' — p12');
        assert.ok(names.every(z => z.length <= 200));
        // a short name is not cut; a surrogate pair is never split
        const u6 = await upload(T5, 'x'.repeat(194) + '😀😀😀', makePdf(), qs);
        assert.strictEqual(u6.s, 202);
        const y6 = await call('POST', `drawings/${u6.j.id}/pages`, { pages: pages.slice(0, 2) }, qs);
        assert.strictEqual(y6.j.drawings[1].name, 'x'.repeat(194) + ' — p2', 'the cut never leaves half a character');
        const u7 = await upload(T5, 'Short', makePdf(), qs);
        assert.strictEqual((await call('POST', `drawings/${u7.j.id}/pages`, { pages: pages.slice(0, 2) }, qs)).j.drawings[1].name, 'Short — p2');
      }
    }

    // ---- batch 3 Task 4: manual measurements (line, polyline, area with holes, rect, count) on PDF, image and DXF ------
    {
      const TM = require('./lib/takeoff/manual.js');
      const { makePdf, PDF_PAGES, makePng, makeOffsetPdf, OFFSET_PAGE } = require('./test/fixtures/make-takeoff.js');
      const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}: expected ≈${b}, got ${a}`);
      const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
      const audits = action => db.prepare("SELECT detail FROM audit_log WHERE action=? ORDER BY id").all(action).map(a => JSON.parse(a.detail));
      const auditFrom = db.prepare('SELECT COALESCE(MAX(id), 0) n FROM audit_log').get().n;
      const T = (await ok(call('POST', 'tenders', { title: 'Test Manual Take-off', kind: 'rta' }, qs), 'tender')).id;
      const newRow = async (description, unit) => (await ok(call('POST', `tenders/${T}/rows`, { description, unit }, qs), 'row ' + description)).id;
      const rM = await newRow('Fake kerb', 'm'), rM2 = await newRow('Fake paving', 'm2'), rNr = await newRow('Fake gullies', 'nr'), rDxf = await newRow('Fake edging', 'm');
      const qtyOf = id => db.prepare('SELECT qty FROM tender_rows WHERE id=?').get(id).qty;
      const mRow = id => db.prepare('SELECT * FROM measurements WHERE id=?').get(id);
      const nM = () => db.prepare('SELECT COUNT(*) n FROM measurements WHERE tender_id=?').get(T).n;
      const measure = (did, b, ck = qs) => call('POST', `drawings/${did}/measurements`, { tool: 'manual', ...b }, ck);
      const put = (id, b, ck = qs) => call('PUT', `measurements/${id}`, b, ck);
      const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
      const poly = { tool: 'polyline', pts: [[0, 0], [30, 40], [30, 100]] };                    // 110 units
      const area = { tool: 'area', outer: sq(200, 200, 100), holes: [sq(240, 240, 20)] };     // 9600 units²
      const dline = { tool: 'line', pts: [[300, 500], [300, 520]] };                          // 20 units

      // a PDF whose pages are not registered: nothing to measure
      const pdfUp = await upload(T, 'Manual sheets', makePdf(), qs);
      let r = await measure(pdfUp.j.id, { row_id: rM, geom: poly });
      assert.strictEqual(r.s, 409, JSON.stringify(r.j));
      const [P1, P2] = (await ok(call('POST', `drawings/${pdfUp.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs), 'pages')).drawings.map(x => x.id);

      // no calibration → 409; a viewer → 403; nothing stored
      r = await measure(P1, { row_id: rM, geom: poly });
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'calibrate this page first');
      assert.strictEqual((await measure(P1, { row_id: rM, geom: poly }, viewer)).s, 403);
      assert.strictEqual(nM(), 0);
      const pageCal = (await ok(call('POST', `drawings/${P1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs), 'calibrate')).calibration;   // 0.05 m/unit
      // R12: points beyond [−w, 2w] × [−h, 2h] are refused (wrong coordinate space), for calibrations too
      for (const b of [{ p1: [0, 0], p2: [1191, 0], real: 5, unit: 'm' }, { p1: [0, -843], p2: [0, 0], real: 5, unit: 'm' }, { region: [0, 0, 100, 1685], p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }]) {
        const x = await call('POST', `drawings/${P1}/calibrations`, b, qs);
        assert.strictEqual(x.s, 400, JSON.stringify(b)); assert.match(x.j.error, /outside the page/);
      }
      // R16: a page box that does not start at 0 (MediaBox [1000 2000 1595 2842]): points stay absolute, the bound is
      // centred on the box origin
      {
        const off = await upload(T, 'Offset sheet', makeOffsetPdf(), qs);
        const [PO] = (await ok(call('POST', `drawings/${off.j.id}/pages`, { pages: [{ ...OFFSET_PAGE }] }, qs), 'offset pages')).drawings;
        assert.deepStrictEqual([PO.page_w, PO.page_h, PO.rotation, PO.page_x0, PO.page_y0], [595, 842, 270, 1000, 2000]);
        const c = await call('POST', `drawings/${PO.id}/calibrations`, { p1: [1100, 2100], p2: [1300, 2100], real: 10, unit: 'm' }, qs);
        assert.strictEqual(c.s, 200, 'absolute points on an offset page are accepted: ' + JSON.stringify(c.j));
        // [x0 − w, x0 + 2w] × [y0 − h, y0 + 2h] = [405, 2190] × [1158, 3684]
        for (const b of [{ p1: [404, 2100], p2: [1100, 2100], real: 5, unit: 'm' }, { p1: [1100, 2100], p2: [2191, 2100], real: 5, unit: 'm' },
          { p1: [1100, 1157], p2: [1100, 2100], real: 5, unit: 'm' }, { p1: [1100, 3685], p2: [1100, 2100], real: 5, unit: 'm' }, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }]) {
          const x = await call('POST', `drawings/${PO.id}/calibrations`, b, qs);
          assert.strictEqual(x.s, 400, JSON.stringify(b)); assert.match(x.j.error, /outside the page/);
        }
        const e = await call('POST', `drawings/${PO.id}/calibrations`, { p1: [405, 1158], p2: [2190, 3684], real: 5, unit: 'm', apply: true, expect: [] }, qs);
        assert.strictEqual(e.s, 200, 'the bound edges are inside: ' + JSON.stringify(e.j));
        // leave the tender as the checks below expect it
        db.prepare('DELETE FROM calibrations WHERE drawing_id=?').run(PO.id); db.prepare('DELETE FROM drawings WHERE id=?').run(PO.id);
      }

      // bad bodies → 400, nothing stored (validation before the calibration lookup)
      for (const [b, re] of [
        [{ row_id: rM, geom: { tool: 'area', outer: [[0, 0], [10, 10], [10, 0], [0, 10]], holes: [] } }, /self-intersect/],
        [{ row_id: rM2, geom: { tool: 'area', outer: sq(0, 0, 100), holes: [sq(200, 200, 10)] } }, /outside the outline/],
        [{ row_id: rM, geom: { tool: 'polyline', pts: [[0, 0], [1e400, 0]] } }, /point/],
        [{ row_id: rM, geom: { tool: 'polyline', pts: [[0, 0], [1191, 0]] } }, /outside the page/],
        [{ row_id: rM, geom: { tool: 'polyline', pts: [[-596, 0], [0, 0]] } }, /outside the page/],
        [{ row_id: rM, geom: { tool: 'rect', p1: [5, 5], p2: [5, 50] } }, /size/],
        [{ row_id: rNr, geom: { tool: 'count', pts: [[1, 1]] }, width: 1 }, /count/],
        [{ row_id: rM2, geom: area, width: 1 }, /depth, not width/],
        [{ row_id: rM, geom: poly, layer: 'X' }, /unknown field/],
        [{ row_id: rM, geom: poly, handles: ['1'] }, /unknown field/],
        [{ row_id: rM, geom: poly, metric: 'area' }, /metric/],
        [{ row_id: rM, geom: poly, deduct: 'yes' }, /deduct/],
        [{ row_id: rM }, /geom/]]) {
        const x = await measure(P1, b);
        assert.strictEqual(x.s, 400, JSON.stringify(b) + ' ' + JSON.stringify(x.j)); assert.match(x.j.error, re, JSON.stringify(b));
      }
      assert.strictEqual(nM(), 0);

      // a polyline on the calibrated page onto a take-off row in m: qty = manualQty, stored with its geometry and calibration
      const mPoly = await ok(measure(P1, { row_id: rM, geom: poly, label: 'Fake kerb A' }), 'polyline');
      const want = TM.manualQty(poly, { scale: 0.05 });
      assert.strictEqual(mPoly.qty, want.qty); near(mPoly.qty, 5.5, 'polyline 110 units × 0.05'); assert.strictEqual(mPoly.qty_unit, 'm');
      assert.strictEqual(mPoly.calibration_id, pageCal.id); near(mPoly.row_qty, 5.5, 'row qty'); near(qtyOf(rM), 5.5, 'row stored');
      let s = mRow(mPoly.id);
      assert.deepStrictEqual(JSON.parse(s.geom), poly);
      assert.deepStrictEqual({ tool: s.tool, metric: s.metric, base: s.base, deduct: s.deduct, calibration_id: s.calibration_id, label: s.label, factor: s.factor },
        { tool: 'manual', metric: 'length', base: want.base, deduct: 0, calibration_id: pageCal.id, label: 'Fake kerb A', factor: 1 });
      assert.deepStrictEqual(audits('measure').at(-1), { drawing_id: P1, row_id: rM, tool: 'manual', shape: 'polyline', metric: 'length', points: 3, qty: want.qty, qty_unit: 'm', deduct: false, calibration_id: pageCal.id }, 'summary only');
      // the list shows the geometry and which calibration was used
      const listed = (await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list')).measurements.find(x => x.id === mPoly.id);
      assert.deepStrictEqual(listed.geom, poly);
      assert.deepStrictEqual(listed.calibration, { id: pageCal.id, region: false, region_no: null, scale: 0.05, verify_pct: null, copied_from: null });
      // Task 6: the list carries the scale the quantity used and the drawing's kind/units (the formula "350 pt × 0.05 m/pt");
      // a drawing exposes the server's unit table, so the browser never keeps its own copy
      assert.deepStrictEqual([listed.scale, listed.drawing_kind, listed.drawing_units], [0.05, 'pdf', null]);
      assert.deepStrictEqual((await call('GET', `drawings/${P1}`, null, viewer)).j.unit_to_m, require('./lib/units').UNIT_TO_M);

      // an area with a hole onto an m2 row → (10000 − 400) × 0.05² = 24; a length on it → 400 (known units must match)
      const mArea = await ok(measure(P1, { row_id: rM2, geom: area }), 'area');
      near(mArea.qty, 24, 'area with a hole'); assert.strictEqual(mArea.qty, TM.manualQty(area, { scale: 0.05 }).qty); near(qtyOf(rM2), 24, 'm2 row');
      r = await measure(P1, { row_id: rM2, geom: dline });
      assert.strictEqual(r.s, 400); assert.deepStrictEqual(r.j, { error: 'unit mismatch — add width/depth', row_unit: 'm2', qty_unit: 'm' });

      // identical geometry (reversed, noise below 1e-6) on the same row → 409 unless confirm_overlap (audited)
      const again = { tool: 'polyline', pts: poly.pts.slice().reverse().map(([x, y]) => [x + 1e-8, y]) };
      r = await measure(P1, { row_id: rM, geom: again });
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'already measured on this row');
      const dup = await ok(measure(P1, { row_id: rM, geom: again, confirm_overlap: true }), 'overlap confirmed');
      assert.strictEqual(audits('measure_overlap_confirmed').at(-1).overlaps, 1);
      await ok(call('DELETE', `measurements/${dup.id}`, null, qs), 'delete the copy');
      near(qtyOf(rM), 5.5, 'back to one polyline');

      // a deduction reduces the row; a row below 0 → 400, rolled back
      const mDed = await ok(measure(P1, { row_id: rM, geom: dline, deduct: true }), 'deduct');
      near(mDed.qty, -1, 'deduct 20 units'); near(qtyOf(rM), 4.5, 'row reduced'); assert.strictEqual(mRow(mDed.id).deduct, 1);
      const n0 = nM();
      r = await measure(P1, { row_id: rM, geom: { tool: 'line', pts: [[0, 600], [0, 800]] }, deduct: true });
      assert.strictEqual(r.s, 400); assert.match(r.j.error, /deductions exceed/);
      assert.strictEqual(nM(), n0, 'nothing stored'); near(qtyOf(rM), 4.5, 'row unchanged');

      // PUT: factor 2 → qty recomputed, row updated; deduct off and on; label; width on an area and m3 on an m2 row refused
      let e = await ok(put(mPoly.id, { factor: 2 }), 'factor');
      near(e.qty, 11, 'factor 2'); near(qtyOf(rM), 10, 'row after factor'); near(mRow(mPoly.id).base, 5.5, 'base unchanged');
      assert.deepStrictEqual(audits('measure_edit').at(-1), { drawing_id: P1, row_id: rM, tool: 'manual', shape: 'polyline', metric: 'length', points: 3, qty: e.qty, qty_unit: 'm', deduct: false, calibration_id: pageCal.id, width: null, depth: null, factor: 2 });
      await ok(put(mDed.id, { deduct: false }), 'deduct off'); near(qtyOf(rM), 12, 'deduct off');
      await ok(put(mDed.id, { deduct: true, label: 'Fake gap' }), 'deduct on'); near(qtyOf(rM), 10, 'deduct on'); assert.strictEqual(mRow(mDed.id).label, 'Fake gap');
      const areaBefore = mRow(mArea.id);
      for (const [b, re, st] of [[{ width: 2 }, /depth, not width/, 400], [{ depth: 0.5 }, /unit mismatch/, 400], [{ geom: poly }, /unknown field/, 400], [{ factor: 0 }, /factor/, 400], [{}, /nothing to change/, 400], [{ row_id: rM }, /unit mismatch/, 400]]) {
        const x = await put(mArea.id, b);
        assert.strictEqual(x.s, st, JSON.stringify(b)); assert.match(x.j.error, re, JSON.stringify(b));
      }
      assert.deepStrictEqual(mRow(mArea.id), areaBefore, 'refused edits change nothing');
      assert.strictEqual((await put(mPoly.id, { factor: 3 }, viewer)).s, 403);
      // making the deduction bigger than the row → 400, rolled back
      r = await put(mDed.id, { factor: 20 });
      assert.strictEqual(r.s, 400); assert.match(r.j.error, /deductions exceed/); near(qtyOf(rM), 10, 'row unchanged'); assert.strictEqual(mRow(mDed.id).factor, 1);

      // re-calibrating the page (scale × 2): 409 with the before/after list, nothing changed; apply → qty doubled (area × 4)
      const snap = () => JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(T), db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(P1), qtyOf(rM), qtyOf(rM2)]);
      const before = snap();
      r = await call('POST', `drawings/${P1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 10, unit: 'm' }, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'calibration changes measured quantities');
      const at = (g, o) => TM.manualQty(g, { scale: 0.1, ...o }).qty;
      assert.deepStrictEqual(r.j.changes, [
        { measurement_id: mPoly.id, row_id: rM, old_qty: mRow(mPoly.id).qty, new_qty: at(poly, { factor: 2 }) },
        { measurement_id: mArea.id, row_id: rM2, old_qty: mRow(mArea.id).qty, new_qty: at(area) },
        { measurement_id: mDed.id, row_id: rM, old_qty: -1, new_qty: at(dline, { deduct: true }) }]);
      assert.strictEqual(snap(), before, 'nothing changed without apply');
      // R18: apply carries the reviewed list; without it → 400
      const expectOf = changes => changes.map(c => ({ measurement_id: c.measurement_id, new_qty: c.new_qty }));
      const reviewedList = expectOf(r.j.changes), recal = { p1: [0, 0], p2: [100, 0], real: 10, unit: 'm' };
      for (const [b, re] of [[{ ...recal, apply: true }, /needs expect/], [{ ...recal, expect: reviewedList }, /goes with apply/], [{ ...recal, apply: true, expect: [{ measurement_id: mPoly.id }] }, /new_qty/],
        [{ ...recal, apply: true, expect: [...reviewedList, reviewedList[0]] }, /duplicate/], [{ ...recal, apply: true, expect: [{ ...reviewedList[0], x: 1 }] }, /unknown field/]]) {
        const x = await call('POST', `drawings/${P1}/calibrations`, b, qs);
        assert.strictEqual(x.s, 400, JSON.stringify(b)); assert.match(x.j.error, re);
      }
      assert.strictEqual(snap(), before, 'nothing changed by a refused apply');
      // another measurement saved between the review and Apply: the reviewed list no longer matches → 409 with the fresh list
      const mLate = await ok(measure(P1, { row_id: rM, geom: { tool: 'line', pts: [[0, 300], [0, 340]] } }), 'saved meanwhile');
      const beforeLate = snap();
      r = await call('POST', `drawings/${P1}/calibrations`, { ...recal, apply: true, expect: reviewedList }, qs);
      assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'the measured quantities changed: review the changes again');
      assert.deepStrictEqual(r.j.changes.map(c => c.measurement_id), [mPoly.id, mArea.id, mDed.id, mLate.id], 'the fresh list');
      assert.strictEqual(snap(), beforeLate, 'nothing changed');
      // a changed qty (not only a changed set) is refused too
      r = await call('POST', `drawings/${P1}/calibrations`, { ...recal, apply: true, expect: [...reviewedList, { measurement_id: mLate.id, new_qty: 5 }] }, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(snap(), beforeLate, 'nothing changed');
      await ok(call('DELETE', 'measurements/' + mLate.id, null, qs), 'tidy');
      assert.strictEqual(snap(), before);
      r = await ok(call('POST', `drawings/${P1}/calibrations`, { ...recal, apply: true, expect: reviewedList }, qs), 'apply');
      assert.strictEqual(r.changes.length, 3);
      near(mRow(mPoly.id).qty, 22, 'polyline doubled'); near(mRow(mPoly.id).base, 11, 'base doubled'); near(mRow(mArea.id).qty, 96, 'area × 4'); near(mRow(mDed.id).qty, -2, 'deduction doubled');
      near(qtyOf(rM), 20, 'row m updated'); near(qtyOf(rM2), 96, 'row m2 updated');
      assert.deepStrictEqual(audits('calibrate').at(-1), { drawing_id: P1, region: false, scale: 0.1, real: 10, unit: 'm', replaced: true, changed: 3, rows: 2 });
      // the same calibration again changes nothing: a plain replace
      assert.deepStrictEqual((await ok(call('POST', `drawings/${P1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 10, unit: 'm' }, qs), 'same')).changes, []);

      // a new region: measurements whose first point falls in it move to it (409 list, apply)
      const regBody = { region: [150, 150, 350, 350], p1: [150, 150], p2: [350, 150], real: 5, unit: 'm' };   // 0.025 m/unit
      r = await call('POST', `drawings/${P1}/calibrations`, regBody, qs);
      assert.strictEqual(r.s, 409, JSON.stringify(r.j));
      assert.deepStrictEqual(r.j.changes, [{ measurement_id: mArea.id, row_id: rM2, old_qty: 96, new_qty: TM.manualQty(area, { scale: 0.025 }).qty }], 'only the area starts inside the region');
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM calibrations WHERE drawing_id=?').get(P1).n, 1, 'no region stored');
      const reg = (await ok(call('POST', `drawings/${P1}/calibrations`, { ...regBody, apply: true, expect: expectOf(r.j.changes) }, qs), 'region apply')).calibration;
      assert.strictEqual(mRow(mArea.id).calibration_id, reg.id); near(mRow(mArea.id).qty, 6, 'area at 0.025'); near(qtyOf(rM2), 6, 'm2 row');
      assert.strictEqual(mRow(mPoly.id).calibration_id, pageCal.id, 'the polyline stays on the page calibration');
      // final review M3: the list says which region (numbered as the scale line: the drawing's regions by id, from 1)
      { const ls = (await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list')).measurements;
        assert.deepStrictEqual(ls.find(x => x.id === mArea.id).calibration, { id: reg.id, region: true, region_no: 1, scale: 0.025, verify_pct: null, copied_from: null });
        assert.strictEqual(ls.find(x => x.id === mPoly.id).calibration.region_no, null); }
      // a new measurement starting in the region uses it
      const mRect = await ok(measure(P1, { row_id: rM2, geom: { tool: 'rect', p1: [160, 160], p2: [200, 180] } }), 'rect in region');
      assert.strictEqual(mRect.calibration_id, reg.id); near(mRect.qty, 0.5, 'rect 40×20 × 0.025²'); near(qtyOf(rM2), 6.5, 'm2 row');
      assert.strictEqual((await call('DELETE', `drawings/${P1}/calibrations/${reg.id}`, null, qs)).s, 409, 'a used region cannot be deleted');
      // R14: a count on an uncalibrated PDF page saves with no calibration; a later calibration lists nothing for it
      const mP2Count = await ok(measure(P2, { row_id: rNr, geom: { tool: 'count', pts: [[50, 50], [60, 60]] } }), 'count on an uncalibrated page');
      assert.strictEqual(mP2Count.qty, 2); assert.strictEqual(mP2Count.calibration_id, null); assert.strictEqual(qtyOf(rNr), 2);
      assert.strictEqual((await measure(P2, { row_id: rM, geom: poly })).j.error, 'calibrate this page first', 'a length still needs a calibration');
      const p2cal = await ok(call('POST', `drawings/${P2}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs), 'page 2');
      assert.deepStrictEqual(p2cal.changes, [], 'the count is not listed'); assert.strictEqual(mRow(mP2Count.id).calibration_id, null);
      // the same geometry on page 2 of the same file is not an overlap
      const mP2 = await ok(measure(P2, { row_id: rM, geom: poly }), 'page 2 polyline');
      near(mP2.qty, 5.5, 'page 2'); near(qtyOf(rM), 25.5, 'row m');

      // an image: a count onto an nr row needs no calibration (bounds 2 × 640 by 2 × 480)
      const img = await upload(T, 'Fake photo', makePng(640, 480), qs);
      assert.match((await measure(img.j.id, { row_id: rNr, geom: { tool: 'count', pts: [[10, 10], [1281, 10]] } })).j.error, /outside the page/);
      // R15: the same count point twice (even apart) counts one item twice → refused
      r = await measure(img.j.id, { row_id: rNr, geom: { tool: 'count', pts: [[1, 1], [2, 2], [1, 1]] } });
      assert.strictEqual(r.s, 400); assert.match(r.j.error, /repeated point/);
      const mCount = await ok(measure(img.j.id, { row_id: rNr, geom: { tool: 'count', pts: [[10, 10], [20, 20], [30, 10]] } }), 'count');
      assert.strictEqual(mCount.qty, 3); assert.strictEqual(mCount.qty_unit, 'nr'); assert.strictEqual(mCount.calibration_id, null); assert.strictEqual(qtyOf(rNr), 5);
      const ical = (await ok(call('POST', `drawings/${img.j.id}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs), 'image calibration'));
      assert.deepStrictEqual(ical.changes, []);
      // re-calibrating lists nothing for a count
      assert.deepStrictEqual((await ok(call('POST', `drawings/${img.j.id}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 7, unit: 'm' }, qs), 'image re-calibration')).changes, []);
      assert.strictEqual(mRow(mCount.id).qty, 3); assert.strictEqual(mRow(mCount.id).calibration_id, null);
      // R12 on the verify line too
      const iv = await call('POST', `drawings/${img.j.id}/calibrations/${ical.calibration.id}/verify`, { p1: [0, 0], p2: [0, 961], real: 5, unit: 'm' }, qs);
      assert.strictEqual(iv.s, 400); assert.match(iv.j.error, /p2 is outside the page/);
      // only counts on it: the calibration can be deleted, the count stays
      await ok(call('DELETE', `drawings/${img.j.id}/calibrations/${ical.calibration.id}`, null, qs), 'delete a calibration only counts are on');
      assert.strictEqual(mRow(mCount.id).qty, 3); assert.strictEqual(qtyOf(rNr), 5);
      // R13: at most 10000 points in a manual shape
      const n1 = nM();
      r = await measure(P1, { row_id: rM, geom: { tool: 'polyline', pts: Array.from({ length: 10001 }, (_, i) => [i % 500, Math.floor(i / 500)]) } });
      assert.strictEqual(r.s, 400); assert.match(r.j.error, /at most 10000/); assert.strictEqual(nM(), n1);
      // R15: an outline that doubles back (a spike) is refused
      r = await measure(P1, { row_id: rM, geom: { tool: 'area', outer: [[0, 0], [10, 0], [10, 10], [6, 10], [6, 20], [6, 10], [0, 10]], holes: [] }, metric: 'perimeter' });
      assert.strictEqual(r.s, 400); assert.match(r.j.error, /self-intersect/);

      // DXF: units first; then scale = UNIT_TO_M[units] (mm), no calibration, georeferenced coordinates exact
      const dx = await upload(T, 'Fake site', FIXTURE, qs);
      assert.strictEqual((await waitDone(dx.j.id, qs)).status, 'ready');
      const geo = { tool: 'polyline', pts: [[500000, 2700000], [503000, 2704000], [503000, 2704000.5]] };   // 5000.5 mm
      r = await measure(dx.j.id, { row_id: rDxf, geom: geo });
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'confirm the drawing units first');
      await ok(call('PUT', `drawings/${dx.j.id}/units`, { units: 'mm' }, qs), 'units');
      const mDxf = await ok(measure(dx.j.id, { row_id: rDxf, geom: geo }), 'dxf polyline');
      near(mDxf.qty, 5.0005, 'mm'); assert.strictEqual(mDxf.qty, TM.manualQty(geo, { scale: 0.001 }).qty); assert.strictEqual(mDxf.calibration_id, null);
      near(qtyOf(rDxf), 5.0005, 'dxf row');
      { const l = (await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list')).measurements.find(x => x.id === mDxf.id);
        assert.deepStrictEqual([l.scale, l.drawing_kind, l.drawing_units, l.calibration], [0.001, 'dxf', 'mm', null], 'DXF: the scale of its units'); }
      assert.deepStrictEqual((await call('GET', `drawings/${dx.j.id}`, null, viewer)).j.unit_to_m, require('./lib/units').UNIT_TO_M);
      const mDxf2 = await ok(measure(dx.j.id, { row_id: rDxf, geom: { tool: 'line', pts: [[0, 0], [5000, 0]] } }), 'dxf line');
      near(mDxf2.qty, 5, '5000 mm'); near(qtyOf(rDxf), 10.0005, 'dxf row');
      await ok(put(mDxf2.id, { factor: 2 }), 'dxf factor'); near(qtyOf(rDxf), 15.0005, 'dxf row after factor');
      // the DXF tools still refuse a manual measurement's fields
      assert.match((await call('POST', `drawings/${dx.j.id}/measurements`, { tool: 'dxf_layer', layer: 'KERB', metric: 'open_length', row_id: rDxf, geom: poly }, qs)).j.error, /unknown field/);

      // no coordinates anywhere in the audit
      for (const a of db.prepare("SELECT action, detail FROM audit_log WHERE id>? AND entity IN ('measurements','calibrations')").all(auditFrom))
        assert.ok(!/[[\]]/.test(a.detail || ''), a.action + ' ' + a.detail);

      // an approved tender: no manual measurement can be added, edited or deleted
      db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(T);
      const frozen = snap();
      assert.strictEqual((await measure(P1, { row_id: rM, geom: { tool: 'line', pts: [[0, 0], [0, 50]] } })).s, 409);
      assert.strictEqual((await put(mPoly.id, { factor: 5 })).s, 409);
      assert.strictEqual((await call('DELETE', `measurements/${mPoly.id}`, null, qs)).s, 409);
      assert.strictEqual(snap(), frozen, 'nothing changed');

      // revise: calibrations and manual measurements copied, drawings, rows and calibration_id remapped
      const rv = (await ok(call('POST', `tenders/${T}/revise`, null, qs), 'revise')).id;
      const od = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(T), nd = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(rv);
      const dmap = new Map(od.map((x, i) => [x.id, nd[i].id]));
      const calsOf = tid => db.prepare('SELECT c.* FROM calibrations c JOIN drawings d ON d.id=c.drawing_id WHERE d.tender_id=? ORDER BY c.id').all(tid);
      const oc = calsOf(T), nc = calsOf(rv);
      assert.strictEqual(nc.length, oc.length); assert.strictEqual(oc.length, 3);
      const cmap = new Map();
      oc.forEach((c, i) => {
        const n = nc[i];
        assert.strictEqual(n.drawing_id, dmap.get(c.drawing_id), 'calibration drawing remapped'); assert.notStrictEqual(n.id, c.id);
        for (const k of ['region', 'p1x', 'p1y', 'p2x', 'p2y', 'real', 'unit', 'scale', 'verify_pct', 'created', 'created_by']) assert.strictEqual(n[k], c[k], k);
        cmap.set(c.id, n.id);
      });
      const oRows = db.prepare('SELECT * FROM tender_rows WHERE tender_id=? ORDER BY seq, id').all(T), nRows = db.prepare('SELECT * FROM tender_rows WHERE tender_id=? ORDER BY seq, id').all(rv);
      const rmap = new Map(oRows.map((x, i) => [x.id, nRows[i].id]));
      const om = db.prepare("SELECT * FROM measurements WHERE tender_id=? AND tool='manual' ORDER BY id").all(T), nm = db.prepare("SELECT * FROM measurements WHERE tender_id=? AND tool='manual' ORDER BY id").all(rv);
      assert.strictEqual(nm.length, om.length); assert.strictEqual(om.length, 9);
      om.forEach((o, i) => {
        const n = nm[i];
        assert.strictEqual(n.drawing_id, dmap.get(o.drawing_id)); assert.strictEqual(n.row_id, rmap.get(o.row_id));
        assert.strictEqual(n.calibration_id, o.calibration_id === null ? null : cmap.get(o.calibration_id), 'calibration_id remapped');
        for (const k of ['geom', 'deduct', 'metric', 'width', 'depth', 'factor', 'label', 'qty', 'qty_unit', 'base']) assert.strictEqual(n[k], o[k], k);
      });
      for (const o of oRows) assert.strictEqual(nRows.find(x => x.seq === o.seq).qty, o.qty, 'Rev row qty = original');
      // the Rev re-calibrates on its own: only its own measurements are listed
      r = await call('POST', `drawings/${dmap.get(P1)}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs);
      assert.strictEqual(r.s, 409);
      assert.deepStrictEqual(r.j.changes.map(c => c.measurement_id), [nm[0].id, nm[2].id], 'the Rev polyline and deduction');

      // the browser loads the same formula file (one source)
      const mf = await fetch(`http://localhost:${server.address().port}/lib/takeoff/manual.js`);
      assert.strictEqual(mf.status, 200); assert.match(mf.headers.get('content-type'), /^text\/javascript/);
      assert.ok(Buffer.from(await mf.arrayBuffer()).equals(fs.readFileSync(path.join(__dirname, 'lib', 'takeoff', 'manual.js'))));
      for (const p of ['lib/takeoff/calib.js', 'lib/units.js', 'server.js', 'lib/takeoff/']) assert.strictEqual((await fetch(`http://localhost:${server.address().port}/${p}`)).status, 404, p);
    }

    // ---- final review I1: an imported row's measured total never goes below 0 (its client qty is never changed);
    // M4: a drawn measurement can be unlinked (PUT row_id: null) -----------------------------------------------------
    {
      const { makePdf, PDF_PAGES } = require('./test/fixtures/make-takeoff.js');
      const { writeXlsx } = require('./lib/xlsx.js');
      const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}: expected ≈${b}, got ${a}`);
      const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
      const T = (await ok(call('POST', 'tenders', { title: 'Test Imported Deductions', kind: 'rta' }, qs), 'tender')).id;
      const BOQ = { file_b64: writeXlsx([{ name: 'BOQ', rows: [['No', 'Description', 'Unit', 'Qty'], ['1', 'Fake imported kerb', 'm', 50]] }]).toString('base64'),
        sheet: 'BOQ', header_row: 1, cols: { no: 'A', desc: 'B', unit: 'C', qty: 'D' } };
      await ok(call('POST', `tenders/${T}/import`, BOQ, qs), 'import');
      const rowsOf = async () => ok(call('GET', `tenders/${T}/rows`, null, viewer), 'rows');
      const rI = (await rowsOf()).find(r => r.description === 'Fake imported kerb').id;
      const rT = (await ok(call('POST', `tenders/${T}/rows`, { description: 'Fake take-off kerb', unit: 'm' }, qs), 'take-off row')).id;
      const pdfUp = await upload(T, 'Fake deduction sheet', makePdf(), qs);
      const [P1] = (await ok(call('POST', `drawings/${pdfUp.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs), 'pages')).drawings.map(x => x.id);
      await ok(call('POST', `drawings/${P1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs), 'calibrate');   // 0.05 m/unit
      const measure = b => call('POST', `drawings/${P1}/measurements`, { tool: 'manual', ...b }, qs);
      const put = (id, b) => call('PUT', `measurements/${id}`, b, qs);
      const line = (y, len) => ({ tool: 'line', pts: [[0, y], [len, y]] });
      const qtyOf = id => db.prepare('SELECT qty FROM tender_rows WHERE id=?').get(id).qty;
      const mRow = id => db.prepare('SELECT * FROM measurements WHERE id=?').get(id);
      const snap = () => JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(T), db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(P1),
        db.prepare('SELECT id, qty FROM tender_rows WHERE tender_id=? ORDER BY id').all(T)]);
      const measuredOf = async id => (await rowsOf()).find(r => r.id === id).measured_qty;
      const refused = (r, msg) => { assert.strictEqual(r.s, 400, msg + ': ' + JSON.stringify(r.j)); assert.match(r.j.error, /deductions exceed the measured quantity/, msg); };

      // a deduction alone on an imported row → 400, nothing saved
      let s0 = snap();
      refused(await measure({ row_id: rI, geom: line(100, 20), deduct: true }), 'deduction only');
      assert.strictEqual(snap(), s0, 'nothing saved');
      // 5 m − 1 m: saved, measured 4, the client qty stays 50
      const mPos = await ok(measure({ row_id: rI, geom: line(100, 100) }), 'positive');
      const mDed = await ok(measure({ row_id: rI, geom: line(200, 20), deduct: true }), 'deduction');
      assert.strictEqual(mDed.row_qty, null, 'an imported row qty is not recomputed');
      near(await measuredOf(rI), 4, 'measured'); assert.strictEqual(qtyOf(rI), 50, 'client qty unchanged');
      // deleting the positive measurement would leave only the deduction → 400, nothing deleted
      s0 = snap();
      refused(await call('DELETE', `measurements/${mPos.id}`, null, qs), 'delete leaving a deduction');
      // unlinking it (M4) likewise; a deduction made bigger than the rest likewise
      refused(await put(mPos.id, { row_id: null }), 'unlink leaving a deduction');
      refused(await put(mDed.id, { factor: 6 }), 'deduction × 6');
      assert.strictEqual(snap(), s0, 'nothing changed');
      // PUT moving a deduction from a take-off row onto the imported row (4 − 6 < 0) → 400, it stays where it was
      const tPos = await ok(measure({ row_id: rT, geom: line(300, 200) }), 'take-off positive');
      const tDed = await ok(measure({ row_id: rT, geom: line(400, 120), deduct: true }), 'take-off deduction');
      near(qtyOf(rT), 4, 'take-off row 10 − 6');
      s0 = snap();
      refused(await put(tDed.id, { row_id: rI }), 'relink a deduction onto the imported row');
      assert.strictEqual(snap(), s0, 'nothing moved'); assert.strictEqual(mRow(tDed.id).row_id, rT);
      // a region that rescales the positive one below the deduction: the apply is refused, nothing stored
      const reg = { region: [0, 90, 120, 110], p1: [0, 95], p2: [100, 95], real: 0.5, unit: 'm' };   // 0.005 m/unit: 5 m → 0.5 m
      let r = await call('POST', `drawings/${P1}/calibrations`, reg, qs);
      assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.deepStrictEqual(r.j.changes.map(c => c.measurement_id), [mPos.id]);
      refused(await call('POST', `drawings/${P1}/calibrations`, { ...reg, apply: true, expect: r.j.changes.map(c => ({ measurement_id: c.measurement_id, new_qty: c.new_qty })) }, qs), 'region apply');
      assert.strictEqual(snap(), s0, 'no region, nothing rescaled');
      // the take-off rule is unchanged: below 0 refused, 0 and above fine
      assert.match((await put(tPos.id, { row_id: null })).j.error, /take-off total would be -6/);
      // M4: a drawn measurement unlinked → row_id NULL, the row recomputed, listed as unlinked, audited; linked again
      const u = await ok(put(tDed.id, { row_id: null }), 'unlink');
      assert.strictEqual(mRow(tDed.id).row_id, null); assert.strictEqual(u.row_qty, null); near(u.old_row_qty, 10, 'old row'); near(qtyOf(rT), 10, 'take-off row without the deduction');
      const lst = await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list');
      assert.ok(lst.unlinked.some(x => x.id === tDed.id) && !lst.measurements.some(x => x.id === tDed.id), 'listed as unlinked');
      const a = JSON.parse(db.prepare("SELECT detail FROM audit_log WHERE action='measure_edit' ORDER BY id DESC LIMIT 1").get().detail);
      assert.strictEqual(a.row_id, null); assert.strictEqual(a.from_row_id, rT);
      await ok(put(tDed.id, { row_id: rT }), 'link again'); near(qtyOf(rT), 4, 'linked again');
      assert.match((await put(tPos.id, { row_id: 'x' })).j.error, /row_id/, 'row_id: a row id or null');
    }

    // ---- batch 4 Task 1: changing the units of a measured DXF goes through before/after (R18 expect) ------------------
    {
      const { writeXlsx } = require('./lib/xlsx.js');
      const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
      const rel = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)), `${msg}: expected ≈${b}, got ${a}`);
      const audits = action => db.prepare("SELECT detail FROM audit_log WHERE action=? ORDER BY id").all(action).map(a => JSON.parse(a.detail));
      // KERB: one line of 5000 units (5 m in mm); ASPHALT: a 10000-unit square (100 m2 in mm); MH: one MH1 insert
      const FIXU = dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...tables([layerRec('KERB'), layerRec('ASPHALT'), layerRec('MH')]),
        ...sec('BLOCKS', [[0, 'BLOCK'], [2, 'MH1'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK']]),
        ...sec('ENTITIES', [...line('UK', 'KERB', 0, 0, 3000, 4000), ...lwp('UA', sq(0, 0, 10000), true, 'ASPHALT'), ...insert('UM', 'MH1', 'MH')])]);
      const T = (await ok(call('POST', 'tenders', { title: 'Test Unit Change', kind: 'rta' }, qs), 'tender')).id;
      const BOQ = { file_b64: writeXlsx([{ name: 'BOQ', rows: [['No', 'Description', 'Unit', 'Qty'], ['1', 'Fake imported asphalt', 'm2', 95]] }]).toString('base64'),
        sheet: 'BOQ', header_row: 1, cols: { no: 'A', desc: 'B', unit: 'C', qty: 'D' } };
      await ok(call('POST', `tenders/${T}/import`, BOQ, qs), 'import');
      const rowsOf = async () => ok(call('GET', `tenders/${T}/rows`, null, viewer), 'rows');
      const rI = (await rowsOf()).find(r => r.description === 'Fake imported asphalt').id;
      const newRow = async (description, unit) => (await ok(call('POST', `tenders/${T}/rows`, { description, unit }, qs), 'row ' + description)).id;
      const rM = await newRow('Fake kerb', 'm'), rM2 = await newRow('Fake paving', 'm2'), rM3 = await newRow('Fake concrete', 'm3'), rNr = await newRow('Fake manholes', 'nr');
      const up = await upload(T, 'Fake unit plan', Buffer.from(FIXU), qs);
      assert.strictEqual(up.s, 202);
      const D = up.j.id;
      assert.strictEqual((await waitDone(D, qs)).status, 'ready');
      await ok(call('PUT', `drawings/${D}/units`, { units: 'mm' }, qs), 'units mm');
      const measure = (b, did = D) => ok(call('POST', `drawings/${did}/measurements`, { confirm_overlap: true, ...b }, qs), 'measure ' + JSON.stringify(b).slice(0, 80));
      const kerb = { tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' }, asph = { tool: 'dxf_layer', layer: 'ASPHALT', metric: 'area' };
      const mLayer = await measure({ row_id: rM, ...kerb, label: 'Fake kerb layer' });
      const mVolL = await measure({ row_id: rM3, ...kerb, width: 0.5, depth: 0.2 });   // m × width × depth (metres): scales by k
      const mArea = await measure({ row_id: rI, ...asph });                           // m2 on the imported row: scales by k²
      const mVolA = await measure({ row_id: rM3, ...asph, depth: 0.1 });               // m2 × depth (metres): scales by k²
      const mSelL = await measure({ row_id: rM, tool: 'dxf_selection', metric: 'open_length', handles: ['UK'] });
      const mSelA = await measure({ row_id: rM2, tool: 'dxf_selection', metric: 'area', handles: ['UA'] });
      const mPoly = await measure({ row_id: rM, tool: 'manual', geom: { tool: 'polyline', pts: [[0, 0], [1000, 0], [1000, 1000]] } });
      const mRect = await measure({ row_id: rM2, tool: 'manual', geom: { tool: 'rect', p1: [0, 0], p2: [2000, 1000] } });
      const mPer = await measure({ row_id: rM, tool: 'dxf_layer', layer: 'ASPHALT', metric: 'closed_perimeter' });     // closed perimeter: k
      const mFac = await measure({ row_id: rM, ...kerb, factor: 2 });                                                  // factor ≠ 1: k
      const mMPer = await measure({ row_id: rM, tool: 'manual', metric: 'perimeter', geom: { tool: 'rect', p1: [0, 0], p2: [2000, 1000] } });   // manual perimeter: k
      const mMVol = await measure({ row_id: rM3, tool: 'manual', width: 0.5, depth: 0.2, geom: { tool: 'polyline', pts: [[0, 0], [1000, 0], [1000, 1000]] } });   // manual × width × depth: k
      const mDed = await measure({ row_id: rM, tool: 'manual', deduct: true, geom: { tool: 'line', pts: [[0, 2000], [500, 2000]] } });   // a deduction: k, stays negative
      // counts: never listed (a count does not depend on the units)
      const mBlk = await measure({ row_id: rNr, tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count' });
      const mSelC = await measure({ row_id: rNr, tool: 'dxf_selection', metric: 'count', handles: ['UM'] });
      const mCnt = await measure({ row_id: rNr, tool: 'manual', geom: { tool: 'count', pts: [[5, 5], [6, 6]] } });
      rel(mLayer.qty, 5, 'KERB 5000 mm = 5 m'); rel(mVolL.qty, 0.5, 'm3 from a length'); rel(mArea.qty, 100, 'ASPHALT 100 m2'); rel(mVolA.qty, 10, 'm3 from an area');
      rel(mSelL.qty, 5, 'selection length'); rel(mSelA.qty, 100, 'selection area'); rel(mPoly.qty, 2, 'polyline'); rel(mRect.qty, 2, 'rect');
      rel(mPer.qty, 40, 'closed perimeter'); rel(mFac.qty, 10, 'factor 2'); rel(mMPer.qty, 6, 'manual perimeter'); rel(mMVol.qty, 0.2, 'manual m3'); rel(mDed.qty, -0.5, 'deduction');
      const mRow = id => db.prepare('SELECT * FROM measurements WHERE id=?').get(id);
      const qtyOf = id => db.prepare('SELECT qty FROM tender_rows WHERE id=?').get(id).qty;
      const snap = () => JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(T), db.prepare('SELECT id, qty FROM tender_rows WHERE tender_id=? ORDER BY id').all(T),
        db.prepare('SELECT units FROM drawings WHERE id=?').get(D)]);
      const s0 = snap(), nUnits = audits('units').length;
      // 1. mm → m: 409 with every non-count measurement, new_qty from the creation code with the new unit
      //    (lengths × 1000, areas × 1000², volumes from a length × 1000, from an area × 1000²); nothing changed
      let r = await call('PUT', `drawings/${D}/units`, { units: 'm' }, qs);
      assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'unit change changes measured quantities');
      assert.strictEqual(r.j.from, 'mm'); assert.strictEqual(r.j.to, 'm');
      const k = 1000, want = [[mLayer, rM, k], [mVolL, rM3, k], [mArea, rI, k * k], [mVolA, rM3, k * k], [mSelL, rM, k], [mSelA, rM2, k * k], [mPoly, rM, k], [mRect, rM2, k * k],
        [mPer, rM, k], [mFac, rM, k], [mMPer, rM, k], [mMVol, rM3, k], [mDed, rM, k]];
      assert.deepStrictEqual(r.j.changes.map(c => c.measurement_id), want.map(([m]) => m.id), 'every non-count measurement, counts excluded');
      for (const [i, [m, row, f]] of want.entries()) {
        const c = r.j.changes[i];
        assert.deepStrictEqual(Object.keys(c).sort(), ['measurement_id', 'new_qty', 'old_qty', 'row_id']);
        assert.strictEqual(c.row_id, row); assert.strictEqual(c.old_qty, m.qty); rel(c.new_qty, m.qty * f, 'new qty of ' + m.id);
      }
      assert.strictEqual(snap(), s0, 'nothing changed without apply'); assert.strictEqual(audits('units').length, nUnits);
      const expectOf = changes => changes.map(c => ({ measurement_id: c.measurement_id, new_qty: c.new_qty }));
      const reviewedList = expectOf(r.j.changes);
      // 3. apply without expect → 400 (and the other malformed bodies); a viewer → 403; nothing changed
      for (const [b, re] of [[{ units: 'm', apply: true }, /needs expect/], [{ units: 'm', expect: reviewedList }, /goes with apply/], [{ units: 'm', apply: 'yes', expect: reviewedList }, /apply must be true or false/],
        [{ units: 'm', apply: true, expect: [{ measurement_id: mLayer.id }] }, /new_qty/], [{ units: 'm', apply: true, expect: reviewedList, x: 1 }, /unknown field/]]) {
        const x = await call('PUT', `drawings/${D}/units`, b, qs);
        assert.strictEqual(x.s, 400, JSON.stringify(b)); assert.match(x.j.error, re, JSON.stringify(b));
      }
      assert.strictEqual((await call('PUT', `drawings/${D}/units`, { units: 'm', apply: true, expect: reviewedList }, viewer)).s, 403);
      assert.strictEqual(snap(), s0, 'nothing changed by a refused apply');
      // 4. a measurement saved between the review and Apply → 409 with the fresh list (it is in it); a changed qty → 409 too
      const mLate = await measure({ row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[0, 0], [0, 400]] } });
      const s1 = snap();
      r = await call('PUT', `drawings/${D}/units`, { units: 'm', apply: true, expect: reviewedList }, qs);
      assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'the measured quantities changed: review the changes again');
      assert.deepStrictEqual(r.j.changes.map(c => c.measurement_id), [...want.map(([m]) => m.id), mLate.id], 'the fresh list');
      rel(r.j.changes.at(-1).new_qty, mLate.qty * k, 'the late one');
      const fresh = expectOf(r.j.changes);
      r = await call('PUT', `drawings/${D}/units`, { units: 'm', apply: true, expect: fresh.map((x, i) => i ? x : { ...x, new_qty: x.new_qty * 2 }) }, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(snap(), s1, 'nothing changed');
      // 4b. the race guard: a measurement saved inside the async window (after the recomputation, before the tx) is caught:
      //     409 with the fresh list that includes it, nothing changed (without the in-tx check the reviewed list would apply)
      let mWin = null, sWin = null;
      ctx.drawings._hooks.beforeUnitTx = async attempt => {
        if (attempt !== 0) return;
        mWin = await measure({ row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[0, 3000], [300, 3000]] } });
        sWin = snap();
      };
      try { r = await call('PUT', `drawings/${D}/units`, { units: 'm', apply: true, expect: fresh }, qs); }
      finally { ctx.drawings._hooks.beforeUnitTx = null; }
      assert.ok(mWin, 'the hook ran inside the window');
      assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'the measured quantities changed: review the changes again');
      assert.deepStrictEqual(r.j.changes.map(c => c.measurement_id), [...fresh.map(x => x.measurement_id), mWin.id], 'the fresh list has the one saved in the window');
      rel(r.j.changes.at(-1).new_qty, mWin.qty * k, 'its new qty');
      assert.strictEqual(snap(), sWin, 'nothing changed by the refused apply');
      const finalChanges = r.j.changes, fresh2 = expectOf(finalChanges);
      // 2. apply with the reviewed list: units, measurements and rows in one go; 6. the rows are recomputed (the imported
      //    row too: its client qty stays, its measured total is checked)
      const real = ctx.tenders.recomputeTakeoffQty, seen = [];
      ctx.tenders.recomputeTakeoffQty = id => { seen.push(id); return real(id); };
      let applied;
      try { applied = await ok(call('PUT', `drawings/${D}/units`, { units: 'm', apply: true, expect: fresh2 }, qs), 'apply'); }
      finally { ctx.tenders.recomputeTakeoffQty = real; }
      assert.strictEqual(applied.units, 'm'); assert.strictEqual(applied.changes.length, 15);
      assert.deepStrictEqual([...new Set(seen)].sort((a, b) => a - b), [rI, rM, rM2, rM3].sort((a, b) => a - b), 'every row of a changed measurement recomputed');
      for (const c of fresh2) { const m = mRow(c.measurement_id); assert.strictEqual(m.qty, c.new_qty, 'stored as reviewed'); }
      rel(mRow(mLayer.id).base, 5000, 'layer base in m'); rel(mRow(mSelA.id).base, 1e8, 'selection base m2'); rel(mRow(mDed.id).qty, -500, 'deduction × 1000, still negative');
      const rowSum = row => finalChanges.filter(c => c.row_id === row).reduce((a, c) => a + c.new_qty, 0);
      for (const row of [rM, rM2, rM3]) rel(qtyOf(row), rowSum(row), 'take-off row ' + row + ' = Σ its new quantities');
      rel(qtyOf(rM), 5000 + 5000 + 2000 + 40000 + 10000 + 6000 - 500 + 400 + 300, 'm row'); rel(qtyOf(rM2), 1e8 + 2e6, 'm2 row'); rel(qtyOf(rM3), 500 + 1e7 + 200, 'm3 row');
      assert.strictEqual(qtyOf(rI), 95, 'the client qty never changes');
      rel((await rowsOf()).find(x => x.id === rI).measured_qty, 1e8, 'imported row measured total');
      for (const m of [mBlk, mSelC, mCnt]) assert.strictEqual(mRow(m.id).qty, m.qty, 'counts unchanged');
      assert.strictEqual(qtyOf(rNr), mBlk.qty + mSelC.qty + mCnt.qty);
      assert.deepStrictEqual(audits('units').at(-1), { from: 'mm', to: 'm', changed: 15, rows: 4 }, 'audit: a summary only');
      // the same numbers as measuring again in the new units (the creation code)
      for (const [m, b] of [[mLayer, { row_id: rM, ...kerb }], [mVolL, { row_id: rM3, ...kerb, width: 0.5, depth: 0.2 }], [mArea, { row_id: rM2, ...asph }], [mVolA, { row_id: rM3, ...asph, depth: 0.1 }],
        [mSelA, { row_id: rM2, tool: 'dxf_selection', metric: 'area', handles: ['UA'] }], [mRect, { row_id: rM2, tool: 'manual', geom: { tool: 'rect', p1: [0, 0], p2: [2000, 1000] } }],
        [mPer, { row_id: rM, tool: 'dxf_layer', layer: 'ASPHALT', metric: 'closed_perimeter' }], [mFac, { row_id: rM, ...kerb, factor: 2 }],
        [mMPer, { row_id: rM, tool: 'manual', metric: 'perimeter', geom: { tool: 'rect', p1: [0, 0], p2: [2000, 1000] } }],
        [mMVol, { row_id: rM3, tool: 'manual', width: 0.5, depth: 0.2, geom: { tool: 'polyline', pts: [[0, 0], [1000, 0], [1000, 1000]] } }],
        [mDed, { row_id: rM, tool: 'manual', deduct: true, geom: { tool: 'line', pts: [[0, 2000], [500, 2000]] } }]]) {
        const again = await measure(b);
        assert.strictEqual(again.qty, mRow(m.id).qty, 'measured again in m: ' + JSON.stringify(b).slice(0, 60));
        await ok(call('DELETE', 'measurements/' + again.id, null, qs), 'tidy');
      }
      // the same units again: a no-op (nothing to review, nothing stored, no audit)
      const s2 = snap(), nU2 = audits('units').length;
      assert.strictEqual((await ok(call('PUT', `drawings/${D}/units`, { units: 'm' }, qs), 'same units')).changes.length, 0);
      assert.strictEqual(snap(), s2); assert.strictEqual(audits('units').length, nU2, 'no audit for the same units');
      // a drawing with counts only: nothing to review, the units change at once (5. counts are never listed)
      const up2 = await upload(T, 'Fake count plan', Buffer.from(FIXU), qs);
      assert.strictEqual((await waitDone(up2.j.id, qs)).status, 'ready');
      await ok(call('PUT', `drawings/${up2.j.id}/units`, { units: 'mm' }, qs), 'units mm');
      const c2 = await measure({ row_id: rNr, tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count' }, up2.j.id);
      const u2 = await ok(call('PUT', `drawings/${up2.j.id}/units`, { units: 'cm' }, qs), 'counts only');
      assert.strictEqual(u2.units, 'cm'); assert.deepStrictEqual(u2.changes, []); assert.strictEqual(mRow(c2.id).qty, c2.qty);
      // a quantity that cannot be recomputed the same way (an entity of the selection is no longer in the drawing) stops the
      // change: 409 with the reason, nothing changed
      const sx = await measure({ row_id: rM, tool: 'dxf_selection', metric: 'open_length', handles: ['UK'] }, up2.j.id);
      db.prepare("INSERT INTO measurement_handles(measurement_id, handle, geom_key) VALUES(?, 'GONE', NULL)").run(sx.id);
      db.prepare('UPDATE measurements SET handles_count=handles_count+1 WHERE id=?').run(sx.id);
      const rowBefore = qtyOf(rM);
      r = await call('PUT', `drawings/${up2.j.id}/units`, { units: 'm' }, qs);
      assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, `measurement ${sx.id} cannot be recomputed at the new scale (calibration or units)`);
      assert.strictEqual(db.prepare('SELECT units FROM drawings WHERE id=?').get(up2.j.id).units, 'cm'); assert.strictEqual(mRow(sx.id).qty, sx.qty); assert.strictEqual(qtyOf(rM), rowBefore);
    }

    // ---- batch 4 Task 2: a revised drawing is uploaded as a pending replacement; the before/after comparison (read only) ---
    {
      const { makePdf, PDF_PAGES, makeOffsetPdf, OFFSET_PAGE, makePng } = require('./test/fixtures/make-takeoff.js');
      const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
      const rel = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)), `${msg}: expected ≈${b}, got ${a}`);
      const audits = action => db.prepare("SELECT detail FROM audit_log WHERE action=? ORDER BY id").all(action).map(a => JSON.parse(a.detail));
      const replace = async (did, name, body, ck = qs) => {
        const r = await fetch(base + `drawings/${did}/replace?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: ck }, body });
        return { s: r.status, j: await r.json().catch(() => null) };
      };
      const PENDING = 'a replacement is pending: accept or cancel it first', IS_PENDING = 'this drawing is a pending replacement: accept or cancel it first';
      // Task 3
      const REPLACED = 'this drawing has been replaced by a newer version: it is kept as history only', REVIEW = 'the measured quantities changed: review the changes again';
      // batch 4 Task 4, R14: a relink / keep_matched sent with new_qty null is a probe: its own code and message
      const PREVIEW = 'check what the chosen resolutions give, then accept again';
      // R18b: the row totals a preview gives, by hand: Σ per row and unit of the items' qty after accept (a deleted one 0,
      // a resolved one its resolved qty)
      const handTotals = (items, resolved) => {
        const rv = new Map(resolved.map(x => [x.measurement_id, x])), out = new Map();
        for (const it of items) {
          if (it.row_id === null) continue;
          const k = it.row_id + '/' + it.qty_unit, x = out.get(k) || { row_id: it.row_id, qty_unit: it.qty_unit, old: 0, new: 0 }, r = rv.get(it.measurement_id);
          x.old += it.old_qty; x.new += r ? (r.resolution === 'delete' ? 0 : r.new_qty) : it.new_qty;
          out.set(k, x);
        }
        return [...out.values()];
      };
      const ACCEPT = (did, b, ck = qs) => call('POST', `drawings/${did}/accept`, b, ck);
      // the reviewed table: every item with the qty shown, plus the resolutions by measurement id
      const expOf = (items, o = {}) => items.map(x => ({ measurement_id: x.measurement_id, new_qty: x.new_qty, ...(o[x.measurement_id] || {}) }));
      const nPending = () => db.prepare('SELECT COUNT(*) n FROM drawings WHERE pending=1').get().n;
      const dRow = id => ({ ...db.prepare('SELECT * FROM drawings WHERE id=?').get(id) });
      // v1 (mm): KERB a 5000 line, ASPHALT a 10000 square, MH one MH1, EDGE E1 (1000) and E2 (2000).
      // v2: ASPHALT renamed PAVING, one more MH1 on MH, E1 moved (same length, other geometry: its geomKey changes).
      const insertAt = (h, name, layer, x, y) => [[0, 'INSERT'], [5, h], [8, layer], [2, name], [10, x], [20, y]];
      const plan = v2 => dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]),
        ...tables([layerRec('KERB'), layerRec(v2 ? 'PAVING' : 'ASPHALT'), layerRec('MH'), layerRec('EDGE')]),
        ...sec('BLOCKS', [[0, 'BLOCK'], [2, 'MH1'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK']]),
        ...sec('ENTITIES', [...line('RK', 'KERB', 0, 0, 3000, 4000), ...lwp('RA', sq(0, 0, 10000), true, v2 ? 'PAVING' : 'ASPHALT'),
          ...insertAt('RM1', 'MH1', 'MH', 100, 100), ...(v2 ? insertAt('RM2', 'MH1', 'MH', 900, 900) : []),
          ...(v2 ? line('E1', 'EDGE', 500, 500, 1500, 500) : line('E1', 'EDGE', 0, 0, 1000, 0)), ...line('E2', 'EDGE', 0, 100, 2000, 100)])]);
      const T = (await ok(call('POST', 'tenders', { title: 'Test Revisions', kind: 'rta' }, qs), 'tender')).id;
      const newRow = async (description, unit) => (await ok(call('POST', `tenders/${T}/rows`, { description, unit }, qs), 'row ' + description)).id;
      const rM = await newRow('Fake kerb', 'm'), rM2 = await newRow('Fake paving', 'm2'), rNr = await newRow('Fake manholes', 'nr');
      const up = await upload(T, 'Fake site plan', Buffer.from(plan(false)), qs);
      assert.strictEqual(up.s, 202);
      const D1 = up.j.id;
      assert.strictEqual((await waitDone(D1, qs)).status, 'ready');
      await ok(call('PUT', `drawings/${D1}/units`, { units: 'mm' }, qs), 'units mm');
      const measure = (b, did = D1, ck = qs) => call('POST', `drawings/${did}/measurements`, { confirm_overlap: true, ...b }, ck);
      const mOk = async (b, did) => ok(measure(b, did), 'measure ' + JSON.stringify(b).slice(0, 60));
      const mLayer = await mOk({ row_id: rM, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length', label: 'Fake kerb layer' });
      const mArea = await mOk({ row_id: rM2, tool: 'dxf_layer', layer: 'ASPHALT', metric: 'area' });
      const mBlk = await mOk({ row_id: rNr, tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count' });
      const mSel = await mOk({ row_id: rM, tool: 'dxf_selection', metric: 'open_length', handles: ['E1', 'E2'] });
      const mMan = await mOk({ row_id: rM, tool: 'manual', geom: { tool: 'polyline', pts: [[0, 0], [1000, 0], [1000, 1000]] }, label: 'Fake drawn edge' });
      rel(mLayer.qty, 5, 'kerb'); rel(mArea.qty, 100, 'asphalt'); assert.strictEqual(mBlk.qty, 1); rel(mSel.qty, 3, 'selection'); rel(mMan.qty, 2, 'manual');
      // a selection stores each handle's geomKey when it is created (the replacement compare matches on handle AND geomKey)
      const keys = db.prepare('SELECT handle, geom_key FROM measurement_handles WHERE measurement_id=? ORDER BY rowid').all(mSel.id);
      assert.deepStrictEqual(keys.map(k => k.handle), ['E1', 'E2']); assert.ok(keys.every(k => typeof k.geom_key === 'string' && k.geom_key), 'geomKeys stored');
      const snap = () => JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(T), db.prepare('SELECT * FROM measurement_handles ORDER BY rowid').all(),
        db.prepare('SELECT id, qty FROM tender_rows WHERE tender_id=? ORDER BY id').all(T), db.prepare('SELECT * FROM calibrations ORDER BY id').all(), db.prepare("SELECT id, units FROM drawings WHERE pending=0 ORDER BY id").all()]);

      // refusals before anything is stored: a viewer, the wrong kind (by name before the body; by content after it), no name,
      // a missing drawing
      const V2 = Buffer.from(plan(true));
      assert.strictEqual((await replace(D1, 'Fake site plan B', V2, viewer)).s, 403, 'viewer → 403 on replace');
      let r = await replace(D1, 'Fake site plan B.pdf', V2);
      assert.strictEqual(r.s, 400); assert.strictEqual(r.j.error, 'a new version of a DXF drawing must be a DXF file');
      r = await replace(D1, 'Fake site plan B', makePdf());
      assert.strictEqual(r.s, 400); assert.strictEqual(r.j.error, 'a new version of a DXF drawing must be a DXF file');
      assert.strictEqual((await replace(D1, '', V2)).s, 400, 'name is required');
      assert.strictEqual((await replace(999999, 'x', V2)).s, 404);
      assert.strictEqual(nPending(), 0, 'nothing stored');

      // Review Focus 3, inside the window: a unit change computed before the replacement was uploaded is refused in its tx
      r = await call('PUT', `drawings/${D1}/units`, { units: 'cm' }, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'unit change changes measured quantities');
      const unitExpect = r.j.changes.map(c => ({ measurement_id: c.measurement_id, new_qty: c.new_qty }));
      const s0 = snap();
      let v2 = null;
      ctx.drawings._hooks.beforeUnitTx = async attempt => { if (attempt === 0 && !v2) v2 = await replace(D1, 'Fake site plan B', V2); };
      try { r = await call('PUT', `drawings/${D1}/units`, { units: 'cm', apply: true, expect: unitExpect }, qs); }
      finally { ctx.drawings._hooks.beforeUnitTx = null; }
      assert.ok(v2, 'the hook ran'); assert.strictEqual(v2.s, 202, JSON.stringify(v2.j));
      assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, PENDING);
      assert.strictEqual(snap(), s0, 'the units and quantities of the old drawing are unchanged');

      // the new row: pending, replaces D1, rev + 1, audited as an upload that replaces D1
      const N = v2.j.id;
      let n = dRow(N);
      assert.strictEqual(n.pending, 1); assert.strictEqual(n.replaces_id, D1); assert.strictEqual(n.rev, dRow(D1).rev + 1); assert.strictEqual(n.kind, 'dxf'); assert.strictEqual(n.units, null);
      assert.strictEqual(dRow(D1).pending, 0); assert.strictEqual(dRow(D1).replaced_by, null);
      assert.deepStrictEqual(audits('upload').at(-1), { name: 'Fake site plan B', bytes: V2.length, sha256: n.sha256, replaces: D1 });
      assert.strictEqual((await waitDone(N, qs)).status, 'ready');
      // not a normal row of the list: listed under the drawing it replaces
      let list = await ok(call('GET', `tenders/${T}/drawings`, null, viewer), 'list');
      assert.deepStrictEqual(list.map(x => x.id), [D1]);
      assert.strictEqual(list[0].pending_replacement.id, N); assert.strictEqual(list[0].pending_replacement.rev, 2);
      // only one pending replacement per drawing; a pending row is not replaced itself
      r = await replace(D1, 'Fake site plan C', V2);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'this drawing already has a pending replacement: accept or cancel it first');
      r = await replace(N, 'Fake site plan C', V2);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, IS_PENDING);
      assert.strictEqual(nPending(), 1);

      // Review Focus 3: while the replacement is pending, nothing on the old drawing is measured, edited, deleted, relinked
      // or rescaled (409), and nothing is measured on the pending one
      const s1 = snap();
      for (const [what, p] of [
        ['layer', measure({ row_id: rM, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' })],
        ['block', measure({ row_id: rNr, tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count' })],
        ['selection', measure({ row_id: rM, tool: 'dxf_selection', metric: 'open_length', handles: ['E2'] })],
        ['manual', measure({ row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[0, 0], [0, 500]] } })],
        ['relink', call('PUT', `measurements/${mLayer.id}`, { row_id: rM2, confirm_uom: true }, qs)],
        ['relink a selection', call('PUT', `measurements/${mSel.id}`, { row_id: rNr }, qs)],
        ['edit manual', call('PUT', `measurements/${mMan.id}`, { label: 'Fake edited' }, qs)],
        ['delete', call('DELETE', `measurements/${mBlk.id}`, null, qs)],
        ['delete manual', call('DELETE', `measurements/${mMan.id}`, null, qs)],
        ['units', call('PUT', `drawings/${D1}/units`, { units: 'cm' }, qs)],
        ['units apply', call('PUT', `drawings/${D1}/units`, { units: 'cm', apply: true, expect: unitExpect }, qs)]]) {
        const x = await p;
        assert.strictEqual(x.s, 409, what + ': ' + JSON.stringify(x.j)); assert.strictEqual(x.j.error, PENDING, what);
      }
      for (const b of [{ row_id: rM, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' }, { row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[0, 0], [0, 500]] } }]) {
        const x = await measure(b, N);
        assert.strictEqual(x.s, 409, JSON.stringify(x.j)); assert.strictEqual(x.j.error, IS_PENDING);
      }
      assert.strictEqual(snap(), s1, 'nothing changed');

      // compare: any reader; DXF waits for its parse and for confirmed units (pre-filled from the old drawing's)
      const cmp = async (ck = viewer) => ok(call('GET', `drawings/${N}/compare`, null, ck), 'compare');
      assert.deepStrictEqual(await cmp(), { ready: true, needs_units: true, old_units: 'mm', items: [], totals: { rows: [] } });
      db.prepare("UPDATE drawings SET status='parsing' WHERE id=?").run(N);
      try { assert.deepStrictEqual(await cmp(), { ready: false, needs_units: true, old_units: 'mm', items: [], totals: { rows: [] } }); }
      finally { db.prepare("UPDATE drawings SET status='ready' WHERE id=?").run(N); }
      r = await call('GET', `drawings/${D1}/compare`, null, viewer);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'this drawing is not a pending replacement');
      assert.strictEqual((await call('PUT', `drawings/${N}/units`, { units: 'mm' }, viewer)).s, 403);
      await ok(call('PUT', `drawings/${N}/units`, { units: 'mm' }, qs), 'units of the pending drawing');
      const nAudit = db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, s2 = snap();
      let c = await cmp();
      assert.strictEqual(c.ready, true); assert.strictEqual(c.needs_units, false);
      const byId = new Map(c.items.map(x => [x.measurement_id, x]));
      assert.deepStrictEqual(c.items.map(x => x.measurement_id), [mLayer, mArea, mBlk, mSel, mMan].map(x => x.id));
      // KERB: the same metric on the same layer → same
      assert.deepStrictEqual(byId.get(mLayer.id), { measurement_id: mLayer.id, row_id: rM, tool: 'dxf_layer', label: 'Fake kerb layer', old_qty: mLayer.qty, new_qty: mLayer.qty, qty_unit: 'm', status: 'same', options: [] });
      // ASPHALT renamed → blocked, relink to PAVING (the one layer with an area)
      assert.deepStrictEqual(byId.get(mArea.id), { measurement_id: mArea.id, row_id: rM2, tool: 'dxf_layer', label: null, old_qty: mArea.qty, new_qty: null, qty_unit: 'm2',
        status: 'blocked', reason: 'layer_missing', options: ['delete', 'relink'], relink_choices: ['PAVING'] });
      // one more MH1 → changed, 1 → 2
      assert.deepStrictEqual(byId.get(mBlk.id), { measurement_id: mBlk.id, row_id: rNr, tool: 'dxf_blocks', label: null, old_qty: 1, new_qty: 2, qty_unit: 'nr', status: 'changed', options: [] });
      // E1 moved: the same handle and the same length, but other geometry → blocked (never its old qty); keep_matched = E2 (2 m)
      assert.deepStrictEqual(byId.get(mSel.id), { measurement_id: mSel.id, row_id: rM, tool: 'dxf_selection', label: null, old_qty: mSel.qty, new_qty: null, qty_unit: 'm',
        status: 'blocked', reason: 'geometry_changed', options: ['delete', 'keep_matched'], keep_matched_qty: 2 });
      // manual: carried over, to be checked; its qty recomputed with the new drawing's units
      assert.deepStrictEqual(byId.get(mMan.id), { measurement_id: mMan.id, row_id: rM, tool: 'manual', label: 'Fake drawn edge', old_qty: mMan.qty, new_qty: mMan.qty, qty_unit: 'm',
        status: 'review', reason: 'manual_check', options: ['mark_reviewed'] });
      // row totals of this drawing's measurements: new is unknown while a row has a blocked item
      assert.deepStrictEqual(c.totals, { rows: [{ row_id: rM, qty_unit: 'm', old: mLayer.qty + mSel.qty + mMan.qty, new: null }, { row_id: rM2, qty_unit: 'm2', old: mArea.qty, new: null },
        { row_id: rNr, qty_unit: 'nr', old: 1, new: 2 }] });
      assert.deepStrictEqual(await cmp(qs), c, 'the same for qs');
      // read only: nothing stored, nothing audited
      assert.strictEqual(snap(), s2); assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, nAudit);
      // other units on the new drawing: lengths and the manual shape × 10 (cm), counts as they are
      await ok(call('PUT', `drawings/${N}/units`, { units: 'cm' }, qs), 'units cm');
      c = await cmp();
      const cm = new Map(c.items.map(x => [x.measurement_id, x]));
      assert.strictEqual(cm.get(mLayer.id).status, 'changed'); rel(cm.get(mLayer.id).new_qty, 50, 'kerb in cm');
      assert.strictEqual(cm.get(mMan.id).status, 'review'); rel(cm.get(mMan.id).new_qty, 20, 'manual in cm');
      assert.strictEqual(cm.get(mBlk.id).new_qty, 2); rel(cm.get(mSel.id).keep_matched_qty, 20, 'keep matched in cm');
      await ok(call('PUT', `drawings/${N}/units`, { units: 'mm' }, qs), 'units back to mm');
      // a selection saved without geomKeys (before batch 2): recovered from the old drawing's cache, so the result is the same
      db.prepare('UPDATE measurement_handles SET geom_key=NULL WHERE measurement_id=?').run(mSel.id);
      try {
        c = await cmp();
        assert.deepStrictEqual(c.items.find(x => x.measurement_id === mSel.id), byId.get(mSel.id), 'legacy geomKeys from the old cache');
        // and when the old cache cannot vouch for them (the stored count differs), nothing matches: delete only
        db.prepare('UPDATE measurements SET handles_count=handles_count+1 WHERE id=?').run(mSel.id);
        c = await cmp();
        const x = c.items.find(i => i.measurement_id === mSel.id);
        assert.deepStrictEqual([x.status, x.reason, x.options, x.keep_matched_qty], ['blocked', 'geometry_changed', ['delete'], null]);
      } finally {
        db.prepare('UPDATE measurements SET handles_count=? WHERE id=?').run(mSel.handles_count, mSel.id);
        const st = db.prepare('UPDATE measurement_handles SET geom_key=? WHERE measurement_id=? AND handle=?');
        for (const k of keys) st.run(k.geom_key, mSel.id, k.handle);
      }
      // R9: a qty that cannot be recomputed blocks its own item only (cannot_recompute, delete), never the whole compare
      db.prepare("UPDATE measurements SET geom='not a shape' WHERE id=?").run(mMan.id);
      try {
        c = await cmp();
        assert.deepStrictEqual(c.items.find(x => x.measurement_id === mMan.id), { measurement_id: mMan.id, row_id: rM, tool: 'manual', label: 'Fake drawn edge', old_qty: mMan.qty, new_qty: null,
          qty_unit: 'm', status: 'blocked', reason: 'cannot_recompute', options: ['delete'] });
        assert.deepStrictEqual(c.items.filter(x => x.measurement_id !== mMan.id), [...byId.values()].filter(x => x.measurement_id !== mMan.id), 'the other items as before');
      } finally { db.prepare('UPDATE measurements SET geom=? WHERE id=?').run(JSON.stringify({ tool: 'polyline', pts: [[0, 0], [1000, 0], [1000, 1000]] }), mMan.id); }
      assert.strictEqual(snap(), s2, 'restored');
      // R8: a tender with a pending drawing replacement is not submitted or approved
      r = await call('POST', `tenders/${T}/submit`, null, qs);
      assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'a drawing replacement is pending');
      db.prepare("UPDATE tenders SET status='submitted' WHERE id=?").run(T);   // a state the API no longer reaches: approve refuses too
      try {
        r = await call('POST', `tenders/${T}/approve`, { expected_P: 0 }, admin);
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'a drawing replacement is pending');
      } finally { db.prepare("UPDATE tenders SET status='draft' WHERE id=?").run(T); }
      // R7: the creation gates are evaluated on the new drawing. v2 draws KERB's line twice (a possible duplicate) and adds
      // an MLINE to EDGE (not measured: dropped) → both layer measurements are blocked confirm_needed with their gate and
      // the qty they get when confirmed; the selection of E1 + E2 is unaffected (its own entities have no gate), and a
      // layer measurement saved with confirm_duplicate stays quiet
      {
        const T3 = (await ok(call('POST', 'tenders', { title: 'Test Revisions Gates', kind: 'rta' }, qs), 'tender 3')).id;
        const r3 = (await ok(call('POST', `tenders/${T3}/rows`, { description: 'Fake edging', unit: 'm' }, qs), 'row')).id;
        const v1g = dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...tables([layerRec('KERB'), layerRec('EDGE'), layerRec('TWIN')]),
          ...sec('ENTITIES', [...line('RK', 'KERB', 0, 0, 3000, 4000), ...line('E1', 'EDGE', 0, 0, 1000, 0), ...line('E2', 'EDGE', 0, 100, 2000, 100),
            ...line('W1', 'TWIN', 0, 0, 0, 500), ...line('W2', 'TWIN', 0, 0, 0, 500)])]);
        const v2g = dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...tables([layerRec('KERB'), layerRec('EDGE'), layerRec('TWIN')]),
          ...sec('ENTITIES', [...line('RK', 'KERB', 0, 0, 3000, 4000), ...line('RK2', 'KERB', 0, 0, 3000, 4000), ...line('E1', 'EDGE', 0, 0, 1000, 0), ...line('E2', 'EDGE', 0, 100, 2000, 100),
            [0, 'MLINE'], [5, 'DM'], [8, 'EDGE'], ...line('W1', 'TWIN', 0, 0, 0, 500), ...line('W2', 'TWIN', 0, 0, 0, 500)])]);
        const g1 = (await upload(T3, 'Fake gates A', Buffer.from(v1g), qs)).j.id;
        await waitDone(g1, qs); await ok(call('PUT', `drawings/${g1}/units`, { units: 'mm' }, qs), 'units');
        const gK = await mOk({ row_id: r3, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' }, g1);
        const gE = await mOk({ row_id: r3, tool: 'dxf_layer', layer: 'EDGE', metric: 'open_length' }, g1);
        const gS = await mOk({ row_id: r3, tool: 'dxf_selection', metric: 'open_length', handles: ['E1', 'E2'] }, g1);
        const gW = await mOk({ row_id: r3, tool: 'dxf_layer', layer: 'TWIN', metric: 'open_length', confirm_duplicate: true }, g1);
        assert.strictEqual(db.prepare('SELECT duplicate FROM measurements WHERE id=?').get(gW.id).duplicate, 1);
        const g2 = await replace(g1, 'Fake gates B', Buffer.from(v2g));
        assert.strictEqual(g2.s, 202, JSON.stringify(g2.j));
        await waitDone(g2.j.id, qs); await ok(call('PUT', `drawings/${g2.j.id}/units`, { units: 'mm' }, qs), 'units');
        const gc = await ok(call('GET', `drawings/${g2.j.id}/compare`, null, viewer), 'compare gates');
        const gi = new Map(gc.items.map(x => [x.measurement_id, x]));
        assert.deepStrictEqual(gi.get(gK.id), { measurement_id: gK.id, row_id: r3, tool: 'dxf_layer', label: null, old_qty: 5, new_qty: 10, qty_unit: 'm', status: 'blocked', reason: 'confirm_needed',
          gates: ['duplicate'], gate_counts: { duplicate: { old: 0, new: 1 } }, options: ['delete', 'confirm'] });
        assert.deepStrictEqual([gi.get(gE.id).status, gi.get(gE.id).reason, gi.get(gE.id).gates, gi.get(gE.id).new_qty, gi.get(gE.id).options], ['blocked', 'confirm_needed', ['incomplete'], 3, ['delete', 'confirm']]);
        assert.deepStrictEqual(gi.get(gE.id).gate_counts, { incomplete: { old: 0, new: 1 } }, 'R11: old and new counts');
        assert.deepStrictEqual([gi.get(gS.id).status, gi.get(gS.id).new_qty], ['same', 3]);
        assert.deepStrictEqual([gi.get(gW.id).status, gi.get(gW.id).new_qty], ['same', 1], 'confirmed at creation: no gate');
        await ok(call('DELETE', `tenders/${T3}`, null, qs), 'tidy');
      }
      // a selection entity gone from the new drawing → handles_missing
      {
        const T2 = (await ok(call('POST', 'tenders', { title: 'Test Revisions Gone', kind: 'rta' }, qs), 'tender 2')).id;
        const r2 = (await ok(call('POST', `tenders/${T2}/rows`, { description: 'Fake edging', unit: 'm' }, qs), 'row')).id;
        const g1 = (await upload(T2, 'Fake gone A', Buffer.from(plan(false)), qs)).j.id;
        await waitDone(g1, qs); await ok(call('PUT', `drawings/${g1}/units`, { units: 'mm' }, qs), 'units');
        const gs = await mOk({ row_id: r2, tool: 'dxf_selection', metric: 'open_length', handles: ['RK', 'E2'] }, g1);
        const gone = dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...sec('ENTITIES', [...line('E2', 'EDGE', 0, 100, 2000, 100)])]);
        // Review Focus 3 inside a create's window: the replacement is uploaded after the layer table was read, before the
        // tx → the in-tx guard refuses the measurement (without it, it would be saved on the old drawing unseen)
        let gr = null;
        const nG = db.prepare('SELECT COUNT(*) n FROM measurements WHERE drawing_id=?').get(g1).n;
        ctx.drawings._hooks.beforeMeasureTx = async () => { if (!gr) gr = await replace(g1, 'Fake gone B', Buffer.from(gone)); };
        try { r = await measure({ row_id: r2, tool: 'dxf_layer', layer: 'EDGE', metric: 'open_length' }, g1); }
        finally { ctx.drawings._hooks.beforeMeasureTx = null; }
        assert.ok(gr, 'the hook ran'); assert.strictEqual(gr.s, 202, JSON.stringify(gr.j));
        assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, PENDING);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurements WHERE drawing_id=?').get(g1).n, nG, 'nothing saved');
        const g2 = gr.j.id;
        await waitDone(g2, qs); await ok(call('PUT', `drawings/${g2}/units`, { units: 'mm' }, qs), 'units');
        const gi = (await ok(call('GET', `drawings/${g2}/compare`, null, viewer), 'compare')).items;
        assert.deepStrictEqual(gi.map(x => [x.measurement_id, x.status, x.reason, x.keep_matched_qty, x.options]), [[gs.id, 'blocked', 'handles_missing', 2, ['delete', 'keep_matched']]]);
        // tender delete removes the pending row with the others
        await ok(call('DELETE', `tenders/${T2}`, null, qs), 'delete tender');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE tender_id=?').get(T2).n, 0, 'pending row deleted with the tender');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE id IN (?, ?)').get(g1, g2).n, 0);
      }

      // the backup copies the pending row and mirrors its file
      {
        const b = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'scripts', 'backup.js')], { env: { ...process.env }, encoding: 'utf8' });
        assert.strictEqual(b.status, 0, b.stderr);
        const bdir = path.join(process.env.DATA_DIR, 'backups'), f = fs.readdirSync(bdir).find(x => /^estimation-\d{8}\.db$/.test(x));
        const { DatabaseSync } = require('node:sqlite'), bdb = new DatabaseSync(path.join(bdir, f), { readOnly: true });
        try { const x = bdb.prepare('SELECT pending, replaces_id FROM drawings WHERE id=?').get(N); assert.deepStrictEqual({ ...x }, { pending: 1, replaces_id: D1 }); }
        finally { bdb.close(); }
        assert.ok(fs.existsSync(path.join(bdir, 'drawings', n.sha256 + '.dxf')), 'the pending file is mirrored');
      }

      // approved tender (forced in the database: R8 stops submit/approve while a replacement is pending, so this state is
      // reached only by data from before; the Rev must still skip the pending row): replace → 409 (before the body);
      // compare is still readable; a Rev copies the accepted rows only
      db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(T);
      try {
        r = await replace(D1, 'Fake site plan C', V2);
        assert.strictEqual(r.s, 409); assert.match(r.j.error, /only a draft can be changed/);
        assert.strictEqual((await cmp()).items.length, 5);
        const rv = await ok(call('POST', `tenders/${T}/revise`, null, qs), 'revise');
        const copied = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(rv.id);
        assert.deepStrictEqual(copied.map(x => [x.sha256, x.pending, x.replaces_id]), [[dRow(D1).sha256, 0, null]], 'the pending row is not copied');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurements WHERE tender_id=?').get(rv.id).n, 5);
        assert.deepStrictEqual((await ok(call('GET', `tenders/${rv.id}/drawings`, null, viewer), 'rev list')).map(x => [x.id, x.pending_replacement]), [[copied[0].id, null]]);
        // the Rev's copy has no pending replacement: it can be measured
        await ok(call('PUT', `drawings/${copied[0].id}/units`, { units: 'mm' }, qs), 'rev units');
      } finally { db.prepare("UPDATE tenders SET status='draft' WHERE id=?").run(T); }

      // PDF: v1 has 2 pages (both calibrated and measured), v2 has 1 page → page 2 is blocked page_missing
      {
        const pdfUp = await upload(T, 'Fake sheets', makePdf(), qs);
        const [P1, P2] = (await ok(call('POST', `drawings/${pdfUp.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs), 'pages')).drawings.map(x => x.id);
        const cal1 = (await ok(call('POST', `drawings/${P1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs), 'cal 1')).calibration;
        await ok(call('POST', `drawings/${P2}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 2, unit: 'm' }, qs), 'cal 2');
        const q1 = await mOk({ row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[10, 10], [10, 50]] } }, P1);   // 40 × 0.05 = 2 m
        const q2 = await mOk({ row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[10, 10], [60, 10]] } }, P2);   // 50 × 0.02 = 1 m
        const q3 = await mOk({ row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[500, 1200], [500, 1240]] } }, P1);   // on both page boxes: 2 m
        rel(q1.qty, 2, 'page 1'); rel(q2.qty, 1, 'page 2'); rel(q3.qty, 2, 'page 1, second');
        // a page row is not replaced on its own; a DXF does not replace a PDF
        r = await replace(P2, 'Fake sheets B', makeOffsetPdf());
        assert.strictEqual(r.s, 400); assert.strictEqual(r.j.error, 'replace the whole PDF: use its first page');
        r = await replace(P1, 'Fake sheets B', V2);
        assert.strictEqual(r.s, 400); assert.strictEqual(r.j.error, 'a new version of a PDF or an image must be a PDF or an image');
        // R8: a drawing is replaced once it is ready (a PDF: its pages registered)
        const unreg = await upload(T, 'Fake sheets unregistered', makePdf(), qs);
        r = await replace(unreg.j.id, 'Fake sheets unregistered B', makePdf());
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'drawing is pages: a new version can be uploaded once it is ready');
        const nv = await replace(P1, 'Fake sheets B', makeOffsetPdf());
        assert.strictEqual(nv.s, 202, JSON.stringify(nv.j));
        const NP = nv.j.id;
        assert.deepStrictEqual([dRow(NP).pending, dRow(NP).replaces_id, dRow(NP).status, dRow(NP).kind], [1, P1, 'pages', 'pdf']);
        // pages not registered yet: not ready
        assert.deepStrictEqual(await ok(call('GET', `drawings/${NP}/compare`, null, viewer), 'compare'), { ready: false, needs_units: false, new_pages: [], items: [], totals: { rows: [] } });
        // the old pages (both) take no calibration change while the replacement is pending
        const s3 = snap();
        for (const [what, p] of [['calibrate page 2', call('POST', `drawings/${P2}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 3, unit: 'm' }, qs)],
          ['verify', call('POST', `drawings/${P1}/calibrations/${cal1.id}/verify`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs)],
          ['delete calibration', call('DELETE', `drawings/${P1}/calibrations/${cal1.id}`, null, qs)],
          ['measure page 1', measure({ row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[0, 0], [0, 50]] } }, P1)],
          ['edit page 2', call('PUT', `measurements/${q2.id}`, { width: 0.5 }, qs)]]) {
          const x = await p;
          assert.strictEqual(x.s, 409, what + ': ' + JSON.stringify(x.j)); assert.strictEqual(x.j.error, PENDING, what);
        }
        assert.strictEqual(snap(), s3, 'nothing changed');
        // the pending PDF registers its one page like any PDF
        const reg = await ok(call('POST', `drawings/${NP}/pages`, { pages: [{ ...OFFSET_PAGE }] }, qs), 'pages of v2');
        assert.deepStrictEqual(reg.drawings.map(x => [x.id, x.pending, x.replaces_id]), [[NP, 1, P1]]);
        // and takes no calibration while pending
        r = await call('POST', `drawings/${NP}/calibrations`, { p1: [OFFSET_PAGE.x0, OFFSET_PAGE.y0], p2: [OFFSET_PAGE.x0 + 100, OFFSET_PAGE.y0], real: 5, unit: 'm' }, qs);
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, IS_PENDING);
        c = await ok(call('GET', `drawings/${NP}/compare`, null, viewer), 'compare pdf');
        // R9: v2's page box is [1000, 2000] + 595 × 842: q1 (near 0, 0) lies off it → off_page; q3 lies on it → review
        assert.deepStrictEqual(c, { ready: true, needs_units: false, new_pages: [], items: [
          { measurement_id: q1.id, row_id: rM, tool: 'manual', label: null, old_qty: q1.qty, new_qty: null, qty_unit: 'm', status: 'blocked', reason: 'off_page', options: ['delete'] },
          { measurement_id: q2.id, row_id: rM, tool: 'manual', label: null, old_qty: q2.qty, new_qty: null, qty_unit: 'm', status: 'blocked', reason: 'page_missing', options: ['delete'] },
          { measurement_id: q3.id, row_id: rM, tool: 'manual', label: null, old_qty: q3.qty, new_qty: q3.qty, qty_unit: 'm', status: 'review', reason: 'manual_check', options: ['mark_reviewed'] }],
        totals: { rows: [{ row_id: rM, qty_unit: 'm', old: q1.qty + q2.qty + q3.qty, new: null }] } });
        // a 2-page replacement: page n's row replaces old page n; both pending, listed under the rows they replace
        const pb = await upload(T, 'Fake sheets two', makePdf(), qs);
        const [B1, B2] = (await ok(call('POST', `drawings/${pb.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs), 'pages')).drawings.map(x => x.id);
        const nb = await replace(B1, 'Fake sheets two B', makePdf());
        const [NB1, NB2] = (await ok(call('POST', `drawings/${nb.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs), 'pages')).drawings.map(x => x.id);
        assert.deepStrictEqual([NB1, NB2].map(id => [dRow(id).pending, dRow(id).replaces_id, dRow(id).parent_id, dRow(id).rev]), [[1, B1, null, 2], [1, B2, NB1, 2]]);
        list = await ok(call('GET', `tenders/${T}/drawings`, null, viewer), 'list');
        assert.deepStrictEqual(list.map(x => [x.id, x.pending_replacement ? x.pending_replacement.id : null]),
          [[D1, N], [P1, NP], [P2, null], [unreg.j.id, null], [B1, NB1], [B2, NB2]], 'pending rows listed under the rows they replace only');
        // an image is replaced by a PDF (pdf/image → pdf or image)
        const im = await upload(T, 'Fake photo', makePng(40, 30), qs);
        const ni = await replace(im.j.id, 'Fake photo B', makePdf());
        assert.strictEqual(ni.s, 202, JSON.stringify(ni.j));
        assert.deepStrictEqual([dRow(ni.j.id).kind, dRow(ni.j.id).pending, dRow(ni.j.id).replaces_id], ['pdf', 1, im.j.id]);
        // R10: its page 2 has no old counterpart: listed as new (information only)
        await ok(call('POST', `drawings/${ni.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs), 'pages');
        assert.deepStrictEqual(await ok(call('GET', `drawings/${ni.j.id}/compare`, null, viewer), 'compare'), { ready: true, needs_units: false, new_pages: [2], items: [], totals: { rows: [] } });

        // ---- Task 3: accept the PDF replacement. q1 (off the new page) and q2 (its page is gone) are deleted; q3 moves to
        // the new page 1 with a copy of its page's calibrations (calibration_id remapped), same qty, flagged for review
        c = await ok(call('GET', `drawings/${NP}/compare`, null, viewer), 'compare pdf');
        const rowQ = id => db.prepare('SELECT qty FROM tender_rows WHERE id=?').get(id).qty;
        db.prepare('UPDATE calibrations SET verify_pct=0.4 WHERE id=?').run(cal1.id);   // verified on the old page
        const rM0 = rowQ(rM), calsP1 = db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(P1).map(x => ({ ...x }));
        assert.ok(calsP1.length >= 1);
        const pdfDel = { [q1.id]: { resolution: 'delete', new_qty: null }, [q2.id]: { resolution: 'delete', new_qty: null } };
        r = await ACCEPT(NP, { expect: expOf(c.items) });
        assert.strictEqual(r.s, 400); assert.strictEqual(r.j.error, `blocked items need a resolution: ${q1.id}, ${q2.id}`);
        let acc = await ok(ACCEPT(NP, { expect: expOf(c.items, pdfDel) }), 'accept pdf');
        assert.deepStrictEqual(acc, { id: NP, replaced: P1, kept: 1, deleted: 2, relinked: 0, kept_matched: 0, confirmed: 0, review: 1, rows: [{ row_id: rM, qty: rowQ(rM) }] });
        rel(rowQ(rM), rM0 - q1.qty - q2.qty, 'the row loses the deleted measurements only');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurements WHERE id IN (?, ?)').get(q1.id, q2.id).n, 0);
        const m3 = db.prepare('SELECT * FROM measurements WHERE id=?').get(q3.id);
        assert.deepStrictEqual([m3.drawing_id, m3.qty, m3.review_needed], [NP, q3.qty, 1]);
        const calsNP = db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(NP);
        const strip = x => { const { id, drawing_id, ...rest } = x; return rest; };
        assert.ok(calsP1.every(x => x.copied_from === null), 'R15: a calibration made on its page is not a copy');
        assert.deepStrictEqual(calsNP.map(strip), calsP1.map(x => ({ ...strip(x), verify_pct: null, copied_from: x.id })), 'the old page 1 calibrations are copied to the new page 1, to be verified there (R15: copied_from)');
        assert.strictEqual(m3.calibration_id, calsNP[calsP1.findIndex(x => x.id === q3.calibration_id)].id, 'calibration_id remapped to the copy');
        assert.deepStrictEqual(db.prepare('SELECT * FROM calibrations WHERE drawing_id=? ORDER BY id').all(P1).map(x => ({ ...x })), calsP1, 'the old page keeps its calibrations (history)');
        assert.deepStrictEqual([dRow(P1).replaced_by, dRow(P2).replaced_by, dRow(NP).pending], [NP, NP, 0]);
        assert.deepStrictEqual(audits('replace_accept').at(-1), { replaced: P1, by: NP, kept: 1, deleted: 2, relinked: 0, kept_matched: 0, confirmed: 0, review: 1, changed_rows: 1 });
        // the old pages are history: no measuring, calibrating, verifying, units; the new page measures; its file is served
        for (const [what, p] of [['measure page 2', measure({ row_id: rNr, tool: 'manual', geom: { tool: 'count', pts: [[5, 5]] } }, P2)],
          ['calibrate page 1', call('POST', `drawings/${P1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 3, unit: 'm' }, qs)],
          ['verify', call('POST', `drawings/${P1}/calibrations/${cal1.id}/verify`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs)],
          ['delete calibration', call('DELETE', `drawings/${P1}/calibrations/${cal1.id}`, null, qs)]]) {
          const x = await p;
          assert.strictEqual(x.s, 409, what + ': ' + JSON.stringify(x.j)); assert.strictEqual(x.j.error, REPLACED, what);
        }
        assert.strictEqual((await fetch(base + `drawings/${P1}/file`, { headers: { cookie: viewer } })).status, 200, 'the old file is served');
        const onNew = await mOk({ row_id: rNr, tool: 'manual', geom: { tool: 'count', pts: [[OFFSET_PAGE.x0 + 5, OFFSET_PAGE.y0 + 5]] } }, NP);
        await ok(call('DELETE', `measurements/${onNew.id}`, null, qs), 'tidy');
        // R15: both reads say where a copy came from, until it is verified or calibrated again on the new page
        const pageCopy = calsNP.find(x => x.region === null), copiedOf = id => db.prepare('SELECT copied_from FROM calibrations WHERE id=?').get(id).copied_from;
        assert.deepStrictEqual((await ok(call('GET', `drawings/${NP}/calibrations`, null, viewer), 'cals')).calibrations.map(x => [x.id, x.copied_from]), calsNP.map(x => [x.id, x.copied_from]));
        assert.deepStrictEqual((await ok(call('GET', `drawings/${NP}`, null, viewer), 'drawing')).calibrations.map(x => x.copied_from), calsNP.map(x => x.copied_from));
        assert.strictEqual(pageCopy.copied_from, cal1.id);
        await ok(call('POST', `drawings/${NP}/calibrations/${pageCopy.id}/verify`, { p1: [500, 1200], p2: [600, 1200], real: 5, unit: 'm' }, qs), 'verify the copy');
        assert.strictEqual(copiedOf(pageCopy.id), null, 'verified on the new page: no longer "copied"');
        db.prepare('UPDATE calibrations SET copied_from=? WHERE id=?').run(cal1.id, pageCopy.id);
        await ok(call('POST', `drawings/${NP}/calibrations`, { p1: [500, 1200], p2: [600, 1200], real: 5, unit: 'm' }, qs), 'calibrate the new page again (same scale: no change)');
        assert.strictEqual(copiedOf(pageCopy.id), null, 'calibrated again: no longer "copied"');
        db.prepare('UPDATE calibrations SET copied_from=? WHERE id=?').run(cal1.id, pageCopy.id);   // the Rev below keeps the flag
        r = await ACCEPT(NP, { expect: [] });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'this drawing is not a pending replacement');

        // ---- Task 3: cancel = DELETE on the pending row: removes that row and its page rows only; the old one is measurable again
        const cnt = { row_id: rNr, tool: 'manual', geom: { tool: 'count', pts: [[5, 5]] } };
        r = await measure(cnt, im.j.id);
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, PENDING);
        assert.strictEqual((await call('DELETE', `drawings/${ni.j.id}`, null, viewer)).s, 403);
        r = await call('DELETE', `drawings/${NB2}`, null, qs);
        assert.strictEqual(r.s, 400); assert.strictEqual(r.j.error, 'cancel the whole new version: use its first page');
        r = await call('DELETE', `drawings/${B1}`, null, qs);
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'only a pending new version can be cancelled');
        const nDraw = db.prepare('SELECT COUNT(*) n FROM drawings').get().n, niRows = db.prepare('SELECT id FROM drawings WHERE id=? OR parent_id=?').all(ni.j.id, ni.j.id).length;
        assert.strictEqual(niRows, 2);
        assert.deepStrictEqual(await ok(call('DELETE', `drawings/${ni.j.id}`, null, qs), 'cancel'), { ok: 1 });
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings').get().n, nDraw - 2, 'the pending row and its page row only');
        assert.deepStrictEqual(audits('replace_cancel').at(-1), { replaces: im.j.id, pages: 2 });
        assert.ok(dRow(im.j.id).id, 'the old drawing stays'); assert.strictEqual(dRow(im.j.id).replaced_by, null);
        const again = await mOk(cnt, im.j.id);
        await ok(call('DELETE', `measurements/${again.id}`, null, qs), 'tidy');
        assert.ok(fs.existsSync(path.join(DDIR, dRow(im.j.id).sha256 + '.png')), 'files stay (shared by sha256)');
        await ok(call('DELETE', `drawings/${NB1}`, null, qs), 'cancel 2 pages');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE id IN (?, ?)').get(NB1, NB2).n, 0);
        assert.strictEqual(nPending(), 1, 'only the DXF replacement N is still pending');
      }

      // ---- batch 4 Task 3: accept the DXF replacement N of D1 (R18: only the reviewed table is applied) ---------------
      {
        const rowQ = id => db.prepare('SELECT qty FROM tender_rows WHERE id=?').get(id).qty;
        const mRow = id => db.prepare('SELECT * FROM measurements WHERE id=?').get(id);
        c = await cmp();
        const items = new Map(c.items.map(x => [x.measurement_id, x]));
        assert.deepStrictEqual(c.items.map(x => [x.measurement_id, x.status]), [[mLayer.id, 'same'], [mArea.id, 'blocked'], [mBlk.id, 'changed'], [mSel.id, 'blocked'], [mMan.id, 'review']]);
        const s4 = snap(), nAcc = audits('replace_accept').length;
        // refusals: a viewer; no expect (400); malformed bodies; a duplicate id
        assert.strictEqual((await ACCEPT(N, { expect: expOf(c.items) }, viewer)).s, 403);
        r = await ACCEPT(N, {});
        assert.strictEqual(r.s, 400); assert.strictEqual(r.j.error, 'accept needs expect: the reviewed table [{ measurement_id, new_qty, resolution?, to?, confirm? }]');
        for (const b of [{ expect: expOf(c.items), relink: {} }, { expect: 'x' }, { expect: [{ measurement_id: mLayer.id }] }, { expect: [{ measurement_id: mLayer.id, new_qty: '5' }] },
          { expect: [{ measurement_id: mLayer.id, new_qty: 5, resolution: 'drop' }] }, { expect: [{ measurement_id: mLayer.id, new_qty: 5, confirm: ['nope'] }] },
          { expect: [{ measurement_id: mLayer.id, new_qty: 5, confirm: ['overlap', 'overlap'] }] }, { expect: [{ measurement_id: mLayer.id, new_qty: 5, to: 7 }] },
          { expect: [{ measurement_id: mLayer.id, new_qty: 5, extra: 1 }] }, { expect: [...expOf(c.items), expOf(c.items)[0]] }]) {
          r = await ACCEPT(N, b);
          assert.strictEqual(r.s, 400, JSON.stringify(b) + ' → ' + JSON.stringify(r.j));
        }
        // blocked items without a resolution → 400 naming them, with the fresh table
        r = await ACCEPT(N, { expect: expOf(c.items) });
        assert.strictEqual(r.s, 400); assert.strictEqual(r.j.error, `blocked items need a resolution: ${mArea.id}, ${mSel.id}`);
        assert.deepStrictEqual(r.j.items, c.items);
        // a resolution the item does not offer → 400 naming the measurement (R12: relink only to its relink_choices)
        const delA = { resolution: 'delete', new_qty: null };
        for (const [o, msg] of [
          [{ [mArea.id]: { resolution: 'keep_matched' }, [mSel.id]: delA }, `measurement ${mArea.id}: cannot be resolved by keep_matched (options: delete, relink)`],
          [{ [mArea.id]: { resolution: 'relink', to: 'KERB' }, [mSel.id]: delA }, `measurement ${mArea.id}: relink to must be one of its relink_choices`],
          [{ [mArea.id]: delA, [mSel.id]: { resolution: 'relink', to: 'EDGE' } }, `measurement ${mSel.id}: cannot be resolved by relink (options: delete, keep_matched)`],
          [{ [mArea.id]: delA, [mSel.id]: { resolution: 'confirm' } }, `measurement ${mSel.id}: cannot be resolved by confirm (options: delete, keep_matched)`],
          [{ [mArea.id]: delA, [mSel.id]: delA, [mLayer.id]: delA }, `measurement ${mLayer.id}: is not blocked: send it without a resolution`]]) {
          r = await ACCEPT(N, { expect: expOf(c.items, o) });
          assert.strictEqual(r.s, 400, JSON.stringify(r.j)); assert.strictEqual(r.j.error, msg);
        }
        assert.strictEqual(snap(), s4, 'nothing changed');
        // relink / keep_matched whose qty is not known yet (null): 409 with the fresh table and what each resolution gives
        const probe = { [mArea.id]: { resolution: 'relink', to: 'PAVING', new_qty: null }, [mSel.id]: { resolution: 'keep_matched', new_qty: null } };
        r = await ACCEPT(N, { expect: expOf(c.items, probe) });
        assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.deepStrictEqual([r.j.code, r.j.error], ['resolution_preview', PREVIEW], 'R14: the probe is not a stale table'); assert.deepStrictEqual(r.j.items, c.items);
        assert.deepStrictEqual(r.j.resolved, [{ measurement_id: mArea.id, resolution: 'relink', to: 'PAVING', new_qty: mArea.qty, gates: [] },
          { measurement_id: mSel.id, resolution: 'keep_matched', new_qty: items.get(mSel.id).keep_matched_qty, gates: [] }]);
        // R18b: the totals the resolutions give (the compare's own totals stay null on the blocked rows)
        assert.deepStrictEqual(r.j.resolved_totals, { rows: handTotals(c.items, r.j.resolved) });
        assert.ok(r.j.totals.rows.some(x => x.new === null) && r.j.resolved_totals.rows.every(x => typeof x.new === 'number'));
        assert.deepStrictEqual(r.j.resolved_totals.rows.find(x => x.row_id === rM2), { row_id: rM2, qty_unit: 'm2', old: mArea.qty, new: mArea.qty });
        // a probe sent with another qty that no longer matches is a stale table (REVIEW), not a preview
        r = await ACCEPT(N, { expect: expOf(c.items, probe).map(x => x.measurement_id === mBlk.id ? { ...x, new_qty: 1 } : x) });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual([r.j.code, r.j.error], [undefined, REVIEW]);
        assert.strictEqual(r.j.resolved_totals, undefined, 'a stale table gives no preview totals');
        // null on an item without relink / keep_matched is never a probe
        r = await ACCEPT(N, { expect: expOf(c.items, { ...probe, [mBlk.id]: { new_qty: null } }) });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual([r.j.code, r.j.error], [undefined, REVIEW]);
        const good = expOf(c.items, { [mArea.id]: { resolution: 'relink', to: 'PAVING', new_qty: mArea.qty }, [mSel.id]: { resolution: 'keep_matched', new_qty: items.get(mSel.id).keep_matched_qty } });
        // stale tables: a measurement left out, a qty that differs → 409, nothing changed
        r = await ACCEPT(N, { expect: good.slice(1) });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, REVIEW); assert.deepStrictEqual(r.j.items, c.items);
        r = await ACCEPT(N, { expect: good.map(x => x.measurement_id === mBlk.id ? { ...x, new_qty: 1 } : x) });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, REVIEW);
        assert.strictEqual(snap(), s4, 'nothing changed'); assert.strictEqual(audits('replace_accept').length, nAcc);
        // the race: the new version's units change between the async comparison and the tx → 409 with the fresh comparison
        let raced = null;
        ctx.drawings._hooks.beforeAcceptTx = async () => { if (!raced) raced = await call('PUT', `drawings/${N}/units`, { units: 'cm' }, qs); };
        try { r = await ACCEPT(N, { expect: good }); }
        finally { ctx.drawings._hooks.beforeAcceptTx = null; }
        assert.ok(raced, 'the hook ran'); assert.strictEqual(raced.s, 200, JSON.stringify(raced.j));
        assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'the drawings changed while the replacement was compared: review the changes again');
        rel(r.j.items.find(x => x.measurement_id === mLayer.id).new_qty, 50, 'the fresh table: kerb in cm');
        assert.strictEqual(snap(), s4, 'nothing changed'); assert.strictEqual(dRow(N).pending, 1); assert.strictEqual(audits('replace_accept').length, nAcc);
        await ok(call('PUT', `drawings/${N}/units`, { units: 'mm' }, qs), 'units back to mm');
        // accept: one tx; kept measurements move to N with the reviewed quantities
        const before = { rM: rowQ(rM) };
        const acc = await ok(ACCEPT(N, { expect: good }), 'accept');
        assert.deepStrictEqual(acc, { id: N, replaced: D1, kept: 5, deleted: 0, relinked: 1, kept_matched: 1, confirmed: 0, review: 1,
          rows: [{ row_id: rM, qty: rowQ(rM) }, { row_id: rM2, qty: rowQ(rM2) }, { row_id: rNr, qty: rowQ(rNr) }] });
        for (const x of [mLayer, mArea, mBlk, mSel, mMan]) assert.strictEqual(mRow(x.id).drawing_id, N, 'moved ' + x.id);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM measurements WHERE drawing_id=?').get(D1).n, 0);
        // relink: the new layer, its qty and base; same/changed: the compared qty; manual: unchanged, flagged for review
        assert.deepStrictEqual([mRow(mArea.id).layer, mRow(mArea.id).qty, mRow(mArea.id).base], ['PAVING', mArea.qty, mArea.qty]);
        assert.deepStrictEqual([mRow(mBlk.id).qty, mRow(mBlk.id).base, mRow(mBlk.id).handles_count], [2, 2, 2]);
        assert.strictEqual(mRow(mLayer.id).qty, mLayer.qty);
        assert.deepStrictEqual([mRow(mMan.id).qty, mRow(mMan.id).review_needed], [mMan.qty, 1]);
        assert.deepStrictEqual([mLayer, mArea, mBlk, mSel].map(x => mRow(x.id).review_needed), [0, 0, 0, 0]);
        // keep_matched: the handles are the matched subset (E2, its geomKey), the qty and the summary from the new cache
        assert.deepStrictEqual(db.prepare('SELECT handle, geom_key FROM measurement_handles WHERE measurement_id=? ORDER BY rowid').all(mSel.id).map(x => ({ ...x })), [{ handle: 'E2', geom_key: keys[1].geom_key }]);
        const ks = mRow(mSel.id);
        assert.deepStrictEqual([ks.qty, ks.handles_count, JSON.parse(ks.selection_summary).by_layer], [items.get(mSel.id).keep_matched_qty, 1, { EDGE: 1 }]);
        // rows: kerb row loses E1 (1 m); paving the same 100; manholes 1 → 2
        rel(rowQ(rM), before.rM - 1, 'kerb row'); rel(rowQ(rM2), mArea.qty, 'paving row'); assert.strictEqual(rowQ(rNr), db.prepare('SELECT SUM(qty) s FROM measurements WHERE row_id=?').get(rNr).s);
        assert.deepStrictEqual([dRow(D1).replaced_by, dRow(N).pending, dRow(N).replaces_id], [N, 0, D1]);
        // the audit: counts only
        assert.deepStrictEqual(audits('replace_accept').at(-1), { replaced: D1, by: N, kept: 5, deleted: 0, relinked: 1, kept_matched: 1, confirmed: 0, review: 1, changed_rows: 3 });
        // the old drawing is history: listed, its file and layers readable, nothing measured, relinked, rescaled or replaced
        list = await ok(call('GET', `tenders/${T}/drawings`, null, viewer), 'list');
        assert.deepStrictEqual(list.filter(x => x.id === D1 || x.id === N).map(x => [x.id, x.replaced_by, x.pending_replacement]), [[D1, N, null], [N, null, null]]);
        assert.strictEqual((await fetch(base + `drawings/${D1}/file`, { headers: { cookie: viewer } })).status, 200);
        await ok(call('GET', `drawings/${D1}/layers`, null, viewer), 'old layers');
        const s5 = snap();
        for (const [what, p] of [['layer', measure({ row_id: rM, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' })],
          ['selection', measure({ row_id: rM, tool: 'dxf_selection', metric: 'open_length', handles: ['E2'] })],
          ['manual', measure({ row_id: rM, tool: 'manual', geom: { tool: 'line', pts: [[0, 0], [0, 500]] } })],
          ['units', call('PUT', `drawings/${D1}/units`, { units: 'cm' }, qs)]]) {
          const x = await p;
          assert.strictEqual(x.s, 409, what + ': ' + JSON.stringify(x.j)); assert.strictEqual(x.j.error, REPLACED, what);
        }
        r = await replace(D1, 'Fake site plan C', V2);
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'this drawing has been replaced already: replace its newest version');
        assert.strictEqual(snap(), s5);
        // the accepted version is a normal drawing: compared no more, measured
        r = await call('GET', `drawings/${N}/compare`, null, viewer);
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'this drawing is not a pending replacement');
        r = await ACCEPT(N, { expect: good });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, 'this drawing is not a pending replacement');
        const onN = await mOk({ row_id: rNr, tool: 'dxf_blocks', layer: 'MH', block: 'MH1', metric: 'count' }, N);
        await ok(call('DELETE', `measurements/${onN.id}`, null, qs), 'tidy');

        // mark reviewed: clears review_needed (admin/qs, draft); audited once
        r = await call('POST', `measurements/${mMan.id}/reviewed`, null, viewer);
        assert.strictEqual(r.s, 403);
        assert.strictEqual((await call('POST', 'measurements/999999/reviewed', null, qs)).s, 404);
        const nRev = audits('measure_reviewed').length;
        assert.deepStrictEqual(await ok(call('POST', `measurements/${mMan.id}/reviewed`, null, qs), 'reviewed'), { ok: 1, id: mMan.id, review_needed: 0 });
        assert.strictEqual(mRow(mMan.id).review_needed, 0);
        assert.deepStrictEqual(audits('measure_reviewed').slice(nRev), [{ drawing_id: N, row_id: rM, tool: 'manual' }]);
        await ok(call('POST', `measurements/${mMan.id}/reviewed`, null, qs), 'again');
        assert.strictEqual(audits('measure_reviewed').length, nRev + 1, 'nothing to clear: no audit');
        db.prepare('UPDATE measurements SET review_needed=1 WHERE id=?').run(mMan.id);   // the Rev below copies the flag

        // a Rev copies the accepted chain (replaced_by / replaces_id remapped, the review flag kept); no pending row exists
        db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(T);
        try {
          const rv = await ok(call('POST', `tenders/${T}/revise`, null, qs), 'revise');
          const cp = db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(rv.id);
          const src = db.prepare('SELECT * FROM drawings WHERE tender_id=? AND pending=0 ORDER BY id').all(T);
          assert.strictEqual(cp.length, src.length);
          const map = new Map(src.map((x, i) => [x.id, cp[i].id]));
          for (let i = 0; i < src.length; i++) {
            assert.strictEqual(cp[i].replaced_by, src[i].replaced_by === null ? null : map.get(src[i].replaced_by), 'replaced_by ' + src[i].id);
            assert.strictEqual(cp[i].replaces_id, src[i].replaces_id === null ? null : map.get(src[i].replaces_id), 'replaces_id ' + src[i].id);
            assert.strictEqual(cp[i].pending, 0);
          }
          assert.deepStrictEqual([cp[0].replaced_by, cp.find(x => x.id === map.get(N)).replaces_id], [map.get(N), map.get(D1)]);
          const cm = db.prepare('SELECT drawing_id, review_needed, label FROM measurements WHERE tender_id=? AND tool=? ORDER BY id').all(rv.id, 'manual').find(x => x.label === 'Fake drawn edge');
          assert.deepStrictEqual([cm.drawing_id, cm.review_needed], [map.get(N), 1]);
          // R15: a copied calibration stays flagged in the Rev, pointing at the Rev's own copy of its source
          const revCals = db.prepare('SELECT c.* FROM calibrations c JOIN drawings d ON d.id=c.drawing_id WHERE d.tender_id=? ORDER BY c.id').all(rv.id);
          const flagged = revCals.filter(x => x.copied_from !== null);
          assert.ok(flagged.length >= 1, 'a copied calibration stays flagged in the Rev');
          for (const x of flagged) assert.ok(revCals.some(y => y.id === x.copied_from), 'copied_from remapped into the Rev');
          // the copied old drawing is history in the Rev too
          r = await call('POST', `drawings/${map.get(D1)}/measurements`, { row_id: [...db.prepare('SELECT id FROM tender_rows WHERE tender_id=?').all(rv.id)][0].id, tool: 'manual', geom: { tool: 'line', pts: [[0, 0], [0, 5]] } }, qs);
          assert.strictEqual(r.s, 409); assert.strictEqual(r.j.error, REPLACED);
          await ok(call('DELETE', `tenders/${rv.id}`, null, qs), 'tidy rev');
        } finally { db.prepare("UPDATE tenders SET status='draft' WHERE id=?").run(T); }
      }

      // Task 3: an imported row whose measured total would go below 0 at accept → 400, the whole accept rolled back
      {
        const { writeXlsx } = require('./lib/xlsx.js');
        const TN = (await ok(call('POST', 'tenders', { title: 'Test Revisions Negative', kind: 'rta' }, qs), 'tender')).id;
        const BOQ = { file_b64: writeXlsx([{ name: 'BOQ', rows: [['No', 'Description', 'Unit', 'Qty'], ['1', 'Fake imported kerb', 'm', 50]] }]).toString('base64'),
          sheet: 'BOQ', header_row: 1, cols: { no: 'A', desc: 'B', unit: 'C', qty: 'D' } };
        await ok(call('POST', `tenders/${TN}/import`, BOQ, qs), 'import');
        const rI = (await ok(call('GET', `tenders/${TN}/rows`, null, viewer), 'rows')).find(x => x.description === 'Fake imported kerb').id;
        const kerbOf = len => dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...tables([layerRec('KERB')]), ...sec('ENTITIES', [...line('RK', 'KERB', 0, 0, len, 0)])]);
        const g1 = (await upload(TN, 'Fake kerb A', Buffer.from(kerbOf(5000)), qs)).j.id;
        await waitDone(g1, qs); await ok(call('PUT', `drawings/${g1}/units`, { units: 'mm' }, qs), 'units');
        const mK = await mOk({ row_id: rI, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length' }, g1);
        await mOk({ row_id: rI, tool: 'manual', deduct: true, geom: { tool: 'line', pts: [[0, 100], [4000, 100]] } }, g1);   // −4 m: 5 − 4 = 1
        const g2 = (await replace(g1, 'Fake kerb B', Buffer.from(kerbOf(3000)))).j.id;
        await waitDone(g2, qs); await ok(call('PUT', `drawings/${g2}/units`, { units: 'mm' }, qs), 'units');
        const nc = await ok(call('GET', `drawings/${g2}/compare`, null, viewer), 'compare');
        assert.deepStrictEqual(nc.items.map(x => [x.status, x.new_qty]), [['changed', 3], ['review', -4]]);
        const sN = JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(TN), db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(TN),
          db.prepare('SELECT * FROM tender_rows WHERE tender_id=? ORDER BY id').all(TN)]), nAcc2 = audits('replace_accept').length;
        r = await ACCEPT(g2, { expect: expOf(nc.items) });
        assert.strictEqual(r.s, 400, JSON.stringify(r.j)); assert.match(r.j.error, /deductions exceed/);
        assert.strictEqual(JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(TN), db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(TN),
          db.prepare('SELECT * FROM tender_rows WHERE tender_id=? ORDER BY id').all(TN)]), sN, 'rolled back');
        assert.strictEqual(audits('replace_accept').length, nAcc2);
        assert.strictEqual(mK.qty, 5);
        await ok(call('DELETE', `tenders/${TN}`, null, qs), 'tidy');
      }

      // Task 4 (Task 3 carry-over): a PDF accept that fails after the calibrations were copied leaves no copy behind. The
      // imported row (client 50 m) has a 5 m line that is off the new page (deleted) and a −4 m deduction that is kept → −4
      {
        const { writeXlsx } = require('./lib/xlsx.js');
        const TP = (await ok(call('POST', 'tenders', { title: 'Test Revisions PDF Rollback', kind: 'rta' }, qs), 'tender')).id;
        const BOQ = { file_b64: writeXlsx([{ name: 'BOQ', rows: [['No', 'Description', 'Unit', 'Qty'], ['1', 'Fake imported kerb', 'm', 50]] }]).toString('base64'),
          sheet: 'BOQ', header_row: 1, cols: { no: 'A', desc: 'B', unit: 'C', qty: 'D' } };
        await ok(call('POST', `tenders/${TP}/import`, BOQ, qs), 'import');
        const rI = (await ok(call('GET', `tenders/${TP}/rows`, null, viewer), 'rows')).find(x => x.description === 'Fake imported kerb').id;
        const pu = await upload(TP, 'Fake sheets R', makePdf(), qs);
        const [Q1] = (await ok(call('POST', `drawings/${pu.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs), 'pages')).drawings.map(x => x.id);
        await ok(call('POST', `drawings/${Q1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs), 'calibrate');
        const off = await mOk({ row_id: rI, tool: 'manual', geom: { tool: 'line', pts: [[10, 10], [10, 110]] } }, Q1);   // 5 m, off the new page
        await mOk({ row_id: rI, tool: 'manual', deduct: true, geom: { tool: 'line', pts: [[500, 1200], [500, 1280]] } }, Q1);   // −4 m, on both pages
        const nq = (await replace(Q1, 'Fake sheets R2', makeOffsetPdf())).j.id;
        await ok(call('POST', `drawings/${nq}/pages`, { pages: [{ ...OFFSET_PAGE }] }, qs), 'pages of v2');
        const pc = await ok(call('GET', `drawings/${nq}/compare`, null, viewer), 'compare');
        assert.deepStrictEqual(pc.items.map(x => [x.status, x.reason]), [['blocked', 'off_page'], ['review', 'manual_check']]);
        const allOf = () => JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(TP), db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(TP),
          db.prepare('SELECT * FROM tender_rows WHERE tender_id=? ORDER BY id').all(TP), db.prepare('SELECT * FROM calibrations ORDER BY id').all()]);
        const sP = allOf(), nAcc3 = audits('replace_accept').length;
        r = await ACCEPT(nq, { expect: expOf(pc.items, { [off.id]: { resolution: 'delete', new_qty: null } }) });
        assert.strictEqual(r.s, 400, JSON.stringify(r.j)); assert.match(r.j.error, /deductions exceed/);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM calibrations WHERE drawing_id=?').get(nq).n, 0, 'no calibration copy left on the new page');
        assert.strictEqual(allOf(), sP, 'rolled back: measurements, drawings, rows and calibrations');
        assert.strictEqual(audits('replace_accept').length, nAcc3);
        await ok(call('DELETE', `tenders/${TP}`, null, qs), 'tidy');
      }

      // Task 3: R11 and the gates of a resolution (R7). v1: ASPHALT and PAVING areas, EDGE E1 + E2, TWIN two identical lines.
      // v2: ASPHALT gone, ASPH2 two identical squares (a duplicate), E1 moved, TWIN a third identical line (2 → 3 copies).
      {
        const TG = (await ok(call('POST', 'tenders', { title: 'Test Revisions Resolution Gates', kind: 'rta' }, qs), 'tender')).id;
        const rgM = (await ok(call('POST', `tenders/${TG}/rows`, { description: 'Fake edging', unit: 'm' }, qs), 'row')).id;
        const rgA = (await ok(call('POST', `tenders/${TG}/rows`, { description: 'Fake surfacing', unit: 'm2' }, qs), 'row')).id;
        const gv = v2 => dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...tables([layerRec('ASPHALT'), layerRec('ASPH2'), layerRec('PAVING'), layerRec('EDGE'), layerRec('TWIN')]),
          ...sec('ENTITIES', [...(v2 ? [...lwp('Q1', sq(40000, 0, 2000), true, 'ASPH2'), ...lwp('Q2', sq(40000, 0, 2000), true, 'ASPH2')] : lwp('RA', sq(0, 0, 10000), true, 'ASPHALT')),
            ...lwp('RP', sq(20000, 0, 5000), true, 'PAVING'),
            ...(v2 ? line('E1', 'EDGE', 500, 500, 1500, 500) : line('E1', 'EDGE', 0, 0, 1000, 0)), ...line('E2', 'EDGE', 0, 100, 2000, 100),
            ...line('W1', 'TWIN', 0, 0, 0, 500), ...line('W2', 'TWIN', 0, 0, 0, 500), ...(v2 ? line('W3', 'TWIN', 0, 0, 0, 500) : [])])]);
        const g1 = (await upload(TG, 'Fake gates A', Buffer.from(gv(false)), qs)).j.id;
        await waitDone(g1, qs); await ok(call('PUT', `drawings/${g1}/units`, { units: 'mm' }, qs), 'units');
        const gA = await mOk({ row_id: rgA, tool: 'dxf_layer', layer: 'ASPHALT', metric: 'area' }, g1);
        const gP = await mOk({ row_id: rgA, tool: 'dxf_layer', layer: 'PAVING', metric: 'area' }, g1);
        const gX = await mOk({ row_id: rgM, tool: 'dxf_layer', layer: 'ASPHALT', metric: 'closed_perimeter' }, g1);
        const gS = await mOk({ row_id: rgM, tool: 'dxf_selection', metric: 'open_length', handles: ['E1', 'E2'] }, g1);
        const gS2 = await mOk({ row_id: rgM, tool: 'dxf_selection', metric: 'open_length', handles: ['E2'] }, g1);   // overlaps gS (confirmed)
        const gW = await mOk({ row_id: rgM, tool: 'dxf_layer', layer: 'TWIN', metric: 'open_length', confirm_duplicate: true }, g1);
        const g2 = (await replace(g1, 'Fake gates B', Buffer.from(gv(true)))).j.id;
        await waitDone(g2, qs); await ok(call('PUT', `drawings/${g2}/units`, { units: 'mm' }, qs), 'units');
        const gc = await ok(call('GET', `drawings/${g2}/compare`, null, viewer), 'compare');
        const gi = new Map(gc.items.map(x => [x.measurement_id, x]));
        assert.deepStrictEqual(gc.items.map(x => [x.measurement_id, x.status, x.reason ?? null]), [[gA.id, 'blocked', 'layer_empty'], [gP.id, 'same', null], [gX.id, 'blocked', 'layer_empty'],
          [gS.id, 'blocked', 'geometry_changed'], [gS2.id, 'same', null], [gW.id, 'blocked', 'confirm_needed']]);
        assert.deepStrictEqual(gi.get(gA.id).relink_choices, ['ASPH2', 'PAVING']);
        // R11: TWIN was confirmed with its duplicates; it has more now → confirm_needed again, with the old and new counts
        const tw = gi.get(gW.id);
        assert.deepStrictEqual([tw.gates, tw.options, Object.keys(tw.gate_counts)], [['duplicate'], ['delete', 'confirm'], ['duplicate']]);
        assert.ok(tw.gate_counts.duplicate.old > 0 && tw.gate_counts.duplicate.new > tw.gate_counts.duplicate.old, JSON.stringify(tw.gate_counts));
        rel(tw.new_qty, 1.5, 'three copies of 0.5 m');
        const base3 = { [gX.id]: { resolution: 'delete', new_qty: null }, [gW.id]: { resolution: 'confirm' } };
        // the gates of a resolution: relink to ASPH2 brings its duplicate; keep_matched E2 overlaps gS2 on the row
        r = await ACCEPT(g2, { expect: expOf(gc.items, { ...base3, [gA.id]: { resolution: 'relink', to: 'ASPH2', new_qty: null }, [gS.id]: { resolution: 'keep_matched', new_qty: null } }) });
        assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.deepStrictEqual([r.j.code, r.j.error], ['resolution_preview', PREVIEW]);
        assert.deepStrictEqual(r.j.resolved.map(x => [x.measurement_id, x.resolution, x.to, x.gates]), [[gA.id, 'relink', 'ASPH2', ['duplicate']], [gX.id, 'delete', undefined, []],
          [gS.id, 'keep_matched', undefined, ['overlap']], [gW.id, 'confirm', undefined, ['duplicate']]]);
        rel(r.j.resolved[0].new_qty, 8, 'two 4 m2 squares'); assert.strictEqual(r.j.resolved[1].new_qty, null); rel(r.j.resolved[2].new_qty, 2, 'E2');
        assert.deepStrictEqual(r.j.resolved_totals, { rows: handTotals(gc.items, r.j.resolved) }, 'R18b: a deleted item counts 0');
        // relink to PAVING: gP already measures it on the row → overlap
        r = await ACCEPT(g2, { expect: expOf(gc.items, { ...base3, [gA.id]: { resolution: 'relink', to: 'PAVING', new_qty: null }, [gS.id]: { resolution: 'keep_matched', new_qty: 2 } }) });
        assert.strictEqual(r.s, 409); assert.strictEqual(r.j.code, 'resolution_preview');
        assert.deepStrictEqual(r.j.resolved[0], { measurement_id: gA.id, resolution: 'relink', to: 'PAVING', new_qty: gP.qty, gates: ['overlap'] });
        // the right quantities but the gates not confirmed → 409, nothing changed
        const sG = JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(TG), db.prepare('SELECT * FROM measurement_handles ORDER BY rowid').all(),
          db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(TG)]);
        const exact = { ...base3, [gA.id]: { resolution: 'relink', to: 'PAVING', new_qty: gP.qty }, [gS.id]: { resolution: 'keep_matched', new_qty: r.j.resolved[2].new_qty } };
        r = await ACCEPT(g2, { expect: expOf(gc.items, exact) });
        assert.strictEqual(r.s, 409); assert.deepStrictEqual([r.j.code, r.j.error], ['confirm_checks', 'confirm the checks of the chosen resolutions']);
        assert.deepStrictEqual(r.j.resolved_totals, { rows: handTotals(gc.items, r.j.resolved) });
        assert.deepStrictEqual(r.j.resolved.filter(x => x.gates.length).map(x => [x.measurement_id, x.gates]), [[gA.id, ['overlap']], [gS.id, ['overlap']], [gW.id, ['duplicate']]]);
        assert.strictEqual(JSON.stringify([db.prepare('SELECT * FROM measurements WHERE tender_id=? ORDER BY id').all(TG), db.prepare('SELECT * FROM measurement_handles ORDER BY rowid').all(),
          db.prepare('SELECT * FROM drawings WHERE tender_id=? ORDER BY id').all(TG)]), sG, 'nothing changed');
        // confirmed → accepted: the flags record what was confirmed
        exact[gA.id].confirm = ['overlap']; exact[gS.id].confirm = ['overlap'];
        const ga = await ok(ACCEPT(g2, { expect: expOf(gc.items, exact) }), 'accept gates');
        assert.deepStrictEqual([ga.kept, ga.deleted, ga.relinked, ga.kept_matched, ga.confirmed], [5, 1, 1, 1, 1]);
        const gRow = id => db.prepare('SELECT * FROM measurements WHERE id=?').get(id);
        assert.deepStrictEqual([gRow(gA.id).layer, gRow(gA.id).qty, gRow(gA.id).duplicate], ['PAVING', gP.qty, 0]);
        assert.deepStrictEqual([gRow(gW.id).duplicate, gRow(gW.id).drawing_id], [1, g2]); rel(gRow(gW.id).qty, 1.5, 'TWIN confirmed');
        assert.strictEqual(gRow(gX.id), undefined, 'deleted');
        assert.deepStrictEqual(db.prepare('SELECT handle FROM measurement_handles WHERE measurement_id=?').all(gS.id).map(x => x.handle), ['E2']);
        assert.deepStrictEqual(audits('replace_accept').at(-1), { replaced: g1, by: g2, kept: 5, deleted: 1, relinked: 1, kept_matched: 1, confirmed: 1, review: 0, changed_rows: 2 });
        await ok(call('DELETE', `tenders/${TG}`, null, qs), 'tender delete removes everything');
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE tender_id=?').get(TG).n, 0);
      }
    }

    // ---- batch 4 Task 5: the Excel take-off report (GET /tenders/:id/takeoff.xlsx?lang=ar|en), any reader ------------------
    {
      const { makePdf, PDF_PAGES } = require('./test/fixtures/make-takeoff.js');
      const { writeXlsx, readXlsx } = require('./lib/xlsx.js');
      const TF = require('./lib/takeoff/formula.js'), I18N = require('./public/i18n.js');
      const tr = lang => k => I18N[lang][k];
      const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
      const T = (await ok(call('POST', 'tenders', { title: 'Test Take-off Report', ref: 'TR-01', kind: 'rta' }, qs), 'tender')).id;
      const BOQ = { file_b64: writeXlsx([{ name: 'BOQ', rows: [['No', 'Description', 'Unit', 'Qty'], ['1', 'FAKE SECTION', null, null], ['1.1', 'Fake imported paving', 'm2', 100]] }]).toString('base64'),
        sheet: 'BOQ', header_row: 1, cols: { no: 'A', desc: 'B', unit: 'C', qty: 'D' } };
      await ok(call('POST', `tenders/${T}/import`, BOQ, qs), 'import');
      const rowsOf = () => ok(call('GET', `tenders/${T}/rows`, null, viewer), 'rows');
      const rI = (await rowsOf()).find(r => r.description === 'Fake imported paving').id;
      const rT = (await ok(call('POST', `tenders/${T}/rows`, { no: '2.1', description: 'Fake kerb', unit: 'm' }, qs), 'take-off row')).id;
      await ok(call('POST', `tenders/${T}/rows/${rT}/lines`, { description: 'fake extra', l: 2 }, qs), 'line');
      // a PDF page at 0.05 m/pt: 5 m on the kerb, a 1 m deduction, a 25 m2 rectangle on the imported row
      const pdfUp = await upload(T, 'Fake report sheet', makePdf(), qs);
      const [P1] = (await ok(call('POST', `drawings/${pdfUp.j.id}/pages`, { pages: PDF_PAGES.map(p => ({ ...p })) }, qs), 'pages')).drawings.map(x => x.id);
      await ok(call('POST', `drawings/${P1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs), 'calibrate');
      const manual = b => ok(call('POST', `drawings/${P1}/measurements`, { tool: 'manual', ...b }, qs), 'manual');
      const mL = await manual({ row_id: rT, geom: { tool: 'line', pts: [[0, 100], [100, 100]] }, label: 'Fake kerb north' });
      const mD = await manual({ row_id: rT, geom: { tool: 'line', pts: [[0, 200], [20, 200]] }, deduct: true });
      const mR = await manual({ row_id: rI, geom: { tool: 'rect', p1: [200, 200], p2: [300, 300] } });
      // a DXF in mm: the KERB layer's open length (5 m) on the kerb row
      const dx = await upload(T, 'Fake report plan', Buffer.from(FIXTURE), qs);
      assert.strictEqual((await waitDone(dx.j.id, qs)).status, 'ready');
      await ok(call('PUT', `drawings/${dx.j.id}/units`, { units: 'mm' }, qs), 'units');
      const mK = await ok(call('POST', `drawings/${dx.j.id}/measurements`, { row_id: rT, tool: 'dxf_layer', layer: 'KERB', metric: 'open_length', factor: 2 }, qs), 'dxf');
      // an older version of the plan, replaced by it (history); one measurement flagged for review
      const old = await upload(T, 'Fake report plan v0', Buffer.from(FIXTURE), qs);
      await waitDone(old.j.id, qs);
      db.prepare('UPDATE drawings SET replaced_by=?, rev=1 WHERE id=?').run(dx.j.id, old.j.id); db.prepare('UPDATE drawings SET rev=2 WHERE id=?').run(dx.j.id);
      db.prepare('UPDATE measurements SET review_needed=1 WHERE id=?').run(mL.id);

      const get = async (q, ck = viewer) => { const r = await fetch(base + `tenders/${T}/takeoff.xlsx` + q, { headers: { cookie: ck } }); return { s: r.status, h: r.headers, b: Buffer.from(await r.arrayBuffer()) }; };
      // refusals
      assert.strictEqual((await get('?lang=en', '')).s, 401, 'no session');
      assert.strictEqual((await get('?lang=fr')).s, 400, 'lang must be ar or en');
      assert.strictEqual((await fetch(base + 'tenders/999999/takeoff.xlsx', { headers: { cookie: viewer } })).status, 404);
      // a viewer downloads it
      const en = await get('?lang=en');
      assert.strictEqual(en.s, 200, en.b.toString());
      assert.strictEqual(en.h.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.strictEqual(en.h.get('content-disposition'), 'attachment; filename="tender-TR-01-rev1-takeoff-DRAFT.xlsx"');
      const wb = readXlsx(en.b);
      assert.deepStrictEqual(wb.sheets.map(x => [x.name, !!x.rtl]), [['Measurements', false], ['Rows', false], ['Drawings', false]]);
      const [SM, SR, SD] = wb.sheets;
      // header: the tender, its ref, the date it was made, and the draft label on every sheet
      for (const sh of wb.sheets) {
        const top = sh.rows.slice(0, 4).flat();
        assert.ok(top.includes('Test Take-off Report') && top.includes('TR-01'), sh.name + ': tender in the header');
        assert.ok(top.includes('DRAFT — NOT APPROVED') && top.includes('مسودة — غير معتمدة'), sh.name + ': draft label');
        assert.ok(top.some(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)), sh.name + ': generation date');
      }
      // a table: the row whose first cell is the first heading; cells by heading
      const tableOf = (sh, first) => {
        const hi = sh.rows.findIndex(r => r[0] === first);
        assert.ok(hi >= 0, sh.name + ': heading row');
        const heads = sh.rows[hi];
        return sh.rows.slice(hi + 1).filter(r => r.length).map(r => Object.fromEntries(heads.map((h, i) => [h, r[i] ?? null])));
      };
      // Measurements: the list's own formula text and stored qty, as numbers
      const list = await ok(call('GET', `tenders/${T}/measurements`, null, viewer), 'list');
      const all = [...list.measurements, ...list.unlinked];
      const mt = tableOf(SM, 'ID');
      assert.deepStrictEqual(mt.map(x => x.ID).sort((a, b) => a - b), all.map(m => m.id).sort((a, b) => a - b), 'every measurement once');
      for (const m of all) {
        const x = mt.find(y => y.ID === m.id);
        assert.strictEqual(x.Formula, TF.formulaText(m, tr('en')), 'formula text = the list: ' + m.id);
        assert.strictEqual(x.Qty, m.qty, 'stored qty'); assert.strictEqual(typeof x.Qty, 'number');
        assert.strictEqual(x.Unit, m.qty_unit);
        assert.strictEqual(x['Created by'], 'qs1');
      }
      const byId = id => mt.find(y => y.ID === id);
      assert.strictEqual(byId(mL.id).Formula, 'length 100.00 pt × 0.05 m/pt = 5.00 m');
      assert.strictEqual(byId(mD.id).Formula, 'length 20.00 pt × 0.05 m/pt = 1.00 m × −1 = -1.00 m');
      assert.strictEqual(byId(mK.id).Formula, 'open length 5.00 m × factor 2 = 10.00 m');
      assert.deepStrictEqual([byId(mL.id).Drawing, byId(mL.id).Page, byId(mL.id).Label, byId(mL.id)['Row no.'], byId(mL.id)['Row description']],
        [db.prepare('SELECT name FROM drawings WHERE id=?').get(P1).name, 1, 'Fake kerb north', '2.1', 'Fake kerb']);
      assert.deepStrictEqual([byId(mK.id).Drawing, byId(mK.id).Rev, byId(mK.id).Tool, byId(mK.id).Measure, byId(mK.id)['Calibration / units']],
        ['Fake report plan', 2, 'DXF layer: KERB', 'open length', 'drawing units mm']);
      assert.strictEqual(byId(mL.id)['Calibration / units'], 'page calibration · not verified', 'as the list: the calibration and its check');
      assert.deepStrictEqual([byId(mL.id)['Review needed'], byId(mK.id)['Review needed'], byId(mD.id).Deduction, byId(mL.id).Deduction], ['Yes', null, 'Yes', null]);
      assert.strictEqual(byId(mR.id).Tool, 'drawn: Rectangle');
      // Rows: the tender API's row qty and measured qty, never recomputed
      const api = await rowsOf(), rt = tableOf(SR, 'No.');
      const apiT = api.find(r => r.id === rT), apiI = api.find(r => r.id === rI);
      const xT = rt.find(x => x.Description === 'Fake kerb'), xI = rt.find(x => x.Description === 'Fake imported paving');
      assert.strictEqual(xT.Total, apiT.qty, 'take-off total = the API row qty'); assert.ok(Math.abs(apiT.qty - 16) < 1e-9, 'kerb 2 + 5 − 1 + 10');
      assert.strictEqual(xT['From measurements'], apiT.measured_qty); assert.strictEqual(xT['From lines'], 2);
      assert.deepStrictEqual([xT.Source, xT.Unit, xT['Client qty'], xT.Measured, xT['Difference %']], ['take-off', 'm', null, null, null]);
      assert.deepStrictEqual([xI.Source, xI.Unit, xI['Client qty'], xI.Total, xI['From lines']], ['client BOQ', 'm2', 100, null, null]);
      assert.strictEqual(xI.Measured, apiI.measured_qty); assert.strictEqual(xI['Difference %'], apiI.measured_diff_pct);
      assert.ok(Math.abs(apiI.measured_diff_pct + 75) < 1e-9, '25 m2 vs 100 m2');
      assert.ok(rt.some(x => x.Description === 'FAKE SECTION' && x.Total === null), 'heading listed, no numbers');
      // Drawings: name, kind, rev, page, units/scale, short sha256, uploaded by/at, replaced by
      const dt = tableOf(SD, 'Drawing'), dRow = id => db.prepare('SELECT * FROM drawings WHERE id=?').get(id);
      const xd = dt.find(x => x.Drawing === 'Fake report plan'), xo = dt.find(x => x.Drawing === 'Fake report plan v0'), xp = dt.find(x => x.Drawing === dRow(P1).name && x.Page === 1);
      assert.deepStrictEqual([xd.Kind, xd.Rev, xd['Units / scale'], xd['SHA-256 (short)'], xd['Uploaded by'], xd['Replaced by']], ['dxf', 2, 'mm', dRow(dx.j.id).sha256.slice(0, 12), 'qs1', null]);
      assert.strictEqual(xd['Uploaded at'], dRow(dx.j.id).created);
      assert.strictEqual(xo['Replaced by'], 'Fake report plan (Rev 2)');
      assert.deepStrictEqual([xp.Kind, xp['Units / scale']], ['pdf', 'Page: 1 pt = 0.05 m · not verified']);
      // Arabic: right-to-left sheets, Arabic headings, the formula in Arabic as the Arabic list shows it
      const ar = readXlsx((await get('?lang=ar')).b);
      assert.deepStrictEqual(ar.sheets.map(x => [x.name, x.rtl]), [['القياسات', true], ['البنود', true], ['المخططات', true]]);
      const amt = tableOf(ar.sheets[0], I18N.ar.rp_id);
      assert.ok(I18N.ar.rp_formula in amt[0] && I18N.ar.rp_qty in amt[0], 'Arabic headings');
      for (const m of all) assert.strictEqual(amt.find(y => y[I18N.ar.rp_id] === m.id)[I18N.ar.rp_formula], TF.formulaText(m, tr('ar')), 'AR formula = the AR list');
      assert.ok(TF.formulaText(all.find(m => m.id === mK.id), tr('ar')).startsWith('طول مفتوح'), 'Arabic words');
      // the calibration cell in Arabic: plain text, no direction marks (batch 4 Task 6 fix round 2)
      const axp = tableOf(ar.sheets[2], I18N.ar.rp_drawing).find(x => x[I18N.ar.rp_drawing] === dRow(P1).name && x[I18N.ar.rp_page] === 1);
      assert.strictEqual(axp[I18N.ar.rp_units_scale], 'الصفحة: 1 نقطة = 0.05 م · لم يُتحقق منه', 'AR calibration cell: ' + JSON.stringify(axp[I18N.ar.rp_units_scale]));
      // not a draft once approved: no label, no -DRAFT in the name
      db.prepare("UPDATE tenders SET status='approved' WHERE id=?").run(T);
      const ap = await get('?lang=en');
      assert.strictEqual(ap.h.get('content-disposition'), 'attachment; filename="tender-TR-01-rev1-takeoff.xlsx"');
      assert.ok(!readXlsx(ap.b).sheets[0].rows.flat().includes('DRAFT — NOT APPROVED'), 'approved: no draft label');
      assert.strictEqual(readXlsx((await get('')).b).sheets[0].name, 'Measurements', 'English by default');
    }

    // ---- batch 4 final review: version chains (DXF and PDF), report calibration, re-import guard, cancel releases the file,
    // a tender deleted inside the accept window, the mixed-units note -------------------------------------------------------
    {
      const { writeXlsx, readXlsx } = require('./lib/xlsx.js');
      const I18N = require('./public/i18n.js');
      const ok = async (p, msg) => { const r = await p; assert.strictEqual(r.s, 200, `${msg}: ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
      const dRow = id => db.prepare('SELECT * FROM drawings WHERE id=?').get(id);
      const replaceUp = async (id, name, body) => {
        const r = await fetch(base + `drawings/${id}/replace?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: qs }, body });
        return { s: r.status, j: await r.json().catch(() => null) };
      };
      const expOf = items => items.map(i => ({ measurement_id: i.measurement_id, new_qty: i.new_qty }));
      const tableOf = (sh, first) => {
        const hi = sh.rows.findIndex(r => r[0] === first);
        assert.ok(hi >= 0, sh.name + ': heading row');
        const heads = sh.rows[hi];
        return sh.rows.slice(hi + 1).filter(r => r.length).map(r => Object.fromEntries(heads.map((h, i) => [h, r[i] ?? null])));
      };
      const report = async T => { const r = await fetch(base + `tenders/${T}/takeoff.xlsx?lang=en`, { headers: { cookie: viewer } }); assert.strictEqual(r.status, 200); return readXlsx(Buffer.from(await r.arrayBuffer())).sheets; };
      const BOQ = (desc, unit, q) => ({ file_b64: writeXlsx([{ name: 'BOQ', rows: [['No', 'Description', 'Unit', 'Qty'], ['1', desc, unit, q]] }]).toString('base64'),
        sheet: 'BOQ', header_row: 1, cols: { no: 'A', desc: 'B', unit: 'C', qty: 'D' } });
      const PENDING = 'a drawing replacement is pending';

      // M7: a DXF chain v1 → v2 → v3 (units mm, mm, m): replaced_by / replaces_id link every version; older ones are history
      const chainDxf = (kerb, extra) => dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...tables([layerRec('KERB'), layerRec('X')]),
        ...sec('ENTITIES', [...line('K1', 'KERB', 0, 0, kerb, 0), ...line('X1', 'X', 0, 0, extra, 0)])]);
      const T = (await ok(call('POST', 'tenders', { title: 'Test Chain', kind: 'rta' }, qs), 'tender')).id;
      const row = (await ok(call('POST', `tenders/${T}/rows`, { description: 'Fake kerb', unit: 'm' }, qs), 'row')).id;
      const v1 = (await upload(T, 'Fake chain v1', Buffer.from(chainDxf(5000, 10)), qs)).j.id;
      assert.strictEqual((await waitDone(v1, qs)).status, 'ready');
      await ok(call('PUT', `drawings/${v1}/units`, { units: 'mm' }, qs), 'units v1');
      const mL = await ok(call('POST', `drawings/${v1}/measurements`, { tool: 'dxf_layer', layer: 'KERB', metric: 'open_length', row_id: row }, qs), 'layer');
      const mM = await ok(call('POST', `drawings/${v1}/measurements`, { tool: 'manual', geom: { tool: 'line', pts: [[0, 0], [2000, 0]] }, row_id: row, confirm_overlap: true }, qs), 'manual');
      // M5: a cancelled new version whose file no other drawing uses: its stored file (and parse files) are removed
      {
        const c = await replaceUp(v1, 'Fake chain cancelled', Buffer.from(chainDxf(5500, 10.5)));
        assert.strictEqual(c.s, 202, JSON.stringify(c.j)); await waitDone(c.j.id, qs);
        const sha = dRow(c.j.id).sha256, files = () => dirFiles().filter(f => f.startsWith(sha));
        assert.ok(files().includes(sha + '.dxf') && files().includes(sha + '.summary.json.gz'), 'stored and parsed: ' + files());
        await ok(call('DELETE', `drawings/${c.j.id}`, null, qs), 'cancel');
        assert.deepStrictEqual(files(), [], 'the cancelled version\'s files are released');
        assert.ok(fs.existsSync(path.join(DDIR, dRow(v1).sha256 + '.dxf')), 'the current drawing\'s file stays');
        // the same content as the current drawing: the file is still used, so it stays
        const s = await replaceUp(v1, 'Fake chain same file', Buffer.from(chainDxf(5000, 10)));
        await waitDone(s.j.id, qs);
        await ok(call('DELETE', `drawings/${s.j.id}`, null, qs), 'cancel same file');
        assert.ok(fs.existsSync(path.join(DDIR, dRow(v1).sha256 + '.dxf')), 'a file another drawing uses stays');
      }
      const step = async (from, kerb, extra, units, between) => {
        const r = await replaceUp(from, 'Fake chain v', Buffer.from(chainDxf(kerb, extra)));
        assert.strictEqual(r.s, 202, JSON.stringify(r.j)); const v = r.j.id; await waitDone(v, qs);
        await ok(call('PUT', `drawings/${v}/units`, { units }, qs), 'units pending');
        const c = await ok(call('GET', `drawings/${v}/compare`, null, qs), 'compare');
        if (between) await between(v, c);
        await ok(call('POST', `drawings/${v}/accept`, { expect: expOf(c.items) }, qs), 'accept');
        return { v, c };
      };
      // M3: a BOQ re-import is refused while a replacement is pending (rows unchanged), allowed again after accept
      const s2 = await step(v1, 6000, 11, 'mm', async () => {
        const before = JSON.stringify(db.prepare('SELECT * FROM tender_rows WHERE tender_id=?').all(T));
        const r = await call('POST', `tenders/${T}/import`, BOQ('Fake imported paving', 'm2', 100), qs);
        assert.strictEqual(r.s, 409, JSON.stringify(r.j)); assert.strictEqual(r.j.error, PENDING);
        assert.strictEqual(JSON.stringify(db.prepare('SELECT * FROM tender_rows WHERE tender_id=?').all(T)), before, 'nothing imported');
      });
      const v2 = s2.v;
      assert.deepStrictEqual(s2.c.items.map(i => [i.measurement_id, i.status, i.old_qty, i.new_qty]), [[mL.id, 'changed', 5, 6], [mM.id, 'review', 2, 2]]);
      const s3 = await step(v2, 7, 12, 'm');
      const v3 = s3.v;
      assert.deepStrictEqual(s3.c.items.map(i => [i.measurement_id, i.status, i.old_qty, i.new_qty]), [[mL.id, 'changed', 6, 7], [mM.id, 'review', 2, 2000]], 'm: the drawn line in metres');
      assert.deepStrictEqual([v1, v2, v3].map(id => { const d = dRow(id); return [d.rev, d.pending, d.replaces_id, d.replaced_by, d.units]; }),
        [[1, 0, null, v2, 'mm'], [2, 0, v1, v3, 'mm'], [3, 0, v2, null, 'm']], 'the chain');
      assert.deepStrictEqual(db.prepare('SELECT id, drawing_id, qty, review_needed FROM measurements WHERE tender_id=? ORDER BY id').all(T).map(x => ({ ...x })),
        [{ id: mL.id, drawing_id: v3, qty: 7, review_needed: 0 }, { id: mM.id, drawing_id: v3, qty: 2000, review_needed: 1 }]);
      assert.strictEqual(db.prepare('SELECT qty FROM tender_rows WHERE id=?').get(row).qty, 2007);
      // history is read only: units, a new version, measuring
      for (const old of [v1, v2]) {
        assert.strictEqual((await call('PUT', `drawings/${old}/units`, { units: 'm' }, qs)).s, 409, 'units of history ' + old);
        assert.strictEqual((await replaceUp(old, 'x', Buffer.from(chainDxf(1, 1)))).s, 409, 'a new version of history ' + old);
        assert.strictEqual((await call('POST', `drawings/${old}/measurements`, { tool: 'dxf_layer', layer: 'X', metric: 'open_length', row_id: row }, qs)).s, 409, 'measuring history ' + old);
      }
      // the report lists every version, each replaced by the next
      const rd = tableOf((await report(T))[2], 'Drawing');
      assert.deepStrictEqual(rd.map(x => [x.Rev, x['Replaced by']]), [[1, 'Fake chain v (Rev 2)'], [2, 'Fake chain v (Rev 3)'], [3, null]]);
      // M4: the tender deleted between the async comparison and the accept tx → 404, not a 500
      {
        const r = await replaceUp(v3, 'Fake chain v4', Buffer.from(chainDxf(8, 13)));
        const v4 = r.j.id; await waitDone(v4, qs);
        await ok(call('PUT', `drawings/${v4}/units`, { units: 'm' }, qs), 'units v4');
        const c = await ok(call('GET', `drawings/${v4}/compare`, null, qs), 'compare v4');
        let gone = null;
        ctx.drawings._hooks.beforeAcceptTx = async () => { if (!gone) gone = await call('DELETE', `tenders/${T}`, null, qs); };
        let a;
        try { a = await call('POST', `drawings/${v4}/accept`, { expect: expOf(c.items) }, qs); }
        finally { ctx.drawings._hooks.beforeAcceptTx = null; }
        assert.ok(gone, 'the hook ran'); assert.strictEqual(gone.s, 200, JSON.stringify(gone.j));
        assert.deepStrictEqual([a.s, a.j.error], [404, 'tender not found']);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drawings WHERE tender_id=?').get(T).n, 0);
      }

      // M7 + I2: a PDF chain (2 pages → 2 pages → 1 page): the page calibration copied at each accept, copied_from chaining
      // back; the report's calibration cells say "copied … verify" as the list does, and the % once verified
      const fakePdf = tag => Buffer.from('%PDF-1.4\n% fake ' + tag + '\n');
      const pages = n => ({ pages: Array.from({ length: n }, (_, i) => ({ page: i + 1, width: 600, height: 400, rotation: 0 })) });
      const TP = (await ok(call('POST', 'tenders', { title: 'Test PDF Chain', kind: 'rta' }, qs), 'tender')).id;
      const prow = (await ok(call('POST', `tenders/${TP}/rows`, { description: 'Fake edging', unit: 'm' }, qs), 'row')).id;
      const p1 = (await upload(TP, 'Fake sheet', fakePdf('a'), qs)).j.id;
      await ok(call('POST', `drawings/${p1}/pages`, pages(2), qs), 'pages');
      const cal1 = (await ok(call('POST', `drawings/${p1}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 1, unit: 'm' }, qs), 'calibrate')).calibration.id;
      const pm = await ok(call('POST', `drawings/${p1}/measurements`, { tool: 'manual', geom: { tool: 'line', pts: [[0, 10], [200, 10]] }, row_id: prow }, qs), 'drawn');
      // M5 for a PDF: a cancelled new version (its pages registered) releases its file
      {
        const c = await replaceUp(p1, 'Fake sheet cancelled', fakePdf('cancelled'));
        await ok(call('POST', `drawings/${c.j.id}/pages`, pages(2), qs), 'pages');
        const f = path.join(DDIR, dRow(c.j.id).sha256 + '.pdf');
        assert.ok(fs.existsSync(f));
        await ok(call('DELETE', `drawings/${c.j.id}`, null, qs), 'cancel');
        assert.ok(!fs.existsSync(f), 'the cancelled PDF is released');
      }
      let prev = p1;
      const chainP = [p1];
      for (const [tag, n] of [['b', 2], ['c', 1]]) {
        const v = (await replaceUp(prev, 'Fake sheet ' + tag, fakePdf(tag))).j.id;
        await ok(call('POST', `drawings/${v}/pages`, pages(n), qs), 'pages ' + tag);
        const c = await ok(call('GET', `drawings/${v}/compare`, null, qs), 'compare ' + tag);
        assert.deepStrictEqual(c.items.map(i => [i.measurement_id, i.status]), [[pm.id, 'review']]);
        await ok(call('POST', `drawings/${v}/accept`, { expect: expOf(c.items) }, qs), 'accept ' + tag);
        chainP.push(v); prev = v;
      }
      const [, pB, pC] = chainP;
      assert.deepStrictEqual(chainP.map(id => { const d = dRow(id); return [d.rev, d.page, d.replaces_id, d.replaced_by]; }), [[1, 1, null, pB], [2, 1, p1, pC], [3, 1, pB, null]]);
      const cals = db.prepare('SELECT id, drawing_id, scale, copied_from FROM calibrations WHERE drawing_id IN (?, ?, ?) ORDER BY id').all(p1, pB, pC).map(x => ({ ...x }));
      assert.deepStrictEqual(cals.map(x => [x.drawing_id, x.scale]), [[p1, 0.01], [pB, 0.01], [pC, 0.01]]);
      assert.deepStrictEqual(cals.map(x => x.copied_from), [null, cal1, cals[1].id], 'copied_from chains back to the first calibration');
      const pmRow = db.prepare('SELECT drawing_id, calibration_id, qty, review_needed FROM measurements WHERE id=?').get(pm.id);
      assert.deepStrictEqual({ ...pmRow }, { drawing_id: pC, calibration_id: cals[2].id, qty: 2, review_needed: 1 });
      // history is read only: verify / calibrate an older page
      assert.strictEqual((await call('POST', `drawings/${pB}/calibrations/${cals[1].id}/verify`, { p1: [0, 0], p2: [100, 0], real: 1, unit: 'm' }, qs)).s, 409);
      // I2: the calibration cells of the report
      const COPIED = I18N.en.tl_copied;
      let [SM, , SD] = await report(TP);
      assert.strictEqual(tableOf(SM, 'ID').find(x => x.ID === pm.id)['Calibration / units'], `page calibration · not verified · ${COPIED}`, 'measurement: copied, to verify');
      assert.strictEqual(tableOf(SD, 'Drawing').find(x => x.Rev === 3)['Units / scale'], `Page: 1 pt = 0.01 m · not verified · ${COPIED}`, 'drawing: copied, to verify');
      assert.strictEqual(tableOf(SD, 'Drawing').find(x => x.Rev === 1 && x.Page === 1)['Units / scale'], 'Page: 1 pt = 0.01 m · not verified', 'the first one was not copied');
      const vf = await ok(call('POST', `drawings/${pC}/calibrations/${cals[2].id}/verify`, { p1: [0, 0], p2: [100, 0], real: 0.995, unit: 'm' }, qs), 'verify');
      const pctText = (vf.pct > 0 ? '+' : '') + vf.pct.toFixed(2) + ' %';
      assert.strictEqual(pctText, '+0.50 %', 'the fixture: ' + vf.pct);
      [SM, , SD] = await report(TP);
      assert.strictEqual(tableOf(SM, 'ID').find(x => x.ID === pm.id)['Calibration / units'], 'page calibration · verified +0.50 %', 'measurement: verified, the % as the list shows it');
      assert.strictEqual(tableOf(SD, 'Drawing').find(x => x.Rev === 3)['Units / scale'], 'Page: 1 pt = 0.01 m · verified +0.50 %');
      const ar = await (async () => { const r = await fetch(base + `tenders/${TP}/takeoff.xlsx?lang=ar`, { headers: { cookie: viewer } }); return readXlsx(Buffer.from(await r.arrayBuffer())).sheets; })();
      assert.strictEqual(tableOf(ar[0], I18N.ar.rp_id).find(x => x[I18N.ar.rp_id] === pm.id)[I18N.ar.rp_cal], 'معايرة الصفحة · تم التحقق +0.50 %', 'Arabic: plain text, no direction marks');

      // M1: the mixed-units note of an imported row: numbers as the screen formats them (at most 3 decimals)
      {
        const TM = (await ok(call('POST', 'tenders', { title: 'Test Mixed Units', kind: 'rta' }, qs), 'tender')).id;
        await ok(call('POST', `tenders/${TM}/import`, BOQ('Fake imported kerb', 'm', 10), qs), 'import');
        const ri = (await ok(call('GET', `tenders/${TM}/rows`, null, qs), 'rows')).find(r => r.description === 'Fake imported kerb').id;
        const pp = (await upload(TM, 'Fake mixed sheet', fakePdf('mixed'), qs)).j.id;
        await ok(call('POST', `drawings/${pp}/pages`, pages(1), qs), 'pages');
        await ok(call('POST', `drawings/${pp}/calibrations`, { p1: [0, 0], p2: [100, 0], real: 5, unit: 'm' }, qs), 'calibrate');
        await ok(call('POST', `drawings/${pp}/measurements`, { tool: 'manual', geom: { tool: 'line', pts: [[0, 100], [100 / 3, 100]] }, row_id: ri }, qs), 'line');
        // one unit per row is enforced now: older data can still hold two (as in the rowMeasuredQty test above)
        db.prepare("INSERT INTO measurements(drawing_id,tender_id,row_id,tool,metric,qty,qty_unit,created,created_by) VALUES(?,?,?,'manual','area',25,'m2','x','qs1')").run(pp, TM, ri);
        const x = tableOf((await report(TM))[1], 'No.').find(r => r.Description === 'Fake imported kerb');
        assert.strictEqual(x.Note, 'mixed units: 1.667 m; 25 m2');
      }
    }

    // ---- final review M7: a database made by the batch-3 schema (no pending / replaces_id / copied_from) opens, upgrades
    // itself (additive columns only) and reads as before -----------------------------------------------------------------
    {
      const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'est-drawings-migrate-')); TMP_DIRS.push(dir4);
      const m = spawnSync(process.execPath, ['--no-warnings', '-e', `
        const path = require('path'), { DatabaseSync } = require('node:sqlite');
        // the batch-3 CREATE statements of these tables (modules/drawings.js at 51d5bb1, its added columns folded in)
        const old = new DatabaseSync(path.join(process.env.DATA_DIR, 'estimation.db'));
        old.exec(\`
CREATE TABLE drawings(id INTEGER PRIMARY KEY AUTOINCREMENT, tender_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'dxf', name TEXT, sha256 TEXT, bytes INTEGER,
  units TEXT, suggested_units TEXT, status TEXT, error TEXT, rev INTEGER DEFAULT 1, replaced_by INTEGER, created TEXT, created_by TEXT,
  failed_version INTEGER, page INTEGER, page_w REAL, page_h REAL, rotation INTEGER, parent_id INTEGER, page_x0 REAL NOT NULL DEFAULT 0, page_y0 REAL NOT NULL DEFAULT 0);
CREATE TABLE measurements(id INTEGER PRIMARY KEY AUTOINCREMENT, drawing_id INTEGER NOT NULL, tender_id INTEGER NOT NULL, row_id INTEGER,
  tool TEXT, layer TEXT, block TEXT, metric TEXT, nested INTEGER DEFAULT 0, width REAL, depth REAL, factor REAL NOT NULL DEFAULT 1, label TEXT, color TEXT,
  qty REAL, qty_unit TEXT, handles_count INTEGER, review_needed INTEGER DEFAULT 0, created TEXT, created_by TEXT,
  uom_confirmed INTEGER NOT NULL DEFAULT 0, incomplete INTEGER NOT NULL DEFAULT 0, duplicate INTEGER NOT NULL DEFAULT 0, base REAL, selection_summary TEXT,
  mixed INTEGER NOT NULL DEFAULT 0, calibration_id INTEGER, geom TEXT, deduct INTEGER NOT NULL DEFAULT 0);
CREATE TABLE calibrations(id INTEGER PRIMARY KEY AUTOINCREMENT, drawing_id INTEGER NOT NULL, region TEXT, p1x REAL NOT NULL, p1y REAL NOT NULL,
  p2x REAL NOT NULL, p2y REAL NOT NULL, real REAL NOT NULL, unit TEXT NOT NULL, scale REAL NOT NULL, verify_pct REAL, created TEXT, created_by TEXT);
CREATE TABLE measurement_handles(measurement_id INTEGER NOT NULL, handle TEXT NOT NULL, geom_key TEXT, PRIMARY KEY(measurement_id, handle));
INSERT INTO drawings(tender_id,kind,name,sha256,status,units,created) VALUES(1,'dxf','Fake old plan','${'b'.repeat(64)}','ready','mm','x');
INSERT INTO drawings(tender_id,kind,name,sha256,status,page,page_w,page_h,rotation,created) VALUES(1,'pdf','Fake old sheet — p1','${'c'.repeat(64)}','ready',1,600,400,0,'x');
INSERT INTO calibrations(drawing_id,p1x,p1y,p2x,p2y,real,unit,scale,created) VALUES(2,0,0,100,0,10,'m',0.1,'x');
INSERT INTO measurements(drawing_id,tender_id,tool,layer,metric,qty,qty_unit,base,created,created_by) VALUES(1,1,'dxf_layer','KERB','open_length',5,'m',5,'x','qs1');
INSERT INTO measurements(drawing_id,tender_id,tool,metric,qty,qty_unit,calibration_id,geom,created,created_by) VALUES(2,1,'manual','length',20,'m',1,'{"tool":"line","pts":[[0,10],[200,10]]}','x','qs1');\`);
        old.close();
        const { server, db, ctx } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
        const cols = t => db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
        db.prepare("INSERT INTO tenders(title,kind,status,created) VALUES('Fake old tender','rta','draft','x')").run();
        server.listen(0, async () => {
          const base = 'http://localhost:' + server.address().port + '/api/';
          const r = await fetch(base + 'setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret12' }) });
          const ck = r.headers.get('set-cookie').split(';')[0];
          const list = await (await fetch(base + 'tenders/1/measurements', { headers: { cookie: ck } })).json();
          const x = await fetch(base + 'tenders/1/takeoff.xlsx?lang=en', { headers: { cookie: ck } });
          const { readXlsx } = require(${JSON.stringify(path.join(__dirname, 'lib', 'xlsx.js'))});
          const sheets = x.status === 200 ? readXlsx(Buffer.from(await x.arrayBuffer())).sheets : null;
          console.log(JSON.stringify({
            drawings: ['pending', 'replaces_id'].map(c => cols('drawings').includes(c)), calibrations: cols('calibrations').includes('copied_from'),
            rows: db.prepare('SELECT id, pending, replaces_id, replaced_by FROM drawings ORDER BY id').all().map(d => ({ ...d })),
            copied: db.prepare('SELECT copied_from FROM calibrations').all().map(c => c.copied_from), pendingTender: ctx.drawings.hasPendingReplacement(1),
            list: list.measurements.concat(list.unlinked).map(m => [m.id, m.qty, m.calibration && m.calibration.copied_from]),
            report: x.status, cal: sheets && sheets[0].rows.find(r => r[0] === 2)[13] }));
          server.close(); process.exit(0);
        });`], { env: { ...process.env, DATA_DIR: dir4, ERP_SYNC_DISABLED: '1' }, encoding: 'utf8' });
      assert.strictEqual(m.status, 0, m.stderr);
      assert.deepStrictEqual(JSON.parse(m.stdout.trim().split('\n').at(-1)), {
        drawings: [true, true], calibrations: true,
        rows: [{ id: 1, pending: 0, replaces_id: null, replaced_by: null }, { id: 2, pending: 0, replaces_id: null, replaced_by: null }],
        copied: [null], pendingTender: false, list: [[1, 5, null], [2, 20, null]], report: 200, cal: 'page calibration · not verified',
      }, 'the batch-3 database upgrades and reads as before: ' + m.stdout);
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
