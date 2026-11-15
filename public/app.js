// Trigon Estimation browser UI: hash routes, Arabic (RTL) / English. Plain JS, no libraries, works offline.
// Every user / BOQ text goes into the DOM as text (h() appends text nodes), never as HTML.
// Money is never computed here: the server prices; the UI only formats. A missing value shows "—", never 0.
'use strict';
(() => {
  const I = window.I18N;
  let lang = 'en';
  try { if (localStorage.getItem('est_lang') === 'ar') lang = 'ar'; } catch (e) { /* storage blocked: English */ }
  const t = (k, vars) => {
    let s = (I[lang] && I[lang][k]) || I.en[k] || k;
    if (vars) for (const v of Object.keys(vars)) s = s.split('{' + v + '}').join(String(vars[v]));
    return s;
  };

  // ---- DOM helpers ------------------------------------------------------------------------------------------
  const addKids = (e, kids) => { for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k)); };
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    addKids(e, kids);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false || (k === 'id' && v === '')) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'value') e.value = v;
      else if (k === 'checked' || k === 'disabled') e[k] = true;
      else e.setAttribute(k, v === true ? '' : v);
    }
    return e;
  }
  const $ = s => document.querySelector(s);
  const pad = n => String(n).padStart(2, '0');
  const iso = s => '\u2066' + s + '\u2069';   // left-to-right isolate: dates and percentages read correctly inside Arabic text
  const fmtTime = s => { if (!s) return null; const d = new Date(s); return iso(isNaN(d) ? String(s) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`); };
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const fmt2 = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQ = v => fin(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : '';
  const missing = reason => h('span', { class: 'missing', title: reason || null }, '—', reason ? h('small', null, ' ' + reason) : null);
  const money = (v, reason) => fin(v) ? h('span', { class: 'num' }, fmt2(v)) : missing(reason || t('no_value'));
  const pctTxt = v => fin(v) ? iso(v.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' %') : '—';
  const nm = o => (lang === 'ar' ? o.name_ar || o.name_en : o.name_en || o.name_ar) || '';
  const blank = s => s === null || s === undefined || String(s).trim() === '';
  const val = e => blank(e.value) ? null : e.value.trim();
  // a typed number for fields the server wants as JSON numbers; anything unparsable is sent as typed so the server explains
  const pnum = s => { if (blank(s)) return null; const x = String(s).replace(/[,\s]/g, ''); return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(x) ? Number(x) : String(s); };
  const inp = (id, value, attrs) => h('input', { id, value: value === null || value === undefined ? '' : String(value), ...attrs });
  const sel = (id, value, opts, attrs) => h('select', { id, ...attrs, value: value === null || value === undefined ? '' : String(value) }, opts.map(([v, l]) => h('option', { value: v }, l)));
  const field = (label, control, cls) => h('label', { class: 'field ' + (cls || '') }, h('span', null, label), control);
  const table = (heads, rows, attrs) => h('table', attrs, h('thead', null, h('tr', null, heads.map(x => h('th', null, x)))), h('tbody', null, rows));
  const yesNo = v => v ? t('yes') : t('no');
  const card = (title, ...kids) => h('section', { class: 'card' }, title ? h('h2', null, title) : null, kids);

  function flash(msg, kind) {
    const box = $('#flash');
    if (!box) return;
    const m = h('div', { class: 'flash ' + (kind || 'err') }, msg, h('button', { class: 'link', onclick: () => m.remove() }, '×'));
    box.append(m);
    if (kind === 'ok') setTimeout(() => m.remove(), 3000);
  }
  const fail = e => flash(t('error') + ': ' + (e && e.message || e));

  // ---- API ------------------------------------------------------------------------------------------------
  let me = null;
  async function api(method, path, body) {
    const r = await fetch('/api/' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (r.status === 401 && me && path !== 'login') { me = null; renderLogin(); }
    if (!r.ok) throw Object.assign(new Error((j && j.error) || r.statusText || String(r.status)), { status: r.status, body: j });
    return j;
  }
  const isAdmin = () => me && me.role === 'admin';
  const canWrite = () => me && (me.role === 'admin' || me.role === 'qs');

  // ---- labels (literal keys only) ---------------------------------------------------------------------------
  const STATUSES = ['draft', 'submitted', 'approved', 'sent', 'won', 'lost'];
  const FROZEN = ['approved', 'sent', 'won', 'lost'];
  const statusLabel = s => ({ draft: t('st_draft'), submitted: t('st_submitted'), approved: t('st_approved'), sent: t('st_sent'), won: t('st_won'), lost: t('st_lost') })[s] || s;
  const kindLabel = k => ({ rta: t('kind_rta'), direct: t('kind_direct') })[k] || k;
  const hiddenKindLabel = k => ({ fixed: t('hk_fixed'), monthly: t('hk_monthly'), pct: t('hk_pct'), locked: t('hk_locked') })[k] || k;
  const partKindLabel = k => ({ material: t('pk_material'), labour: t('pk_labour'), equipment: t('pk_equipment'), sub: t('pk_sub'), fixed: t('pk_fixed') })[k] || k;
  const roleLabel = r => ({ admin: t('role_admin'), qs: t('role_qs'), viewer: t('role_viewer') })[r] || r;
  const catKindLabel = k => ({ overhead: t('ck_overhead'), labour_oncost: t('ck_labour_oncost'), equipment: t('ck_equipment'), project: t('ck_project'), ignore: t('ck_ignore') })[k] || k;
  const blockLabel = c => ({ no_snapshot: t('blk_no_snapshot'), snapshot_stale: t('blk_snapshot_stale'), overhead_missing: t('blk_overhead_missing'), row_unlinked: t('blk_row_unlinked'),
    row_unpriced: t('blk_row_unpriced'), row_zero_qty: t('blk_row_zero_qty'), row_zero_cost: t('blk_row_zero_cost'), material_stale: t('blk_material_stale'), hidden_unanswered: t('blk_hidden_unanswered') })[c] || c;
  const badge = s => h('span', { class: 'badge st-' + s }, statusLabel(s));
  const priceState = p => !p || !p.result ? 'none' : !p.complete ? 'partial' : p.blocking.length ? 'blocked' : 'complete';
  const stateLabel = st => ({ complete: t('complete'), partial: t('partial'), blocked: t('blocked'), none: t('no_price_short') })[st];

  // ---- language -----------------------------------------------------------------------------------------------
  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('app_title');
  }
  function toggleLang() {
    lang = lang === 'ar' ? 'en' : 'ar';
    try { localStorage.setItem('est_lang', lang); } catch (e) { /* not saved: still switches for this page */ }
    applyLang();
    if (me) { renderShell(); route(); } else renderLogin();
  }
  const langButton = () => h('button', { id: 'lang-toggle', class: 'secondary', onclick: toggleLang }, lang === 'ar' ? 'English' : 'العربية');

  // ---- login / first setup -------------------------------------------------------------------------------------
  let setupMode = false;
  function renderLogin() {
    const root = $('#root');
    const u = inp(setupMode ? 'setup-username' : 'login-username', '', { autocomplete: 'username', required: true });
    const p = inp(setupMode ? 'setup-password' : 'login-password', '', { type: 'password', autocomplete: setupMode ? 'new-password' : 'current-password', required: true });
    const msg = h('p', { class: 'err' });
    const form = h('form', { class: 'card login', onsubmit: async ev => {
      ev.preventDefault(); msg.textContent = '';
      try {
        await api('POST', setupMode ? 'setup' : 'login', { username: u.value, password: p.value });
        await boot();
      } catch (e) { msg.textContent = e.status === 401 ? t('bad_login') : e.message; }
    } },
    h('h1', null, t('app_title')),
    setupMode ? h('p', null, t('setup_intro')) : null,
    field(t('username'), u), field(t('password'), p), msg,
    h('div', { class: 'row' }, h('button', { id: setupMode ? 'setup-submit' : 'login-submit', type: 'submit' }, setupMode ? t('create_admin') : t('login')), langButton()));
    root.replaceChildren(h('div', { class: 'login-wrap' }, form));
    u.focus();
  }

  // ---- shell -------------------------------------------------------------------------------------------------
  function renderShell() {
    const nav = [['#/', t('nav_tenders')], ['#/costs', t('nav_costs')], ['#/library', t('nav_library')]];
    if (isAdmin()) nav.push(['#/settings', t('nav_settings')]);
    $('#root').replaceChildren(
      h('header', { class: 'topbar' }, h('strong', null, t('app_title')), h('span', { class: 'spacer' }),
        h('span', { class: 'who' }, me.username + ' · ' + roleLabel(me.role)), langButton(),
        h('button', { class: 'secondary', onclick: async () => { try { await api('POST', 'logout'); } catch (e) { /* signed out anyway */ } me = null; boot(); } }, t('logout'))),
      h('div', { id: 'sync-banner' }),
      h('div', { class: 'layout' },
        h('nav', { class: 'sidebar' }, nav.map(([href, l]) => h('a', { href, 'data-nav': href }, l))),
        h('main', null, h('div', { id: 'flash' }), h('div', { id: 'main' }))));
  }

  async function syncBanner() {
    let st;
    try { st = await api('GET', 'costs/status'); } catch (e) { return null; }
    const box = $('#sync-banner');
    if (box) {
      box.replaceChildren();
      if (st.stale || st.last_error) box.append(h('div', { class: 'banner banner-red' },
        h('strong', null, st.last_error ? t('sync_failed') : t('costs_stale')), ' ',
        t('last_good_sync') + ': ' + (fmtTime(st.last_ok) || t('never')),
        st.last_error ? h('div', { class: 'small' }, st.last_error) : null));
    }
    return st;
  }
  async function syncNow(btn) {
    btn.disabled = true;
    try { await api('POST', 'costs/sync'); flash(t('sync_done'), 'ok'); } catch (e) { fail(e); }
    btn.disabled = false;
    route();
  }

  // ---- router -------------------------------------------------------------------------------------------------
  let routeTok = 0;
  async function route(navigated) {
    if (!me) return;
    const tok = ++routeTok;
    const p = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
    for (const a of document.querySelectorAll('nav.sidebar a')) a.classList.toggle('active', a.getAttribute('data-nav') === '#/' + (p[0] === 'tender' ? '' : (p[0] || '')));
    const main = $('#main'), out = h('div');
    main.replaceChildren(h('p', { class: 'muted' }, t('loading')));
    if (navigated) $('#flash').replaceChildren();
    const st = await syncBanner();
    try {
      if (!p.length) await pageHome(out, st);
      else if (p[0] === 'costs') await pageCosts(out, st);
      else if (p[0] === 'library') await pageLibrary(out, st);
      else if (p[0] === 'settings' && isAdmin()) await pageSettings(out, st);
      else if (p[0] === 'tender' && /^\d+$/.test(p[1] || '')) await pageTender(out, Number(p[1]), p[2] || 'info', p[3] ? Number(p[3]) : null);
      else out.append(h('p', null, t('not_found')));
    } catch (e) {
      if (!me) return;
      out.replaceChildren(h('div', { class: 'banner banner-red' }, t('error') + ': ' + e.message));
    }
    if (tok === routeTok) main.replaceChildren(out);
    const target = p[0] === 'tender' && p[3] ? document.getElementById((p[2] === 'hidden' ? 'hidden-' : 'row-') + p[3]) : null;
    if (target) target.scrollIntoView({ block: 'center' });
  }
  const rerender = () => route(false);

  // ---- home: tenders by status, sync status, new tender -------------------------------------------------------------
  async function pageHome(out, st) {
    const list = await api('GET', 'tenders');
    const page = h('div', { id: 'page-home' });
    page.append(card(t('sync_status'),
      h('dl', { class: 'kv' },
        h('dt', null, t('last_good_sync')), h('dd', null, fmtTime(st && st.last_ok) || t('never')),
        h('dt', null, t('last_attempt')), h('dd', null, fmtTime(st && st.last_attempt) || '—'),
        h('dt', null, t('snapshot_built')), h('dd', null, fmtTime(st && st.snapshot_created) || '—', st && st.last_checked ? h('small', { class: 'muted' }, ' ' + t('unchanged_since')) : null),
        h('dt', null, t('sync_state')), h('dd', null, !st ? '—' : st.last_error ? t('sync_failed') : st.stale ? t('costs_stale') : t('sync_ok'))),
      st && st.last_error ? h('p', { class: 'err' }, st.last_error) : null,
      canWrite() ? h('button', { onclick: ev => syncNow(ev.target) }, t('sync_now')) : null));

    const head = h('div', { class: 'row' }, h('h1', null, t('nav_tenders')), h('span', { class: 'spacer' }));
    page.append(head);
    if (canWrite()) {
      const formBox = h('div');
      head.append(h('button', { id: 'new-tender', onclick: () => { formBox.replaceChildren(newTenderForm()); } }, t('new_tender')));
      page.append(formBox);
    }
    for (const s of STATUSES) {
      const rows = list.filter(x => x.status === s);
      page.append(h('section', { class: 'card' }, h('h2', null, badge(s), ' ', h('span', { class: 'muted' }, '(' + rows.length + ')')),
        rows.length ? table([t('ref'), t('title'), t('client'), t('kind'), t('rev'), t('created'), t('approved_price')],
          rows.map(x => h('tr', null, h('td', null, x.ref || ''), h('td', null, h('a', { href: '#/tender/' + x.id + '/info' }, x.title)), h('td', null, x.client || ''),
            h('td', null, kindLabel(x.kind)), h('td', { class: 'num' }, x.rev), h('td', null, fmtTime(x.created)), h('td', { class: 'num' }, fin(x.approved_P) ? fmt2(x.approved_P) : '—'))), { class: 'grid' })
          : h('p', { class: 'muted' }, t('none'))));
    }
    out.append(page);
  }

  function infoFields(prefix, v, editable) {
    const dis = editable ? {} : { disabled: true };
    const f = {
      title: inp(prefix + 'title', v.title, { required: true, ...dis }), ref: inp(prefix + 'ref', v.ref, dis), client: inp(prefix + 'client', v.client, dis),
      kind: sel(prefix + 'kind', v.kind || 'direct', [['direct', t('kind_direct')], ['rta', t('kind_rta')]], dis),
      M: inp(prefix + 'M', v.M, { inputmode: 'numeric', ...dis }), adv_pct: inp(prefix + 'adv', v.adv_pct, { inputmode: 'decimal', ...dis }),
      ret_pct: inp(prefix + 'ret', v.ret_pct, { inputmode: 'decimal', ...dis }), collection_days: inp(prefix + 'cd', v.collection_days, { inputmode: 'decimal', ...dis }),
      retention_months: inp(prefix + 'retm', v.retention_months, { inputmode: 'numeric', ...dis }), submit_date: inp(prefix + 'date', v.submit_date, { type: 'date', ...dis }),
    };
    const grid = h('div', { class: 'form-grid' },
      field(t('title'), f.title), field(t('ref'), f.ref), field(t('client'), f.client), field(t('kind'), f.kind),
      field(t('duration_months'), f.M), field(t('adv_pct'), f.adv_pct), field(t('ret_pct'), f.ret_pct), field(t('collection_days'), f.collection_days),
      field(t('retention_months'), f.retention_months), field(t('submit_date'), f.submit_date));
    const values = () => Object.fromEntries(Object.entries(f).map(([k, e]) => [k, k === 'kind' ? e.value : val(e)]));
    return { grid, f, values };
  }
  function newTenderForm() {
    const x = infoFields('nt-', {}, true);
    return card(t('new_tender'), x.grid, h('div', { class: 'row' },
      h('button', { id: 'nt-save', onclick: async ev => {
        ev.target.disabled = true;
        try { const r = await api('POST', 'tenders', x.values()); location.hash = '#/tender/' + r.id + '/info'; }
        catch (e) { fail(e); ev.target.disabled = false; }
      } }, t('create'))));
  }

  // ---- tender ----------------------------------------------------------------------------------------------------
  const repriced = new Map();   // tender id -> last reprice result, shown once on the page
  async function pageTender(out, id, tab, focusId) {
    const T = await api('GET', 'tenders/' + id);
    let price = null, priceErr = null;
    try { price = await api('GET', `tenders/${id}/price`); } catch (e) { priceErr = e.message; }
    const frozen = price && price.frozen ? price.frozen : null;
    const editable = canWrite() && T.status === 'draft';
    const page = h('div', { id: 'page-tender' });

    // header
    page.append(h('div', { class: 'tender-head' },
      h('h1', null, T.title, ' ', badge(T.status)),
      h('div', { class: 'muted' }, [T.ref ? t('ref') + ': ' + T.ref : null, t('rev') + ' ' + T.rev, T.client, kindLabel(T.kind)].filter(Boolean).join(' · ')),
      h('div', { class: 'row wrap' }, workflowButtons(T), exportLinks(T, price))));

    // newer costs (yellow): never applied silently; reprice shows old vs new
    const rp = repriced.get(id);
    if (rp) {
      repriced.delete(id);
      page.append(h('div', { class: 'banner banner-info', id: 'reprice-result' }, h('strong', null, t('repriced')), ' ',
        t('old_price') + ': ', rp.old_P === null ? '—' : fmt2(rp.old_P), ' (' + (rp.old_complete ? t('complete') : t('partial')) + ') → ',
        t('new_price') + ': ', rp.new_P === null ? '—' : fmt2(rp.new_P), ' (' + (rp.new_complete ? t('complete') : t('partial')) + ')'));
    }
    const previewBox = h('div');
    if (price && price.newer_snapshot) {
      page.append(h('div', { class: 'banner banner-yellow', id: 'newer-banner' },
        t('newer_costs', { date: fmtTime(price.snapshot_created) || '—' }), ' ',
        editable ? h('button', { id: 'reprice', onclick: async ev => {
          ev.target.disabled = true;
          try { previewBox.replaceChildren(repricePreview(id, price, await api('GET', `tenders/${id}/price?snapshot=latest`))); }
          catch (e) { fail(e); }
          ev.target.disabled = false;
        } }, t('reprice_preview')) : null));
      page.append(previewBox);
    }

    const tabs = [['info', t('tab_info')], ['quantities', t('tab_quantities')], ['drawings', t('tab_drawings')], ['links', t('tab_links')], ['hidden', t('tab_hidden')], ['summary', t('tab_summary')]];
    if (!tabs.some(x => x[0] === tab)) tab = 'info';
    page.append(h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('a', { id: 'tab-' + k, href: `#/tender/${id}/${k}`, class: k === tab ? 'active' : null }, l))));
    const body = h('div', { id: 'tab-body-' + tab, class: 'tab-body' });
    page.append(body);
    const ctx = { T, id, price, priceErr, frozen, editable, focusId };
    if (tab === 'info') tabInfo(body, ctx);
    else if (tab === 'quantities') await tabQuantities(body, ctx);
    else if (tab === 'drawings') await tabDrawings(body, ctx);
    else if (tab === 'links') await tabLinks(body, ctx);
    else if (tab === 'hidden') await tabHidden(body, ctx);
    else tabSummary(body, ctx);
    out.append(page);
  }

  // old vs new before anything changes; only Apply rebinds the tender to the latest costs
  function repricePreview(id, cur, next) {
    const P = p => p && p.result ? fmt2(p.result.P) : '—';
    return h('div', { class: 'banner banner-info', id: 'reprice-preview-box' },
      h('strong', null, t('reprice_preview_title')), ' ',
      h('span', { id: 'reprice-old' }, t('old_price') + ': ', P(cur), ' (' + stateLabel(priceState(cur)) + ')'), ' → ',
      h('span', { id: 'reprice-new' }, t('new_price') + ': ', P(next), ' (' + stateLabel(priceState(next)) + ')'),
      ' · ' + t('snapshot_date') + ': ' + (fmtTime(next.snapshot_created) || '—'),
      next.blocking.length ? blockingList(id, next, 'reprice-blocking') : null,
      h('div', { class: 'row' }, h('button', { id: 'reprice-apply', onclick: async ev => {
        ev.target.disabled = true;
        try { repriced.set(id, await api('POST', `tenders/${id}/reprice`)); rerender(); } catch (e) { fail(e); ev.target.disabled = false; }
      } }, t('reprice_apply')), h('button', { class: 'secondary', onclick: ev => ev.target.closest('#reprice-preview-box').remove() }, t('cancel'))));
  }

  function workflowButtons(T) {
    const go = (path, body, then) => async ev => {
      ev.target.disabled = true;
      try { const r = await api('POST', `tenders/${T.id}/${path}`, body); if (then) then(r); else rerender(); }
      catch (e) { fail(e); ev.target.disabled = false; }
    };
    const b = [];
    if (canWrite() && T.status === 'draft') b.push(h('button', { id: 'wf-submit', onclick: go('submit') }, t('submit_for_approval')));
    if (isAdmin() && T.status === 'submitted') b.push(h('button', { class: 'secondary', id: 'wf-return', onclick: go('return') }, t('return_to_draft')));
    if (canWrite() && T.status === 'approved') b.push(h('button', { id: 'wf-send', onclick: go('send') }, t('mark_sent')));
    if (canWrite() && ['approved', 'sent'].includes(T.status)) b.push(h('button', { class: 'secondary', onclick: go('revise', null, r => { location.hash = '#/tender/' + r.id + '/info'; }) }, t('revise')));
    if (canWrite() && T.status === 'sent') {
      const res = sel('res-result', 'won', [['won', t('st_won')], ['lost', t('st_lost')]]), wp = inp('res-winner', '', { placeholder: t('winner_price'), inputmode: 'decimal' });
      b.push(h('span', { class: 'row' }, res, wp, h('button', { onclick: async ev => {
        ev.target.disabled = true;
        const body = { result: res.value };
        if (res.value === 'lost' && !blank(wp.value)) body.winner_price = wp.value.trim();
        try { await api('PUT', `tenders/${T.id}/result`, body); rerender(); } catch (e) { fail(e); ev.target.disabled = false; }
      } }, t('record_result'))));
    }
    if (T.result) b.push(h('span', null, t('result') + ': ' + statusLabel(T.result) + (fin(T.winner_price) ? ' · ' + t('winner_price') + ' ' + fmt2(T.winner_price) : '')));
    if (canWrite() && T.status === 'draft') b.push(h('button', { class: 'danger', onclick: async ev => {
      if (!confirm(t('delete_tender_confirm'))) return;
      ev.target.disabled = true;
      try { await api('DELETE', 'tenders/' + T.id); location.hash = '#/'; } catch (e) { fail(e); ev.target.disabled = false; }
    } }, t('delete')));
    return b;
  }

  function exportLinks(T, price) {
    const ready = price && (price.frozen || (price.result && price.complete && !price.blocking.length));
    const a = (kind, format, label) => h('a', { class: 'button secondary', href: `/api/tenders/${T.id}/export?format=${format}&kind=${kind}`, download: true }, label);
    const out = [h('span', { class: 'muted' }, t('export') + ':')];
    if (ready && !price.frozen) out.push(h('span', { class: 'tag', title: t('export_draft_note') }, t('export_draft')));   // the file is marked DRAFT until approved
    if (ready) out.push(a('client', 'xlsx', t('export_client_xlsx')), a('client', 'csv', t('export_client_csv')));
    else out.push(h('span', { class: 'button secondary disabled', title: t('export_client_blocked') }, t('export_client_xlsx')));
    if (canWrite()) out.push(a('internal', 'xlsx', t('export_internal_xlsx')), a('internal', 'csv', t('export_internal_csv')));
    return h('span', { class: 'row wrap' }, out);
  }

  // ---- tab: info ----
  function tabInfo(body, { T, editable }) {
    const x = infoFields('ti-', T, editable);
    const margin = inp('ti-margin', T.margin_pct, { inputmode: 'decimal', disabled: !(editable && isAdmin()) });
    if (isAdmin()) x.grid.append(field(t('margin_pct'), margin));
    else x.grid.append(field(t('margin'), h('span', null, fin(T.margin_pct) ? pctTxt(T.margin_pct) : t('margin_default'))));
    body.append(card(t('tab_info'), x.grid,
      editable ? h('button', { id: 'ti-save', onclick: async ev => {
        const b = x.values();
        if (isAdmin()) b.margin_pct = val(margin);
        ev.target.disabled = true;
        try { await api('PUT', 'tenders/' + T.id, b); flash(t('saved'), 'ok'); } catch (e) { fail(e); }
        ev.target.disabled = false;
      } }, t('save')) : h('p', { class: 'muted' }, T.status === 'draft' ? t('read_only') : t('only_draft_editable'))),
    card(null, h('dl', { class: 'kv' },
      h('dt', null, t('created')), h('dd', null, (fmtTime(T.created) || '') + (T.created_by ? ' · ' + T.created_by : '')),
      h('dt', null, t('approved_by')), h('dd', null, T.approved_by ? T.approved_by + ' · ' + fmtTime(T.approved_at) : '—'),
      h('dt', null, t('approved_price')), h('dd', null, fin(T.approved_P) ? fmt2(T.approved_P) : '—'))));
  }

  // ---- tab: quantities (import + take-off) ----
  const colName = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
  // measured vs client qty of a row (spec: a measurement never changes an imported row's qty). Mixed units are
  // never added together: shown as "mixed units" with each unit in the tooltip.
  const diffTxt = v => iso((v > 0 ? '+' : '') + v.toFixed(2) + ' %');
  function measuredCell(r) {
    if (r.is_heading) return null;
    const units = r.measured_units || [], out = [];
    if (units.length > 1) out.push(h('span', { class: 'tag bad', title: units.map(u => fmtQ(u.qty) + ' ' + u.unit).join(' · ') }, t('mixed_units')));
    else if (units.length === 1 && r.source === 'import') {
      out.push(h('span', { class: 'num' }, fmtQ(r.measured_qty) + ' ' + (r.measured_unit || '')));
      if (fin(r.measured_diff_pct)) out.push(h('span', { class: 'tag' + (r.measure_diff ? ' bad' : ''), title: t('measured_diff_title') }, diffTxt(r.measured_diff_pct)));
    }
    if (r.measured_incomplete) out.push(h('span', { class: 'tag bad' }, t('measured_incomplete')));
    if (r.measured_duplicate) out.push(h('span', { class: 'tag bad' }, t('measured_duplicate')));
    return out;
  }

  async function tabQuantities(body, { T, id, editable, focusId }) {
    const rows = await api('GET', `tenders/${id}/rows`);
    if (editable) body.append(importPanel(id, rows.some(r => r.source === 'import')));

    const tb = [];
    for (const r of rows) {
      const isTake = r.source === 'takeoff';
      const qtyCell = r.is_heading ? h('span', { class: 'tag' }, t('heading'))
        : editable && !isTake ? (() => {
          const q = inp('', r.qty, { class: 'w-num', inputmode: 'decimal' });
          return h('span', { class: 'row' }, q, h('button', { class: 'small', onclick: async () => {
            try { await api('PUT', `tenders/${id}/rows/${r.id}`, { qty: q.value }); rerender(); } catch (e) { fail(e); }
          } }, t('save')));
        })() : h('span', { class: 'num' }, fmtQ(r.qty));
      tb.push(h('tr', { id: 'row-' + r.id, class: [r.is_heading ? 'heading' : '', r.id === focusId ? 'focus' : ''].join(' ').trim() || null },
        h('td', null, r.no || ''), h('td', { class: 'desc' }, r.description || ''), h('td', null, r.unit || ''), h('td', { class: 'num qty' }, qtyCell),
        h('td', { class: 'num measured' }, measuredCell(r)), h('td', null, isTake ? t('src_takeoff') : t('src_import')),
        h('td', null, editable ? h('button', { class: 'small danger', onclick: async () => {
          if (!confirm(t('delete_row_confirm'))) return;
          try { await api('DELETE', `tenders/${id}/rows/${r.id}`); rerender(); } catch (e) { fail(e); }
        } }, t('delete')) : null)));
      if (isTake && !r.is_heading) tb.push(h('tr', { class: 'lines-row' }, h('td'), h('td', { colspan: 6 }, takeoffLines(id, r, editable))));
    }
    body.append(card(t('boq_rows'), h('p', { class: 'muted small' }, t('heading_hint')),
      rows.length ? table([t('no'), t('description'), t('unit'), t('qty'), t('measured'), t('source'), ''], tb, { class: 'grid boq' }) : h('p', { class: 'muted' }, t('no_rows'))));

    if (editable) {
      const no = inp('to-no', ''), desc = inp('to-desc', ''), unit = inp('to-unit', ''), head = h('input', { type: 'checkbox', id: 'to-heading' });
      body.append(card(t('add_takeoff_row'), h('div', { class: 'form-grid' }, field(t('no'), no), field(t('description'), desc), field(t('unit'), unit), field(t('is_heading'), head, 'check')),
        h('button', { onclick: async () => {
          try { await api('POST', `tenders/${id}/rows`, { no: no.value, description: desc.value, unit: unit.value, is_heading: head.checked }); rerender(); } catch (e) { fail(e); }
        } }, t('add'))));
    }
  }

  function takeoffLines(id, r, editable) {
    const lineInputs = l => ({ description: inp('', l.description, { class: 'w-desc' }), l: inp('', l.l, { class: 'w-num', inputmode: 'decimal' }), w: inp('', l.w, { class: 'w-num', inputmode: 'decimal' }),
      d: inp('', l.d, { class: 'w-num', inputmode: 'decimal' }), count: inp('', l.count, { class: 'w-num', inputmode: 'decimal' }), deduct: h('input', { type: 'checkbox', checked: !!l.deduct }) });
    const bodyOf = f => ({ description: f.description.value, l: val(f.l), w: val(f.w), d: val(f.d), count: val(f.count), deduct: f.deduct.checked });
    const rowsOut = r.lines.map(l => {
      if (!editable) return h('tr', null, h('td', null, l.description || ''), [l.l, l.w, l.d, l.count].map(x => h('td', { class: 'num' }, fmtQ(x))), h('td', null, l.deduct ? t('deduct') : ''), h('td'));
      const f = lineInputs(l);
      return h('tr', null, h('td', null, f.description), h('td', null, f.l), h('td', null, f.w), h('td', null, f.d), h('td', null, f.count), h('td', null, f.deduct),
        h('td', null, h('button', { class: 'small', onclick: async () => { try { await api('PUT', `tenders/${id}/rows/${r.id}/lines/${l.id}`, bodyOf(f)); rerender(); } catch (e) { fail(e); } } }, t('save')),
          h('button', { class: 'small danger', onclick: async () => { try { await api('DELETE', `tenders/${id}/rows/${r.id}/lines/${l.id}`); rerender(); } catch (e) { fail(e); } } }, '×')));
    });
    if (editable) {
      const f = lineInputs({});
      rowsOut.push(h('tr', { class: 'new' }, h('td', null, f.description), h('td', null, f.l), h('td', null, f.w), h('td', null, f.d), h('td', null, f.count), h('td', null, f.deduct),
        h('td', null, h('button', { class: 'small', onclick: async () => { try { await api('POST', `tenders/${id}/rows/${r.id}/lines`, bodyOf(f)); rerender(); } catch (e) { fail(e); } } }, t('add_line')))));
    }
    return h('div', null, h('div', { class: 'small muted' }, t('takeoff_lines') + ' — ' + t('takeoff_hint')),
      table([t('description'), t('len'), t('width'), t('depth'), t('count'), t('deduct'), ''], rowsOut, { class: 'grid lines' }));
  }

  function importPanel(id, hasImport) {
    const box = h('div');
    const file = h('input', { type: 'file', id: 'imp-file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    let b64 = null, sheets = [];
    const showPreview = () => {
      const sheetSel = sel('imp-sheet', sheets[0].name, sheets.map(s => [s.name, `${s.name} (${s.row_count})`]));
      const hdr = inp('imp-header', '1', { class: 'w-num', inputmode: 'numeric' });
      const cNo = inp('imp-col-no', 'A', { class: 'w-col' }), cDesc = inp('imp-col-desc', 'B', { class: 'w-col' }), cUnit = inp('imp-col-unit', 'C', { class: 'w-col' }), cQty = inp('imp-col-qty', 'D', { class: 'w-col' });
      const prev = h('div', { class: 'scroll' });
      const draw = () => {
        const s = sheets.find(x => x.name === sheetSel.value) || sheets[0];
        const width = Math.max(1, ...s.rows.map(r => r.length));
        prev.replaceChildren(table(['#', ...Array.from({ length: width }, (_, i) => colName(i))],
          s.rows.map((r, i) => h('tr', null, h('td', { class: 'muted' }, i + 1), Array.from({ length: width }, (_, j) => h('td', null, r[j] === null || r[j] === undefined ? '' : String(r[j]))))), { class: 'grid preview' }));
      };
      sheetSel.addEventListener('change', draw);
      draw();
      box.replaceChildren(
        h('div', { class: 'form-grid' }, field(t('sheet'), sheetSel), field(t('header_row'), hdr), field(t('col_no'), cNo), field(t('col_desc'), cDesc), field(t('col_unit'), cUnit), field(t('col_qty'), cQty)),
        h('p', { class: 'muted small' }, t('import_hint')), hasImport ? h('p', { class: 'warn' }, t('import_replaces')) : null,
        h('button', { id: 'imp-go', onclick: async ev => {
          const n = Number(hdr.value);
          ev.target.disabled = true;
          try {
            const r = await api('POST', `tenders/${id}/import`, { file_b64: b64, sheet: sheetSel.value, header_row: Number.isInteger(n) ? n : hdr.value, cols: { no: val(cNo), desc: val(cDesc), unit: val(cUnit), qty: val(cQty) } });
            flash(t('imported', { n: r.rows }) + (r.links_removed ? ' ' + t('links_removed', { n: r.links_removed }) : ''), r.links_removed ? 'warn' : 'ok');
            rerender();
          } catch (e) { fail(e); ev.target.disabled = false; }
        } }, t('import')),
        h('p', { class: 'muted small' }, t('preview_first_rows')), prev);
    };
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = async () => {
        b64 = String(rd.result).replace(/^data:[^,]*,/, '');
        try { sheets = (await api('POST', `tenders/${id}/import/preview`, { file_b64: b64 })).sheets; if (!sheets.length) throw new Error(t('no_sheets')); showPreview(); }
        catch (e) { fail(e); }
      };
      rd.onerror = () => fail(t('file_read_error'));
      rd.readAsDataURL(f);
    });
    return card(t('import_boq'), field(t('xlsx_file'), file), box);
  }

  // ---- tab: drawings (DXF upload, units, layer table, links to rows, measurements) ----
  // The server measures; the UI never computes a quantity. No number is shown before the units are confirmed.
  const DW_UNITS = ['mm', 'cm', 'm', 'km', 'ft', 'in'];
  const DW_MAX = 100 * 1024 * 1024;
  const metricLabel = m => ({ open_length: t('mt_open_length'), closed_perimeter: t('mt_closed_perimeter'), area: t('mt_area'), count: t('mt_count') })[m] || m;
  const dwStatusLabel = s => ({ parsing: t('dws_parsing'), ready: t('dws_ready'), failed: t('dws_failed') })[s] || s;
  const warnLabel = c => ({ unsupported_polyline: t('wc_unsupported_polyline'), self_intersecting: t('wc_self_intersecting'), hatch_open_loop: t('wc_hatch_open_loop'),
    hatch_cw_edge_unverified: t('wc_hatch_cw_edge_unverified'), hatch_no_boundary: t('wc_hatch_no_boundary'), hatch_loops_overlap: t('wc_hatch_loops_overlap'),
    unsupported_hatch_edge: t('wc_unsupported_hatch_edge'), paper_space: t('wc_paper_space'), xref: t('wc_xref'), nonplanar: t('wc_nonplanar'),
    missing_block: t('wc_missing_block'), z_ignored: t('wc_z_ignored'), degenerate_arc: t('wc_degenerate_arc'), possible_duplicate: t('wc_possible_duplicate') })[c] || c;
  const rowText = r => [r.no, r.description].filter(Boolean).join(' — ') || '#' + r.id;
  const rowOpts = rows => [['', t('lk_choose_row')], ...rows.filter(r => !r.is_heading).map(r => [String(r.id), rowText(r) + ' (' + (r.unit || '—') + ') · ' + (r.source === 'takeoff' ? t('src_takeoff') : t('src_import'))])];

  // a drawing being parsed: ask again with backoff (0.3 s doubling, at most 3 s; after a failed request at most 10 s)
  // while the same page is shown. Stops only when the page changes.
  function watchParse(did, onDone) {
    const tok = routeTok;
    let delay = 300;
    const tick = async () => {
      if (tok !== routeTok) return;
      let d;
      try { d = await api('GET', 'drawings/' + did); } catch (e) { delay = Math.min(delay * 2, 10000); setTimeout(tick, delay); return; }
      if (tok !== routeTok) return;
      if (d.status === 'parsing') { delay = Math.min(delay * 2, 3000); setTimeout(tick, delay); return; }
      whenFormsFree(tok, () => onDone(d));
    };
    setTimeout(tick, delay);
  }
  // a finished parse never wipes what the user is typing: wait while a link form is open or a relink row is chosen
  const formsBusy = () => !!document.getElementById('lk-form') || [...document.querySelectorAll('select.rl-row')].some(x => x.value);
  function whenFormsFree(tok, fn) {
    if (tok !== routeTok) return;
    if (formsBusy()) setTimeout(() => whenFormsFree(tok, fn), 1000); else fn();
  }

  function uploadPanel(id) {
    const name = inp('dw-name', '', { maxlength: 200 }), file = h('input', { type: 'file', id: 'dw-file', accept: '.dxf' });
    const msg = h('p', { id: 'dw-progress', class: 'muted' });
    const say = (text, cls) => { msg.className = cls || 'muted'; msg.textContent = text; };
    const btn = h('button', { id: 'dw-upload', onclick: async () => {
      const f = file.files && file.files[0];
      if (!f) return say(t('dw_no_file'), 'err');
      if (f.size > DW_MAX) return say(t('dw_too_large'), 'err');
      const title = val(name) || f.name.replace(/\.dxf$/i, '');
      btn.disabled = true;
      say(t('dw_uploading', { mb: (f.size / 1048576).toFixed(1) }));
      let r, j = null;
      try {
        r = await fetch(`/api/tenders/${id}/drawings?name=${encodeURIComponent(title)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
        try { j = await r.json(); } catch (e) { j = null; }
      } catch (e) { btn.disabled = false; return say(t('error') + ': ' + e.message, 'err'); }
      if (r.status === 401) { me = null; return renderLogin(); }
      // 413 (over 100 MB), 400 (binary DXF, no name), 409 (not a draft): the server's own words
      if (!r.ok) { btn.disabled = false; return say(t('error') + ': ' + ((j && j.error) || r.statusText || r.status), 'err'); }
      say(t('dw_parsing'));
      watchParse(j.id, d => { location.hash = `#/tender/${id}/drawings/${d.id}`; });
    } }, t('dw_upload'));
    return card(t('dw_upload_title'), h('div', { class: 'form-grid' }, field(t('dw_name'), name), field(t('dw_file'), file)), btn, msg);
  }

  async function tabDrawings(body, { T, id, editable, focusId }) {
    const [list, ms, rows] = await Promise.all([api('GET', `tenders/${id}/drawings`), api('GET', `tenders/${id}/measurements`), api('GET', `tenders/${id}/rows`)]);
    const box = h('div', { id: 'drawings', 'data-tender': String(id) });
    if (!editable) box.append(h('p', { class: 'muted' }, canWrite() && T.status !== 'draft' ? t('dw_read_only_note') : t('read_only')));
    if (editable) box.append(uploadPanel(id));
    const cur = list.find(d => d.id === focusId) || [...list].reverse().find(d => d.status === 'ready') || list[list.length - 1] || null;
    box.append(card(t('dw_list'), list.length ? h('div', { class: 'scroll' }, table([t('dw_name'), t('dw_status'), t('dw_units'), t('dw_size_mb'), t('created')], list.map(d =>
      h('tr', { class: cur && d.id === cur.id ? 'selected' : null }, h('td', null, h('a', { href: `#/tender/${id}/drawings/${d.id}`, dir: 'auto' }, d.name || '#' + d.id)),
        h('td', null, h('span', { class: 'tag' + (d.status === 'failed' ? ' bad' : d.status === 'ready' ? ' good' : '') }, dwStatusLabel(d.status))),
        h('td', null, d.units || '—'), h('td', { class: 'num' }, !fin(d.bytes) ? '—' : d.bytes < 10486 ? '< 0.01' : (d.bytes / 1048576).toFixed(2)),
        h('td', null, (fmtTime(d.created) || '') + (d.created_by ? ' · ' + d.created_by : '')))), { class: 'grid' })) : h('p', { class: 'muted' }, t('dw_none'))));
    for (const d of list.filter(x => x.status === 'parsing')) watchParse(d.id, () => rerender());
    if (cur && cur.status === 'ready') await drawingPanel(box, cur, ms, rows, editable);
    else if (cur && cur.status === 'failed') box.append(h('div', { class: 'banner banner-red' }, h('strong', null, t('dw_parse_failed')), ': ', cur.error || ''));
    else if (cur) box.append(h('p', { class: 'muted' }, t('dw_parsing')));
    box.append(measurementList(ms, rows, editable));
    body.append(box);
  }

  async function drawingPanel(box, cur, ms, rows, editable) {
    const [d, lt] = await Promise.all([api('GET', 'drawings/' + cur.id), api('GET', `drawings/${cur.id}/layers`)]);
    const confirmed = lt.units_confirmed, measured = [...ms.measurements, ...ms.unlinked].some(m => m.drawing_id === d.id);
    // units: the suggestion is pre-selected, nothing is computed until Confirm
    const unitSel = sel('dw-unit-select', d.units || d.suggested_units || '', [['', t('dw_choose_units')], ...DW_UNITS.map(u => [u, u])], { disabled: !editable || measured });
    const ignored = Object.entries(d.ignored || {});
    box.append(h('section', { class: 'card', id: 'dw-units' }, h('h2', null, t('dw_units_title'), ' — ', h('span', { dir: 'auto' }, d.name || '')),
      h('p', { class: 'muted small' }, d.suggested_units ? t('dw_suggested', { u: d.suggested_units }) : t('dw_no_suggested')),
      h('div', { class: 'row wrap' }, unitSel, editable && !measured ? h('button', { id: 'dw-confirm-units', onclick: async ev => {
        if (!unitSel.value) return flash(t('dw_choose_units'));
        ev.target.disabled = true;
        try { await api('PUT', `drawings/${d.id}/units`, { units: unitSel.value }); rerender(); } catch (e) { fail(e); ev.target.disabled = false; }
      } }, t('dw_confirm_units')) : null),
      confirmed ? h('p', { class: 'small' }, h('span', { class: 'tag good' }, t('dw_units_confirmed', { u: lt.units }))) : h('p', { class: 'warn' }, t('dw_units_note')),
      ignored.length ? h('p', { id: 'dw-ignored', class: 'small muted' }, t('dw_ignored') + ': ', ignored.map(([k, n]) => k + ' × ' + n).join(', ')) : null,
      drawingWarnings((lt.warnings || []).filter(w => w.code !== 'possible_duplicate'))));

    // layer table; possible duplicates sit next to their layer
    const dups = new Map();
    for (const w of lt.warnings || []) if (w.code === 'possible_duplicate' && w.detail && typeof w.detail === 'object') {
      if (!dups.has(w.detail.layer)) dups.set(w.detail.layer, []);
      dups.get(w.detail.layer).push(w.detail);
    }
    const canLink = editable && confirmed;
    const linkBtn = (tr, target, ncols) => h('button', { class: 'small secondary lk-btn', onclick: () => {
      const old = box.querySelector('#lk-form-row');
      if (old) old.remove();
      const fr = h('tr', { id: 'lk-form-row' }, h('td', { colspan: ncols }, linkForm({ drawing_id: d.id, ...target }, rows, () => fr.remove())));
      tr.after(fr);
    } }, t('dw_link'));
    const heads = [t('dw_layer'), t('dw_open_length'), t('dw_closed_perimeter'), t('dw_area'), t('dw_blocks'), t('dw_notes')];
    const trs = lt.layers.map(l => {
      const tr = h('tr', { 'data-layer': l.layer });
      const cell = metric => h('td', { class: 'num m-' + metric }, fin(l[metric])
        ? [h('span', { class: 'num' }, fmt2(l[metric])), canLink && l[metric] > 0 ? [' ', linkBtn(tr, { tool: 'dxf_layer', layer: l.layer, metric }, heads.length)] : null]
        : missing(t('dw_confirm_first')));
      const blocks = h('td', { class: 'm-blocks' }, !Array.isArray(l.blocks) ? missing(t('dw_confirm_first'))
        : l.blocks.map(b => h('div', { class: 'blk' }, h('span', { dir: 'auto' }, b.name), h('span', { class: 'num' }, ': ' + b.top + ' / ' + b.nested),
          canLink && b.top + b.nested > 0 ? [' ', linkBtn(tr, { tool: 'dxf_blocks', layer: l.layer, block: b.name, metric: 'count', has_nested: b.nested > 0 }, heads.length)] : null)));
      const notes = h('td', { class: 'notes' }, l.off ? h('span', { class: 'tag' }, t('dw_off')) : null, l.frozen ? h('span', { class: 'tag' }, t('dw_frozen')) : null,
        l.area_excluded > 0 ? h('span', { class: 'tag warn-tag' }, t('dw_area_excluded', { n: l.area_excluded })) : null,
        l.approx > 0 ? h('span', { class: 'tag warn-tag' }, t('dw_approx', { n: l.approx })) : null,
        l.dropped > 0 ? h('span', { class: 'tag warn-tag' }, t('dw_dropped', { n: l.dropped })) : null,
        (dups.get(l.layer) || []).map(x => h('span', { class: 'tag warn-tag' }, x.block ? t('dw_block_duplicates', { block: x.block, n: x.count }) : t('dw_duplicates', { n: x.count }))));
      tr.append(h('td', { class: 'layer-name' }, h('span', { dir: 'auto' }, l.layer)), cell('open_length'), cell('closed_perimeter'), cell('area'), blocks, notes);
      return tr;
    });
    box.append(card(t('dw_layers'), h('div', { class: 'scroll' }, table(heads, trs, { class: 'grid layers', id: 'dw-layers', 'data-units': confirmed ? lt.units : null }))));
  }

  // drawing-level warnings, one line per code with how many and the first few entity handles
  function drawingWarnings(ws) {
    if (!ws.length) return null;
    const by = new Map();
    for (const w of ws) { if (!by.has(w.code)) by.set(w.code, []); by.get(w.code).push(w.detail); }
    const det = v => v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return h('details', { id: 'dw-warnings', class: 'dw-warnings' }, h('summary', null, t('dw_warnings') + ' (' + ws.length + ')'),
      h('ul', null, [...by].map(([code, list]) => h('li', { 'data-code': code }, h('strong', null, warnLabel(code)), ' × ' + list.length + ' ', h('code', { class: 'muted' }, code),
        list.some(x => det(x)) ? h('div', { class: 'small muted', dir: 'auto' }, list.slice(0, 5).map(det).filter(Boolean).join(', ') + (list.length > 5 ? ', …' : '')) : null))));
  }

  // the server's refusal of a link: its message, plus a confirm box only for the refusals a user may confirm
  function linkRefusal(e, msg, addConfirm) {
    const j = e.body || {};
    msg.replaceChildren(h('p', { class: 'err' }, t('error') + ': ' + e.message));
    let box = false;
    if (e.status === 409 && j.error === 'unit mismatch') box = addConfirm('confirm_uom', t('lk_confirm_uom', { row: j.row_unit || '', qty: j.qty_unit || '' }));
    else if (e.status === 409 && j.error === 'already measured on this row') box = addConfirm('confirm_overlap', t('lk_confirm_overlap'));
    else if (e.status === 409 && j.error === 'possible duplicates on this layer') box = addConfirm('confirm_duplicate', t('lk_confirm_duplicate', { n: j.duplicates || 0 }));
    else if (e.status === 409 && j.error === 'layer quantity is incomplete') box = addConfirm('confirm_incomplete', t('lk_confirm_incomplete', { a: j.area_excluded || 0, b: j.approx || 0, c: j.dropped || 0 }));
    else if (e.status === 400 && /^unit mismatch/.test(j.error || '')) msg.append(h('p', { class: 'warn', id: 'lk-hint-width' }, t('lk_hint_width', { row: j.row_unit || '—', qty: j.qty_unit || '—' })));
    if (box) msg.append(h('p', { class: 'muted small' }, t('lk_tick_to_save')));
  }
  // width / depth / factor: plain digits with a dot only. "1,5" is refused, never read as 15 (or 1.5).
  const strictNum = (s, label) => {
    const x = String(s).trim();
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(x)) return Number(x);
    throw new Error(t('lk_bad_number', { field: label, v: x }));
  };
  // confirm checkboxes that stay once shown (a second refusal can follow the first)
  function confirmBoxes(prefix) {
    const boxes = {}, el = h('div');
    const add = (key, text) => {
      if (!boxes[key]) { boxes[key] = h('input', { type: 'checkbox', id: prefix + key.replace('_', '-') }); el.append(h('label', { class: 'field check' }, h('span', null, text), boxes[key])); }
      return true;
    };
    const flags = () => Object.fromEntries(Object.entries(boxes).filter(([, cb]) => cb.checked).map(([k]) => [k, true]));
    // a confirmation belongs to the row and numbers it was given for: any change drops it
    const reset = () => { for (const k of Object.keys(boxes)) delete boxes[k]; el.replaceChildren(); };
    return { el, add, flags, reset };
  }

  function linkForm(target, rows, close) {
    const len = target.metric === 'open_length' || target.metric === 'closed_perimeter', count = target.metric === 'count';
    const rowSel = sel('lk-row', '', rowOpts(rows));
    const w = len ? inp('lk-width', '', { class: 'w-num', inputmode: 'decimal' }) : null, dp = count ? null : inp('lk-depth', '', { class: 'w-num', inputmode: 'decimal' });
    const fac = inp('lk-factor', '', { class: 'w-num', inputmode: 'decimal', placeholder: '1' }), label = inp('lk-label', '', { maxlength: 200 });
    const nested = count && target.has_nested ? h('input', { type: 'checkbox', id: 'lk-nested' }) : null;
    const msg = h('div', { id: 'lk-msg' }), cb = confirmBoxes('lk-');
    const clear = () => { cb.reset(); msg.replaceChildren(); };
    rowSel.addEventListener('change', clear);
    for (const x of [w, dp, fac]) if (x) x.addEventListener('input', clear);
    const what = target.tool === 'dxf_blocks' ? [h('span', { dir: 'auto' }, target.layer), ' / ', h('span', { dir: 'auto' }, target.block), ' — ' + metricLabel('count')]
      : [h('span', { dir: 'auto' }, target.layer), ' — ' + metricLabel(target.metric)];
    const save = h('button', { id: 'lk-save', onclick: async () => {
      const b = { row_id: rowSel.value ? Number(rowSel.value) : null, tool: target.tool, layer: target.layer, metric: target.metric, ...cb.flags() };
      if (target.tool === 'dxf_blocks') { b.block = target.block; if (nested) b.nested = nested.checked; }
      try {
        if (w && !blank(w.value)) b.width = strictNum(w.value, t('width'));
        if (dp && !blank(dp.value)) b.depth = strictNum(dp.value, t('depth'));
        if (!blank(fac.value)) b.factor = strictNum(fac.value, t('lk_factor'));
      } catch (e) { msg.replaceChildren(h('p', { class: 'err' }, e.message)); return; }
      if (!blank(label.value)) b.label = label.value.trim();
      save.disabled = true;
      try { await api('POST', `drawings/${target.drawing_id}/measurements`, b); flash(t('saved'), 'ok'); rerender(); }
      catch (e) { save.disabled = false; linkRefusal(e, msg, cb.add); }
    } }, t('lk_save'));
    return h('div', { id: 'lk-form', class: 'lk-form' }, h('h3', null, t('lk_title')), h('p', null, t('lk_what') + ': ', what),
      h('div', { class: 'form-grid' }, field(t('lk_row'), rowSel, 'wide'), w ? field(t('width'), w) : null, dp ? field(t('depth'), dp) : null, field(t('lk_factor'), fac),
        field(t('lk_label'), label), nested ? field(t('lk_nested'), nested, 'check') : null),
      len || target.metric === 'area' ? h('p', { class: 'muted small' }, t('lk_dims_note')) : null,
      msg, cb.el, h('div', { class: 'row' }, save, h('button', { id: 'lk-cancel', class: 'secondary', onclick: close }, t('cancel'))));
  }

  // every measurement of the tender; unlinked first (after a re-import) with a row picker to relink
  function measurementList(ms, rows, editable) {
    const src = m => [h('span', { dir: 'auto' }, m.layer), m.block ? [' / ', h('span', { dir: 'auto' }, m.block), m.nested ? h('span', { class: 'tag' }, t('lk_nested')) : null] : null];
    const how = m => metricLabel(m.metric) + [m.width, m.depth].filter(fin).map(x => ' × ' + fmtQ(x)).join('') + (fin(m.factor) && m.factor !== 1 ? ' × ' + fmtQ(m.factor) : '');
    const flags = m => [m.incomplete ? h('span', { class: 'tag bad' }, t('m_incomplete')) : null, m.duplicate ? h('span', { class: 'tag bad' }, t('m_duplicate')) : null, m.uom_confirmed ? h('span', { class: 'tag' }, t('m_uom_confirmed')) : null];
    const del = m => editable ? h('button', { class: 'small danger m-delete', onclick: async ev => {
      if (!confirm(t('m_delete_confirm'))) return;
      ev.target.disabled = true;
      try { await api('DELETE', 'measurements/' + m.id); rerender(); } catch (e) { fail(e); ev.target.disabled = false; }
    } }, t('delete')) : null;
    const relink = m => {
      if (!editable) return null;
      const rs = sel('', '', rowOpts(rows), { class: 'w-item rl-row' }), msg = h('div'), cb = confirmBoxes('rl-' + m.id + '-');
      rs.addEventListener('change', () => { cb.reset(); msg.replaceChildren(); });
      const go = h('button', { class: 'small', onclick: async () => {
        go.disabled = true;
        try { await api('PUT', 'measurements/' + m.id, { row_id: rs.value ? Number(rs.value) : null, ...cb.flags() }); rerender(); }
        catch (e) { go.disabled = false; linkRefusal(e, msg, cb.add); }
      } }, t('m_relink'));
      return h('div', null, h('div', { class: 'row' }, rs, go), msg, cb.el);
    };
    const line = (m, last) => h('tr', { 'data-measurement': String(m.id), 'data-row': m.row_id === null ? null : String(m.row_id) },
      h('td', null, h('span', { dir: 'auto' }, m.label || '')), h('td', null, h('span', { dir: 'auto' }, m.drawing_name || '')), h('td', null, src(m)), h('td', null, how(m)),
      h('td', { class: 'num' }, fin(m.qty) ? fmt2(m.qty) : '—'), h('td', null, m.qty_unit || ''), h('td', null, flags(m)), h('td', null, last(m)), h('td', null, del(m)));
    const heads = [t('m_label'), t('m_drawing'), t('m_source'), t('m_metric'), t('qty'), t('unit'), '', t('row'), ''];
    return h('section', { class: 'card', id: 'dw-measurements' }, h('h2', null, t('measurements')),
      ms.unlinked.length ? [h('h3', { class: 'err' }, t('m_unlinked') + ' (' + ms.unlinked.length + ')'),
        h('div', { class: 'scroll' }, table(heads, ms.unlinked.map(m => line(m, relink)), { class: 'grid', id: 'dw-unlinked' }))] : null,
      ms.measurements.length ? h('div', { class: 'scroll' }, table(heads, ms.measurements.map(m => line(m, x => h('span', { dir: 'auto' }, [x.row_no, x.row_description].filter(Boolean).join(' — ') + ' (' + (x.row_unit || '—') + ')'))), { class: 'grid' }))
        : !ms.unlinked.length ? h('p', { class: 'muted' }, t('m_none')) : null);
  }

  // ---- tab: links (rows -> library items, manual unit rates, cost breakdown) ----
  async function tabLinks(body, { id, price, frozen, editable, focusId }) {
    const [rows, items] = await Promise.all([api('GET', `tenders/${id}/rows`), editable ? api('GET', 'library/items') : Promise.resolve([])]);
    const pRows = new Map(((frozen ? frozen.rows : price && price.rows) || []).map(r => [r.id, r]));
    const st = frozen ? 'complete' : priceState(price);
    const notPrice = { none: t('no_tender_price'), partial: t('partial_banner'), blocked: t('blocked_banner') }[st];
    const itemOpts = [['', '—'], ...items.map(i => [String(i.id), `${i.code} — ${nm(i)} (${i.uom})`])];
    const list = rows.filter(r => !r.is_heading);
    if (!list.length) { body.append(card(t('tab_links'), h('p', { class: 'muted' }, t('no_priced_rows')))); return; }
    body.append(h('p', { class: 'muted small' }, t('links_hint')));
    for (const r of list) {
      const pr = pRows.get(r.id);
      let state;
      if (r.manual_unit !== null) state = h('span', { class: 'tag' }, t('manual_rate'));
      else if (!r.links.length) state = h('span', { class: 'tag bad' }, t('blk_row_unlinked'));
      else if (pr && pr.direct_unit === null) state = h('span', { class: 'tag bad' }, t('blk_row_unpriced'));
      else state = h('span', { class: 'tag good' }, t('linked'));
      const breakdown = pr && pr.links.length ? table([t('item'), t('share'), t('unit_cost'), t('parts')], pr.links.map(l => h('tr', null,
        h('td', null, l.code + ' — ' + nm(l) + (l.version ? ' (v' + l.version + ')' : '')), h('td', { class: 'num' }, fmtQ(l.share)),
        h('td', { class: 'num' }, money(l.unit, l.missing && l.missing.length ? t('missing') + ': ' + l.missing.join(', ') : null)),
        h('td', null, l.parts.map(p => h('div', { class: 'part' }, partKindLabel(p.kind) + ': ', p.hidden ? h('span', { class: 'missing' }, '— ', h('small', null, t('hidden_part'))) : money(p.cost)))))), { class: 'grid inner' }) : null;

      let editor = null;
      if (editable) {
        const lines = r.links.map(l => ({ item_id: l.item_id, share: l.share }));
        const lbox = h('div');
        const draw = () => {
          lbox.replaceChildren(...lines.map((l, i) => {
            const s = sel('', l.item_id === null ? '' : String(l.item_id), itemOpts, { class: 'w-item', onchange: ev => { l.item_id = ev.target.value ? Number(ev.target.value) : null; } });
            const sh = inp('', l.share, { class: 'w-num', inputmode: 'decimal', onchange: ev => { l.share = pnum(ev.target.value); } });
            return h('div', { class: 'row' }, s, h('span', { class: 'muted' }, t('share')), sh, h('button', { class: 'small danger', onclick: () => { lines.splice(i, 1); draw(); } }, '×'));
          }), h('button', { class: 'small secondary', onclick: () => { lines.push({ item_id: null, share: lines.length ? null : 1 }); draw(); } }, t('add_link')));
        };
        draw();
        const mu = inp('', r.manual_unit, { class: 'w-num', inputmode: 'decimal' });
        editor = h('div', { class: 'editor' },
          h('div', null, h('strong', null, t('links')), lbox, h('button', { onclick: async () => {
            try { await api('PUT', `tenders/${id}/rows/${r.id}/links`, { links: lines.filter(l => l.item_id !== null).map(l => ({ item_id: l.item_id, share: l.share })) }); flash(t('saved'), 'ok'); rerender(); } catch (e) { fail(e); }
          } }, t('save_links'))),
          h('div', null, h('strong', null, t('manual_unit')), h('div', { class: 'row' }, mu, h('button', { class: 'small', onclick: async () => {
            try { await api('PUT', `tenders/${id}/rows/${r.id}`, { manual_unit: val(mu) }); flash(t('saved'), 'ok'); rerender(); } catch (e) { fail(e); }
          } }, t('save'))), h('div', { class: 'muted small' }, t('manual_unit_hint'))));
      }
      body.append(h('section', { class: 'card link-card' + (focusId === r.id ? ' focus' : ''), id: 'row-' + r.id },
        h('div', { class: 'row wrap' }, h('strong', null, (r.no ? r.no + ' ' : '') + (r.description || '')), h('span', { class: 'muted' }, fmtQ(r.qty) + ' ' + (r.unit || '')), state,
          h('span', { class: 'spacer' }), h('span', null, t('direct_unit') + ': ', pr ? money(pr.direct_unit, pr.direct_unit === null ? t('not_priced') : null) : '—'),
          h('span', { class: 'rate' }, t('rate') + ': ', st !== 'complete' ? missing(notPrice) : pr ? money(pr.rate, t('no_tender_price')) : '—')),
        r.qty === 0 ? h('p', { class: 'warn' }, t('blk_row_zero_qty')) : null,
        breakdown, editor));
    }
  }

  // ---- tab: hidden items ----
  async function tabHidden(body, { id, editable, focusId }) {
    const list = await api('GET', `tenders/${id}/hidden`);
    const FIELDS = { fixed: ['amount'], monthly: ['amount'], pct: ['pct'], locked: ['amount', 'months', 'bank_fee_pct', 'loss_pct'] };
    const rows = list.map(x => {
      const st = sel('', x.status || '', [['', t('hs_unanswered')], ['applies', t('hs_applies')], ['na', t('hs_na')], ['included', t('hs_included')]], { disabled: !editable });
      const f = {};
      for (const k of ['amount', 'pct', 'months', 'bank_fee_pct', 'loss_pct']) f[k] = FIELDS[x.kind].includes(k) ? inp('', x[k], { class: 'w-sm', inputmode: 'decimal', disabled: !editable }) : h('span', { class: 'muted' }, '');
      const note = inp('', x.note, { class: 'w-note', disabled: !editable });
      return h('tr', { id: 'hidden-' + x.id, class: (x.status === null ? 'unanswered' : '') + (focusId === x.id ? ' focus' : '') },
        h('td', null, nm(x)), h('td', null, hiddenKindLabel(x.kind)), h('td', null, st),
        ['amount', 'pct', 'months', 'bank_fee_pct', 'loss_pct'].map(k => h('td', null, f[k])), h('td', null, note),
        h('td', null, editable ? [h('button', { class: 'small', onclick: async () => {
          const b = { status: st.value || null, note: note.value };
          for (const k of FIELDS[x.kind]) b[k] = val(f[k]);
          try { await api('PUT', `tenders/${id}/hidden/${x.id}`, b); flash(t('saved'), 'ok'); rerender(); } catch (e) { fail(e); }
        } }, t('save')), x.template_id === null ? h('button', { class: 'small danger', onclick: async () => {
          try { await api('DELETE', `tenders/${id}/hidden/${x.id}`); rerender(); } catch (e) { fail(e); }
        } }, '×') : null] : null));
    });
    body.append(card(t('tab_hidden'), h('p', { class: 'muted small' }, t('hidden_hint')),
      h('div', { class: 'scroll' }, table([t('name'), t('kind'), t('answer'), t('amount'), t('pct'), t('months'), t('bank_fee_pct'), t('loss_pct'), t('note'), ''], rows, { class: 'grid' }))));
    if (editable) {
      const en = inp('nh-en', ''), ar = inp('nh-ar', ''), kind = sel('nh-kind', 'fixed', [['fixed', t('hk_fixed')], ['monthly', t('hk_monthly')], ['pct', t('hk_pct')], ['locked', t('hk_locked')]]);
      body.append(card(t('add_hidden_item'), h('div', { class: 'form-grid' }, field(t('name_en'), en), field(t('name_ar'), ar), field(t('kind'), kind)),
        h('button', { onclick: async () => { try { await api('POST', `tenders/${id}/hidden`, { name_en: en.value, name_ar: ar.value, kind: kind.value }); rerender(); } catch (e) { fail(e); } } }, t('add'))));
    }
  }

  // ---- tab: summary ----
  function tabSummary(body, ctx) {
    const box = h('div', { id: 'summary', 'data-tender': String(ctx.id) });
    body.append(box);
    if (ctx.frozen) return drawFrozen(box, ctx);
    if (!ctx.price) { box.append(h('div', { class: 'banner banner-red', id: 'price-banner' }, h('strong', null, t('no_price')), ' ', ctx.priceErr || '')); return; }
    drawSummary(box, ctx, ctx.price, null);
  }

  const resultRows = (r) => [
    ['D', t('c_D'), r.D], ['H', t('c_H'), r.H], ['OH', t('c_OH'), r.OH], ['F', t('c_F'), r.F], ['L', t('c_L'), r.L],
    ['C', t('c_C'), r.C], ['P_min', t('c_Pmin'), r.P_min], ['P', t('c_P'), r.P]];

  function threeNumbers(r, st) {
    const bad = st === 'partial' || st === 'blocked';
    const c = (id, label, v, note) => h('div', { class: 'big' + (bad ? ' partial' : '') + (id === 'P' ? ' main' : '') }, h('div', { class: 'label' }, label),
      h('div', { class: 'value', id: 'num-' + id }, fin(v) ? fmt2(v) : '—'), h('div', { class: 'small muted' }, note));
    return h('div', { class: 'three' }, c('C', t('true_cost'), r.C, t('true_cost_note')), c('Pmin', t('floor_price'), r.P_min, t('floor_note')),
      st === 'partial' ? c('P', t('partial_price'), r.P, t('partial_banner')) : st === 'blocked' ? c('P', t('blocked_price'), r.P, t('blocked_banner'))
        : c('P', t('proposed_price'), r.P, t('proposed_note')));
  }

  function waterfall(r) {
    const scale = Math.max(r.P, r.P_min, r.C);
    if (!(fin(scale) && scale > 0)) return h('div', { id: 'waterfall', class: 'waterfall' }, missing(t('no_value')));
    const w = v => Math.max(0, v / scale * 100).toFixed(3) + '%';
    const segs = [['D', t('c_D'), r.D], ['H', t('c_H'), r.H], ['OH', t('c_OH'), r.OH], ['F', t('c_F'), r.F], ['L', t('c_L'), r.L], ['M', t('c_margin'), r.P - r.C]];
    const bar = h('div', { class: 'wf-bar' }, segs.filter(s => fin(s[2]) && s[2] > 0).map(([k, l, v]) => h('div', { class: 'wf-seg wf-' + k, style: 'width:' + w(v), title: l + ': ' + fmt2(v) }, v / scale > 0.06 ? k : '')));
    const marks = h('div', { class: 'wf-marks' },
      [['C', r.C], ['P_min', r.P_min], ['P', r.P]].map(([k, v]) => h('div', { class: 'wf-mark', style: 'inset-inline-start:' + w(v) }, h('span', null, k))));
    return h('div', { id: 'waterfall', class: 'waterfall' }, h('div', { class: 'wf-wrap' }, bar, marks),
      h('div', { class: 'wf-legend' }, segs.map(([k, l, v]) => h('span', { class: 'wf-key' }, h('i', { class: 'wf-' + k }), l + ' ', h('span', { class: 'num' }, fmt2(v))))),
      r.P < r.P_min ? h('p', { class: 'warn' }, t('below_floor')) : null);
  }

  function costTable(r) {
    return table([t('component'), t('amount_aed')], [
      ...resultRows(r).map(([k, l, v]) => h('tr', { class: ['C', 'P_min', 'P'].includes(k) ? 'total' : null }, h('td', null, k + ' — ' + l), h('td', { class: 'num' }, money(v)))),
      h('tr', null, h('td', null, t('c_margin')), h('td', { class: 'num' }, money(r.P - r.C))),
      h('tr', null, h('td', null, t('room_to_floor')), h('td', { class: 'num' }, money(r.P - r.P_min))),
      h('tr', null, h('td', null, t('boq_total')), h('td', { class: 'num' }, money(r.total))),
      h('tr', null, h('td', null, t('rounding_diff')), h('td', { class: 'num' }, money(r.rounding_diff)))], { class: 'grid costs' });
  }

  function ohCompare(r) {
    return card(t('oh_compare'), h('dl', { class: 'kv' },
      h('dt', null, t('oh_this_method')), h('dd', null, money(r.OH)),
      h('dt', null, t('oh_flat')), h('dd', null, fin(r.OH_flat_compare) ? money(r.OH_flat_compare) : h('span', null, '—', h('small', { class: 'muted' }, ' ' + t('oh_flat_null'))))),
    h('p', { class: 'muted small' }, t('oh_compare_note')));
  }

  function scheduleTable(r) {
    if (!r.schedule || !r.schedule.length) return null;
    return h('details', { class: 'card' }, h('summary', null, t('cashflow')),
      h('div', { class: 'scroll' }, table([t('month'), t('cf_out'), t('cf_in'), t('cf_balance'), t('cf_cost')],
        r.schedule.map(x => h('tr', null, h('td', { class: 'num' }, x.month), h('td', { class: 'num' }, money(x.out)), h('td', { class: 'num' }, money(x.in)), h('td', { class: 'num' }, money(x.balance)), h('td', { class: 'num' }, money(x.cost)))), { class: 'grid' })));
  }

  function blockingList(id, p, listId) {
    const rows = new Map((p.rows || []).map(r => [r.id, r])), hid = new Map((p.hidden || []).map(x => [x.id, x]));
    return h('section', { class: 'card blocking' }, h('h2', null, t('blocking_title') + ' (' + p.blocking.length + ')'),
      h('ul', { id: listId || 'blocking-list' }, p.blocking.map(b => {
        let target = null;
        if (b.row_id) { const r = rows.get(b.row_id); target = h('a', { href: `#/tender/${id}/links/${b.row_id}` }, t('row') + ' ' + (r ? [r.no, r.description].filter(Boolean).join(' — ') : '#' + b.row_id)); }
        else if (b.hidden_id) { const x = hid.get(b.hidden_id); target = h('a', { href: `#/tender/${id}/hidden/${b.hidden_id}` }, t('hidden_item') + ' ' + (x ? nm(x) : '#' + b.hidden_id)); }
        else if (['no_snapshot', 'snapshot_stale', 'overhead_missing'].includes(b.code)) target = h('a', { href: '#/costs' }, t('nav_costs'));
        return h('li', null, h('strong', null, blockLabel(b.code)), target ? [' — ', target] : null, b.detail && b.code !== 'row_unpriced' ? h('span', { class: 'muted' }, ' (' + (b.code === 'snapshot_stale' ? fmtTime(b.detail) : b.detail) + ')') : null,
          b.code === 'row_unpriced' && b.detail ? h('span', { class: 'muted' }, ' (' + t('missing') + ': ' + b.detail + ')') : null);
      })));
  }

  // imported rows whose measured qty differs from the client's by more than 5 %: listed, never blocking
  function measureWarningList(id, p) {
    const rows = new Map((p.rows || []).map(r => [r.id, r]));
    return h('section', { class: 'card', id: 'measure-warnings' }, h('h2', null, t('measure_warnings_title') + ' (' + p.measure_warnings.length + ')'),
      h('p', { class: 'muted small' }, t('measure_warnings_note')),
      h('ul', null, p.measure_warnings.map(w => {
        const r = rows.get(w.row_id);
        return h('li', null, h('a', { href: `#/tender/${id}/quantities/${w.row_id}` }, t('row') + ' ' + (r ? [r.no, r.description].filter(Boolean).join(' — ') : '#' + w.row_id)),
          ' ', h('span', { class: 'tag bad' }, fin(w.diff_pct) ? diffTxt(w.diff_pct) : '—'));
      })));
  }

  function drawSummary(box, ctx, p, whatIf) {
    const { id, T } = ctx, r = p.result, st = priceState(p);
    box.replaceChildren();
    if (whatIf) box.append(h('div', { class: 'banner banner-info', id: 'whatif-note' }, h('strong', null, t('whatif_note')), ' ',
      h('button', { class: 'small secondary', onclick: () => drawSummary(box, ctx, ctx.price, null) }, t('reset'))));
    if (!r) box.append(h('div', { class: 'banner banner-red', id: 'price-banner' }, h('strong', null, t('no_price')), p.error ? ' — ' + p.error : ''));
    else if (st === 'partial') box.append(h('div', { class: 'banner banner-red', id: 'price-banner' }, h('strong', null, t('partial_banner')), ' ',
      t('partial_detail', { rows: p.excluded_rows.length, hidden: p.unanswered_hidden.length })));
    else if (st === 'blocked') box.append(h('div', { class: 'banner banner-red', id: 'price-banner' }, h('strong', null, t('blocked_banner')), ' ', t('blocked_detail')));
    if (p.blocking.length) box.append(blockingList(id, p));
    if ((p.snapshot_warnings || []).length) box.append(snapshotWarnings(p.snapshot_warnings));
    if ((p.measure_warnings || []).length) box.append(measureWarningList(id, p));

    if (r) {
      box.append(threeNumbers(r, st));
      box.append(card(t('waterfall'), waterfall(r), costTable(r)));
      box.append(ohCompare(r));
    }

    // inputs and what-if
    const inpts = p.inputs || {};
    const runWhatIf = async (margin, M, cd) => {
      const q = new URLSearchParams(), w = { M, cd };
      if (margin !== null && margin !== undefined) { w.margin = margin; if (!blank(margin)) q.set('margin_pct', String(margin).trim()); }
      if (!blank(M)) q.set('M', String(M).trim());
      if (!blank(cd)) q.set('collection_days', String(cd).trim());
      drawSummary(box, ctx, await api('GET', `tenders/${id}/price?${q}`), w);
    };
    const wiM = inp('wi-M', whatIf && whatIf.M !== undefined ? whatIf.M : inpts.M, { class: 'w-num', inputmode: 'numeric' });
    const wiCd = inp('wi-cd', whatIf && whatIf.cd !== undefined ? whatIf.cd : inpts.collection_days, { class: 'w-num', inputmode: 'decimal' });
    const wiMargin = isAdmin() ? inp('wi-margin', whatIf && whatIf.margin !== undefined ? whatIf.margin : p.margin_pct, { class: 'w-num', inputmode: 'decimal' }) : null;
    box.append(h('div', { class: 'cols' },
      card(t('inputs_used'), h('dl', { class: 'kv' },
        h('dt', null, t('snapshot_date')), h('dd', null, fmtTime(p.snapshot_created) || '—'),
        h('dt', null, t('margin')), h('dd', null, pctTxt(p.margin_pct)),
        h('dt', null, t('duration_months')), h('dd', null, inpts.M ?? '—'),
        h('dt', null, t('adv_pct')), h('dd', null, pctTxt(inpts.adv_pct)),
        h('dt', null, t('ret_pct')), h('dd', null, pctTxt(inpts.ret_pct)),
        h('dt', null, t('collection_days')), h('dd', null, inpts.collection_days ?? '—'),
        h('dt', null, t('retention_months')), h('dd', null, inpts.retention_months ?? '—'),
        h('dt', null, t('finance_rate')), h('dd', null, pctTxt(inpts.finance_rate_pct)),
        h('dt', null, t('min_profit')), h('dd', null, pctTxt(inpts.min_profit_pct)),
        h('dt', null, t('oh_monthly')), h('dd', null, money(inpts.oh_monthly, t('oh_missing'))),
        h('dt', null, t('w_monthly')), h('dd', null, money(inpts.w_monthly, t('no_value'))))),
      card(t('whatif'), h('p', { class: 'muted small' }, t('whatif_hint')),
        h('div', { class: 'form-grid' }, wiMargin ? field(t('margin_pct'), wiMargin) : null, field(t('duration_months'), wiM), field(t('collection_days'), wiCd)),
        h('button', { id: 'wi-apply', onclick: async ev => {
          ev.target.disabled = true;
          try { await runWhatIf(wiMargin ? wiMargin.value : null, wiM.value, wiCd.value); } catch (e) { fail(e); ev.target.disabled = false; }
        } }, t('whatif_apply')))));

    // approval: only when the numbers on screen are what approval will freeze (saved M and collection days)
    const saved = ctx.price.inputs || {};
    const sameTerms = !whatIf || (inpts.M === saved.M && inpts.collection_days === saved.collection_days);
    if (isAdmin() && T.status === 'submitted' && sameTerms) box.append(approvePanel(ctx, p, m => runWhatIf(m, saved.M, saved.collection_days)));
    if (r) { const s = scheduleTable(r); if (s) box.append(s); }
  }

  // warnings of the cost snapshot this price uses: approval needs them acknowledged
  function snapshotWarnings(ws, listId) {
    return h('section', { class: 'card warnings' }, h('h2', null, t('snapshot_warnings_title') + ' (' + ws.length + ')'),
      h('ul', { id: listId || 'snapshot-warnings' }, ws.map(w => h('li', null, h('code', null, w.code), w.detail ? ' — ' + w.detail : ''))),
      h('p', { class: 'muted small' }, t('snapshot_warnings_note')));
  }

  function approvePanel(ctx, p, repriceAt) {
    const onlyStale = p.blocking.length > 0 && p.blocking.every(b => b.code === 'snapshot_stale');
    const margin = inp('ap-margin', p.margin_pct, { class: 'w-num', inputmode: 'decimal' });
    const override = onlyStale ? h('input', { type: 'checkbox', id: 'ap-override' }) : null;
    const can = !!p.result && p.complete && (!p.blocking.length || onlyStale);
    const ack = (p.snapshot_warnings || []).length ? h('input', { type: 'checkbox', id: 'ap-ack' }) : null;
    let same = true;
    const msg = h('div');
    // a typed margin that differs from the margin of the numbers shown must be priced first
    const changed = h('div', { id: 'ap-margin-changed', class: 'warn', hidden: true }, t('approve_margin_changed'), ' ',
      h('button', { class: 'small', id: 'ap-reprice', onclick: async ev => { ev.target.disabled = true; try { await repriceAt(margin.value); } catch (e) { fail(e); ev.target.disabled = false; } } }, t('approve_price_at_margin')));
    const btn = h('button', { id: 'ap-approve', disabled: !can || !!ack, onclick: async ev => {
        const b = { margin_pct: p.margin_pct, expected_P: p.result.P };
        if (override) b.override_stale = override.checked;
        if (ack) b.ack_warnings = ack.checked;
        ev.target.disabled = true;
        try { await api('POST', `tenders/${ctx.id}/approve`, b); flash(t('approved_ok'), 'ok'); rerender(); }
        catch (e) {
          fail(e); ev.target.disabled = false;
          if (e.body && e.body.blocking) msg.replaceChildren(blockingList(ctx.id, { ...p, blocking: e.body.blocking }, 'approve-blocking'));
          if (e.body && e.body.warnings) msg.replaceChildren(snapshotWarnings(e.body.warnings, 'approve-warnings'));
          if (e.body && fin(e.body.P)) msg.replaceChildren(h('p', { class: 'err', id: 'approve-price-changed' }, t('approve_price_changed') + ' ' + fmt2(e.body.P)));
        }
      } }, t('approve'));
    const refresh = () => { btn.disabled = !can || !same || (!!ack && !ack.checked); };
    margin.addEventListener('input', () => {
      same = pnum(margin.value) === p.margin_pct;
      changed.hidden = same;
      refresh();
    });
    if (ack) ack.addEventListener('change', refresh);
    return card(t('approve_title'),
      h('div', { class: 'form-grid' }, field(t('margin_pct'), margin), override ? field(t('override_stale'), override, 'check') : null, ack ? field(t('ack_warnings'), ack, 'check') : null),
      changed, onlyStale ? h('p', { class: 'warn' }, t('override_stale_note')) : null,
      !can ? h('p', { class: 'err' }, t('approve_blocked')) : null, btn, msg);
  }

  function drawFrozen(box, { frozen: f }) {
    box.append(h('div', { class: 'banner banner-ok' }, h('strong', null, t('frozen_price')), ' ',
      t('approved_by') + ': ' + (f.approved_by || '—') + ' · ' + (fmtTime(f.approved_at) || '') + ' · ' + t('snapshot_date') + ': ' + (fmtTime(f.snapshot_created) || '—') + ' · ' + t('margin') + ': ' + pctTxt(f.margin_pct)),
    );
    if (f.override_stale) box.append(h('p', { class: 'warn' }, t('approved_on_stale')));
    if ((f.snapshot_warnings || []).length) box.append(h('p', { class: 'warn', id: 'frozen-warnings' }, t('approved_with_warnings') + ': ', f.snapshot_warnings.map((c, i) => [i ? ', ' : '', h('code', null, c)])));
    box.append(threeNumbers(f, 'complete'), card(t('waterfall'), waterfall(f), costTable(f)), ohCompare(f));
    const s = scheduleTable(f); if (s) box.append(s);
  }

  // ---- company costs -----------------------------------------------------------------------------------------------
  async function pageCosts(out, st) {
    const page = h('div', { id: 'page-costs' });
    out.append(page);
    page.append(h('div', { class: 'row' }, h('h1', null, t('nav_costs')), h('span', { class: 'spacer' }),
      canWrite() ? h('button', { onclick: ev => syncNow(ev.target) }, t('sync_now')) : null));
    const snap = st && st.last_ok_id ? await api('GET', 'costs/snapshot') : null;
    if (!snap) page.append(h('div', { class: 'banner banner-red' }, t('no_snapshot_yet')));
    else {
      page.append(card(t('overhead'), h('dl', { class: 'kv' },
        h('dt', null, t('last_good_sync')), h('dd', null, fmtTime(st.last_ok) || '—'),
        h('dt', null, t('oh_monthly')), h('dd', null, money(snap.oh_monthly, t('oh_missing')), snap.oh_overridden ? h('span', { class: 'tag' }, t('overridden')) : null),
        h('dt', null, t('months_covered')), h('dd', null, snap.months_covered ?? '—'),
        h('dt', null, t('w_monthly')), h('dd', null, money(snap.w_monthly, t('no_value'))),
        snap.oh_parts ? [h('dt', null, t('oh_bills')), h('dd', null, money(snap.oh_parts.bills)), h('dt', null, t('oh_payroll')), h('dd', null, money(snap.oh_parts.payroll)),
          h('dt', null, t('oh_depreciation')), h('dd', null, money(snap.oh_parts.depreciation, t('no_value')))] : null),
        snap.oh_parts ? h('p', { class: 'muted small' }, t('oh_parts_note')) : null));
      page.append(card(t('trades'), table([t('trade'), t('group'), t('rate_per_hour'), isAdmin() ? t('headcount') : null, ''].filter(x => x !== null),
        (snap.trades || []).map(x => h('tr', null, h('td', null, x.trade), h('td', null, x.group), h('td', { class: 'num' }, money(x.rate, x.via_group ? t('group_rate_hidden') : t('no_valid_rate'))),
          isAdmin() ? h('td', { class: 'num' }, x.headcount ?? '') : null,
          h('td', null, x.via_group ? h('span', { class: 'tag' }, t('via_group')) : null, x.overridden ? h('span', { class: 'tag' }, t('overridden')) : null))), { class: 'grid' }),
      table([t('group'), t('rate_per_hour'), isAdmin() ? t('headcount') : null].filter(x => x !== null),
        (snap.groups || []).map(g => h('tr', null, h('td', null, g.group), h('td', { class: 'num' }, money(g.rate, t('group_rate_hidden'))), isAdmin() ? h('td', { class: 'num' }, g.headcount ?? '') : null)), { class: 'grid' })));
      page.append(card(t('equipment'), (snap.equipment || []).length ? table([t('id'), t('name'), t('source'), t('rate_per_hour'), ''],
        snap.equipment.map(e => h('tr', null, h('td', null, e.id), h('td', null, e.name || ''), h('td', null, e.source === 'hired' ? t('hired') : t('owned')),
          h('td', { class: 'num' }, money(e.rate, t('no_valid_rate'))), h('td', null, e.overridden ? h('span', { class: 'tag' }, t('overridden')) : null))), { class: 'grid' }) : h('p', { class: 'muted' }, t('none'))));
      const um = snap.unmapped || {};
      if ((snap.warnings || []).length || (um.categories || []).length || (um.designations || []).length) page.append(card(t('warnings'),
        h('ul', null, (snap.warnings || []).map(w => h('li', null, h('code', null, w.code), w.detail ? ' — ' + w.detail : ''))),
        (um.categories || []).length ? h('p', null, t('unmapped_categories') + ': ' + um.categories.join(', ')) : null,
        (um.designations || []).length ? h('p', null, t('unmapped_designations') + ': ' + um.designations.join(', ')) : null,
        isAdmin() ? h('a', { href: '#/settings' }, t('fix_in_settings')) : null));
    }
    if (isAdmin()) {
      const cfg = await api('GET', 'costs/config');
      const sugg = ['oh_monthly', ...((snap && snap.trades) || []).map(x => 'trade:' + x.trade), ...((snap && snap.equipment) || []).map(e => 'equip:' + e.id)];
      page.append(mapEditor(t('overrides'), cfg.overrides || {}, { keyLabel: t('override_key'), valLabel: t('override_value'), numeric: true, suggestions: sugg.filter(k => !(k in (cfg.overrides || {}))),
        note: t('overrides_note'), save: o => api('PUT', 'costs/config', { overrides: o }) }));
    }
    if (canWrite()) await materialsSection(page);
  }

  async function materialsSection(page) {
    const mats = await api('GET', 'costs/materials');
    const box = card(t('materials'), h('p', { class: 'muted small' }, t('materials_hint')));
    page.append(box);
    box.append(table([t('code'), t('name'), t('unit'), ''], mats.map(m => {
      const detail = h('div');
      return [h('tr', null, h('td', null, m.code || ''), h('td', null, nm(m)), h('td', null, m.unit),
        h('td', null, h('button', { class: 'small secondary', onclick: async () => { if (detail.childNodes.length) detail.replaceChildren(); else await materialDetail(detail, m); } }, t('quotes_links')),
          isAdmin() ? h('button', { class: 'small danger', onclick: async () => { if (!confirm(t('delete_material_confirm'))) return; try { await api('DELETE', 'costs/materials/' + m.id); rerender(); } catch (e) { fail(e); } } }, t('delete')) : null)),
      h('tr', { class: 'lines-row' }, h('td', { colspan: 4 }, detail))];
    }), { class: 'grid' }));
    const code = inp('m-code', ''), en = inp('m-en', ''), ar = inp('m-ar', ''), unit = inp('m-unit', '');
    box.append(h('h3', null, t('add_material')), h('div', { class: 'form-grid' }, field(t('code'), code), field(t('name_en'), en), field(t('name_ar'), ar), field(t('unit'), unit)),
      h('button', { onclick: async () => { try { await api('POST', 'costs/materials', { code: code.value, name_en: en.value, name_ar: ar.value, unit: unit.value }); rerender(); } catch (e) { fail(e); } } }, t('add')));
  }

  async function materialDetail(box, m) {
    const [quotes, links] = await Promise.all([api('GET', `costs/materials/${m.id}/quotes`), api('GET', `costs/materials/${m.id}/links`)]);
    const redraw = () => materialDetail(box, m).catch(fail);
    const qd = inp('', new Date().toISOString().slice(0, 10), { type: 'date' }), qs = inp('', '', { placeholder: t('supplier') }), qr = inp('', '', { class: 'w-num', inputmode: 'decimal', placeholder: t('rate') });
    const ld = inp('', '', { placeholder: t('po_description') }), lu = inp('', '', { class: 'w-col', placeholder: t('unit') });
    box.replaceChildren(h('div', { class: 'cols' },
      h('div', null, h('h4', null, t('quotes')), table([t('date'), t('supplier'), t('rate'), ''], quotes.map(q => h('tr', null, h('td', null, q.date), h('td', null, q.supplier || ''), h('td', { class: 'num' }, money(q.rate)),
        h('td', null, h('button', { class: 'small danger', onclick: async () => { try { await api('DELETE', `costs/materials/${m.id}/quotes/${q.id}`); redraw(); } catch (e) { fail(e); } } }, '×')))), { class: 'grid' }),
        h('div', { class: 'row' }, qd, qs, qr, h('button', { class: 'small', onclick: async () => { try { await api('POST', `costs/materials/${m.id}/quotes`, { date: qd.value, supplier: qs.value, rate: qr.value }); redraw(); } catch (e) { fail(e); } } }, t('add')))),
      h('div', null, h('h4', null, t('po_links')), h('p', { class: 'muted small' }, t('po_links_hint')), table([t('po_description'), t('unit'), ''], links.map(l => h('tr', null, h('td', null, l.description_norm), h('td', null, l.unit),
        h('td', null, h('button', { class: 'small danger', onclick: async () => { try { await api('DELETE', `costs/materials/${m.id}/links/${l.id}`); redraw(); } catch (e) { fail(e); } } }, '×')))), { class: 'grid' }),
        h('div', { class: 'row' }, ld, lu, h('button', { class: 'small', onclick: async () => { try { await api('POST', `costs/materials/${m.id}/links`, { description: ld.value, unit: lu.value }); redraw(); } catch (e) { fail(e); } } }, t('add'))))));
  }

  // key -> value editor for cost config maps and overrides
  function mapEditor(title, obj, o) {
    const entries = Object.entries(obj).map(([k, v]) => ({ k, v: String(v) }));
    const box = card(title, o.note ? h('p', { class: 'muted small' }, o.note) : null);
    const list = h('div');
    const draw = () => {
      list.replaceChildren(table([o.keyLabel, o.valLabel, ''], entries.map((e, i) => h('tr', null,
        h('td', null, inp('', e.k, { class: 'w-desc', oninput: ev => { e.k = ev.target.value; } })),
        h('td', null, o.options ? sel('', e.v, [['', '—'], ...o.options], { onchange: ev => { e.v = ev.target.value; } }) : inp('', e.v, { class: o.numeric ? 'w-num' : 'w-desc', inputmode: o.numeric ? 'decimal' : null, oninput: ev => { e.v = ev.target.value; } })),
        h('td', null, h('button', { class: 'small danger', onclick: () => { entries.splice(i, 1); draw(); } }, '×')))), { class: 'grid' }),
      h('div', { class: 'row wrap' }, h('button', { class: 'small secondary', onclick: () => { entries.push({ k: '', v: '' }); draw(); } }, t('add_entry')),
        (o.suggestions || []).filter(s => !entries.some(e => e.k === s)).slice(0, 40).map(s => h('button', { class: 'small secondary', title: t('add_entry'), onclick: () => { entries.push({ k: s, v: '' }); draw(); } }, '+ ' + s))));
    };
    draw();
    box.append(list, h('button', { onclick: async ev => {
      const out = {};
      for (const e of entries) if (!blank(e.k)) out[e.k.trim()] = o.numeric ? e.v.trim() : e.v;
      ev.target.disabled = true;
      try { await o.save(out); flash(t('saved'), 'ok'); } catch (e) { fail(e); }
      ev.target.disabled = false;
    } }, t('save')));
    return box;
  }

  // ---- item library ------------------------------------------------------------------------------------------------
  let libSection = null;
  async function pageLibrary(out, st) {
    const [sections, items] = await Promise.all([api('GET', 'library/sections'), api('GET', 'library/items')]);
    const page = h('div', { id: 'page-library' });
    out.append(page);
    page.append(h('h1', null, t('nav_library')));
    const secName = id => { const s = sections.find(x => x.id === id); return s ? nm(s) : '#' + id; };
    const editorBox = h('div');
    const shown = items.filter(i => libSection === null || i.section_id === libSection);
    page.append(h('div', { class: 'lib' },
      h('aside', { class: 'card sections' }, h('h2', null, t('sections')),
        h('ul', null, h('li', null, h('a', { href: '#/library', class: libSection === null ? 'active' : null, onclick: ev => { ev.preventDefault(); libSection = null; rerender(); } }, t('all'))),
          sections.map(s => h('li', null, h('a', { href: '#/library', class: libSection === s.id ? 'active' : null, onclick: ev => { ev.preventDefault(); libSection = s.id; rerender(); } }, nm(s)),
            s.default_rework_pct ? h('small', { class: 'muted' }, ' ' + pctTxt(s.default_rework_pct)) : null))),
        canWrite() ? sectionForm() : null),
      h('div', null,
        card(t('items'), canWrite() ? h('button', { id: 'new-item', onclick: () => itemEditor(editorBox, null, sections, st).catch(fail) }, t('new_item')) : null,
          shown.length ? table([t('code'), t('name'), t('section'), t('unit'), t('version'), t('unit_cost'), t('parts'), ''], shown.map(i => h('tr', null,
            h('td', null, i.code), h('td', null, nm(i)), h('td', null, secName(i.section_id)), h('td', null, i.uom), h('td', { class: 'num' }, 'v' + i.version),
            h('td', { class: 'num' }, money(i.unit, i.missing && i.missing.length ? t('missing') + ': ' + i.missing.join(', ') : null)),
            h('td', null, i.parts.map(p => h('div', { class: 'part' }, partKindLabel(p.kind) + ': ', p.hidden ? h('span', { class: 'missing' }, '— ', h('small', null, t('hidden_part'))) : money(p.cost)))),
            h('td', null, canWrite() ? h('button', { class: 'small secondary', onclick: () => itemEditor(editorBox, i, sections, st).catch(fail) }, t('edit')) : null))), { class: 'grid' }) : h('p', { class: 'muted' }, t('none'))),
        editorBox)));
  }

  function sectionForm() {
    const en = inp('sec-en', ''), ar = inp('sec-ar', ''), rw = inp('sec-rework', '', { class: 'w-num', inputmode: 'decimal' });
    return h('div', { class: 'stack' }, h('h3', null, t('add_section')), field(t('name_en'), en), field(t('name_ar'), ar), field(t('default_rework_pct'), rw),
      h('button', { onclick: async () => {
        const b = { name_en: en.value, name_ar: ar.value };
        if (!blank(rw.value)) b.default_rework_pct = pnum(rw.value);
        try { await api('POST', 'library/sections', b); rerender(); } catch (e) { fail(e); }
      } }, t('add')));
  }

  async function itemEditor(box, item, sections, st) {
    const [mats, snap, versions] = await Promise.all([api('GET', 'costs/materials'), st && st.last_ok_id ? api('GET', 'costs/snapshot') : Promise.resolve(null),
      item ? api('GET', `library/items/${item.id}/versions`) : Promise.resolve([])]);
    const cur = versions.length ? versions[versions.length - 1].data : { rework_pct: null, condition_factor: 1, parts: [] };
    const parts = cur.parts.map(p => ({ ...p, crewText: p.crew ? p.crew.map(c => c.trade + ':' + c.count).join(', ') : '' }));
    const code = inp('it-code', item ? item.code : ''), uom = inp('it-uom', item ? item.uom : ''), en = inp('it-en', item ? item.name_en : ''), ar = inp('it-ar', item ? item.name_ar : '');
    const sec = sel('it-section', item ? String(item.section_id) : (libSection !== null ? String(libSection) : String(sections[0] && sections[0].id)), sections.map(s => [String(s.id), nm(s)]));
    const rw = inp('it-rework', cur.rework_pct, { class: 'w-num', inputmode: 'decimal', placeholder: t('section_default') }), cf = inp('it-cf', cur.condition_factor, { class: 'w-num', inputmode: 'decimal' });
    const trades = h('datalist', { id: 'dl-trades' }, ((snap && snap.trades) || []).map(x => h('option', { value: x.trade })));
    const equipOpts = [['', '—'], ...((snap && snap.equipment) || []).map(e => [e.id, `${e.id} — ${e.name || ''}`])];
    const matOpts = [['', '—'], ...mats.map(m => [String(m.id), `${m.code ? m.code + ' — ' : ''}${nm(m)} (${m.unit})`])];
    const plist = h('div');
    const num = (p, k, ph) => inp('', p[k], { class: 'w-num', inputmode: 'decimal', placeholder: ph, oninput: ev => { p[k] = ev.target.value; } });
    const draw = () => {
      plist.replaceChildren(...parts.map((p, i) => {
        const kind = sel('', p.kind, [['material', t('pk_material')], ['labour', t('pk_labour')], ['equipment', t('pk_equipment')], ['sub', t('pk_sub')], ['fixed', t('pk_fixed')]],
          { onchange: ev => { parts[i] = { kind: ev.target.value, crewText: '' }; draw(); } });
        let f;
        if (p.kind === 'material') {
          const opts = p.material_id && !mats.some(m => m.id === p.material_id) ? [...matOpts, [String(p.material_id), '#' + p.material_id]] : matOpts;
          f = [sel('', p.material_id ? String(p.material_id) : '', opts, { onchange: ev => { p.material_id = ev.target.value ? Number(ev.target.value) : null; } }),
            field(t('qty_per_unit'), num(p, 'qty')), field(t('waste_pct'), num(p, 'waste_pct'))];
        } else if (p.kind === 'labour') {
          f = [field(t('crew'), inp('', p.crewText, { class: 'w-desc', list: 'dl-trades', placeholder: t('crew_ph'), oninput: ev => { p.crewText = ev.target.value; } })), field(t('output_per_day'), num(p, 'output_per_day'))];
        } else if (p.kind === 'equipment') {
          const opts = p.equipment_id && !equipOpts.some(o => o[0] === p.equipment_id) ? [...equipOpts, [p.equipment_id, p.equipment_id]] : equipOpts;
          f = [sel('', p.equipment_id || '', opts, { onchange: ev => { p.equipment_id = ev.target.value || null; } }), field(t('output_per_hour'), num(p, 'output_per_hour'))];
        } else if (p.kind === 'sub') f = [field(t('sub_rate'), num(p, 'rate'))];
        else f = [field(t('fixed_amount'), num(p, 'amount'))];
        return h('div', { class: 'part-row row wrap' }, kind, f, h('button', { class: 'small danger', onclick: () => { parts.splice(i, 1); draw(); } }, '×'));
      }), h('button', { class: 'small secondary', onclick: () => { parts.push({ kind: 'material', crewText: '' }); draw(); } }, t('add_part')));
    };
    draw();
    const clean = () => parts.map(p => {
      if (p.kind === 'material') {
        if (blank(p.waste_pct)) throw new Error(t('waste_required'));
        return { kind: 'material', material_id: p.material_id ?? null, qty: pnum(p.qty), waste_pct: pnum(p.waste_pct) };
      }
      if (p.kind === 'labour') return { kind: 'labour', output_per_day: pnum(p.output_per_day), crew: p.crewText.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const m = /^(.*?)\s*[:x×]\s*(\d+)$/.exec(s);
        return m ? { trade: m[1].trim(), count: Number(m[2]) } : { trade: s, count: 1 };
      }) };
      if (p.kind === 'equipment') return { kind: 'equipment', equipment_id: p.equipment_id || null, output_per_hour: pnum(p.output_per_hour) };
      if (p.kind === 'sub') return { kind: 'sub', rate: pnum(p.rate) };
      return { kind: 'fixed', amount: pnum(p.amount) };
    });
    box.replaceChildren(card(item ? t('edit_item') + ' ' + item.code + ' (v' + item.version + ')' : t('new_item'), trades,
      h('div', { class: 'form-grid' }, field(t('code'), code), field(t('section'), sec), field(t('unit'), uom), field(t('name_en'), en), field(t('name_ar'), ar),
        field(t('rework_pct'), rw), field(t('condition_factor'), cf)),
      h('h3', null, t('parts')), plist,
      item ? h('p', { class: 'muted small' }, t('new_version_note')) : null,
      h('div', { class: 'row' }, h('button', { id: 'it-save', onclick: async ev => {
        let b;
        try { b = { code: code.value, section_id: Number(sec.value), uom: uom.value, name_en: en.value, name_ar: ar.value, rework_pct: pnum(rw.value), condition_factor: pnum(cf.value), parts: clean() }; }
        catch (e) { fail(e); return; }
        ev.target.disabled = true;
        try { await api(item ? 'PUT' : 'POST', item ? 'library/items/' + item.id : 'library/items', b); flash(t('saved'), 'ok'); rerender(); } catch (e) { fail(e); ev.target.disabled = false; }
      } }, t('save')), h('button', { class: 'secondary', onclick: () => box.replaceChildren() }, t('cancel'))),
      versions.length ? h('details', null, h('summary', null, t('versions') + ' (' + versions.length + ')'),
        h('ul', null, versions.map(v => h('li', null, 'v' + v.version + ' · ' + fmtTime(v.created) + ' · ' + (v.created_by || ''))))) : null));
    box.scrollIntoView({ block: 'start' });
  }

  // ---- settings (admin) ------------------------------------------------------------------------------------------------
  async function pageSettings(out) {
    const [s, cfg, users, tpls, st] = await Promise.all([api('GET', 'settings'), api('GET', 'costs/config'), api('GET', 'users'), api('GET', 'hidden-templates'), api('GET', 'costs/status')]);
    const snap = st.last_ok_id ? await api('GET', 'costs/snapshot') : null;
    const page = h('div', { id: 'page-settings' });
    out.append(page);
    page.append(h('h1', null, t('nav_settings')));

    const labels = { erp_db_path: t('set_erp_db_path'), work_days: t('set_work_days'), work_hours: t('set_work_hours'), finance_rate_pct: t('set_finance_rate_pct'), min_profit_pct: t('set_min_profit_pct'),
      default_margin_pct: t('set_default_margin_pct'), stale_days: t('set_stale_days'), material_stale_days: t('set_material_stale_days'), sync_minutes: t('set_sync_minutes') };
    const ins = Object.fromEntries(Object.keys(labels).map(k => [k, inp('set-' + k, s[k], k === 'erp_db_path' ? { class: 'w-path' } : { class: 'w-num', inputmode: 'decimal' })]));
    page.append(card(t('general_settings'), h('div', { class: 'form-grid' }, Object.keys(labels).map(k => field(labels[k], ins[k], k === 'erp_db_path' ? 'wide' : ''))),
      h('div', { class: 'row' }, h('button', { id: 'set-save', onclick: async ev => {
        const b = {};
        for (const k of Object.keys(labels)) if (ins[k].value !== String(s[k])) b[k] = ins[k].value;
        if (!Object.keys(b).length) { flash(t('nothing_changed'), 'ok'); return; }
        ev.target.disabled = true;
        try { Object.assign(s, await api('PUT', 'settings', b)); flash(t('saved'), 'ok'); } catch (e) { fail(e); }
        ev.target.disabled = false;
      } }, t('save')), h('button', { class: 'secondary', onclick: ev => syncNow(ev.target) }, t('sync_now')))));

    const um = (snap && snap.unmapped) || { categories: [], designations: [] };
    const catOpts = ['overhead', 'labour_oncost', 'equipment', 'project', 'ignore'].map(k => [k, catKindLabel(k)]);
    const saveCfg = key => o => api('PUT', 'costs/config', { [key]: o });
    page.append(mapEditor(t('category_map'), cfg.category_map || {}, { keyLabel: t('erp_category'), valLabel: t('category_kind'), options: catOpts, suggestions: um.categories || [], note: t('category_map_note'), save: saveCfg('category_map') }));
    page.append(mapEditor(t('trade_map'), cfg.trade_map || {}, { keyLabel: t('erp_designation'), valLabel: t('trade'), suggestions: um.designations || [], note: t('trade_map_note'), save: saveCfg('trade_map') }));
    const tradeNames = [...new Set(Object.values(cfg.trade_map || {}))];
    page.append(mapEditor(t('trade_groups'), cfg.trade_groups || {}, { keyLabel: t('trade'), valLabel: t('group'), suggestions: tradeNames, note: t('trade_groups_note'), save: saveCfg('trade_groups') }));

    // users
    const un = inp('u-name', ''), upw = inp('u-pw', '', { type: 'password', autocomplete: 'new-password' }), ur = sel('u-role', 'qs', [['qs', t('role_qs')], ['viewer', t('role_viewer')], ['admin', t('role_admin')]]);
    const roleOpts = [['qs', t('role_qs')], ['viewer', t('role_viewer')], ['admin', t('role_admin')]];
    const urow = u => {
      const role = sel('', u.role, roleOpts), on = h('input', { type: 'checkbox', checked: !u.disabled }), pw = inp('', '', { type: 'password', autocomplete: 'new-password', placeholder: t('new_password') });
      const put = async (b, done) => { try { await api('PUT', 'users/' + u.id, b); flash(done, 'ok'); rerender(); } catch (e) { fail(e); } };
      return h('tr', { id: 'user-' + u.id, class: u.disabled ? 'muted' : null }, h('td', null, u.username), h('td', null, role), h('td', null, on), h('td', null, fmtTime(u.created)),
        h('td', null, h('button', { class: 'small', onclick: () => {
          const b = {};
          if (role.value !== u.role) b.role = role.value;
          if (on.checked === !!u.disabled) b.disabled = !on.checked;
          if (!Object.keys(b).length) { flash(t('nothing_changed'), 'ok'); return; }
          if (confirm(t('user_change_confirm'))) put(b, t('saved'));
        } }, t('save'))),
        h('td', null, h('span', { class: 'row' }, pw, h('button', { class: 'small secondary', onclick: () => { if (confirm(t('user_change_confirm'))) put({ password: pw.value }, t('password_reset_done')); } }, t('reset_password')))));
    };
    page.append(card(t('users'), h('p', { class: 'muted small' }, t('users_note')),
      h('div', { class: 'scroll' }, table([t('username'), t('role'), t('active'), t('created'), '', t('reset_password')], users.map(urow), { class: 'grid' })),
      h('h3', null, t('add_user')), h('div', { class: 'form-grid' }, field(t('username'), un), field(t('password'), upw), field(t('role'), ur)),
      h('button', { onclick: async () => { try { await api('POST', 'users', { username: un.value, password: upw.value, role: ur.value }); flash(t('saved'), 'ok'); rerender(); } catch (e) { fail(e); } } }, t('add'))));

    // hidden-cost templates
    const kindOpts = [['fixed', t('hk_fixed')], ['monthly', t('hk_monthly')], ['pct', t('hk_pct')], ['locked', t('hk_locked')]];
    const trow = x => {
      const en = inp('', x.name_en, { class: 'w-desc' }), ar = inp('', x.name_ar, { class: 'w-desc' }), kind = sel('', x.kind, kindOpts), sort = inp('', x.sort, { class: 'w-col', inputmode: 'numeric' });
      const act = h('input', { type: 'checkbox', checked: !!x.active });
      return h('tr', null, h('td', null, en), h('td', null, ar), h('td', null, kind), h('td', null, sort), h('td', null, act),
        h('td', null, h('button', { class: 'small', onclick: async () => {
          try { await api('PUT', 'hidden-templates/' + x.id, { name_en: en.value, name_ar: ar.value, kind: kind.value, sort: pnum(sort.value) ?? 0, active: act.checked ? 1 : 0 }); flash(t('saved'), 'ok'); } catch (e) { fail(e); }
        } }, t('save'))));
    };
    const nen = inp('tpl-en', ''), nar = inp('tpl-ar', ''), nk = sel('tpl-kind', 'fixed', kindOpts);
    page.append(card(t('hidden_templates'), h('p', { class: 'muted small' }, t('hidden_templates_note')),
      h('div', { class: 'scroll' }, table([t('name_en'), t('name_ar'), t('kind'), t('sort'), t('active'), ''], tpls.map(trow), { class: 'grid' })),
      h('h3', null, t('add_template')), h('div', { class: 'form-grid' }, field(t('name_en'), nen), field(t('name_ar'), nar), field(t('kind'), nk)),
      h('button', { onclick: async () => { try { await api('POST', 'hidden-templates', { name_en: nen.value, name_ar: nar.value, kind: nk.value }); rerender(); } catch (e) { fail(e); } } }, t('add'))));
  }

  // ---- boot ---------------------------------------------------------------------------------------------------------
  async function boot() {
    applyLang();
    let st;
    try { st = await api('GET', 'status'); } catch (e) { $('#root').replaceChildren(h('div', { class: 'banner banner-red' }, t('server_unreachable'))); return; }
    me = st.user; setupMode = st.setup;
    if (!me) return renderLogin();
    renderShell();
    await route();
  }
  window.addEventListener('hashchange', () => { if (me) route(true); });
  boot();
})();
