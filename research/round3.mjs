// Round 3 evaluation: realistic fills, luck check, in-play scanner, risk-sized bets, options view.
//   node research/round3.mjs     -> prints the tables, writes research/round3.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED, BASE_CFG, UNIVERSE } from '../city.mjs';
import { load } from './data.mjs';
import { buildDays, runCfg, portfolio, evenSplit, growth, maxDD, spyHold, stratCard, WARM } from './lab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ---- luck check: resample the daily returns with replacement; how often does the total come out above zero?
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function pAboveZero(daily, n = 5000, seed = 7) {
  if (!daily.length) return 0; const R = rng(seed); let pos = 0;
  for (let k = 0; k < n; k++) { let g = 0; for (let i = 0; i < daily.length; i++) g += Math.log(1 + daily[Math.floor(R() * daily.length)]); if (g > 0) pos++; }
  return pos / n;
}
const P = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const luck = (p) => `${Math.round(p * 100)}%${p < 0.8 ? ' (could be luck)' : ''}`;

const t0 = Date.now();
const D1 = buildDays(load('1m'), 1, 300), D5 = buildDays(load('5m'), 5, 60).filter((x) => x.d < D1[0].d);
const sets = { m1: { name: '1-minute month', D: D1, tag: '1m' }, m5: { name: 'older 5-minute days (never tuned on)', D: D5, tag: '5m' } };
console.log(`1m ${D1.length} days ${D1[0].d}..${D1.at(-1).d} | 5m ${D5.length} days ${D5[0].d}..${D5.at(-1).d} | universe ${UNIVERSE.length}`);

function evalCfg(cfg, s) {
  const { D, tag } = s, run = runCfg(cfg, D, tag), p = portfolio(run, cfg.fund, WARM, D.length, D), po = portfolio(run, cfg.fund, WARM, D.length, D, 'O');
  const e = evenSplit(run, WARM, D.length), tr = run.trades.filter((t) => t.di >= WARM);
  const eq = []; p.reduce((v, r) => (eq.push(v * (1 + r)), v * (1 + r)), 20);
  return { usd: 20 * (1 + growth(p)), ret: growth(p), dd: maxDD(p), luck: pAboveZero(p), even: growth(e), evenLuck: pAboveZero(e), spy: spyHold(D, WARM, D.length), trades: tr.length, low: Math.min(20, ...eq), high: Math.max(20, ...eq),
    optUsd: 20 * (1 + growth(po)), optDD: maxDD(po), daily: p };
}
const show = (label, r) => console.log(`  ${label.padEnd(34)} $20 -> $${r.usd.toFixed(2)} (${P(r.ret)}, worst drop ${P(r.dd)}, luck check ${luck(r.luck)}) | even split ${P(r.even)} | SPY ${P(r.spy)} | trades ${r.trades}`);

const CUR = SHIPPED, NEXT = { ...SHIPPED, fill: 'next' };
const variants = {
  'current (fill at signal close)': CUR,
  'current, realistic fills': NEXT,
  '+ risk-sized bets': { ...NEXT, fund: { ...NEXT.fund, size: 'risk' } },
  '+ scanner, top 15 of 64': { ...NEXT, syms: UNIVERSE, scan: 15 },
  'control: all 64, no scanner': { ...NEXT, syms: UNIVERSE },
  '+ scanner + risk-sized': { ...NEXT, syms: UNIVERSE, scan: 15, fund: { ...NEXT.fund, size: 'risk' } },
};
const out = { sets: {}, cards: {} };
for (const [k, s] of Object.entries(sets)) {
  console.log(`\n${s.name}: ${s.D[WARM].d} .. ${s.D.at(-1).d} (${s.D.length - WARM} days)`);
  out.sets[k] = {};
  for (const [label, cfg] of Object.entries(variants)) { const r = evalCfg(cfg, s); show(label, r); out.sets[k][label] = { ...r, daily: undefined }; }
  const cur = out.sets[k]['current, realistic fills'];
  console.log(`  options view (estimate, current bots): $20 -> $${cur.optUsd.toFixed(2)} (worst drop ${P(cur.optDD)})`);
  out.cards[k] = stratCard(s.D, s.tag, NEXT, WARM, s.D.length);
  for (const [st, v] of Object.entries(out.cards[k])) console.log(`   ${st.padEnd(8)} trades ${String(v.trades).padStart(4)}${v.trades < 30 ? ' (too few to trust)' : ''} win ${(v.winRate * 100).toFixed(0)}% PF ${v.pf.toFixed(2)} total ${P(v.total)}`);
}
// ship check: beats current (realistic fills), its even split, and SPY, on BOTH datasets
console.log('\nship check (must beat current-realistic, even split and SPY on both datasets):');
out.ship = {};
for (const label of ['+ risk-sized bets', '+ scanner, top 15 of 64', '+ scanner + risk-sized']) {
  const ok = Object.keys(sets).every((k) => { const v = out.sets[k][label], c = out.sets[k]['current, realistic fills']; return v.ret > c.ret && v.ret > c.even && v.ret > v.spy; });
  out.ship[label] = ok; console.log(`  ${label.padEnd(30)} ${ok ? 'PASS' : 'fail'}`);
}
fs.writeFileSync(path.join(HERE, 'round3.json'), JSON.stringify(out, null, 1));
console.log('secs', (Date.now() - t0) / 1000);
