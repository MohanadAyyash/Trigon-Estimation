// PDF page and image viewer on a <canvas>: the page under the same view transform as the DXF viewer (core.js), wheel zoom
// at the cursor, pan, fit. Display only: no quantities (the measuring tools draw through the hooks below).
//
//   TVRaster.create(container, { kind: 'pdf'|'image', url, page, pageW, pageH, rotation, alive, onCursor, onClick, onDraw })
//     -> engine (a <canvas class="tv-raster"> is added to container)
//   TVRaster.pdfjs() -> Promise<pdf.js module> (vendored /vendor/pdfjs, loaded once, worker set; never a CDN)
//
// Coordinates (R12):
//   page    = what is stored. PDF: unrotated PDF user space (points, y up), as pdf.js viewport.convertToPdfPoint gives;
//             a page's /Rotate never changes a page point or a length. Image: pixels, y down, origin at the top-left.
//   display = the page as shown: the pdf.js viewport at scale 1 with the row's rotation (y down); an image's pixels.
//   world   = (display x, −display y): the core.js view (TV.makeView/zoomAt/pan/toScreen, y up) works unchanged on it.
//   screen  = CSS pixels in the canvas.
//
// Hooks for the measuring tools (Task 6):
//   engine.view() -> V (core.js view over world), engine.ready (Promise: page loaded, first bitmap drawn, or rejects)
//   engine.toPage(sx, sy) -> [px, py], engine.toScreen(px, py) -> [sx, sy] (exact inverses; null before ready)
//   opts.onDraw(ctx, engine): called each frame after the page, ctx in CSS pixels (overlays); engine.requestDraw()
//   opts.onCursor(pagePt | null), opts.onClick(pagePt, event): a left click without a drag (a left drag pans)
//   opts.onError(error): a page render failed (the load itself rejects engine.ready)
//   engine.setPanOnLeft(on): false gives the left button to the tools (pan stays on the middle/right button)
//   engine.whenIdle() -> Promise once no render is pending or running (tests)
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

  // ---- load ----
  async function load() {
    if (o.kind === 'image') {
      const ab = await fetchFile(o.url);
      if (dead) return;
      img = await createImageBitmap(new Blob([ab]));
      if (dead) { img.close(); return; }
      // the stored size is read from the file header; a decoded image of another size (e.g. EXIF orientation) would put
      // every point in the wrong place: refuse rather than show it shifted
      if (img.width !== o.pageW || img.height !== o.pageH) throw new Error('image size ' + img.width + ' × ' + img.height + ' ≠ ' + o.pageW + ' × ' + o.pageH);
      dw = img.width; dh = img.height;
      toD = (x, y) => [x, y]; toP = (x, y) => [x, y];
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
    } else throw new Error('unknown kind: ' + o.kind);
    fit();
    if (pg) renderBase();
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
      if (dead || tasks[slot] !== t) return;
      const b = { c, x: r.x, y: r.y, w: c.width / s, h: c.height / s, s };
      if (slot === 'base') base = b; else detail = b;
      schedule();
    }, e => {
      if (!(e && e.name === 'RenderingCancelledException')) failed(e);
    }).finally(() => {
      if (tasks[slot] === t) tasks[slot] = null;
      busy--; settle();
    });
  }
  const capScale = (w, h, s) => Math.min(s, Math.sqrt(MAX_PIXELS / (w * h)));
  // the whole page at the fit resolution: shown at any zoom while a sharper one is on its way
  function renderBase() { render('base', { x: 0, y: 0, w: dw, h: dh }, capScale(dw, dh, fitScale * dpr)); }
  // the visible part of the page at the current zoom (none needed while the whole-page bitmap is sharp enough)
  function renderDetail() {
    timer = 0;
    if (dead || !pg || !V) return settle();
    const want = V.scale * dpr;
    if (base && want <= base.s * 1.01) { detail = null; if (tasks.detail) { tasks.detail.cancel(); tasks.detail = null; } return settle(); }
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
    if (!d || d.pan || d.moved || !o.onClick) return;
    o.onClick(toPage(d.x0, d.y0), e);
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
    whenIdle: () => new Promise(f => { idleWaiters.push(f); settle(); }),
  };
  resize();
  // ready: the page is loaded and (for a PDF) the whole-page bitmap is drawn
  api.ready = load().then(() => api.whenIdle()).then(() => { if (dead) throw new Error('viewer closed'); return api; });
  api.ready.catch(() => {});
  return api;
}

window.TVRaster = { create, pdfjs };
})();
