# Take-off Batch 4: drawing replacement with before/after, unit change, reports

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a revised drawing (DXF, PDF or image) can replace the current one. Before anything changes, the program shows a before/after table of every linked quantity. The user resolves the measurements that no longer match, then accepts, and only then do quantities change. The same before/after mechanism lets the user change a DXF's confirmed units after measuring. Take-off reports are available as Excel (measurements per row) and as a PNG of the drawing with coloured, numbered measurements.

**Architecture:**
- A replacement upload creates a **pending** drawing row: `replaces_id = old.id`, `status` unchanged for parsing, and `pending = 1`.
- **Pending rows:**
  - They are not listed as normal drawings and cannot be measured on.
  - They are only compared, accepted or cancelled.
- **The compare engine** (`lib/takeoff/compare.js`, pure, plus the existing DXF worker for selection totals) computes each measurement's new quantity on the pending drawing, and its status:
  - `same`
  - `changed`
  - `review`, which carries a reason (`layer_missing`, `block_missing`, `handles_missing`, `geometry_changed`, `manual_check`)
  - `blocked`, when the quantity cannot be computed
- **Accept** is one transaction, guarded by `expect` (the R18 pattern from batch 3):
  - It moves measurements and calibrations to the new row, applies the new quantities and resolutions, and recomputes rows. This includes the imported-row negative check.
  - It sets `old.replaced_by` and audits.
  - **Cancel** deletes the pending row.
- **Unit change** after measuring uses the same pattern: preview, then apply with `expect`.
- **Reports:**
  - **Excel:** built on the server with `lib/xlsx.js writeXlsx`.
  - **PNG:** built in the browser from the viewer canvas, plus overlays, as `canvas.toBlob`. There are no new dependencies.

**Tech Stack:** Node ≥ 22.5, no dependencies (vendored pdf.js only). Plain browser JS.

**Spec:** `docs/superpowers/specs/2026-11-14-takeoff-design.md` §5.5, §5.6, and §6 decisions 5 and 6.

## Global Constraints

- **No quantity changes before explicit acceptance.**
  - Replacement accept and unit-change apply require `expect: [{ measurement_id, new_qty, resolution? }]` equal to the server's fresh recomputation inside the transaction. The id set must match exactly, and qty must match within 1e-9 relative. Otherwise the server returns 409 with the fresh table.
  - Missing `expect` → 400.
- **Blocking review (spec §6.5).** A `dxf_layer`/`dxf_blocks` measurement whose layer or block disappeared, or a `dxf_selection` whose handles or geometry no longer match, blocks acceptance until one of these resolutions is sent for it:
  - `delete`;
  - `relink` with a new layer/block name present in the new drawing (layer and block measurements only);
  - `keep_matched`, for selection measurements only: qty is taken from the handles still present with an identical geomKey.
- **Manual measurements:**
  - They are carried over unchanged: same geometry, in the new drawing's units/calibration.
  - They are flagged `review_needed = 1`, which is non-blocking. The user clears the flag with "mark reviewed".
  - For DXF their quantity is unchanged unless the units differ (unit rules below).
  - For PDF/image: page n maps to page n of the new file. The old page's calibrations are copied to the new page and flagged for review. A page that no longer exists → blocking, resolution `delete`.
- **Units:**
  - A replacement DXF needs confirmed units before comparing. They are pre-filled from the old drawing's units, and the user must confirm them.
  - Changing units on a measured drawing goes only through preview/apply (§6.6). The existing refusal is replaced by that flow.
- **Draft only.** Admin/qs write; everyone reads compare, reports and file.
- **Audit:** in the same transaction, summary only (counts and totals, never coordinates).
- **Imported (client BOQ) rows:**
  - The client quantity is never changed.
  - The existing negative-measured refusal applies at accept.
- **Rev clone and tender delete** handle pending rows and `replaced_by`/`replaces_id` chains. A pending row is not copied into a Rev; only accepted history is.
- Arabic + English for every string. Text only via `h()`/`textContent`.
- Commits end with the session trailer. Branch `claude/friendly-hopper-5afh4q`. The controller pushes and merges.

## Review Focus

1. **Silent change.** No path may change a saved quantity without an accept or apply that carries a matching `expect`. → Tasks 1, 3
2. **Handle matching.** A handle reused for different geometry must not keep its old quantity. Matching is by handle **and** geomKey. → Task 2
3. **Concurrency.** A measurement added or edited on the old drawing while a replacement is pending must appear in the fresh 409 table. Either refuse measuring on a drawing with a pending replacement (409 "a replacement is pending") or include it. Pick one rule and test it. → Tasks 2, 3
4. **Report numbers equal the screen.**
   - Excel quantities come from the stored quantities and the same row totals as the tender screen.
   - The PNG numbers match the list.
   - Draft tenders are labelled "مسودة — غير معتمدة" / "Draft — not approved". → Tasks 5, 6
