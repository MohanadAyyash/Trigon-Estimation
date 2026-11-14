// Monthly cash-flow financing cost (spec 5.7). Pure; percent inputs are percentages (10 = 10 %).
// Numbers are unrounded: round only at display boundaries.
const MAX_MONTHS = 1200; // guards against absurd inputs allocating huge schedules

const fail = msg => { const e = new Error(msg); e.code = 'bad_input'; throw e; };
const isNum = x => typeof x === 'number' && Number.isFinite(x);

function financingCost(p) {
  if (!p || typeof p !== 'object') fail('input must be an object');
  const { spend, M, V, adv_pct, ret_pct, collection_days, retention_months, rate_pct } = p;
  if (!Number.isInteger(M) || M < 1 || M > MAX_MONTHS) fail('M (project duration in months) must be a positive integer');
  if (!isNum(spend) || spend < 0) fail('spend must be a finite number >= 0');
  if (!isNum(V) || V <= 0) fail('V (contract value) must be a finite number > 0');
  if (!isNum(adv_pct) || adv_pct < 0 || adv_pct >= 100) fail('adv_pct must be >= 0 and < 100');
  if (!isNum(ret_pct) || ret_pct < 0 || ret_pct >= 100) fail('ret_pct must be >= 0 and < 100');
  if (!isNum(rate_pct) || rate_pct < 0) fail('rate_pct must be a finite number >= 0');
  if (!isNum(collection_days) || collection_days < 0 || Math.ceil(collection_days / 30) > MAX_MONTHS) fail('collection_days must be a finite number >= 0 (at most ' + MAX_MONTHS * 30 + ')');
  if (!Number.isInteger(retention_months) || retention_months < 0 || retention_months > MAX_MONTHS) fail('retention_months must be an integer >= 0');

  const adv = adv_pct / 100, ret = ret_pct / 100, rate = rate_pct / 100;
  const lag = Math.ceil(collection_days / 30);
  const last = M + Math.max(lag, retention_months);
  const out = new Array(last + 1).fill(0), inn = new Array(last + 1).fill(0);
  inn[0] += V * adv;
  for (let m = 1; m <= M; m++) {
    out[m] += spend / M;
    inn[m + lag] += V / M * (1 - ret) - V * adv / M;
  }
  inn[M + retention_months] += V * ret;

  const schedule = [];
  let balance = 0, F = 0;
  for (let t = 0; t <= last; t++) {
    balance += inn[t] - out[t];
    const cost = Math.max(0, -balance) * rate / 12;
    F += cost;
    schedule.push({ month: t, out: out[t], in: inn[t], balance, cost });
  }
  if (!Number.isFinite(F)) fail('financing cost is not finite; check inputs');
  return { F, schedule };
}

module.exports = { financingCost };
