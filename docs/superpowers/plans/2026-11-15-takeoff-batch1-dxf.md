# Take-off Batch 1 (DXF layers → BOQ quantities) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload a DXF to a tender, confirm its units, see a table of layers and blocks with their lengths, areas and counts, and link a layer or block to a tender row.

- On a take-off row the link sets the quantity.
- On a client BOQ row it shows as "our measured qty" next to the client's quantity.

**Architecture:**
- A pure DXF pipeline in `lib/dxf/` (parse → flatten with real geometry → per-layer summary), unit-tested on small hand-written DXF strings.
- A new `modules/drawings.js`:
  - stores files by sha256 under `DATA_DIR/drawings/`;
  - parses them in a `worker_threads` worker into a gzipped JSON cache;
  - exposes layer tables and measurement endpoints.
- `modules/tenders.js` gets four hooks: row quantity, measured-vs-client view, Rev copy, re-import/delete guards.
- A "Drawings" tab is added to the tender screen.

**Tech Stack:** Node ≥ 22.5 (`node:sqlite`, `node:zlib`, `node:crypto`, `node:worker_threads`), plain browser JS. No new dependencies (pdf.js arrives in batch 3, not here).

**Spec:** `docs/superpowers/specs/2026-11-14-takeoff-design.md` (Arabic). Batch 1 covers §5.1, §5.2, §5.6 and §6 items 1–4, 6, 7, 10, 11. Base app spec: `docs/superpowers/specs/2026-11-14-estimation-design.md`.

## Global Constraints

- **Dependencies:** none. `package.json` dependencies stay empty.
- **Database:** the app's own `estimation.db`. The ERP is never touched.
- **Units:**
  - No quantity is computed from a drawing until its units are confirmed (`drawings.units` not null).
  - Units offered: `mm`, `cm`, `m`, `km`, `ft`, `in`.
  - Factors to metres: 0.001, 0.01, 1, 1000, 0.3048, 0.0254.
- **Normalised quantity units** are exactly `m`, `m2`, `m3`, `nr`, `ls`.
- **Upload:**
  - Raw body route only; it is the only route allowed above 20 MB. Limit **100 MB** (100·1024·1024 bytes), enforced while streaming (413).
  - ASCII DXF only. Binary DXF (file starts with `AutoCAD Binary DXF`) → 400 `binary DXF is not supported — save as ASCII DXF`.
- **Parsing** runs in a `worker_threads` worker. The HTTP server must keep answering other requests during a parse.
- **Cache:** `DATA_DIR/drawings/<sha256>.dxf` and `<sha256>.json.gz`. Never in the database.
- **Double counting:** prevented by entity handle only. Identical geometry is reported as `possible_duplicate` warnings and never merged.
- **Arcs:**
  - Bulges, ARC, CIRCLE and ELLIPSE use true arc geometry.
  - SPLINE and non-uniformly-scaled arcs are approximated and flagged `approx`.
- **Client BOQ rows** (`source='import'`): a measurement never changes `qty`. It shows as `measured_qty` with `measured_diff_pct`.
  - |diff| > 5 % → row flag `measure_diff` and a summary entry. Not blocking.
- **LS rows** (normalised uom `ls`) cannot take measurements (400).
- **Tender status:** all writes need a draft tender (409 otherwise, via existing `mustDraft`). Roles: admin and qs write; viewer reads.
- **Audit:** every write is audited in the same transaction. The detail is a summary only: tool, row, qty, entity count — never geometry or handle lists.
- **UI:** all user-visible strings in Arabic and English (`public/i18n.js`). Text goes into the DOM via `h()`/`textContent`, never `innerHTML`.
- **Tests:**
  - Follow the existing pattern: a temp `DATA_DIR`, the real server, `ERP_SYNC_DISABLED=1`.
  - DXF fixtures are built as strings inside the tests. No binary or third-party files are committed.
- **Commits** end with the session attribution trailer. Work on branch `claude/friendly-hopper-5afh4q`; never push to `main`.

## Review Focus

