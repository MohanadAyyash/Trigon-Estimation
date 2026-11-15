// Raw DXF entities (parse.js) -> flat list of measurable items in drawing units.
// Exact geometry: lines, circular arcs (ARC, CIRCLE, bulges) and elliptical arcs are kept as true curves
// under uniform scale/rotation/mirror. Only SPLINEs and arcs under non-uniform scale are sampled (approx: true).
'use strict';
const TAU = 2 * Math.PI, D2R = Math.PI / 180;
const MAX_DEPTH = 32;
const RATIO_SLACK = 1e-9;     // ellipse minor/major ratio may exceed 1 by float noise only
const ARC_STEP = 0.5 * D2R;   // sampling step for arcs under non-uniform scale
const PIP_STEP = 1 * D2R;     // sampling step for hatch loop containment tests only
const SPLINE_SAMPLES = 200;   // per knot span
const ID = [1, 0, 0, 1, 0, 0];
const MIRROR_X = [-1, 0, 0, 1, 0, 0];

// ---- group-code access (values are strings; garbage never becomes 0) ----
function get(codes, code) { for (const p of codes) if (p[0] === code) return p[1]; return undefined; }
function toNum(v, code, what) {
  const s = v.trim(), n = s === '' ? NaN : Number(s);
  if (!Number.isFinite(n)) throw new Error('corrupt DXF: bad value for group code ' + code + ' in ' + what);
  return n;
}
function num(codes, code, dflt, what) {
  const v = get(codes, code);
  if (v === undefined) {
    if (dflt === undefined) throw new Error('corrupt DXF: missing group code ' + code + ' in ' + what);
    return dflt;
  }
  return toNum(v, code, what);
}
function all(codes, code, what) { const r = []; for (const [c, v] of codes) if (c === code) r.push(toNum(v, c, what)); return r; }
// x/y pairs: every x code must be followed by its y code before the next x
function pairs(codes, cx, cy, what) {
  const r = []; let cur = null;
  for (const [c, v] of codes) {
    if (c === cx) {
      if (cur && cur[1] === undefined) throw new Error('corrupt DXF: incomplete coordinate pair in ' + what);
      cur = [toNum(v, c, what), undefined]; r.push(cur);
    } else if (c === cy) {
      if (!cur || cur[1] !== undefined) throw new Error('corrupt DXF: incomplete coordinate pair in ' + what);
      cur[1] = toNum(v, c, what);
    }
  }
  if (cur && cur[1] === undefined) throw new Error('corrupt DXF: incomplete coordinate pair in ' + what);
  return r;
}

// exact at multiples of 90 degrees, so rotated geometry stays exactly axis-aligned
function cosd(a) { const m = ((a % 360) + 360) % 360; return m === 0 ? 1 : m === 90 ? 0 : m === 180 ? -1 : m === 270 ? 0 : Math.cos(a * D2R); }
function sind(a) { const m = ((a % 360) + 360) % 360; return m === 0 ? 0 : m === 90 ? 1 : m === 180 ? 0 : m === 270 ? -1 : Math.sin(a * D2R); }
// sweep of end - start in (0, 360]; null when the angles coincide
function sweepDeg(s, e, fullWhenEqual) {
  const d = e - s, m = ((d % 360) + 360) % 360;
  if (m !== 0) return m;
  return d !== 0 || fullWhenEqual ? 360 : null;
}

// ---- affine transforms [a,b,c,d,e,f]: x' = a x + c y + e, y' = b x + d y + f ----
function compose(P, Q) { // P after Q
  return [P[0] * Q[0] + P[2] * Q[1], P[1] * Q[0] + P[3] * Q[1], P[0] * Q[2] + P[2] * Q[3], P[1] * Q[2] + P[3] * Q[3],
    P[0] * Q[4] + P[2] * Q[5] + P[4], P[1] * Q[4] + P[3] * Q[5] + P[5]];
}
const ap = (T, p) => [T[0] * p[0] + T[2] * p[1] + T[4], T[1] * p[0] + T[3] * p[1] + T[5]];
const lin = (T, p) => [T[0] * p[0] + T[2] * p[1], T[1] * p[0] + T[3] * p[1]];
function info(T) {
  const [a, b, c, d] = T, det = a * d - b * c;
  const tol = 1e-12 * Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const similar = det !== 0 && (det > 0 ? Math.abs(a - d) <= tol && Math.abs(b + c) <= tol : Math.abs(a + d) <= tol && Math.abs(b - c) <= tol);
  return { det, s: Math.sqrt(Math.abs(det)), similar };
}

