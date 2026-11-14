// xlsx reader/writer (pure lib): node --no-warnings test-xlsx.js
const assert = require('assert');
const { readXlsx, writeXlsx, buildZip } = require('./lib/xlsx.js');

const WB = (names) => `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
const RELS = (n) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
const SHEET = (rows) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

// 1. round trip, including empty row, '' vs null, trailing nulls
const input = [['No', 'Description', 'Unit', 'Qty'], ['1', 'Kerb laying', 'm', 1250.5], [], ['', 'SECTION B', null, null]];
const buf = writeXlsx([{ name: 'BOQ', rows: input, colWidths: [6, 40, 8, 12] }]);
assert.ok(Buffer.isBuffer(buf) && buf.slice(0, 2).toString() === 'PK');
assert.deepStrictEqual(readXlsx(buf).sheets, [{ name: 'BOQ', rows: input }]);

// 2. hand-built: shared string (incl. rich text), inline string, gap, stored entry, no styles, escapes
const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Interlock, 80mm</t></si><si><r><rPr><b/></rPr><t>Rich </t></r><r><t xml:space="preserve">text &amp; more</t></r></si><si><t>Qty</t><rPh sb="0" eb="1"><t>IGNORED</t></rPh></si></sst>`;
const sheet1 = SHEET(
  `<row r="1"><c r="A1" t="s"><v>2</v></c><c r="B1" t="s"><v>0</v></c></row>` +
  `<row r="3"><c r="A3" t="inlineStr"><is><t>Inline &lt;1&gt; &#65;&#x42;</t></is></c><c r="B3" t="s"><v>1</v></c><c r="C3" t="n"><v>12.5</v></c></row>` +
  `<row r="5"><c r="A5" t="str"><f>A1</f><v>Qty</v></c><c r="D5" t="inlineStr"><is><t>1,250.50</t></is></c><c r="E5" t="b"><v>1</v></c></row>`);
const zip = buildZip([
  { name: '[Content_Types].xml', data: '<Types/>', method: 8 },
  { name: 'xl/workbook.xml', data: WB(['Sheet One']), method: 0 },
  { name: 'xl/_rels/workbook.xml.rels', data: RELS(1), method: 8 },
  { name: 'xl/sharedStrings.xml', data: sst, method: 0 },
  { name: 'xl/worksheets/sheet1.xml', data: sheet1, method: 8 },
]);
assert.deepStrictEqual(readXlsx(zip).sheets, [{ name: 'Sheet One', rows: [
  ['Qty', 'Interlock, 80mm'], [], ['Inline <1> AB', 'Rich text & more', 12.5], [], ['Qty', null, null, '1,250.50', 1],
] }], 'shared/inline/gap/stored/formula-string; text numbers stay strings');

// 3. no sharedStrings part, absolute rel target, empty sheet
const zip2 = buildZip([
  { name: 'xl/workbook.xml', data: WB(['A', 'B']), method: 8 },
  { name: 'xl/_rels/workbook.xml.rels', data: RELS(2).replace('Target="worksheets/sheet1.xml"', 'Target="/xl/worksheets/sheet1.xml"'), method: 8 },
  { name: 'xl/worksheets/sheet1.xml', data: SHEET(`<row r="2"><c r="B2" t="inlineStr"><is><t>x</t></is></c></row>`), method: 8 },
  { name: 'xl/worksheets/sheet2.xml', data: SHEET(''), method: 8 },
]);
assert.deepStrictEqual(readXlsx(zip2).sheets, [{ name: 'A', rows: [[], [null, 'x']] }, { name: 'B', rows: [] }]);

// 4. two sheets keep order and names
const two = readXlsx(writeXlsx([{ name: 'Second', rows: [['a']] }, { name: 'First & Last', rows: [[1, 2]] }]));
assert.deepStrictEqual(two.sheets.map(s => s.name), ['Second', 'First & Last']);
assert.deepStrictEqual(two.sheets[1].rows, [[1, 2]]);

// 4b. sheet-name validation, formula without cached value, no sheets
const wr = name => () => writeXlsx([{ name, rows: [] }]);
assert.throws(wr('Bad:Name'), /invalid sheet name/);
assert.throws(wr('x'.repeat(32)), /31/);
assert.doesNotThrow(wr('x'.repeat(31)));
assert.throws(() => writeXlsx([{ name: 'Dup', rows: [] }, { name: 'dUP', rows: [] }]), /duplicate sheet name/);
assert.throws(wr(''), /invalid sheet name/);
assert.throws(wr("'quoted"), /apostrophe/);
const one = sheetBody => buildZip([{ name: 'xl/workbook.xml', data: WB(['Sheet1']) }, { name: 'xl/_rels/workbook.xml.rels', data: RELS(1) }, { name: 'xl/worksheets/sheet1.xml', data: SHEET(sheetBody) }]);
assert.throws(() => readXlsx(one('<row r="7"><c r="D7"><f>A1*B1</f></c></row>')), /formula without cached value at Sheet1!D7 .* Excel first/);
assert.throws(() => readXlsx(one('<row r="7"><c r="D7"><f>A1*B1</f><v></v></c></row>')), /formula without cached value at Sheet1!D7/);
assert.deepStrictEqual(readXlsx(one('<row r="1"><c r="A1"><f>1+2</f><v>3</v></c></row>')).sheets[0].rows, [[3]]);
assert.throws(() => readXlsx(buildZip([{ name: 'xl/workbook.xml', data: WB(['S']).replace(/<sheet /g, '<x:sheet ') }])), /^Error: no sheets found in workbook$/);

// 5. Arabic and awkward text round-trips unchanged
const ar = [['البند', 'الوصف', 'الكمية'], ['١', 'رصف أحجار البردورة — مم', 12], ['2', '  padded  ', 'line1\nline2 & <b> "q" \'s\'']];
assert.deepStrictEqual(readXlsx(writeXlsx([{ name: 'جدول الكميات', rows: ar }])).sheets, [{ name: 'جدول الكميات', rows: ar }]);

// 6. errors
assert.throws(() => readXlsx(Buffer.from('hello, definitely not a zip')), /^Error: not an xlsx file$/);
assert.throws(() => readXlsx(Buffer.alloc(0)), /not an xlsx file/);
assert.throws(() => readXlsx('nope'), /not an xlsx file/);
assert.throws(() => readXlsx(buildZip([{ name: 'readme.txt', data: 'x' }])), /not an xlsx file/);
const corrupt = Buffer.from(zip); corrupt[corrupt.indexOf('Interlock')] ^= 1; // flip a byte in a stored entry
assert.throws(() => readXlsx(corrupt), /crc/i);
assert.throws(() => readXlsx(buildZip([{ name: 'xl/workbook.xml', data: WB(['S']) }, { name: 'xl/_rels/workbook.xml.rels', data: RELS(1) }, { name: 'xl/worksheets/sheet1.xml', data: SHEET('<row r="1"><c r="A1"><v>1,5</v></c></row>') }])), /bad number/);
assert.throws(() => writeXlsx([{ name: 'S', rows: [[NaN]] }]), /number/i);
assert.throws(() => writeXlsx([{ name: 'S', rows: [[Infinity]] }]), /number/i);
console.log('test-xlsx: all passed');