1. **DXF written by different AutoCAD versions:**
   - R12 `POLYLINE`/`VERTEX`/`SEQEND` instead of `LWPOLYLINE`;
   - CRLF line endings;
   - group codes padded with spaces;
   - `$INSUNITS` missing or 0.

   All must parse to the same geometry, and missing units must force a choice. → tests in Task 1 and Task 2.
2. **Arabic layer names:** a UTF-8 file (AC1021+), or an older file whose `$DWGCODEPAGE` is `ANSI_1256`. Names must round-trip into the layer table and the UI unchanged. → tests in Task 1 and Task 6.
3. **A large file** (100 MB limit; 100,000 entities):
   - the upload is rejected early when over the limit;
   - the server answers `/api/status` while a parse runs;
   - the parse plus layer table finishes in under 15 s here.

   → test in Task 4 (the perf assertion lives in Task 3).
4. **The same layer or block linked twice to the same row:**
   - 409 `already measured on this row`, unless `confirm_overlap: true`;
   - the confirmation is audited;
   - quantities never silently double. → test in Task 5.
5. **Measurements on tenders that change state:**
   - submit/approve: writes return 409;
   - Rev: drawings and measurements are copied, with row ids remapped;
   - re-import: imported-row measurements become unlinked, never deleted;
   - deleting a row that has measurements: 409.

   → tests in Task 5.

## File Structure

```
lib/units.js              unit factors, $INSUNITS map, uom normalisation (aliases, Arabic)
lib/dxf/parse.js          parseDxf(text) → { header, layers, blocks, entities, ignored }
lib/dxf/decode.js         decodeDxf(buf) → text (UTF-8, else $DWGCODEPAGE, else latin1); binary detection
lib/dxf/geometry.js       flatten(doc) → resolved entities with metrics in drawing units
lib/dxf/summary.js        layerTable(flat) → per-layer totals, block counts, warnings
lib/dxf/worker.js         worker_threads entry: buffer → { summary, flat-light } JSON
modules/drawings.js       tables, raw upload, cache, units, layers, measurements API
modules/tenders.js        (modify) row qty hook, measured view, Rev copy, re-import/delete guards
public/app.js, i18n.js, style.css   (modify) Drawings tab
test-dxf.js               parse + geometry + summary + units (pure)
test-drawings.js          API: upload, units, layers, measurements, tender hooks
test-ui.js                (modify) Drawings tab smoke
```

---

### Task 1: Units, decoding and DXF parsing

**Files:**
- Create: `lib/units.js`, `lib/dxf/decode.js`, `lib/dxf/parse.js`, `test-dxf.js`

**Interfaces:**
- Produces:
  - `UNIT_TO_M = { mm:0.001, cm:0.01, m:1, km:1000, ft:0.3048, in:0.0254 }`.
  - `insunitsToUnit(code: number) → 'mm'|'cm'|'m'|'km'|'ft'|'in'|null`. Codes: 1→in, 2→ft, 4→mm, 5→cm, 6→m, 7→km. Anything else → null.
  - `normUom(s: string) → 'm'|'m2'|'m3'|'nr'|'ls'|null`. The lookup trims, lower-cases and collapses spaces; aliases:
    - `m`: `m`, `lm`, `rm`, `l.m`, `م`, `م.ط`
    - `m2`: `m2`, `m²`, `sqm`, `sq.m`, `sq m`, `م2`, `م²`
    - `m3`: `m3`, `m³`, `cum`, `cu.m`, `cu m`, `م3`, `م³`
    - `nr`: `nr`, `no`, `nos`, `no.`, `ea`, `each`, `pcs`, `عدد`
    - `ls`: `ls`, `l.s`, `l.s.`, `lump sum`, `item`, `مقطوعية`
  - `decodeDxf(buf: Buffer) → string`. Throws `Error('binary DXF is not supported — save as ASCII DXF')` when `buf` starts with `AutoCAD Binary DXF`. Order:
    1. Strict UTF-8 (`TextDecoder('utf-8', { fatal: true })`).
    2. If that fails, read `$DWGCODEPAGE` from a latin1 decode. `ANSI_1256` → `windows-1256`; `ANSI_1252` → `windows-1252`; otherwise latin1.
  - `parseDxf(text: string) → { header: { insunits: number|null, codepage: string|null, acadver: string|null }, layers: [{ name, color, off: bool, frozen: bool }], blocks: { [name]: { base:[x,y], entities: Raw[] } }, entities: Raw[], ignored: { [type]: count }, warnings: [{ code, detail }] }`
    - `Raw = { type, handle, layer, codes: [[code:number, value:string]...] }`. Model-space entities only. R12 `POLYLINE` plus its `VERTEX`es and `SEQEND` are folded into one Raw with `vertices: [[x,y,bulge]...]` and `closed` from flag 70 & 1.
    - Layer `off` = color < 0. Layer `frozen` = flag 70 & 1.
    - Entities in paper space (code 67 = 1) are skipped and give the warning `paper_space` with a count.
    - A `$XREF`-style block (flag 70 & 4) gives the warning `xref`.
    - Supported types are kept in `entities`. Every other type is counted in `ignored`.
    - Supported types: `LINE`, `LWPOLYLINE`, `POLYLINE`, `ARC`, `CIRCLE`, `ELLIPSE`, `SPLINE`, `INSERT`, `HATCH`, `TEXT`, `MTEXT`.

