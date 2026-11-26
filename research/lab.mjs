// Research lab: walk-forward testing of bot ideas on cached real bars, with costs on every trade.
// Uses the exact engine the live bots use (stepBars from city.mjs).
//   node research/lab.mjs          -> prints a summary, writes research/REPORT.md + research/results.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMS, UNIVERSE, BASE_CFG, botsFor, indicators, moodSeries, newBotDay, stepBars, flatten, pickFunded, scanInPlay, hlc, splitDays, et } from '../city.mjs';
import { load } from './data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WARM = 5, BLOCK = 3; // first 5 days only build track records; then train-on-past / test-on-next-3, sliding
const ALL7 = ['trend', 'og', 'fade', 'vwapb', 'pdhl', 'gap', 'pullback'];

// ---------- data ----------
export function buildDays(raw, barMin, minBars, scanTop = 15) {
  const syms = UNIVERSE.filter((s) => raw[s]?.length);
  const per = Object.fromEntries(syms.map((s) => [s, splitDays(raw[s])]));
  const days = [...per.SPY.keys()].filter((d) => per.SPY.get(d).length >= minBars);
  const n5 = Math.max(1, Math.round(5 / barMin));
  return days.map((d) => {
    const spy = per.SPY.get(d), er = moodSeries(spy, barMin), closeMin = et(spy.at(-1).t).min + barMin, out = { d, sym: {} };
    out.spyRet = spy.at(-1).c / spy[0].o - 1; out.spyClose = spy.at(-1).c; out.spyOpen = spy[0].o;
    const rows = [];
    for (const s of syms) {
      const bars = per[s].get(d); if (!bars?.length) continue;
      const keys = [...per[s].keys()], k = keys.indexOf(d), prev = k > 0 ? hlc(per[s].get(keys[k - 1]), barMin) : null;
      out.sym[s] = { bars, ind: indicators(bars), ctx: { closeMin, prev, er, open: bars[0].o } };
      rows.push({ sym: s, o: bars[0].o, prev, v5: bars.slice(0, n5).reduce((a, b) => a + b.v, 0), hist: keys.slice(Math.max(0, k - 5), k).map((x) => per[s].get(x).slice(0, n5).reduce((a, b) => a + b.v, 0)) });
    }
    out.scan = scanInPlay(rows, scanTop); out.inPlay = new Set(out.scan.map((r) => r.sym));
    return out;
  });
}

