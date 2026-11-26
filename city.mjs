// City: paper-trading bots on REAL market prices (Yahoo 1-minute bars), fake money only.
// Every ticker x every strategy = one bot. All bots trade every day in "practice" (shadow) mode so each
// one builds a track record; each morning the $ pool is handed to the top-ranked bots (the "funded" ones).
// Runs on GitHub Actions (run.mjs); state lives on the `live` branch. No broker, no keys, no real orders.
//
//   node city.mjs --backtest     replay the last ~7 sessions with the daily re-ranking (does not touch the real state)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START_CASH = 20;
export const SYMS = ['SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'XLK', 'XLF', 'XLE', 'ARKK', 'TLT', 'NVDA', 'TSLA', 'AAPL', 'AMD', 'META', 'AMZN', 'MSFT'];
export const SYM_INFO = {
  SPY: 'S&P 500, the 500 biggest US companies', QQQ: 'Nasdaq 100, mostly big tech', IWM: 'Russell 2000, small companies', DIA: 'Dow Jones, 30 old-school giants',
  SMH: 'chip makers', XLK: 'tech sector', XLF: 'banks and finance', XLE: 'oil and energy', ARKK: 'risky "future tech" fund', TLT: 'long-term US government bonds',
  NVDA: 'Nvidia', TSLA: 'Tesla', AAPL: 'Apple', AMD: 'AMD', META: 'Meta', AMZN: 'Amazon', MSFT: 'Microsoft',
};
export const STRATS = {
  trend: 'Bets with the move. Fast average (9) crosses the slow one (21) and price is on the same side of VWAP. Out at +0.35% / -0.25% or when the averages flip back.',
  og: 'Opening range breakout. Marks the high and low of 9:30-9:45. Breaks above = up bet, breaks below = down bet. Target one range width, stop at the middle. Max one trade each way per day.',
  fade: 'Bets against stretched moves. RSI under 25 and price well under VWAP = up bet, RSI over 75 and well over VWAP = down bet. Out at VWAP, +0.3%, or -0.25%.',
};
const SNAME = { trend: 'Trend', og: 'OG', fade: 'Fade' };
export const BOTS = SYMS.flatMap((sym) => Object.keys(STRATS).map((strat) => ({ id: `${sym.toLowerCase()}-${strat}`, name: `${sym} ${SNAME[strat]}`, sym, strat })));
const LOCK_UP = 0.02, LOCK_DOWN = -0.03; // per bot per day, on its practice score
export const FUND = { top: 8, window: 10, shrink: 3 }; // fund the top 8, ranked on the last 10 sessions

// ---------- helpers ----------
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function et(tsSec) { const p = Object.fromEntries(ET.formatToParts(new Date(tsSec * 1000)).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; }
const r2 = (n) => Math.round(n * 100) / 100, r4 = (n) => Math.round(n * 1e4) / 1e4, r6 = (n) => Math.round(n * 1e6) / 1e6;

export async function yahoo(sym, range = '1d') {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=${range}&includePrePost=false`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`yahoo ${sym} ${r.status}`);
      const j = (await r.json()).chart.result[0];
      const q = j.indicators.quote[0], bars = [];
      (j.timestamp || []).forEach((t, k) => { if (q.close[k] != null && q.high[k] != null) bars.push({ t, o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k], v: q.volume[k] || 0 }); });
      return { bars, meta: j.meta };
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
}
async function yahooAll(syms, range) {
  const out = {}, q = [...syms];
  await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) { const s = q.shift(); try { out[s] = await yahoo(s, range); } catch (e) { out[s] = { err: e.message }; } } }));
  return out;
}

function indicators(bars) {
  const n = bars.length, ema = (p) => { const k = 2 / (p + 1); let e = bars[0].c; return bars.map((b) => (e = b.c * k + e * (1 - k))); };
  const e9 = ema(9), e21 = ema(21), vw = [], rsi = [];
  let pv = 0, vv = 0, ag = 0, al = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i], tp = (b.h + b.l + b.c) / 3; pv += tp * (b.v || 1); vv += b.v || 1; vw.push(pv / vv);
    if (i === 0) { rsi.push(50); continue; }
    const d = b.c - bars[i - 1].c, g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= 14) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; }
    rsi.push(i < 14 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return { e9, e21, vw, rsi };
}

// ---------- state ----------
export function freshState() {
  return { v: 2, startCash: START_CASH, startedAt: Date.now(), cash: START_CASH, day: null, ranks: [],
    bots: BOTS.map((b) => ({ ...b, cash: 0, alloc: 0, sv: 1, sd: 1, daily: [], pos: null, trades: [], day: null, lock: null, lastT: 0, sig: { dir: null, charge: 0, why: '' }, cool: 0, og: {} })),
    equity: [], log: [] };
}
const posValue = (p, px) => p.stake * (1 + p.side * ((px ?? p.last) - p.entry) / p.entry);
export function botEquity(b, px) { return b.cash + (b.pos ? posValue(b.pos, px) : 0); }
export const totalEquity = (S) => S.cash + S.bots.reduce((a, b) => a + botEquity(b), 0);
export function score(b) { const d = b.daily.slice(-FUND.window), n = d.length; if (!n) return 0; return d.reduce((a, x) => a + x.r, 0) / n * (n / (n + FUND.shrink)); }
const recent = (b) => b.daily.slice(-FUND.window).reduce((a, x) => a * (1 + x.r), 1) - 1;

// new session: close the books on yesterday for every bot, re-rank, hand the pool to the top bots
export function newDay(S, day, t) {
  if (S.day === day) return;
  for (const b of S.bots) {
    if (b.day) { b.daily.push({ d: b.day, r: r6(b.sv / b.sd - 1) }); b.daily = b.daily.slice(-30); }
    b.day = day; b.sd = b.sv; b.lock = null; b.og = {}; b.cool = 0;
  }
  if (S.bots.some((b) => b.pos)) return void (S.day = day); // never re-deal mid-trade (shouldn't happen: everything closes before the bell)
  let pool = S.cash; for (const b of S.bots) { pool += b.cash; b.cash = 0; b.alloc = 0; }
  const ranked = [...S.bots].sort((a, b) => score(b) - score(a) || recent(b) - recent(a) || a.id.localeCompare(b.id));
  const top = ranked.slice(0, FUND.top), W = top.reduce((a, _, i) => a + (FUND.top - i), 0);
  top.forEach((b, i) => { b.cash = b.alloc = pool * (FUND.top - i) / W; });
  S.cash = 0; S.day = day; S.ranks = ranked.map((b) => b.id);
  S.log.unshift({ t, kind: 'new day', why: `money goes to ${top.slice(0, 3).map((b) => b.name).join(', ')} +${top.length - 3} more` });
}

function openPos(S, b, side, px, t, why, stop, target) {
  b.pos = { side, stake: b.cash, entry: px, at: t, stop, target, last: px, why }; b.cash = 0;
  if (b.pos.stake > 0) S.log.unshift({ t, bot: b.id, kind: side > 0 ? 'up bet' : 'down bet', px: r4(px), why });
}
function closePos(S, b, px, t, why) {
  const p = b.pos, ret = p.side * (px - p.entry) / p.entry, pnl = p.stake * ret;
  b.cash = p.stake + pnl; b.sv *= 1 + ret;
  b.trades.unshift({ side: p.side > 0 ? 'up' : 'down', entry: r4(p.entry), exit: r4(px), in: p.at, out: t, pnl: r6(pnl), pct: r4(ret * 100), why, real: p.stake > 0 });
  b.trades = b.trades.slice(0, 40); b.pos = null; b.cool = 5;
  if (p.stake > 0) S.log.unshift({ t, bot: b.id, kind: pnl >= 0 ? 'win' : 'loss', px: r4(px), pnl: r6(pnl), why });
  const g = b.sv / b.sd - 1;
  if (g >= LOCK_UP) b.lock = 'profit lock'; else if (g <= LOCK_DOWN) b.lock = 'loss limit';
  if (b.lock && b.alloc > 0) S.log.unshift({ t, bot: b.id, kind: b.lock, why: `${(g * 100).toFixed(1)}% today, done until tomorrow` });
  S.log = S.log.slice(0, 300);
}

// run one bot over a session's closed bars (call newDay for the session first)
export function stepBot(S, b, bars, closeMin, ind = indicators(bars)) {
  for (let i = 0; i < bars.length; i++) {
    const x = bars[i]; if (x.t <= b.lastT) continue; b.lastT = x.t;
    const m = et(x.t).min, px = x.c, e9 = ind.e9[i], e21 = ind.e21[i], vw = ind.vw[i], rsi = ind.rsi[i];
    if (b.cool > 0) b.cool--;
    let dir = null, charge = 0, why = '';
    if (b.strat === 'trend') { const gap = (e9 - e21) / px * 1e4; dir = gap > 0 ? 'up' : 'down'; charge = Math.min(1, Math.abs(gap) / 6) * ((gap > 0) === (px > vw) ? 1 : 0.4); why = `9/21 gap ${gap.toFixed(1)} bp, price ${px > vw ? 'above' : 'below'} VWAP`; }
    if (b.strat === 'og') {
      if (m < 585) { b.og.hi = Math.max(b.og.hi ?? -Infinity, x.h); b.og.lo = Math.min(b.og.lo ?? Infinity, x.l); why = 'marking the opening range'; }
      else if (b.og.hi) { const rg = b.og.hi - b.og.lo || px * 1e-3, up = (px - b.og.lo) / rg; dir = up >= 0.5 ? 'up' : 'down'; charge = Math.min(1, Math.abs(up - 0.5) * 2) ** 2; why = `range ${b.og.lo.toFixed(2)}-${b.og.hi.toFixed(2)}`; }
    }
    if (b.strat === 'fade') { dir = rsi < 50 ? 'up' : 'down'; charge = Math.min(1, Math.max(0, (Math.abs(rsi - 50) - 10) / 15)); why = `RSI ${rsi.toFixed(0)}, ${((px - vw) / vw * 100).toFixed(2)}% from VWAP`; }
    b.sig = { dir, charge: r2(charge), why };
    if (b.pos) {
      const p = b.pos; p.last = px;
      let out = null;
      if (m >= closeMin - 5) out = 'end of day';
      else if (p.side > 0 ? x.l <= p.stop : x.h >= p.stop) { closePos(S, b, p.stop, x.t, 'stop'); continue; }
      else if (p.side > 0 ? x.h >= p.target : x.l <= p.target) { closePos(S, b, p.target, x.t, 'target'); continue; }
      else if (b.strat === 'trend' && Math.sign(e9 - e21) !== p.side && i > 0 && Math.sign(ind.e9[i - 1] - ind.e21[i - 1]) !== p.side) out = 'trend flipped';
      else if (b.strat === 'fade' && (p.side > 0 ? px >= vw : px <= vw)) out = 'back to VWAP';
      if (out) closePos(S, b, px, x.t, out);
      continue;
    }
    if (b.lock || b.cool > 0 || m < 585 || m >= Math.min(closeMin - 30, 930)) continue;
    if (b.strat === 'trend' && i > 3) {
      const was = Math.sign(ind.e9[i - 3] - ind.e21[i - 3]), now = Math.sign(e9 - e21), slope = e9 - ind.e9[i - 2], wide = Math.abs(e9 - e21) / px * 1e4 >= 1.5;
      if (wide && now !== was && now > 0 && px > vw && slope > 0) openPos(S, b, 1, px, x.t, '9 crossed above 21, over VWAP', px * (1 - 0.0025), px * (1 + 0.0035));
      else if (wide && now !== was && now < 0 && px < vw && slope < 0) openPos(S, b, -1, px, x.t, '9 crossed below 21, under VWAP', px * (1 + 0.0025), px * (1 - 0.0035));
    }
    if (b.strat === 'og' && b.og.hi) {
      const rg = b.og.hi - b.og.lo, mid = (b.og.hi + b.og.lo) / 2, avgV = bars.slice(Math.max(0, i - 20), i).reduce((a, y) => a + y.v, 0) / Math.min(20, i || 1);
      if (!b.og.up && px > b.og.hi && x.v >= avgV) { b.og.up = 1; openPos(S, b, 1, px, x.t, 'broke above the opening range', mid, px + rg); }
      else if (!b.og.dn && px < b.og.lo && x.v >= avgV) { b.og.dn = 1; openPos(S, b, -1, px, x.t, 'broke below the opening range', mid, px - rg); }
    }
    if (b.strat === 'fade') {
      const dv = (px - vw) / vw;
      if (rsi < 25 && dv < -0.002) openPos(S, b, 1, px, x.t, `oversold (RSI ${rsi.toFixed(0)})`, px * (1 - 0.0025), px * (1 + 0.003));
      else if (rsi > 75 && dv > 0.002) openPos(S, b, -1, px, x.t, `overbought (RSI ${rsi.toFixed(0)})`, px * (1 + 0.0025), px * (1 - 0.003));
    }
  }
}

export function mark(S, last) {
  for (const b of S.bots) if (b.pos && last[b.sym]) b.pos.last = last[b.sym];
  const total = totalEquity(S), now = Date.now(), prev = S.equity[S.equity.length - 1];
  if (!prev || now - prev.t >= 5 * 60000 || Math.abs(prev.v - total) > 1e-4) S.equity.push({ t: now, v: r4(total) });
  if (S.equity.length > 3000) S.equity = S.equity.filter((_, i) => i % 2 === 0 || i > S.equity.length - 500);
  return total;
}

// replay past sessions so a fresh city starts with track records
function replay(S, data, days, onDay) {
  for (const d of days) {
    const sess = {};
    for (const s of SYMS) if (data[s]?.bars) sess[s] = data[s].bars.filter((x) => et(x.t).day === d);
    const ref = sess.SPY?.length ? sess.SPY : Object.values(sess).find((x) => x.length);
    if (!ref?.length) continue;
    newDay(S, d, ref[0].t);
    const closeMin = et(ref.at(-1).t).min + 1;
    for (const s of SYMS) { const bars = sess[s]; if (!bars?.length) continue; const ind = indicators(bars); for (const b of S.bots.filter((y) => y.sym === s)) stepBot(S, b, bars, closeMin, ind); }
    onDay?.(d);
  }
}
// practice-only warmup (moves no money)
export async function warmup(S) {
  const data = await yahooAll(SYMS, '7d');
  const today = et(Date.now() / 1000).day;
  const days = [...new Set((data.SPY?.bars || []).map((x) => et(x.t).day))].filter((d) => d < today);
  const cash = S.cash; S.cash = 0;
  replay(S, data, days);
  for (const b of S.bots) { b.trades = []; b.cash = 0; b.alloc = 0; b.pos = null; }
  S.cash = cash; S.log = [{ t: Date.now() / 1000, kind: 'warmed up', why: `scored every bot on the last ${days.length} sessions` }]; S.ranks = [];
  return days.length;
}

// ---------- public view (what the VideoDash City tab reads) ----------
export function publicView(S, st) {
  const total = totalEquity(S), rank = Object.fromEntries((S.ranks.length ? S.ranks : S.bots.map((b) => b.id)).map((id, i) => [id, i + 1]));
  const live = [...S.bots].sort((a, b) => score(b) - score(a));
  return { v: 2, at: Date.now(), runner: 'github', open: st.open, next: st.next, closeAt: st.closeAt, err: st.err, startCash: S.startCash, startedAt: S.startedAt, total: r4(total), idle: r4(S.cash),
    strats: STRATS, symInfo: SYM_INFO, fund: FUND, lock: { up: LOCK_UP, down: LOCK_DOWN }, quotes: st.quotes, equity: S.equity.slice(-400), log: S.log.slice(0, 60),
    bots: S.bots.map((b) => ({ id: b.id, name: b.name, sym: b.sym, strat: b.strat, rank: rank[b.id], liveRank: live.indexOf(b) + 1, funded: b.alloc > 0, alloc: r4(b.alloc), equity: r4(botEquity(b)),
      score: r6(score(b)), r10: r6(recent(b)), today: r6(b.sv / b.sd - 1), days: b.daily.length, lock: b.lock, sig: b.sig,
      pos: b.pos ? { side: b.pos.side > 0 ? 'up' : 'down', stake: r4(b.pos.stake), entry: r4(b.pos.entry), last: r4(b.pos.last), at: b.pos.at, stop: r4(b.pos.stop), target: r4(b.pos.target), why: b.pos.why, pct: r4(b.pos.side * (b.pos.last - b.pos.entry) / b.pos.entry * 100), pnl: r6(posValue(b.pos) - b.pos.stake) } : null,
      trades: b.trades.slice(0, b.alloc > 0 ? 20 : 8), wins: b.trades.filter((t) => t.pct > 0).length, n: b.trades.length })) };
}

// one live tick: pull 1-minute bars for every ticker, roll the day if needed, step the bots, mark to market
export async function tick(S, st) {
  const data = await yahooAll(SYMS, '1d'), ref = data.SPY;
  if (!ref?.bars) throw new Error(ref?.err || 'no SPY data');
  const reg = ref.meta.currentTradingPeriod.regular, now = Date.now() / 1000;
  st.open = now >= reg.start && now < reg.end && ref.bars.length > 0 && now - ref.bars.at(-1).t < 600;
  st.closeAt = reg.end * 1000; st.openAt = reg.start * 1000; st.next = now < reg.start ? reg.start * 1000 : null;
  const closeMin = et(reg.end).min, last = {}, holding = S.bots.some((b) => b.pos);
  if (st.open) newDay(S, et(ref.bars.at(-1).t).day, now);
  st.quotes = st.quotes || {}; const missing = [];
  for (const s of SYMS) {
    const d = data[s]; if (!d?.bars) { missing.push(s); continue; }
    const today = d.bars.length ? et(d.bars.at(-1).t).day : null;
    const sess = d.bars.filter((x) => et(x.t).day === today && x.t + 60 <= now);
    last[s] = d.meta.regularMarketPrice;
    st.quotes[s] = { px: d.meta.regularMarketPrice, prev: d.meta.chartPreviousClose, spark: sess.filter((_, i) => i % 5 === 0).map((x) => r4(x.c)).slice(-80) };
    if ((st.open || holding) && sess.length) { const ind = indicators(sess); for (const b of S.bots.filter((y) => y.sym === s)) stepBot(S, b, sess, closeMin, ind); }
  }
  st.err = missing.length ? 'no data for ' + missing.join(', ') : null;
  mark(S, last);
}

// ---------- backtest CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--backtest')) {
  const S = freshState(), data = await yahooAll(SYMS, '7d');
  const days = [...new Set(data.SPY.bars.map((x) => et(x.t).day))];
  replay(S, data, days, (d) => {
    const f = S.bots.filter((b) => b.alloc > 0);
    console.log(d, 'total', totalEquity(S).toFixed(4), '| funded:', f.map((b) => `${b.name} ${(b.sv / b.sd * 100 - 100).toFixed(2)}%`).join(', '));
  });
  const all = [...S.bots].sort((a, b) => score(b) - score(a));
  console.log('\nbest practice records:'); for (const b of all.slice(0, 8)) console.log(' ', b.name.padEnd(10), (recent(b) * 100).toFixed(2).padStart(6) + '%', 'trades', b.trades.length);
  console.log('worst:'); for (const b of all.slice(-4)) console.log(' ', b.name.padEnd(10), (recent(b) * 100).toFixed(2).padStart(6) + '%', 'trades', b.trades.length);
  console.log('\nequal-split benchmark (same $20 spread over all bots):', (20 * S.bots.reduce((a, b) => a + b.sv, 0) / S.bots.length).toFixed(4));
  console.log('view size', JSON.stringify(publicView(S, { quotes: {} })).length);
}