- [ ] **Step 1: Write the failing tests in `test-dxf.js`.** Use a helper `dxf(sections)` that builds a DXF string from `[code, value]` pairs.
  - `normUom('M2') === 'm2'`, `normUom(' م² ') === 'm2'`, `normUom('Nos') === 'nr'`, `normUom('Lump Sum') === 'ls'`, `normUom('kg') === null`.
  - `insunitsToUnit(4) === 'mm'`, `insunitsToUnit(0) === null`.
  - Binary: `decodeDxf(Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00'))` throws /binary DXF/.
  - Arabic: a UTF-8 file with layer `أسفلت` → `layers[0].name === 'أسفلت'`. The same file encoded in windows-1256, with header `$DWGCODEPAGE`=`ANSI_1256`, gives the same name. Encode it in the test with a small table of the four letters' cp1256 bytes: أ=0xC3, س=0xD3, ف=0xDD, ل=0xE1, ت=0xCA.
  - Robustness: a DXF using CRLF line endings, with group codes written as `  0` and `10 ` (padded), parses the same as the clean version (`deepEqual` of `entities`).
  - R12: `POLYLINE` (70=1) with 4 `VERTEX` (0,0) (10,0) (10,10) (0,10) and a `SEQEND` → one Raw with 4 vertices and `closed: true`.
  - `$INSUNITS` 6 → `header.insunits === 6`. Missing → `null`.
  - A paper-space LINE (67=1) is skipped, with warning `paper_space`. A `DIMENSION` is counted in `ignored.DIMENSION === 1`.
- [ ] **Step 2: Run.** `node --no-warnings test-dxf.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `lib/units.js`, `lib/dxf/decode.js` and `lib/dxf/parse.js`.
  - Tokenise as pairs of lines: `code = parseInt(line.trim())`, `value = next line` with the trailing `\r` stripped and kept untrimmed, except that numeric values are parsed with `Number(value.trim())`.
  - Sections: HEADER, TABLES (LAYER), BLOCKS, ENTITIES.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dxf): units, decoding and DXF parser`.

### Task 2: Geometry — flatten with real arcs, blocks, hatches

**Files:**
- Create: `lib/dxf/geometry.js`
- Test: `test-dxf.js` (append)

**Interfaces:**
- Consumes: `parseDxf` from Task 1.
- Produces: `flatten(doc) → Flat[]`, where

```js
Flat = { handle, layer, type,
         kind: 'open'|'closed'|'insert'|'text',
         length: number,        // open: path length; closed: perimeter (drawing units)
         area: number|null,     // closed shapes and HATCH only
         block: string|null,    // INSERT: block name
         depth: number,         // 0 = top level, ≥1 = inside a block
         count: number,         // INSERT: 1, or rows×cols for MINSERT
         approx: boolean,
         bbox: [minx, miny, maxx, maxy],
         geomKey: string }      // stable hash of rounded geometry, for duplicate warnings
```

Geometry rules:
- **Bulge segment:** chord `c`, bulge `b`; θ = 4·atan(b); radius r = c / (2·sin(θ/2)).
  - Arc length = |θ|·r.
  - Area contribution (shoelace + segment) = (r²/2)·(θ − sin θ), sign following the bulge.