// ---- segments ----
// L: { t:'L', p0, p1 }
// A: circular arc { t:'A', p0, p1, c, r, a0, sw }   (radians, sw signed: + = counter-clockwise)
// E: elliptical arc { t:'E', p0, p1, c, M, N, t0, sw }   point(t) = c + M cos t + N sin t
const L = (p0, p1) => ({ t: 'L', p0, p1 });
function arcSeg(c, r, a0, sw) {
  const a1 = a0 + sw;
  const p0 = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
  const p1 = Math.abs(sw) >= TAU ? p0 : [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)];
  return { t: 'A', p0, p1, c, r, a0, sw };
}
const ePt = (s, t) => [s.c[0] + s.M[0] * Math.cos(t) + s.N[0] * Math.sin(t), s.c[1] + s.M[1] * Math.cos(t) + s.N[1] * Math.sin(t)];
function ellSeg(c, M, N, t0, sw) {
  const s = { t: 'E', c, M, N, t0, sw };
  s.p0 = ePt(s, t0); s.p1 = Math.abs(sw) >= TAU ? s.p0 : ePt(s, t0 + sw);
  return s;
}
// bulge b from p0 to p1: theta = 4 atan b (+ = counter-clockwise); centre on the left of the chord for 0 < b < 1
function bulgeSeg(p0, p1, b) {
  if (Math.abs(b) < 1e-12) return L(p0, p1); // numerically straight
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], cl = Math.hypot(dx, dy);
  if (cl === 0) return null; // zero-length chord: no arc
  const k = (1 - b * b) / (4 * b);
  const c = [(p0[0] + p1[0]) / 2 - dy * k, (p0[1] + p1[1]) / 2 + dx * k];
  return { t: 'A', p0, p1, c, r: cl * (1 + b * b) / (4 * Math.abs(b)), a0: Math.atan2(p0[1] - c[1], p0[0] - c[0]), sw: 4 * Math.atan(b) };
}
function polySegs(pts, closed) { // pts [[x,y,bulge]]
  const segs = [], n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    if (closed && n < 2) break;
    const s = bulgeSeg([p[0], p[1]], [q[0], q[1]], p[2] || 0);
    if (s) segs.push(s);
  }
  return segs;
}
function sampleSeg(s, step) { // points from p0 to p1 inclusive
  const n = Math.max(2, Math.ceil(Math.abs(s.sw) / step)), pts = [s.p0];
  for (let k = 1; k < n; k++) {
    const f = k / n;
    pts.push(s.t === 'A' ? [s.c[0] + s.r * Math.cos(s.a0 + s.sw * f), s.c[1] + s.r * Math.sin(s.a0 + s.sw * f)] : ePt(s, s.t0 + s.sw * f));
  }
  pts.push(s.p1);
  return pts;
}
// transform one path's segments; arcs under a non-similarity are sampled (approx)
function xformSegs(segs, T, I, flag) {
  const out = [];
  for (const s of segs) {
    if (s.t === 'L') { out.push(L(ap(T, s.p0), ap(T, s.p1))); continue; }
    if (I.similar) {
      if (s.t === 'A') {
        const c = ap(T, s.c), p0 = ap(T, s.p0), p1 = Math.abs(s.sw) >= TAU ? p0 : ap(T, s.p1);
        out.push({ t: 'A', p0, p1, c, r: s.r * I.s, a0: Math.atan2(p0[1] - c[1], p0[0] - c[0]), sw: I.det > 0 ? s.sw : -s.sw });
      } else {
        const p0 = ap(T, s.p0);
        out.push({ t: 'E', c: ap(T, s.c), M: lin(T, s.M), N: lin(T, s.N), t0: s.t0, sw: s.sw, p0, p1: Math.abs(s.sw) >= TAU ? p0 : ap(T, s.p1) });
      }
      continue;
    }
    flag.approx = true;
    const pts = sampleSeg(s, ARC_STEP).map(p => ap(T, p));
    for (let k = 0; k + 1 < pts.length; k++) out.push(L(pts[k], pts[k + 1]));
  }
  return out;
}

// ---- metrics ----
const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
function ellipseLen(s) {
  const a = Math.hypot(s.M[0], s.M[1]), b = Math.hypot(s.N[0], s.N[1]);
  if (Math.abs(s.sw) >= TAU) { // Ramanujan II (M and N are perpendicular: ellipses are only moved by similarities)
    if (a + b === 0) return 0;
    const h = ((a - b) / (a + b)) ** 2;
    return Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h)));
  }
  // composite Simpson on |P'(t)|, at least 360 steps
  const n = 2 * Math.max(180, Math.ceil(Math.abs(s.sw) / TAU * 1440)), hh = s.sw / n;
  const f = t => Math.hypot(-s.M[0] * Math.sin(t) + s.N[0] * Math.cos(t), -s.M[1] * Math.sin(t) + s.N[1] * Math.cos(t));
  let sum = f(s.t0) + f(s.t0 + s.sw);
  for (let k = 1; k < n; k++) sum += (k % 2 ? 4 : 2) * f(s.t0 + k * hh);
  return Math.abs(sum * hh / 3);
}
function segLen(s) { return s.t === 'L' ? Math.hypot(s.p1[0] - s.p0[0], s.p1[1] - s.p0[1]) : s.t === 'A' ? s.r * Math.abs(s.sw) : ellipseLen(s); }
// signed area term: integral of (x dy - y dx)/2 along the segment, measured from local origin o
// (a closed path's total does not depend on o; a local o keeps georeferenced coordinates precise)
const sub = (p, o) => [p[0] - o[0], p[1] - o[1]];
function segArea(s, o) {
  const p0 = sub(s.p0, o), p1 = sub(s.p1, o);
  if (s.t === 'L') return cross(p0, p1) / 2;
  if (s.t === 'A') return cross(p0, p1) / 2 + s.r * s.r / 2 * (s.sw - Math.sin(s.sw)); // chord + circular segment
  const t1 = s.t0 + s.sw, c = sub(s.c, o);
  return (cross(c, s.M) * (Math.cos(t1) - Math.cos(s.t0)) + cross(c, s.N) * (Math.sin(t1) - Math.sin(s.t0)) + cross(s.M, s.N) * s.sw) / 2;
}
function onSweep(a0, sw, a) { // is angle/param a within [a0, a0+sw] (either direction)
  const lo = sw >= 0 ? a0 : a0 + sw, w = Math.abs(sw);
  return w >= TAU || ((a - lo) % TAU + TAU) % TAU <= w;
}
function segBox(s, bb) {
  const add = p => { if (p[0] < bb[0]) bb[0] = p[0]; if (p[1] < bb[1]) bb[1] = p[1]; if (p[0] > bb[2]) bb[2] = p[0]; if (p[1] > bb[3]) bb[3] = p[1]; };
  add(s.p0); add(s.p1);
  if (s.t === 'A') {
    for (let q = 0; q < 4; q++) if (onSweep(s.a0, s.sw, q * Math.PI / 2)) add([s.c[0] + s.r * cosd(q * 90), s.c[1] + s.r * sind(q * 90)]);
  } else if (s.t === 'E') {
    for (const k of [0, 1]) {
      const tx = Math.atan2(s.N[0], s.M[0]), ty = Math.atan2(s.N[1], s.M[1]);
      for (const t of [tx + k * Math.PI, ty + k * Math.PI]) if (onSweep(s.t0, s.sw, t)) add(ePt(s, t));
    }
  }
}
const newBox = () => [Infinity, Infinity, -Infinity, -Infinity];
function pathMetrics(segs) {
  let length = 0, area = 0; const bbox = newBox(), o = segs.length ? segs[0].p0 : [0, 0];
  for (const s of segs) { length += segLen(s); area += segArea(s, o); segBox(s, bbox); }
  return { length, area, bbox };
}

