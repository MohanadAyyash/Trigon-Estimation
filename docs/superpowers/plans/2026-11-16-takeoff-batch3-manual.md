# Take-off Batch 3: PDF and images, calibration, manual measuring tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload PDF drawings and images, calibrate their scale, and measure by hand on them and on DXF drawings. The tools are line/polyline length, closed area with holes, rectangle and point count, with width/depth/factor and deduct. Each measurement is linked to tender rows with the existing gates.

**Architecture:**
- **PDF pages:** the browser renders them with a vendored pdf.js (pinned 4.10.38, in `public/vendor/pdfjs/`, Apache-2.0 licence file included).
- **Images:** drawn directly.
- **Stored geometry:** manual geometry is stored in page units (PDF points or image pixels) or DXF drawing units.
- **Quantities:** the server computes every quantity (pure `lib/takeoff/*`) from the stored geometry and the page's calibration (PDF/image) or the confirmed units (DXF). The browser's live value is a labelled preview using the same formulas.
- **DXF snapping:** uses true vertices only. This needs a per-point flag in the display file.

**Tech Stack:** Node ≥ 22.5. Plain browser JS with Canvas 2D. pdf.js 4.10.38 is vendored (the only dependency, approved by the owner) and loaded with dynamic `import()` from `/vendor/pdfjs/pdf.min.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-14-takeoff-design.md` §5.4 (batch 3), §5.6, §6 items 6–9.

## Global Constraints

- **Dependencies:** none, except vendored pdf.js 4.10.38 (`pdf.min.mjs`, `pdf.worker.min.mjs`, `LICENSE`). It is never loaded from the internet.
- **Arabic + English** for every string (parity enforced). Text only via `h()`/`textContent`; no innerHTML.
- **Saved quantities** are computed only on the server, from stored geometry × (calibration scale | `UNIT_TO_M`). The browser preview is labelled "preview"/"معاينة" and uses the identical formula module, shared as UMD like `core.js`.
- **No quantity before:** calibration of that page or region (PDF/image), or confirmed units (DXF).
- **Manual measure order:** shape → minus holes (inside the same measurement) → × width/depth → × factor. A measurement may itself be a deduction (`deduct: true`, negative contribution). A row total below 0 is refused (existing rule).
- **Gates:** the batch-1/2 unit rules (known units must match; `confirm_uom` only for unrecognised row units). Draft-only. Roles: admin/qs write. Audit in the same transaction, summary only (tool, row, qty, point count; never coordinates).
- **Upload limits:**
  - PDF: magic `%PDF-`, ≤ 100 MB.
  - Images: PNG/JPEG by magic bytes, ≤ 50 MB. Dimensions are read on the server from the header (PNG IHDR, JPEG SOF0/SOF2) and must be ≤ 20000 px per side.
- **Calibration:**
  - Two points plus a known real length. Points must be ≥ 10 page units apart.
  - **Verify tool:** a second known line reports the difference %. Above 1 % gives a warning.
  - **Regions:** optional rectangles with their own calibration. A measurement uses the region containing its first point; otherwise the page calibration.
  - **Re-calibration** when measurements depend on it returns a before/after list and is applied only with `apply: true`.
- **Undo** while drawing (point by point), Enter/double-click finishes, Esc cancels. Saved measurements can be edited (label, width, depth, factor, deduct, row) or deleted. Changing geometry = delete and redraw.
- **Commits** end with the session trailer. Branch `claude/friendly-hopper-5afh4q`. The controller pushes and merges.

## Review Focus

1. **A wrong scale stays wrong silently.** Every PDF quantity must show which calibration it used (page or region, and the verify %). Re-calibrating must show before/after and never change quantities without `apply`. → Task 3.
2. **Polygons drawn by hand often self-intersect or have holes outside the outer ring.** These must be refused with a clear message, never given a wrong area. → Task 4.
3. **Rotated PDF pages** (rotation 90/270), pages of different sizes in one file, and **very large sheets** (A0 at high zoom): the measured length must be independent of rotation and zoom. → Tasks 2, 5 and 6.
4. **DXF snap precision at georeferenced coordinates:** snapping to a true vertex must reproduce the vertex within 1e-3 drawing units. A tessellation point is never a snap target. → Task 1.
5. **Approved tenders and the Rev copy:** manual measurements and calibrations are copied with remapped rows. Nothing on a non-draft tender can change. → Task 4.

## File Structure

