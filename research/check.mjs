// Cross-check: pick ideas on one dataset, test them on the other one (never seen during picking).
// Rule fixed up front: keep an idea if, ALONE, it beat the baseline on BOTH the funded-portfolio and the
// even-split measure on the picking dataset. Then run the combined bundle on the other dataset.
//   node research/check.mjs [idea,idea,...]   (optional: also evaluate a hand-given bundle on both)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CFG } from '../city.mjs';
import { load } from './data.mjs';
import { buildDays, build, portOf, evenSplit, runCfg, growth, maxDD, spyHold, stratCard, WARM, TOGGLES } from './lab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D1all = buildDays(load('1m'), 1, 300), D5 = buildDays(load('5m'), 5, 60).filter((x) => x.d < D1all[0].d);
const sets = { '1m': { D: D1all, tag: '1m', from: WARM + 3 }, '5m': { D: D5, tag: '5m', from: WARM } };
const P = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';

function evalBundle(names, s) {
  const { D, tag, from } = s, to = D.length, cfg = build(names);
  const p = portOf(names, D, tag, from, to), e = cfg.strats.length ? evenSplit(runCfg(cfg, D, tag), from, to) : [];
  const tr = cfg.strats.length ? runCfg(cfg, D, tag).trades.filter((t) => t.di >= from) : [];
  const fundedTrades = tr.length; // all bots (practice) — for scale only
  return { port: growth(p), dd: maxDD(p), even: growth(e), spy: spyHold(D, from, to), days: to - from, practiceTradesPerDay: fundedTrades / (to - from) };
}
function pickOn(s) {
  const b = evalBundle([], s), keep = [];
  for (const n of Object.keys(TOGGLES)) {
    const cfg = build([n]); if (!cfg.strats.length) continue;
    const r = evalBundle([n], s), fundOnly = !!TOGGLES[n].c?.fund;
    if (r.port > b.port && (fundOnly || r.even > b.even)) keep.push(n);
  }
  // one per group, strongest first
  const seen = new Set(), out = [];
  for (const n of keep.sort((x, y) => evalBundle([y], s).port - evalBundle([x], s).port)) { const g = TOGGLES[n].g; if (!seen.has(g)) { seen.add(g); out.push(n); } }
  return out;
}

const res = {};
for (const [pick, test] of [['1m', '5m'], ['5m', '1m']]) {
  const names = pickOn(sets[pick]);
  const b = evalBundle([], sets[test]), x = evalBundle(names, sets[test]);
  res[`${pick}->${test}`] = { picked: names, base: b, bundle: x };
  console.log(`picked on ${pick}: [${names.join(', ')}]`);
  console.log(`  tested on ${test} (${x.days} unseen days): bundle ${P(x.port)} (dd ${P(x.dd)}, even ${P(x.even)}) vs baseline ${P(b.port)} (dd ${P(b.dd)}, even ${P(b.even)}) | SPY ${P(x.spy)}`);
}
const hand = process.argv[2]?.split(',').filter(Boolean);
if (hand) {
  res.hand = { names: hand };
  for (const k of ['1m', '5m']) {
    const b = evalBundle([], sets[k]), x = evalBundle(hand, sets[k]);
    res.hand[k] = { base: b, bundle: x, cards: stratCard(sets[k].D, k, build(hand), sets[k].from, sets[k].D.length) };
    console.log(`hand bundle [${hand.join(', ')}] on ${k}: ${P(x.port)} dd ${P(x.dd)} even ${P(x.even)} | baseline ${P(b.port)} dd ${P(b.dd)} even ${P(b.even)} | SPY ${P(x.spy)} | practice trades/day ${x.practiceTradesPerDay.toFixed(0)} (base ${b.practiceTradesPerDay.toFixed(0)})`);
    for (const [st, v] of Object.entries(res.hand[k].cards)) console.log(`   ${st.padEnd(9)} tot ${P(v.total)} win ${(v.winRate * 100).toFixed(0)}% PF ${v.pf.toFixed(2)} trades/day ${v.perDay.toFixed(1)}`);
    for (const n of hand) { const lo = evalBundle(hand.filter((y) => y !== n), sets[k]); console.log(`   without ${n.padEnd(8)} ${P(lo.port)} (even ${P(lo.even)})`); }
  }
}
fs.writeFileSync(path.join(HERE, 'check.json'), JSON.stringify(res, null, 1));
