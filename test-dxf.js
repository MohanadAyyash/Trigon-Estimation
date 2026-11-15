// Units, DXF decoding and parsing: node --no-warnings test-dxf.js
const assert = require('assert');
const { UNIT_TO_M, insunitsToUnit, normUom } = require('./lib/units.js');
const { decodeDxf } = require('./lib/dxf/decode.js');
const { parseDxf } = require('./lib/dxf/parse.js');

const dxf = (pairs, eol = '\n') => [...pairs, [0, 'EOF']].map(([c, v]) => c + eol + v).join(eol) + eol;
const sec = (name, pairs) => [[0, 'SECTION'], [2, name], ...pairs, [0, 'ENDSEC']];
const layerRec = (name, color = 7, flag = 0) => [[0, 'LAYER'], [2, name], [70, flag], [62, color], [6, 'CONTINUOUS']];
const tables = layers => sec('TABLES', [[0, 'TABLE'], [2, 'LAYER'], [70, layers.length], ...layers.flat(), [0, 'ENDTAB']]);
const line = (h, layer, x1, y1, x2, y2, extra = []) => [[0, 'LINE'], [5, h], [8, layer], ...extra, [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]];
const eof = [[0, 'EOF']];

// units
assert.deepStrictEqual(UNIT_TO_M, { mm: 0.001, cm: 0.01, m: 1, km: 1000, ft: 0.3048, in: 0.0254 });
assert.strictEqual(insunitsToUnit(4), 'mm');
assert.strictEqual(insunitsToUnit(0), null);
assert.strictEqual(insunitsToUnit(1), 'in'); assert.strictEqual(insunitsToUnit(2), 'ft');
assert.strictEqual(insunitsToUnit(5), 'cm'); assert.strictEqual(insunitsToUnit(6), 'm');
assert.strictEqual(insunitsToUnit(7), 'km'); assert.strictEqual(insunitsToUnit(3), null);
assert.strictEqual(normUom('M2'), 'm2');
assert.strictEqual(normUom(' م² '), 'm2');
assert.strictEqual(normUom('Nos'), 'nr');
assert.strictEqual(normUom('Lump Sum'), 'ls');
assert.strictEqual(normUom('Lump   Sum'), 'ls');
assert.strictEqual(normUom('kg'), null);
for (const [u, list] of Object.entries({ m: ['m', 'lm', 'rm', 'l.m', 'م', 'م.ط'], m2: ['m2', 'm²', 'sqm', 'sq.m', 'sq m', 'م2', 'م²'], m3: ['m3', 'm³', 'cum', 'cu.m', 'cu m', 'م3', 'م³'], nr: ['nr', 'no', 'nos', 'no.', 'ea', 'each', 'pcs', 'عدد'], ls: ['ls', 'l.s', 'l.s.', 'lump sum', 'item', 'مقطوعية'] }))
  for (const a of list) assert.strictEqual(normUom(a), u, a);
assert.strictEqual(normUom(null), null);

// binary
assert.throws(() => decodeDxf(Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00')), /binary DXF/);

// Arabic: UTF-8 and windows-1256
const ar = 'أسفلت';
const mk = (cp) => dxf([...sec('HEADER', [[9, '$DWGCODEPAGE'], [3, cp]]), ...tables([layerRec(ar)]), ...sec('ENTITIES', line('A1', ar, 0, 0, 5, 0)), ...eof]);
const u8 = parseDxf(decodeDxf(Buffer.from(mk('ANSI_1252'), 'utf8')));
assert.strictEqual(u8.layers[0].name, ar);
const cp1256 = { 'أ': 0xC3, 'س': 0xD3, 'ف': 0xDD, 'ل': 0xE1, 'ت': 0xCA };
const enc = s => Buffer.from([...s].map(ch => cp1256[ch] !== undefined ? cp1256[ch] : ch.charCodeAt(0)));
const bytes1256 = enc(mk('ANSI_1256'));
assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes1256), 'fixture is not valid UTF-8');
const a1256 = parseDxf(decodeDxf(bytes1256));
assert.strictEqual(a1256.layers[0].name, ar);
assert.strictEqual(a1256.header.codepage, 'ANSI_1256');
assert.strictEqual(a1256.entities[0].layer, ar);
assert.strictEqual(parseDxf(decodeDxf(Buffer.from(mk('ANSI_1252').replace('أسفلت', 'abc\xe9'), 'latin1'))).layers[0].name, 'abc\xe9');

// robustness: CRLF + padded codes
const base = [...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...tables([layerRec('WALLS')]), ...sec('ENTITIES', [...line('1F', 'WALLS', 0, 0, 10, 0), ...line('20', 'WALLS', 10, 0, 10, 10)]), ...eof];
const clean = parseDxf(dxf(base));
const padded = parseDxf(base.map(([c, v]) => String(c).padStart(3, ' ') + (c === 10 ? ' ' : '') + '\r\n' + v + '\r\n').join(''));
assert.strictEqual(clean.entities.length, 2);
assert.deepStrictEqual(padded.entities, clean.entities);
assert.deepStrictEqual(padded.layers, clean.layers);
assert.strictEqual(clean.entities[0].type, 'LINE');
assert.strictEqual(clean.entities[0].handle, '1F');
assert.strictEqual(clean.entities[0].layer, 'WALLS');
assert.ok(clean.entities[0].codes.some(([c, v]) => c === 10 && v === '0'));

// R12 polyline
const v = (x, y) => [[0, 'VERTEX'], [8, 'P'], [10, x], [20, y], [30, 0]];
const r12 = parseDxf(dxf([...sec('ENTITIES', [[0, 'POLYLINE'], [5, 'B1'], [8, 'P'], [66, 1], [70, 1], ...v(0, 0), ...v(10, 0), ...v(10, 10), ...v(0, 10), [0, 'SEQEND'], [8, 'P']]), ...eof]));
assert.strictEqual(r12.entities.length, 1);
assert.strictEqual(r12.entities[0].type, 'POLYLINE');
assert.strictEqual(r12.entities[0].closed, true);
assert.deepStrictEqual(r12.entities[0].vertices, [[0, 0, 0, 0], [10, 0, 0, 0], [10, 10, 0, 0], [0, 10, 0, 0]]);
assert.strictEqual(r12.ignored.VERTEX, undefined);
const open = parseDxf(dxf(sec('ENTITIES', [[0, 'POLYLINE'], [5, 'B2'], [8, 'P'], [70, 0], ...v(0, 0), [0, 'VERTEX'], [10, 1], [20, 1], [42, 0.5], [0, 'SEQEND']])));
assert.strictEqual(open.entities[0].closed, false);
assert.deepStrictEqual(open.entities[0].vertices, [[0, 0, 0, 0], [1, 1, 0.5, 0]]);

// insunits, layer 0, layer flags
assert.strictEqual(clean.header.insunits, 4);
assert.strictEqual(parseDxf(dxf(sec('ENTITIES', []))).header.insunits, null);
assert.strictEqual(parseDxf(dxf([...sec('HEADER', [[9, '$INSUNITS'], [70, 6], [9, '$ACADVER'], [1, 'AC1027']])])).header.insunits, 6);
assert.strictEqual(parseDxf(dxf([...sec('HEADER', [[9, '$ACADVER'], [1, 'AC1027']])])).header.acadver, 'AC1027');
assert.deepStrictEqual(clean.layers.map(l => l.name), ['WALLS', '0']);
const lf = parseDxf(dxf(tables([layerRec('0'), layerRec('OFF', -3), layerRec('FRZ', 5, 1)])));
assert.deepStrictEqual(lf.layers, [{ name: '0', color: 7, off: false, frozen: false }, { name: 'OFF', color: -3, off: true, frozen: false }, { name: 'FRZ', color: 5, off: false, frozen: true }]);

// paper space, ignored, handles
const misc = parseDxf(dxf([...sec('ENTITIES', [...line('A', '0', 0, 0, 1, 1), ...line('B', '0', 0, 0, 2, 2, [[67, 1]]), [0, 'DIMENSION'], [5, 'D'], [8, '0'], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 1]]), ...eof]));
assert.strictEqual(misc.entities.length, 2);
assert.deepStrictEqual(misc.entities.map(e => e.handle), ['A', 'nohandle:1']);
assert.strictEqual(misc.ignored.DIMENSION, 1);
const ps = misc.warnings.filter(w => w.code === 'paper_space');
assert.strictEqual(ps.length, 1); assert.ok(/1/.test(ps[0].detail));

// blocks + xref
const blk = parseDxf(dxf([...sec('BLOCKS', [[0, 'BLOCK'], [2, 'B1'], [70, 0], [10, 5], [20, 6], [0, 'LINE'], [5, 'L1'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0], [0, 'ENDBLK'], [0, 'BLOCK'], [2, 'X'], [70, 4], [10, 0], [20, 0], [0, 'ENDBLK']]), ...sec('ENTITIES', [[0, 'INSERT'], [5, 'I1'], [8, '0'], [2, 'B1'], [10, 0], [20, 0]]), ...eof]));
assert.deepStrictEqual(blk.blocks.B1.base, [5, 6]);
assert.strictEqual(blk.blocks.B1.flag, 0);
assert.strictEqual(blk.blocks.B1.entities.length, 1);
assert.strictEqual(blk.blocks.B1.entities[0].type, 'LINE');
assert.strictEqual(blk.blocks.X.flag, 4);
assert.strictEqual(blk.entities.length, 1);
assert.ok(blk.warnings.some(w => w.code === 'xref' && /X/.test(w.detail)));

// repeated codes are kept in order
const lw = parseDxf(dxf(sec('ENTITIES', [[0, 'LWPOLYLINE'], [5, 'LW'], [8, '0'], [90, 2], [70, 1], [10, 0], [20, 0], [10, 4], [20, 0], [42, 1]])));
assert.deepStrictEqual(lw.entities[0].codes.filter(([c]) => c === 10 || c === 20).map(([c, x]) => c + ':' + x), ['10:0', '20:0', '10:4', '20:0']);

