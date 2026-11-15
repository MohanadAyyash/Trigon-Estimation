# Take-off Batch 2 (on-screen DXF viewer, selection, snapping) + drawings backup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a DXF drawing on screen with layer visibility, zoom/pan, click and box selection with a live total, snapping, and link a selection to a tender row as a measurement. Also make the daily backup include the drawings folder.

**Architecture:**
- **Display data:** the parse worker also writes a compact binary display file per drawing. Arcs are tessellated for display only, and coordinates are relative to the drawing origin as Float32.
- **Browser side:** a pure viewer core (`public/viewer/core.js`: view transform, grid index, hit testing, snapping) is unit-tested in Node. A thin canvas layer draws it.
- **Saved quantities** are never computed in the browser. The server totals the selected handles from the exact parse cache, in a worker, and reuses the batch 1 gates (units / uom / overlap / incomplete / duplicate).

**Tech Stack:** Node ≥ 22.5, `node:worker_threads`, `node:zlib`, plain browser JS with Canvas 2D. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-14-takeoff-design.md` (Arabic):
- §5.3 is batch 2.
- §5.6 applies to every measurement.
- §6 items 3 and 5 apply to selections.

Base app spec: `docs/superpowers/specs/2026-11-14-estimation-design.md`.

## Global Constraints

- **No dependencies.** No CDN.
- **Arabic + English** for every visible string (`public/i18n.js`, parity enforced by `test-ui.js`). DOM text only via `h()`/`textContent`.
- **Saved quantities:**
  - Computed on the server from the exact parse cache (Float64, drawing units × `UNIT_TO_M`).
  - The browser's live total is for display only and is labelled "preview".
  - No quantity of any kind before units are confirmed.
- **Display data** may be approximate: Float32 relative to the origin, arcs tessellated. Never use it for a saved quantity.
- **Selection gates** (same bodies and flags as batch 1). A selection measurement needs:
  - `confirm_incomplete` when any selected entity is dropped, has a null area for metric `area`, or is `approx`;
  - `confirm_duplicate` when two selected entities share a `geomKey`;
  - `confirm_overlap` when any selected handle is already counted on the same row (by another selection, or by a layer measurement of the same metric on the same sha);
  - `confirm_uom` only when the row unit is unrecognised.
- **Draft only:** writes need a draft tender (409 otherwise). Roles: admin and qs write, viewer reads.
- **Audit:** every write is audited in the same transaction, as a summary only (counts, never handle lists).
- **Performance (Review Focus 3):**
  - A drawing of 100,000 entities must open in the viewer.
  - Each zoom or pan frame renders in under 200 ms on this machine. The test cap is configurable through `TEST_FRAME_MS`, default 500.
- **PARSER_VERSION** becomes 4. Old caches are re-parsed through the existing mechanism.
- **Commits** end with the session trailer. Branch `claude/friendly-hopper-5afh4q`. Never push to `main`; the controller does that.

## Review Focus

1. **Georeferenced drawings** (coordinates around 500,000 / 2,700,000 m, or in mm, which is 1000× larger):
   - display must not jitter or snap to a grid;
   - clicks must hit the right entity;
   - selection totals must stay exact.

   → Task 2 (origin offset) and Task 4 (hit test at georeferenced coordinates).
2. **Selecting part of a layer that is already linked to the same row:**
   - must give 409 `already measured on this row`;
   - with `confirm_overlap` it is saved and the confirmation is audited.

   → Task 3.
3. **A 100k-entity drawing:** the viewer opens, zoom and pan stay responsive, and the server stays responsive while it totals a selection of 100,000 handles. → Tasks 3 and 5.
4. **Arabic layer names** in the layer panel, and entity info shown on hover, render unchanged. → Task 5.
5. **Restoring from backup:**
   - a restored database with `data/drawings` restored from `backups/drawings` shows drawings again;
   - a drawing whose summary is missing but whose `.dxf` exists is parsed again automatically instead of asking for a re-upload.

   → Task 1.

## File Structure

```
scripts/backup.js            (modify) also mirror data/drawings/*.dxf into data/backups/drawings/ (add-only)
modules/drawings.js          (modify) missing summary + .dxf present → re-parse; render endpoint; dxf_selection measurements
lib/dxf/render.js            buildRender(doc, flat, segsByHandle) → Buffer (display format)
lib/dxf/geometry.js          (modify) flatten(doc, { withSegs: true }) also returns world segments per entity
lib/dxf/worker.js            (modify) writes <sha>.render.bin.gz; PARSER_VERSION 4
lib/dxf/select.js            selectionTotals(flat, handles, metric, opts) — pure
lib/dxf/select-worker.js     worker entry: loads <sha>.json.gz, runs selectionTotals
public/viewer/core.js        pure viewer logic (UMD: module.exports in Node, window.TV in the browser)
public/viewer/aci.js         ACI colour table (256 RGB entries)
public/viewer/canvas.js      canvas rendering and interaction
public/app.js, i18n.js, style.css   (modify) viewer in the Drawings tab
test-backup.js, test-dxf.js, test-drawings.js, test-viewer.js (new, pure core), test-ui.js
```

---

### Task 1: Backup includes drawings; a missing summary is rebuilt from the `.dxf`

**Files:**
- Modify: `scripts/backup.js`, `modules/drawings.js` (`readSummary`), `README.md` (AR + EN)
- Test: `test-backup.js`, `test-drawings.js`

**Interfaces:**
- **Backup:**
  - After the database copy, mirror every `DATA_DIR/drawings/<sha>.dxf` into `DATA_DIR/backups/drawings/<sha>.dxf`. Copy only files that are missing there; copy to `.tmp`, then rename.
  - Never delete anything in `backups/drawings`. The source files are content-addressed and immutable.
  - Caches (`*.json.gz`, `*.summary.json.gz`, `*.render.bin.gz`) are not backed up; they are rebuilt.
  - A failure follows the existing path: append to `backup-errors.log`, exit 1.
- **`readSummary`:** when the summary is missing (or of another version) and `<sha>.dxf` exists, re-parse through the existing queue (`parseSha`).
  - If the `.dxf` is missing too, return the existing 409 "upload the drawing again".
  - A failed re-parse is recorded on the drawing (`status 'failed'` with the plain message), so later views do not re-queue it again. This closes the deferred batch 1 minor (a).
- **README (AR + EN):**
  - Backups now include drawings automatically (`data\backups\drawings`).
  - Restore = copy `estimation.db` back plus `data\backups\drawings\*` into `data\drawings`.

- [ ] **Step 1: Failing tests.**
  - test-backup: run the script on a temp `DATA_DIR` with two `.dxf` files. Both appear in `backups/drawings`. A second run copies nothing new: mtime is unchanged. A third `.dxf` added later is copied. Deleting a source file leaves its backup in place.
  - test-drawings: upload, then delete the `<sha>.summary.json.gz` and the full cache. GET layers parses again and returns the same totals. Delete the `.dxf` as well: GET returns 409, and repeating the GET does not start a new parse (count the workers with the existing test hook).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test-backup.js`, `test-drawings.js`, `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(backup): include drawings; rebuild a missing summary from the stored DXF`.

### Task 2: Display file (render payload) and its endpoint

**Files:**
- Create: `lib/dxf/render.js`
- Modify: `lib/dxf/geometry.js` (option `withSegs`), `lib/dxf/worker.js`, `lib/dxf/summary.js` (`PARSER_VERSION = 4`), `modules/drawings.js`
- Test: `test-dxf.js`, `test-drawings.js`

**Interfaces:**
- `flatten(doc, { withSegs: true })` → the same `Flat[]`. Each non-dropped entity also gets `segs` (world-space segments, the existing `L`/`A`/`E` objects). The default call is unchanged.
- `buildRender(doc, flat) → Buffer`, the display format (little-endian). Layout:
  1. `uint32 headerLen`, then UTF-8 JSON header:

     ```
     { version: 1, origin: [x0, y0], bbox: [minx, miny, maxx, maxy],
       layers: [{ name, color, off, frozen }],
       handles: [string, ...],   // entity i ↔ handles[i], same order as the arrays below
       blocks: [string, ...] }
     ```

     - `origin` = the bbox min of the drawing.
     - `color` is the ACI number from the LAYER table; 7 when it is missing.
  2. Padding to a 4-byte boundary, then these typed arrays, in order:
     - `Uint32 layer[i]`, `Uint32 start[i]`, `Uint32 count[i]` (point offsets into `pts`)
     - `Uint8 kind[i]`: 0 open, 1 closed, 2 insert marker, 3 text anchor, 4 dropped (no points, not drawn)
     - padding to 4 bytes
     - `Uint32 block[i]` (index into `blocks`, or 0xFFFFFFFF)
     - `Float64 len[i]`, `Float64 area[i]` (drawing units; `NaN` when null). These are only for the live preview.
     - `Float32 pts[2·N]` = (x − x0, y − y0)
  3. A count of 0 is allowed.
- **Tessellation:** arcs and ellipses are split so that the chord error is ≤ 0.002·r (ellipses: use the major radius), with at least 4 and at most 256 segments per full turn. Lines are kept as they are.
- **Inserts** are drawn as their content, which is already flattened. Each INSERT also gets one `kind 2` marker at its insertion point, used for hit testing block counts.
- **Worker:** writes `<sha>.render.bin.gz`. The summary's `parser_version` is 4.
- **Endpoint:** `GET /api/drawings/:id/render`
  - Returns the gz bytes with `Content-Type: application/octet-stream`, `Content-Encoding: gzip`, `ETag: "<sha>-4"`, `Cache-Control: private, max-age=86400`. Handle `If-None-Match` → 304.
  - 409 unless the drawing is ready.
  - Allowed for any role that can read the tender.
  - It is allowed before units are confirmed: geometry is not a quantity.

- [ ] **Step 1: Failing tests** (test-dxf). Decode with a tiny decoder written in the test.
  - LINE (0,0)–(3,4) plus a closed square, both offset by (500000, 2700000) → `origin` = (500000, 2700000). The decoded points + origin are within 1e-3 of the true coordinates, and `len[0] === 5`.
  - CIRCLE r 10 → between 4 and 256 points; max chord error ≤ 0.02.
  - INSERT → one kind-2 marker at the insertion point, with the right `block` index.
  - A dropped entity → kind 4 with count 0.
  - Handles round-trip in order.
  - A 100k LINE file → buildRender < 3000 ms; the gz size is reported in the test output.
- [ ] **Step 2: Failing tests** (test-drawings).
  - GET render → 200, gzip, parseable. A second GET with `If-None-Match` → 304.
  - Viewer role → 200. A drawing that is not ready → 409.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `test-dxf.js`, `test-drawings.js`, `npm test` → PASS.
- [ ] **Step 6: Commit** `feat(dxf): compact display file per drawing and its endpoint`.

### Task 3: Selection totals and `dxf_selection` measurements

**Files:**
- Create: `lib/dxf/select.js`, `lib/dxf/select-worker.js`
- Modify: `modules/drawings.js` (create / relink / delete / clone for selections), `modules/tenders.js` only if the hooks need it
- Test: `test-dxf.js` (pure), `test-drawings.js` (API)

**Interfaces:**
- `selectionTotals(flat, handles, metric, { blocksOnly? }) →`

  ```
  { base,             // drawing units: Σlength for open_length (kind open);
                      //   Σlength for closed_perimeter (kind closed, not HATCH);
                      //   Σarea (non-null) for area; Σcount of kind insert for count
    used,             // entities that contributed
    dropped,          // selected entities with kind dropped
    area_null,        // for area: selected closed entities with null area
    approx,           // selected and approx
    duplicates,       // extra copies by geomKey among the used entities
    unknown,          // handles not in flat
    skipped,          // selected entities that don't apply to the metric
    by_layer: { [layer]: used count } }
  ```

  Selected entities that do not apply to the metric are ignored and counted in `skipped`. A handle that appears twice in the request → 400 at the API.
- `select-worker.js`: `workerData { file, handles, metric }` → `postMessage(result)`. It runs through the **same** FIFO queue as parses (concurrency 1), so a big selection never blocks the main thread.
- `POST /api/drawings/:id/measurements` with `tool: 'dxf_selection'`. Body:

  ```
  { row_id, handles: [string],   // 1..200000, unique
    metric: 'open_length'|'closed_perimeter'|'area'|'count',
    width?, depth?, factor?, label?, color?,
    confirm_uom?, confirm_overlap?, confirm_incomplete?, confirm_duplicate? }
  ```

  - `unknown > 0` → 400 `selection contains entities not in this drawing`.
  - `used === 0` → 400 `nothing in the selection can be measured as <metric>`.
  - Quantity and unit rules are exactly those of batch 1 (base × f or f², × width × depth × factor, `MAX_QTY`).
  - **Gates:**
    - incomplete = `dropped > 0 || area_null > 0 || approx > 0`;
    - duplicate = `duplicates > 0`;
    - overlap = any handle already in `measurement_handles` for a measurement on the same row with the same metric family (length metrics with each other; area; count), **or** any used entity's layer is linked by a `dxf_layer` measurement of the same metric on the same row and the same sha256.

    The 409 bodies follow batch 1 and add `{ dropped, area_null, approx, duplicates, overlapping }` counts.
- **Storage:**
  - New table `measurement_handles(measurement_id INTEGER NOT NULL, handle TEXT NOT NULL, PRIMARY KEY(measurement_id, handle))`.
  - The measurement row: `layer` NULL, `block` NULL, `handles_count = used`, `base`, and the same flags as batch 1 (`incomplete`, `duplicate`, `uom_confirmed`).
  - The selection summary for display goes in a new nullable TEXT column `selection_summary` (JSON: `by_layer` counts, metric).
- Relink revalidates the overlap using the stored handles. Rev clone copies `measurement_handles`. Delete removes them. A tender delete removes them.
- **Audit:** `{ drawing_id, row_id, tool, metric, used, qty, qty_unit }` plus the confirm actions with counts only.

- [ ] **Step 1: Failing pure tests** (test-dxf), on a fixture with KERB lines (2 × 5 m), a bowtie, a SPLINE, two identical lines and an INSERT:
  - open_length over two lines → 10.
  - area including the bowtie → `area_null` 1.
  - The duplicate pair → `duplicates` 1.
  - The spline → `approx` 1.
  - count over the INSERT handle → 1.
  - An unknown handle → `unknown` 1.
- [ ] **Step 2: Failing API tests** (test-drawings):
  - Selecting one KERB line onto a take-off row `m` gives qty 5.
  - Selecting the same handle again on that row → 409 `already measured on this row`; with confirm → saved and audited.
  - Selecting a KERB line onto a row that already has a `dxf_layer` KERB `open_length` measurement → 409 overlap.
  - The incomplete and duplicate selections → 409, then saved with confirm, with flags stored.
  - A handle repeated in the body → 400. An unknown handle → 400.
  - Revise the tender → the Rev has the selection with the same handles.
  - Delete the measurement → its handles are gone.
  - Approved tender → 409.
  - **100k handles:** select every entity of the 100k-LINE drawing. The server answers `/api/status` < `TEST_LATENCY_MS` while totalling, and the qty is exact.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `test-dxf.js`, `test-drawings.js`, `test-tenders.js`, `test-workflow.js`, `npm test` → PASS.
- [ ] **Step 6: Commit** `feat(takeoff): measure a selection of DXF entities (server-side totals, same gates)`.

### Task 4: Viewer core (pure, tested in Node)

**Files:**
- Create: `public/viewer/core.js`, `public/viewer/aci.js`
- Test: `test-viewer.js`

**Interfaces** (all pure; `core.js` exports via `module.exports` when defined, else `window.TV`):
- `decodeRender(arrayBuffer) → R` — the Task 2 format, returned as typed-array views (no copies).
- `makeView(bbox, width, height) → V`
  - `V = { scale, tx, ty }`: screen = (x·scale + tx, −y·scale + ty), in origin-relative coordinates.
  - The bbox is fitted with a 5 % margin.
- `zoomAt(V, sx, sy, factor) → V` keeps the drawing point under (sx, sy) fixed. `pan(V, dx, dy) → V`. `toWorld(V, sx, sy) → [x, y]`. `toScreen(V, x, y) → [sx, sy]`.
- `buildGrid(R, cellSize?) → G`: a uniform grid over the bbox, each cell listing entity indices that touch it. Cell size defaults so that cells ≈ √N × √N.
- `visible(G, R, worldRect, layerOn: Uint8Array) → Uint32Array` of entity indices.
- `hitTest(G, R, wx, wy, tolWorld, layerOn) → index | -1`
  - The nearest segment within the tolerance.
  - For closed shapes, a point inside counts when no edge is within the tolerance.
  - Kind 2 markers are hit within the tolerance.
- `boxSelect(G, R, rect, mode: 'window'|'crossing', layerOn) → Uint32Array`
  - window = the entity bbox is fully inside;
  - crossing = any segment intersects the rect, or the entity is fully inside.
- `snap(G, R, wx, wy, tolWorld, layerOn) → { x, y, kind: 'end'|'mid' } | null`: the nearest endpoint or segment midpoint within the tolerance.
- `previewTotal(R, indices, metric, unitFactor) → { value, used }`, display only:
  - open_length = Σ len over kind 0;
  - closed_perimeter = Σ len over kind 1;
  - area = Σ non-NaN area over kind 1 × f²;
  - count = Σ kind-2 markers.
- `aci.js`: the 256-entry AutoCAD ACI → `#rrggbb` table. Generate it from `ezdxf.colors` in the scratchpad venv (`/tmp/claude-0/-home-user/1956033f-373b-50f0-9950-21a22804a62c/scratchpad/hatchcheck/v`), credited in a comment (MIT). Do not type it from memory.

- [ ] **Step 1: Failing tests** (`test-viewer.js`, Node only; build `R` with `buildRender` from Task 2 on string DXF fixtures):
  - `zoomAt` keeps the point under the cursor within 1e-9 for factors 2, 0.5 and 10 in a row.
  - At georeferenced coordinates (+500000, +2700000), a click 1 px from a 1 m line at scale 100 px/m hits it, and a click 10 px away misses.
  - window vs crossing on two lines, one inside the rect and one partly inside.
  - A layer switched off is never hit or selected.
  - snap returns the endpoint within the tolerance and the midpoint of the segment.
  - `previewTotal` open_length over two 5 m lines in mm units → 10.
  - `aci[1] === '#ff0000'`, `aci[7] === '#ffffff'` (or the ezdxf value), and the table length is 256.
  - Performance: a grid over 100k lines builds in < 1000 ms. `visible()` for a viewport showing 1 % of the drawing returns in < 20 ms.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test-viewer.js`, `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(viewer): pure viewer core (view, grid, hit test, box select, snap) and ACI colours`.

### Task 5: Canvas viewer in the Drawings tab

**Files:**
- Create: `public/viewer/canvas.js`
- Modify: `public/app.js`, `public/i18n.js`, `public/style.css`, `public/index.html` (script tags for `viewer/core.js`, `viewer/aci.js`, `viewer/canvas.js`)
- Test: `test-ui.js`

**Interfaces:**
- Consumes the Task 2 endpoint, the Task 3 API and the Task 4 core.
- "Open viewer" on a ready drawing. The viewer panel takes the full width under the drawing list:
  - **Canvas:** devicePixelRatio aware. Background is dark (`#1e1e1e`); colours come from ACI.
  - **Layer panel:** checkbox per layer, colour swatch, Arabic names `dir=auto`, "all/none".
  - **Toolbar:** Select (click; Shift+click toggles), Window, Crossing, Clear, Fit, and a snap on/off toggle (snap marker shown under the cursor when on).
  - **Status bar:**
    - the cursor's real coordinates (origin + world, with the drawing units);
    - the selected count;
    - preview totals per metric, labelled "preview" (AR "معاينة"), each "—" until units are confirmed;
    - the hovered entity's layer, type and handle.
  - **Mouse:** wheel = zoom at the cursor, drag with the middle or right button = pan, drag in Window/Crossing mode = rubber band.
  - "Link selection…" opens the batch 1 link form with the metric picker.
    - It sends `tool:'dxf_selection'` with the handles.
    - The confirm checkboxes follow the batch 1 rules, and they reset on any change of row, metric, width, depth, factor or selection.
    - After a save, the selection is cleared, the measurement list refreshes, and the server's qty is shown.
- **Rendering:**
  - Only `visible()` entities are drawn.
  - At most one draw per animation frame.
  - `window.__tvLastFrameMs` is set to the last frame's duration (test hook).
- Read-only on non-draft tenders: selection and preview still work, Link is hidden.
- Leaving the tab or route detaches all listeners (`routeTok`).

- [ ] **Step 1: Extend `test-ui.js`** (Playwright, deviceScaleFactor 1):
  1. Upload the batch 1 fixture and confirm mm.
  2. Open the viewer and wait for the canvas.
  3. Click on the first KERB line (screen position computed with the page's `TV.toScreen`). The status bar shows 1 selected and the preview open_length 5.00.
  4. Link the selection to the take-off row `m`. Qty 5 appears and the measurement is listed with tool selection.
  5. Select the same line again and link it to the same row → the overlap 409 shows the checkbox. Change the selection → the box disappears.
  6. Turn off the KERB layer → clicking the same spot selects nothing.
  7. Arabic layer name in the panel unchanged.
  8. **100k drawing:** open the viewer, dispatch 5 wheel events, read `__tvLastFrameMs` < `TEST_FRAME_MS` (default 500).
  9. No console errors.
  10. Screenshot to the scratchpad `viewer.png`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test-ui.js`, `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(ui): on-screen DXF viewer with layers, selection, snapping and linking`.
