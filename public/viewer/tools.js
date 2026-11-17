// Manual measuring tools (batch 3, plan Task 6): the shape being drawn on a viewer (the DXF canvas, canvas.js, or a PDF
// page / image, raster.js), and the overlay of saved manual measurements and calibrations. No quantity is computed here:
// the page (app.js) shows the live preview with lib/takeoff/manual.js (window.TakeoffManual, the server's own formulas)
// and every saved quantity comes from the server.
//
//   TVTools.create({ canvas, toScreen(p) -> [sx, sy] | null, toPage(sx, sy) -> p | null, requestDraw(), axisLock, alive(),
//                    cursor() -> p | null, overlay() -> { saved, cals, region }, onChange(tools), onFinish(kind, data) })
//   tools.drawSavedAt(ctx, toScreen, more) -> [{ id, no, colour }]: the saved measurements and calibrations alone (the
//     screen's own drawing, no shape being drawn) through another projection, e.g. an offscreen export view (batch 4 Task 6);
//     more: further saved entries after overlay().saved (an export's layer / block / selection measurements)
//   TVTools.PALETTE: the colours of saved measurements without their own (entry k: PALETTE[k % length])
//   TVTools.calibrationFor(cals, p): the calibration a point uses, as the server's lib/takeoff/calib.js calibrationFor
//   TVTools.pathWarnings(pts, closed): [{ code: 'back' | 'sharp', at }] (R15: a path that doubles back on itself; a very
//     sharp angle), at = the 1-based point number
//
// Points are in the viewer's stored coordinates: DXF drawing units (the snap point is exact, R7), PDF page user space
// (unrotated, absolute, R12/R16) or image pixels, as the viewer's onClick gives them. Tools:
//   line (2 points), polyline (Enter / double-click), area (Hole starts a hole inside it), rect (2 corners or a drag),
//   count, calibrate and verify (2 points), region (2 corners or a drag).
// A 2-point tool finishes by itself; the others on finish(). onFinish(kind, data) is 'measure' with the manual geom,
// 'calibrate' / 'verify' / 'region' with { p1, p2 }; it returns true to keep the shape shown (frozen) while its form is
// open. undo() removes the last point, cancel() (Esc) drops the shape and leaves the tool. axisLock (raster): Shift keeps
// the new point horizontal or vertical to the previous one as displayed (exactly on a page axis: the page is shown turned
// by 0/90/180/270 only). A saved measurement with a number (overlay().saved[i].no: its number in the measurement list)
// carries a badge with that number at its first point (batch 4 Task 6); an entry with no geom but a point at (a DXF layer,
// block or selection measurement in an export) is its badge alone.
'use strict';
(function () {
const SAME_PX = 2;          // a click within 2 screen px of the previous point is the same point (the 2nd click of a double-click)
const SHARP_DEG = 10;       // a turn sharper than this is worth a look

// lib/takeoff/calib.js calibrationFor: the region containing the point (edges included; on a shared edge the lower id), else
// the page calibration, else null. region: null (the page), [x0, y0, x1, y1] or its JSON text
function calibrationFor(cals, p) {
  let best = null, page = null;
  for (const c of cals || []) {
    const r = c.region === null || c.region === undefined ? null : typeof c.region === 'string' ? JSON.parse(c.region) : c.region;
    if (r === null) { if (page === null) page = c; continue; }
    if (p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3] && (best === null || c.id < best.id)) best = c;
  }
  return best || page;
}

// R15: where a path doubles back on itself (the next edge runs back along the previous one) or turns very sharply
function pathWarnings(pts, closed) {
  const out = [], n = pts.length;
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1], lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!lu || !lv) continue;
    const dot = ux * vx + uy * vy, cross = ux * vy - uy * vx;
    if (dot < 0 && Math.abs(cross) <= 1e-9 * lu * lv) out.push({ code: 'back', at: i + 1 });
    else if (Math.atan2(Math.abs(cross), -dot) * 180 / Math.PI < SHARP_DEG) out.push({ code: 'sharp', at: i + 1 });   // angle between the two edges at b
  }
  return out;
}

