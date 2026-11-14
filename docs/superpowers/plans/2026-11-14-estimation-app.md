# Trigon Estimation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone estimating / QS web app for the office PC. It reads Trigon ERP's real costs from `erp.db` (read-only) and prices client BOQs into three numbers: true cost, floor price and proposed price.

**Architecture:** A zero-dependency Node HTTP server (same style as the ERP: `server.js` + `modules/*.js` + `public/`) with its own `data/estimation.db`. Pure calculation libraries in `lib/` (cost snapshot, unit cost, cash flow, tender pricing, xlsx) are unit-tested without the server. API modules wrap them. A plain-JS bilingual UI sits on top. An hourly sync opens the ERP database with `readOnly: true`, reads inside one short transaction, closes it, and stores an aggregated, dated cost snapshot.

**Tech Stack:** Node.js ≥ 22.5 (`node:http`, `node:sqlite`, `node:zlib`, `node:crypto`), plain HTML/CSS/JS. No npm dependencies at all.

**Spec:** `docs/superpowers/specs/2026-11-14-estimation-design.md` (Arabic). Read it first. Section numbers below (§5.3 etc.) refer to it.

## Global Constraints

- Node ≥ 22.5; `"engines": { "node": ">=22.5" }`. **No dependencies or devDependencies** in `package.json`.
- Own database `DATA_DIR/estimation.db` (`DATA_DIR` env, default `./data`, git-ignored). WAL mode.
- The ERP database is opened **only** through `lib/erpsync.js`, **only** with `new DatabaseSync(path, { readOnly: true })`, inside one `BEGIN … COMMIT`, and closed in `finally`. No other file may open it.
- No personal data leaves the sync: snapshots store per-trade aggregates (rate, headcount), never employee names, IDs, or individual salaries.
- Money: AED; `round2 = x => Math.round((x + Number.EPSILON) * 100) / 100`. Round only at display/unit-rate/export boundaries, never inside iterations. All costs exclude VAT (bills: `amount` only; PO lines: `rate`).
- Never treat a missing value as zero. A missing ERP column stops the sync with the column's name. A computed rate that is 0, negative or missing is a warning, and the item using it cannot be approved.
- No government fees, RTA fees or productivity figures hard-coded as facts. Seeded templates carry names only, no amounts.
- Port default `3100` (`PORT` env). `HOST` env, default `127.0.0.1`. `Estimation-Start.bat` sets `HOST=0.0.0.0` so the QS can reach it over the office LAN.
- Every user-visible string exists in Arabic and English (`public/i18n.js`). Arabic is RTL.
- Roles: `admin`, `qs`, `viewer`. Passwords use `crypto.scryptSync(pw, salt, 32)`. Session cookie `sid` is `HttpOnly; SameSite=Strict`.
- Tests: each `test-*.js` starts the real server on a temp `DATA_DIR` (pattern of the ERP's `test-claims.js`), or tests a pure lib directly. `npm test` runs them all. Fake data only (e.g. "Test Mason A", "Fake Supplier LLC").
- Commits end with the attribution lines from the session; work on branch `claude/friendly-hopper-5afh4q`; never push to `main`.

## Review Focus

1. **ERP file locked, moved, or mid-write** (wrong path, ERP restarting, file absent): sync fails cleanly, the last snapshot stays in use, and a red banner shows the last good sync time. Never a crash, never a half-written snapshot. → test in Task 3.
2. **Messy client BOQ xlsx** (merged header rows, shared strings, numbers stored as text with commas, empty rows, a second sheet, inline strings): rows keep their order, quantities parse (`"1,250.50"` → 1250.5), and rows without a quantity are kept as headings. → test in Task 2.
3. **A tender priced on an old snapshot, then approved later**: approval is blocked when the tender's snapshot is older than 7 days unless the admin passes `override_stale: true` (recorded in the audit log). A newer sync never silently changes an open tender. → test in Task 9.
4. **Small trades leak salaries**: a trade with fewer than 3 people never shows its own rate or headcount to `qs`/`viewer`, only its group's. This holds in every API response, including the tender cost breakdown and the internal export. → tests in Tasks 4 and 10.
5. **Zero/odd inputs to pricing** (D = 0, M = 0, margin ≥ 100 %, collection days 0, no active ERP projects so W = 0, pricing that doesn't converge): clear 400 errors or defined results, never `NaN`/`Infinity` in a response. → tests in Tasks 6 and 7.

## File Structure

```
package.json, .gitignore, README.md
Estimation-Start.bat, Estimation-Autostart.bat
server.js                 HTTP server, own DB + schema, auth/sessions/users, audit, router, sync scheduler
lib/money.js              round2, num (parse "1,250.50")
lib/xlsx.js               readXlsx(buf) / writeXlsx(sheets) via zlib (zip + XML)
lib/erpsync.js            readErp(erpPath, opts) → raw aggregates (only file that touches erp.db)
lib/costs.js              buildSnapshot(raw, cfg) → cost snapshot; viewSnapshot(snap, role)
lib/unitcost.js           unitCost(version, snapshot, cfg) → { unit, parts, missing }
lib/cashflow.js           financingCost(opts) → { F, schedule }
lib/pricing.js            priceTender(input) → result (fixed-point on V)
modules/costs.js          /api/costs/*   sync, snapshots, mappings, overrides, manual material prices
modules/library.js        /api/library/* sections, items, versions
modules/tenders.js        /api/tenders/* rows, import, take-off, links, hidden items, price, workflow, export
public/index.html, app.js, i18n.js, style.css
test/fixtures/make-erp.js fake ERP db (ERP's real CREATE statements for the tables read)
test-xlsx.js test-erpsync.js test-costs.js test-unitcost.js test-cashflow.js test-pricing.js
test-auth.js test-sync.js test-library.js test-tenders.js test-workflow.js test-ui.js
```

---

### Task 1: Server skeleton, schema, auth, users, audit

**Files:**
- Create: `package.json`, `.gitignore`, `server.js`, `lib/money.js`, `test-auth.js`

**Interfaces:**
- Produces: `module.exports = { server, db, ctx }` from `server.js`.
  - `ctx = { db, send(res, code, body, headers?), bad(msg) /* throws 400 */, readBody(req) → object, audit(user, action, entity, id, detail), getSettings() → object, setSetting(key, value), round2, num }`.
  - Module contract: `modules/x.js` exports `ctx => ({ handle(req, res, url, parts, me) → boolean })`, with `parts = url.pathname.split('/').slice(2)` (after `/api`) and `me = { id, username, role }`.
  - Role check helper `ctx.need(me, ...roles)` throws 403.
- `lib/money.js`: `round2(x) → number`, `num(v) → number | null`. `num` strips commas and spaces, and returns `null` for empty or non-numeric input.
- Tables created here: `users(id, username UNIQUE, pw, salt, role, created)`, `sessions(token PK, user_id, created)`, `settings(key PK, value)`, `audit_log(id, at, user, action, entity, entity_id, detail)`.
- Endpoints: `GET /api/status` → `{ setup: bool, user }`, `POST /api/setup` (first admin only), `POST /api/login`, `POST /api/logout`, `GET/POST /api/users` (admin), `GET/PUT /api/settings` (read: all; write: admin), `GET /api/audit` (admin).

**Settings defaults** (`getSettings()`):

```js
{ erp_db_path: '..\\Trigon-ERP\\data\\erp.db', work_days: 26, work_hours: 8, finance_rate_pct: 8, min_profit_pct: 5, default_margin_pct: 12, stale_days: 7, material_stale_days: 60, sync_minutes: 60 }
```

- [ ] **Step 1: Write the failing test `test-auth.js`**
  - setup creates admin → 200, second setup → 403
  - login wrong password → 401
  - admin creates `qs1` (role `qs`) → 200
  - `qs1` `PUT /api/settings` → 403, `GET /api/settings` → 200 with `work_days === 26`
  - `GET /api/audit` as qs → 403, and as admin it contains an entry with `action === 'create'` and `entity === 'users'`
  - unauthenticated `GET /api/settings` → 401
  - `num('1,250.50') === 1250.5`, `num('') === null`, `num('abc') === null`, `round2(1.005) === 1.01`
- [ ] **Step 2: Run `node --no-warnings test-auth.js`**. Expected: fails (`Cannot find module './server.js'`).
- [ ] **Step 3: Implement `server.js` and `lib/money.js`.**
  - Follow the ERP's `server.js` patterns: `readBody` limit 20 MB (BOQ uploads arrive as base64), static files from `public/`, and `server.listen(PORT, HOST)` only when `require.main === module`.
  - Lock out login for 15 min after 5 failures per username.
  - `package.json` scripts: `"start": "node --no-warnings server.js"` and `"test"` chaining every `test-*.js`.
  - `.gitignore`: `data/`.
- [ ] **Step 4: Run `node --no-warnings test-auth.js`**. Expected: `auth ok` printed, exit 0.
- [ ] **Step 5: Commit** `feat: server skeleton, auth, users, settings, audit`.

### Task 2: xlsx reader/writer

**Files:**
- Create: `lib/xlsx.js`, `test-xlsx.js`, `test/fixtures/boq-sample.xlsx` (generated by the test itself via `writeXlsx`, then hand-patched XML strings for shared strings/inline strings; see test).

**Interfaces:**
- `readXlsx(buf: Buffer) → { sheets: [{ name: string, rows: (string|number|null)[][] }] }`
  - Parses the ZIP central directory. Supports methods 0 (stored) and 8 (`zlib.inflateRawSync`).
  - Reads `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml` (incl. rich-text `<r><t>`), and the sheets.
  - Cell types: `s`, `str`, `inlineStr`, `n`, `b`. Cell refs like `C12` decide the column, so gaps stay `null`. Rows keep their sheet row index (empty rows → `[]`).
- `writeXlsx(sheets: [{ name, rows, colWidths?: number[] }]) → Buffer`
  - Minimal valid workbook: inline strings, numbers as `n`, `zlib.deflateRawSync`, CRC via `zlib.crc32`.
  - Opens in Excel. Verify once manually or with LibreOffice if available. The test round-trips through `readXlsx`.

- [ ] **Step 1: Write failing `test-xlsx.js`**
  - Round trip: `readXlsx(writeXlsx([{name:'BOQ', rows:[['No','Description','Unit','Qty'],['1','Kerb laying','m',1250.5],[],['', 'SECTION B', null, null]]}]))`. The result `.sheets[0].rows` deep-equals the input (the empty row → `[]`).
  - A hand-built zip whose sheet uses a shared string `"Interlock, 80mm"`, an inline string, a gap (`A5` then `D5`), and a stored (method 0) entry → expected rows.
  - Two sheets → both names returned in order.
  - Arabic text round-trips unchanged.
- [ ] **Step 2: Run it**. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `lib/xlsx.js`.** Use a small regex-based XML scan, which is enough for SpreadsheetML. Decode `&amp; &lt; &gt; &quot; &apos; &#NN;`.
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat: dependency-free xlsx read/write`.

### Task 3: ERP read-only sync reader

**Files:**
- Create: `lib/erpsync.js`, `test/fixtures/make-erp.js`, `test-erpsync.js`

**Interfaces:**
- `makeErp(file: string, data?: object) → void` (fixture)
  - Creates the db in WAL mode, using the ERP's real column lists for:
    - `employees(id, name, designation, project_id, status)`
    - `payroll(id, month, employee_id, project_id, gross, overtime, status)`
    - `payroll_alloc(payroll_id, project_id, amount)`
    - `eos_provisions(month, employee_id, amount)`
    - `bills(id, date, project_id, category, amount, vat_amount)`
    - `purchase_orders(id, date, status, items)`
    - `fixed_assets(id, name, category, cost, salvage, life_years, status, project_id)`
    - `equipment_logs(asset_id, date, hours, cost)`
    - `hire_items(id, name, type, basis, rate, base_hours, status)`
    - `projects(id, contract_value, start_date, end_date, status)`
  - Copy these CREATE statements from the ERP repo (`server.js:27-36`, `modules/payroll2.js`, `modules/procurement.js`, `modules/assets.js`, `modules/siteops.js`, `modules/hired.js`), trimmed to the columns used plus at least one unused column each.
  - Inserts `data` rows.
- `readErp(erpPath: string, { now: Date }) → raw`, where:

```js
raw = {
  read_at,                                     // ISO
  payroll: [{ month, employee_key, designation, gross, overtime, project_share }],
           // final only, last 12 months; employee_key = opaque per-sync index, not the ERP id
  eos: [{ month, employee_key, amount }],
  bills: [{ date, category, amount, has_project }],   // last 12 months
  categories: [string],                        // distinct bill categories ever
  designations: [string],                      // distinct non-empty employee designations
  po_lines: [{ date, description, unit, rate }],      // POs with status NOT IN ('draft','cancelled'), last 24 months
  assets: [{ key, name, category, cost, salvage, life_years, has_project, log_hours_12m, log_cost_12m, ever_logged }],
  hires: [{ key, name, type, basis, rate, base_hours }],  // status 'active'
  projects: [{ contract_value, start_date, end_date }],   // status 'active'
  earliest_bill: 'YYYY-MM-DD' | null
}
```

- `project_share` = fraction (0..1) of that payroll row's gross that is project-assigned (§7 rule 4):
  - if `payroll_alloc` rows exist → Σalloc.amount / gross (cap 1)
  - else 1 if `payroll.project_id`
  - else 1 if `employees.project_id`
  - else 0
- Required-column check: before reading, run `PRAGMA table_info` for each table. Any missing table/column → throw `ErpSchemaError` with `message = 'ERP column missing: payroll.overtime'`.
- No names leave this function. Asset/hire `name` is equipment, not a person, and is allowed.

- [ ] **Step 1: Write failing `test-erpsync.js`**
  - Fixture with 1 `draft` and 2 `final` payroll months. `raw.payroll` has only `final` rows, and no key named `name` or `employee_id` appears anywhere in `JSON.stringify(raw)`. Also assert the fake name `"Test Mason A"` is absent.
  - `project_share` is 0.5 when alloc 1500 of gross 3000; 1 with `payroll.project_id`; 0 when nothing is set.
  - A PO with status `cancelled` is excluded.
  - Drop `overtime` from the fixture's `payroll` → throws `/ERP column missing: payroll.overtime/`.
  - Nonexistent path → throws (no file created at that path afterwards: `fs.existsSync === false`).
  - **WAL safety:** open a writer connection on the fixture, call `readErp`, insert a row with the writer during/after; the insert succeeds. After `readErp` returns, the file can be renamed/deleted on all platforms, which shows the handle was closed.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `lib/erpsync.js`** with `readOnly: true`, `BEGIN`/`COMMIT`, and `close()` in `finally`. Date windows use `opts.now`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: read-only ERP reader with schema check`.

### Task 4: Cost snapshot builder

**Files:**
- Create: `lib/costs.js`, `test-costs.js`

**Interfaces:**
- Consumes: `raw` from Task 3.
- `buildSnapshot(raw, cfg) → snap`

```js
cfg = { work_days, work_hours, category_map: { [erpCategory]: 'overhead'|'labour_oncost'|'equipment'|'project'|'ignore' },
        trade_map: { [designation]: tradeName }, trade_groups: { [tradeName]: groupName },
        overrides: { 'trade:Mason': 18, 'equip:asset:3': 95, ... } }
snap = { oh_monthly, oh_parts: { bills, payroll, depreciation }, months_covered,
         w_monthly,                      // current work per month from active projects
         trades: [{ trade, group, rate, headcount, overridden }],
         groups: [{ group, rate, headcount }],
         equipment: [{ id: 'asset:<key>'|'hire:<key>', name, rate, source: 'owned'|'hired', overridden }],
         po_prices: [{ description, unit, date, rate }],   // passed through for Task 5 material resolution
         unmapped: { categories: [], designations: [] }, warnings: [{ code, detail }] }
```

**Rules** (spec §5.3, §7):
- **Window:** the 12 full calendar months before `raw.read_at`.
- `months_covered = clamp(months from earliest_bill to window end, 1, 12)`. If < 12 → warning `short_history`.
- **OH_m** = (overhead-mapped bills with `has_project === false` + Σ payroll `gross × (1 − project_share)` in window + monthly depreciation × months_covered of assets with `has_project === false && ever_logged === false && status === 'active'`) / months_covered.
  - Monthly depreciation = (cost − salvage) / life_years / 12.
  - Bills mapped `equipment`, `project`, `ignore`, or with `has_project` → excluded.
  - A category with no mapping → excluded + listed in `unmapped.categories` + warning `unmapped_category`.
- **Trade rate:**
  - Last 3 months that have final payroll.
  - Per employee: average (gross − overtime) over those months + average EOS provision + oncost_per_worker.
  - `oncost_per_worker` = (labour_oncost bills in window / months_covered) / headcount of mapped employees in the latest final month.
  - Trade rate = mean of its employees ÷ (work_days × work_hours).
  - The group rate is the headcount-weighted mean over its trades.
  - Unmapped designations → `unmapped.designations` + warning.
- **Owned equipment** (`ever_logged`): rate = ((cost − salvage)/life_years + log_cost_12m) / log_hours_12m. If `log_hours_12m` is 0 → `rate: null` + warning `equipment_no_hours`.
- **Hired equipment:** rate / (basis === 'hour' ? 1 : base_hours).
- **w_monthly** = Σ active projects of contract_value / max(1, whole months between start and end). A project missing a date → skipped + warning `project_no_dates`.
- **Overrides** replace the computed value and set `overridden: true`. An override on a trade does not change its group's rate.
- Rates ≤ 0 → `rate: null` + warning `bad_rate`.

**Views:**
- `viewSnapshot(snap, role) → snap'`.
  - For `qs`/`viewer`: every trade with `headcount < 3` gets `rate = its group's rate`, `headcount` deleted, and `via_group: true`.
  - `oh_parts.payroll` deleted (it would expose management salaries).
  - Admin gets the snapshot unchanged.

- [ ] **Step 1: Write failing `test-costs.js`** using this fixture (all fake):
  - 3 Masons: gross 3000, overtime 300, months 2026-08/09/10 final, plus a 2026-11 draft gross 9999 (already excluded by Task 3, so build `raw` directly here).
  - 1 Foreman: gross 6000, overtime 0.
  - EOS 150 / month each.
  - `labour_oncost` bills 36000 across the window; earliest bill ≥ 12 months back.
  - `work_days 26`, `work_hours 8`. Both trades in group `Site`.

  **Expected:**
  - `Mason.rate ≈ 17.3077` ((2700 + 750 + 150) / 208)
  - `Foreman.rate ≈ 33.1731` ((6000 + 750 + 150) / 208)
  - `Site.rate ≈ 21.2740` (4425 / 208)
  - `viewSnapshot(snap,'qs')`: the Foreman row has `rate ≈ 21.2740`, `via_group === true`, no `headcount`; Mason keeps 17.3077.
  - OH: overhead bills 120000 no project + one bill 50000 with project (excluded) + office payroll 4000 × 12 months with share 0 + one asset (cost 66000, salvage 6000, life 5, never logged) → `oh_monthly = (120000 + 48000 + 1000 × 12) / 12 = 15000`.
  - Owned excavator: cost 260000, salvage 20000, life 8, log_cost_12m 30000, hours 1200 → rate 50. Same with hours 0 → `rate === null` + warning `equipment_no_hours`.
  - Hired roller: 13000 / month, base 260 → rate 50.
  - Override `trade:Mason = 18` → Mason 18, `overridden: true`, Site group unchanged.
  - Unmapped category `misc` → in `unmapped.categories`, not in OH.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `lib/costs.js`.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: cost snapshot from ERP aggregates`.

### Task 5: Costs API, sync scheduler, material prices

**Files:**
- Create: `modules/costs.js`, `test-sync.js`
- Modify: `server.js` (register module, start scheduler when `require.main === module` and on `POST /api/costs/sync`)

**Interfaces:**
- Consumes: `readErp`, `buildSnapshot`, `viewSnapshot`.
- **Tables:**
  - `snapshots(id, created, ok INTEGER, error TEXT, data TEXT /*JSON snap*/)`
  - `materials(id, code, name_ar, name_en, unit)`
  - `material_po_links(material_id, description_norm, unit)`
  - `material_quotes(id, material_id, date, supplier, rate, created_by)`
  - `cost_config(key PK, value JSON)` for `category_map`, `trade_map`, `trade_groups`, `overrides`.
- **Exported for later tasks:**
  - `ctx.costs.latest() → { id, created, data } | null` (latest ok snapshot)
  - `ctx.costs.get(id)`
  - `ctx.costs.materialPrice(material_id, snapshotData, now) → { rate, date, source: 'po'|'quote', avg, min, max, stale: bool } | null`
    - The latest-dated between linked PO lines (match `norm(description)` + unit, `norm` = lowercase, trim, collapse spaces) and manual quotes.
    - `stale` when older than `material_stale_days`.
- **Endpoints:**
  - `POST /api/costs/sync` (admin, qs)
  - `GET /api/costs/status` → `{ last_ok, last_attempt, last_error, stale: bool }`
  - `GET /api/costs/snapshot` (role-viewed)
  - `GET/PUT /api/costs/config` (admin)
  - `/api/costs/materials` CRUD (admin, qs)
  - `/api/costs/materials/:id/links` (admin, qs)
  - `/api/costs/materials/:id/quotes` (admin, qs)
- **Sync:**
  - Failure → insert `ok=0` with error, keep the previous ok snapshot as latest, audit `sync_failed`.
  - Scheduler: every `sync_minutes`, plus once at start; skip if `ERP_SYNC_DISABLED=1` (tests).

- [ ] **Step 1: Write failing `test-sync.js`:**
  - Set `erp_db_path` to a fixture → `POST sync` → 200. `GET snapshot` as admin has `trades`.
  - Point the path at a missing file → `POST sync` → 502 with the error. `status.last_ok` is unchanged, `last_error` is set, and `GET snapshot` still returns the old one.
  - Material linked to PO description `"Interlock Tile 80mm "` unit `m2` (PO 2026-09-01 rate 30) plus a quote 2026-10-15 rate 32 → `materialPrice.rate === 32`, `source === 'quote'`.
  - With `now` 2027-01-01 → `stale === true`.
  - No links and no quotes → `null`.
  - QS `PUT config` → 403.
  - The snapshot JSON stored in `estimation.db` does not contain `"Test Mason A"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: costs API, hourly ERP sync, material prices`.

### Task 6: Unit cost of a library item + library API

**Files:**
- Create: `lib/unitcost.js`, `modules/library.js`, `test-unitcost.js`, `test-library.js`

**Interfaces:**
- **Tables:**
  - `sections(id, name_ar, name_en, parent_id, default_rework_pct, sort)`
  - `items(id, code UNIQUE, section_id, unit, name_ar, name_en, current_version)`
  - `item_versions(id, item_id, version, created, created_by, data JSON)`
- **Version data:**

```js
{ rework_pct, condition_factor /* ≥1, default 1 */,
  parts: [ { kind:'material', material_id, qty, waste_pct }
         | { kind:'labour', crew:[{ trade, count }], output_per_day }
         | { kind:'equipment', equipment_id, output_per_hour }
         | { kind:'sub', rate } | { kind:'fixed', amount } ] }
```

- `unitCost(versionData, snapData, cfg: { work_hours, materialPrice: id => price|null }) → { unit: number|null, parts: [{ kind, cost }], missing: [string] }`
  - material = qty × (1 + waste/100) × price
  - labour = Σ(count × tradeRate) × work_hours / output_per_day × condition_factor
  - equipment = rate / output_per_hour × condition_factor
  - sub = rate; fixed = amount
  - unit = Σ × (1 + rework/100)
  - Any missing price/rate → `unit: null`, with a `missing` entry like `'material:12'`, `'trade:Mason'`, `'equipment:asset:3'`.
  - Labour uses the **role-independent** trade rate (the server computes; the QS only sees the result, which is fine because a crew cost doesn't expose an individual salary).
- **Endpoints:**
  - `/api/library/sections` (CRUD: admin, qs)
  - `/api/library/items` (list with each item's current unit cost from the latest snapshot)
  - `POST /api/library/items`
  - `PUT /api/library/items/:id` → **always** a new `item_versions` row (`version + 1`) and moves `current_version`; old versions are never updated or deleted
  - `GET /api/library/items/:id/versions`
  - Seeded on first start (names only, no rates): sections Excavation, Backfill & compaction, Sub-base, Road base, Asphalt, Kerbs, Interlock, Road marking & signs, Drainage, Utility protection, Waste disposal (Arabic names too).

- [ ] **Step 1: Write failing `test-unitcost.js`.**
  - Material: qty 1, waste 5 %, price 300.
  - Crew: 1 Foreman @40 + 4 Labourer @15, output 20/day, 8 h.
  - Equipment: 120 / h, output 10 / h.
  - condition_factor 1.25, fixed 5, rework 2 %.
  - **Expected:** `unit ≈ 392.70` ((315 + (40 + 12) × 1.25 + 5) × 1.02), and `parts` costs `[315, 50, 15, 5]`.
  - Missing material price → `unit === null`, `missing` contains `'material:<id>'`.
  - `output_per_day: 0` → `missing` contains `'labour:output'`, never `Infinity`.
- [ ] **Step 2: Write failing `test-library.js`.**
  - Seeded sections exist (11).
  - Create item → PUT twice → versions `[1, 2, 3]`, and version 1 data is unchanged.
  - Viewer `POST` → 403.
  - Duplicate code → 400.
- [ ] **Step 3: Run both** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run both** → PASS.
- [ ] **Step 6: Commit** `feat: item library with versions and unit cost`.

### Task 7: Cash-flow financing cost

**Files:**
- Create: `lib/cashflow.js`, `test-cashflow.js`

**Interfaces:**
- `financingCost({ spend, M, V, adv_pct, ret_pct, collection_days, retention_months, rate_pct }) → { F, schedule: [{ month, out, in, balance, cost }] }`

Algorithm (spec §5.7, approved by owner):

```
lag = ceil(collection_days / 30)
month 0: in += V*adv
for m in 1..M: out[m] += spend/M ; in[m+lag] += V/M*(1-ret) - V*adv/M
in[M + retention_months] += V*ret
balance_t = Σ_{≤t}(in - out);  cost_t = max(0, -balance_t) * rate/12
F = Σ cost_t over t = 0..last event month
```

- [ ] **Step 1: Write failing `test-cashflow.js`.**
  - spend 200000, M 2, V 240000, ret 10 %, 60 days, retention 12 months, rate 12 %, adv 0 → `F === 3920` (round2).
  - Same with adv 10 % → `F === 3320`.
  - collection 0, ret 0, V ≥ spend → `F === 0`.
  - `M = 0` → throws `/duration/`.
  - The schedule's last month is 14 (2 + 12).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: monthly cash-flow financing cost`.

### Task 8: Tender pricing engine

**Files:**
- Create: `lib/pricing.js`, `test-pricing.js`

**Interfaces:**
- Consumes: `financingCost`.
- `priceTender(input) → result`

```js
input = { rows: [{ id, qty, direct_unit }],     // direct_unit already resolved (Task 9); headings excluded
          hidden: [{ kind:'fixed', amount } | { kind:'monthly', amount } | { kind:'pct', pct }
                 | { kind:'locked', amount, months, bank_fee_pct, loss_pct }],   // only status 'applies'
          M, oh_monthly, w_monthly, finance_rate_pct, margin_pct, min_profit_pct,
          adv_pct, ret_pct, collection_days, retention_months }
result = { D, H, OH, F, L, C, V, P, P_min, OH_flat_compare, rows: [{ id, rate, amount }],
           total, rounding_diff, iterations, schedule }
```

- D = Σ qty × direct_unit.
- H = Σ fixed + Σ monthly × M + Σ pct × V.
- `locked` cost L = amount × (finance_rate × months/12 + bank_fee_pct/100 × months/12 + loss_pct/100). Bank fee is **per year, pro-rated**: a designer call, shown on screen.
- OH = oh_monthly × M × V / (V + w_monthly × M).
- F = financingCost(spend = D + H + OH).
- C = D + H + OH + F + L. P = C / (1 − margin). Iterate V := P from V₀ = D / (1 − margin) until |ΔV| < 0.005. More than 100 iterations → throw `/did not converge/`.
- P_min = C / (1 − min_profit) at the final V.
- `OH_flat_compare` = oh_monthly × 12 / (w_monthly × 12 || 1) × V. This is OH as a flat % of turnover, shown for comparison (§5.7).
- Row rate = round2(direct_unit × P / D). Amount = round2(qty × rate). total = Σ amount. rounding_diff = round2(total − P).
- **Guards** (400-style `Error` with `code: 'bad_input'`):
  - D ≤ 0
  - M ≤ 0
  - margin or min_profit ≥ 100 or < 0
  - any non-finite output

- [ ] **Step 1: Write failing `test-pricing.js`.**
  - Inputs: D = 400000 (one row qty 1000 × 400); hidden fixed 8000; monthly 6000; locked 50000 / 8 months / fee 0 / loss 0; M 2; oh_monthly 120000; w_monthly 0; rate 8 %; margin 12 %; min 5 %; adv 0, ret 0, collection 0.
  - **Expected:** `L ≈ 2666.67`, `OH === 240000`, `F === 0`, `C ≈ 662666.67`, `P ≈ 753030.30`, `P_min ≈ 697543.86`.
  - Same + `{ kind:'pct', pct: 0.5 }` (CAR) → `V ≈ 757333.33`, `C ≈ 666453.33`, `P_min ≈ 701529.82`.
  - Rows: two rows (qty 3 @ 100, qty 7 @ 100; D = 1000), and P = 1234.567 forced via margin. `total` equals the sum of rounded amounts, and `rounding_diff === round2(total − P)`.
  - Guards: D = 0 / M = 0 / margin 100 → throws `bad_input`, no `NaN` anywhere (`JSON.stringify(result)` has no `null` from NaN).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: tender pricing engine (fixed point on contract value)`.

### Task 9: Tenders API: rows, import, take-off, links, hidden items, pricing, workflow

**Files:**
- Create: `modules/tenders.js`, `test-tenders.js`, `test-workflow.js`

**Interfaces:**
- Consumes: `readXlsx`, `unitCost`, `priceTender`, `ctx.costs.*`.
- **Tables:**
  - `tenders(id, ref, title, client, kind 'rta'|'direct', root_id, rev, status, snapshot_id, M, adv_pct, ret_pct, collection_days, retention_months, margin_pct, submit_date, result, winner_price, approved_by, approved_at, frozen JSON, created, created_by)`
  - `tender_rows(id, tender_id, seq, no, description, unit, qty, is_heading, manual_unit, source 'import'|'takeoff')`
  - `row_links(row_id, item_id, share)` (shares of quantity, Σ = 1)
  - `takeoff_lines(id, row_id, description, l, w, d, count, deduct)`
  - `hidden_templates(id, name_ar, name_en, kind, sort, active)`
  - `tender_hidden(id, tender_id, template_id, name_ar, name_en, kind, status NULL|'applies'|'na'|'included', amount, pct, months, bank_fee_pct, loss_pct, note)`
- **Statuses:** `draft → submitted → approved → sent → won|lost`. Editing is allowed only in `draft`.
- **Seeded `hidden_templates`** (names AR/EN + kind, no amounts):

| Name | Kind |
|---|---|
| RTA permits & NOCs | fixed |
| Permit deposit | locked |
| Traffic diversion (TMP) | monthly |
| Security/guarding | monthly |
| Lab testing | fixed |
| Consultant | fixed |
| CAR insurance | pct |
| Performance bond | locked |
| Waste disposal | fixed |
| Extra accommodation & transport | monthly |
| Site office | monthly |

- **Endpoints:**
  - `POST /api/tenders` (copies active templates, binds `snapshot_id` = latest ok)
  - `GET/PUT /api/tenders/:id`
  - `POST /api/tenders/:id/import/preview { file_b64 }` → sheets + first 30 rows
  - `POST /api/tenders/:id/import { file_b64, sheet, header_row, cols:{ no, desc, unit, qty } }`
    - Replaces imported rows; keeps order.
    - A row is a heading when qty is `null` after `num()`.
    - An empty row is skipped.
  - Rows, take-off lines, links, manual unit, hidden items: CRUD under `/api/tenders/:id/...`
  - Take-off qty = Σ(±(l ?? 1)(w ?? 1)(d ?? 1)(count ?? 1)) over lines, where a line with all of l/w/d blank counts 0 and `deduct` negates it.
  - `GET /api/tenders/:id/price?margin_pct=` → `priceTender` result + per-row breakdown + `blocking: [{ code, row_id?|hidden_id?|detail }]` + `newer_snapshot: bool`.
    - Row direct_unit = `manual_unit` ?? Σ share × unitCost(item current version).
    - Codes: `row_unlinked`, `row_unpriced` (missing parts), `hidden_unanswered`, `material_stale`, `snapshot_stale`.
    - Uses the tender's `snapshot_id` (approved: the frozen result only).
  - `POST /api/tenders/:id/reprice` → binds the latest snapshot; the response includes old and new P.
  - `POST /api/tenders/:id/submit` (qs, admin): draft → submitted.
  - `POST /api/tenders/:id/approve { margin_pct, override_stale? }` (**admin only**):
    - Requires `blocking` empty, except that `snapshot_stale` is waived by `override_stale: true` (audited as `approve_stale`).
    - Stores `frozen` = full result + item version ids + snapshot id.
  - `POST /api/tenders/:id/return` (admin): submitted → draft.
  - `POST /api/tenders/:id/revise`: copy of an approved/sent tender as `rev + 1`, `root_id` kept, status draft; the original is untouched.
  - `PUT /api/tenders/:id/result { result:'won'|'lost', winner_price? }`.
  - No DELETE of tenders past draft.
  - `GET/POST/PUT /api/hidden-templates` (write: admin). Deactivating a template (`active = 0`) never changes existing tenders.
  - Every state change is audited.

- [ ] **Step 1: Write failing `test-tenders.js`.**
  - Import a `writeXlsx` BOQ with a heading row, `"1,250.50"` qty text, an empty row, and Arabic descriptions → rows in order, qty 1250.5, heading flagged, empty row skipped.
  - Take-off: lines (10, 2, —, 1) and (3, 1, —, 1, deduct) → qty 17.
  - Link a row to two items with shares 0.6/0.4 → direct_unit = 0.6 × u1 + 0.4 × u2.
  - Unanswered hidden item → `blocking` contains `hidden_unanswered`.
  - Unlinked qty row → `row_unlinked`.
  - Price response, viewed as qs, has no trade with a `headcount < 3` rate (Review Focus 4).
- [ ] **Step 2: Write failing `test-workflow.js`.**
  - qs approve → 403.
  - Approve with blocking → 409 with the list.
  - Clean tender → submit → approve → `frozen.P` set. A later sync + library edit → `GET price` returns the same frozen P.
  - `PUT` rows on approved → 409.
  - Revise → rev 2 draft, rev 1 still approved.
  - Snapshot `created` set 8 days back → approve → 409 `snapshot_stale`; with `override_stale` → 200 and audit `approve_stale`.
  - New sync while draft → `newer_snapshot === true`, P unchanged until `reprice`.
- [ ] **Step 3: Run both** → FAIL.
- [ ] **Step 4: Implement `modules/tenders.js`.**
- [ ] **Step 5: Run both** → PASS.
- [ ] **Step 6: Commit** `feat: tenders: BOQ import, take-off, hidden items, pricing, approval, revisions`.

### Task 10: Exports

**Files:**
- Modify: `modules/tenders.js`
- Test: `test-tenders.js` (append)

**Interfaces:**
- `GET /api/tenders/:id/export?format=xlsx|csv&kind=client|internal`
  - **client:** columns in the client's order: No, Description, Unit, Qty, Rate, Amount. Headings are kept as rows. A total row follows. CSV is UTF-8 with BOM.
  - **internal** (admin, qs): sheet `Summary` (D, H, OH, F, L, C, P_min, P, margin, snapshot date), sheet `Rows` (direct unit + parts per row), sheet `Hidden`, sheet `CashFlow` (schedule).
  - The internal export obeys `viewSnapshot` (no small-trade rates for qs).
  - Viewer → client kind only.

- [ ] **Step 1: Append failing tests.**
  - `readXlsx(client export)`: rows match the import order, with a `Rate` column equal to the priced rates and a total equal to `result.total`.
  - Internal as qs contains no small-trade own rate.
  - The client export contains none of: `"Direct"`, `"OH"`, `"Margin"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: client and internal BOQ exports`.

### Task 11: Browser UI (Arabic/English)

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/i18n.js`, `public/style.css`, `test-ui.js`

**Screens (spec §5.9):** each is a hash route in `app.js`.
- `#/` Tenders by status + sync status
- `#/costs` OH breakdown, trades, equipment, materials, overrides (admin edits)
- `#/library`
- `#/tender/:id` with tabs: Info, Quantities, Links, Hidden, Summary
- `#/settings` (admin): ERP path, category/trade maps, groups, percentages, users, hidden templates

**Summary tab:**
- The three numbers.
- The cost waterfall (D, H, OH, F, L → C → P_min → P) as a horizontal stacked bar.
- What-if inputs (margin, M, collection days) calling `GET price` with query overrides, without saving.
- The OH flat-% comparison.
- The `blocking` list with links.
- The approve button (admin).

**Banners:**
- Global red banner when `costs/status.stale` or `last_error`, with the last good time.
- Yellow banner when the tender has `newer_snapshot`.

**Language:** AR/EN toggle stored in `localStorage` (wrapped in try/catch); `dir="rtl"` for Arabic.

- [ ] **Step 1: Write failing `test-ui.js`.**
  - Server serves `/` with `<html` and `/app.js`.
  - Every key used in `app.js` (`t('key')` regex) exists in both `ar` and `en` of `i18n.js`.
  - Playwright smoke if `require('playwright')` resolves (skip otherwise):
    1. Log in as admin, create a tender, see the Summary tab render without console errors.
    2. Switch to AR → `document.dir === 'rtl'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement the UI.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: bilingual browser UI`.

### Task 12: Windows launchers, README, full run

**Files:**
- Create: `Estimation-Start.bat`, `Estimation-Autostart.bat`, `README.md`
- Modify: `package.json` (`test` script includes every `test-*.js`)

- `Estimation-Start.bat`:
  - Mirror the ERP's `Trigon-Start.bat`: Node check / `winget` install, `chcp 65001`, restart loop.
  - Set `HOST=0.0.0.0`, `PORT=3100`.
  - Open `http://localhost:3100`.
  - Print the LAN address hint (`ipconfig` IPv4) for the QS.
- `Estimation-Autostart.bat`: creates a Startup-folder shortcut to `Estimation-Start.bat` (same approach as the ERP's `Trigon-Autostart.bat`; read it and mirror it).
- `README.md` (AR + EN):
  - Install and start.
  - First admin setup.
  - Set the ERP path.
  - Map categories and designations.
  - Allow port 3100 in Windows Firewall (private network only).
  - "The app never writes to the ERP".

- [ ] **Step 1: Run `npm test`**. Expected: every suite prints ok, exit 0.
- [ ] **Step 2: Start the server against a fixture ERP** (build one with `makeErp` into `data-demo/erp.db`, then `npm start` and set that path under Settings → ERP path), walk through one tender end-to-end in the browser, and screenshot the Summary tab.
- [ ] **Step 3: Commit** `chore: Windows launchers and README`, then push the branch.
