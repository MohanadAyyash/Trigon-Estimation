// PDF page and image viewer on a <canvas>: the page under the same view transform as the DXF viewer (core.js), wheel zoom
// at the cursor, pan, fit. Display only: no quantities (the measuring tools draw through the hooks below).
//
//   TVRaster.create(container, { kind: 'pdf'|'image', url, page, pageW, pageH, rotation, alive, onCursor, onClick, onDraw })
//     -> engine (a <canvas class="tv-raster"> is added to container)
//   TVRaster.pdfjs() -> Promise<pdf.js module> (vendored /vendor/pdfjs, loaded once, worker set; never a CDN)
//
// Coordinates (R12):
//   page    = what is stored. PDF: unrotated PDF user space (points, y up), absolute: a page box that does not start at
//             (0, 0) keeps its own coordinates (R16), as pdf.js viewport.convertToPdfPoint gives; a page's /Rotate never
//             changes a page point or a length. Image: pixels, y down, origin at the top-left, in the frame the browser
//             displays (R17): createImageBitmap applies the EXIF orientation. Orientations that keep the size (2, 3, 4, and
//             5–8 on a square image) are accepted in that displayed frame; lengths are unaffected (a mirror or turn is an
//             isometry). One that swaps width and height no longer matches the size the server read from the file
//             header: refused with error.code 'image_frame' ({ width, height } displayed, { pageW, pageH } stored).
//   display = the page as shown: the pdf.js viewport at scale 1 with the row's rotation (y down); an image's pixels.
//   world   = (display x, −display y): the core.js view (TV.makeView/zoomAt/pan/toScreen, y up) works unchanged on it.
//   screen  = CSS pixels in the canvas.
//
// Hooks for the measuring tools (Task 6):
//   engine.view() -> V (core.js view over world), engine.ready (Promise: page loaded, first bitmap drawn, or rejects)
//   engine.toPage(sx, sy) -> [px, py], engine.toScreen(px, py) -> [sx, sy] (exact inverses; null before ready)
//   opts.onDraw(ctx, engine): called each frame after the page, ctx in CSS pixels (overlays); engine.requestDraw()
//   opts.onCursor(pagePt | null), opts.onClick(pagePt, event): a left click without a drag (a left drag pans)
//   opts.onDrag(pageStart, pageEnd, event): a left drag while the left button is given to the tools (setPanOnLeft(false))
//   opts.onError(error): a page render failed (the load itself rejects engine.ready)
//   engine.setPanOnLeft(on): false gives the left button to the tools (pan stays on the middle/right button)
//   engine.whenIdle() -> Promise once no render is pending or running (tests)
//
// Previous version underneath (batch 4 Task 4, display only): opts.under = { kind, url, page, rotation } is another page
// (the version this one replaces). It is rendered once onto an opaque white canvas (a PDF page whole at twice the fit
// resolution, an image as decoded; ≤ 16 MP) and blended with the page: a canvas pixel is (1 − mix) · this page + mix · the
// previous one (drawn after the page at opacity mix, the same blend as the page at 1 − mix over it).
// Alignment (R17): in page space, where the measurements live. PDF over PDF: the previous page's bitmap → its unrotated
// user space (inverse of its pdf.js viewport transform) → this page's display (this viewport's transform) → screen, one
// affine (setTransform), so another /Rotate or page-box origin lines up point for point. Image over image: pixels (the
// same as display). A PDF and an image: no common space; drawn display top-left on top-left at its own size and
// engine.underAligned() is false (the page says so). engine.setUnderMix(0..1), engine.underMix(); opts.underMix sets
// the start (default 0: this page only). engine.ready waits for it; a failure to load it calls onError and leaves this
// page shown alone.
//
// Export (batch 4 Task 6): engine.exportFrame(whole) -> { w, h, toScreen(p), paint(g, k) } draws the page offscreen (the
// visible canvas and its bitmaps are not touched): whole = the whole page (with the view's 5 % margin, long side EXPORT_LONG
// CSS px), else the current view at the screen's size. paint(g, k) -> Promise draws it onto the 2-D context g at k device
// px per CSS px: a PDF is rendered again by pdf.js at that resolution (the visible part of the page, ≤ 16 MP as below), an
// image drawn from its bitmap; no previous version. toScreen(p) is a page point's CSS px in that frame.
//
// Rendering: a PDF is rendered by pdf.js (worker /vendor/pdfjs/pdf.worker.min.mjs). The whole page once at the fit
// resolution, then the visible part at the current zoom 150 ms after the view stops changing (canvas ≤ 16 MP). A new
// render cancels the one in flight; between renders the last bitmaps are drawn through the view transform, so zoom and
// pan are instant. An image is drawn with drawImage. window.__tvLastFrameMs = the last frame's duration (test hook).
// destroy() cancels rendering, frees the document and removes every listener; when alive() turns false the next frame
// destroys the viewer.
'use strict';
(function () {
const BG = '#1e1e1e', PAGE = '#ffffff', EDGE = 'rgba(255,255,255,0.25)';
const MAX_PIXELS = 16e6, DEBOUNCE_MS = 150, DRAG_PX = 3;
const EXPORT_LONG = 1400;   // an export of the whole page: the long side in CSS px (the device px follow from the page's k)
// 2-D affines [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f), as canvas setTransform takes them
const mul = (P, Q) => [P[0] * Q[0] + P[2] * Q[1], P[1] * Q[0] + P[3] * Q[1], P[0] * Q[2] + P[2] * Q[3], P[1] * Q[2] + P[3] * Q[3],
  P[0] * Q[4] + P[2] * Q[5] + P[4], P[1] * Q[4] + P[3] * Q[5] + P[5]];
const inv = M => { const d = M[0] * M[3] - M[1] * M[2]; return [M[3] / d, -M[1] / d, -M[2] / d, M[0] / d, (M[2] * M[5] - M[3] * M[4]) / d, (M[1] * M[4] - M[0] * M[5]) / d]; };

let lib = null;
function pdfjs() {
  if (!lib) lib = import('/vendor/pdfjs/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'; return m; }, e => { lib = null; throw e; });
  return lib;
}

// fetch a stored file -> ArrayBuffer; the server's own words on refusal
async function fetchFile(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    throw Object.assign(new Error((j && j.error) || r.statusText || String(r.status)), { status: r.status });
  }
  return r.arrayBuffer();
}

