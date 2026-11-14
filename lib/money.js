// Money helpers (AED). Round only at display / unit-rate / export boundaries, never inside iterations.
const round2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
// Parse a user-typed number: strips commas and spaces; null for empty or non-numeric (never 0).
const num = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,\s]/g, '');
  if (s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return Number(s);
};
module.exports = { round2, num };