```
public/vendor/pdfjs/{pdf.min.mjs,pdf.worker.min.mjs,LICENSE}   vendored, pinned 4.10.38
lib/dxf/render.js, lib/dxf/summary.js     (modify) display file v3: per-point flag for true vertices; PARSER_VERSION 6
public/viewer/core.js                     (modify) snap uses true vertices and straight-segment midpoints only
lib/takeoff/imagesize.js                  PNG/JPEG dimensions from header bytes
lib/takeoff/calib.js                      scale from calibration, region lookup, verify %
lib/takeoff/manual.js                     UMD: lengths, areas with holes, validation, qty composition (shared with the browser)
modules/drawings.js                       (modify) pdf/image upload, pages, file endpoint, calibrations, manual measurements
public/viewer/raster.js                   PDF/image page viewer (pdf.js), shares the view transform
public/viewer/tools.js                    measuring tools (draw, undo, snap hook, live preview)
public/app.js, i18n.js, style.css, index.html   (modify)
test-takeoff.js (pure: imagesize, calib, manual), test-drawings.js, test-viewer.js, test-ui.js
```

---

### Task 1: Batch-2 carry-overs and true-vertex snapping

**Files:** `lib/dxf/render.js`, `lib/dxf/summary.js` (`PARSER_VERSION = 6`), `public/viewer/core.js`, `public/i18n.js`, `public/app.js`; tests in `test-dxf.js`, `test-viewer.js`, `test-ui.js`.

**Interfaces:**
- **Display file format version 3:** after `pts`, add `Uint8 vtx[N]` (one byte per point).
  - 1 = true vertex: a polyline/line vertex, or an arc/ellipse start or end.
  - 0 = tessellation point or NaN break.
  - Update the format comment and the test decoder.
- **`TV.snap`** returns:
  - `'end'` only for vtx = 1 points;
  - `'mid'` only for the midpoint of two consecutive vtx = 1 points with no tessellation point between them (a straight segment).
  - `kind 2/3/5` markers snap as `'end'`.
- **Carry-overs:**
  - Arabic `tv_confirm_mixed` uses «عُدّ».
  - A nested-only count refusal (400 "nothing … count") with nested off shows the hint "tick Include nested inserts" (AR/EN) in the viewer.

