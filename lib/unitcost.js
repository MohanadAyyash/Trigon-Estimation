// Unit cost of a library item version (pure). Uses raw snapshot rates: a crew cost never exposes one person's pay,
// and the caller decides what part breakdown a role may see. A missing price/rate/output is never treated as zero.
const pos = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const fin = (n, d) => typeof n === 'number' && Number.isFinite(n) ? n : d;
const nn = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function unitCost(v, snap, cfg) {
  const factor = fin(v.condition_factor, 1), rework = fin(v.rework_pct, 0), hours = cfg.work_hours;
  const trades = new Map(((snap && snap.trades) || []).map(t => [t.trade, t]));
  const equip = new Map(((snap && snap.equipment) || []).map(e => [e.id, e]));
  const parts = [], missing = [];
  const miss = code => { if (!missing.includes(code)) missing.push(code); };
  let sum = 0, ok = true;
  for (const p of v.parts || []) {
    let cost = null;
    if (p.kind === 'material') {
      const price = cfg.materialPrice(p.material_id);
      if (!pos(price)) miss('material:' + p.material_id);
      else if (!nn(p.qty)) miss('material:qty');
      else cost = p.qty * (1 + fin(p.waste_pct, 0) / 100) * price;
    } else if (p.kind === 'labour') {
      let crew = 0, bad = false;
      for (const c of p.crew || []) {
        const t = trades.get(c.trade);
        if (!pos(c.count)) { miss('labour:count'); bad = true; }
        if (!t || !pos(t.rate)) { miss('trade:' + c.trade); bad = true; } else if (pos(c.count)) crew += c.count * t.rate;
      }
      if (!pos(p.output_per_day)) { miss('labour:output'); bad = true; }
      if (!pos(hours)) { miss('work_hours'); bad = true; }
      if (!bad) cost = crew * hours / p.output_per_day * factor;
    } else if (p.kind === 'equipment') {
      const e = equip.get(p.equipment_id);
      let bad = false;
      if (!e || !pos(e.rate)) { miss('equipment:' + p.equipment_id); bad = true; }
      if (!pos(p.output_per_hour)) { miss('equipment:output'); bad = true; }
      if (!bad) cost = e.rate / p.output_per_hour * factor;
    } else if (p.kind === 'sub') { if (nn(p.rate)) cost = p.rate; else miss('sub:rate'); }
    else if (p.kind === 'fixed') { if (nn(p.amount)) cost = p.amount; else miss('fixed:amount'); }
    else throw new Error('unknown part kind: ' + p.kind);
    if (cost !== null && !Number.isFinite(cost)) { miss('overflow'); cost = null; }
    parts.push({ kind: p.kind, cost });
    if (cost === null) ok = false; else sum += cost;
  }
  let unit = ok ? sum * (1 + rework / 100) : null;
  if (unit !== null && !Number.isFinite(unit)) { miss('overflow'); unit = null; }
  return { unit, parts, missing };
}

module.exports = { unitCost };