// ---- geometry key: rounded to 1e-6, independent of direction / start vertex / winding ----
const r6 = v => String(Math.round(v * 1e6));
const pk = p => r6(p[0]) + ',' + r6(p[1]);
function reverseSeg(s) {
  if (s.t === 'L') return L(s.p1, s.p0);
  return Object.assign({}, s, { p0: s.p1, p1: s.p0, sw: -s.sw, t0: s.t === 'E' ? s.t0 + s.sw : s.t0 });
}
function axesKey(s) { // shape of an ellipse independent of how M/N are chosen
  let [A, b] = Math.hypot(...s.M) >= Math.hypot(...s.N) ? [s.M, Math.hypot(...s.N)] : [s.N, Math.hypot(...s.M)];
  if (A[0] < 0 || (A[0] === 0 && A[1] < 0)) A = [-A[0], -A[1]];
  return pk(A) + ';' + r6(b);
}
function segTok(s) {
  if (s.t === 'L') return 'L' + pk(s.p0);
  const dir = (s.t === 'A' ? s.sw : s.sw * cross(s.M, s.N)) > 0 ? '+' : '-';
  return (s.t === 'A' ? 'A' : 'E' + axesKey(s) + ';') + pk(s.p0) + ';' + pk(s.c) + dir;
}
function pathKey(segs, closed) {
  segs = segs.filter(s => !(s.t === 'L' && pk(s.p0) === pk(s.p1)));
  if (!segs.length) return 'p';
  if (closed && segs.length === 1 && Math.abs(segs[0].sw) >= TAU) {
    const s = segs[0];
    return s.t === 'A' ? 'C' + pk(s.c) + ';' + r6(s.r) : 'F' + pk(s.c) + ';' + axesKey(s);
  }
  const rev = segs.slice().reverse().map(reverseSeg);
  if (!closed) {
    const f = segs.map(segTok).join('|') + '|' + pk(segs[segs.length - 1].p1);
    const r = rev.map(segTok).join('|') + '|' + pk(rev[rev.length - 1].p1);
    return 'o' + (f < r ? f : r);
  }
  let best = null;
  for (const list of [segs, rev]) {
    const toks = list.map(segTok);
    let min = toks[0];
    for (const t of toks) if (t < min) min = t;
    toks.forEach((t, i) => {
      if (t !== min) return;
      const k = toks.slice(i).concat(toks.slice(0, i)).join('|');
      if (best === null || k < best) best = k;
    });
  }
  return 'c' + best;
}
function hash(str) { // two 32-bit FNV-1a style lanes -> 16 hex chars (stable, platform independent)
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995); h2 ^= h2 >>> 15;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b); h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
  return (h1 >>> 0).toString(16).padStart(8, '0') + ((h2 ^ (h2 >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

// ---- splines (de Boor, homogeneous for rational) ----
function splinePoints(e, what) {
  const c = e.codes, flags = num(c, 70, 0, what), p = num(c, 71, undefined, what);
  const knots = all(c, 40, what), weights = all(c, 41, what);
  const ctrl = pairs(c, 10, 20, what), fit = pairs(c, 11, 21, what);
  const check = (code, n) => { const v = get(c, code); if (v !== undefined && toNum(v, code, what) !== n) throw new Error('corrupt DXF: group code ' + code + ' count mismatch in ' + what); };
  check(72, knots.length); check(73, ctrl.length); check(74, fit.length);
  let pts;
  if (ctrl.length) {
    if (!Number.isInteger(p) || p < 1 || ctrl.length < p + 1 || knots.length !== ctrl.length + p + 1) throw new Error('corrupt DXF: bad spline degree/knots in ' + what);
    if (weights.length && weights.length !== ctrl.length) throw new Error('corrupt DXF: spline weight count mismatch in ' + what);
    for (let i = 1; i < knots.length; i++) if (knots[i] < knots[i - 1]) throw new Error('corrupt DXF: decreasing spline knots in ' + what);
    const P = ctrl.map((q, i) => { const w = weights.length ? weights[i] : 1; return [q[0] * w, q[1] * w, w]; });
    const at = (t, k) => {
      const d = []; for (let j = 0; j <= p; j++) d.push(P[j + k - p].slice());
      for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
        const lo = knots[j + k - p], al = (t - lo) / (knots[j + 1 + k - r] - lo);
        for (let m = 0; m < 3; m++) d[j][m] = (1 - al) * d[j - 1][m] + al * d[j][m];
      }
      return [d[p][0] / d[p][2], d[p][1] / d[p][2]];
    };
    pts = []; let last = -1;
    for (let k = p; k < ctrl.length; k++) {
      const u0 = knots[k], u1 = knots[k + 1];
      if (!(u1 > u0)) continue;
      for (let i = 0; i < SPLINE_SAMPLES; i++) pts.push(at(u0 + (u1 - u0) * i / SPLINE_SAMPLES, k));
      last = k;
    }
    if (last < 0) throw new Error('corrupt DXF: empty spline knot range in ' + what);
    pts.push(at(knots[last + 1], last));
  } else if (fit.length >= 2) pts = fit; // no control points: polyline through fit points (approx)
  else throw new Error('corrupt DXF: spline without control or fit points in ' + what);
  if (pts.some(q => !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) throw new Error('corrupt DXF: bad spline in ' + what);
  return { pts, closed: (flags & 1) === 1 };
}

// ---- hatch boundary loops ----
const HATCH_GAP_REL = 1e-6; // tolerated edge gap, relative to the loop's bbox diagonal
function hatchLoops(e, what) {
  const c = e.codes; let i = c.findIndex(p => p[0] === 91);
  if (i < 0) throw new Error('corrupt DXF: missing group code 91 in ' + what);
  const take = code => {
    if (i >= c.length || c[i][0] !== code) throw new Error('corrupt DXF: expected group code ' + code + ' in ' + what + (i < c.length ? ', got ' + c[i][0] : ''));
    return toNum(c[i++][1], code, what);
  };
  const opt = code => (i < c.length && c[i][0] === code ? toNum(c[i++][1], code, what) : undefined);
  const nLoops = take(91), loops = [];
  let cw = false;
  for (let l = 0; l < nLoops; l++) {
    const flag = take(92); let segs = [];
    if (flag & 2) { // polyline loop (always closed)
      take(72); take(73); const n = take(93), pts = []; // 72 says whether 42s are written; read them whenever present
      for (let k = 0; k < n; k++) { const x = take(10), y = take(20); pts.push([x, y, opt(42) || 0]); }
      segs = polySegs(pts, true);
    } else {
      const n = take(93);
      for (let k = 0; k < n; k++) {
        const type = take(72);
        if (type === 1) segs.push(L([take(10), take(20)], [take(11), take(21)]));
        else if (type === 2) {
          const cx = take(10), cy = take(20), r = take(40), s = take(50), en = take(51), ccw = take(73);
          if (!ccw) cw = true;
          if (r < 0) throw new Error('corrupt DXF: negative radius in ' + what);
          // clockwise arc edges store their angles measured clockwise (negated)
          const sw = sweepDeg(s, en, false);
          if (sw === null) return { bad: 'hatch_open_loop' };
          segs.push(arcSeg([cx, cy], r, (ccw ? s : -s) * D2R, (ccw ? sw : -sw) * D2R));
        } else if (type === 3) {
          const cx = take(10), cy = take(20), mx = take(11), my = take(21), ratio = take(40), s = take(50), en = take(51), ccw = take(73);
          if (!(ratio > 0 && ratio <= 1 + RATIO_SLACK)) throw new Error('corrupt DXF: ellipse ratio must be in (0, 1] in ' + what);
          if (!ccw) cw = true;
          const sw = sweepDeg(s, en, false);
          if (sw === null) return { bad: 'hatch_open_loop' };
          const toParam = a => Math.atan2(Math.sin(a * D2R) / ratio, Math.cos(a * D2R)); // edge angles are geometric angles
          const N = [-my * ratio, mx * ratio];
          let t0 = toParam(ccw ? s : -s), t1 = toParam(ccw ? en : -en), psw;
          if (sw === 360) psw = ccw ? TAU : -TAU;
          else { psw = ((t1 - t0) % TAU + TAU) % TAU; if (!ccw) psw -= TAU; if (psw === 0 || psw === -TAU) psw = ccw ? TAU : -TAU; }
          segs.push(ellSeg([cx, cy], [mx, my], N, t0, psw));
        } else return { bad: 'unsupported_hatch_edge' }; // spline edges: not measured
      }
      segs = chainLoop(segs);
      if (!segs) return { bad: 'hatch_open_loop' };
    }
    const nSrc = opt(97) || 0;
    for (let k = 0; k < nSrc && i < c.length && c[i][0] === 330; k++) i++;
    if (segs.length) loops.push(segs); // empty boundary loops (93 = 0) are skipped
  }
  let style = 0;
  for (; i < c.length; i++) if (c[i][0] === 75) { style = toNum(c[i][1], 75, what); break; }
  return { loops, style, cw };
}
// Edges must form a closed chain. An edge given backwards is turned round. A gap up to the tolerance
// (relative to the loop's own extent, plus a floating-point floor for large coordinates) is closed with an
// explicit line segment; a larger gap -> null (loop not measurable).
function chainLoop(segs) {
  if (!segs.length) return segs;
  const bb = newBox(); let big = 0;
  for (const s of segs) for (const p of [s.p0, s.p1]) {
    bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]);
    big = Math.max(big, Math.abs(p[0]), Math.abs(p[1]));
  }
  const tol = HATCH_GAP_REL * Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) + 8 * Number.EPSILON * big;
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const out = [segs[0]];
  const link = (p, q) => { if (p[0] !== q[0] || p[1] !== q[1]) out.push(L(p, q)); };
  for (let k = 1; k < segs.length; k++) {
    let prev = out[out.length - 1], s = segs[k];
    const opts = [[dist(prev.p1, s.p0), false, false], [dist(prev.p1, s.p1), false, true]];
    if (k === 1) opts.push([dist(prev.p0, s.p0), true, false], [dist(prev.p0, s.p1), true, true]);
    const [d, revPrev, revCur] = opts.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (d > tol) return null;
    if (revPrev) prev = out[0] = reverseSeg(prev);
    if (revCur) s = reverseSeg(s);
    link(prev.p1, s.p0); out.push(s);
  }
  const last = out[out.length - 1];
  if (dist(last.p1, out[0].p0) > tol) return null;
  link(last.p1, out[0].p0);
  return out;
}
function loopPolygon(segs) {
  const pts = [];
  for (const s of segs) {
    const sp = s.t === 'L' ? [s.p0, s.p1] : sampleSeg(s, PIP_STEP);
    for (let k = pts.length ? 1 : 0; k < sp.length; k++) pts.push(sp[k]);
  }
  return pts;
}
function pointIn(pt, poly) { // even-odd ray cast
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function onBoundary(pt, poly, tol) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / l2)) : 0;
    if (Math.hypot(pt[0] - ax - t * dx, pt[1] - ay - t * dy) <= tol) return true;
  }
  return false;
}
// loop i is inside loop j: bbox inside, and a point of loop i (not on loop j) is inside loop j
function contains(j, i) {
  const a = j.bbox, b = i.bbox;
  if (b[0] < a[0] || b[1] < a[1] || b[2] > a[2] || b[3] > a[3] || Math.abs(i.area) > Math.abs(j.area)) return false;
  const tol = 1e-9 * Math.hypot(a[2] - a[0], a[3] - a[1]) + 8 * Number.EPSILON * Math.max(...a.map(Math.abs));
  for (let k = 0; k + 1 < i.poly.length; k++) {
    const p = i.poly[k], q = i.poly[k + 1], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (!onBoundary(m, j.poly, tol)) return pointIn(m, j.poly);
  }
  return null; // every point of loop i lies on loop j: coincident loops
}
// containment depth of each loop (affine maps keep containment, so this is done once in block coordinates);
// null when two loops coincide (neither contains the other)
function loopDepths(ls) {
  const depths = [];
  for (const l of ls) {
    let depth = 0;
    for (const o of ls) {
      if (o === l) continue;
      const r = contains(o, l);
      if (r === null) return null;
      if (r) depth++;
    }
    depths.push(depth);
  }
  return depths;
}
function hatchArea(loops, depths, style) {
  let area = 0;
  loops.forEach((segs, k) => {
    const a = Math.abs(pathMetrics(segs).area), depth = depths[k];
    if (style === 2) area += depth === 0 ? a : 0;
    else if (style === 1) area += depth === 0 ? a : depth === 1 ? -a : 0;
    else area += depth % 2 ? -a : a;
  });
  return area;
}
// Proper crossings between polygon edges, by sweep over x with bbox pruning. Touching and collinear overlap
// (keyhole slits) are not crossings. self: a loop crosses itself; overlap: two different loops cross.
function side(a, b, c) { const ux = b[0] - a[0], uy = b[1] - a[1]; return (ux * (c[1] - a[1]) - uy * (c[0] - a[0])) / Math.hypot(ux, uy); }
function properCross(a, b, c, d) {
  const tol = 1e-9 * (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - c[0], d[1] - c[1]));
  const s1 = side(a, b, c), s2 = side(a, b, d);
  if (!((s1 > tol && s2 < -tol) || (s1 < -tol && s2 > tol))) return false;
  const s3 = side(c, d, a), s4 = side(c, d, b);
  return (s3 > tol && s4 < -tol) || (s3 < -tol && s4 > tol);
}
// Two passages through one contact point P cross when their edge directions interleave in cyclic order
// around P. A shared direction (collinear slit, island along an edge) counts as touching, not crossing.
function interleaved(P, u1, u2, v1, v2) {
  const ang = q => Math.atan2(q[1] - P[1], q[0] - P[0]);
  const a1 = ang(u1), a2 = ang(u2), b1 = ang(v1), b2 = ang(v2), eps = 1e-9;
  const rel = b => ((b - a1) % TAU + TAU) % TAU, span = rel(a2);
  for (const b of [b1, b2]) { const r = rel(b); if (r < eps || TAU - r < eps || Math.abs(r - span) < eps) return false; }
  return (rel(b1) < span) !== (rel(b2) < span);
}
function crossings(polys) {
  const o = polys.length && polys[0].length ? polys[0][0] : [0, 0], items = [];
  let big = 0; const bb = newBox();
  for (const pts of polys) for (const p of pts) {
    big = Math.max(big, Math.abs(p[0]), Math.abs(p[1]));
    const r = sub(p, o); bb[0] = Math.min(bb[0], r[0]); bb[1] = Math.min(bb[1], r[1]); bb[2] = Math.max(bb[2], r[0]); bb[3] = Math.max(bb[3], r[1]);
  }
  const tol = 1e-9 * Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) + 8 * Number.EPSILON * big;
  const near0 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
  polys.forEach((pts, li) => {
    const q = []; // consecutive points closer than tol are one vertex
    for (const p of pts) { const r = sub(p, o); if (!q.length || !near0(r, q[q.length - 1])) q.push(r); }
    while (q.length > 1 && near0(q[0], q[q.length - 1])) q.pop(); // closed: drop repeated start
    const n = q.length;
    if (n < 3) return; // degenerate loop: no area, no directions
    for (let k = 0; k < n; k++) {
      const a = q[k], b = q[(k + 1) % n];
      items.push({ e: true, a, b, li, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
      items.push({ e: false, p: a, prev: q[(k - 1 + n) % n], next: b, li, x0: a[0], x1: a[0], y0: a[1], y1: a[1] });
    }
  });
  const d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const onInterior = (v, e) => { // vertex strictly inside an edge (not at its ends)
    if (d2(v, e.a) <= tol || d2(v, e.b) <= tol) return false;
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], l2 = dx * dx + dy * dy, t = ((v[0] - e.a[0]) * dx + (v[1] - e.a[1]) * dy) / l2;
    return t > 0 && t < 1 && Math.abs(dx * (v[1] - e.a[1]) - dy * (v[0] - e.a[0])) / Math.sqrt(l2) <= tol;
  };
  items.forEach(it => { it.x0 -= tol; it.x1 += tol; });
  items.sort((p, q) => p.x0 - q.x0);
  const r = { self: false, overlap: false };
  for (let i = 0; i < items.length; i++) {
    const A = items[i];
    for (let j = i + 1; j < items.length && items[j].x0 <= A.x1; j++) {
      const B = items[j], same = A.li === B.li;
      if (B.y0 - tol > A.y1 || B.y1 + tol < A.y0 || (same ? r.self : r.overlap)) continue;
      let hit = false;
      if (A.e && B.e) hit = properCross(A.a, A.b, B.a, B.b);
      else if (!A.e && !B.e) hit = d2(A.p, B.p) <= tol && interleaved(A.p, A.prev, A.next, B.prev, B.next);
      else {
        const v = A.e ? B : A, e = A.e ? A : B;
        hit = onInterior(v.p, e) && interleaved(v.p, v.prev, v.next, e.a, e.b);
      }
      if (hit) {
        if (same) r.self = true; else r.overlap = true;
        if (r.self && r.overlap) return r;
      }
    }
  }
  return r;
}