const TWO = { line: 1, calibrate: 1, verify: 1, rect: 1, region: 1 };
const MEASURE = { line: 1, polyline: 1, area: 1, rect: 1, count: 1 };
const PALETTE = ['#d81b60', '#00897b', '#f57c00', '#3949ab', '#7cb342', '#8e24aa'];
const DRAW = '#ff1744', CAL = '#00acc1', REGION = '#ffb300';

function create(o) {
  let tool = null, ring = [], outer = null, holes = [], done = null, shift = false, dead = false, drawn = [], drawnCals = [];
  let proj = null;   // drawSavedAt: another projection, for the duration of that call
  const S = p => proj ? proj(p) : o.toScreen(p);
  const changed = () => { if (o.onChange) o.onChange(api); if (o.requestDraw) o.requestDraw(); };
  const samePt = (a, b) => {
    if (a[0] === b[0] && a[1] === b[1]) return true;
    const sa = S(a), sb = S(b);
    return !!(sa && sb) && Math.hypot(sa[0] - sb[0], sa[1] - sb[1]) <= SAME_PX;
  };
  const last = () => ring.length ? ring[ring.length - 1] : null;
  // Shift: horizontal or vertical as displayed; the page coordinate that barely moved is set exactly to the previous one
  function lock(p, ref) {
    const sr = S(ref), sp = S(p);
    if (!sr || !sp) return p;
    const q = Math.abs(sp[0] - sr[0]) >= Math.abs(sp[1] - sr[1]) ? o.toPage(sp[0], sr[1]) : o.toPage(sr[0], sp[1]);
    if (!q) return p;
    return Math.abs(q[0] - ref[0]) < Math.abs(q[1] - ref[1]) ? [ref[0], q[1]] : [q[0], ref[1]];
  }
  const locked = (p, ev) => o.axisLock && (shift || (ev && ev.shiftKey)) && last() ? lock(p, last()) : p;

  function clear() { ring = []; outer = null; holes = []; done = null; }
  function setTool(t) { clear(); tool = t || null; changed(); }
  function pick(p, ev) {
    if (!tool || done || !p || dead) return false;
    p = locked([p[0], p[1]], ev);
    const l = last();
    if (l && samePt(l, p)) return false;
    if (tool === 'count' && ring.some(q => samePt(q, p))) { if (o.onNote) o.onNote('same_point'); return false; }
    ring.push(p);
    changed();
    if (TWO[tool] && ring.length === 2) finish();
    return true;
  }
  function drag(p0, p1) {
    // a click that moved more than a few pixels with a point tool adds nothing: say so (never dropped silently)
    if (tool && tool !== 'rect' && tool !== 'region' && !done) { if (o.onNote) o.onNote('drag'); return; }
    if ((tool !== 'rect' && tool !== 'region') || done || ring.length || !p0 || !p1) return;
    ring = [p0, p1];
    finish();
  }
  // Hole: the outline (or the hole drawn so far) is closed and the next points draw a hole inside it
  function hole() {
    if (tool !== 'area' || done) return false;
    if (ring.length < 3) { if (o.onNote) o.onNote('need_points', 3); return false; }
    if (outer) holes.push(ring); else outer = ring;
    ring = [];
    changed();
    return true;
  }
  function undo() {
    if (done) return;
    if (ring.length) ring.pop();
    else if (outer) { if (holes.length) ring = holes.pop(); else { ring = outer; outer = null; } }   // back into the ring before Hole
    changed();
  }
  // the measured shape so far (the frozen one while its form is open), or null when there are not enough points yet
  function geom() {
    if (done && done.kind === 'measure') return done.data;
    if (!MEASURE[tool]) return null;
    if (tool === 'line' || tool === 'polyline') return ring.length >= 2 ? { tool, pts: ring.slice() } : null;
    if (tool === 'count') return ring.length ? { tool, pts: ring.slice() } : null;
    if (tool === 'rect') return ring.length === 2 ? { tool, p1: ring[0], p2: ring[1] } : null;
    const out = outer || ring;
    if (out.length < 3) return null;
    return { tool: 'area', outer: out.slice(), holes: outer && ring.length >= 3 ? [...holes, ring.slice()] : holes.slice() };
  }
  function finish() {
    if (!tool || done || dead) return false;
    const t = tool;
    let kind = 'measure', data;
    if (MEASURE[t]) {
      if (t === 'area' && outer && ring.length && ring.length < 3) { if (o.onNote) o.onNote('need_points', 3); return false; }
      data = geom();
      if (!data) { if (o.onNote) o.onNote('need_points', t === 'count' ? 1 : t === 'area' ? 3 : 2); return false; }
    } else {
      if (ring.length !== 2) { if (o.onNote) o.onNote('need_points', 2); return false; }
      kind = t; data = { p1: ring[0], p2: ring[1] };
    }
    const keep = o.onFinish ? o.onFinish(kind, data) === true : false;
    if (tool !== t || dead) return keep;   // the page switched tools (a region goes on to its calibration)
    if (keep) done = { kind, data };
    else if (TWO[t]) ring = [];
    changed();
    return keep;
  }
  function cancel() { setTool(null); }

  // ---- overlay ----
  function path(ctx, pts, closed) {
    let started = false;
    for (const p of pts) { const s = S(p); if (!s) continue; if (!started) { ctx.moveTo(s[0], s[1]); started = true; } else ctx.lineTo(s[0], s[1]); }
    if (closed && started) ctx.closePath();
  }
  const rectPts = (a, b) => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  function shape(ctx, g, colour, fill) {
    ctx.beginPath();
    if (g.tool === 'area') { path(ctx, g.outer, true); for (const h of g.holes || []) path(ctx, h, true); }
    else if (g.tool === 'rect') path(ctx, rectPts(g.p1, g.p2), true);
    else if (g.tool !== 'count') path(ctx, g.pts, false);
    if (g.tool === 'area' || g.tool === 'rect') { ctx.globalAlpha = fill; ctx.fillStyle = colour; ctx.fill('evenodd'); ctx.globalAlpha = 1; }
    ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.stroke();
    if (g.tool === 'count') for (const p of g.pts) dot(ctx, p, colour, 4);
  }
  function dot(ctx, p, colour, r) { const s = S(p); if (!s) return; ctx.fillStyle = colour; ctx.fillRect(s[0] - r, s[1] - r, 2 * r, 2 * r); }
  function label(ctx, p, text, colour) {
    const s = S(p);
    if (!s || !text) return;
    ctx.font = '12px "Segoe UI", Tahoma, Arial, sans-serif';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(s[0] + 6, s[1] - 18, w + 6, 16);
    ctx.fillStyle = colour; ctx.fillText(text, s[0] + 9, s[1] - 6);
  }
  // the measurement list's number, white on the measurement's colour, up and before its first point
  function badge(ctx, p, no, colour) {
    const s = S(p);
    if (!s) return;
    const text = String(no);
    ctx.font = 'bold 11px "Segoe UI", Tahoma, Arial, sans-serif';
    const r = Math.max(8, ctx.measureText(text).width / 2 + 4), cx = s[0] - r - 3, cy = s[1] - r - 3;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = colour; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 0.5);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  const first = g => g.tool === 'rect' ? g.p1 : g.tool === 'area' ? g.outer[0] : g.pts[0];
  // the saved measurements (with their number badges) and the calibrations: on the screen and in an export alike
  function drawSaved(ctx, ov) {
    const saved = [], cals = [];
    (ov.saved || []).forEach((m, k) => {
      const colour = m.color || PALETTE[k % PALETTE.length];
      if (!m.geom) {
        if (m.at && Number.isInteger(m.no)) { badge(ctx, m.at, m.no, colour); saved.push({ id: m.id, no: m.no, text: m.text || '', colour }); }
        return;
      }
      shape(ctx, m.geom, colour, 0.15);
      label(ctx, first(m.geom), m.text, colour);
      if (Number.isInteger(m.no)) badge(ctx, first(m.geom), m.no, colour);
      saved.push({ id: m.id, no: Number.isInteger(m.no) ? m.no : null, text: m.text, colour });
    });
    for (const c of ov.cals || []) {
      ctx.setLineDash([6, 4]);
      if (c.region) { ctx.beginPath(); path(ctx, rectPts([c.region[0], c.region[1]], [c.region[2], c.region[3]]), true); ctx.strokeStyle = REGION; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.beginPath(); path(ctx, [c.p1, c.p2], false); ctx.strokeStyle = CAL; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, c.region ? [c.region[0], c.region[3]] : c.p2, c.text, c.region ? '#8a6100' : '#00707f');
      cals.push(c.text);
    }
    return { saved, cals };
  }
  function draw(ctx) {
    if (dead) return;
    const ov = o.overlay ? o.overlay() : {};
    ctx.save();
    ({ saved: drawn, cals: drawnCals } = drawSaved(ctx, ov));
    if (ov.region) {   // drawn, waiting for its calibration
      ctx.setLineDash([4, 3]); ctx.beginPath(); path(ctx, rectPts([ov.region[0], ov.region[1]], [ov.region[2], ov.region[3]]), true);
      ctx.strokeStyle = REGION; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    }
    // the shape being drawn, with the rubber band to the cursor
    if (tool) {
      let cur = done ? null : o.cursor ? o.cursor() : null;
      if (cur) cur = locked(cur, null);
      const colour = tool === 'calibrate' || tool === 'verify' ? CAL : tool === 'region' ? REGION : DRAW;
      const two = (tool === 'rect' || tool === 'region') && ring.length === 1 && cur ? rectPts(ring[0], cur) : null;
      if (outer) { shape(ctx, { tool: 'area', outer, holes }, colour, 0.12); outer.forEach(p => dot(ctx, p, colour, 3)); holes.forEach(h => h.forEach(p => dot(ctx, p, colour, 3))); }
      if (tool !== 'count') {
        ctx.beginPath();
        if (two) path(ctx, two, true);
        else if (tool === 'rect' && ring.length === 2) path(ctx, rectPts(ring[0], ring[1]), true);
        else path(ctx, ring, tool === 'area' && ring.length > 2 && !cur);
        ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.stroke();
        if (cur && ring.length && !two) {
          ctx.beginPath(); path(ctx, tool === 'area' && ring.length > 1 ? [ring[ring.length - 1], cur, ring[0]] : [ring[ring.length - 1], cur], false);
          ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
        }
      }
      ring.forEach(p => dot(ctx, p, colour, tool === 'count' ? 4 : 3));
    }
    ctx.restore();
  }
  function drawSavedAt(ctx, toScreen, more) {
    const ov = o.overlay ? o.overlay() : {};
    proj = toScreen;
    ctx.save();
    try { return drawSaved(ctx, { ...ov, saved: [...(ov.saved || []), ...(more || [])] }).saved; } finally { ctx.restore(); proj = null; }
  }

  // ---- keys: Enter finishes, Esc cancels; Shift held for the axis lock (and the rubber band) ----
  const typing = e => e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  function onKey(e) {
    if (dead) return;
    if (o.alive && !o.alive()) { destroy(); return; }
    if (e.key === 'Shift') { shift = e.type === 'keydown'; if (tool) o.requestDraw(); return; }
    if (e.type !== 'keydown' || !tool) return;
    // Enter in a field belongs to the field; Esc cancels from a form's text field too (not from an open list)
    if (e.key === 'Enter' && !done && !typing(e)) { e.preventDefault(); finish(); }
    else if (e.key === 'Escape' && !(e.target && e.target.tagName === 'SELECT')) { e.preventDefault(); cancel(); }
  }
  const onBlur = () => { shift = false; };
  function onDbl(e) { if (tool && !done) { e.preventDefault(); finish(); } }
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  if (o.canvas) o.canvas.addEventListener('dblclick', onDbl);
  function destroy() {
    if (dead) return;
    dead = true;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('blur', onBlur);
    if (o.canvas) o.canvas.removeEventListener('dblclick', onDbl);
  }

  const api = {
    tool: () => tool, setTool, pick, drag, hole, undo, finish, cancel, geom, draw, drawSavedAt, destroy,
    // the shape stays drawn (frozen) while its form is open; clear() drops it and keeps the tool
    clear() { clear(); changed(); },
    isDone: () => !!done,
    holeMode: () => !!outer,
    points: () => ring.map(p => p.slice()),
    pointCount: () => ring.length + (outer ? outer.length : 0) + holes.reduce((s, h) => s + h.length, 0),
    overlay: () => drawn.slice(),   // what the last frame drew of the saved measurements: [{ id, no, text, colour }] (test hook)
    overlayCals: () => drawnCals.slice(),   // the scale labels it drew (test hook)
  };
  return api;
}

const TVTools = { create, calibrationFor, pathWarnings, PALETTE };
if (typeof module !== 'undefined' && module.exports) module.exports = TVTools; else window.TVTools = TVTools;
})();