// ---------- run a config over every day: per-bot daily returns + all trades ----------
const cache = new Map();
const merge = (a, b) => ({ ...a, ...b, fund: { ...a.fund, ...(b.fund || {}) } });
export function runCfg(cfg, D, tag) {
  const key = tag + JSON.stringify({ ...cfg, fund: undefined });
  if (cache.has(key)) return cache.get(key);
  const bots = botsFor(cfg), R = Object.fromEntries(bots.map((b) => [b.id, []])), O = Object.fromEntries(bots.map((b) => [b.id, []])), trades = [];
  D.forEach((day, di) => {
    for (const b of bots) {
      const e = day.sym[b.sym];
      if (!e || (cfg.scan && !day.inPlay.has(b.sym))) { R[b.id].push(e ? null : 0); O[b.id].push(e ? null : 0); continue; }
      const ctx = cfg.scan ? { ...e.ctx, inPlay: day.inPlay } : e.ctx;
      const bs = newBotDay(day.d); stepBars(bs, b, e.bars, e.ind, ctx, cfg); flatten(bs, cfg, null, ctx);
      R[b.id].push(bs.sv - 1); O[b.id].push(bs.ov - 1);
      for (const t of bs.trades) trades.push({ di, strat: b.strat, sym: b.sym, r: t.pct / 100, o: t.opt / 100 });
    }
  });
  const res = { bots, R, O, trades, cfg }; cache.set(key, res); return res;
}
// daily portfolio returns: each morning fund bots using only the days before. which = 'R' (real) or 'O' (options estimate)
export function portfolio(run, f, from, to, D, which = 'R') {
  const out = [], cfg = run.cfg;
  for (let di = from; di < to; di++) {
    const elig = cfg.scan ? run.bots.filter((b) => D[di].inPlay.has(b.sym)) : run.bots;
    const volOf = (b) => D[di].sym[b.sym]?.ctx.prev?.barRange;
    const w = pickFunded(elig, (b) => run.R[b.id].slice(0, di), f, volOf);
    let r = 0; for (const [id, x] of w) r += x * (run[which][id][di] ?? 0);
    out.push(r);
  }
  return out;
}
export const evenSplit = (run, from, to, filter = () => true) => { const bs = run.bots.filter(filter), out = []; for (let di = from; di < to; di++) { const v = bs.map((b) => run.R[b.id][di]).filter((x) => x != null); out.push(v.length ? v.reduce((a, x) => a + x, 0) / v.length : 0); } return out; };
export const growth = (rs) => rs.reduce((a, r) => a * (1 + r), 1) - 1;
const logSum = (rs) => rs.reduce((a, r) => a + Math.log(1 + r), 0);
export function maxDD(rs) { let eq = 1, pk = 1, dd = 0; for (const r of rs) { eq *= 1 + r; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return dd; }
export const spyHold = (D, from, to) => D[to - 1].spyClose / D[from].spyOpen - 1;
const dayType = (r) => (r > 0.003 ? 'up' : r < -0.003 ? 'down' : 'flat');

// ---------- the ideas being tested ----------
export const TOGGLES = {
  mood15: { g: 'mood', c: { mood: true, moodTh: 0.15 } }, mood25: { g: 'mood', c: { mood: true, moodTh: 0.25 } },
  atr: { g: 'stops', c: { stops: 'atr', atrStop: 1.5, atrTarget: 3 } }, atrWide: { g: 'stops', c: { stops: 'atr', atrStop: 3, atrTarget: 6 } },
  trail: { g: 'trail', c: { trail: 1.5 } },
  am: { g: 'win', c: { window: 'am' } }, ampm: { g: 'win', c: { window: 'ampm' } },
  confirm: { g: 'confirm', c: { confirm: true } },
  cap3: { g: 'cap', c: { maxTrades: 3 } }, cool30: { g: 'cool', c: { lossCool: 30 } },
  vwapb: { g: '+vwapb', add: 'vwapb' }, pdhl: { g: '+pdhl', add: 'pdhl' }, gap: { g: '+gap', add: 'gap' }, pullback: { g: '+pullback', add: 'pullback' },
  noTrend: { g: '-trend', drop: 'trend' }, noFade: { g: '-fade', drop: 'fade' },
  sharpe: { g: 'score', c: { fund: { score: 'sharpe' } } }, caps: { g: 'caps', c: { fund: { capTicker: 2, capCluster: 3 } } },
  bench: { g: 'bench', c: { fund: { bench: 3 } } }, posOnly: { g: 'pos', c: { fund: { minScore: 0 } } }, eqW: { g: 'weights', c: { fund: { weights: 'equal' } } },
};
function apply(cfg, name) {
  const t = TOGGLES[name];
  if (t.add) return { ...cfg, strats: [...cfg.strats, t.add] };
  if (t.drop) return { ...cfg, strats: cfg.strats.filter((s) => s !== t.drop) };
  return merge(cfg, t.c);
}
export const build = (names) => names.reduce(apply, BASE_CFG);
export const portOf = (names, D, tag, from, to) => { const cfg = build(names); return cfg.strats.length ? portfolio(runCfg(cfg, D, tag), cfg.fund, from, to, D) : Array(to - from).fill(0); };

// greedy: starting from the baseline, keep adding whichever idea helps most on the TRAIN days, until nothing helps
function greedy(D, tag, from, to, log) {
  let cur = [], best = logSum(portOf(cur, D, tag, from, to));
  for (let step = 0; step < 8; step++) {
    let pick = null, pv = best;
    for (const n of Object.keys(TOGGLES)) {
      if (cur.some((c) => TOGGLES[c].g === TOGGLES[n].g)) continue;
      const v = logSum(portOf([...cur, n], D, tag, from, to));
      if (v > pv + 0.0005) { pv = v; pick = n; }
    }
    if (!pick) break;
    cur.push(pick); best = pv; log?.(`    + ${pick} -> train ${(Math.expm1(pv) * 100).toFixed(2)}%`);
  }
  return cur;
}

function walkForward(D, tag, log) {
  const folds = [], sel = [], base = [], ev = [], evSel = [];
  for (let t = WARM + BLOCK; t < D.length; t += BLOCK) {
    const end = Math.min(t + BLOCK, D.length);
    log?.(`  fold: train ${D[WARM].d}..${D[t - 1].d}, test ${D[t].d}..${D[end - 1].d}`);
    const names = greedy(D, tag, WARM, t, log);
    const s = portOf(names, D, tag, t, end), b = portOf([], D, tag, t, end);
    folds.push({ train: [D[WARM].d, D[t - 1].d], test: [D[t].d, D[end - 1].d], picked: names, sel: growth(s), base: growth(b) });
    sel.push(...s); base.push(...b);
    ev.push(...evenSplit(runCfg(BASE_CFG, D, tag), t, end)); const sc = build(names); evSel.push(...(sc.strats.length ? evenSplit(runCfg(sc, D, tag), t, end) : Array(end - t).fill(0)));
  }
  const from = WARM + BLOCK;
  return { folds, testDays: [D[from].d, D.at(-1).d, D.length - from], selected: sel, baseline: base, evenBase: ev, evenSelected: evSel, spy: spyHold(D, from, D.length), spyDaily: D.slice(from).map((x) => x.spyRet) };
}

// per-strategy report card (even weight across that strategy's 17 bots), on the given days
export function stratCard(D, tag, cfg, from, to) {
  const run = runCfg(cfg, D, tag), out = {};
  for (const st of cfg.strats) {
    const daily = evenSplit(run, from, to, (b) => b.strat === st), tr = run.trades.filter((t) => t.strat === st && t.di >= from && t.di < to);
    const wins = tr.filter((t) => t.r > 0), losses = tr.filter((t) => t.r <= 0), gw = wins.reduce((a, t) => a + t.r, 0), gl = -losses.reduce((a, t) => a + t.r, 0);
    const by = { up: [], down: [], flat: [] }; daily.forEach((r, k) => by[dayType(D[from + k].spyRet)].push(r));
    out[st] = { total: growth(daily), maxDD: maxDD(daily), trades: tr.length, perDay: tr.length / (to - from), winRate: tr.length ? wins.length / tr.length : 0,
      pf: gl ? gw / gl : gw ? Infinity : 0, avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0,
      byDay: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.length, avg: v.length ? v.reduce((a, x) => a + x, 0) / v.length : null }])) };
  }
  return out;
}
// each idea alone vs the baseline, on the given days (diagnostic)
function ideaDeltas(D, tag, from, to) {
  const b = portOf([], D, tag, from, to), be = evenSplit(runCfg(BASE_CFG, D, tag), from, to), out = {};
  for (const n of Object.keys(TOGGLES)) {
    const cfg = build([n]); if (!cfg.strats.length) continue;
    const p = portOf([n], D, tag, from, to), e = evenSplit(runCfg(cfg, D, tag), from, to);
    out[n] = { port: growth(p) - growth(b), even: growth(e) - growth(be) };
  }
  return out;
}

