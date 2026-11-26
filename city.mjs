// City: paper-trading bots on REAL market prices (Yahoo 1-minute bars), fake money only.
// Five bots, one "tower" each. Runs on GitHub Actions (run.mjs); state lives on the `live` branch.
// Nothing here can place a real order: no broker, no keys, fake money only.
//
//   node city.mjs --backtest [days]   replay the last few sessions on a fresh $20 (does not touch the real state)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START_CASH = 20;
export const BOTS = [
  { id: 'qqq-trend', name: 'QQQ Trend', sym: 'QQQ', strat: 'trend' },
  { id: 'spy-trend', name: 'SPY Trend', sym: 'SPY', strat: 'trend' },
  { id: 'iwm-trend', name: 'IWM Trend', sym: 'IWM', strat: 'trend' },
  { id: 'qqq-og', name: 'QQQ OG', sym: 'QQQ', strat: 'og' },
  { id: 'qqq-fade', name: 'QQQ Fade', sym: 'QQQ', strat: 'fade' },
];
export const STRATS = {
  trend: 'Bets with the move. Fast average (9) crosses the slow one (21) and price is on the same side of VWAP. Out at +0.35% / -0.25% or when the averages flip back.',
  og: 'Opening range breakout. Marks the high and low of 9:30-9:45. Breaks above = up bet, breaks below = down bet. Target one range width, stop at the middle. Max one trade each way per day.',
  fade: 'Bets against stretched moves. RSI under 25 and price well under VWAP = up bet, RSI over 75 and well over VWAP = down bet. Out at VWAP, +0.3%, or -0.25%.',
};
const LOCK_UP = 0.02, LOCK_DOWN = -0.03; // profit lock / loss limit, fraction of the bot's balance at the open

