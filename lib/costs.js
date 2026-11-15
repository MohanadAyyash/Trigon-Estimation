// Cost snapshot builder (pure, no I/O): ERP aggregates from lib/erpsync.js -> company overhead per month,
// cost per hour of each trade, equipment hourly rates. Spec §5.3 and §7.
// Rules: a missing value is never read as zero; a value that would be 0, negative, NaN or Infinity becomes null
// with a warning. No employee keys or individual figures leave this function, only per-trade aggregates.

const finite = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
const pad = n => String(n).padStart(2, '0');
const monthIdx = s => {   // 'YYYY-MM...' -> y*12 + (m-1), or null
  const m = /^(\d{4})-(\d{2})/.exec(typeof s === 'string' ? s : '');
  return m && +m[2] >= 1 && +m[2] <= 12 ? +m[1] * 12 + (+m[2] - 1) : null;
};
const idxMonth = i => `${Math.floor(i / 12)}-${pad(i % 12 + 1)}`;
const dayMs = s => {   // 'YYYY-MM-DD' -> UTC ms of that real calendar day, or null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s.trim() : '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]), d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
};
const DAY = 86400000, AVG_MONTH_DAYS = 30.4375;
// warnings whose detail could point at a person's pay: non-admin views get the code only
const PAYROLL_WARNINGS = new Set(['bad_payroll_gross', 'bad_payroll_row', 'eos_missing', 'no_headcount', 'no_designation']);
const sortedUnique = a => [...new Set(a)].sort();

