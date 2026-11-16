// Drawing viewer on a <canvas>: draws a decoded display file (window.TV, public/viewer/core.js) and turns mouse input
// into a view, a selection, a hover and a snap point. No text, no quantities: the page (app.js) shows those.
// Display only: every saved quantity is computed on the server from the exact parse cache.
//
//   TVCanvas.create(canvas, R, { alive, onSelect, onHover, onCursor }) -> viewer
//   TVCanvas.layerColor(aci) -> '#rrggbb' readable on the dark background
//
// Drawing: only TV.visible() entities, one draw per animation frame at most. The entities go into a cached base layer
// (redrawn when the view, layers or selection change); hover outline, snap marker and rubber band are drawn over it.
// window.__tvLastFrameMs = the last frame's duration (test hook). destroy() removes every listener; when alive() turns
// false (the page changed), the next frame destroys the viewer.
'use strict';
(function () {
const BG = '#1e1e1e', LIGHT = '#e0e0e0', SEL = '#ffa726', HI = '#26c6da', HOVER = 'rgba(255,255,255,0.45)', SNAP = '#00e676';
const KIND_CLOSED = 1, KIND_INSERT = 2, KIND_TEXT = 3;
const CLICK_PX = 5, SNAP_PX = 10, DRAG_PX = 3;

// relative luminance (WCAG) of #rrggbb
function lum(hex) {
  const c = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
// ACI 0 (by block), 7 (black/white), 250 and any colour too dark for the dark canvas -> a light theme colour
function layerColor(aci) {
  const i = Math.abs(Number(aci));
  if (!Number.isInteger(i) || i < 1 || i > 255 || i === 7 || i === 250) return LIGHT;
  const hex = window.TV_ACI[i];
  return !hex || lum(hex) < 0.15 ? LIGHT : hex;
}

function create(canvas, R, opts) {
  const TV = window.TV, o = opts || {}, n = R.n;
  const G = TV.buildGrid(R);
  const layerOn = new Uint8Array(R.layers.length);
  R.layers.forEach((l, i) => { layerOn[i] = l.off || l.frozen ? 0 : 1; });
  const colors = R.layers.map(l => layerColor(l.color));
  const slots = [...new Set(colors)], slotOf = Uint32Array.from(colors.map(c => slots.indexOf(c)));
  const sel = new Uint8Array(n), hi = new Uint8Array(n);
  let nSel = 0, nHi = 0, handleIdx = null;
  let V = null, fitScale = 1, W = 0, H = 0, dpr = 1;
  let mode = 'select', snapOn = false, mouse = null, moved = false, hover = -1, snapPt = null, band = null, drag = null;
  let baseDirty = true, raf = 0, dead = false;
  const base = document.createElement('canvas'), ctx = canvas.getContext('2d'), bctx = base.getContext('2d');

  const isPoint = i => R.kind[i] === KIND_INSERT || R.kind[i] === KIND_TEXT || R.count[i] === 1;
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const tol = px => px / V.scale;

  // one entity's paths into the current path, in CSS pixels; a NaN pair starts a new subpath
  function trace(c, i) {
    const s = V.scale, ex = (R.eo[2 * i] - V.ox) * s + V.tx, ey = -(R.eo[2 * i + 1] - V.oy) * s + V.ty;
    const p = R.pts, st = R.start[i], e = st + R.count[i];
    if (isPoint(i)) {
      const x = ex + p[2 * st] * s, y = ey - p[2 * st + 1] * s, r = R.kind[i] === KIND_TEXT ? 2 : 4;
      c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r);
      return;
    }
    const closed = R.kind[i] === KIND_CLOSED;
    let m = 0;
    for (let k = st; k < e; k++) {
      const px = p[2 * k], py = p[2 * k + 1];
      if (px !== px || py !== py) { if (closed && m > 2) c.closePath(); m = 0; continue; }
      const x = ex + px * s, y = ey - py * s;
      if (m === 0) c.moveTo(x, y); else c.lineTo(x, y);
      m++;
    }
    if (closed && m > 2) c.closePath();
  }

  function drawBase() {
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.fillStyle = BG; bctx.fillRect(0, 0, base.width, base.height);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const a = TV.toWorld(V, 0, H), b = TV.toWorld(V, W, 0);
    const vis = TV.visible(G, R, [a[0], a[1], b[0], b[1]], layerOn);
    // bucket by colour (a counting sort), one stroke per colour
    const cnt = new Uint32Array(slots.length + 1);
    for (let k = 0; k < vis.length; k++) cnt[slotOf[R.layer[vis[k]]] + 1]++;
    for (let c = 0; c < slots.length; c++) cnt[c + 1] += cnt[c];
    const order = new Uint32Array(vis.length), fill = cnt.slice(0, slots.length);
    for (let k = 0; k < vis.length; k++) order[fill[slotOf[R.layer[vis[k]]]]++] = vis[k];
    bctx.lineWidth = 1; bctx.lineJoin = 'round';
    for (let c = 0; c < slots.length; c++) {
      if (cnt[c] === cnt[c + 1]) continue;
      bctx.beginPath();
      for (let k = cnt[c]; k < cnt[c + 1]; k++) trace(bctx, order[k]);
      bctx.strokeStyle = slots[c]; bctx.stroke();
    }
    for (const [flags, any, colour] of [[hi, nHi, HI], [sel, nSel, SEL]]) {
      if (!any) continue;
      bctx.beginPath();
      for (let k = 0; k < vis.length; k++) if (flags[vis[k]]) trace(bctx, vis[k]);
      bctx.lineWidth = 2; bctx.strokeStyle = colour; bctx.stroke();
    }
  }

  function frame() {
    raf = 0;
    if (dead) return;
    if (o.alive && !o.alive()) { destroy(); return; }
    const t0 = performance.now();
    if (baseDirty) { drawBase(); baseDirty = false; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (moved) {
      moved = false;
      const w = mouse ? TV.toWorld(V, mouse[0], mouse[1]) : null;
      const h = w && !drag ? TV.hitTest(G, R, w[0], w[1], tol(CLICK_PX), layerOn) : -1;
      snapPt = w && snapOn && !drag ? TV.snap(G, R, w[0], w[1], tol(SNAP_PX), layerOn) : null;
      if (h !== hover) { hover = h; if (o.onHover) o.onHover(hover); }
    }
    if (hover >= 0 && layerOn[R.layer[hover]]) {
      ctx.beginPath(); trace(ctx, hover);
      ctx.lineWidth = 5; ctx.strokeStyle = HOVER; ctx.stroke();
    }
    if (snapPt) {
      const [x, y] = TV.toScreen(V, snapPt.x, snapPt.y);
      ctx.beginPath();
      if (snapPt.kind === 'end') ctx.rect(x - 5, y - 5, 10, 10);
      else { ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y + 5); ctx.lineTo(x - 6, y + 5); ctx.closePath(); }
      ctx.lineWidth = 2; ctx.strokeStyle = SNAP; ctx.stroke();
    }
    if (band) {
      const x = Math.min(band[0], band[2]), y = Math.min(band[1], band[3]), w = Math.abs(band[2] - band[0]), h = Math.abs(band[3] - band[1]);
      const win = mode === 'window';
      ctx.setLineDash(win ? [] : [6, 4]);
      ctx.fillStyle = win ? 'rgba(79,195,247,0.12)' : 'rgba(129,199,132,0.12)'; ctx.fillRect(x, y, w, h);
      ctx.lineWidth = 1; ctx.strokeStyle = win ? '#4fc3f7' : '#81c784'; ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
    window.__tvLastFrameMs = performance.now() - t0;
  }
  function schedule(full) {
    if (full) baseDirty = true;
    if (!raf && !dead) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    dpr = window.devicePixelRatio || 1;
    W = w; H = h;
    canvas.width = base.width = Math.round(w * dpr);
    canvas.height = base.height = Math.round(h * dpr);
    if (!V) fit();
    schedule(true);
  }
  function fit() {
    V = TV.makeView(R.bbox, W || 1, H || 1, R.origin);
    fitScale = V.scale;
    schedule(true);
  }

  // ---- selection ----
  const changed = () => { if (o.onSelect) o.onSelect(); schedule(true); };
  function setSel(list, how) {   // how: replace | add | toggle
    if (how === 'replace' && nSel) { sel.fill(0); nSel = 0; }
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (how === 'toggle' && sel[i]) { sel[i] = 0; nSel--; } else if (!sel[i]) { sel[i] = 1; nSel++; }
    }
    changed();
  }
  const indices = flags => { const out = []; for (let i = 0; i < n; i++) if (flags[i]) out.push(i); return Uint32Array.from(out); };
  const byHandle = () => { if (!handleIdx) { handleIdx = new Map(); R.handles.forEach((hd, i) => handleIdx.set(hd, i)); } return handleIdx; };

  // ---- input ----
  function onWheel(e) {
    e.preventDefault();
    const [x, y] = pos(e), dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const f = Math.min(2, Math.max(0.5, Math.pow(1.0015, -dy)));
    const s = V.scale * f;
    if (s < fitScale * 1e-3 || s > fitScale * 1e7) return;
    V = TV.zoomAt(V, x, y, f);
    moved = true; schedule(true);
  }
  function onDown(e) {
    if (drag) return;
    const [x, y] = pos(e);
    if (e.button === 1 || e.button === 2) { e.preventDefault(); drag = { pan: true, x, y }; }
    else if (e.button === 0) drag = { pan: false, x0: x, y0: y, shift: e.shiftKey };
    else return;
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onUp);
  }
  function onDragMove(e) {
    const [x, y] = pos(e);
    if (drag.pan) { V = TV.pan(V, x - drag.x, y - drag.y); drag.x = x; drag.y = y; schedule(true); return; }
    if (mode !== 'select' && (band || Math.abs(x - drag.x0) > DRAG_PX || Math.abs(y - drag.y0) > DRAG_PX)) { band = [drag.x0, drag.y0, x, y]; schedule(); }
  }
  function onUp(e) {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onUp);
    const d = drag;
    drag = null;
    if (!d || d.pan) return;
    const [x, y] = pos(e);
    if (band) {
      const a = TV.toWorld(V, band[0], band[1]), b = TV.toWorld(V, band[2], band[3]);
      band = null;
      setSel(TV.boxSelect(G, R, [a[0], a[1], b[0], b[1]], mode, layerOn), d.shift ? 'add' : 'replace');
      return;
    }
    const w = TV.toWorld(V, x, y), i = TV.hitTest(G, R, w[0], w[1], tol(CLICK_PX), layerOn);
    if (d.shift) { if (i >= 0) setSel([i], 'toggle'); } else setSel(i >= 0 ? [i] : [], 'replace');
  }
  function onMove(e) {
    mouse = pos(e); moved = true;
    if (o.onCursor) o.onCursor(TV.toWorld(V, mouse[0], mouse[1]));
    schedule();
  }
  function onLeave() { mouse = null; moved = true; schedule(); }
  const noMenu = e => e.preventDefault();

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('contextmenu', noMenu);
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(resize); ro.observe(canvas); } else window.addEventListener('resize', resize);
  resize();

  function destroy() {
    if (dead) return;
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    canvas.removeEventListener('wheel', onWheel, { passive: false });
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('mouseleave', onLeave);
    canvas.removeEventListener('contextmenu', noMenu);
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onUp);
    if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
  }

  return {
    canvas, R,
    view: () => V,
    fit,
    setMode(m) { mode = m === 'window' || m === 'crossing' ? m : 'select'; },
    setSnap(on) { snapOn = !!on; moved = true; if (!snapOn) snapPt = null; schedule(); },
    snapPoint: () => snapPt,
    layerOn: i => layerOn[i] === 1,
    // a hidden layer leaves the selection (nothing invisible is ever linked)
    setLayers(list, on) {
      for (const i of list) layerOn[i] = on ? 1 : 0;
      if (!on) for (let i = 0; i < n; i++) if (sel[i] && !layerOn[R.layer[i]]) { sel[i] = 0; nSel--; }
      moved = true; changed();
    },
    selection: () => indices(sel),
    selectedHandles: () => Array.from(indices(sel), i => R.handles[i]),
    clear() { sel.fill(0); hi.fill(0); nSel = nHi = 0; changed(); },
    // a saved selection's entities, read only (another colour, not part of the selection); the view fits them
    highlight(handles) {
      hi.fill(0); nHi = 0;
      const m = byHandle(), bb = G.bb;
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const hd of handles) {
        const i = m.get(hd);
        if (i === undefined || hi[i]) continue;
        hi[i] = 1; nHi++;
        if (bb[4 * i] === bb[4 * i]) { a = Math.min(a, bb[4 * i]); b = Math.min(b, bb[4 * i + 1]); c = Math.max(c, bb[4 * i + 2]); d = Math.max(d, bb[4 * i + 3]); }
      }
      if (a !== Infinity) {
        const pad = Math.max(c - a, d - b, 1 / fitScale * 50) * 0.5;
        V = TV.makeView([a + G.ox - pad, b + G.oy - pad, c + G.ox + pad, d + G.oy + pad], W || 1, H || 1, R.origin);
      }
      schedule(true);
      return nHi;
    },
    highlightedHandles: () => Array.from(indices(hi), i => R.handles[i]),
    destroy,
  };
}

window.TVCanvas = { create, layerColor };
})();
