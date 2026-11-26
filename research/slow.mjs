// Slow lane research: daily strategies tested walk-forward over 20+ years of real daily bars.
// Every trade pays 0.02% slippage + 0.01% fees per side. Trades fill at the next day's open (overnight bot: buys
// at the close, sells at the next open). Parameters are tuned only on years BEFORE each test year.
//   node research/slow.mjs [--refresh]   -> research/SLOW.md + research/slow.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), DIR = path.join(HERE, 'cache');
export const DAILY = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB', 'SMH', 'TLT', 'IEF', 'GLD', 'ARKK', 'NVDA', 'TSLA', 'AAPL', 'AMD', 'META', 'AMZN', 'MSFT'];
export const ROTATE = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB', 'TLT', 'GLD']; // momentum universe (ETFs only)
const SLIP = 0.0002, FEE = 0.0001, COST = SLIP + FEE;

// ---------- data (dividend-adjusted, so buy-and-hold includes dividends) ----------
async function fetchDaily(sym) {
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=0&period2=${Math.floor(Date.now() / 1000)}&events=div%2Csplit`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(r.status);
      const j = (await r.json()).chart.result[0], q = j.indicators.quote[0], adj = j.indicators.adjclose?.[0]?.adjclose || q.close, out = [];
      j.timestamp.forEach((t, i) => { if (q.close[i] && q.open[i] && adj[i]) { const f = adj[i] / q.close[i]; out.push({ d: new Date((t + 4 * 3600) * 1000).toISOString().slice(0, 10), o: q.open[i] * f, c: adj[i] }); } });
      return out;
    } catch (e) { if (k === 3) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
}
export async function loadDaily(refresh) {
  fs.mkdirSync(DIR, { recursive: true });
  const raw = {};
  for (const s of DAILY) {
    const f = path.join(DIR, `${s}_1d.json`);
    if (refresh || !fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(await fetchDaily(s)));
    raw[s] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const dates = raw.SPY.map((x) => x.d), at = Object.fromEntries(dates.map((d, i) => [d, i]));
  const O = {}, C = {};
  for (const s of DAILY) { O[s] = Array(dates.length).fill(null); C[s] = Array(dates.length).fill(null); for (const x of raw[s]) if (at[x.d] != null) { O[s][at[x.d]] = x.o; C[s][at[x.d]] = x.c; } }
  return { dates, O, C };
}

// ---------- indicators ----------
const smaCache = new Map(), rsiCache = new Map();
function sma(M, s, n) { const k = s + n; if (smaCache.has(k)) return smaCache.get(k); const c = M.C[s], out = Array(c.length).fill(null); let sum = 0, cnt = 0;
  for (let i = 0; i < c.length; i++) { if (c[i] == null) { sum = 0; cnt = 0; continue; } sum += c[i]; cnt++; if (cnt > n) { sum -= c[i - n]; cnt = n; } if (cnt === n) out[i] = sum / n; } smaCache.set(k, out); return out; }
function rsi2(M, s) { if (rsiCache.has(s)) return rsiCache.get(s); const c = M.C[s], out = Array(c.length).fill(null); let ag = 0, al = 0, n = 0;
  for (let i = 1; i < c.length; i++) { if (c[i] == null || c[i - 1] == null) { n = 0; ag = al = 0; continue; } const d = c[i] - c[i - 1]; n++;
    if (n <= 2) { ag += Math.max(d, 0) / 2; al += Math.max(-d, 0) / 2; } else { ag = (ag + Math.max(d, 0)) / 2; al = (al + Math.max(-d, 0)) / 2; }
    if (n >= 2) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } rsiCache.set(s, out); return out; }

// ---------- strategies: at each close i return target weights for the NEXT open (null = keep), or {close: w} for now ----------
export const FAMILIES = {
  trendSPY: { grid: [{ n: 150 }, { n: 200 }, { n: 250 }], make: (p) => trendBot('SPY', p.n) },
  trendQQQ: { grid: [{ n: 150 }, { n: 200 }, { n: 250 }], make: (p) => trendBot('QQQ', p.n) },
  momentum: { grid: [126, 189, 252].flatMap((lb) => [true, false].map((abs) => ({ lb, abs }))), make: (p) => momBot(p.lb, p.abs) },
  dipSPY: { grid: [5, 10, 15].flatMap((th) => [true, false].map((tf) => ({ th, tf }))), make: (p) => dipBot('SPY', p.th, p.tf) },
  dipQQQ: { grid: [5, 10, 15].flatMap((th) => [true, false].map((tf) => ({ th, tf }))), make: (p) => dipBot('QQQ', p.th, p.tf) },
  overnight: { grid: [{}], make: () => overnightBot('SPY') },
  holdSPY: { grid: [{}], make: () => holdBot('SPY') },
};
export const NAMES = { trendSPY: 'SPY trend (above its average)', trendQQQ: 'QQQ trend (above its average)', momentum: 'Momentum rotation (top 3 ETFs)', dipSPY: 'SPY dip buying', dipQQQ: 'QQQ dip buying', overnight: 'Overnight (buy close, sell open)', holdSPY: 'Hold SPY' };
function trendBot(s, n) { return (M, i) => { const a = sma(M, s, n)[i]; return a == null ? {} : M.C[s][i] > a ? { [s]: 1 } : {}; }; }
function holdBot(s) { return (M, i) => ({ [s]: 1 }); }
function momBot(lb, abs) {
  return (M, i, st) => {
    const nm = M.dates[i + 1]; if (st.done && (!nm || nm.slice(5, 7) === M.dates[i].slice(5, 7))) return null; // rebalance on the last close of each month
    st.done = true;
    const r = ROTATE.filter((s) => M.C[s][i] != null && M.C[s][i - lb] != null).map((s) => ({ s, r: M.C[s][i] / M.C[s][i - lb] - 1 })).sort((a, b) => b.r - a.r).slice(0, 3).filter((x) => !abs || x.r > 0);
    return Object.fromEntries(r.map((x) => [x.s, 1 / 3]));
  };
}
function dipBot(s, th, tf) {
  return (M, i, st) => {
    const c = M.C[s], r = rsi2(M, s)[i], a = sma(M, s, 200)[i];
    if (c[i] == null || r == null) return {};
    if (st.inPos) { if (c[i] > c[i - 1]) { st.inPos = false; return {}; } return null; }
    if (r < th && (!tf || (a != null && c[i] > a))) { st.inPos = true; return { [s]: 1 }; }
    return null;
  };
}
function overnightBot(s) { return (M, i) => (M.C[s][i] == null ? null : { close: { [s]: 1 } }); }

// ---------- engine ----------
export function simulate(M, strat, from, to) {
  let cash = 1, sh = {}, pending = null, flatAtOpen = false;
  const val = (P, i) => cash + Object.entries(sh).reduce((a, [s, n]) => a + n * (P[s][i] ?? 0), 0);
  const lots = {}, trades = [], rets = [], days = [], expo = [];
  function rebalance(w, P, i) {
    const V = val(P, i), want = Object.fromEntries(Object.entries(w).filter(([s]) => P[s][i] != null));
    let traded = 0; const syms = new Set([...Object.keys(sh), ...Object.keys(want)]);
    for (const s of syms) traded += Math.abs((want[s] || 0) * V - (sh[s] || 0) * (P[s][i] ?? 0));
    const V2 = V - traded * COST; cash = V2; const nsh = {};
    for (const [s, x] of Object.entries(want)) if (x > 0) { nsh[s] = (x * V2) / P[s][i]; cash -= x * V2; }
    for (const s of syms) { const was = (sh[s] || 0) > 0, now = (nsh[s] || 0) > 0;
      if (!was && now) lots[s] = P[s][i] * (1 + SLIP);
      if (was && !now && lots[s]) { trades.push({ d: M.dates[i], s, r: (P[s][i] * (1 - SLIP)) / lots[s] - 1 - 2 * FEE }); delete lots[s]; } }
    sh = nsh;
  }
  const st = {};
  let prev = 1;
  for (let i = from; i < to; i++) {
    if (i > from) {
      if (flatAtOpen) { rebalance({}, M.O, i); flatAtOpen = false; }
      if (pending) { rebalance(pending, M.O, i); pending = null; }
    }
    const t = strat(M, i, st);
    if (t && t.close) { rebalance(t.close, M.C, i); flatAtOpen = true; } else if (t) pending = t;
    const V = val(M.C, i);
    if (i > from) { rets.push(V / prev - 1); days.push(M.dates[i]); expo.push(Object.keys(sh).length ? 1 : 0); }
    prev = V;
  }
  return { rets, days, trades, expo };
}

// ---------- metrics ----------
const growth = (r) => r.reduce((a, x) => a * (1 + x), 1);
export const cagr = (r) => (r.length ? growth(r) ** (252 / r.length) - 1 : 0);
export function maxDD(r) { let e = 1, pk = 1, dd = 0; for (const x of r) { e *= 1 + x; pk = Math.max(pk, e); dd = Math.min(dd, e / pk - 1); } return dd; }
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
export const sharpe = (r) => (sd(r) ? (mean(r) / sd(r)) * Math.sqrt(252) : 0);
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// block bootstrap (20-day blocks keep streaks intact): chance the total log-return of `a` beats `b` (or zero)
export function luck(a, b = null, n = 5000, block = 20) {
  const R = rng(11), L = a.length, nb = Math.ceil(L / block); let win = 0;
  for (let k = 0; k < n; k++) { let g = 0; for (let j = 0; j < nb; j++) { const st = Math.floor(R() * (L - block)); for (let i = st; i < st + block; i++) g += Math.log(1 + a[i]) - (b ? Math.log(1 + b[i]) : 0); } if (g > 0) win++; }
  return win / n;
}
const yearRet = (rets, days, y) => { const r = rets.filter((_, i) => days[i].startsWith(String(y))); return r.length ? growth(r) - 1 : null; };

// ---------- walk-forward ----------
export function walkForward(M, fam, firstTest = 2005) {
  const F = FAMILIES[fam], years = [...new Set(M.dates.map((d) => +d.slice(0, 4)))].filter((y) => y >= firstTest);
  const start = M.dates.findIndex((d) => d >= '1999-03-10'); // QQQ inception: common start for training
  const rets = [], days = [], trades = [], picks = [];
  for (const y of years) {
    const ys = M.dates.findIndex((d) => d >= `${y}-01-01`), ye = M.dates.findIndex((d) => d >= `${y + 1}-01-01`), end = ye < 0 ? M.dates.length : ye;
    let best = F.grid[0], bs = -Infinity;
    if (F.grid.length > 1) for (const p of F.grid) { const s = sharpe(simulate(M, F.make(p), start, ys).rets); if (s > bs) { bs = s; best = p; } }
    const sim = simulate(M, F.make(best), start, end), k0 = sim.days.findIndex((d) => d >= `${y}-01-01`);
    rets.push(...sim.rets.slice(k0)); days.push(...sim.days.slice(k0)); trades.push(...sim.trades.filter((t) => t.d.startsWith(String(y)))); picks.push({ y, p: best });
  }
  return { rets, days, trades, picks };
}

// even mix (daily rebalanced) + optional volatility targeting (10% a year, from the last 20 days, no leverage)
export function mix(series, target = 0) {
  const L = series[0].length, raw = Array.from({ length: L }, (_, i) => mean(series.map((s) => s[i])));
  if (!target) return raw;
  const out = []; let prevS = 1;
  for (let i = 0; i < L; i++) {
    const w = raw.slice(Math.max(0, i - 20), i), v = w.length >= 10 ? sd(w) * Math.sqrt(252) : target;
    const s = Math.min(1, target / Math.max(v, 1e-6));
    out.push(s * raw[i] - Math.abs(s - prevS) * COST); prevS = s;
  }
  return out;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const t0 = Date.now(), M = await loadDaily(process.argv.includes('--refresh'));
  console.log('daily bars', M.dates[0], '..', M.dates.at(-1), M.dates.length, 'days');
  const R = {};
  for (const f of Object.keys(FAMILIES)) R[f] = walkForward(M, f);
  const days = R.holdSPY.days, spy = R.holdSPY.rets;
  for (const f in R) if (R[f].days.length !== days.length) throw new Error('misaligned ' + f);
  // combo: each test year, from the bots (not hold/overnight) pick those with a good TRAINING Sharpe and low overlap
  const cand = ['trendSPY', 'trendQQQ', 'momentum', 'dipSPY', 'dipQQQ'], years = [...new Set(days.map((d) => +d.slice(0, 4)))];
  const combo = [], comboVT = [], comboPicks = [];
  const full = Object.fromEntries(cand.map((f) => [f, simulate(M, FAMILIES[f].make(FAMILIES[f].grid[0]), 0, M.dates.length)])); // train-side estimates (default params)
  for (const y of years) {
    const tr = (f) => full[f].rets.filter((_, i) => full[f].days[i] < `${y}-01-01` && full[f].days[i] >= '2000-01-01');
    const ranked = cand.map((f) => ({ f, s: sharpe(tr(f)) })).filter((x) => x.s > 0.3).sort((a, b) => b.s - a.s), pick = [];
    for (const x of ranked) { const corrOk = pick.every((p) => { const a = tr(x.f), b = tr(p); const ma = mean(a), mb = mean(b); const c = mean(a.map((v, i) => (v - ma) * (b[i] - mb))) / (sd(a) * sd(b) || 1); return c < 0.7; }); if (corrOk) pick.push(x.f); }
    const idx = days.map((d, i) => (d.startsWith(String(y)) ? i : -1)).filter((i) => i >= 0);
    const ser = (pick.length ? pick : ['holdSPY']).map((f) => idx.map((i) => R[f].rets[i]));
    combo.push(...mix(ser)); comboPicks.push({ y, pick });
  }
  comboVT.push(...mix([combo], 0.10));
  const evenAll = mix(Object.keys(FAMILIES).map((f) => R[f].rets));
  const rows = { ...Object.fromEntries(Object.keys(FAMILIES).map((f) => [f, { name: NAMES[f], rets: R[f].rets, trades: R[f].trades, picks: R[f].picks }])),
    combo: { name: 'Mix of best low-overlap bots', rets: combo, trades: [] }, comboVT: { name: 'Same mix + volatility targeting', rets: comboVT, trades: [] }, evenAll: { name: 'Even split of all slow bots', rets: evenAll, trades: [] } };
  const yrs = years.length, out = {};
  const P = (x) => (x == null ? '   –  ' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
  console.log(`\nunseen test years ${years[0]}-${years.at(-1)} (${days.length} days). Costs included.\n`);
  for (const [k, v] of Object.entries(rows)) {
    const tw = v.trades.filter((t) => t.r > 0), gw = tw.reduce((a, t) => a + t.r, 0), gl = -v.trades.filter((t) => t.r <= 0).reduce((a, t) => a + t.r, 0);
    out[k] = { name: v.name, cagr: cagr(v.rets), maxDD: maxDD(v.rets), sharpe: sharpe(v.rets), total: growth(v.rets) - 1, trades: v.trades.length, perYear: v.trades.length / yrs, winRate: v.trades.length ? tw.length / v.trades.length : null, pf: gl ? gw / gl : null,
      luckUp: luck(v.rets), luckVsSpy: k === 'holdSPY' ? null : luck(v.rets, spy), y2008: yearRet(v.rets, days, 2008), y2020: yearRet(v.rets, days, 2020), y2022: yearRet(v.rets, days, 2022), picks: v.picks };
    const o = out[k];
    console.log(`${v.name.padEnd(34)} ${P(o.cagr).padStart(7)}/yr  worst ${P(o.maxDD).padStart(7)}  sharpe ${o.sharpe.toFixed(2)}  trades/yr ${o.perYear.toFixed(0).padStart(3)}  win ${o.winRate == null ? ' – ' : (o.winRate * 100).toFixed(0) + '%'}  PF ${o.pf == null ? '–' : o.pf.toFixed(2)}  luck>0 ${(o.luckUp * 100).toFixed(0)}%  luck>SPY ${o.luckVsSpy == null ? '–' : (o.luckVsSpy * 100).toFixed(0) + '%'}  | 2008 ${P(o.y2008)} 2020 ${P(o.y2020)} 2022 ${P(o.y2022)}`);
  }
  // ship rule: beats SPY, the even split and the current day-trading bots (~+2.6%/yr annualized on unseen days, luck 61%) on unseen years, with luck vs SPY >= 80%
  const DAYBOTS = 0.026;
  const pass = Object.entries(out).filter(([k, o]) => k !== 'holdSPY' && k !== 'evenAll' && o.cagr > out.holdSPY.cagr && o.cagr > out.evenAll.cagr && o.cagr > DAYBOTS && o.luckVsSpy >= 0.8).map(([k]) => k);
  console.log('\nship check (beat SPY + even split + day bots on unseen years, luck vs SPY >= 80%):', pass.length ? pass.join(', ') : 'NOTHING PASSES');
  const riskBetter = Object.entries(out).filter(([k, o]) => !['holdSPY', 'evenAll'].includes(k) && o.sharpe > out.holdSPY.sharpe && o.maxDD > out.holdSPY.maxDD).map(([k]) => k);
  console.log('smoother than SPY (higher sharpe AND smaller worst drop):', riskBetter.join(', ') || 'none');
  console.log('combo picks:', comboPicks.map((x) => `${x.y}:${x.pick.join('+') || 'SPY'}`).join(' '));
  fs.writeFileSync(path.join(HERE, 'slow.json'), JSON.stringify({ range: [days[0], days.at(-1)], out, pass, riskBetter, comboPicks }, null, 1));
  console.log('secs', (Date.now() - t0) / 1000);
}
