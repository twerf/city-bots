// Parameter sweeps around the shipped settings. For each setting, try a small grid with everything else fixed.
// Pick on the 1-minute month using a neighbour-smoothed score (value + the settings next to it), so a lone lucky
// number can't win, then check the picks on the older 5-minute days nobody tuned on.
//   node research/sweep.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED } from '../city.mjs';
import { load } from './data.mjs';
import { buildDays, runCfg, portfolio, evenSplit, growth, maxDD, spyHold, WARM } from './lab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D1 = buildDays(load('1m'), 1, 300), D5 = buildDays(load('5m'), 5, 60).filter((x) => x.d < D1[0].d);
const S1 = { D: D1, tag: '1m', from: WARM }, S5 = { D: D5, tag: '5m', from: WARM };
const P = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const setp = (cfg, key, v) => { const c = structuredClone(cfg); const k = key.split('.'); let o = c; while (k.length > 1) o = o[k.shift()]; o[k[0]] = v; return c; };
export function evalCfg(cfg, s) {
  const run = runCfg(cfg, s.D, s.tag), p = portfolio(run, cfg.fund, s.from, s.D.length), e = evenSplit(run, s.from, s.D.length);
  return { port: growth(p), dd: maxDD(p), even: growth(e), spy: spyHold(s.D, s.from, s.D.length) };
}
const GRID = {
  amEnd: [630, 660, 675, 690, 720, 780], maxTrades: [1, 2, 3, 4, 6], gapMin: [0.002, 0.003, 0.004, 0.006], rsiLo: [20, 25, 30],
  'lock.up': [0.01, 0.02, 0.03, 0.05], 'fund.top': [4, 6, 8, 10, 12], 'fund.window': [5, 7, 10, 15], 'fund.shrink': [1, 3, 6],
  'fund.bench': [0, 2, 3, 4], 'fund.capCluster': [2, 3, 99],
};

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = {}; let picked = structuredClone(SHIPPED);
  for (const [key, vals] of Object.entries(GRID)) {
    const rows = vals.map((v) => { const c = setp(SHIPPED, key, v); if (key === 'fund.capCluster') c.fund.capTicker = v === 99 ? 99 : 2; return { v, c, a: evalCfg(c, S1), b: evalCfg(c, S5) }; });
    const lg = (x) => Math.log(1 + x.a.port) + 0.5 * Math.log(1 + x.a.even);
    rows.forEach((r, i) => { const nb = rows.slice(Math.max(0, i - 1), i + 2); r.smooth = nb.reduce((a, x) => a + lg(x), 0) / nb.length; });
    const best = rows.reduce((a, r) => (r.smooth > a.smooth ? r : a));
    const cur = key.split('.').reduce((o, k) => o[k], SHIPPED);
    console.log(`\n${key} (shipped ${cur}) -> pick ${best.v}`);
    for (const r of rows) console.log(`  ${String(r.v).padEnd(6)} 1m: port ${P(r.a.port).padStart(7)} even ${P(r.a.even).padStart(7)} smooth ${(r.smooth * 100).toFixed(2).padStart(6)} | 5m(unseen): port ${P(r.b.port).padStart(7)} even ${P(r.b.even).padStart(7)} dd ${P(r.b.dd)}`);
    out[key] = { shipped: cur, pick: best.v, rows: rows.map((r) => ({ v: r.v, m1: r.a, m5: r.b, smooth: r.smooth })) };
    picked = setp(picked, key, best.v); if (key === 'fund.capCluster') picked.fund.capTicker = best.v === 99 ? 99 : 2;
  }
  const sh1 = evalCfg(SHIPPED, S1), sh5 = evalCfg(SHIPPED, S5), pk1 = evalCfg(picked, S1), pk5 = evalCfg(picked, S5);
  console.log(`\nshipped  1m ${P(sh1.port)} even ${P(sh1.even)} | 5m ${P(sh5.port)} dd ${P(sh5.dd)} even ${P(sh5.even)} | SPY 1m ${P(sh1.spy)} 5m ${P(sh5.spy)}`);
  console.log(`swept    1m ${P(pk1.port)} even ${P(pk1.even)} | 5m ${P(pk5.port)} dd ${P(pk5.dd)} even ${P(pk5.even)}`);
  fs.writeFileSync(path.join(HERE, 'sweep.json'), JSON.stringify({ out, picked, sh1, sh5, pk1, pk5 }, null, 1));
}
