// Units, DXF decoding and parsing: node --no-warnings test-dxf.js
const assert = require('assert');
const { UNIT_TO_M, insunitsToUnit, normUom } = require('./lib/units.js');
const { decodeDxf } = require('./lib/dxf/decode.js');
const { parseDxf } = require('./lib/dxf/parse.js');

const dxf = (pairs, eol = '\n') => pairs.map(([c, v]) => c + eol + v).join(eol) + eol;
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
assert.deepStrictEqual(r12.entities[0].vertices, [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]]);
assert.strictEqual(r12.ignored.VERTEX, undefined);
const open = parseDxf(dxf(sec('ENTITIES', [[0, 'POLYLINE'], [5, 'B2'], [8, 'P'], [70, 0], ...v(0, 0), [0, 'VERTEX'], [10, 1], [20, 1], [42, 0.5], [0, 'SEQEND']])));
assert.strictEqual(open.entities[0].closed, false);
assert.deepStrictEqual(open.entities[0].vertices, [[0, 0, 0], [1, 1, 0.5]]);

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

console.log('ok test-dxf');