5. **Imported-row and below-zero rules** hold through accept and unit apply. → Tasks 1, 3

## File Structure

```
lib/takeoff/compare.js          pure: per-measurement status and new qty from old/new summaries, handles and geomKeys
modules/drawings.js             (modify) replace upload, pending rows, compare, accept/cancel, mark-reviewed, unit change preview/apply, reports.xlsx
lib/dxf/select.js / select-worker.js  (modify only if needed) selection totals restricted to a handle subset on another drawing's cache
public/app.js, i18n.js, style.css     (modify) replace flow, compare table, resolutions, accept, units change, reports buttons, PNG export
public/viewer/raster.js               (modify) optional second (previous) page layer with opacity, for PDF/image comparison
test-takeoff.js, test-drawings.js, test-ui.js, test-backup.js (if file storage changes)
```

---

### Task 1: Carry-overs and the unit change with before/after

**Files:** `modules/drawings.js`, `public/app.js`, `public/i18n.js`, plus tests.

**Interfaces:**
- **Carry-overs:**
  1. On the first calibration 409 table, call `await c.refreshList()` before `changesTable(...)`, so another user's new measurement shows its label.
  2. A raster click that drags more than 3 px with a non-rect tool shows a short status hint ("point not added: the mouse moved; click without dragging", AR/EN) instead of dropping the point silently.
- **`PUT /api/drawings/:id/units { units }`** on a DXF that already has measurements:
  - Without `apply` → 409 `{ error: 'unit change changes measured quantities', changes: [{ measurement_id, row_id, old_qty, new_qty }] }`. The list covers every non-count measurement on the drawing: layer, blocks (counts excluded), selection, and manual non-count. new_qty is recomputed with the new unit factor through the same functions that created the quantity.
  - With `apply: true, expect` → the R18 rules. One transaction: update units, measurements (qty/base) and rows (recompute, imported negative check), plus the audit.
  - A drawing with no measurements keeps today's behaviour.
- **UI:** a units dropdown on a measured drawing → before/after table → Apply (with expect). A fresh 409 redraws the table.

- [ ] **Step 1: Failing tests.**
  1. mm → m on a drawing with a layer-length measurement of 5000 mm (5 m) and a manual polyline → the 409 lists both with new qty ×1000.
  2. Apply with expect → rows updated.
  3. Apply without expect → 400.
  4. A measurement added in between → 409 fresh.
  5. Counts are not listed.
  6. Imported row below 0 is impossible here (units scale positive), but still assert that the row recompute runs.
  7. UI:
     1. change units → table → Apply → row qty changes;
     2. first-409 table shows the label;
     3. a drag-click shows the hint.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (`SKIP_PDF=1 npm test`).
- [ ] **Step 5: Commit** `feat(takeoff): change DXF units after measuring via before/after; batch-3 carry-overs`.

### Task 2: Replacement upload and the compare engine

**Files:** `lib/takeoff/compare.js`, `modules/drawings.js`, (if needed) `lib/dxf/select.js`, tests in `test-takeoff.js`, `test-drawings.js`.

**Interfaces:**
- **Columns (addCol, idempotent):** `drawings.pending INTEGER DEFAULT 0`, `drawings.replaces_id INTEGER`.
- **`POST /api/drawings/:id/replace?name=…`** (admin/qs, draft) uploads the new file through the existing upload path.
  - **Kind:** must match (dxf→dxf; pdf/image→pdf or image; a PDF replaces a PDF page set).
  - **New row:** `pending = 1`, `replaces_id = id`, `rev = old.rev + 1`.
  - **Only one pending replacement per drawing** (409 otherwise).
  - For a PDF, the pending parent row registers its pages like a normal PDF, and the page children inherit `pending`/`replaces_id` mapping by page number.
- **Pending rows:**
  - excluded from `GET /api/tenders/:id/drawings` as normal rows; listed under their old row as `pending_replacement`;
  - every measuring/calibrating route on a pending row → 409.