// ---------- main ----------
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const t0 = Date.now(), log = (...a) => console.log(...a);
  const D1 = buildDays(load('1m'), 1, 300), D5all = buildDays(load('5m'), 5, 60);
  const first1 = D1[0].d, D5hold = D5all.filter((x) => x.d < first1); // 5-min days older than anything in the 1-min set: never used for tuning
  log(`1m: ${D1.length} days ${D1[0].d}..${D1.at(-1).d} | 5m holdout: ${D5hold.length} days ${D5hold[0]?.d}..${D5hold.at(-1)?.d}`);

  // mood calibration (what values the efficiency ratio takes)
  const ers = D1.flatMap((x) => [...moodSeries(x.sym.SPY.bars, 1).values()].filter((v) => v != null)).sort((a, b) => a - b);
  log('SPY mood (efficiency) percentiles 25/50/75:', [0.25, 0.5, 0.75].map((p) => ers[Math.floor(p * ers.length)].toFixed(3)).join(' / '));

  log('\nWALK-FORWARD on 1-minute data (the live timeframe):');
  const wf = walkForward(D1, '1m', log);
  log('\nFINAL PICK: greedy on every 1-minute day (what would ship):');
  const final = greedy(D1, '1m', WARM, D1.length, log);
  const finalCfg = build(final);

  const H = D5hold, hw = Math.min(WARM, H.length - 1);
  const hold = { days: [H[hw].d, H.at(-1).d, H.length - hw],
    base: growth(portOf([], H, '5m', hw, H.length)), final: growth(portOf(final, H, '5m', hw, H.length)),
    evenBase: growth(evenSplit(runCfg(BASE_CFG, H, '5m'), hw, H.length)), evenFinal: finalCfg.strats.length ? growth(evenSplit(runCfg(finalCfg, H, '5m'), hw, H.length)) : 0,
    spy: spyHold(H, hw, H.length), ddBase: maxDD(portOf([], H, '5m', hw, H.length)), ddFinal: maxDD(portOf(final, H, '5m', hw, H.length)) };

  const from = WARM + BLOCK;
  const cards = { base1m: stratCard(D1, '1m', BASE_CFG, from, D1.length), all7_1m: stratCard(D1, '1m', { ...BASE_CFG, strats: ALL7 }, from, D1.length),
    all7_hold: stratCard(H, '5m', { ...BASE_CFG, strats: ALL7 }, hw, H.length), final1m: finalCfg.strats.length ? stratCard(D1, '1m', finalCfg, from, D1.length) : {} };
  const ideas = { test1m: ideaDeltas(D1, '1m', from, D1.length), hold5m: ideaDeltas(H, '5m', hw, H.length) };

  const res = { generated: new Date().toISOString(), costs: BASE_CFG.cost, wf: { ...wf, selectedTotal: growth(wf.selected), baselineTotal: growth(wf.baseline), evenBaseTotal: growth(wf.evenBase), evenSelectedTotal: growth(wf.evenSelected), ddSel: maxDD(wf.selected), ddBase: maxDD(wf.baseline) },
    final, finalCfg, hold, cards, ideas, secs: (Date.now() - t0) / 1000 };
  fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify(res, null, 1));
  const P = (x) => (x == null ? '–' : (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%');
  log('\n=== WALK-FORWARD (unseen days only) ===', wf.testDays.join(' .. '));
  log('selected-process', P(res.wf.selectedTotal), 'dd', P(res.wf.ddSel), '| baseline (current bots + costs)', P(res.wf.baselineTotal), 'dd', P(res.wf.ddBase), '| even split base', P(res.wf.evenBaseTotal), '| SPY hold', P(wf.spy));
  for (const f of wf.folds) log(' ', f.test.join('..'), 'picked [' + f.picked.join(', ') + ']', 'sel', P(f.sel), 'base', P(f.base));
  log('\n=== 5-MIN HOLDOUT (older days, never tuned on) ===', hold.days.join(' .. '));
  log('final', P(hold.final), 'dd', P(hold.ddFinal), '| base', P(hold.base), 'dd', P(hold.ddBase), '| even base', P(hold.evenBase), '| even final', P(hold.evenFinal), '| SPY', P(hold.spy));
  log('\n=== IDEAS ALONE vs baseline (portfolio / even-split deltas) ===');
  for (const n of Object.keys(ideas.test1m)) log(' ', n.padEnd(9), '1m-test', P(ideas.test1m[n].port).padStart(8), P(ideas.test1m[n].even).padStart(8), ' | 5m-hold', P(ideas.hold5m[n]?.port).padStart(8), P(ideas.hold5m[n]?.even).padStart(8));
  log('\n=== STRATEGY CARDS (1m test days, base settings) ===');
  for (const [k, v] of Object.entries(cards.all7_1m)) log(' ', k.padEnd(9), 'tot', P(v.total).padStart(8), 'dd', P(v.maxDD).padStart(8), 'trades/day', v.perDay.toFixed(1).padStart(5), 'win', (v.winRate * 100).toFixed(0) + '%', 'PF', v.pf.toFixed(2), 'avgW', P(v.avgWin), 'avgL', P(v.avgLoss), 'up', P(v.byDay.up.avg), 'down', P(v.byDay.down.avg), 'flat', P(v.byDay.flat.avg));
  log('\n=== STRATEGY CARDS (5m holdout) ===');
  for (const [k, v] of Object.entries(cards.all7_hold)) log(' ', k.padEnd(9), 'tot', P(v.total).padStart(8), 'dd', P(v.maxDD).padStart(8), 'win', (v.winRate * 100).toFixed(0) + '%', 'PF', v.pf.toFixed(2));
  log('\nsecs', res.secs);
}