// fix round 1
const err = (fn, re) => assert.throws(fn, re);
err(() => parseDxf(''), /not a DXF file/);
err(() => parseDxf('hello'), /not a DXF file/);
err(() => parseDxf('hello\nworld\n'), /not a DXF file/);
const full = dxf(base);
err(() => parseDxf(full.slice(0, full.indexOf('WALLS', full.indexOf('ENTITIES')) + 3)), /truncated \(no EOF\)/);
err(() => parseDxf(full.replace(/(\n0\nEOF)+\n$/, "\n")), /truncated/);
err(() => parseDxf(dxf(sec('ENTITIES', [[0, 'LINE']])).replace('\n0\nLINE', '\nxx\nLINE')), /line \d+/);
// unparsable coordinates are errors, absent bulge is 0
err(() => parseDxf(dxf(sec('ENTITIES', [[0, 'POLYLINE'], [5, 'PV'], [70, 0], [0, 'VERTEX'], [10, ''], [20, 1], [0, 'SEQEND']]))), /VERTEX|PV/);
err(() => parseDxf(dxf(sec('ENTITIES', [[0, 'POLYLINE'], [5, 'PV'], [70, 0], [0, 'VERTEX'], [10, 1], [0, 'SEQEND']]))), /PV/);
err(() => parseDxf(dxf(sec('ENTITIES', [[0, 'LWPOLYLINE'], [5, 'LQ'], [10, 'abc'], [20, 0]]))), /LQ/);
err(() => parseDxf(dxf(sec('BLOCKS', [[0, 'BLOCK'], [2, 'BB'], [70, 0], [10, 'zz'], [20, 0], [0, 'ENDBLK']]))), /BB/);
// vertex flags: polyface face records (128) and spline frame points (16) are skipped from vertices
const fv = (x, y, f) => [[0, 'VERTEX'], [10, x], [20, y], [70, f]];
const pf = parseDxf(dxf(sec('ENTITIES', [[0, 'POLYLINE'], [5, 'PF'], [70, 64], ...fv(0, 0, 64), ...fv(1, 0, 64), ...fv(1, 1, 64), ...fv(9, 9, 192), [0, 'VERTEX'], [10, 0], [20, 0], [70, 128], [71, 1], [72, 2], [73, 3], ...fv(2, 2, 16), ...fv(3, 3, 32), [0, 'SEQEND']])));
assert.deepStrictEqual(pf.entities[0].vertices, [[0, 0, 0, 64], [1, 0, 0, 64], [1, 1, 0, 64], [3, 3, 0, 32]]);
assert.ok(pf.entities[0].codes.some(([c, v]) => c === 70 && v === '64'));
// prototype-safe names
const pr = parseDxf(dxf([...sec('BLOCKS', [[0, 'BLOCK'], [2, '__proto__'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK'], [0, 'BLOCK'], [2, 'constructor'], [70, 0], [0, 'ENDBLK']]), ...sec('ENTITIES', [[0, '__proto__'], [5, 'Q'], [0, 'constructor']])]));
assert.deepStrictEqual(Object.keys(pr.blocks), ['__proto__', 'constructor']);
assert.strictEqual(pr.ignored.__proto__, 1); assert.strictEqual(pr.ignored.constructor, 1);
assert.strictEqual(Object.getPrototypeOf(pr.ignored), null);
assert.strictEqual(insunitsToUnit('constructor'), null);
assert.ok(Object.isFrozen(UNIT_TO_M));
// paper-space POLYLINE skips its VERTEX/SEQEND
const pp = parseDxf(dxf(sec('ENTITIES', [[0, 'POLYLINE'], [5, 'PP'], [67, 1], [70, 0], ...v(0, 0), ...v(1, 1), [0, 'SEQEND'], ...line('K', '0', 0, 0, 1, 1)])));
assert.strictEqual(pp.entities.length, 1); assert.strictEqual(pp.entities[0].handle, 'K');
assert.deepStrictEqual(pp.ignored, Object.create(null));
assert.strictEqual(pp.warnings.filter(w => w.code === 'paper_space').length, 1);
// Uint8Array input
assert.strictEqual(parseDxf(decodeDxf(new Uint8Array(Buffer.from(full)))).entities.length, 2);

// ---- Task 2: geometry ----
const { flatten } = require('./lib/dxf/geometry.js');
const near = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b);
const fl = pairs => flatten(parseDxf(dxf(pairs)));
const ents = list => sec('ENTITIES', list);
const lwp = (h, pts, closed, layer = '0') => [[0, 'LWPOLYLINE'], [5, h], [8, layer], [90, pts.length], [70, closed ? 1 : 0], ...pts.flatMap(([x, y, b]) => b ? [[10, x], [20, y], [42, b]] : [[10, x], [20, y]])];
const block = (name, list, base = [0, 0]) => [[0, 'BLOCK'], [2, name], [70, 0], [10, base[0]], [20, base[1]], ...list, [0, 'ENDBLK']];
const insert = (h, name, layer, extra = []) => [[0, 'INSERT'], [5, h], [8, layer], [2, name], ...[[10, 0], [20, 0]].filter(([c]) => !extra.some(x => x[0] === c)), ...extra];
const sq = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

// lines, polylines, bulges
const g1 = fl(ents(line('L1', 'A', 0, 0, 3, 4)));
assert.strictEqual(g1.length, 1); assert.strictEqual(g1[0].length, 5); assert.strictEqual(g1[0].kind, 'open');
assert.strictEqual(g1[0].area, null); assert.strictEqual(g1[0].depth, 0); assert.strictEqual(g1[0].approx, false);
assert.deepStrictEqual(g1[0].bbox, [0, 0, 3, 4]); assert.strictEqual(g1[0].type, 'LINE'); assert.strictEqual(g1[0].layer, 'A');
const sqf = fl(ents(lwp('S', sq(0, 0, 10), true)))[0];
assert.strictEqual(sqf.kind, 'closed'); near(sqf.length, 40); near(sqf.area, 100);
const arc1 = fl(ents(lwp('B', [[0, 0, 1], [2, 0]], false)))[0];
near(arc1.length, Math.PI); assert.strictEqual(arc1.kind, 'open'); assert.strictEqual(arc1.area, null);
near(arc1.bbox[1], -1); near(arc1.bbox[3], 0); // positive bulge = counter-clockwise: the arc passes below the chord
const circ = fl(ents(lwp('C', [[0, 0, 1], [2, 0, 1]], true)))[0];
near(circ.area, Math.PI); near(circ.length, 2 * Math.PI);
const neg = fl(ents(lwp('N', [[0, 0, -1], [2, 0, -1]], true)))[0];
near(neg.area, Math.PI); near(neg.length, 2 * Math.PI);
// R12 POLYLINE gives the same geometry as LWPOLYLINE
const r12sq = fl(ents([[0, 'POLYLINE'], [5, 'P'], [8, '0'], [66, 1], [70, 1], ...sq(0, 0, 10).flatMap(([x, y]) => v(x, y)), [0, 'SEQEND']]))[0];
near(r12sq.length, 40); near(r12sq.area, 100); assert.strictEqual(r12sq.geomKey, sqf.geomKey);

// circle, arc, ellipse
const ca = fl(ents([[0, 'CIRCLE'], [5, 'CI'], [8, '0'], [10, 1], [20, 1], [40, 2], [0, 'ARC'], [5, 'AR'], [8, '0'], [10, 0], [20, 0], [40, 1], [50, 0], [51, 90]]));
assert.strictEqual(ca[0].kind, 'closed'); near(ca[0].area, 4 * Math.PI); near(ca[0].length, 4 * Math.PI);
assert.deepStrictEqual(ca[0].bbox, [-1, -1, 3, 3]);
assert.strictEqual(ca[1].kind, 'open'); near(ca[1].length, Math.PI / 2); near(ca[1].bbox[2], 1); near(ca[1].bbox[3], 1);
const wrap = fl(ents([[0, 'ARC'], [5, 'W'], [8, '0'], [10, 0], [20, 0], [40, 1], [50, 270], [51, 90]]))[0]; // end < start wraps through 0
near(wrap.length, Math.PI); near(wrap.bbox[0], 0); near(wrap.bbox[2], 1);
const ell = fl(ents([[0, 'ELLIPSE'], [5, 'E'], [8, '0'], [10, 0], [20, 0], [11, 2], [21, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI]]))[0];
assert.strictEqual(ell.kind, 'closed'); near(ell.area, 2 * Math.PI); near(ell.length, 9.688448220547675, 1e-6); assert.strictEqual(ell.approx, false);
const qell = fl(ents([[0, 'ELLIPSE'], [5, 'Q'], [8, '0'], [10, 0], [20, 0], [11, 2], [21, 0], [40, 0.5], [41, 0], [42, Math.PI / 2]]))[0];
assert.strictEqual(qell.kind, 'open'); near(qell.length, 9.688448220547676 / 4, 1e-8); near(qell.bbox[2], 2); near(qell.bbox[3], 1);

// blocks
const B1 = block('B1', line('L1', '0', 0, 0, 1, 0));
const ib = fl([...sec('BLOCKS', B1), ...ents(insert('I1', 'B1', 'KERB', [[41, 2], [42, 2]]))]);
const ins = ib.find(f => f.kind === 'insert'), bl = ib.find(f => f.type === 'LINE');
assert.strictEqual(ins.count, 1); assert.strictEqual(ins.block, 'B1'); assert.strictEqual(ins.depth, 0); assert.strictEqual(ins.layer, 'KERB');
assert.strictEqual(bl.layer, 'KERB'); near(bl.length, 2); assert.strictEqual(bl.depth, 1); assert.strictEqual(bl.block, null);
const rot = fl([...sec('BLOCKS', B1), ...ents(insert('I1', 'B1', 'KERB', [[50, 90]]))]).find(f => f.type === 'LINE');
assert.ok(rot.bbox[2] - rot.bbox[0] < 1e-9, 'rotated line is vertical'); near(rot.bbox[3] - rot.bbox[1], 1);
const nest = fl([...sec('BLOCKS', [...B1, ...block('B2', insert('I0', 'B1', '0'))]), ...ents(insert('I2', 'B2', 'KERB'))]);
assert.strictEqual(nest.find(f => f.type === 'LINE').depth, 2); assert.strictEqual(nest.find(f => f.type === 'LINE').layer, 'KERB');
assert.deepStrictEqual(nest.filter(f => f.kind === 'insert').map(f => [f.block, f.depth, f.layer]), [['B2', 0, 'KERB'], ['B1', 1, 'KERB']]);
// base point, layer kept when not 0 (also with BYBLOCK colour), instance handles are unique
const lay = fl([...sec('BLOCKS', block('B3', [...line('K1', 'OWN', 5, 5, 6, 5), ...line('K2', 'OWN', 5, 5, 5, 6, [[62, 0]])], [5, 5])), ...ents([...insert('J1', 'B3', 'TOP'), ...insert('J2', 'B3', 'TOP', [[10, 100]])])]);
const ll = lay.filter(f => f.type === 'LINE');
assert.deepStrictEqual(ll.map(f => f.layer), ['OWN', 'OWN', 'OWN', 'OWN']); // BYBLOCK colour does not change layer (ruling)
assert.deepStrictEqual(ll[0].bbox, [0, 0, 1, 0]); assert.deepStrictEqual(ll[2].bbox, [100, 0, 101, 0]);
assert.strictEqual(new Set(lay.map(f => f.handle)).size, lay.length);
// MINSERT: 70 columns, 71 rows, 44/45 spacing
const mi = fl([...sec('BLOCKS', B1), ...ents(insert('M1', 'B1', 'KERB', [[70, 3], [71, 2], [44, 10], [45, 5]]))]);
assert.strictEqual(mi.find(f => f.kind === 'insert').count, 6);
const ml = mi.filter(f => f.type === 'LINE');
assert.strictEqual(ml.length, 6); assert.strictEqual(new Set(ml.map(f => f.handle)).size, 6);
assert.deepStrictEqual(ml.map(f => f.bbox[0] + ',' + f.bbox[1]).sort(), ['0,0', '0,5', '10,0', '10,5', '20,0', '20,5']);
// non-uniform scale: arcs sampled and flagged
const nu = fl([...sec('BLOCKS', block('BC', [[0, 'CIRCLE'], [5, 'C1'], [8, '0'], [10, 0], [20, 0], [40, 1]])), ...ents(insert('NU', 'BC', 'X', [[41, 2], [42, 1]]))]).find(f => f.type === 'CIRCLE');
assert.strictEqual(nu.approx, true); near(nu.area, 2 * Math.PI, 1e-3); near(nu.length, 9.688448220547675, 1e-3);
// uniform scale with a circle stays exact; negative uniform scale (mirror) too
const us = fl([...sec('BLOCKS', block('BC', [[0, 'CIRCLE'], [5, 'C1'], [8, '0'], [10, 1], [20, 0], [40, 1]])), ...ents(insert('U', 'BC', 'X', [[41, -2], [42, 2]]))]).find(f => f.type === 'CIRCLE');
assert.strictEqual(us.approx, false); near(us.area, 4 * Math.PI); near(us.length, 4 * Math.PI); near(us.bbox[0], -4); near(us.bbox[2], 0);

// spline
const sp = fl(ents([[0, 'SPLINE'], [5, 'SP'], [8, '0'], [70, 8], [71, 1], [72, 4], [73, 2], [40, 0], [40, 0], [40, 1], [40, 1], [10, 0], [20, 0], [10, 3], [20, 4]]))[0];
assert.strictEqual(sp.approx, true); near(sp.length, 5); assert.strictEqual(sp.kind, 'open');
const sp2 = fl(ents([[0, 'SPLINE'], [5, 'S2'], [8, '0'], [70, 8], [71, 2], [72, 6], [73, 3], ...[0, 0, 0, 1, 1, 1].map(k => [40, k]), [10, 0], [20, 0], [10, 1], [20, 1], [10, 2], [20, 0]]))[0];
assert.strictEqual(sp2.approx, true); near(sp2.bbox[3], 0.5, 1e-6); near(sp2.bbox[2], 2);
assert.throws(() => fl(ents([[0, 'SPLINE'], [5, 'S3'], [70, 8], [71, 2], [40, 0], [40, 1], [10, 0], [20, 0], [10, 1], [20, 1], [10, 2], [20, 0]])), /S3/);

// hatch: outer 10x10 (polyline loop), inner 2x2 (line edges)
const hpoly = (pts, flag = 3) => [[92, flag], [72, 0], [73, 1], [93, pts.length], ...pts.flatMap(([x, y]) => [[10, x], [20, y]]), [97, 0]];
const hlines = (pts, flag = 0) => [[92, flag], [93, pts.length], ...pts.flatMap(([x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return [[72, 1], [10, x], [20, y], [11, x2], [21, y2]]; }), [97, 0]];
const hatch = (h, loops, style = 0, layer = 'H') => [[0, 'HATCH'], [5, h], [8, layer], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, 'SOLID'], [70, 1], [71, 0], [91, loops.length], ...loops.flat(), [75, style], [76, 1], [98, 0]];
const ht = fl(ents(hatch('H1', [hpoly(sq(0, 0, 10)), hlines(sq(4, 4, 2), 16)])))[0];
assert.strictEqual(ht.kind, 'closed'); near(ht.area, 96); near(ht.length, 48); assert.deepStrictEqual(ht.bbox, [0, 0, 10, 10]);
// hatch styles: 0 odd parity, 1 outermost, 2 ignore islands
const three = [hpoly(sq(0, 0, 10)), hpoly(sq(2, 2, 6)), hpoly(sq(4, 4, 2))];
near(fl(ents(hatch('H2', three, 0)))[0].area, 68); near(fl(ents(hatch('H3', three, 1)))[0].area, 64); near(fl(ents(hatch('H4', three, 2)))[0].area, 100);
// arc edges: full circle (ccw), quarter disc with a clockwise arc (angles stored clockwise), polyline loop with bulges
const arcEdge = (cx, cy, r, s, e, ccw) => [[72, 2], [10, cx], [20, cy], [40, r], [50, s], [51, e], [73, ccw]];
near(fl(ents(hatch('H5', [[[92, 1], [93, 1], ...arcEdge(0, 0, 1, 0, 360, 1), [97, 0]]])))[0].area, Math.PI);
const quarter = [[92, 1], [93, 3], [72, 1], [10, 0], [20, 0], [11, 0], [21, 1], ...arcEdge(0, 0, 1, 270, 360, 0), [72, 1], [10, 1], [20, 0], [11, 0], [21, 0], [97, 0]];
const hq = fl(ents(hatch('H6', [quarter])))[0];
near(hq.area, Math.PI / 4); near(hq.length, 2 + Math.PI / 2); near(hq.bbox[2], 1); near(hq.bbox[3], 1);
const bulgeLoop = [[92, 3], [72, 1], [73, 1], [93, 2], [10, 0], [20, 0], [42, 1], [10, 2], [20, 0], [42, 1], [97, 0]];
near(fl(ents(hatch('H7', [bulgeLoop])))[0].area, Math.PI);
// ellipse edge (full)
const ee = fl(ents(hatch('H8', [[[92, 1], [93, 1], [72, 3], [10, 0], [20, 0], [11, 2], [21, 0], [40, 0.5], [50, 0], [51, 360], [73, 1], [97, 0]]])))[0];
near(ee.area, 2 * Math.PI);
// an edge loop that does not close is excluded with a warning, never measured
const gapDoc = parseDxf(dxf(ents(hatch('HG', [[[92, 1], [93, 2], [72, 1], [10, 0], [20, 0], [11, 1], [21, 0], [72, 1], [10, 5], [20, 5], [11, 0], [21, 1], [97, 0]]]))));
const dropOf = (h, layer, type) => ({ handle: h, layer, type, kind: 'dropped', length: 0, area: null, block: null, depth: 0, count: 1, approx: false, bbox: null, geomKey: null });
assert.deepStrictEqual(flatten(gapDoc), [dropOf('HG', 'H', 'HATCH')]);
assert.ok(gapDoc.warnings.some(w => w.code === 'hatch_open_loop' && w.detail === 'HG'));

// text
const tx = fl(ents([[0, 'TEXT'], [5, 'T1'], [8, 'TX'], [10, 1], [20, 2], [40, 1], [1, 'hello']]))[0];
assert.strictEqual(tx.kind, 'text'); assert.strictEqual(tx.length, 0); assert.strictEqual(tx.area, null); assert.deepStrictEqual(tx.bbox, [1, 2, 1, 2]);
assert.strictEqual(fl(ents([[0, 'MTEXT'], [5, 'T2'], [8, 'TX'], [10, 1], [20, 2], [1, 'x']]))[0].kind, 'text');

// units are not applied (drawing units)
near(fl([...sec('HEADER', [[9, '$INSUNITS'], [70, 4]]), ...ents(line('U1', '0', 0, 0, 3000, 4000))])[0].length, 5000);

// geomKey: direction-, start- and winding-independent; same boundary in a HATCH and a polyline match
const key = list => fl(ents(list))[0].geomKey;
assert.strictEqual(typeof sqf.geomKey, 'string');
assert.strictEqual(key(line('a', '0', 0, 0, 3, 4)), key(line('b', '0', 3, 4, 0, 0)));
assert.notStrictEqual(key(line('a', '0', 0, 0, 3, 4)), key(line('b', '0', 0, 0, 3, 4.001)));
assert.strictEqual(key(line('a', '0', 0, 0, 3, 4)), key(line('b', '0', 0.0000001, 0, 3, 4)));
const sqRev = [[10, 10], [10, 0], [0, 0], [0, 10]];
assert.strictEqual(key(lwp('a', sqRev, true)), sqf.geomKey);
assert.strictEqual(key(lwp('a', [[10, 0], [10, 10], [0, 10], [0, 0]], true)), sqf.geomKey);
assert.strictEqual(key(hatch('h', [hpoly(sq(0, 0, 10))])), sqf.geomKey);
assert.strictEqual(key(hatch('h', [hlines(sq(0, 0, 10))])), sqf.geomKey);
assert.notStrictEqual(key(lwp('a', sq(0, 0, 10), false)), sqf.geomKey);
assert.strictEqual(key(lwp('a', [[0, 0, 0.5], [2, 0]], false)), key(lwp('b', [[2, 0, -0.5], [0, 0]], false)));
assert.notStrictEqual(key(lwp('a', [[0, 0, 0.5], [2, 0]], false)), key(lwp('b', [[0, 0, -0.5], [2, 0]], false)));

// rulings: 3D / mesh / polyface POLYLINE excluded with a warning
for (const f of [8, 16, 64]) {
  const d = parseDxf(dxf(ents([[0, 'POLYLINE'], [5, 'P3'], [8, '0'], [70, f], ...v(0, 0), ...v(1, 1), [0, 'SEQEND'], ...line('ok', '0', 0, 0, 1, 0)])));
  assert.deepStrictEqual(flatten(d).map(e => [e.handle, e.kind]), [['P3', 'dropped'], ['ok', 'open']]);
  assert.ok(d.warnings.some(w => w.code === 'unsupported_polyline' && w.detail === 'P3'), 'flag ' + f);
}
// incomplete LWPOLYLINE pair, bad numbers name the entity
assert.throws(() => fl(ents([[0, 'LWPOLYLINE'], [5, 'LZ'], [70, 0], [10, 0], [20, 0], [10, 4]])), /LZ/);
assert.throws(() => fl(ents([[0, 'LWPOLYLINE'], [5, 'LY'], [70, 0], [10, 0], [10, 4], [20, 0]])), /LY/);
assert.throws(() => fl(ents(line('LX', '0', 0, 0, 'abc', 1))), /LINE LX/);
assert.throws(() => fl(ents([[0, 'LINE'], [5, 'LW'], [10, 0], [20, 0], [11, 1]])), /LINE LW/);
assert.throws(() => fl(ents([[0, 'CIRCLE'], [5, 'CR'], [10, 0], [20, 0], [40, '']])), /CIRCLE CR/);
// missing block: counted, no geometry, warned once
const mb = parseDxf(dxf(ents([...insert('X1', 'NOPE', 'L'), ...insert('X2', 'NOPE', 'L')])));
const mbf = flatten(mb);
assert.deepStrictEqual(mbf.map(f => [f.kind, f.count, f.block]), [['insert', 1, 'NOPE'], ['insert', 1, 'NOPE']]);
assert.deepStrictEqual(mb.warnings.filter(w => w.code === 'missing_block'), [{ code: 'missing_block', detail: 'NOPE' }]);
flatten(mb); assert.strictEqual(mb.warnings.filter(w => w.code === 'missing_block').length, 1);
// recursion and depth cap
assert.throws(() => fl([...sec('BLOCKS', [...block('R1', insert('a', 'R2', '0')), ...block('R2', insert('b', 'R1', '0'))]), ...ents(insert('top', 'R1', '0'))]), /recursive block R1/);
const chain = []; for (let i = 0; i < 40; i++) chain.push(...block('C' + i, i < 39 ? insert('c' + i, 'C' + (i + 1), '0') : line('end', '0', 0, 0, 1, 0)));
assert.throws(() => fl([...sec('BLOCKS', chain), ...ents(insert('top', 'C0', '0'))]), /32/);
const chainOk = []; for (let i = 0; i < 32; i++) chainOk.push(...block('C' + i, i < 31 ? insert('c' + i, 'C' + (i + 1), '0') : line('end', '0', 0, 0, 1, 0)));
assert.strictEqual(fl([...sec('BLOCKS', chainOk), ...ents(insert('top', 'C0', '0'))]).find(f => f.type === 'LINE').depth, 32);
// extrusion (0,0,-1): mirrored OCS, length unchanged, bbox mirrored
const ma = fl(ents([[0, 'ARC'], [5, 'MA'], [8, '0'], [10, 5], [20, 0], [40, 1], [50, 0], [51, 90], [210, 0], [220, 0], [230, -1]]))[0];
near(ma.length, Math.PI / 2); near(ma.bbox[0], -6); near(ma.bbox[1], 0); near(ma.bbox[2], -5); near(ma.bbox[3], 1);
const mlw = fl(ents([...lwp('ML', sq(1, 0, 2), true), [210, 0], [220, 0], [230, -1]]))[0];
near(mlw.area, 4); assert.deepStrictEqual(mlw.bbox, [-3, 0, -1, 2]);
const mline = fl(ents(line('MLN', '0', 1, 0, 2, 0, [[210, 0], [220, 0], [230, -1]])))[0]; // LINE is in WCS: not mirrored
assert.deepStrictEqual(mline.bbox, [1, 0, 2, 0]);
const mins = fl([...sec('BLOCKS', B1), ...ents(insert('MI', 'B1', 'K', [[10, 5], [210, 0], [220, 0], [230, -1]]))]).find(f => f.type === 'LINE');
assert.deepStrictEqual(mins.bbox, [-6, 0, -5, 0]);
const npDoc = parseDxf(dxf(ents([[0, 'CIRCLE'], [5, 'NP'], [8, '0'], [10, 0], [20, 0], [40, 1], [210, 1], [220, 0], [230, 0]])));
assert.deepStrictEqual(flatten(npDoc), [dropOf('NP', '0', 'CIRCLE')]);
assert.ok(npDoc.warnings.some(w => w.code === 'nonplanar' && w.detail === 'NP'));

// ELLIPSE is in WCS: extrusion (0,0,-1) reverses the minor axis, the centre is not mirrored
const me = fl(ents([[0, 'ELLIPSE'], [5, 'ME'], [8, '0'], [10, 0], [20, 0], [11, 2], [21, 0], [40, 0.5], [41, 0], [42, Math.PI / 2], [210, 0], [220, 0], [230, -1]]))[0];
near(me.length, 9.688448220547676 / 4, 1e-8); near(me.bbox[0], 0); near(me.bbox[1], -1); near(me.bbox[2], 2); near(me.bbox[3], 0);
// hatch spline edges are not measured: excluded with a warning
const hsDoc = parseDxf(dxf(ents(hatch('HS', [[[92, 1], [93, 1], [72, 4], [94, 3], [73, 0], [74, 0], [95, 8], [96, 4], [97, 0]]]))));
assert.deepStrictEqual(flatten(hsDoc), [dropOf('HS', 'H', 'HATCH')]);
assert.ok(hsDoc.warnings.some(w => w.code === 'unsupported_hatch_edge' && w.detail === 'HS'));

// ---- Task 2 fix round 1 ----
const warned = (doc, code, detail) => doc.warnings.some(w => w.code === code && w.detail === detail);
const flDoc = pairs => { const d = parseDxf(dxf(pairs)); return { d, f: flatten(d) }; };
// 1. hatch loop area does not depend on absolute position; tolerated gaps are closed explicitly
const gapSq = (x0, y0, g) => [[92, 1], [93, 4], [72, 1], [10, x0], [20, y0], [11, x0 + 10], [21, y0], [72, 1], [10, x0 + 10], [20, y0], [11, x0 + 10], [21, y0 + 10],
  [72, 1], [10, x0 + 10], [20, y0 + 10], [11, x0], [21, y0 + 10], [72, 1], [10, x0], [20, y0 + 10], [11, x0], [21, y0 + g], [97, 0]];
const atOrigin = fl(ents(hatch('G0', [gapSq(0, 0, 1e-7)])))[0];
const geo = fl(ents(hatch('G1', [gapSq(500000, 2700000, 1e-7)])))[0];
near(atOrigin.area, 100, 1e-6); near(geo.area, atOrigin.area, 1e-6);
const geoMm = fl(ents(hatch('G2', [gapSq(500000000, 2700000000, 1e-7)])))[0];
near(geoMm.area, 100, 1e-3);
for (const [h, x, y] of [['G3', 0, 0], ['G4', 500000, 2700000], ['G5', 500000000, 2700000000]]) {
  const { d, f } = flDoc(ents(hatch(h, [gapSq(x, y, 0.001)])));
  assert.deepStrictEqual(f, [dropOf(h, 'H', 'HATCH')], h); assert.ok(warned(d, 'hatch_open_loop', h), h);
}
near(fl(ents(lwp('GP', sq(500000, 2700000, 10), true)))[0].area, 100, 1e-6);
near(fl(ents(lwp('GQ', [[500000, 2700000, 1], [500002, 2700000, 1]], true)))[0].area, Math.PI, 1e-6);
// 3. self-intersecting closed paths and overlapping hatch loops: area excluded, length kept, warned
const bow = flDoc(ents(lwp('BOW', [[0, 0], [10, 10], [10, 0], [0, 10]], true)));
assert.strictEqual(bow.f[0].area, null); near(bow.f[0].length, 20 + 20 * Math.SQRT2); assert.ok(warned(bow.d, 'self_intersecting', 'BOW'));
const hbow = flDoc(ents(hatch('HB', [hpoly([[0, 0], [10, 10], [10, 0], [0, 10]])])));
assert.strictEqual(hbow.f[0].area, null); assert.ok(warned(hbow.d, 'self_intersecting', 'HB'));
const hov = flDoc(ents(hatch('HO', [hpoly(sq(0, 0, 10)), hpoly(sq(5, 5, 10))])));
assert.strictEqual(hov.f[0].area, null); near(hov.f[0].length, 80); assert.ok(warned(hov.d, 'hatch_loops_overlap', 'HO'));
const hdup = flDoc(ents(hatch('HD', [hpoly(sq(0, 0, 10)), hlines(sq(0, 0, 10))])));
assert.strictEqual(hdup.f[0].area, null); assert.ok(warned(hdup.d, 'hatch_loops_overlap', 'HD'));
const okShape = flDoc(ents([...lwp('OK1', [[0, 0], [10, 0], [10, 10], [5, 5], [0, 10]], true), ...hatch('OK2', [hpoly(sq(0, 0, 10)), hpoly(sq(0, 0, 5))])]));
near(okShape.f[0].area, 75); assert.strictEqual(okShape.f[1].area, null); // island lying along the outer edges: flagged (fix round 3 ruling)
assert.deepStrictEqual(okShape.d.warnings, [{ code: 'hatch_loops_overlap', detail: 'OK2' }]);
// 4. clockwise hatch edges: computed exactly, not approximated, no warning (convention verified, see the AutoCAD case below)
const cw = flDoc(ents(hatch('H6', [quarter])));
near(cw.f[0].area, Math.PI / 4); assert.strictEqual(cw.f[0].approx, false); assert.deepStrictEqual(cw.d.warnings, []);
// AutoCAD clockwise arc edge (ezdxf EDGE_HATCH): the edge values below were created by AutoCAD and are taken from the
// MIT-licensed ezdxf test suite (tests/test_02_dxf_graphics/test_229b_hatch_extended.py), (c) 2015-2021 Manfred Moitzi.
// True area: 10x10 square + half-ellipse bulge (3 x 1) - half-disc bite (r 1) = 100 + PI.
const acad = [[92, 1], [93, 8],
  [72, 3], [10, 10.0], [20, 5.0], [11, 3.0], [21, 0.0], [40, 0.3333333333333333], [50, 270], [51, 450], [73, 1],
  [72, 1], [10, 10], [20, 6], [11, 10], [21, 10],
  [72, 1], [10, 10], [20, 10], [11, 6], [21, 10],
  [72, 2], [10, 5.0], [20, 10.0], [40, 1.0], [50, 360.0], [51, 540.0], [73, 0],
  [72, 1], [10, 4], [20, 10], [11, 0], [21, 10],
  [72, 1], [10, 0], [20, 10], [11, 0], [21, 0],
  [72, 1], [10, 0], [20, 0], [11, 10], [21, 0],
  [72, 1], [10, 10], [20, 0], [11, 10], [21, 4], [97, 0]];
const ac = flDoc(ents(hatch('HA', [acad])));
near(ac.f[0].area, 100 + Math.PI, 1e-9); assert.strictEqual(ac.f[0].approx, false); assert.deepStrictEqual(ac.d.warnings, []);
assert.strictEqual(fl(ents(hatch('H5', [[[92, 1], [93, 1], ...arcEdge(0, 0, 1, 0, 360, 1), [97, 0]]])))[0].approx, false);
// 5. expansion cap
assert.throws(() => fl([...sec('BLOCKS', B1), ...ents(insert('BIG', 'B1', 'K', [[70, 32767], [71, 32767], [44, 1], [45, 1]]))]), /^Error: drawing expands to too many entities \(> 5,000,000\)$/);
const fan = []; for (let i = 0; i < 6; i++) fan.push(...block('F' + i, i < 5 ? insert('f' + i, 'F' + (i + 1), '0', [[70, 20], [71, 1]]) : line('end', '0', 0, 0, 1, 0)));
assert.throws(() => fl([...sec('BLOCKS', fan), ...ents(insert('top', 'F0', '0', [[70, 20], [71, 1]]))]), /too many entities/);
// 6. minors
const tb = fl(ents(lwp('TB', [[0, 0, 1e-13], [2, 0]], false)))[0];
near(tb.length, 2); assert.strictEqual(tb.approx, false);
near(fl(ents(lwp('TC', [[0, 0, 1e-13], [10, 0, -1e-13], [10, 10], [0, 10]], true)))[0].area, 100);
const zl = flDoc(ents([[0, 'LINE'], [5, 'Z1'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 3], [21, 4], [31, 12]]));
assert.strictEqual(zl.f[0].length, 5); assert.ok(warned(zl.d, 'z_ignored', 'Z1'));
assert.ok(!warned(flDoc(ents(line('Z2', '0', 0, 0, 3, 4))).d, 'z_ignored', 'Z2'));
const zs = flDoc(ents([[0, 'SPLINE'], [5, 'Z3'], [8, '0'], [71, 1], [40, 0], [40, 0], [40, 1], [40, 1], [10, 0], [20, 0], [30, 0], [10, 3], [20, 4], [30, 2]]));
near(zs.f[0].length, 5); assert.ok(warned(zs.d, 'z_ignored', 'Z3'));
const h0 = flDoc(ents(hatch('H0', [])));
assert.deepStrictEqual(h0.f, [dropOf('H0', 'H', 'HATCH')]); assert.ok(warned(h0.d, 'hatch_no_boundary', 'H0'));
for (const r of [0, -0.5, 1.5]) assert.throws(() => fl(ents([[0, 'ELLIPSE'], [5, 'ER'], [10, 0], [20, 0], [11, 2], [21, 0], [40, r]])), /ELLIPSE ER/, String(r));
near(fl(ents([[0, 'ELLIPSE'], [5, 'E1'], [10, 0], [20, 0], [11, 2], [21, 0], [40, 1]]))[0].area, 4 * Math.PI);

// ---- Task 2 fix round 2: crossings through a vertex or a T-junction ----
const vBow = [[0, 0], [5, 5], [10, 10], [10, 0], [5, 5], [0, 10]], tBow = [[0, 0], [10, 10], [10, 0], [5, 5], [0, 10]];
for (const [h, pts] of [['VB', vBow], ['TB2', tBow]]) {
  const a = flDoc(ents(lwp(h, pts, true)));
  assert.strictEqual(a.f[0].area, null, h); assert.ok(warned(a.d, 'self_intersecting', h), h);
  const b = flDoc(ents(hatch(h + 'H', [hpoly(pts)])));
  assert.strictEqual(b.f[0].area, null, h + 'H'); assert.ok(warned(b.d, 'self_intersecting', h + 'H'), h + 'H');
}
const ovA = [[0, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10]], ovB = [[5, 5], [10, 5], [15, 5], [15, 15], [5, 15], [5, 10]];
const ovv = flDoc(ents(hatch('OV', [hpoly(ovA), hpoly(ovB)])));
assert.strictEqual(ovv.f[0].area, null); assert.ok(warned(ovv.d, 'hatch_loops_overlap', 'OV'));
// touching is allowed: keyhole slit (repeated vertices, collinear slit edges), island touching at a vertex and along an edge
const keyhole = [[0, 0], [10, 0], [10, 5], [7, 5], [7, 3], [3, 3], [3, 7], [7, 7], [7, 5], [10, 5], [10, 10], [0, 10]];
const kh = flDoc(ents([...lwp('KH', keyhole, true), ...hatch('KHH', [hpoly(keyhole)]),
  ...hatch('TI', [hpoly(sq(0, 0, 10)), hpoly([[10, 5], [5, 8], [5, 2]])]), ...lwp('TV', [[0, 0], [10, 0], [5, 5], [10, 10], [0, 10], [5, 5]], true)]));
// keyhole slits are collinear overlaps: flagged, never measured (fix round 3 ruling); touching at a point still measures
assert.strictEqual(kh.f[0].area, null); assert.strictEqual(kh.f[1].area, null); near(kh.f[2].area, 85); near(kh.f[3].area, 50);
assert.deepStrictEqual(kh.d.warnings, [{ code: 'self_intersecting', detail: 'KH' }, { code: 'self_intersecting', detail: 'KHH' }]);
// empty boundary loops are skipped; only empty loops -> hatch_no_boundary
const emp = flDoc(ents([...hatch('EL', [[[92, 1], [93, 0], [97, 0]], hpoly(sq(0, 0, 10))]), ...hatch('EA', [[[92, 1], [93, 0], [97, 0]], [[92, 2], [72, 0], [73, 1], [93, 0], [97, 0]]])]));
assert.deepStrictEqual(emp.f.map(f => f.kind), ['closed', 'dropped']); near(emp.f[0].area, 100);
assert.ok(warned(emp.d, 'hatch_no_boundary', 'EA')); assert.ok(!emp.d.warnings.some(w => w.detail === 'EL'));

// ---- Task 2 fix round 3: crossings through a shared collinear stretch ----
for (const [h, pts] of [['SB1', [[0, 0], [4, 5], [6, 5], [10, 10], [10, 0], [6, 5], [4, 5], [0, 10]]], ['SB2', [[0, 0], [3, 5], [7, 5], [10, 10], [10, 0], [6, 5], [4, 5], [0, 10]]]]) {
  const a = flDoc(ents(lwp(h, pts, true)));
  assert.strictEqual(a.f[0].area, null, h); assert.ok(warned(a.d, 'self_intersecting', h), h);
  const b = flDoc(ents(hatch(h + 'H', [hpoly(pts)])));
  assert.strictEqual(b.f[0].area, null, h + 'H'); assert.ok(warned(b.d, 'self_intersecting', h + 'H'), h + 'H');
}
const abl = flDoc(ents(hatch('AB', [hpoly(sq(0, 0, 10)), hpoly([[4, -5], [4, 0], [6, 0], [6, 5], [3, 5], [3, 0], [2, 0], [2, -5]])])));
assert.strictEqual(abl.f[0].area, null); assert.ok(warned(abl.d, 'hatch_loops_overlap', 'AB'));
near(abl.f[0].length, 40 + 28);
// a spike back along the previous edge (adjacent edges) is not this check's business; non-collinear shapes still measure
near(fl(ents(lwp('NC', [[0, 0], [10, 0], [10, 10], [5, 6], [0, 10]], true)))[0].area, 80);

// ---- Task 3: layer summary ----
const { layerTable } = require('./lib/dxf/summary.js');
const { performance } = require('perf_hooks');
const sumOf = (pairs, unit) => { const d = parseDxf(dxf(pairs)); return layerTable(flatten(d), d.layers, unit); };
const byL = (t, n) => t.layers.find(l => l.layer === n);
const sumEnts = [...lwp('K1', sq(0, 0, 1000), true, 'KERB'), ...line('K2', 'KERB', 0, 0, 3000, 4000), ...hatch('A1', [hpoly(sq(0, 0, 10000))], 0, 'ASPHALT'),
  ...insert('M1', 'MH1', 'MH'), ...insert('M2', 'MH1', 'MH'), ...lwp('E1', sq(0, 0, 1), true, 'EMPTY')];
const sumDoc = [...sec('BLOCKS', [[0, 'BLOCK'], [2, 'MH1'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK']]), ...tables([layerRec('KERB'), layerRec('ASPHALT'), layerRec('MH'), layerRec('UNUSED', -7, 1), layerRec('أسفلت')]), ...ents(sumEnts)];
const stT = sumOf(sumDoc, 'mm');
near(byL(stT, 'KERB').open_length, 5); near(byL(stT, 'KERB').closed_perimeter, 4); near(byL(stT, 'KERB').area, 1);
near(byL(stT, 'ASPHALT').area, 100); assert.strictEqual(byL(stT, 'ASPHALT').closed_perimeter, 0); // R3
assert.deepStrictEqual(byL(stT, 'MH').blocks, [{ name: 'MH1', top: 2, nested: 0 }]);
assert.deepStrictEqual(stT.warnings, [{ code: 'possible_duplicate', detail: { layer: 'MH', count: 1, block: 'MH1' } }]); // both MH1 inserts sit at the same point
const unT = byL(stT, 'UNUSED'); assert.deepStrictEqual([unT.off, unT.frozen, unT.open_length, unT.area, unT.entities, unT.blocks], [true, true, 0, 0, 0, []]);
assert.ok(byL(stT, 'أسفلت')); assert.strictEqual(byL(stT, 'EMPTY').area, 1e-6);
assert.deepStrictEqual(stT.layers.map(l => l.layer), [...stT.layers.map(l => l.layer)].sort((a, b) => (a < b ? -1 : 1)));
const nuT = sumOf(sumDoc, null);
assert.strictEqual(byL(nuT, 'KERB').open_length, null); assert.strictEqual(byL(nuT, 'KERB').area, null); assert.strictEqual(byL(nuT, 'MH').blocks, null); assert.deepStrictEqual(nuT.warnings, []);
// duplicates: counted, warned, never merged
const dupT = sumOf([...ents([...line('D1', 'KERB', 0, 0, 3, 4), ...line('D2', 'KERB', 3, 4, 0, 0), ...line('D3', 'KERB', 1, 1, 2, 2), ...line('D4', 'OTHER', 0, 0, 3, 4)])], 'm');
near(byL(dupT, 'KERB').open_length, 10 + Math.SQRT2); assert.deepStrictEqual(dupT.warnings, [{ code: 'possible_duplicate', detail: { layer: 'KERB', count: 1 } }]);
const hdT = sumOf(ents([...lwp('P1', sq(0, 0, 10), true, 'X'), ...hatch('P2', [hpoly(sq(0, 0, 10))], 0, 'X')]), 'm');
near(byL(hdT, 'X').area, 200); near(byL(hdT, 'X').closed_perimeter, 40); assert.strictEqual(hdT.warnings[0].detail.count, 1);
// null areas are skipped and counted, not zero
const bowT = sumOf(ents([...lwp('B1', [[0, 0], [10, 10], [10, 0], [0, 10]], true, 'X'), ...lwp('B2', sq(0, 0, 2), true, 'X')]), 'm');
near(byL(bowT, 'X').area, 4); assert.strictEqual(byL(bowT, 'X').area_excluded, 1);
// nested blocks stay separate from top-level; unit factors: ft squared
const nestT = sumOf([...sec('BLOCKS', [[0, 'BLOCK'], [2, 'IN'], [70, 0], [10, 0], [20, 0], [0, 'LINE'], [5, 'L1'], [8, '0'], [10, 0], [20, 0], [11, 10], [21, 0], [0, 'ENDBLK'],
  [0, 'BLOCK'], [2, 'OUT'], [70, 0], [10, 0], [20, 0], [0, 'INSERT'], [5, 'N1'], [8, '0'], [2, 'IN'], [10, 0], [20, 0], [0, 'ENDBLK']]), ...ents([...insert('O1', 'OUT', 'B'), ...insert('O2', 'IN', 'B'), ...lwp('F', sq(0, 0, 10), true, 'B')])], 'ft');
assert.deepStrictEqual(byL(nestT, 'B').blocks, [{ name: 'IN', top: 1, nested: 1 }, { name: 'OUT', top: 1, nested: 0 }]);
near(byL(nestT, 'B').area, 100 * 0.3048 * 0.3048); near(byL(nestT, 'B').open_length, 20 * 0.3048);
// unknown / inherited unit names throw (no NaN metrics)
for (const bad of ['constructor', 'toString', '__proto__', 'yd']) assert.throws(() => layerTable([], [], bad), /unknown unit/, bad);
// stacked identical INSERTs: counted (not merged) and warned; different points are not
const stk = sumOf(sumDoc.slice(0, 0).concat(sec('BLOCKS', [[0, 'BLOCK'], [2, 'MH1'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK']]), ents([...insert('S1', 'MH1', 'MH'), ...insert('S2', 'MH1', 'MH')])), 'm');
assert.deepStrictEqual(byL(stk, 'MH').blocks, [{ name: 'MH1', top: 2, nested: 0 }]);
assert.deepStrictEqual(stk.warnings, [{ code: 'possible_duplicate', detail: { layer: 'MH', count: 1, block: 'MH1' } }]);
const stk2 = sumOf(sec('BLOCKS', [[0, 'BLOCK'], [2, 'MH1'], [70, 0], [10, 0], [20, 0], [0, 'ENDBLK']]).concat(ents([...insert('S1', 'MH1', 'MH'), ...insert('S2', 'MH1', 'MH', [[10, 5], [20, 0]])])), 'm');
assert.deepStrictEqual(stk2.warnings, []); assert.strictEqual(byL(stk2, 'MH').blocks[0].top, 2);
// performance: 100,000 LINEs over 20 layers
{
  const parts = ['0\nSECTION\n2\nENTITIES'];
  for (let i = 0; i < 100000; i++) parts.push('0\nLINE\n5\nH' + i + '\n8\nL' + (i % 20) + '\n10\n' + i + '\n20\n0\n30\n0\n11\n' + (i + 3) + '\n21\n4\n31\n0');
  parts.push('0\nENDSEC\n0\nEOF\n');
  const text = parts.join('\n');
  const t0 = performance.now();
  const d = parseDxf(text); const t = layerTable(flatten(d), d.layers, 'm');
  const ms = performance.now() - t0;
  console.log('perf 100k LINEs parse+flatten+layerTable ms:', Math.round(ms));
  assert.ok(ms < 15000, 'perf ' + ms);
  assert.strictEqual(t.layers.length, 21); assert.strictEqual(t.layers.find(l => l.layer === '0').entities, 0); // parseDxf always lists layer 0
  assert.deepStrictEqual(t.warnings, []);
  assert.strictEqual(t.layers.reduce((a, l) => a + l.entities, 0), 100000);
  assert.strictEqual(t.layers.reduce((a, l) => a + l.open_length, 0), 500000);
  for (const l of t.layers.filter(l => l.layer !== '0')) assert.strictEqual(l.open_length, 25000);
}

// ---- final review item 1: shapes the parser cannot measure are counted against their layer (dropped) ----
{
  // the probe: a closed 10 x 10 and a HATCH with a spline edge on ASPHALT. The hatch is not measured: dropped 1, area stays 100
  const splineHatch = hatch('HS1', [[[92, 1], [93, 1], [72, 4], [94, 3], [73, 0], [74, 0], [95, 8], [96, 4], [97, 0]]], 0, 'ASPHALT');
  const pr = sumOf(ents([...lwp('SQ', sq(0, 0, 10), true, 'ASPHALT'), ...splineHatch]), 'm');
  const a = byL(pr, 'ASPHALT');
  near(a.area, 100); assert.strictEqual(a.dropped, 1); assert.strictEqual(a.area_excluded, 0); assert.strictEqual(a.approx, 0); assert.strictEqual(a.entities, 1);
  assert.strictEqual(byL(sumOf(ents([...lwp('SQ', sq(0, 0, 10), true, 'ASPHALT')]), 'm'), 'ASPHALT').dropped, 0, 'nothing dropped → 0');
  assert.strictEqual(byL(sumOf(ents(splineHatch), null), 'ASPHALT').dropped, null, 'no units → no numbers');
  // each dropped kind: unsupported polyline, nonplanar entity, open hatch loop, hatch without boundary
  const kinds = sumOf(ents([[0, 'POLYLINE'], [5, 'P3'], [8, 'K'], [70, 16], ...v(0, 0), ...v(1, 1), [0, 'SEQEND'],
    [0, 'CIRCLE'], [5, 'NP'], [8, 'K'], [10, 0], [20, 0], [40, 1], [210, 1], [220, 0], [230, 0], ...hatch('H0', [], 0, 'K'),
    ...hatch('HG', [[[92, 1], [93, 2], [72, 1], [10, 0], [20, 0], [11, 1], [21, 0], [72, 1], [10, 5], [20, 5], [11, 0], [21, 1], [97, 0]]], 0, 'K')]), 'mm');
  assert.strictEqual(byL(kinds, 'K').dropped, 4); assert.strictEqual(byL(kinds, 'K').entities, 0);
  // a nonplanar INSERT: its own layer gets the drop (counted per instance), the block is not counted and its content not measured
  const npi = parseDxf(dxf([...sec('BLOCKS', B1), ...ents(insert('NI', 'B1', 'MH', [[70, 2], [71, 1], [44, 5], [210, 1], [220, 0], [230, 0]]))]));
  const npf = flatten(npi);
  assert.deepStrictEqual(npf, [{ handle: 'NI', layer: 'MH', type: 'INSERT', kind: 'dropped', length: 0, area: null, block: 'B1', depth: 0, count: 2, approx: false, bbox: null, geomKey: null }]);
  assert.ok(warned(npi, 'nonplanar', 'NI'));
  const npt = byL(layerTable(npf, npi.layers, 'm'), 'MH');
  assert.strictEqual(npt.dropped, 2); assert.deepStrictEqual(npt.blocks, []);
  // a dropped shape inside a block: placeholder per instance on the resolved layer; the insert bbox ignores it
  const inb = fl([...sec('BLOCKS', block('BH', [...line('L', '0', 0, 0, 1, 0), ...hatch('HX', [], 0, '0')])), ...ents(insert('IB', 'BH', 'TOP'))]);
  assert.deepStrictEqual(inb.map(f => [f.handle, f.layer, f.kind]), [['IB', 'TOP', 'insert'], ['IB/L', 'TOP', 'open'], ['IB/HX', 'TOP', 'dropped']]);
  assert.deepStrictEqual(inb[0].bbox, [0, 0, 1, 0]);
  // unsupported entity types: an MLINE on KERB is dropped on KERB (model space and inside a block on its resolved layer);
  // annotation (DIMENSION, LEADER, ATTRIB, XLINE, POINT…) is ignored and listed, never counted as a shape not measured
  const ml = parseDxf(dxf([...sec('BLOCKS', block('BM', [[0, 'MLINE'], [5, 'MB'], [8, '0']])), ...ents([...line('K1', 'KERB', 0, 0, 5, 0), [0, 'MLINE'], [5, 'M1'], [8, 'KERB'],
    [0, 'DIMENSION'], [5, 'D1'], [8, 'KERB'], [0, 'LEADER'], [5, 'D2'], [8, 'KERB'], [0, 'XLINE'], [5, 'X1'], [8, 'KERB'], [0, 'POINT'], [5, 'PT'], [8, 'KERB'],
    ...insert('IM', 'BM', 'WALL')])]));
  assert.deepStrictEqual({ ...ml.ignored }, { MLINE: 1, DIMENSION: 1, LEADER: 1, XLINE: 1, POINT: 1 }, 'ignored types still listed');
  const mlf = flatten(ml);
  assert.deepStrictEqual(mlf.filter(f => f.kind === 'dropped').map(f => [f.handle, f.layer, f.type]), [['M1', 'KERB', 'MLINE'], ['IM/MB', 'WALL', 'MLINE']]);
  const mlt = layerTable(mlf, ml.layers, 'm');
  assert.strictEqual(byL(mlt, 'KERB').dropped, 1); near(byL(mlt, 'KERB').open_length, 5); assert.strictEqual(byL(mlt, 'WALL').dropped, 1);
  assert.deepStrictEqual(byL(mlt, 'WALL').blocks, [{ name: 'BM', top: 1, nested: 0 }]);
  // attributes after an INSERT are annotation too
  const att = parseDxf(dxf([...sec('BLOCKS', block('BA', [])), ...ents([...insert('IA', 'BA', 'MH', [[66, 1]]), [0, 'ATTRIB'], [5, 'AT'], [8, 'MH'], [0, 'SEQEND'], [5, 'SQ'], [8, 'MH']])]));
  assert.strictEqual(byL(layerTable(flatten(att), att.layers, 'm'), 'MH').dropped, 0, 'ATTRIB is not a shape');
}

// ---- display file (render payload): Float32 points relative to the drawing origin, arcs tessellated ----
{
  const { buildRender } = require('./lib/dxf/render.js');
  const zlib = require('zlib');
  // tiny decoder (the real one is the browser's): uint32 headerLen, JSON, pad 4, layer/start/count u32, kind u8, pad 4,
  // block u32, pad 8, len/area f64, eo f64 × 2n, pts f32 (relative to their entity's eo)
  const decode = buf => {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const hl = dv.getUint32(0, true), header = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8'));
    const pad = (o, m) => { const e = Math.ceil(o / m) * m; for (let k = o; k < e; k++) assert.strictEqual(buf[k], 0, 'padding byte ' + k + ' is 0'); return e; };
    let o = pad(4 + hl, 4); const n = header.handles.length;
    const arr = (get, size) => { const a = []; for (let i = 0; i < n; i++) { a.push(get(o)); o += size; } return a; };
    const layer = arr(p => dv.getUint32(p, true), 4), start = arr(p => dv.getUint32(p, true), 4), count = arr(p => dv.getUint32(p, true), 4);
    const kind = arr(p => dv.getUint8(p), 1); o = pad(o, 4);
    const block = arr(p => dv.getUint32(p, true), 4); o = pad(o, 8);
    const len = arr(p => dv.getFloat64(p, true), 8), area = arr(p => dv.getFloat64(p, true), 8);
    const eo = arr(p => [dv.getFloat64(p, true), dv.getFloat64(p + 8, true)], 16);
    assert.strictEqual((buf.byteLength - o) % 8, 0, 'pts are whole (x, y) Float32 pairs');
    const pts = []; for (; o < buf.byteLength; o += 8) pts.push([dv.getFloat32(o, true), dv.getFloat32(o + 4, true)]);
    for (let i = 0; i < n; i++) assert.ok(start[i] + count[i] <= pts.length, 'entity ' + i + ' points in range');
    const P = i => pts.slice(start[i], start[i] + count[i]).map(([x, y]) => [x + eo[i][0], y + eo[i][1]]);
    return { header, layer, start, count, kind, block, len, area, eo, pts, P, n };
  };
  const render = pairs => { const d = parseDxf(dxf(pairs)), f = flatten(d, { withSegs: true }); return { d, f, r: decode(buildRender(d, f)) }; };

  // withSegs leaves every existing field and warning as it is
  {
    const pairs = [...sec('BLOCKS', block('BW', [...line('L', '0', 0, 0, 1, 0), [0, 'ARC'], [5, 'A'], [8, '0'], [10, 0], [20, 0], [40, 1], [50, 0], [51, 90]], [5, 6])),
      ...ents([...insert('IW', 'BW', 'MH', [[41, 2], [42, 3]]), ...line('L2', 'K', 0, 0, 5, 0), ...hatch('HX', [], 0, 'K'), ...lwp('BOW', [[0, 0], [10, 10], [10, 0], [0, 10]], true, 'K')])];
    const a = parseDxf(dxf(pairs)), b = parseDxf(dxf(pairs));
    const fa = flatten(a), fb = flatten(b, { withSegs: true });
    assert.ok(fa.every(e => !('segs' in e) && !('ins' in e) && !('pathLens' in e)), 'default call: no segs, no ins, no pathLens');
    assert.deepStrictEqual(fb.map(e => { const o = { ...e }; delete o.segs; delete o.ins; delete o.pathLens; return o; }), fa);
    assert.deepStrictEqual(b.warnings, a.warnings);
    assert.ok(fb.filter(e => e.kind !== 'dropped').every(e => Array.isArray(e.segs)), 'segs on every non-dropped entity');
    assert.ok(fb.filter(e => e.kind === 'dropped').every(e => !('segs' in e)));
    assert.deepStrictEqual(fb.find(e => e.kind === 'insert').ins, [0, 0], 'ins = the insertion point in world coordinates');
    assert.deepStrictEqual(fb.find(e => e.handle === 'L2').segs.map(s => [s.t, s.p0, s.p1]), [['L', [0, 0], [5, 0]]]);
  }
  // georeferenced: LINE (0,0)-(3,4) and a closed square, offset by (500000, 2700000) → origin there, points exact to 1e-3
  {
    const X = 500000, Y = 2700000;
    const { f, r } = render([...tables([layerRec('ROAD'), layerRec('OFF', -3)]), ...ents([...line('G1', 'ROAD', X, Y, X + 3, Y + 4), ...lwp('G2', sq(X + 10, Y + 20, 10), true, 'NEW')])]);
    assert.deepStrictEqual(r.header.origin, [X, Y]); assert.deepStrictEqual(r.header.bbox, [X, Y, X + 20, Y + 30]);
    assert.strictEqual(r.header.version, 2);
    assert.deepStrictEqual(r.eo, [[X, Y], [X + 10, Y + 20]], 'each entity\'s own bbox min');
    assert.strictEqual(r.len[0], 5); assert.strictEqual(r.kind[0], 0); assert.ok(Number.isNaN(r.area[0]), 'null area → NaN');
    r.P(0).forEach((p, k) => { near(p[0], [X, X + 3][k], 1e-3); near(p[1], [Y, Y + 4][k], 1e-3); });
    assert.strictEqual(r.count[0], 2);
    assert.strictEqual(r.kind[1], 1); assert.strictEqual(r.count[1], 4, 'closed: the closing point is not repeated');
    r.P(1).forEach((p, k) => { near(p[0], sq(X + 10, Y + 20, 10)[k][0], 1e-3); near(p[1], sq(X + 10, Y + 20, 10)[k][1], 1e-3); });
    near(r.len[1], 40); near(r.area[1], 100);
    assert.deepStrictEqual(r.header.handles, f.map(e => e.handle));
    // layers: the LAYER table (ACI colour; off/frozen), then layers only used by entities (colour 7)
    assert.deepStrictEqual(r.header.layers, [{ name: 'ROAD', color: 7, off: false, frozen: false }, { name: 'OFF', color: 3, off: true, frozen: false },
      { name: '0', color: 7, off: false, frozen: false }, { name: 'NEW', color: 7, off: false, frozen: false }]);
    assert.deepStrictEqual(r.layer.map(i => r.header.layers[i].name), ['ROAD', 'NEW']);
    assert.deepStrictEqual(r.block, [0xFFFFFFFF, 0xFFFFFFFF]); assert.deepStrictEqual(r.header.blocks, []);
  }
  // CIRCLE r 10: 4..256 points, chord error ≤ 0.02; ARC: ends exact; ELLIPSE: chord error ≤ 0.002 × major radius
  {
    const { r } = render(ents([[0, 'CIRCLE'], [5, 'C'], [8, '0'], [10, 100], [20, 100], [40, 10], [0, 'ARC'], [5, 'A'], [8, '0'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90],
      [0, 'ELLIPSE'], [5, 'E'], [8, '0'], [10, 0], [20, 0], [11, 20], [21, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI]]));
    assert.strictEqual(r.kind[0], 1); assert.ok(r.count[0] >= 4 && r.count[0] <= 256, 'circle points ' + r.count[0]);
    const cp = r.P(0); let worst = 0;
    for (let k = 0; k < cp.length; k++) {
      const p = cp[k], q = cp[(k + 1) % cp.length];
      near(Math.hypot(p[0] - 100, p[1] - 100), 10, 1e-4);
      worst = Math.max(worst, 10 - Math.hypot((p[0] + q[0]) / 2 - 100, (p[1] + q[1]) / 2 - 100));
    }
    assert.ok(worst <= 0.02, 'circle chord error ' + worst);
    console.log('render: circle r 10 → ' + r.count[0] + ' points, max chord error ' + worst.toFixed(5));
    const ap0 = r.P(1);
    assert.strictEqual(r.kind[1], 0); near(ap0[0][0], 10, 1e-4); near(ap0[0][1], 0, 1e-4); near(ap0[ap0.length - 1][0], 0, 1e-4); near(ap0[ap0.length - 1][1], 10, 1e-4);
    assert.ok(ap0.length >= 3 && ap0.length < r.count[0], 'a quarter arc takes fewer points than the full circle');
    near(r.len[1], 5 * Math.PI, 1e-9);
    const ep = r.P(2); let ew = 0;
    for (let k = 0; k < ep.length; k++) {
      const p = ep[k], q = ep[(k + 1) % ep.length], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      near((p[0] / 20) ** 2 + (p[1] / 10) ** 2, 1, 1e-5);
      // distance from the chord midpoint out to the ellipse along the ray from the centre
      const s = 1 / Math.sqrt((m[0] / 20) ** 2 + (m[1] / 10) ** 2); ew = Math.max(ew, Math.hypot(m[0], m[1]) * (s - 1));
    }
    assert.ok(ew <= 0.002 * 20, 'ellipse chord error ' + ew);
    assert.ok(r.count[2] >= 4 && r.count[2] <= 256);
  }
  // INSERT: one kind-2 marker at the insertion point (block base applied), the right block index; content drawn as flattened
  {
    const { f, r } = render([...sec('BLOCKS', [...block('B0', []), ...block('BR', line('L1', '0', 5, 6, 7, 6), [5, 6])]),
      ...ents([...insert('I0', 'B0', 'MH', [[10, 1], [20, 2]]), ...insert('I1', 'BR', 'MH', [[10, 100], [20, 200], [50, 90]]), [0, 'MTEXT'], [5, 'T'], [8, 'MH'], [10, 3], [20, 4], [1, 'NOTE']])]);
    assert.deepStrictEqual(f.map(e => [e.handle, e.kind]), [['I0', 'insert'], ['I1', 'insert'], ['I1/L1', 'open'], ['T', 'text']]);
    assert.deepStrictEqual(r.header.blocks, ['B0', 'BR']);
    assert.deepStrictEqual(r.kind, [2, 2, 0, 3]); assert.deepStrictEqual(r.count, [1, 1, 2, 1]);
    assert.deepStrictEqual(r.block, [0, 1, 0xFFFFFFFF, 0xFFFFFFFF]);
    near(r.P(0)[0][0], 1, 1e-5); near(r.P(0)[0][1], 2, 1e-5);
    near(r.P(1)[0][0], 100, 1e-4); near(r.P(1)[0][1], 200, 1e-4);
    near(r.P(2)[1][0], 100, 1e-4); near(r.P(2)[1][1], 202, 1e-4);   // rotated 90°: (7,6) - base → (0,2)
    near(r.P(3)[0][0], 3, 1e-5); near(r.P(3)[0][1], 4, 1e-5);
    assert.strictEqual(r.len[0], 0); assert.ok(Number.isNaN(r.area[0]));
  }
  // dropped → kind 4 with no points; handles round-trip in order
  {
    const { f, r } = render(ents([...line('A1', 'K', 0, 0, 1, 0), [0, 'MLINE'], [5, 'M1'], [8, 'K'], ...hatch('HX', [], 0, 'K'), ...line('A2', 'K', 0, 1, 1, 1)]));
    assert.deepStrictEqual(r.header.handles, ['A1', 'M1', 'HX', 'A2']); assert.deepStrictEqual(r.header.handles, f.map(e => e.handle));
    assert.deepStrictEqual(r.kind, [0, 4, 4, 0]); assert.deepStrictEqual(r.count, [2, 0, 0, 2]);
    assert.ok(Number.isNaN(r.area[1])); assert.strictEqual(r.len[1], 0);
    near(r.P(3)[0][1], 1, 1e-6);
  }
  // several paths in one entity (HATCH outer loop + island): one NaN,NaN break between them, none at the ends;
  // count includes the break; no segment joins loop 1 to loop 2
  {
    const { f, r } = render(ents([...hatch('HI', [hpoly(sq(0, 0, 10)), hpoly(sq(4, 4, 2))], 0, 'K'), ...lwp('S1', sq(20, 0, 5), true, 'K')]));
    assert.deepStrictEqual(f[0].pathLens, [4, 4]); assert.deepStrictEqual(f[1].pathLens, [4]);
    assert.strictEqual(r.kind[0], 1); assert.strictEqual(r.count[0], 4 + 1 + 4, 'two rings of 4 + one break');
    const p = r.pts.slice(r.start[0], r.start[0] + r.count[0]), brk = p.map((q, k) => Number.isNaN(q[0]) || Number.isNaN(q[1]) ? k : -1).filter(k => k >= 0);
    assert.deepStrictEqual(brk, [4], 'exactly one break, between the loops');
    assert.ok(Number.isNaN(p[4][0]) && Number.isNaN(p[4][1]), 'the break is a NaN,NaN pair');
    const o = r.eo[0], abs = q => [q[0] + o[0], q[1] + o[1]];
    assert.deepStrictEqual(p.slice(0, 4).map(abs), sq(0, 0, 10)); assert.deepStrictEqual(p.slice(5).map(abs), sq(4, 4, 2));
    // drawn as consecutive pairs, never across the break: no segment from loop 1's last point to loop 2's first
    const segs = []; for (let k = 0; k + 1 < p.length; k++) if (!Number.isNaN(p[k][0]) && !Number.isNaN(p[k + 1][0])) segs.push([abs(p[k]), abs(p[k + 1])]);
    assert.ok(!segs.some(([u, v]) => u[0] === 0 && u[1] === 10 && v[0] === 4 && v[1] === 4), 'no bridge between the loops');
    assert.strictEqual(segs.length, 6);
    // a single-path entity has no break
    assert.strictEqual(r.count[1], 4); assert.ok(r.pts.slice(r.start[1], r.start[1] + 4).every(q => Number.isFinite(q[0]) && Number.isFinite(q[1])));
  }
  // nothing to draw: origin (0,0), empty bbox, zero entities
  {
    const { r } = render(ents([]));
    assert.deepStrictEqual(r.header.origin, [0, 0]); assert.deepStrictEqual(r.header.bbox, [0, 0, 0, 0]);
    assert.strictEqual(r.n, 0); assert.strictEqual(r.pts.length, 0);
  }
  // zero padding at every alignment (the decoder checks it), whatever the header and entity counts
  for (const k of [1, 2, 3, 5]) {
    const { r } = render(ents(Array.from({ length: k }, (_, i) => line('Z' + i, 'L' + 'x'.repeat(i), 0, 0, i + 1, 0)).flat()));
    assert.strictEqual(r.n, k); near(r.P(k - 1)[1][0], k, 0);
  }
  // review fix 1: a georeferenced drawing in mm with a stray entity near (0,0). Each entity has its own origin, so a 5 mm
  // line at (500,000,000; 2,700,000,000) keeps its length and position (a shared origin gave a 256 mm Float32 spacing)
  {
    const X = 500000000, Y = 2700000000;
    const { r, f } = render([...sec('BLOCKS', block('BA', [[0, 'ARC'], [5, 'A1'], [8, '0'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]])),
      ...ents([...insert('I1', 'BA', '0', [[210, 0], [220, 0], [230, -1]]), ...line('S', '0', X, Y, X + 3, Y + 4)])]);
    assert.deepStrictEqual(f.map(e => e.handle), ['I1', 'I1/A1', 'S']);
    assert.deepStrictEqual(r.header.origin, [-10, 0]);
    const p = r.P(2);
    near(p[0][0], X, 1e-3); near(p[0][1], Y, 1e-3); near(p[1][0], X + 3, 1e-3); near(p[1][1], Y + 4, 1e-3);
    near(Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), 5, 1e-3);
    assert.deepStrictEqual(r.eo[2], [X, Y]);
  }
  // review fix 3: negative sweeps. A mirrored INSERT (extrusion 0,0,-1) of a 0..90° arc lies in the second quadrant;
  // a clockwise hatch arc edge (270..360 stored clockwise) in the first. Points on the circle, tessellated, ends exact.
  {
    const onArc = (pts, r, inQuad, what) => {
      const arc = pts.filter(q => Math.abs(Math.hypot(q[0], q[1]) - r) <= 1e-4);
      assert.ok(arc.length >= 13, what + ': tessellated (' + arc.length + ' points on the circle)');
      assert.ok(arc.every(inQuad), what + ': every point in the right quadrant');
      assert.ok(arc.some(q => Math.abs(Math.atan2(Math.abs(q[1]), Math.abs(q[0])) - Math.PI / 4) < 0.07), what + ': passes through the middle of the quadrant');
      return arc;
    };
    const m = render([...sec('BLOCKS', block('BA', [[0, 'ARC'], [5, 'A1'], [8, '0'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]])),
      ...ents(insert('I1', 'BA', '0', [[210, 0], [220, 0], [230, -1]]))]).r;
    const mp = m.P(1);
    assert.strictEqual(mp.length, m.count[1]);
    onArc(mp, 10, q => q[0] <= 1e-4 && q[1] >= -1e-4, 'mirrored INSERT arc');
    near(mp[0][0], -10, 1e-4); near(mp[0][1], 0, 1e-4); near(mp[mp.length - 1][0], 0, 1e-4); near(mp[mp.length - 1][1], 10, 1e-4);
    const q10 = [[92, 1], [93, 3], [72, 1], [10, 0], [20, 0], [11, 0], [21, 10], ...arcEdge(0, 0, 10, 270, 360, 0), [72, 1], [10, 10], [20, 0], [11, 0], [21, 0], [97, 0]];
    const h = render(ents(hatch('HC', [q10]))).r, hp = h.P(0);
    assert.ok(hp.every(q => Number.isFinite(q[0])), 'one loop: no break');
    onArc(hp, 10, q => q[0] >= -1e-4 && q[1] >= -1e-4, 'clockwise hatch arc');
    assert.ok(hp.some(q => Math.abs(q[0]) < 1e-4 && Math.abs(q[1]) < 1e-4), 'the corner at the centre');
  }
  // review fix 4: flats without segs → a clear error; review fix 2: more points than the cap → 'drawing too large to display'
  {
    const d = parseDxf(dxf(ents([...line('A', '0', 0, 0, 1, 0), ...insert('I', 'NONE', '0')])));
    assert.throws(() => buildRender(d, flatten(d)), /^Error: buildRender needs flatten\(doc, \{ withSegs: true \}\)$/);
    const f = flatten(d, { withSegs: true });
    assert.throws(() => buildRender(d, f.filter(e => e.kind === 'insert').map(e => ({ ...e, ins: undefined }))), /needs flatten/);
    assert.throws(() => buildRender(d, f, { maxPoints: 2 }), /^Error: drawing too large to display$/);
    assert.strictEqual(decode(buildRender(d, f, { maxPoints: 3 })).pts.length, 3);
  }
  // 100,000 LINEs: buildRender < 3000 ms
  {
    const parts = ['0\nSECTION\n2\nENTITIES'];
    for (let i = 0; i < 100000; i++) parts.push('0\nLINE\n5\nH' + i + '\n8\nL' + (i % 20) + '\n10\n' + (500000 + i) + '\n20\n2700000\n11\n' + (500000 + i + 3) + '\n21\n2700004');
    parts.push('0\nENDSEC\n0\nEOF\n');
    const d = parseDxf(parts.join('\n')), f = flatten(d, { withSegs: true });
    const t0 = performance.now(), buf = buildRender(d, f), ms = performance.now() - t0;
    const gz = zlib.gzipSync(buf);
    console.log('render 100k LINEs: buildRender ' + Math.round(ms) + ' ms, ' + buf.length + ' bytes, gz ' + gz.length + ' bytes');
    assert.ok(ms < 3000, 'buildRender ' + ms + ' ms');
    const r = decode(buf);
    assert.strictEqual(r.n, 100000); assert.strictEqual(r.pts.length, 200000);
    near(r.P(99999)[1][0], 500000 + 99999 + 3, 1e-3); near(r.P(99999)[1][1], 2700004, 1e-3);
  }
}

// ---- batch 2 Task 3: selection totals (pure) ----
{
  const { selectionTotals } = require('./lib/dxf/select.js');
  const spline = [[0, 'SPLINE'], [5, 'S1'], [8, 'CURVE'], [70, 8], [71, 1], [72, 4], [73, 2], [40, 0], [40, 0], [40, 1], [40, 1], [10, 0], [20, 0], [10, 3], [20, 4]];
  const splineHatch = hatch('QH', [[[92, 1], [93, 1], [72, 4], [94, 3], [73, 0], [74, 0], [95, 8], [96, 4], [97, 0]]], 0, 'DROP');
  const sd = parseDxf(dxf([...sec('BLOCKS', block('MH1', [])), ...ents([...line('K1', 'KERB', 0, 0, 3, 4), ...line('K2', 'KERB', 10, 0, 13, 4),
    ...lwp('B1', [[0, 20], [1, 21], [1, 20], [0, 21]], true, 'BOW'), ...lwp('B2', sq(20, 0, 2), true, 'BOW'), ...hatch('BH', [hpoly(sq(40, 0, 3))], 0, 'BOW'), ...spline,
    ...line('U1', 'DUPL', 0, 60, 3, 60), ...line('U2', 'DUPL', 3, 60, 0, 60), ...insert('M1', 'MH1', 'MH'),
    ...insert('M2', 'MH1', 'MH', [[10, 50], [20, 50], [70, 2], [71, 3], [44, 5], [45, 5]]), ...insert('M3', 'MH1', 'MH2', [[10, 90], [20, 90]]),
    [0, 'TEXT'], [5, 'T1'], [8, 'KERB'], [10, 0], [20, 0], [40, 1], [1, 'NOTE'], ...splineHatch])]));
  const sf = flatten(sd);
  const st = (h, metric) => selectionTotals(sf, h, metric);
  // open_length over the two KERB lines → 10; the text on the layer is not a length (skipped)
  const k = st(['K1', 'K2', 'T1'], 'open_length');
  assert.deepStrictEqual(k, { base: 10, used: 2, dropped: 0, area_null: 0, approx: 0, duplicates: 0, unknown: 0, skipped: 1, by_layer: { KERB: 2 }, blocks: [], used_handles: ['K1', 'K2'] });
  // area including the bowtie: the bowtie has no area → area_null 1, the square counts; the hatch counts as an area
  const a = st(['B1', 'B2', 'BH'], 'area');
  near(a.base, 4 + 9); assert.strictEqual(a.area_null, 1); assert.strictEqual(a.used, 2); assert.deepStrictEqual(a.used_handles, ['B2', 'BH']);
  // closed_perimeter: a HATCH is an area only (skipped); the bowtie still has a perimeter
  const pr = st(['B1', 'B2', 'BH'], 'closed_perimeter');
  assert.strictEqual(pr.used, 2); assert.strictEqual(pr.skipped, 1); assert.strictEqual(pr.area_null, 0);
  // the duplicate pair → duplicates 1, both counted (never merged)
  const u = st(['U1', 'U2'], 'open_length');
  assert.strictEqual(u.duplicates, 1); near(u.base, 6); assert.strictEqual(u.used, 2);
  // the spline → approx 1
  const s = st(['S1'], 'open_length');
  assert.strictEqual(s.approx, 1); assert.strictEqual(s.used, 1); near(s.base, 5, 1e-6);
  // count over the INSERT handle → 1; an MINSERT counts rows × cols; lines are skipped; blocks per layer for the summary
  const c1 = st(['M1'], 'count');
  assert.strictEqual(c1.base, 1); assert.strictEqual(c1.used, 1); assert.deepStrictEqual(c1.blocks, [{ layer: 'MH', block: 'MH1', count: 1 }]);
  const c2 = st(['M1', 'M2', 'M3', 'K1'], 'count');
  assert.strictEqual(c2.base, 1 + 6 + 1); assert.strictEqual(c2.skipped, 1); assert.deepStrictEqual(c2.by_layer, { MH: 2, MH2: 1 });
  assert.deepStrictEqual(c2.blocks, [{ layer: 'MH', block: 'MH1', count: 7 }, { layer: 'MH2', block: 'MH1', count: 1 }]);
  // an insert is not a length
  assert.strictEqual(st(['M1'], 'open_length').used, 0);
  // an unknown handle → unknown 1
  const un = st(['K1', 'NOPE'], 'open_length');
  assert.strictEqual(un.unknown, 1); assert.strictEqual(un.base, 5);
  // a dropped shape (spline-edge hatch) → dropped, whatever the metric; nothing used
  for (const m of ['open_length', 'closed_perimeter', 'area', 'count']) { const d = st(['QH'], m); assert.strictEqual(d.dropped, 1, m); assert.strictEqual(d.used, 0, m); }
  assert.throws(() => st(['K1'], 'volume'), /unknown metric/);
  // a layer named __proto__ is an own property of by_layer
  const pf = flatten(parseDxf(dxf(ents(line('P1', '__proto__', 0, 0, 3, 4)))));
  assert.ok(Object.hasOwn(selectionTotals(pf, ['P1'], 'open_length').by_layer, '__proto__'));
  // a whole layer adds up bit for bit as the layer table does (flat order, not request order)
  {
    const L = [];
    for (let i = 0; i < 500; i++) L.push(...line('W' + i, 'W', i * 0.1, 0, i * 0.1 + 0.7 + i / 3, 0.3 * i));
    const wd = parseDxf(dxf(ents(L))), wf = flatten(wd);
    const hs = wf.map(f => f.handle).reverse();
    assert.strictEqual(selectionTotals(wf, hs, 'open_length').base, layerTable(wf, wd.layers, 'm').layers.find(l => l.layer === 'W').open_length);
  }
}

console.log('ok test-dxf');