- **ELLIPSE:** arc length by Ramanujan II for a full ellipse; numeric integration (≥ 360 steps) for a partial one. Area = π·a·b for a full ellipse. Not flagged approx.
- **SPLINE:** evaluated by de Boor at ≥ 200 samples per span, as a polyline. `approx: true`.
- **INSERT:**
  - Apply scale (41/42), rotation (50) and insertion (10/20) to the block entities, recursively. Nested entities get `depth+1`.
  - Block entities on layer `0` (or color BYBLOCK) take the INSERT's layer.
  - Uniform scale scales lengths by |s| and areas by s².
  - Non-uniform scale: arcs are sampled to a polyline and `approx: true`.
  - MINSERT (70/71 rows/cols): `count = rows×cols`, and geometry is repeated at the 44/45 spacing.
- **HATCH:**
  - Area = outer boundary loops minus inner loops. Loops are classified by containment (even–odd) using the loop paths.
  - Edge types: line, arc, ellipse, polyline-with-bulge.
  - `length` = sum of loop perimeters.
- **TEXT/MTEXT:** `kind 'text'`, length 0, area null.

- [ ] **Step 1: Append failing tests.** Exact values; compare with tolerance 1e-9 unless noted.
  - `LINE` (0,0)→(3,4): `length === 5`, `kind 'open'`.
  - Closed `LWPOLYLINE` square 10×10: `length 40`, `area 100`.
  - Open `LWPOLYLINE` (0,0)→(2,0) with bulge 1: `length === Math.PI`.
  - Closed `LWPOLYLINE` (0,0)→(2,0)→back, both bulges 1 (a circle of r 1): `area ≈ Math.PI`, `length ≈ 2π`.
  - `CIRCLE` r 2: `area 4π`, `length 4π`. `ARC` r 1, 0°→90°: `length π/2`.
  - `ELLIPSE` full, a = 2, b = 1: `area 2π`, `length ≈ 9.688448220547675` (1e-6).
  - Block `B1` = LINE (0,0)→(1,0) on layer `0`.
    - `INSERT B1` on layer `KERB` at scale 2 → a flat line on `KERB` with `length 2` and `depth 1`, plus an insert entry with `count 1` and `block 'B1'`.
    - Rotation 90° → the line's bbox is vertical.
    - Nested: block `B2` contains `INSERT B1`; `INSERT B2` → B1 at `depth 2`.
  - MINSERT of B1 with 2 rows × 3 cols → insert `count 6`, 6 line entries.
  - `HATCH` outer 10×10, inner 2×2 → `area 96`.
  - Non-uniform INSERT (sx 2, sy 1) of a block containing a CIRCLE r 1 → `approx: true`, `area ≈ 2π` (1e-3).
  - `SPLINE` → `approx: true`.
  - Units are not applied here (drawing units).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `lib/dxf/geometry.js`.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dxf): geometry with true arcs, blocks, MINSERT, hatches`.

### Task 3: Layer summary and duplicates (+ performance)

**Files:**
- Create: `lib/dxf/summary.js`
- Test: `test-dxf.js` (append)

**Interfaces:**
- Consumes: `flatten`, `Flat`, `UNIT_TO_M`.
- Produces: `layerTable(flat: Flat[], layers, unit: string|null) → { layers: LayerRow[], warnings: [{ code, detail }] }`.

```js
LayerRow = { layer, off, frozen,
             open_length,      // m   (null if unit null)
             closed_perimeter, // m
             area,             // m2
             blocks: [{ name, top: count, nested: count }],
             entities: number, approx: number }