- [ ] **Step 1: Failing tests.**
  - Render: a closed LWPOLYLINE with one bulge segment → vtx flags are 1 at the 4 vertices and 0 on the arc's inner points.
  - Viewer: snap near an arc's inner tessellation point returns `null` or the nearest true vertex, never the tessellation point.
  - Viewer: snap at georeferenced coordinates (+500000 m and in mm ×1000) reproduces a vertex within 1e-3.
  - UI: AR text contains «عُدّ»; the nested hint appears.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test-dxf.js`, `test-viewer.js`, `test-ui.js`, `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(viewer): snap to true vertices only (display file v3); batch-2 carry-overs`.

### Task 2: PDF and image upload, pages, file endpoint, vendored pdf.js

**Files:** `public/vendor/pdfjs/*`, `lib/takeoff/imagesize.js`, `modules/drawings.js`; tests in `test-takeoff.js` (new), `test-drawings.js`.

**Interfaces:**
- **Vendoring:**
  - Download `pdfjs-dist@4.10.38` with `npm pack` in the scratchpad, never into `node_modules` of the repo.
  - Copy `build/pdf.min.mjs`, `build/pdf.worker.min.mjs` and `LICENSE` into `public/vendor/pdfjs/`.
  - Record the sha256 of each file in `public/vendor/pdfjs/README.md` (version, source tarball URL, hashes).
  - The static handler must serve `.mjs` as `text/javascript`. Fix the MIME map if needed.
- **`imageSize(buf) → { type: 'png'|'jpeg', width, height }`**
  - Throws `Error('not a PNG or JPEG image')` or `'image too large (max 20000 px per side)'`.
  - PNG: IHDR at offset 16.
  - JPEG: walk the markers to SOF0–SOF3 / SOF5–SOF7 / SOF9–SOF11 / SOF13–SOF15. Read only the header. Truncated input → throw.
- **Upload:** the existing route `POST /api/tenders/:id/drawings?name=…` accepts PDF/PNG/JPEG by magic.
  - Kind `pdf` limit 100 MB; images 50 MB. Content-addressed storage `<sha>.<ext>`.
  - **PDF:** the row is created with `kind 'pdf'`, `status 'pages'` (pages unknown) and `page NULL`.
  - **Image:** one row, `kind 'image'`, `page 1`, `page_w/page_h` = pixels, `status 'ready'`.
  - DXF behaviour is unchanged.
  - New columns (idempotent): `page INTEGER`, `page_w REAL`, `page_h REAL`, `rotation INTEGER`, `parent_id INTEGER`.
- **`POST /api/drawings/:id/pages { pages: [{ page, width, height, rotation }] }`** (admin/qs, draft):
  - Allowed once, for a `pdf` row in status `'pages'`. The browser reports what pdf.js read.
  - Page 1 updates the parent row. Pages 2..n create child rows with `parent_id`, the same sha and name `"<name> — p<n>"`.
  - All rows go to `status 'ready'`.
  - Validation: 1 ≤ n ≤ 2000, positive finite sizes ≤ 14400 pt (200 in), rotation ∈ {0, 90, 180, 270}, pages 1..n each exactly once.
- **`GET /api/drawings/:id/file`:** streams the original bytes with the right Content-Type, `Cache-Control: private, no-cache` and an ETag. For a child page it serves the shared file. Any role that can read the tender.
- **Rev clone and tender delete** include page rows (`parent_id` remapped).

- [ ] **Step 1: Failing pure tests** (`test-takeoff.js`):
  - PNG 640×480 header → `{ png, 640, 480 }`.
  - Progressive JPEG (SOF2) 1200×900 → correct size.
  - Truncated JPEG → throws.
  - 30000 px PNG → throws "too large".
  - Random bytes → throws.
- [ ] **Step 2: Failing API tests:**
  - Upload a tiny valid PDF (build a 2-page PDF string in the test, uncompressed) → `kind pdf`, `status pages`.
  - POST pages for 2 pages (595×842 rot 0, 842×595 rot 90) → 2 rows ready.
  - GET file → bytes equal and the content type is `application/pdf`.
  - Upload a PNG → ready, with the right size.
  - Wrong magic → 400. A second pages call → 409.
  - Viewer can GET file; viewer POST pages → 403.
  - `.mjs` served as `text/javascript`.
  - The vendored files' sha256 match README.md.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `test-takeoff.js`, `test-drawings.js`, `npm test` → PASS.
- [ ] **Step 6: Commit** `feat(takeoff): PDF and image drawings (pages, file endpoint) and vendored pdf.js 4.10.38`.

### Task 3: Calibration (page and regions), verify, re-calibration

**Files:** `lib/takeoff/calib.js`, `modules/drawings.js`; tests in `test-takeoff.js`, `test-drawings.js`.

**Interfaces:**
- **Table** `calibrations(id, drawing_id, region TEXT /*NULL=page, or JSON [x0,y0,x1,y1]*/, p1x, p1y, p2x, p2y, real REAL, unit TEXT, scale REAL /*metres per page unit*/, verify_pct REAL, created, created_by)`. At most one page-level calibration per drawing. Regions must not overlap each other.
- **`scaleOf(p1, p2, real, unit) → number`**
  - `real` is converted to metres with `UNIT_TO_M[unit]`, then divided by the distance between the points.
  - Throws when the distance < 10 or `real` is not finite and > 0.
- **`calibrationFor(cals, point) → cal | null`:** the region whose rect contains the point (inclusive edges), else the page calibration, else null.
- **`verifyPct(cal, p1, p2, real, unit) → number`:** = (measured − real) / real × 100.
- **`POST /api/drawings/:id/calibrations { region?, p1, p2, real, unit }`**
  - Applies to pdf/image only (a DXF → 400).
  - **If no measurement uses the replaced calibration:** create, or replace the page-level one.
  - **If measurements use the replaced calibration:**
    - without `apply: true` → 409 `{ error: 'calibration changes measured quantities', changes: [{ measurement_id, row_id, old_qty, new_qty }] }`;
    - with `apply: true` → update in one tx, recompute those measurements and their take-off rows (existing recompute), audit with counts.
- **`POST /api/drawings/:id/calibrations/:cid/verify { p1, p2, real, unit }`** → stores `verify_pct` and returns `{ pct, warning: |pct| > 1 }`.
- **`DELETE` a calibration:** 409 if measurements use it.

- [ ] **Step 1: Failing pure tests:**
  - p1 (0,0), p2 (100,0), real 5 m → scale 0.05.
  - unit mm: real 5000 → 0.05.
  - Distance 5 → throws.
  - Region lookup: a point inside the region → region; outside → page.
  - Verify: line 200 → measured 10 m vs real 10.2 → pct ≈ −1.96, warning.
- [ ] **Step 2: Failing API tests:**
  - Calibrate page 1 → a manual-free GET shows the calibration.
  - Add a region and check the overlap refusal.
  - Verify returns a warning above 1 %.
  - The re-calibration flow is tested in Task 4, together with manual measurements.
  - DXF → 400. Approved tender → 409.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(takeoff): page and region calibration with verification`.