- **Rule for Review Focus 3:** while a replacement is pending, measuring routes on the OLD drawing (create, edit or delete of a measurement, calibrate) → 409 "a replacement is pending: accept or cancel it first". Test it.
- **`GET /api/drawings/:newId/compare`** → `{ ready: bool, needs_units: bool, items: [{ measurement_id, row_id, tool, label, old_qty, new_qty|null, qty_unit, status: 'same'|'changed'|'review'|'blocked', reason?, options: ['delete'|'relink'|'keep_matched'|'mark_reviewed'], relink_choices?: [...] }], totals: { rows: [{ row_id, old, new }] } }`.
  - **DXF:** waits for the parse (`ready: false` while parsing); needs confirmed units (`needs_units`).
  - **`dxf_layer`:** the same metric on the same layer name in the new summary. If the layer is missing → blocked `layer_missing`, with relink_choices = new layers that have that metric > 0.
  - **`dxf_blocks`:** the same block name (and nested flag). If missing → blocked `block_missing`.
  - **`dxf_selection`:** for each stored handle, its geomKey in the new cache.
    - All present with an equal geomKey → recompute the total on the new cache (worker) → same/changed.
    - Otherwise → blocked `handles_missing`/`geometry_changed`, with `keep_matched_qty` computed from the subset that still matches.
  - **Manual (DXF):** qty recomputed with the new units → `review` `manual_check` (non-blocking).
  - **Manual (PDF/image):** the page exists → `review` `manual_check`; qty is computed with the copied calibration of the same page (same scale unless the user re-calibrates after accept). A missing page → blocked `page_missing`.
- **`lib/takeoff/compare.js`:** pure decision functions (status, reason, options, totals per row) with unit tests on hand-built summaries.
- **Store the selection geomKey** when a selection measurement is created, if it is not already stored (`measurement_handles.geom_key`). Earlier rows without it → blocked `geometry_changed` unless the handle's geomKey is recomputable from the old cache. Document what you did.

- [ ] **Step 1: Failing pure tests** (compare.js):
  - same layer and metric → `same`;
  - layer renamed → blocked, with relink choices;
  - block count changed → `changed`;
  - selection with one handle reused for different geometry → blocked `geometry_changed`, `keep_matched_qty` = the rest;
  - manual → `review`;
  - row totals summed per row.
- [ ] **Step 2: Failing API tests:**
  - upload DXF v1, measure a layer, a block count, a selection and a manual polyline;
  - replace with v2 (one layer renamed, one extra block, one selection entity moved);
  - compare lists the 4 expected statuses and numbers;
  - only one pending allowed;
  - measuring on the old drawing → 409;
  - a pending row is not in the normal list;
  - viewer → 403 on replace, 200 on compare;
  - approved tender → 409;
  - PDF v1 2 pages → v2 1 page: page 2 measurement blocked `page_missing`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(takeoff): drawing replacement upload and before/after comparison`.

### Task 3: Accept and cancel a replacement

**Files:** `modules/drawings.js`, tests in `test-drawings.js`, `test-tenders.js`.

**Interfaces:**
- **`POST /api/drawings/:newId/accept { expect: [{ measurement_id, new_qty, resolution? }], relink?: { [measurement_id]: name } }`** (admin/qs, draft):
  - Recompute compare inside the transaction. Every blocked item needs a resolution. The `expect` set and qtys must match the fresh result (R18). Otherwise → 409 with the fresh compare.
  - **In one transaction:**
    1. Move every kept measurement to the new drawing id (and the matching page row for PDFs).
    2. Apply the new qty/base:
       - `relink` sets the new layer/block and its qty;
       - `keep_matched` rewrites the handles to the matched subset;
       - `delete` removes the measurement.
    3. Set `review_needed = 1` on manual measurements.
    4. Copy calibrations to the new page rows, remapping `calibration_id`.
    5. Recompute every affected row (the imported negative check included).
    6. Set `old.replaced_by = new.id` and `new.pending = 0`.
    7. Audit: `{ replaced: old, by: new, kept, deleted, relinked, changed_rows }`.
  - The old drawing stays as history: read-only, listed under "previous versions", with its file served.
- **`DELETE /api/drawings/:newId`** while pending = cancel: removes the pending rows only. Files stay while referenced, the existing release rule.
- **`POST /api/measurements/:id/reviewed`** clears `review_needed` (admin/qs, draft).
- **Rev clone:** copies the accepted chain (`replaced_by` remapped) and skips pending rows.
- **Tender delete:** removes everything.

- [ ] **Step 1: Failing tests:**
  - accept without resolutions for blocked items → 400 naming them;
  - with resolutions and expect → quantities and rows match the compare;
  - accept with a stale expect → 409, nothing changed;
  - an imported row going negative at accept → 400, rollback;
  - cancel → old drawing measurable again;
  - mark reviewed;
  - Rev after accept copies history; Rev while pending skips the pending row;
  - the audit has counts only.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test-drawings.js`, `test-tenders.js`, `test-workflow.js`, `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(takeoff): accept or cancel a drawing replacement (guarded by the reviewed table)`.