```

- Drawing units → metres: length × f, area × f², where f = `UNIT_TO_M[unit]`. When `unit` is null, every metric is null and nothing is computed.
- A HATCH's area counts toward its layer's area. A closed polyline's area counts too.
- When a HATCH and a closed polyline on the **same layer** share `geomKey`, both still count (handles differ) and the warning `possible_duplicate` is raised with the layer and the count. Same for identical LINEs.
- `geomKey` comes from coordinates rounded to 1e-6 drawing units, made independent of direction.
- Block counts: `top` = Σ count where depth 0; `nested` = Σ count where depth ≥ 1. Grouped by the INSERT's resolved layer.

- [ ] **Step 1: Append failing tests.**
  - Fixture, unit `mm`:
    - layer `KERB`: LINE 3000,4000 (5 m) plus a closed square 1000 mm (perimeter 4 m, area 1 m²);
    - layer `ASPHALT`: HATCH 10000×10000 (100 m²);
    - layer `MH`: two `INSERT MH1`.
  - Expected:
    - `KERB.open_length === 5`, `KERB.closed_perimeter === 4`, `KERB.area === 1`;
    - `ASPHALT.area === 100`;
    - `MH.blocks` `[{ name: 'MH1', top: 2, nested: 0 }]`.
  - `unit null` → `KERB.open_length === null`.
  - Duplicate: two identical LINEs on `KERB` → `open_length` counts both and there is a warning `possible_duplicate`.
  - Arabic layer name preserved.
  - **Performance:** 100,000 LINEs across 20 layers, built as a string. `parseDxf` + `flatten` + `layerTable` takes < 15000 ms (`performance.now()`), and the totals are exact.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (record the timing in the report).
- [ ] **Step 5: Commit** `feat(dxf): per-layer totals, block counts, duplicate warnings`.

### Task 4: Drawings module — storage, raw upload, worker parse, units, layers

**Files:**
- Create: `modules/drawings.js`, `lib/dxf/worker.js`, `test-drawings.js`
- Modify: `server.js` (add to `MODULES` after tenders); `package.json` only if needed (it isn't: `run-tests.js` globs).

**Interfaces:**
- Consumes: the `ctx` helpers (`need`, `audit`, `bad`, `DATA_DIR`), the tenders tables, `decodeDxf`, `parseDxf`, `flatten`, `layerTable`, `insunitsToUnit`.
- Tables:
  - `drawings(id, tender_id, kind TEXT NOT NULL DEFAULT 'dxf', name, sha256, bytes, units TEXT, suggested_units TEXT, status TEXT /*parsing|ready|failed*/, error TEXT, rev INTEGER DEFAULT 1, replaced_by INTEGER, created, created_by)`
  - `measurements(id, drawing_id, tender_id, row_id INTEGER /*NULL = unlinked*/, tool TEXT, layer TEXT, block TEXT, metric TEXT, nested INTEGER DEFAULT 0, width REAL, depth REAL, factor REAL NOT NULL DEFAULT 1, label, color, qty REAL, qty_unit TEXT, handles_count INTEGER, review_needed INTEGER DEFAULT 0, created, created_by)`
- Exposes on ctx: `ctx.drawings = { cloneForTender(fromTenderId, toTenderId, rowIdMap), unlinkRows(rowIds), rowMeasuredQty(rowId) → { qty, unit, count } | null, hasMeasurements(rowId) → bool }`.
- Endpoints:
  - `POST /api/tenders/:id/drawings?name=<urlencoded>`, raw body (`Content-Type: application/octet-stream`):
    - Read the stream yourself: do not call `readBody`. Abort with 413 when the size exceeds 100 MB.
    - Compute sha256 and write the `.dxf` if it is absent.
    - Insert the row with `status 'parsing'` and reply 202 `{ id }`.
    - Parse in a worker. On success write `<sha>.json.gz` = `{ header, layers, ignored, warnings, flat }` (flat without `codes`), set `status 'ready'`, and set `suggested_units` from `$INSUNITS`. On failure set `status 'failed'` with the error message.
    - The same sha256 already parsed → reuse the cache and go straight to `ready`.
    - Audit `upload` (name, bytes, sha256).
  - `GET /api/tenders/:id/drawings` → the list.
  - `GET /api/drawings/:id` → the row plus `ignored`, `warnings`, `header`.
  - `PUT /api/drawings/:id/units { units }`:
    - admin or qs; draft only.
    - Allowed only while the drawing has no measurements. Otherwise 409 `units cannot change after measuring (batch 4 adds a before/after flow)`.
    - Audited.
  - `GET /api/drawings/:id/layers` → `layerTable(flat, layers, units)` (metrics null until units are set) and `units_confirmed: bool`.
  - Roles: viewer may GET. Every write requires admin or qs plus a draft tender, and 404 for a drawing of another tender path.

- [ ] **Step 1: Write failing `test-drawings.js`.**
  - Create a tender and upload the Task 3 fixture DXF via `fetch(..., { body: Buffer })` → 202. Poll `GET /api/drawings/:id` until `ready` (poll loop with a 10 s cap, not a fixed sleep).
  - `suggested_units` is `'mm'` when `$INSUNITS` = 4. `layers` before units have null metrics and `units_confirmed: false`.
  - `PUT units { units: 'mm' }` → layers `KERB.open_length === 5`. Invalid units `'yd'` → 400.
  - Binary DXF → the drawing ends `failed` with /binary DXF/ (or a 400 at upload if detected from the first bytes — choose one and assert it).
  - Body > 100 MB: send a stream of 101 MB of `'0\n'` → 413, and no file is left in `DATA_DIR/drawings`.
  - Responsiveness: start a 100,000-LINE upload, then immediately `GET /api/status` and assert it answers in < 500 ms while the drawing is still `parsing`.
  - Same file uploaded twice → one `.dxf` file on disk, both drawings `ready`.
  - Viewer `POST` → 403. Approved tender → `POST` 409.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `modules/drawings.js` and `lib/dxf/worker.js` (`new Worker(path, { workerData: { file } })`, posting back JSON).
- [ ] **Step 4: Run** `test-drawings.js` and `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(drawings): raw DXF upload, worker parse, units, layer table API`.

### Task 5: Measurements from layers and blocks, and tender integration

**Files:**
- Modify: `modules/drawings.js`, `modules/tenders.js`
- Test: `test-drawings.js` (append)

**Interfaces:**
- Consumes: Task 4 tables and the `ctx.drawings` hooks; in `tenders.js`, `takeoffQty`, `mustDraft`, `tx`, the import and revise handlers, and the rows view.
- Endpoint `POST /api/drawings/:id/measurements`. Body:

```js
{ row_id, tool: 'dxf_layer'|'dxf_blocks', layer,
  metric: 'open_length'|'closed_perimeter'|'area'|'count',
  block?, nested?: bool,
  width?, depth?, factor?: 1,
  label?, color?, confirm_uom?: bool, confirm_overlap?: bool }