### Task 4: Manual measurement maths and API

**Files:** `lib/takeoff/manual.js` (UMD), `modules/drawings.js`; tests in `test-takeoff.js`, `test-drawings.js`.

**Interfaces:**
- **`manualQty(geom, opts) → { base, unit, qty, qty_unit, perimeter? }`** (pure, shared with the browser).
  - `geom` is one of:
    - `{ tool: 'line'|'polyline', pts: [[x,y],…] }` (≥ 2 points)
    - `{ tool: 'area', outer: [[x,y]…], holes: [[[x,y]…]…] }` (outer ≥ 3; each hole ≥ 3)
    - `{ tool: 'rect', p1, p2 }`
    - `{ tool: 'count', pts }`
  - `opts = { scale (metres per unit, already region-resolved per first point), width?, depth?, factor = 1, deduct = false, metric?: 'area'|'perimeter' (area tool) }`.
  - Order:
    1. length (or area − Σ hole areas, or perimeter of outer + holes, or count);
    2. × scale (area × scale²);
    3. × width × depth;
    4. × factor;
    5. deduct → negative.
  - Units: as batch 1 (m, m2, m3, nr). Count with width/depth → throws.
- **`validateGeom(geom) → void`, throws with a clear message:**
  - coordinates are finite and ≤ 1e9;
  - no repeated consecutive points;
  - the area outer ring does not self-intersect, including through a vertex and along collinear stretches — use the batch-1 crossing rules (reuse the geometry helpers by exporting them, or a small dedicated implementation with the same tests);
  - each hole lies strictly inside the outer ring, holes do not intersect each other or the outer ring;
  - rect has non-zero size;
  - ≤ 100000 points.
- **`POST /api/drawings/:id/measurements { tool: 'manual', geom, row_id, width?, depth?, factor?, deduct?, metric?, label?, color?, confirm_uom? }`**
  - Works on dxf (units confirmed; scale = `UNIT_TO_M[units]`), pdf and image (calibration for the first point required, else 409 `'calibrate this page first'`).
  - Stores the geometry as JSON (new column `geom TEXT`), the calibration id used (`calibration_id`), `base`, `qty`, `deduct`.
  - Same unit gate and draft/role/audit rules.
  - Overlap: two manual measurements with identical normalised geometry on the same row → 409 `'already measured on this row'` unless `confirm_overlap`.
- **`PUT /api/measurements/:id`** (manual) can change `row_id`, `width`, `depth`, `factor`, `deduct`, `label`. qty is recomputed in the tx; take-off rows are recomputed.
- **Re-calibration flow** (Task 3): `changes` lists these manual measurements with old and new qty.
- **Rev clone** copies manual measurements (with `geom`) and calibrations (`calibration_id` remapped).

- [ ] **Step 1: Failing pure tests:**
  - Polyline (0,0) (30,40) (30,100) at scale 0.1 → length 11 m.
  - Area: 100×100 outer with a 20×20 hole at scale 0.05 → (10000 − 400) × 0.0025 = 24 m².
  - Area metric 'perimeter' → (400 + 80) × 0.05 = 24 m.
  - Width 0.5 on a length → m2. Depth on an area → m3. Factor 2. Deduct → negative.
  - Count with width → throws.
  - Bowtie outer → throws `/self-intersect/`. Vertex-crossing bowtie → throws.
  - A hole outside → throws. A hole crossing the outer → throws.
  - Rect of zero size → throws.
  - Same results through the UMD in a vm context (browser path).
- [ ] **Step 2: Failing API tests:**
  - On a calibrated PDF page: a polyline onto a take-off row `m` → qty matches `manualQty`.
  - Without calibration → 409.
  - On a DXF in mm: polyline of 5000 units → 5 m.
  - An area with a hole onto an `m2` row → 24.
  - A deduct measurement reduces the row. Below 0 → 400 rollback.
  - PUT factor 2 → row updated.
  - Re-calibrate the page (scale × 2) → 409 with changes; `apply` → qty doubled, row updated, audit.
  - Identical geometry twice → 409 overlap.
  - Approved tender → 409. Revise → manual measurements and calibrations copied.
  - Audit has no coordinates.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `test-takeoff.js`, `test-drawings.js`, `test-tenders.js`, `test-workflow.js`, `npm test` → PASS.