### Task 4: Replacement UI and visual comparison

**Files:** `public/app.js`, `public/i18n.js`, `public/style.css`, `public/viewer/raster.js`, `public/viewer/canvas.js` (if needed); tests in `test-ui.js`.

**Interfaces:**
- **Drawings tab, per drawing:** "Upload revised version", available to admin/qs on drafts.
- **Pending state:**
  - progress (parsing) → units confirmation (DXF, pre-filled) → before/after table: old qty, new qty, difference, status with a translated reason, and a resolution control per blocked item (delete / relink dropdown / keep matched with its qty).
  - Row totals before and after.
  - "Accept revision" is disabled until every blocked item has a resolution. It posts with expect. A 409 redraws the fresh table with the label refreshed. "Cancel revision".
- **Visual comparison:**
  - **PDF/image:** the raster viewer shows the new page with the old page underneath, with an opacity slider ("show previous version").
  - **DXF:** the old and new drawings are drawn in two colours (old in grey, new in normal colours), with a toggle.
- **After accept:**
  - Manual measurements show a "check" badge and a "mark reviewed" button.
  - "Previous versions" lists old revisions read-only.
- **Read-only (approved):** the table can be viewed; no actions.

- [ ] **Step 1: Failing UI tests:**
  1. DXF:
     1. upload v1 and measure (layer + selection);
     2. upload v2 → table shows a blocked item → resolve with relink → Accept → the take-off row qty equals the new value;
     3. Previous versions lists v1.
  2. PDF: v2 opens with the opacity slider; the pixel blend changes with the slider.
  3. A stale accept → refreshed table.
  4. Manual measurement badge → mark reviewed.
  5. No console errors.
  6. Screenshot `revision.png`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ui): drawing revision flow with before/after table and visual comparison`.

### Task 5: Excel take-off report

**Files:** `modules/drawings.js` (or `modules/tenders.js` if the export lives there), `lib/xlsx.js` (use as-is), `public/app.js`, `public/i18n.js`; tests in `test-drawings.js`, `test-xlsx.js`.

**Interfaces:**
- **`GET /api/tenders/:id/takeoff.xlsx?lang=ar|en`** (all roles).
- **Sheet 1 "Measurements":**
  - drawing (name, rev, page);
  - measurement label;
  - tool/metric;
  - linked row (code + description);
  - formula text (the same text as the list in the UI, built by one shared function);
  - qty, unit, deduct, calibration/units used;
  - review flag;
  - created by/at.
- **Sheet 2 "Rows":** take-off rows with their qty from measurements and from lines, the total, and unit. For imported rows: the client qty, our measured qty and the difference %.
- **Sheet 3 "Drawings":** name, kind, rev, units/scale, sha256 (short), uploaded by/at, and replaced by.
- **Header:** the tender name/number and generation date. Drafts are labelled "مسودة — غير معتمدة" / "Draft — not approved".
- **Numbers** are written as numbers, not text.
- **Arabic sheets** set right-to-left if `writeXlsx` supports it. Otherwise add minimal support in `lib/xlsx.js` with a test.
- **Data rules:** no personal data beyond the user names already in the audit. Values come from stored quantities only.

- [ ] **Step 1: Failing tests:**
  - read the generated file back with `readXlsx`;
  - row totals equal the tender API's take-off row quantities;
  - the formula text equals the measurement list's;
  - draft label present;
  - viewer can download;
  - AR headers when `lang=ar`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(takeoff): Excel take-off report`.

### Task 6: PNG drawing export with measurements

**Files:** `public/app.js`, `public/viewer/canvas.js`, `public/viewer/raster.js`, `public/i18n.js`; tests in `test-ui.js`.

**Interfaces:**
- **"Export image" in both viewers:** renders the current view (or "whole sheet", the default) offscreen, then saves it as `<tender>-<drawing>-rev<n>.png`.
  - **Resolution:** up to 8000 px on the long side, clamped by the browser canvas limits.
  - **Contents:**
    - the drawing;
    - every saved measurement overlay in its colour, with a number badge (1..n in list order);
    - a legend box listing number, label, qty, unit and row;
    - the scale line;
    - tender name and date;
    - the draft label on drafts.
- **Measurement list:** shows the same numbers.
- **Approved tenders:** the export is allowed. It is read-only.

- [ ] **Step 1: Failing UI tests:**
  - export a PDF page with 2 measurements → the downloaded PNG decodes (read its width and height in the test);
  - a pixel at a known overlay position has the overlay colour;
  - the legend text exists. Check the legend through a hook that returns the legend entries used for drawing, equal to the list.
  - same for DXF.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ui): export drawing with numbered measurements as PNG`.