function buildSnapshot(raw, cfg) {
  if (!raw || typeof raw !== 'object') throw new Error('buildSnapshot: raw must be an object');
  if (!cfg || typeof cfg !== 'object') throw new Error('buildSnapshot: cfg must be an object');
  const readAt = new Date(raw.read_at);
  if (typeof raw.read_at !== 'string' || isNaN(readAt)) throw new Error('buildSnapshot: raw.read_at must be an ISO date');

  const warnings = (raw.warnings || []).map(w => ({ code: w.code, detail: w.detail != null ? String(w.detail) : (w.id != null ? `id ${w.id}` : '') }));
  const warn = (code, detail) => warnings.push({ code, detail: detail == null ? '' : String(detail) });
  const positive = (v, label) => {   // a computed rate: finite and > 0, else null + warning
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    warn('bad_rate', label);
    return null;
  };
  const categoryMap = cfg.category_map || {}, tradeMap = cfg.trade_map || {}, tradeGroups = cfg.trade_groups || {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // Window: the 12 full calendar months before read_at's month.
  const curIdx = readAt.getUTCFullYear() * 12 + readAt.getUTCMonth();
  const winStart = curIdx - 12, winEnd = curIdx - 1;
  const inWindow = s => { const i = monthIdx(s); return i !== null && i >= winStart && i <= winEnd; };

  // months_covered
  let monthsCovered = null;
  const eb = monthIdx(raw.earliest_bill);
  if (eb === null) warn('no_bill_history', 'no bills in the ERP: overhead cannot be averaged');
  else {
    monthsCovered = Math.min(12, Math.max(1, winEnd - eb + 1));
    if (monthsCovered < 12) warn('short_history', `${monthsCovered} month(s) of bills`);
  }

  // Bills in the window, split by mapping
  let ohBills = 0, oncostTotal = 0;
  const unmappedCats = new Set();
  for (const c of raw.categories || []) if (!has(categoryMap, c)) unmappedCats.add(c);
  let uncategorised = 0;
  for (const b of raw.bills || []) {
    if (!inWindow(b.date)) continue;
    if (!finite(b.amount)) { warn('bad_bill_amount', b.date); continue; }
    const cat = b.category == null ? '' : String(b.category);
    if (cat.trim() === '') { uncategorised++; continue; }
    if (!has(categoryMap, cat)) { unmappedCats.add(cat); continue; }
    const kind = categoryMap[cat];
    if (kind === 'overhead' && b.has_project === false) ohBills += Number(b.amount);
    else if (kind === 'labour_oncost') oncostTotal += Number(b.amount);
  }
  if (uncategorised) warn('uncategorised_bills', `${uncategorised} bill(s) without a category excluded`);
  const unmappedCategories = [...unmappedCats].sort();
  for (const c of unmappedCategories) warn('unmapped_category', c);

  // Overhead payroll: the non-project share of gross in the window, limited to the months the bills cover so that
  // numerator and months_covered describe the same period
  let ohPayroll = 0;
  for (const p of raw.payroll || []) {
    if (!inWindow(p.month) || eb === null || monthIdx(p.month) < eb) continue;
    if (!finite(p.gross) || !finite(p.project_share)) { warn('bad_payroll_row', p.month); continue; }
    ohPayroll += Number(p.gross) * (1 - Number(p.project_share));
  }

  // Overhead depreciation: assets not on a project and never used as equipment
  let ohDepMonthly = 0;
  const assetOk = a => finite(a.cost) && finite(a.salvage) && finite(a.life_years) && Number(a.life_years) > 0;
  for (const a of raw.assets || []) {
    if (a.has_project !== false || a.ever_logged !== false) continue;
    if (!assetOk(a)) { warn('bad_asset', `asset:${a.key}`); continue; }
    ohDepMonthly += (Number(a.cost) - Number(a.salvage)) / Number(a.life_years) / 12;
  }

  const ohParts = { bills: ohBills, payroll: ohPayroll, depreciation: monthsCovered === null ? null : ohDepMonthly * monthsCovered };
  let ohMonthly = null;
  if (monthsCovered !== null) {
    const v = (ohBills + ohPayroll + ohParts.depreciation) / monthsCovered;
    if (Number.isFinite(v) && v > 0) ohMonthly = v; else warn('bad_value', 'oh_monthly');
  }

  // Trades: last 3 months that have final payroll (raw.payroll is final-only)
  const curMonth = idxMonth(curIdx);
  const allMonths = sortedUnique((raw.payroll || []).map(p => p.month).filter(m => monthIdx(m) !== null && m.slice(0, 7) <= curMonth));
  const tradeMonths = allMonths.slice(-3);
  const unmappedDes = new Set();
  for (const d of raw.designations || []) { const t = String(d).trim(); if (t && !has(tradeMap, t)) unmappedDes.add(t); }
  for (const p of raw.payroll || []) { const t = String(p.designation == null ? '' : p.designation).trim(); if (t && !has(tradeMap, t)) unmappedDes.add(t); }
  const unmappedDesignations = [...unmappedDes].sort();
  for (const d of unmappedDesignations) warn('unmapped_designation', d);

  const workHours = finite(cfg.work_days) && finite(cfg.work_hours) ? Number(cfg.work_days) * Number(cfg.work_hours) : NaN;
  const trades = [], groups = [];
  if (!tradeMonths.length) warn('no_final_payroll', 'no final payroll: trade rates cannot be computed');
  else {
    if (!(workHours > 0)) warn('bad_work_hours', 'work_days x work_hours must be > 0');
    const monthSet = new Set(tradeMonths), latest = tradeMonths[tradeMonths.length - 1];
    const emps = new Map();   // employee_key -> { pay: Map(month -> gross-overtime), eos: Map(month -> amount), designation, latest }
    for (const p of raw.payroll || []) {
      if (!monthSet.has(p.month)) continue;
      if (!finite(p.gross)) { warn('bad_payroll_row', p.month); continue; }
      const e = emps.get(p.employee_key) || { pay: new Map(), eos: new Map(), designation: '', month: '' };
      const ot = finite(p.overtime) ? Number(p.overtime) : 0;
      e.pay.set(p.month, (e.pay.get(p.month) || 0) + Number(p.gross) - ot);
      if (p.month >= e.month) { e.month = p.month; e.designation = String(p.designation == null ? '' : p.designation).trim(); }
      emps.set(p.employee_key, e);
    }
    for (const r of raw.eos || []) {
      const e = emps.get(r.employee_key);
      if (!e || !monthSet.has(r.month) || !finite(r.amount)) continue;
      e.eos.set(r.month, (e.eos.get(r.month) || 0) + Number(r.amount));
    }
    const byTrade = new Map();   // trade -> [employee]
    let headLatest = 0, unassigned = 0;
    for (const e of emps.values()) {
      if (!e.designation) { unassigned++; continue; }
      if (!has(tradeMap, e.designation)) continue;
      const t = String(tradeMap[e.designation]);
      if (!byTrade.has(t)) byTrade.set(t, []);
      byTrade.get(t).push(e);
      if (e.pay.has(latest)) headLatest++;
    }
    if (unassigned) warn('no_designation', `${unassigned} employee(s) without a designation excluded from trades`);
    let oncost = null;
    if (byTrade.size) {
      if (headLatest === 0) warn('no_headcount', `no mapped employees in ${latest}`);
      else {
        oncost = monthsCovered === null ? 0 : (oncostTotal / monthsCovered) / headLatest;
        if (oncost === 0) warn('no_labour_oncost', 'no labour on-cost bills in the window');
      }
    }
    const avg = m => { let s = 0; for (const v of m.values()) s += v; return s / m.size; };
    const computed = new Map();   // trade -> computed rate (before overrides)
    for (const [t, list] of [...byTrade.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      let sum = 0, eosMissing = false;
      for (const e of list) {
        let eos = 0;
        if (e.eos.size) eos = avg(e.eos); else eosMissing = true;
        sum += avg(e.pay) + eos;
      }
      if (eosMissing) warn('eos_missing', t);
      const rate = oncost === null ? positive(NaN, `trade:${t}`) : positive((sum / list.length + oncost) / workHours, `trade:${t}`);
      computed.set(t, rate);
      trades.push({ trade: t, group: has(tradeGroups, t) && tradeGroups[t] ? String(tradeGroups[t]) : t, rate, headcount: list.length, overridden: false });
    }
    const gmap = new Map();
    for (const tr of trades) {
      const g = gmap.get(tr.group) || { w: 0, n: 0, headcount: 0, bad: false };
      g.headcount += tr.headcount;
      if (computed.get(tr.trade) === null) g.bad = true; else { g.w += computed.get(tr.trade) * tr.headcount; g.n += tr.headcount; }
      gmap.set(tr.group, g);
    }
    for (const [name, g] of [...gmap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      // a group with a trade that has no valid rate would be a silently partial average: null instead
      const rate = g.bad ? null : positive(g.w / g.n, `group:${name}`);
      if (g.bad) warn('bad_rate', `group:${name}`);
      groups.push({ group: name, rate, headcount: g.headcount });
    }
  }

  // Equipment
  const equipment = [];
  for (const a of raw.assets || []) {
    if (a.ever_logged !== true) continue;
    const id = `asset:${a.key}`;
    let rate = null;
    if (!assetOk(a) || !finite(a.log_cost_12m) || !finite(a.log_hours_12m)) warn('bad_asset', id);
    else if (!(Number(a.log_hours_12m) > 0)) warn('equipment_no_hours', id);
    else rate = positive(((Number(a.cost) - Number(a.salvage)) / Number(a.life_years) + Number(a.log_cost_12m)) / Number(a.log_hours_12m), id);
    equipment.push({ id, name: a.name, rate, source: 'owned', overridden: false });
  }
  for (const h of raw.hires || []) {
    if (h.type !== 'equipment') continue;   // hired labour is not equipment
    const id = `hire:${h.key}`;
    const div = h.basis === 'hour' ? 1 : (finite(h.base_hours) ? Number(h.base_hours) : NaN);
    equipment.push({ id, name: h.name, rate: positive(finite(h.rate) ? Number(h.rate) / div : NaN, id), source: 'hired', overridden: false });
  }

  // Work per month from active projects
  let wMonthly = 0;
  for (const p of raw.projects || []) {
    const s = dayMs(p.start_date), e = dayMs(p.end_date);
    if (s === null || e === null) { warn('project_no_dates', ''); continue; }
    if (!finite(p.contract_value)) { warn('project_no_value', ''); continue; }
    if (e < s) { warn('project_bad_dates', `${p.start_date} > ${p.end_date}`); continue; }
    // ERP end dates are inclusive: 2026-01-01..2026-12-31 is 12 months, 2026-03-01..2026-04-30 is 2
    const months = Math.max(1, Math.round((e - s + DAY) / DAY / AVG_MONTH_DAYS));
    wMonthly += Number(p.contract_value) / months;
  }
  if (!Number.isFinite(wMonthly)) { warn('bad_value', 'w_monthly'); wMonthly = null; }

  // Overrides
  let ohOverridden = false;
  for (const [key, val] of Object.entries(cfg.overrides || {})) {
    const v = finite(val) ? Number(val) : NaN;
    if (!(v > 0)) { warn('bad_override', key); continue; }
    let target = null;
    if (key === 'oh_monthly') { ohMonthly = v; ohOverridden = true; continue; }
    if (key.startsWith('trade:')) target = trades.find(t => t.trade === key.slice(6));
    else if (key.startsWith('equip:')) target = equipment.find(e => e.id === key.slice(6));
    else { warn('bad_override', key); continue; }
    if (!target) { warn('override_unused', key); continue; }
    target.rate = v;
    target.overridden = true;
  }

  return {
    // the hours the trade rates were built on: unit costs must use the same hours, not a later setting
    work_days: finite(cfg.work_days) ? Number(cfg.work_days) : null, work_hours: finite(cfg.work_hours) ? Number(cfg.work_hours) : null,
    oh_monthly: ohMonthly, oh_overridden: ohOverridden, oh_parts: ohParts, months_covered: monthsCovered,
    w_monthly: wMonthly, trades, groups, equipment,
    po_prices: (raw.po_lines || []).map(l => ({ description: l.description, unit: l.unit, date: l.date, rate: l.rate })),
    unmapped: { categories: unmappedCategories, designations: unmappedDesignations }, warnings,
  };
}

// Role view for qs/viewer (any non-admin role). A trade with fewer than 3 people never shows its own rate or
// headcount, and nothing shown may let it be worked out:
// - group headcounts and all overhead parts are hidden (payroll = OH x months - bills - depreciation);
// - a group's rate is shown only when the small (<3) trades in it total 0 or >= 3 people, otherwise it is null
//   (e.g. Mason 3 + Foreman 1: Foreman = Site + (Site - Mason) x 3), and its small trades get null too;
// - small trades take the group's rate (or null) with via_group: true and no overridden flag;
// - payroll-related warnings lose their detail.
function viewSnapshot(snap, role) {
  const v = structuredClone(snap);
  if (role === 'admin') return v;
  delete v.oh_parts;
  const small = new Map();   // group -> total headcount of its small trades
  for (const t of v.trades || []) if (!(t.headcount >= 3)) small.set(t.group, (small.get(t.group) || 0) + (t.headcount || 0));
  const groupRate = new Map();
  for (const g of v.groups || []) {
    const n = small.get(g.group) || 0;
    if (n > 0 && n < 3) g.rate = null;
    groupRate.set(g.group, g.rate);
    delete g.headcount;
  }
  for (const t of v.trades || []) {
    if (t.headcount >= 3) continue;
    t.rate = groupRate.has(t.group) ? groupRate.get(t.group) : null;
    t.via_group = true;
    delete t.headcount;
    delete t.overridden;
  }
  for (const w of v.warnings || []) if (PAYROLL_WARNINGS.has(w.code)) delete w.detail;
  return v;
}

module.exports = { buildSnapshot, viewSnapshot };
