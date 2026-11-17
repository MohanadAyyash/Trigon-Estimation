// The formula text of a measurement (spec 5.6): "<metric> <base> <unit> × width w × depth d × factor f = qty unit" (width/
// depth only when given, factor only when not 1); a drawn shape: "length 110.00 pt × 0.1 m/pt = 11.00 m × width 0.5 = 5.50 m2",
// a deduction ends "× −1". Pure: no DOM, no Node APIs, no I/O.
// One file, two users: the measurement list in the browser (window.TakeoffFormula, served at /lib/takeoff/formula.js by
// server.js) and the Excel take-off report (modules/tenders.js, require), so the report shows the list's own text.
// m: a measurement as GET /tenders/:id/measurements returns it. t(key): the UI text of a key (public/i18n.js) in one language.
'use strict';
(function () {
const fin = v => typeof v === 'number' && Number.isFinite(v);
const fmt2 = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQ = v => fin(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : '';
const fmtScale = v => v.toLocaleString('en-US', { maximumSignificantDigits: 6 });
const METRIC_KEYS = { open_length: 'mt_open_length', closed_perimeter: 'mt_closed_perimeter', area: 'mt_area', count: 'mt_count', length: 'mt_length', perimeter: 'mt_perimeter' };
// every i18n key this file reads (test-ui.js checks both languages have them)
const KEYS = [...Object.values(METRIC_KEYS), 'f_width', 'f_depth', 'f_factor', 'tv_unit_pt', 'tv_unit_px'];
const metricLabel = (metric, t) => Object.hasOwn(METRIC_KEYS, metric) ? t(METRIC_KEYS[metric]) : metric;

// a drawn shape (batch 3): the shape in drawing/page units × the scale it used, then the batch 1 factors
function manualHow(m, t) {
  const ml = metricLabel(m.metric, t);
  const u = m.drawing_kind === 'pdf' ? t('tv_unit_pt') : m.drawing_kind === 'image' ? t('tv_unit_px') : (m.drawing_units || '');
  const extras = (fin(m.width) ? ' × ' + t('f_width') + ' ' + fmtQ(m.width) : '') + (fin(m.depth) ? ' × ' + t('f_depth') + ' ' + fmtQ(m.depth) : '')
    + (fin(m.factor) && m.factor !== 1 ? ' × ' + t('f_factor') + ' ' + fmtQ(m.factor) : '') + (m.deduct ? ' × −1' : '');
  const tail = extras && fin(m.qty) ? extras + ' = ' + fmt2(m.qty) + ' ' + (m.qty_unit || '') : '';
  if (!fin(m.base)) return ml + (fin(m.qty) ? ' = ' + fmt2(m.qty) + ' ' + (m.qty_unit || '') : '');
  if (m.metric === 'count' || !fin(m.scale)) return ml + ' ' + (m.metric === 'count' ? fmtQ(m.base) + ' nr' : fmt2(m.base) + (m.metric === 'area' ? ' m2' : ' m'))
    + (tail || (fin(m.qty) && m.qty !== m.base ? ' = ' + fmt2(m.qty) + ' ' + (m.qty_unit || '') : ''));
  const shape = m.metric === 'area' ? fmt2(m.base / (m.scale * m.scale)) + ' ' + u + '² × (' + fmtScale(m.scale) + ' m/' + u + ')² = ' + fmt2(m.base) + ' m2'
    : fmt2(m.base / m.scale) + ' ' + u + ' × ' + fmtScale(m.scale) + ' m/' + u + ' = ' + fmt2(m.base) + ' m';
  return ml + ' ' + shape + tail;
}

// A measurement saved before `base` was stored derives it from qty when every factor is known; otherwise only the qty is shown.
function formulaText(m, t) {
  if (m.tool === 'manual') return manualHow(m, t);
  const w = m.width === null || m.width === undefined ? 1 : m.width, d = m.depth === null || m.depth === undefined ? 1 : m.depth, f = m.factor;
  const known = [w, d, f].every(x => fin(x) && x > 0);
  const base = fin(m.base) ? m.base : known && fin(m.qty) ? m.qty / (w * d * f) : null;
  const tail = fin(m.qty) ? ' = ' + fmt2(m.qty) + ' ' + (m.qty_unit || '') : '';
  if (base === null) return metricLabel(m.metric, t) + tail;
  const unit = m.metric === 'count' ? 'nr' : m.metric === 'area' ? 'm2' : 'm';
  return metricLabel(m.metric, t) + ' ' + (m.metric === 'count' ? fmtQ(base) : fmt2(base)) + ' ' + unit + (fin(m.width) ? ' × ' + t('f_width') + ' ' + fmtQ(m.width) : '')
    + (fin(m.depth) ? ' × ' + t('f_depth') + ' ' + fmtQ(m.depth) : '') + (fin(f) && f !== 1 ? ' × ' + t('f_factor') + ' ' + fmtQ(f) : '') + tail;
}

const TakeoffFormula = { formulaText, metricLabel, KEYS };
if (typeof module !== 'undefined' && module.exports) module.exports = TakeoffFormula; else window.TakeoffFormula = TakeoffFormula;
})();
