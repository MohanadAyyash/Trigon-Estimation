// Calibration of a PDF page or an image (batch 3, plan Task 3): two points in page units (PDF points, image pixels) and
// the real length between them give the scale in metres per page unit. A region (a rectangle [minx, miny, maxx, maxy]
// in the same page units) may have its own calibration; a measurement uses the region containing its first point, else
// the page calibration. Pure: no I/O.
const { UNIT_TO_M } = require('../units');

const MIN_DIST = 10;          // page units between the two points
const MAX_COORD = 1e9;

const isPoint = p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD);
function checkPoint(p, name = 'point') { if (!isPoint(p)) throw new Error(`${name} must be a point [x, y] (finite numbers)`); return p; }
// real length in metres; throws on a bad length or unit
function metres(real, unit) {
  if (typeof unit !== 'string' || !Object.hasOwn(UNIT_TO_M, unit)) throw new Error('unit must be one of ' + Object.keys(UNIT_TO_M).join(', '));
  if (typeof real !== 'number' || !Number.isFinite(real) || !(real > 0)) throw new Error('the real length must be a number > 0');
  const m = real * UNIT_TO_M[unit];
  // e.g. 1e306 km overflows to Infinity, 5e-324 mm underflows to 0
  if (!Number.isFinite(m) || !(m > 0)) throw new Error('the real length is out of range');
  return m;
}
// the distance between the two points, at least MIN_DIST page units
function span(p1, p2) {
  checkPoint(p1, 'p1'); checkPoint(p2, 'p2');
  const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (!(d >= MIN_DIST)) throw new Error(`the two points must be at least ${MIN_DIST} page units apart`);
  return d;
}

// metres per page unit
function scaleOf(p1, p2, real, unit) {
  const d = span(p1, p2), m = metres(real, unit), s = m / d;
  if (!Number.isFinite(s) || !(s > 0)) throw new Error('the calibration gives no usable scale');
  return s;
}

// a region as [minx, miny, maxx, maxy] (corners in any order); throws unless it is 4 finite numbers with a size > 0
function normRect(r) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD)) throw new Error('region must be [x0, y0, x1, y1] (finite numbers)');
  const out = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  if (!(out[2] > out[0]) || !(out[3] > out[1])) throw new Error('region must have a size > 0');
  return out;
}
// two normalised rectangles share some area (touching at an edge or a corner is not an overlap)
const rectsOverlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
// a stored region: NULL (the page), JSON text or an array
const regionOf = cal => cal.region === null || cal.region === undefined ? null : typeof cal.region === 'string' ? JSON.parse(cal.region) : cal.region;
const contains = (r, p) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];

// the calibration that applies at a point: the region whose rectangle contains it (edges included; on an edge shared by
// two regions, the lower id), else the page calibration, else null
function calibrationFor(cals, point) {
  checkPoint(point);
  let best = null, page = null;
  for (const c of cals) {
    const r = regionOf(c);
    if (r === null) { if (page === null) page = c; continue; }
    if (contains(r, point) && (best === null || c.id < best.id)) best = c;
  }
  return best || page;
}

// a second known line checked against a calibration: (measured − real) / real × 100
function verifyPct(cal, p1, p2, real, unit) {
  const d = span(p1, p2), m = metres(real, unit), pct = (d * cal.scale - m) / m * 100;
  if (!Number.isFinite(pct)) throw new Error('the verify line gives no usable result');
  return pct;
}

module.exports = { MIN_DIST, scaleOf, normRect, rectsOverlap, regionOf, calibrationFor, verifyPct, checkPoint };
