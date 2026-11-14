// Tender pricing engine (spec 5.6-5.7). Pure. Percent inputs are percentages (12 = 12 %).
// Finds the contract value V by fixed point (H's pct items, OH and F all depend on V).
// Results are unrounded except the BOQ rates/amounts, total and rounding_diff.
const { round2 } = require('./money.js');
const { financingCost } = require('./cashflow.js');

const MAX_ITER = 100, TOL = 0.005;
const err = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
const fail = msg => { throw err('bad_input', msg); };
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const need = (x, name) => { if (!isNum(x) || x < 0) fail(name + ' must be a finite number >= 0'); return x; };
const finite = (x, name) => { if (!Number.isFinite(x)) fail(name + ' is not finite; check inputs'); return x; };

function priceTender(input) {
  if (!input || typeof input !== 'object') fail('input must be an object');
  const { rows, hidden, M, oh_monthly, w_monthly, finance_rate_pct, margin_pct, min_profit_pct,
          adv_pct, ret_pct, collection_days, retention_months } = input;

  if (!Array.isArray(rows)) fail('rows must be an array');
  if (!Array.isArray(hidden)) fail('hidden must be an array');
  if (!Number.isInteger(M) || M < 1) fail('M (project duration in months) must be a positive integer');
  if (!isNum(oh_monthly) || oh_monthly < 0) fail('oh_monthly (monthly overhead) is missing or invalid; overhead must be a finite number >= 0');
  need(w_monthly, 'w_monthly (monthly work in hand)');
  need(finance_rate_pct, 'finance_rate_pct');
  for (const [v, n] of [[margin_pct, 'margin_pct'], [min_profit_pct, 'min_profit_pct']])
    if (!isNum(v) || v < 0 || v >= 100) fail(n + ' must be >= 0 and < 100');
  if (isNum(adv_pct) && isNum(ret_pct) && adv_pct + ret_pct >= 100) fail('adv_pct + ret_pct must be < 100');

  let D = 0;
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') fail(`rows[${i}] must be an object`);
    need(row.qty, `rows[${i}].qty`);
    need(row.direct_unit, `rows[${i}].direct_unit`);
    D += row.qty * row.direct_unit;
  });
  finite(D, 'D (direct cost)');
  if (D <= 0) fail('D (direct cost) must be > 0');

  const rate = finance_rate_pct / 100;
  let Hfixed = 0, pctSum = 0, L = 0;
  hidden.forEach((h, i) => {
    if (!h || typeof h !== 'object') fail(`hidden[${i}] must be an object`);
    const at = f => `hidden[${i}].${f}`;
    switch (h.kind) {
      case 'fixed': Hfixed += need(h.amount, at('amount')); break;
      case 'monthly': Hfixed += need(h.amount, at('amount')) * M; break;
      case 'pct': pctSum += need(h.pct, at('pct')); break;
      case 'locked': {
        const amount = need(h.amount, at('amount')), months = need(h.months, at('months'));
        const fee = need(h.bank_fee_pct, at('bank_fee_pct')), loss = need(h.loss_pct, at('loss_pct'));
        // Bank fee is per year, pro-rated over the months held; loss is an expected cost.
        L += amount * (rate * months / 12 + fee / 100 * months / 12 + loss / 100);
        break;
      }
      default: fail(`hidden[${i}].kind must be one of fixed, monthly, pct, locked`);
    }
  });
  finite(Hfixed, 'H (hidden items)'); finite(L, 'L (locked amounts cost)');

  const margin = margin_pct / 100, minProfit = min_profit_pct / 100;
  const at = V => {
    const H = finite(Hfixed + pctSum / 100 * V, 'H (hidden items)');
    const OH = finite(oh_monthly * M * V / (V + w_monthly * M), 'OH (overhead)');
    const { F, schedule } = financingCost({ spend: D + H + OH, M, V, adv_pct, ret_pct, collection_days, retention_months, rate_pct: finance_rate_pct });
    const C = finite(D + H + OH + F + L, 'C (true cost)');
    return { H, OH, F, C, P: finite(C / (1 - margin), 'P (price)'), schedule };
  };

  let V = finite(D / (1 - margin), 'V (contract value)'), s, iterations = 0;
  for (;;) {
    if (iterations >= MAX_ITER) throw err('no_convergence', `pricing did not converge after ${MAX_ITER} iterations; check percentage hidden items against the margin`);
    s = at(V); iterations++;
    if (Math.abs(s.P - V) < TOL) break;
    V = s.P;
  }

  const { H, OH, F, C, P, schedule } = s;
  const P_min = finite(C / (1 - minProfit), 'P_min (floor price)');
  // Flat-percentage comparison is meaningless with no work in hand (w_monthly 0): null, not a number.
  const OH_flat_compare = w_monthly > 0 ? finite(oh_monthly * 12 / (w_monthly * 12) * V, 'OH_flat_compare') : null;
  const out = rows.map(row => {
    const r = round2(finite(row.direct_unit * P / D, 'row rate'));
    return { id: row.id, rate: r, amount: round2(row.qty * r) };
  });
  const total = round2(out.reduce((t, x) => t + x.amount, 0));
  return { D, H, OH, F, L, C, V, P, P_min, OH_flat_compare, rows: out, total,
           rounding_diff: round2(finite(total - P, 'rounding_diff')), iterations, schedule };
}

module.exports = { priceTender };