```

- **Quantity:**
  - `base` = the layer metric in metres, or the block count (`top`, plus `nested` when `nested: true`).
  - `qty = base × (width ?? 1) × (depth ?? 1) × factor`.
  - Unit:
    - `open_length` / `closed_perimeter`: `m`; ×width → `m2`; ×width×depth → `m3`.
    - `area`: `m2`; ×depth → `m3`.
    - `count`: `nr`.
    - Width/depth on `count` → 400.
- **Validation:**
  - Units not confirmed → 409 `confirm the drawing units first`.
  - Row not in this tender, or a heading → 400.
  - `normUom(row.unit) === 'ls'` → 400.
  - `normUom(row.unit)` null or ≠ `qty_unit` → 409 `{ error: 'unit mismatch', row_unit, qty_unit }` unless `confirm_uom: true` (audited as `measure_uom_confirmed`).
  - The same `(drawing, layer|block, metric)` already measured on the same row → 409 `already measured on this row` unless `confirm_overlap: true` (audited).
  - width/depth/factor must be finite > 0 and ≤ 1e6.
- **Row integration in `tenders.js`:**
  - Take-off rows: `qty = takeoffQty(lines) + Σ measurements.qty`. Recompute on every measurement create/delete and on every line write. Negative → rollback (existing rule).
  - Imported rows: `qty` is never changed. The rows view adds `measured_qty`, `measured_unit` and `measured_diff_pct = (measured − qty)/qty × 100` (null if qty 0). When |diff| > 5 → `measure_diff: true`.
  - The price response adds `measure_warnings: [{ row_id, diff_pct }]`. The UI shows it in Summary. It is **not** a blocking code.
- **Guards:**
  - Deleting a row that has measurements → 409 `remove its measurements first`.
  - Re-import: `ctx.drawings.unlinkRows(oldImportedRowIds)` sets `row_id = NULL` (measurements kept). The import response adds `measurements_unlinked`.
  - Revise: `ctx.drawings.cloneForTender(old, new, rowIdMap)` copies the drawings rows (same sha256, no file copy) and the measurements with remapped `row_id`.
- `DELETE /api/measurements/:id`, `PUT /api/measurements/:id { row_id }` (relink an unlinked one), and `GET /api/tenders/:id/measurements` (with `unlinked` ones listed).
- Audit summary only: `{ drawing_id, row_id, tool, layer|block, metric, qty, qty_unit }`.

- [ ] **Step 1: Append failing tests.** Same fixture, units `mm`:
  - Take-off row `m`: link `KERB open_length` → row qty 5. Add a take-off line 2 → qty 7. Delete the measurement → 2.
  - Take-off row `m2`: link `KERB open_length` with width 0.5 → qty 2.5, `qty_unit m2`. Without width → 409 unit mismatch. With `confirm_uom` → saved, and an audit row exists.
  - Imported row (via the existing import) `ASPHALT … m2` with client qty 95: link `ASPHALT area` → row `qty` stays 95, `measured_qty 100`, `measured_diff_pct ≈ 5.263`, `measure_diff true`. The price response has a `measure_warnings` entry and `blocking` is unchanged.
  - Block row `nr`: link `MH1` count → qty 2.
  - Overlap: the same link twice → 409. With `confirm_overlap` → qty doubles and the audit row exists.
  - LS row → 400. Units unconfirmed → 409.
  - Delete a row with measurements → 409.
  - Re-import → the measurement row_id is null, `measurements_unlinked: 1`, and the drawings tab list shows it as unlinked.
  - Submit and approve the tender, then revise → the Rev has the drawing (same sha256) and the measurements on the new row ids. The original's measurements are unchanged.
  - Approved tender → measurement `POST` 409.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (all writes in `tx()` together with their audit).
- [ ] **Step 4: Run** `test-drawings.js`, `test-tenders.js`, `test-workflow.js` and `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(takeoff): link DXF layers/blocks to rows; measured vs client qty`.

### Task 6: Drawings tab (UI)

**Files:**
- Modify: `public/app.js`, `public/i18n.js`, `public/style.css`, `test-ui.js`

**Interfaces:**
- Consumes: the Task 4 and 5 endpoints.

**Screen:** a new tab `#/tender/:id/drawings` between Quantities and Links.
- **Upload:** a file input (`.dxf`) and a name. Send with `fetch(…, { method: 'POST', body: file })`. Show "parsing…" and poll until ready.
- **Units panel:** the suggested units are pre-selected; nothing is computed until the user presses "Confirm units". Show `ignored`, `paper_space`, `xref` and `approx` warnings.
- **Layer table:** columns layer, open length (m), closed perimeter (m), area (m²), blocks (name: top / nested), approx, off/frozen badges.
  - Each metric cell has a "Link…" button, which opens a small form: row picker (take-off and imported rows, showing their uom), width/depth/factor, label.
  - On 409, show the server's message with a confirm checkbox for `confirm_uom` / `confirm_overlap`.
- **Measurement list:** label, layer/block, metric, qty, unit, row, and Delete.
  - Unlinked measurements are listed first, with a row picker to relink.
- **Quantities tab:** imported rows show `measured_qty` and a diff badge, with a warning colour when `measure_diff`.
- **Summary:** lists `measure_warnings`.
- All new strings go in both languages. Arabic layer names display as-is.

- [ ] **Step 1: Extend `test-ui.js`.** Keep the i18n parity check. Playwright:
  1. Upload the fixture DXF.
  2. Confirm units.
  3. See `KERB` with `5.00`.
  4. Link it to a take-off row.
  5. See the row qty `5.00` on the Quantities tab.
  6. An Arabic layer `أسفلت` renders unchanged.
  7. No console errors.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test-ui.js` and `npm test` → PASS. Save a screenshot of the Drawings tab to the scratchpad.
- [ ] **Step 5: Commit** `feat(ui): drawings tab — DXF upload, units, layer table, links`.