function create(container, opts) {
  const TV = window.TV, o = opts || {};
  window.__tvCreated = (window.__tvCreated || 0) + 1;   // test hook: engines created
  const canvas = document.createElement('canvas');
  canvas.className = 'tv-raster';
  container.append(canvas);
  const ctx = canvas.getContext('2d');
  let V = null, fitScale = 1, W = 0, H = 0, dpr = 1, raf = 0, dead = false, panLeft = true;
  let dw = 0, dh = 0;              // display size (scale 1)
  let toD = null, toP = null;      // page <-> display
  let img = null;                  // image: the decoded bitmap
  let doc = null, pg = null, rot = 0;
  let base = null, detail = null;  // PDF bitmaps { c, x, y, w, h } over display space
  const tasks = { base: null, detail: null };   // pdf.js render tasks in flight
  let timer = 0, busy = 0, idleWaiters = [];
  let drag = null, mouse = null;
  // under: { c (opaque canvas), toPage: bitmap px → its page space (PDF user space, image pixels), toDisp: bitmap px → its display }
  let under = null, mix = Math.min(1, Math.max(0, Number(o.underMix) || 0)), pageToD = null;   // pageToD: this page's page → display affine

  // ---- load ----
  async function load() {
    if (o.kind === 'image') {
      const ab = await fetchFile(o.url);
      if (dead) return;
      img = await createImageBitmap(new Blob([ab]));
      if (dead) { img.close(); return; }
      // the stored size is read from the file header; a displayed image of another size (EXIF orientation 5–8) would put
      // every point outside the server's page: refuse (the page translates the code)
      if (img.width !== o.pageW || img.height !== o.pageH)
        throw Object.assign(new Error('image size ' + img.width + ' × ' + img.height + ' ≠ ' + o.pageW + ' × ' + o.pageH), { code: 'image_frame', width: img.width, height: img.height, pageW: o.pageW, pageH: o.pageH });
      dw = img.width; dh = img.height;
      toD = (x, y) => [x, y]; toP = (x, y) => [x, y]; pageToD = [1, 0, 0, 1, 0, 0];
    } else if (o.kind === 'pdf') {
      const [m, ab] = await Promise.all([pdfjs(), fetchFile(o.url)]);
      if (dead) return;
      const loading = m.getDocument({ data: new Uint8Array(ab), isEvalSupported: false });
      doc = loading;   // destroy() can stop a load in progress
      const d = await loading.promise;
      if (dead) return;
      pg = await d.getPage(o.page || 1);
      if (dead) return;
      rot = [0, 90, 180, 270].includes(o.rotation) ? o.rotation : pg.rotate;
      const vp = pg.getViewport({ scale: 1, rotation: rot });
      dw = vp.width; dh = vp.height;
      toD = (x, y) => vp.convertToViewportPoint(x, y);
      toP = (x, y) => vp.convertToPdfPoint(x, y);
      pageToD = vp.transform.slice();
    } else throw new Error('unknown kind: ' + o.kind);
    fit();
    if (pg) renderBase();
    schedule();
  }

  // an opaque white canvas of display size w × h at s device px per unit, drawn by paint(context)
  const paper = (w, h, s) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * s)); c.height = Math.max(1, Math.ceil(h * s));
    const g = c.getContext('2d');
    g.fillStyle = PAGE; g.fillRect(0, 0, c.width, c.height);
    return [c, g];
  };
  // the previous version's page, once
  async function loadUnder() {
    const u = o.under;
    const ab = await fetchFile(u.url);
    if (dead) return;
    if (u.kind === 'image') {
      const b = await createImageBitmap(new Blob([ab]));
      if (dead) { b.close(); return; }
      const [c, g] = paper(b.width, b.height, capScale(b.width, b.height, 1));
      g.drawImage(b, 0, 0, c.width, c.height);
      const k = b.width / c.width;   // bitmap px → image px (= its display)
      b.close();
      under = { c, toPage: [k, 0, 0, b.height / c.height, 0, 0], toDisp: [k, 0, 0, b.height / c.height, 0, 0] };
    } else if (u.kind === 'pdf') {
      const m = await pdfjs();
      if (dead) return;
      const loading = m.getDocument({ data: new Uint8Array(ab), isEvalSupported: false });
      try {
        const d = await loading.promise;
        if (dead) return;
        const p = await d.getPage(u.page || 1);
        const r = [0, 90, 180, 270].includes(u.rotation) ? u.rotation : p.rotate;
        const vp1 = p.getViewport({ scale: 1, rotation: r }), s = capScale(vp1.width, vp1.height, Math.max(1, fitScale * dpr * 2));
        const [c, g] = paper(vp1.width, vp1.height, s), vps = p.getViewport({ scale: s, rotation: r });
        await p.render({ canvasContext: g, viewport: vps }).promise;
        if (dead) return free(c);
        under = { c, toPage: inv(vps.transform), toDisp: [1 / s, 0, 0, 1 / s, 0, 0] };
      } finally { loading.destroy(); }
    } else throw new Error('unknown kind: ' + u.kind);
    schedule();
  }

  // ---- PDF rendering ----
  // render display rect r at s device px per display unit into slot ('base' | 'detail'); a newer render in the same slot
  // cancels this one. The bitmap is kept only if this render is still the slot's latest.
  function render(slot, r, s) {
    if (tasks[slot]) tasks[slot].cancel();
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(r.w * s)); c.height = Math.max(1, Math.ceil(r.h * s));
    const vp = pg.getViewport({ scale: s, rotation: rot, offsetX: -r.x * s, offsetY: -r.y * s });
    const t = pg.render({ canvasContext: c.getContext('2d'), viewport: vp });
    tasks[slot] = t; busy++;
    t.promise.then(() => {
      if (dead || tasks[slot] !== t) return free(c);
      const b = { c, x: r.x, y: r.y, w: c.width / s, h: c.height / s, s };
      if (slot === 'base') { drop(base); base = b; } else { drop(detail); detail = b; }
      schedule();
    }, e => {
      free(c);
      if (!(e && e.name === 'RenderingCancelledException')) failed(e);
    }).finally(() => {
      if (tasks[slot] === t) tasks[slot] = null;
      busy--; settle();
    });
  }
  // a cancelled or replaced bitmap gives its memory back at once (not when the canvas is collected)
  const free = c => { c.width = 0; c.height = 0; };
  const drop = b => { if (b) free(b.c); };
  const capScale = (w, h, s) => Math.min(s, Math.sqrt(MAX_PIXELS / (w * h)));
  // the whole page at the fit resolution: shown at any zoom while a sharper one is on its way
  function renderBase() { render('base', { x: 0, y: 0, w: dw, h: dh }, capScale(dw, dh, fitScale * dpr)); }
  // the visible part of the page at the current zoom (none needed while the whole-page bitmap is sharp enough)
  function renderDetail() {
    timer = 0;
    if (dead || !pg || !V) return settle();
    const want = V.scale * dpr;
    if (base && want <= base.s * 1.01) { drop(detail); detail = null; if (tasks.detail) { tasks.detail.cancel(); tasks.detail = null; } return settle(); }
    const a = display(0, 0), b = display(W, H);
    const x0 = Math.max(0, Math.min(a[0], b[0])), y0 = Math.max(0, Math.min(a[1], b[1])), x1 = Math.min(dw, Math.max(a[0], b[0])), y1 = Math.min(dh, Math.max(a[1], b[1]));
    if (!(x1 > x0 && y1 > y0)) return settle();   // the page is off screen
    const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, s = capScale(r.w, r.h, want);
    if (detail && Math.abs(detail.s - s) <= s * 0.01 && detail.x <= r.x && detail.y <= r.y && detail.x + detail.w >= r.x + r.w && detail.y + detail.h >= r.y + r.h) return settle();
    render('detail', r, s);
  }
  function failed(e) { if (!dead && o.onError) o.onError(e); }
  function later() {
    if (!pg || dead) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(renderDetail, DEBOUNCE_MS);
  }
  // idle: nothing pending, nothing rendering and the last bitmap drawn
  function settle() {
    if (timer || busy || raf || !idleWaiters.length) return;
    const w = idleWaiters; idleWaiters = [];
    for (const f of w) f();
  }

  // ---- drawing ----
  const display = (sx, sy) => { const w = TV.toWorld(V, sx, sy); return [w[0], -w[1]]; };
  const screenOf = (x, y) => TV.toScreen(V, x, -y);
  function blit(b) {
    const [sx, sy] = screenOf(b.x, b.y), s = V.scale;
    ctx.drawImage(b.c, sx, sy, b.w * s, b.h * s);
  }
  function frame() {
    raf = 0;
    if (dead) return;
    if (o.alive && !o.alive()) { destroy(); return; }
    const t0 = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (V && toD) {
      const [sx, sy] = screenOf(0, 0), s = V.scale;
      ctx.fillStyle = PAGE; ctx.fillRect(sx, sy, dw * s, dh * s);
      if (img) {
        ctx.imageSmoothingEnabled = s < 2;   // zoomed in: the pixels as they are
        ctx.drawImage(img, sx, sy, dw * s, dh * s);
        ctx.imageSmoothingEnabled = true;
      }
      if (base) blit(base);
      if (detail) blit(detail);
      if (under && mix > 0) {
        // display → screen (CSS px): x · s + (tx − ox · s), y · s + (ty + oy · s) (screenOf); then the bitmap through page space
        const toScr = [s, 0, 0, s, V.tx - V.ox * s, V.ty + V.oy * s];
        const M = mul(toScr, underAligned() ? mul(pageToD, under.toPage) : under.toDisp);
        ctx.save(); ctx.globalAlpha = mix; ctx.transform(...M); ctx.drawImage(under.c, 0, 0); ctx.restore();
      }
      ctx.lineWidth = 1; ctx.strokeStyle = EDGE; ctx.strokeRect(sx - 0.5, sy - 0.5, dw * s + 1, dh * s + 1);
      if (o.onDraw) o.onDraw(ctx, api);
    }
    window.__tvLastFrameMs = performance.now() - t0;
    settle();
  }
  function schedule() { if (!raf && !dead) raf = requestAnimationFrame(frame); }
  function viewChanged() { schedule(); later(); }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    dpr = window.devicePixelRatio || 1;
    W = w; H = h;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    if (!V && toD) fit();
    viewChanged();
  }
  function fit() {
    if (!toD) return;
    V = TV.makeView([0, -dh, dw, 0], W || 1, H || 1, [0, 0]);
    fitScale = V.scale;
    viewChanged();
  }

  // ---- export ----
  function exportFrame(whole) {
    if (!V || !toD) return null;
    let view, w, h;
    if (whole) {
      const a = dw * 1.1, b = dh * 1.1, m = Math.max(a, b);
      w = Math.max(1, Math.round(EXPORT_LONG * a / m)); h = Math.max(1, Math.round(EXPORT_LONG * b / m));
      view = TV.makeView([0, -dh, dw, 0], w, h, [0, 0]);
    } else { view = { ...V }; w = W; h = H; }
    const scr = (x, y) => TV.toScreen(view, x, -y);
    return { w, h, toScreen: p => { const d = toD(p[0], p[1]); return scr(d[0], d[1]); }, paint: (g, k) => paintExport(g, k, view, w, h, scr) };
  }
  async function paintExport(g, k, view, w, h, scr) {
    if (dead) throw new Error('viewer closed');
    g.setTransform(k, 0, 0, k, 0, 0);
    g.fillStyle = BG; g.fillRect(0, 0, w, h);
    const [sx, sy] = scr(0, 0), s = view.scale;
    g.fillStyle = PAGE; g.fillRect(sx, sy, dw * s, dh * s);
    if (img) g.drawImage(img, sx, sy, dw * s, dh * s);
    else if (pg) {
      // the part of the page in the frame, in display units, rendered at the export's device px per unit (≤ 16 MP)
      const a = TV.toWorld(view, 0, 0), b = TV.toWorld(view, w, h);
      const x0 = Math.max(0, Math.min(a[0], b[0])), y0 = Math.max(0, Math.min(-a[1], -b[1])), x1 = Math.min(dw, Math.max(a[0], b[0])), y1 = Math.min(dh, Math.max(-a[1], -b[1]));
      if (x1 > x0 && y1 > y0) {
        const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, rs = capScale(r.w, r.h, s * k);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.ceil(r.w * rs)); c.height = Math.max(1, Math.ceil(r.h * rs));
        const p = pg;
        try {
          await p.render({ canvasContext: c.getContext('2d'), viewport: p.getViewport({ scale: rs, rotation: rot, offsetX: -r.x * rs, offsetY: -r.y * rs }) }).promise;
          if (dead) throw new Error('viewer closed');
          const [rx, ry] = scr(r.x, r.y);
          g.setTransform(k, 0, 0, k, 0, 0);
          g.drawImage(c, rx, ry, c.width / rs * s, c.height / rs * s);
        } finally { free(c); }
      }
    }
    g.lineWidth = 1; g.strokeStyle = EDGE; g.strokeRect(sx - 0.5, sy - 0.5, dw * s + 1, dh * s + 1);
  }

  // the previous version lines up in page space only when both are PDFs or both images (R17)
  function underAligned() { return !!o.under && o.under.kind === o.kind; }

  // ---- input ----
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function onWheel(e) {
    e.preventDefault();
    if (!V) return;
    const [x, y] = pos(e), dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const f = Math.min(2, Math.max(0.5, Math.pow(1.0015, -dy)));
    const s = V.scale * f;
    if (s < fitScale * 0.05 || s > Math.max(100, fitScale * 4)) return;   // up to 100 screen px per point / pixel
    V = TV.zoomAt(V, x, y, f);
    viewChanged();
  }
  function onDown(e) {
    if (drag || !V) return;
    const [x, y] = pos(e);
    if (e.button === 1 || e.button === 2) { e.preventDefault(); drag = { pan: true, x, y }; }
    else if (e.button === 0) drag = { pan: false, x, y, x0: x, y0: y, moved: false };
    else return;
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onUp);
  }
  function onDragMove(e) {
    const [x, y] = pos(e);
    if (!drag.pan) {
      if (!drag.moved && Math.abs(x - drag.x0) <= DRAG_PX && Math.abs(y - drag.y0) <= DRAG_PX) return;
      drag.moved = true;
      if (!panLeft) return;
    }
    V = TV.pan(V, x - drag.x, y - drag.y); drag.x = x; drag.y = y;
    viewChanged();
  }
  function onUp(e) {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onUp);
    const d = drag;
    drag = null;
    if (!d || d.pan) return;
    if (d.moved) { if (!panLeft && o.onDrag) { const [x, y] = pos(e); o.onDrag(toPage(d.x0, d.y0), toPage(x, y), e); } return; }
    if (o.onClick) o.onClick(toPage(d.x0, d.y0), e);
  }
  function onMove(e) { mouse = pos(e); if (o.onCursor && V && toP) o.onCursor(toPage(mouse[0], mouse[1])); }
  function onLeave() { mouse = null; if (o.onCursor) o.onCursor(null); }
  const noMenu = e => e.preventDefault();

  function toPage(sx, sy) { if (!V || !toP) return null; const d = display(sx, sy); return toP(d[0], d[1]); }
  function toScreen(px, py) { if (!V || !toD) return null; const d = toD(px, py); return screenOf(d[0], d[1]); }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('contextmenu', noMenu);
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(resize); ro.observe(canvas); } else window.addEventListener('resize', resize);

  function destroy() {
    if (dead) return;
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (timer) clearTimeout(timer);
    timer = 0;
    for (const k of ['base', 'detail']) if (tasks[k]) { tasks[k].cancel(); tasks[k] = null; }
    if (doc) { doc.destroy(); doc = null; }   // the loading task: frees the document and its worker
    if (img) { img.close(); img = null; }
    if (under) { free(under.c); under = null; }
    drop(base); drop(detail);
    base = detail = pg = null;
    canvas.removeEventListener('wheel', onWheel, { passive: false });
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('mouseleave', onLeave);
    canvas.removeEventListener('contextmenu', noMenu);
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onUp);
    if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
    const w = idleWaiters; idleWaiters = [];
    for (const f of w) f();
  }

  const api = {
    canvas, kind: o.kind,
    view: () => V,
    size: () => [dw, dh],   // display size at scale 1 (points or pixels, rotated)
    fit, toPage, toScreen, destroy,
    requestDraw: schedule,
    setPanOnLeft(on) { panLeft = !!on; },
    setUnderMix(v) { mix = Math.min(1, Math.max(0, Number(v) || 0)); schedule(); },
    underMix: () => mix,
    hasUnder: () => !!under,
    underAligned,
    exportFrame,
    whenIdle: () => new Promise(f => { idleWaiters.push(f); settle(); }),
  };
  resize();
  // ready: the page is loaded and (for a PDF) the whole-page bitmap is drawn
  api.ready = load().then(() => o.under && !dead ? loadUnder().catch(failed) : null).then(() => api.whenIdle()).then(() => { if (dead) throw new Error('viewer closed'); return api; });
  api.ready.catch(() => {});
  return api;
}

window.TVRaster = { create, pdfjs };
})();