// ---------- helpers ----------
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function et(tsSec) { const p = Object.fromEntries(ET.formatToParts(new Date(tsSec * 1000)).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; }
const r2 = (n) => Math.round(n * 100) / 100, r4 = (n) => Math.round(n * 1e4) / 1e4;

export async function yahoo(sym, range = '1d') {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=${range}&includePrePost=false`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`yahoo ${sym} ${r.status}`);
  const j = (await r.json()).chart.result[0];
  const q = j.indicators.quote[0], bars = [];
  (j.timestamp || []).forEach((t, i) => { if (q.close[i] != null && q.high[i] != null) bars.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  return { bars, meta: j.meta };
}

// indicators over one session's bars (index 0 = first bar of the day)
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

// ---------- the engine (pure: same code for live and backtest) ----------
export function freshState() {
  return { v: 1, startCash: START_CASH, startedAt: Date.now(), bots: BOTS.map((b) => ({ ...b, cash: START_CASH / BOTS.length, pos: null, trades: [], day: null, dayStart: 0, lock: null, lastT: 0, sig: { dir: null, charge: 0, why: '' }, cool: 0, og: {} })), equity: [], log: [] };
}
export function botEquity(b, px) { return b.cash + (b.pos ? b.pos.qty * b.pos.entry + b.pos.side * b.pos.qty * ((px ?? b.pos.last) - b.pos.entry) : 0); }

function openPos(S, b, side, px, t, why, stop, target) {
  const qty = b.cash / px; b.cash = 0;
  b.pos = { side, qty, entry: px, at: t, stop, target, last: px, why };
  S.log.unshift({ t, bot: b.id, kind: side > 0 ? 'up bet' : 'down bet', px: r4(px), why });
}
function closePos(S, b, px, t, why) {
  const p = b.pos, pnl = p.side * p.qty * (px - p.entry);
  b.cash = p.qty * p.entry + pnl;
  b.trades.unshift({ side: p.side > 0 ? 'up' : 'down', entry: r4(p.entry), exit: r4(px), in: p.at, out: t, pnl: r4(pnl), pct: r4((p.side * (px - p.entry) / p.entry) * 100), why });
  b.trades = b.trades.slice(0, 200); b.pos = null; b.cool = 5;
  S.log.unshift({ t, bot: b.id, kind: pnl >= 0 ? 'win' : 'loss', px: r4(px), pnl: r4(pnl), why });
  S.log = S.log.slice(0, 300);
  const gain = (botEquity(b) - b.dayStart) / b.dayStart;
  if (gain >= LOCK_UP) b.lock = 'profit lock'; else if (gain <= LOCK_DOWN) b.lock = 'loss limit';
  if (b.lock) S.log.unshift({ t, bot: b.id, kind: b.lock, why: `${(gain * 100).toFixed(1)}% today, done until tomorrow` });
}

// run one bot over a session's closed bars; closeMin = minutes-after-midnight ET of the session close
export function stepBot(S, b, bars, closeMin) {
  if (!bars.length) return;
  const day = et(bars[0].t).day;
  if (b.day !== day) { b.day = day; b.dayStart = botEquity(b, b.pos?.last); b.lock = null; b.og = {}; b.cool = 0; }
  const ind = indicators(bars);
  for (let i = 0; i < bars.length; i++) {
    const x = bars[i]; if (x.t <= b.lastT) continue; b.lastT = x.t;
    const m = et(x.t).min, px = x.c, e9 = ind.e9[i], e21 = ind.e21[i], vw = ind.vw[i], rsi = ind.rsi[i];
    if (b.cool > 0) b.cool--;
    // signal meter (what the tower shows)
    let dir = null, charge = 0, why = '';
    if (b.strat === 'trend') { const gap = (e9 - e21) / px * 1e4; dir = gap > 0 ? 'up' : 'down'; charge = Math.min(1, Math.abs(gap) / 6) * ((gap > 0) === (px > vw) ? 1 : 0.4); why = `9/21 gap ${gap.toFixed(1)} bp, price ${px > vw ? 'above' : 'below'} VWAP`; }
    if (b.strat === 'og') {
      if (m < 585) { b.og.hi = Math.max(b.og.hi ?? -Infinity, x.h); b.og.lo = Math.min(b.og.lo ?? Infinity, x.l); why = 'marking the opening range'; }
      else if (b.og.hi) { const rg = b.og.hi - b.og.lo || px * 1e-3, up = (px - b.og.lo) / rg; dir = up >= 0.5 ? 'up' : 'down'; charge = Math.min(1, Math.abs(up - 0.5) * 2) ** 2; why = `range ${b.og.lo.toFixed(2)}-${b.og.hi.toFixed(2)}`; }
    }
    if (b.strat === 'fade') { dir = rsi < 50 ? 'up' : 'down'; charge = Math.min(1, Math.max(0, (Math.abs(rsi - 50) - 10) / 15)); why = `RSI ${rsi.toFixed(0)}, ${((px - vw) / vw * 100).toFixed(2)}% from VWAP`; }
    b.sig = { dir, charge: r2(charge), why };
    // manage an open position
    if (b.pos) {
      const p = b.pos; p.last = px; const ch = p.side * (px - p.entry) / p.entry;
      let out = null;
      if (m >= closeMin - 5) out = 'end of day';
      else if (p.side > 0 ? x.l <= p.stop : x.h >= p.stop) { out = 'stop'; closePos(S, b, p.stop, x.t, out); continue; }
      else if (p.side > 0 ? x.h >= p.target : x.l <= p.target) { out = 'target'; closePos(S, b, p.target, x.t, out); continue; }
      else if (b.strat === 'trend' && Math.sign(e9 - e21) !== p.side && i > 0 && Math.sign(ind.e9[i - 1] - ind.e21[i - 1]) !== p.side) out = 'trend flipped';
      else if (b.strat === 'fade' && (p.side > 0 ? px >= vw : px <= vw)) out = 'back to VWAP';
      if (out) closePos(S, b, px, x.t, out);
      continue;
    }
    // entries
    if (b.lock || b.cool > 0 || m < 585 || m >= Math.min(closeMin - 30, 930) || b.cash < 0.01) continue;
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

// mark open positions to the latest live price, record the equity curve
export function mark(S, last) {
  for (const b of S.bots) if (b.pos && last[b.sym]) b.pos.last = last[b.sym];
  const total = S.bots.reduce((a, b) => a + botEquity(b), 0);
  const now = Date.now(), prev = S.equity[S.equity.length - 1];
  if (!prev || now - prev.t >= 5 * 60000 || Math.abs(prev.v - total) > 1e-4) S.equity.push({ t: now, v: r4(total) });
  if (S.equity.length > 3000) S.equity = S.equity.filter((_, i) => i % 2 === 0 || i > S.equity.length - 500);
  return total;
}

// ---------- public view (what the VideoDash City tab reads) ----------
export function publicView(S, st) {
  const total = S.bots.reduce((a, b) => a + botEquity(b), 0);
  return { at: Date.now(), runner: 'github', open: st.open, next: st.next, closeAt: st.closeAt, err: st.err, startCash: S.startCash, startedAt: S.startedAt, total: r4(total), strats: STRATS, lock: { up: LOCK_UP, down: LOCK_DOWN },
    quotes: st.quotes, equity: S.equity.slice(-400), log: S.log.slice(0, 60),
    bots: S.bots.map((b) => ({ id: b.id, name: b.name, sym: b.sym, strat: b.strat, equity: r4(botEquity(b)), dayStart: r4(b.dayStart || START_CASH / BOTS.length), lock: b.lock, sig: b.sig,
      pos: b.pos ? { side: b.pos.side > 0 ? 'up' : 'down', entry: r4(b.pos.entry), last: r4(b.pos.last), at: b.pos.at, stop: r4(b.pos.stop), target: r4(b.pos.target), why: b.pos.why, pnl: r4(b.pos.side * b.pos.qty * (b.pos.last - b.pos.entry)) } : null,
      trades: b.trades.slice(0, 30), wins: b.trades.filter((t) => t.pnl > 0).length, n: b.trades.length })) };
}

// one tick: pull live 1-minute bars, step the bots, mark to market. Mutates S and st.
export async function tick(S, st) {
  const syms = [...new Set(S.bots.map((b) => b.sym))], data = {};
  for (const s of syms) data[s] = await yahoo(s);
  const meta = data[syms[0]].meta, reg = meta.currentTradingPeriod.regular, now = Date.now() / 1000;
  st.open = now >= reg.start && now < reg.end && data[syms[0]].bars.length > 0 && now - data[syms[0]].bars.at(-1).t < 600;
  st.closeAt = reg.end * 1000; st.openAt = reg.start * 1000; st.next = now < reg.start ? reg.start * 1000 : null;
  const closeMin = et(reg.end).min, last = {};
  st.quotes = st.quotes || {};
  for (const s of syms) {
    const { bars, meta: mt } = data[s];
    const today = bars.length ? et(bars.at(-1).t).day : null;
    const sess = bars.filter((x) => et(x.t).day === today && x.t + 60 <= now); // closed bars of the latest session only
    last[s] = mt.regularMarketPrice;
    st.quotes[s] = { px: mt.regularMarketPrice, prev: mt.chartPreviousClose, spark: sess.filter((_, i) => i % 5 === 0).map((x) => r4(x.c)).slice(-80) };
    if (st.open || S.bots.some((b) => b.pos)) for (const b of S.bots.filter((y) => y.sym === s)) stepBot(S, b, sess, closeMin);
  }
  mark(S, last);
}

// ---------- backtest CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--backtest')) {
  const S = freshState(), syms = [...new Set(BOTS.map((b) => b.sym))], data = {};
  for (const s of syms) data[s] = (await yahoo(s, '5d')).bars;
  const days = [...new Set(data.SPY.map((x) => et(x.t).day))];
  for (const d of days) {
    for (const s of syms) {
      const sess = data[s].filter((x) => et(x.t).day === d), closeMin = et(sess.at(-1).t).min + 1;
      for (const b of S.bots.filter((y) => y.sym === s)) stepBot(S, b, sess, closeMin);
    }
    console.log(d, 'equity', S.bots.reduce((a, b) => a + botEquity(b), 0).toFixed(4));
  }
  for (const b of S.bots) console.log(b.name.padEnd(10), 'trades', String(b.trades.length).padStart(3), 'wins', String(b.trades.filter((t) => t.pnl > 0).length).padStart(3), 'equity', botEquity(b).toFixed(4), b.pos ? 'OPEN' : '');
  console.log('sample:', JSON.stringify(S.log.slice(0, 6)));
}