// ---- raw entity -> local shape (block/OCS coordinates; OCS mirror already applied) ----
const OCS = new Set(['ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'INSERT', 'HATCH', 'TEXT']);
function extrusion(e, what) { // 1 = (0,0,1), -1 = (0,0,-1), 0 = anything else
  const x = num(e.codes, 210, 0, what), y = num(e.codes, 220, 0, what), z = num(e.codes, 230, 1, what);
  const n = Math.hypot(x, y, z);
  if (!(n > 0)) throw new Error('corrupt DXF: zero extrusion direction in ' + what);
  if (Math.abs(x / n) > 1e-9 || Math.abs(y / n) > 1e-9) return 0;
  return z > 0 ? 1 : -1;
}
function buildShape(e, warn) {
  const what = e.type + ' ' + e.handle, c = e.codes;
  const ext = extrusion(e, what);
  if (ext === 0) { warn('nonplanar', e.handle); return null; }
  const mirror = ext < 0 && OCS.has(e.type);
  let sh;
  switch (e.type) {
    case 'LINE':
      if (num(c, 30, 0, what) !== num(c, 31, 0, what)) warn('z_ignored', e.handle); // measured in plan
      sh = { kind: 'open', paths: [{ segs: [L([num(c, 10, undefined, what), num(c, 20, undefined, what)], [num(c, 11, undefined, what), num(c, 21, undefined, what)])], closed: false }] };
      break;
    case 'LWPOLYLINE': case 'POLYLINE': {
      let pts, closed;
      if (e.type === 'POLYLINE') {
        if (num(c, 70, 0, what) & (8 | 16 | 64)) { warn('unsupported_polyline', e.handle); return null; }
        pts = e.vertices; closed = e.closed;
      } else {
        const xy = pairs(c, 10, 20, what), n90 = get(c, 90);
        if (n90 !== undefined && toNum(n90, 90, what) !== xy.length) throw new Error('corrupt DXF: vertex count mismatch in ' + what);
        pts = xy.map(p => [p[0], p[1], 0]);
        let k = -1;
        for (const [code, v] of c) { if (code === 10) k++; else if (code === 42) { if (k < 0) throw new Error('corrupt DXF: bulge before first vertex in ' + what); pts[k][2] = toNum(v, 42, what); } }
        closed = (num(c, 70, 0, what) & 1) === 1;
      }
      sh = { kind: closed ? 'closed' : 'open', paths: [{ segs: polySegs(pts, closed), closed }], anchor: pts.length ? [pts[0][0], pts[0][1]] : null };
      break;
    }
    case 'CIRCLE': case 'ARC': {
      const cx = num(c, 10, undefined, what), cy = num(c, 20, undefined, what), r = num(c, 40, undefined, what);
      if (r < 0) throw new Error('corrupt DXF: negative radius in ' + what);
      if (e.type === 'CIRCLE') { sh = { kind: 'closed', paths: [{ segs: [arcSeg([cx, cy], r, 0, TAU)], closed: true }] }; break; }
      const s = num(c, 50, undefined, what), en = num(c, 51, undefined, what), sw = sweepDeg(s, en, false);
      if (sw === null) { warn('degenerate_arc', e.handle); return null; }
      const seg = arcSeg([cx, cy], r, s * D2R, sw * D2R);
      seg.p0 = [cx + r * cosd(s), cy + r * sind(s)]; seg.p1 = [cx + r * cosd(en), cy + r * sind(en)];
      sh = { kind: 'open', paths: [{ segs: [seg], closed: false }] };
      break;
    }
    case 'ELLIPSE': { // WCS; minor axis = ratio * (extrusion x major)
      const cx = num(c, 10, undefined, what), cy = num(c, 20, undefined, what), mx = num(c, 11, undefined, what), my = num(c, 21, undefined, what);
      const ratio = num(c, 40, undefined, what), t0 = num(c, 41, 0, what), t1 = num(c, 42, TAU, what);
      if (!(ratio > 0 && ratio <= 1 + RATIO_SLACK)) throw new Error('corrupt DXF: ellipse ratio must be in (0, 1] in ' + what);
      let sw = ((t1 - t0) % TAU + TAU) % TAU;
      const full = sw < 1e-12 || TAU - sw < 1e-12;
      if (full) sw = TAU;
      const seg = ellSeg([cx, cy], [mx, my], [-my * ratio * ext, mx * ratio * ext], full ? 0 : t0, sw);
      sh = { kind: full ? 'closed' : 'open', paths: [{ segs: [seg], closed: full }] };
      break;
    }
    case 'SPLINE': {
      const { pts, closed } = splinePoints(e, what), segs = [];
      for (const code of [30, 31]) { const z = all(c, code, what); if (z.some(v => v !== z[0])) warn('z_ignored', e.handle); }
      for (let k = 0; k + 1 < pts.length; k++) segs.push(L(pts[k], pts[k + 1]));
      if (closed && pts.length > 2 && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) segs.push(L(pts[pts.length - 1], pts[0]));
      sh = { kind: closed ? 'closed' : 'open', paths: [{ segs, closed }], approx: true };
      break;
    }
    case 'HATCH': {
      const h = hatchLoops(e, what);
      if (h.bad) { warn(h.bad, e.handle); return null; }
      if (!h.loops.length) { warn('hatch_no_boundary', e.handle); return null; }
      sh = { kind: 'closed', hatch: true, style: h.style, paths: h.loops.map(segs => ({ segs, closed: true })) };
      if (h.cw) { warn('hatch_cw_edge_unverified', e.handle); sh.approx = true; }
      break;
    }
    case 'TEXT': case 'MTEXT': {
      let text = ''; for (const [code, v] of c) if (code === 3) text += v; text += get(c, 1) || '';
      sh = { kind: 'text', point: [num(c, 10, undefined, what), num(c, 20, undefined, what)], text };
      break;
    }
    default: return null;
  }
  if (mirror) {
    if (sh.point) sh.point = ap(MIRROR_X, sh.point);
    if (sh.anchor) sh.anchor = ap(MIRROR_X, sh.anchor);
    if (sh.paths) sh.paths = sh.paths.map(p => ({ segs: xformSegs(p.segs, MIRROR_X, info(MIRROR_X), {}), closed: p.closed }));
  }
  // area is only trusted for simple closed boundaries (checked once; affine maps keep crossings and containment)
  if (sh.kind === 'closed') {
    const polys = sh.paths.filter(p => p.segs.length > 1 || sh.hatch).map(p => loopPolygon(p.segs));
    const x = polys.length ? crossings(polys) : { self: false, overlap: false };
    if (x.self) { warn('self_intersecting', e.handle); sh.noArea = true; }
    if (sh.hatch) {
      const depths = x.overlap ? null : loopDepths(sh.paths.map((p, k) => Object.assign(pathMetrics(p.segs), { poly: polys[k] })));
      if (!depths) { warn('hatch_loops_overlap', e.handle); sh.noArea = true; } else sh.depths = depths;
    }
  }
  return sh;
}

function measure(sh, T, I) {
  const flag = { approx: !!sh.approx };
  if (sh.kind === 'text') {
    const p = ap(T, sh.point);
    return { kind: 'text', length: 0, area: null, approx: false, bbox: [p[0], p[1], p[0], p[1]], geomKey: hash('T' + pk(p) + ';' + sh.text) };
  }
  const paths = sh.paths.map(p => ({ segs: xformSegs(p.segs, T, I, flag), closed: p.closed }));
  let length = 0, area = 0; const bbox = newBox();
  for (const p of paths) {
    const m = pathMetrics(p.segs);
    length += m.length; area += m.area;
    for (let k = 0; k < 2; k++) { bbox[k] = Math.min(bbox[k], m.bbox[k]); bbox[k + 2] = Math.max(bbox[k + 2], m.bbox[k + 2]); }
  }
  if (sh.hatch && !sh.noArea) area = hatchArea(paths.map(p => p.segs), sh.depths, sh.style);
  const key = paths.map(p => pathKey(p.segs, p.closed)).sort().join('&');
  return { kind: sh.kind, length, area: sh.kind === 'closed' && !sh.noArea ? Math.abs(area) : null, approx: flag.approx, bbox, geomKey: hash(key) };
}

const MAX_FLAT = 5000000;
function grid(e, what) { // MINSERT: 70 columns, 71 rows (0 = 1)
  const intOf = code => {
    const n = num(e.codes, code, 1, what);
    if (!Number.isInteger(n) || n < 0) throw new Error('corrupt DXF: bad group code ' + code + ' in ' + what);
    return n || 1;
  };
  return { cols: intOf(70), rows: intOf(71) };
}
// Upper bound of Flat entries (every entity, every INSERT instance), computed before anything is allocated.
function expansionCount(doc) {
  const memo = new Map();
  const tooMany = () => new Error('drawing expands to too many entities (> 5,000,000)');
  const countList = (list, stack) => {
    let n = 0;
    for (const e of list) {
      n += 1;
      if (e.type === 'INSERT') {
        const name = get(e.codes, 2);
        if (name !== undefined && Object.hasOwn(doc.blocks, name)) {
          const { cols, rows } = grid(e, e.type + ' ' + e.handle);
          n += rows * cols * countBlock(name, stack);
        }
      }
      if (n > MAX_FLAT) throw tooMany();
    }
    return n;
  };
  const countBlock = (name, stack) => {
    if (memo.has(name)) return memo.get(name);
    if (stack.includes(name)) throw new Error('recursive block ' + name);
    if (stack.length + 1 > MAX_DEPTH) throw new Error('block nesting deeper than ' + MAX_DEPTH + ' at ' + name);
    const n = countList(doc.blocks[name].entities, stack.concat([name]));
    memo.set(name, n);
    return n;
  };
  return countList(doc.entities, []);
}

function flatten(doc) {
  expansionCount(doc);
  const out = [];
  const seen = new Set(doc.warnings.map(w => w.code + '\0' + w.detail));
  const warn = (code, detail) => { const k = code + '\0' + detail; if (!seen.has(k)) { seen.add(k); doc.warnings.push({ code, detail }); } };
  const shapes = new Map();
  const shapeOf = e => { if (!shapes.has(e)) shapes.set(e, buildShape(e, warn)); return shapes.get(e); };

  const walk = (list, T, depth, prefix, parentLayer, stack) => {
    const I = info(T);
    for (const e of list) {
      const what = e.type + ' ' + e.handle;
      const layer = parentLayer !== null && e.layer === '0' ? parentLayer : e.layer; // BYBLOCK colour does not change layer
      const handle = prefix + e.handle;
      if (e.type === 'INSERT') { insertOf(e, what, T, depth, handle, layer, stack); continue; }
      const sh = shapeOf(e);
      if (!sh) continue;
      const m = measure(sh, T, I);
      if (m.bbox[0] === Infinity) { const p = ap(T, sh.anchor || [0, 0]); m.bbox = [p[0], p[1], p[0], p[1]]; } // no segments (single vertex)
      if (!Number.isFinite(m.length) || (m.area !== null && !Number.isFinite(m.area)) || !m.bbox.every(Number.isFinite))
        throw new Error('geometry error: non-finite result in ' + what);
      out.push({ handle, layer, type: e.type, kind: m.kind, length: m.length, area: m.area, block: null, depth, count: 1, approx: m.approx, bbox: m.bbox, geomKey: m.geomKey });
    }
  };
  const insertOf = (e, what, T, depth, handle, layer, stack) => {
    const c = e.codes, name = get(c, 2);
    if (name === undefined) throw new Error('corrupt DXF: missing block name in ' + what);
    const ext = extrusion(e, what);
    if (ext === 0) { warn('nonplanar', e.handle); return; }
    const { cols, rows } = grid(e, what);
    const sx = num(c, 41, 1, what), sy = num(c, 42, 1, what), rot = num(c, 50, 0, what);
    const cs = num(c, 44, 0, what), rs = num(c, 45, 0, what);
    if (sx === 0 || sy === 0) throw new Error('corrupt DXF: zero scale in ' + what);
    const ix = num(c, 10, undefined, what), iy = num(c, 20, undefined, what);
    const blk = Object.hasOwn(doc.blocks, name) ? doc.blocks[name] : null;
    const base = blk ? blk.base : [0, 0];
    const co = cosd(rot), si = sind(rot);
    // world = T . mirror? . translate(ins) . rotate . translate(col*cs, row*rs) . scale . translate(-base)
    const cell = (i, j) => {
      const ox = j * cs, oy = i * rs;
      let M = [co * sx, si * sx, -si * sy, co * sy, ix + co * (ox - sx * base[0]) - si * (oy - sy * base[1]), iy + si * (ox - sx * base[0]) + co * (oy - sy * base[1])];
      if (ext < 0) M = compose(MIRROR_X, M);
      return compose(T, M);
    };
    const T0 = cell(0, 0), at = ap(T0, base);
    const entry = { handle, layer, type: e.type, kind: 'insert', length: 0, area: null, block: name, depth, count: rows * cols, approx: false,
      bbox: [at[0], at[1], at[0], at[1]], geomKey: hash('I' + name + ';' + T0.map(r6).join(',') + ';' + rows + 'x' + cols + ';' + r6(cs) + ',' + r6(rs)) };
    out.push(entry);
    if (!blk) { warn('missing_block', name); return; }
    if (stack.includes(name)) throw new Error('recursive block ' + name);
    if (depth + 1 > MAX_DEPTH) throw new Error('block nesting deeper than ' + MAX_DEPTH + ' at ' + name);
    const start = out.length, inner = stack.concat([name]);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const tag = rows * cols > 1 ? '@' + i + ',' + j : '';
      walk(blk.entities, cell(i, j), depth + 1, handle + tag + '/', layer, inner);
    }
    if (out.length > start) {
      const bb = newBox();
      for (let k = start; k < out.length; k++) { const b = out[k].bbox; bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); }
      entry.bbox = bb;
    }
  };
  walk(doc.entities, ID, 0, '', null, []);
  return out;
}

module.exports = { flatten };