- [ ] **Step 6: Commit** `feat(takeoff): manual measurements (length, area with holes, rect, count) on DXF, PDF and images`.

### Task 5: PDF and image viewer

**Files:** `public/viewer/raster.js`, `public/app.js`, `public/index.html`; tests in `test-ui.js`.

**Interfaces:**
- **`TVRaster.create(container, { kind: 'pdf'|'image', url, page, pageW, pageH, rotation }) → engine`**
  - Same view transform as `core.js`, with page units and y down for images.
  - **PDF coordinates:** page units are PDF user space, y up, in points. Points are stored unrotated, so rotation never changes a length.
  - **Rendering:**
    - pdf.js renders the page at a resolution matching the current zoom (clamped to a 16 MP canvas), debounced 150 ms after zoom.
    - The canvas transform is applied in between, so zoom stays instant.
    - The pdf.js worker is `/vendor/pdfjs/pdf.worker.min.mjs`.
    - Images are drawn with `drawImage`.
  - Wheel zoom at the cursor, pan, fit, `destroy()`, a `__tvLastFrameMs` hook and `toPage(sx, sy)`/`toScreen(px, py)`.
- **Drawings tab:** "Open viewer" on pdf/image drawings opens `TVRaster`. The PDF row in status `'pages'` shows "reading pages…": the browser loads it with pdf.js, POSTs pages, then refreshes.

- [ ] **Step 1: Failing UI tests:**
  - Upload the 2-page test PDF → it becomes 2 rows (pages registered by the browser).
  - Open page 2 (rotated 90) → the canvas renders: the pixel at a known filled rectangle is non-background.
  - Upload a PNG → open → a rendered pixel matches the image.
  - Wheel zoom keeps the page point under the cursor (`toPage` before = after, within 1e-6).
  - No console errors.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test-ui.js`, `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(ui): PDF and image viewer (vendored pdf.js)`.

### Task 6: Measuring and calibration tools (PDF, images and DXF)

**Files:** `public/viewer/tools.js`, `public/app.js`, `public/i18n.js`, `public/style.css`; tests in `test-ui.js`.

**Interfaces:**
- **Toolbar** in both viewers (DXF canvas and raster): Line, Polyline, Area, Hole (while an area is open), Rect, Count, Calibrate, Verify (raster only), Region (raster only), Undo point, Finish (Enter/double-click), Cancel (Esc).
- **Live value while drawing:** `manualQty` with the resolved scale, labelled preview. "—" until calibrated/units confirmed, with the reason.
- **DXF:** snap on (TV.snap true vertices).
- **Raster:** no snap. Shift constrains to horizontal/vertical.
- **Finish** opens the link form, reusing the batch 1/2 form: row picker, width/depth/factor (strictNum), deduct, label, confirm boxes. The boxes reset on any change, and the generation guard covers an in-flight save. Saves `tool: 'manual'`.
- **Saved manual measurements:**
  - drawn as overlays in their colour, with their label and qty;
  - the list shows formula and inputs: "length 110.00 units × 0.1 m/unit = 11.00 m" (§5.6) and which calibration was used (page or region, verify %);
  - edit (label/width/depth/factor/deduct/row) and delete.
- **Calibrate:**
  - Click two points and enter the length and unit.
  - If measurements depend on the calibration, the 409 shows a before/after table with an "Apply" button.
  - The current scale is always visible ("1 unit = x m").
  - Verify shows the % with a warning colour above 1 %.
- **Region:** drag a rectangle, then calibrate inside it.

- [ ] **Step 1: Failing UI tests:**
  1. **PDF page:**
     1. Measuring before calibrating shows "—" and "calibrate first".
     2. Calibrate two points 100 page units apart = 5 m.
     3. Draw a polyline of 3 points (computed via `toScreen`) → the preview matches `manualQty`.
     4. Finish, link to a take-off row `m` → the row qty equals the server qty.
     5. The list shows the formula and "page calibration".
  2. **Area with hole:** draw → link to an `m2` row → 24.
  3. **Undo point:** removes the last point, and the preview updates.
  4. **Esc** cancels.
  5. **Verify** off by 2 % → warning colour.
  6. **Re-calibrate** with measurements → the before/after table shows → Apply → row qty changes.
  7. **DXF:** the polyline tool snaps to a true vertex (the marker shows), and the saved length equals the exact distance.
  8. **Read-only on an approved tender:** tools are hidden and preview still works.
  9. No console errors.
  10. Screenshot `measure.png` in the scratchpad.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test-ui.js`, `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(ui): manual measuring and calibration tools`.
