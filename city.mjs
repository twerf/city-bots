// City v3: paper-trading bots on REAL market prices (Yahoo 1-minute bars), fake money only.
// Every ticker x every strategy = one bot. All bots trade every day in practice mode so each one keeps a track
// record. Each morning the money goes to the top-ranked bots. Every trade pays slippage + fees.
// The live runner (run.mjs) and the research lab (research/lab.mjs) share stepBars(), so what was tested is
// what runs. No broker, no keys, no real orders.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = 3;
const START_CASH = 20;
export const SYMS = ['SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'XLK', 'XLF', 'XLE', 'ARKK', 'TLT', 'NVDA', 'TSLA', 'AAPL', 'AMD', 'META', 'AMZN', 'MSFT'];
export const SYM_INFO = {
  SPY: 'S&P 500, the 500 biggest US companies', QQQ: 'Nasdaq 100, mostly big tech', IWM: 'Russell 2000, small companies', DIA: 'Dow Jones, 30 old-school giants',
  SMH: 'chip makers', XLK: 'tech sector', XLF: 'banks and finance', XLE: 'oil and energy', ARKK: 'risky "future tech" fund', TLT: 'long-term US government bonds',
  NVDA: 'Nvidia', TSLA: 'Tesla', AAPL: 'Apple', AMD: 'AMD', META: 'Meta', AMZN: 'Amazon', MSFT: 'Microsoft',
};
// tickers that move together; funding caps how many bots one group can hold
export const CLUSTER = { NVDA: 'chips', SMH: 'chips', AMD: 'chips', XLK: 'bigtech', QQQ: 'bigtech', MSFT: 'bigtech', AAPL: 'bigtech', META: 'bigtech', AMZN: 'bigtech',
  SPY: 'index', DIA: 'index', IWM: 'small', ARKK: 'small', XLF: 'fin', XLE: 'energy', TLT: 'bonds', TSLA: 'tsla' };
export const STRATS = {
  trend: 'Rides a move. The fast average (9 min) crosses the slow one (21 min) on the same side of VWAP (the day\'s volume-weighted average price).',
  og: 'Opening range breakout. Marks the high and low of 9:30-9:45 and bets on the break with above-average volume. Stop at the middle of the range.',
  fade: 'Bets against stretched moves. RSI (0-100 overbought/oversold gauge) under 25 and well below VWAP = up bet, over 75 and well above = down bet. Out when price gets back to VWAP.',
  vwapb: 'VWAP bounce. In an uptrend, waits for a dip to VWAP that bounces and bets up (mirror in downtrends).',
  pdhl: 'Yesterday\'s high/low breakout. Up bet when price breaks above yesterday\'s high, down bet below yesterday\'s low.',
  gap: 'Gap fill. If the day opens well above or below yesterday\'s close, bets it drifts back toward that close (first 30 minutes only).',
  pullback: 'First pullback. After a strong first 15 minutes, waits for the first dip to the 21-min average and bets the move continues.',
};
export const SNAME = { trend: 'Trend', og: 'OG', fade: 'Fade', vwapb: 'VWAP', pdhl: 'PDH/L', gap: 'Gap', pullback: 'Pullback' };
const TRENDY = new Set(['trend', 'og', 'vwapb', 'pdhl', 'pullback']);

// v2 behaviour (+ costs) = the baseline every change is measured against
export const BASE_CFG = {
  strats: ['trend', 'og', 'fade'],
  cost: { slip: 0.0002, fee: 0.0001 },        // per side: 0.02% slippage, 0.01% fees
  stops: 'pct', atrStop: 1.5, atrTarget: 3,   // 'atr' = stops sized to each ticker's typical 1-min bar
  trail: 0,                                   // >0: trailing stop of N x ATR once a trade is 1 ATR in profit
  window: 'all',                              // 'all' | 'am' (9:45-11:15) | 'ampm' (+ 14:30 to 30 min before close)
  confirm: false,                             // trend-type entries need above-avg volume + the 5-min trend agreeing
  mood: false, moodTh: 0.2,                   // trend-type bots only when SPY is trending, fade/gap only when it's choppy
  maxTrades: 99, lossCool: 5,                 // max entries per bot per day, minutes to sit out after a loss
  amEnd: 675,                                 // end of the morning window (minutes after midnight ET, 675 = 11:15)
  gapMin: 0.003, rsiLo: 25,                   // gap-fill minimum gap; fade RSI trigger (rsiLo / 100-rsiLo)
  lock: { up: 0.02, down: -0.03 },
  fund: { top: 8, window: 10, shrink: 3, score: 'mean', capTicker: 99, capCluster: 99, bench: 0, minScore: -1, weights: 'rank' },
};
// what the live bots run. Ideas picked on the 1-minute month, then tested on 35 older 5-minute days they
// never saw (research/check.mjs). See research/REPORT.md for the numbers.
export const SHIPPED = {
  ...BASE_CFG,
  strats: ['og', 'fade', 'pdhl', 'gap', 'vwapb'], // trend bots dropped: ~87 trades/day, profit factor 0.6 after costs
  window: 'am',      // new entries only 9:45-11:15 (gap 9:35-10:00); open bets can still run until the exit
  confirm: true,     // breakout-type entries need above-average volume + the 5-min trend pointing the same way
  maxTrades: 3,      // per bot per day
  fund: { ...BASE_CFG.fund, score: 'sharpe', bench: 3 }, // rank on steadiness, bench any bot after 3 red days in a row
};

export const botsFor = (cfg) => SYMS.flatMap((sym) => cfg.strats.map((strat) => ({ id: `${sym.toLowerCase()}-${strat}`, name: `${sym} ${SNAME[strat]}`, sym, strat })));

// ---------- helpers ----------
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function et(tsSec) { const p = Object.fromEntries(ET.formatToParts(new Date(tsSec * 1000)).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; }
const r2 = (n) => Math.round(n * 100) / 100, r4 = (n) => Math.round(n * 1e4) / 1e4, r6 = (n) => Math.round(n * 1e6) / 1e6;

export async function yahoo(sym, range = '1d', interval = '1m') {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}&includePrePost=false`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`yahoo ${sym} ${r.status}`);
      const j = (await r.json()).chart.result[0];
      const q = j.indicators.quote[0], bars = [];
      (j.timestamp || []).forEach((t, k) => { if (q.close[k] != null && q.high[k] != null) bars.push({ t, o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k], v: q.volume[k] || 0 }); });
      return { bars, meta: j.meta };
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
}
export async function yahooAll(syms, range, interval) {
  const out = {}, q = [...syms];
  await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) { const s = q.shift(); try { out[s] = await yahoo(s, range, interval); } catch (e) { out[s] = { err: e.message }; } } }));
  return out;
}
export const splitDays = (bars) => { const m = new Map(); for (const b of bars) { const d = et(b.t).day; if (!m.has(d)) m.set(d, []); m.get(d).push(b); } return m; };

// ---------- indicators (per session) ----------
export function indicators(bars) {
  const n = bars.length, ema = (p) => { const k = 2 / (p + 1); let e = bars[0].c; return bars.map((b) => (e = b.c * k + e * (1 - k))); };
  const e9 = ema(9), e21 = ema(21), e45 = ema(45), e105 = ema(105), vw = [], rsi = [], atr = [], av = [], m = [];
  let pv = 0, vv = 0, ag = 0, al = 0, a = 0, vs = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i], tp = (b.h + b.l + b.c) / 3;
    m.push(et(b.t).min);
    pv += tp * (b.v || 1); vv += b.v || 1; vw.push(pv / vv);
    const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l;
    a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14; atr.push(Math.max(a, b.c * 3e-4));
    av.push(i ? vs / Math.min(i, 20) : 0); vs += b.v; if (i >= 20) vs -= bars[i - 20].v;
    if (i === 0) { rsi.push(50); continue; }
    const d = b.c - bars[i - 1].c, g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= 14) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; }
    rsi.push(i < 14 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return { e9, e21, e45, e105, vw, rsi, atr, av, m };
}
// market mood from SPY: efficiency ratio over the last hour (net move / total distance travelled). High = trending, low = choppy.
export function moodSeries(spy, barMin = 1) {
  const out = new Map(), L0 = Math.round(60 / barMin), Lmin = Math.max(3, Math.round(15 / barMin));
  for (let i = 0; i < spy.length; i++) {
    const L = Math.min(i, L0); if (L < Lmin) { out.set(spy[i].t, null); continue; }
    let s = 0; for (let j = i - L + 1; j <= i; j++) s += Math.abs(spy[j].c - spy[j - 1].c);
    out.set(spy[i].t, s ? Math.abs(spy[i].c - spy[i - L].c) / s : 0);
  }
  return out;
}

// ---------- the bot engine (shared by live + lab) ----------
export const newBotDay = (day = null) => ({ day, pos: null, lock: null, cool: 0, n: 0, sv: 1, lastT: 0, og: {}, done: {}, sig: { dir: null, charge: 0, why: '' }, trades: [] });
const tradeRet = (p, px, c) => p.side * (px * (1 - p.side * c.slip) / p.fill - 1) - 2 * c.fee;
export const markRet = (p, c) => (p ? tradeRet(p, p.last, c) : 0);

function signal(strat, i, x, ind, bs, ctx) {
  const px = x.c, e9 = ind.e9[i], e21 = ind.e21[i], vw = ind.vw[i], rsi = ind.rsi[i];
  if (strat === 'fade') return { dir: rsi < 50 ? 'up' : 'down', charge: Math.min(1, Math.max(0, (Math.abs(rsi - 50) - 10) / 15)), why: `RSI ${rsi.toFixed(0)}, ${((px - vw) / vw * 100).toFixed(2)}% from VWAP` };
  if (strat === 'og' || strat === 'pullback') {
    if (ind.m[i] < 585) return { dir: null, charge: 0, why: 'marking the opening range' };
    if (!bs.og.hi) return { dir: null, charge: 0, why: '' };
    const rg = bs.og.hi - bs.og.lo || px * 1e-3, up = (px - bs.og.lo) / rg;
    return { dir: up >= 0.5 ? 'up' : 'down', charge: Math.min(1, Math.abs(up - 0.5) * 2) ** 2, why: `opening range ${bs.og.lo.toFixed(2)}-${bs.og.hi.toFixed(2)}` };
  }
  if (strat === 'pdhl' && ctx.prev) { const up = px > (ctx.prev.h + ctx.prev.l) / 2, lvl = up ? ctx.prev.h : ctx.prev.l; return { dir: up ? 'up' : 'down', charge: Math.max(0, 1 - Math.abs(px - lvl) / lvl / 0.01), why: `yesterday ${ctx.prev.l.toFixed(2)}-${ctx.prev.h.toFixed(2)}` }; }
  if (strat === 'gap' && ctx.prev) { const g = (ctx.open - ctx.prev.c) / ctx.prev.c; return { dir: g > 0 ? 'down' : 'up', charge: Math.min(1, Math.abs(g) / 0.006), why: `gap ${(g * 100).toFixed(2)}%` }; }
  const gap = (e9 - e21) / px * 1e4;
  return { dir: gap > 0 ? 'up' : 'down', charge: Math.min(1, Math.abs(gap) / 6) * ((gap > 0) === (px > vw) ? 1 : 0.4), why: `9/21 gap ${gap.toFixed(1)} bp, price ${px > vw ? 'above' : 'below'} VWAP` };
}

function entry(strat, i, x, bars, ind, bs, ctx, cfg) {
  const px = x.c, e9 = ind.e9[i], e21 = ind.e21[i], vw = ind.vw[i], rsi = ind.rsi[i], atr = ind.atr[i];
  const pct = (side, s, t) => ({ stop: px * (1 - side * s), target: px * (1 + side * t) });
  const lv = (side, s, t) => (cfg.stops === 'atr' ? { stop: px - side * cfg.atrStop * atr, target: px + side * cfg.atrTarget * atr } : pct(side, s, t));
  if (strat === 'trend' && i > 3) {
    const was = Math.sign(ind.e9[i - 3] - ind.e21[i - 3]), now = Math.sign(e9 - e21), slope = e9 - ind.e9[i - 2], wide = Math.abs(e9 - e21) / px * 1e4 >= 1.5;
    if (wide && now !== was && now > 0 && px > vw && slope > 0) return { side: 1, why: '9 crossed above 21, over VWAP', ...lv(1, 0.0025, 0.0035) };
    if (wide && now !== was && now < 0 && px < vw && slope < 0) return { side: -1, why: '9 crossed below 21, under VWAP', ...lv(-1, 0.0025, 0.0035) };
  }
  if (strat === 'og' && bs.og.hi) {
    const rg = bs.og.hi - bs.og.lo, mid = (bs.og.hi + bs.og.lo) / 2;
    if (!bs.done.ogu && px > bs.og.hi && x.v >= ind.av[i]) return { side: 1, why: 'broke above the opening range', stop: mid, target: px + rg, mark: 'ogu' };
    if (!bs.done.ogd && px < bs.og.lo && x.v >= ind.av[i]) return { side: -1, why: 'broke below the opening range', stop: mid, target: px - rg, mark: 'ogd' };
  }
  if (strat === 'fade') {
    const dv = (px - vw) / vw;
    if (rsi < cfg.rsiLo && dv < -0.002) return { side: 1, why: `oversold (RSI ${rsi.toFixed(0)})`, ...lv(1, 0.0025, 0.003) };
    if (rsi > 100 - cfg.rsiLo && dv > 0.002) return { side: -1, why: `overbought (RSI ${rsi.toFixed(0)})`, ...lv(-1, 0.0025, 0.003) };
  }
  if (strat === 'vwapb' && i >= 30) {
    let above = 0; for (let j = i - 30; j < i; j++) if (bars[j].c > ind.vw[j]) above++;
    const p = bars[i - 1];
    if (e9 > e21 && e21 > ind.e21[i - 5] && above >= 20 && p.l <= ind.vw[i - 1] * 1.0005 && x.c > vw && x.c > x.o) return { side: 1, why: 'bounced off VWAP in an uptrend', ...lv(1, 0.0025, 0.004) };
    if (e9 < e21 && e21 < ind.e21[i - 5] && above <= 10 && p.h >= ind.vw[i - 1] * 0.9995 && x.c < vw && x.c < x.o) return { side: -1, why: 'rejected at VWAP in a downtrend', ...lv(-1, 0.0025, 0.004) };
  }
  if (strat === 'pdhl' && ctx.prev && i > 0) {
    const pc = bars[i - 1].c;
    if (!bs.done.pu && px > ctx.prev.h && pc <= ctx.prev.h && x.v >= ind.av[i]) return { side: 1, why: 'broke above yesterday\'s high', ...lv(1, 0.003, 0.006), mark: 'pu' };
    if (!bs.done.pd && px < ctx.prev.l && pc >= ctx.prev.l && x.v >= ind.av[i]) return { side: -1, why: 'broke below yesterday\'s low', ...lv(-1, 0.003, 0.006), mark: 'pd' };
  }
  if (strat === 'gap' && ctx.prev && !bs.done.gap) {
    const g = (ctx.open - ctx.prev.c) / ctx.prev.c, side = g > 0 ? -1 : 1;
    if (Math.abs(g) >= cfg.gapMin && Math.abs(g) <= 0.02 && side * (ctx.prev.c - px) > 0) return { side, why: `${g > 0 ? 'gapped up' : 'gapped down'} ${(Math.abs(g) * 100).toFixed(1)}%, betting it fills`, stop: px - side * Math.abs(g) * ctx.prev.c * 0.5, target: ctx.prev.c, mark: 'gap' };
  }
  if (strat === 'pullback' && bs.og.hi && !bs.done.pb && i > 0) {
    const upMove = (bs.og.hi - ctx.open) / ctx.open, dnMove = (ctx.open - bs.og.lo) / ctx.open;
    if (upMove >= 0.004 && upMove > dnMove && x.l <= e21 && x.c > e9 && x.c > x.o) { const stop = Math.min(x.l, bars[i - 1].l) - atr * 0.25; return { side: 1, why: 'first dip after a strong open', stop, target: px + 2 * (px - stop), mark: 'pb' }; }
    if (dnMove >= 0.004 && dnMove > upMove && x.h >= e21 && x.c < e9 && x.c < x.o) { const stop = Math.max(x.h, bars[i - 1].h) + atr * 0.25; return { side: -1, why: 'first bounce after a weak open', stop, target: px - 2 * (stop - px), mark: 'pb' }; }
  }
  return null;
}

// step one bot's day-state over a session's closed bars (skips bars it has already seen)
export function stepBars(bs, bot, bars, ind, ctx, cfg, ev = {}) {
  const C = cfg.cost;
  for (let i = 0; i < bars.length; i++) {
    const x = bars[i]; if (x.t <= bs.lastT) continue; bs.lastT = x.t;
    const m = ind.m[i], px = x.c;
    if (bs.cool > 0) bs.cool--;
    if (m < 585) { bs.og.hi = Math.max(bs.og.hi ?? -Infinity, x.h); bs.og.lo = Math.min(bs.og.lo ?? Infinity, x.l); }
    const sg = signal(bot.strat, i, x, ind, bs, ctx); bs.sig = { dir: sg.dir, charge: r2(sg.charge), why: sg.why };
    if (bs.pos) {
      const p = bs.pos; p.last = px; p.best = p.side > 0 ? Math.max(p.best, x.h) : Math.min(p.best, x.l);
      let out = null, at = px;
      if (m >= ctx.closeMin - 5) out = 'end of day';
      else if (p.side > 0 ? x.l <= p.stop : x.h >= p.stop) { out = p.trailing ? 'trailing stop' : 'stop'; at = p.stop; }
      else if (p.target != null && (p.side > 0 ? x.h >= p.target : x.l <= p.target)) { out = 'target'; at = p.target; }
      else if (bot.strat === 'trend' && Math.sign(ind.e9[i] - ind.e21[i]) !== p.side && i > 0 && Math.sign(ind.e9[i - 1] - ind.e21[i - 1]) !== p.side) out = 'trend flipped';
      else if (bot.strat === 'fade' && (p.side > 0 ? px >= ind.vw[i] : px <= ind.vw[i])) out = 'back to VWAP';
      if (out) { closeTrade(bs, at, x.t, out, cfg, ev); continue; }
      if (cfg.trail > 0 && p.side * (p.best - p.entry) >= p.atr) { const ns = p.best - p.side * cfg.trail * p.atr; if (p.side > 0 ? ns > p.stop : ns < p.stop) { p.stop = ns; p.trailing = 1; } }
      continue;
    }
    if (bs.lock || bs.cool > 0 || bs.n >= cfg.maxTrades) continue;
    const late = Math.min(ctx.closeMin - 30, 930);
    const inWin = bot.strat === 'gap' ? m >= 575 && m < 600
      : cfg.window === 'am' ? m >= 585 && m < cfg.amEnd : cfg.window === 'ampm' ? (m >= 585 && m < cfg.amEnd) || (m >= 870 && m < late) : m >= 585 && m < late;
    if (!inWin) continue;
    const e = entry(bot.strat, i, x, bars, ind, bs, ctx, cfg);
    if (!e) continue;
    const trendy = TRENDY.has(bot.strat);
    if (cfg.mood) { const er = ctx.er?.get(x.t); if (er != null && (trendy ? er < cfg.moodTh : er >= cfg.moodTh)) continue; }
    if (cfg.confirm && trendy && (x.v < ind.av[i] || Math.sign(ind.e45[i] - ind.e105[i]) !== e.side)) continue;
    if (e.mark) bs.done[e.mark] = 1;
    const target = cfg.trail > 0 && trendy ? null : e.target;
    bs.pos = { side: e.side, entry: px, fill: px * (1 + e.side * C.slip), at: x.t, stop: e.stop, target, last: px, best: px, atr: ind.atr[i], why: e.why };
    bs.n++; ev.open?.(bs.pos);
  }
}
function closeTrade(bs, px, t, why, cfg, ev) {
  const p = bs.pos, r = tradeRet(p, px, cfg.cost), before = bs.sv;
  bs.sv *= 1 + r; bs.pos = null; bs.cool = r < 0 ? Math.max(5, cfg.lossCool) : 5;
  const tr = { side: p.side > 0 ? 'up' : 'down', entry: r4(p.entry), exit: r4(px), in: p.at, out: t, pct: r4(r * 100), why };
  bs.trades.push(tr);
  const g = bs.sv - 1;
  if (g >= cfg.lock.up) bs.lock = 'profit lock'; else if (g <= cfg.lock.down) bs.lock = 'loss limit';
  ev.close?.(tr, r, before);
}
// force-close anything still open (end of data)
export function flatten(bs, cfg, ev) { if (bs.pos) closeTrade(bs, bs.pos.last, bs.lastT, 'end of day', cfg, ev || {}); }

// ---------- funding: who gets the money each morning ----------
export function scoreBot(daily, f) {
  const d = daily.slice(-f.window), n = d.length; if (!n) return 0;
  const mu = d.reduce((a, x) => a + x, 0) / n, sh = n / (n + f.shrink);
  if (f.score === 'sharpe') { const sd = Math.sqrt(d.reduce((a, x) => a + (x - mu) ** 2, 0) / n) + 0.002; return (mu / sd) * sh; }
  return mu * sh;
}
// returns Map(id -> fraction of the pool). Unused fractions stay in cash.
export function pickFunded(bots, dailyOf, f) {
  const sc = bots.map((b) => ({ b, d: dailyOf(b) })).map((x) => ({ ...x, s: scoreBot(x.d, f) }))
    .filter((x) => x.s > f.minScore && !(f.bench && x.d.length >= f.bench && x.d.slice(-f.bench).every((r) => r < 0)))
    .sort((a, b) => b.s - a.s || a.b.id.localeCompare(b.b.id));
  const pick = [], perT = {}, perC = {};
  for (const x of sc) {
    if (pick.length >= f.top) break;
    const t = x.b.sym, c = CLUSTER[t] || t;
    if ((perT[t] || 0) >= f.capTicker || (perC[c] || 0) >= f.capCluster) continue;
    perT[t] = (perT[t] || 0) + 1; perC[c] = (perC[c] || 0) + 1; pick.push(x.b);
  }
  const N = f.top, W = (N * (N + 1)) / 2;
  return new Map(pick.map((b, i) => [b.id, f.weights === 'equal' ? 1 / N : (N - i) / W]));
}

// ---------- live state ----------
export function freshState(cfg = SHIPPED) {
  return { v: VERSION, cfgKey: JSON.stringify(cfg), cfg, startCash: START_CASH, startedAt: Date.now(), cash: START_CASH, day: null, ranks: [],
    bots: botsFor(cfg).map((b) => ({ ...b, alloc: 0, daily: [], bs: newBotDay(), trades: [] })), equity: [], log: [] };
}
export const botEquity = (S, b) => b.alloc * b.bs.sv * (1 + markRet(b.bs.pos, S.cfg.cost));
export const totalEquity = (S) => S.cash + S.bots.reduce((a, b) => a + botEquity(S, b), 0);
const dailyR = (b) => b.daily.map((x) => x.r);
const recent = (b, w = 10) => b.daily.slice(-w).reduce((a, x) => a * (1 + x.r), 1) - 1;

export function newDay(S, day, t) {
  if (S.day === day) return;
  let pool = S.cash;
  for (const b of S.bots) {
    if (b.bs.pos) flatten(b.bs, S.cfg); // safety: nothing should be open overnight
    if (b.bs.day) { b.daily.push({ d: b.bs.day, r: r6(b.bs.sv - 1) }); b.daily = b.daily.slice(-30); }
    pool += b.alloc * b.bs.sv; b.alloc = 0; b.bs = newBotDay(day);
  }
  const w = pickFunded(S.bots, dailyR, S.cfg.fund);
  let used = 0; for (const b of S.bots) if (w.has(b.id)) { b.alloc = pool * w.get(b.id); used += b.alloc; }
  S.cash = pool - used; S.day = day;
  const f = S.bots.filter((b) => b.alloc > 0).sort((a, b) => b.alloc - a.alloc);
  S.ranks = f.map((b) => b.id);
  S.log.unshift({ t, kind: 'new day', why: f.length ? `money goes to ${f.slice(0, 3).map((b) => b.name).join(', ')}${f.length > 3 ? ` +${f.length - 3} more` : ''}${S.cash > 0.01 ? `, $${S.cash.toFixed(2)} sits in cash` : ''}` : 'no bot qualifies, all cash today' });
  S.log = S.log.slice(0, 300);
}
function evFor(S, b) {
  return {
    open: (p) => { if (b.alloc > 0) S.log.unshift({ t: p.at, bot: b.id, kind: p.side > 0 ? 'up bet' : 'down bet', px: r4(p.entry), why: p.why }); },
    close: (tr, r, before) => {
      const pnl = b.alloc * before * r;
      b.trades.unshift({ ...tr, pnl: r6(pnl), real: b.alloc > 0 }); b.trades = b.trades.slice(0, 40);
      if (b.alloc > 0) { S.log.unshift({ t: tr.out, bot: b.id, kind: pnl >= 0 ? 'win' : 'loss', px: tr.exit, pnl: r6(pnl), why: tr.why }); if (b.bs.lock) S.log.unshift({ t: tr.out, bot: b.id, kind: b.bs.lock, why: `${((b.bs.sv - 1) * 100).toFixed(1)}% today, done until tomorrow` }); }
      S.log = S.log.slice(0, 300);
    },
  };
}
// run every bot over one session (bars per symbol), with yesterday's levels for context
function playSession(S, sess, prevOf, closeMin, barMin = 1) {
  const er = moodSeries(sess.SPY || [], barMin);
  for (const s of SYMS) {
    const bars = sess[s]; if (!bars?.length) continue;
    const ind = indicators(bars), ctx = { closeMin, prev: prevOf(s), er, open: bars[0].o };
    for (const b of S.bots) if (b.sym === s) stepBars(b.bs, b, bars, ind, ctx, S.cfg, evFor(S, b));
  }
}
export const hlc = (bars) => (bars?.length ? { h: Math.max(...bars.map((b) => b.h)), l: Math.min(...bars.map((b) => b.l)), c: bars.at(-1).c } : null);

export function mark(S, last) {
  for (const b of S.bots) if (b.bs.pos && last[b.sym]) b.bs.pos.last = last[b.sym];
  const total = totalEquity(S), now = Date.now(), prev = S.equity[S.equity.length - 1];
  if (!prev || now - prev.t >= 5 * 60000 || Math.abs(prev.v - total) > 1e-4) S.equity.push({ t: now, v: r4(total) });
  if (S.equity.length > 3000) S.equity = S.equity.filter((_, i) => i % 2 === 0 || i > S.equity.length - 500);
  return total;
}

// practice-only warmup: replay the last ~7 sessions so rankings aren't empty (moves no money)
export async function warmup(S) {
  const data = await yahooAll(SYMS, '7d'), today = et(Date.now() / 1000).day;
  const days = Object.fromEntries(SYMS.map((s) => [s, data[s]?.bars ? splitDays(data[s].bars) : new Map()]));
  const list = [...days.SPY.keys()].filter((d) => d < today);
  const cash = S.cash; S.cash = 0;
  list.forEach((d, k) => {
    const sess = Object.fromEntries(SYMS.map((s) => [s, days[s].get(d) || []]));
    newDay(S, d, sess.SPY[0].t);
    playSession(S, sess, (s) => hlc(days[s].get(list[k - 1])), et(sess.SPY.at(-1).t).min + 1);
    for (const b of S.bots) flatten(b.bs, S.cfg);
  });
  for (const b of S.bots) { b.trades = []; b.alloc = 0; }
  S.cash = cash; S.day = null; S.log = [{ t: Date.now() / 1000, kind: 'warmed up', why: `scored every bot on the last ${list.length} sessions` }]; S.ranks = [];
  return list.length;
}

// ---------- public view (what the VideoDash City tab reads) ----------
export function publicView(S, st) {
  const f = S.cfg.fund, live = [...S.bots].sort((a, b) => scoreBot(dailyR(b), f) - scoreBot(dailyR(a), f) || a.id.localeCompare(b.id));
  const rank = Object.fromEntries(S.ranks.map((id, i) => [id, i + 1]));
  return { v: VERSION, at: Date.now(), runner: 'github', open: st.open, next: st.next, closeAt: st.closeAt, err: st.err, startCash: S.startCash, startedAt: S.startedAt, total: r4(totalEquity(S)), idle: r4(S.cash),
    strats: Object.fromEntries(S.cfg.strats.map((k) => [k, STRATS[k]])), snames: SNAME, symInfo: SYM_INFO, fund: f, lock: S.cfg.lock, quotes: st.quotes, equity: S.equity.slice(-400), log: S.log.slice(0, 60),
    bots: S.bots.map((b) => { const p = b.bs.pos, eq = botEquity(S, b);
      return { id: b.id, name: b.name, sym: b.sym, strat: b.strat, rank: rank[b.id] || null, liveRank: live.indexOf(b) + 1, funded: b.alloc > 0, alloc: r4(b.alloc), equity: r4(eq),
        score: r6(scoreBot(dailyR(b), f)), r10: r6(recent(b, f.window)), today: r6(b.bs.sv * (1 + markRet(p, S.cfg.cost)) - 1), days: b.daily.length, lock: b.bs.lock, sig: b.bs.sig,
        pos: p ? { side: p.side > 0 ? 'up' : 'down', stake: r4(b.alloc * b.bs.sv), entry: r4(p.entry), last: r4(p.last), at: p.at, stop: r4(p.stop), target: p.target == null ? null : r4(p.target), why: p.why, pct: r4(markRet(p, S.cfg.cost) * 100), pnl: r6(b.alloc * b.bs.sv * markRet(p, S.cfg.cost)) } : null,
        trades: b.trades.slice(0, b.alloc > 0 ? 20 : 8), wins: b.trades.filter((t) => t.pct > 0).length, n: b.trades.length }; }) };
}

// one live tick: 2 days of 1-minute bars per ticker (today + yesterday's levels), roll the day, step every bot, mark to market
export async function tick(S, st) {
  const data = await yahooAll(SYMS, '2d'), ref = data.SPY;
  if (!ref?.bars) throw new Error(ref?.err || 'no SPY data');
  const reg = ref.meta.currentTradingPeriod.regular, now = Date.now() / 1000;
  st.open = now >= reg.start && now < reg.end && ref.bars.length > 0 && now - ref.bars.at(-1).t < 600;
  st.closeAt = reg.end * 1000; st.openAt = reg.start * 1000; st.next = now < reg.start ? reg.start * 1000 : null;
  const closeMin = et(reg.end).min, last = {}, holding = S.bots.some((b) => b.bs.pos), today = et(ref.bars.at(-1).t).day;
  if (st.open) newDay(S, today, now);
  st.quotes = st.quotes || {}; const missing = [], sess = {}, prev = {};
  for (const s of SYMS) {
    const d = data[s]; if (!d?.bars) { missing.push(s); continue; }
    const days = splitDays(d.bars), keys = [...days.keys()], k = keys.indexOf(today);
    sess[s] = (days.get(today) || []).filter((x) => x.t + 60 <= now);
    prev[s] = hlc(days.get(keys[k > 0 ? k - 1 : keys.length - 2]));
    last[s] = d.meta.regularMarketPrice;
    st.quotes[s] = { px: d.meta.regularMarketPrice, prev: d.meta.chartPreviousClose, spark: sess[s].filter((_, i) => i % 5 === 0).map((x) => r4(x.c)).slice(-80) };
  }
  if ((st.open || holding) && S.day === today) playSession(S, sess, (s) => prev[s], closeMin);
  st.err = missing.length ? 'no data for ' + missing.join(', ') : null;
  mark(S, last);
}

// ---------- quick backtest CLI: node city.mjs --backtest ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--backtest')) {
  const S = freshState();
  const data = await yahooAll(SYMS, '7d'), days = Object.fromEntries(SYMS.map((s) => [s, data[s]?.bars ? splitDays(data[s].bars) : new Map()]));
  const list = [...days.SPY.keys()];
  list.forEach((d, k) => {
    const sess = Object.fromEntries(SYMS.map((s) => [s, days[s].get(d) || []]));
    newDay(S, d, sess.SPY[0].t);
    playSession(S, sess, (s) => hlc(days[s].get(list[k - 1])), et(sess.SPY.at(-1).t).min + 1);
    for (const b of S.bots) flatten(b.bs, S.cfg);
    console.log(d, 'total', totalEquity(S).toFixed(4), '| funded:', S.bots.filter((b) => b.alloc > 0).map((b) => `${b.name} ${((b.bs.sv - 1) * 100).toFixed(2)}%`).join(', '));
  });
  console.log('view size', JSON.stringify(publicView(S, { quotes: {} })).length);
}
