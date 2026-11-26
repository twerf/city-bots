// Mirror lane: the reel guy's style on Alpaca PAPER (fake $100k). 1-day-to-expiry at-the-money options on
// QQQ / SPY / IWM, triggered by our trend + opening-range signals. Real option quotes, real paper fills.
// PAPER ONLY: the base URL is hard-coded to the paper endpoint and every tick re-checks the account is a paper account.
import { BASE_CFG, botsFor, indicators, moodSeries, newBotDay, stepBars, splitDays, hlc, et, yahooAll } from './city.mjs';

const BASE = 'https://paper-api.alpaca.markets', DATA = 'https://data.alpaca.markets';
if (!BASE.startsWith('https://paper-api.')) throw new Error('mirror: refusing to run against a non-paper endpoint');
const KEY = process.env.ALPACA_KEY, SEC = process.env.ALPACA_SECRET;
export const mirrorEnabled = () => !!(KEY && SEC);

export const RULES = { perTrade: 0.05, maxOpen: 3, stop: -0.4, target: 0.6, flatMin: 950, lastEntryMin: 930, lockUp: 0.03, lockDown: -0.03, orderTtlSec: 55, signalMaxAgeSec: 150 };
const UNDER = ['QQQ', 'SPY', 'IWM'];
const CFG = { ...BASE_CFG, strats: ['trend', 'og'], syms: UNDER, fill: 'close' }; // signal engine = our trend + opening-range bots
const BOTS = botsFor(CFG);

async function api(base, p, opt = {}) {
  const r = await fetch(base + p, { ...opt, headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'Content-Type': 'application/json' } });
  const t = await r.text();
  if (!r.ok) { const e = new Error(`alpaca ${r.status} ${opt.method || 'GET'} ${p.split('?')[0]}: ${t.slice(0, 200)}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
const T = (p, o) => api(BASE, '/v2' + p, o), D = (p) => api(DATA, p);
export async function assertPaper() {
  const a = await T('/account');
  if (!String(a.account_number || '').startsWith('PA')) throw new Error('mirror: refusing, this is not a paper account');
  return a;
}
const r2 = (n) => Math.round(n * 100) / 100, r4 = (n) => Math.round(n * 1e4) / 1e4;

export function freshMirror() {
  return { v: 1, startedAt: Date.now(), startEq: null, spy0: null, day: null, dayStartEq: null, locked: null, shadow: {}, open: {}, orders: [], trades: [], log: [], equity: [], days: [], spreads: [], slips: [], lastEq: null, lastSpy: null, err: null };
}
const say = (M, kind, why, extra = {}) => { M.log.unshift({ t: Date.now(), kind, why, ...extra }); M.log = M.log.slice(0, 200); };

async function nextTradingDay(today) {
  const end = new Date(Date.parse(today) + 12 * 86400e3).toISOString().slice(0, 10);
  const cal = await T(`/calendar?start=${today}&end=${end}`);
  return cal.map((c) => c.date).find((d) => d > today);
}
export async function quotes(syms) {
  if (!syms.length) return {};
  const j = await D(`/v1beta1/options/quotes/latest?symbols=${syms.join(',')}&feed=indicative`);
  return j.quotes || {};
}
async function pickContract(under, side, px, exp) {
  const type = side > 0 ? 'call' : 'put';
  // next trading day's expiry; if that ticker has none (e.g. no daily expiries), the soonest one after it
  const lte = new Date(Date.parse(exp) + 7 * 86400e3).toISOString().slice(0, 10);
  const j = await T(`/options/contracts?underlying_symbols=${under}&expiration_date_gte=${exp}&expiration_date_lte=${lte}&type=${type}&strike_price_gte=${(px * 0.97).toFixed(2)}&strike_price_lte=${(px * 1.03).toFixed(2)}&limit=1000`);
  const cs = (j.option_contracts || []).filter((x) => x.tradable !== false);
  const first = cs.map((x) => x.expiration_date).sort()[0];
  return cs.filter((x) => x.expiration_date === first).sort((a, b) => Math.abs(a.strike_price - px) - Math.abs(b.strike_price - px))[0] || null;
}
async function placeLimit(M, o) {
  const ord = await T('/orders', { method: 'POST', body: JSON.stringify({ symbol: o.sym, qty: String(o.qty), side: o.kind, type: 'limit', limit_price: o.limit.toFixed(2), time_in_force: 'day' }) });
  M.orders.push({ ...o, id: ord.id, at: Date.now() });
  say(M, o.kind === 'buy' ? 'order buy' : 'order sell', `${o.qty}x ${o.sym} limit $${o.limit.toFixed(2)} (bid ${o.bid} / ask ${o.ask})${o.why ? ' · ' + o.why : ''}`);
}

// one tick: called every minute by run.mjs while the market is open
export async function mirrorTick(M) {
  const acct = await assertPaper(), eq = +acct.equity;
  M.lastEq = eq; if (M.startEq == null) M.startEq = eq;
  const clock = await T('/clock'), nowS = Date.now() / 1000, { day: today, min: m } = et(nowS);
  if (!clock.is_open) return;
  const closeMin = et(Date.parse(clock.next_close) / 1000).min, flatAt = Math.min(RULES.flatMin, closeMin - 10), lastEntry = Math.min(RULES.lastEntryMin, closeMin - 30); // half days close at 1pm
  if (M.day !== today) {
    if (M.day) { M.days.push({ d: M.day, start: M.dayStartEq, end: eq, ret: r4(eq / M.dayStartEq - 1) }); M.days = M.days.slice(-250); }
    M.day = today; M.dayStartEq = +acct.last_equity || eq; M.locked = null; M.shadow = {}; say(M, 'new day', `account $${eq.toFixed(0)}`);
  }
  // 1) pending orders: record fills, cancel stale ones
  for (const o of [...M.orders]) {
    const s = await T(`/orders/${o.id}`), done = () => (M.orders = M.orders.filter((x) => x.id !== o.id));
    if (s.status === 'filled') {
      const fill = +s.filled_avg_price, qty = +s.filled_qty, slip = o.kind === 'buy' ? fill / o.mid - 1 : 1 - fill / o.mid;
      M.slips.push(r4(slip)); M.slips = M.slips.slice(-500); done();
      if (o.kind === 'buy') { M.open[o.sym] = { sym: o.sym, under: o.under, side: o.side, bot: o.bot, qty, entry: fill, at: Date.now(), why: o.why, last: fill }; say(M, 'filled buy', `${qty}x ${o.sym} @ $${fill.toFixed(2)} (mid was $${o.mid.toFixed(2)})`); }
      else {
        const p = M.open[o.sym]; if (!p) continue;
        const pnl = (fill - p.entry) * qty * 100, pct = fill / p.entry - 1;
        M.trades.unshift({ sym: o.sym, under: p.under, side: p.side > 0 ? 'call' : 'put', bot: p.bot, qty, entry: p.entry, exit: fill, pct: r4(pct * 100), pnl: r2(pnl), in: p.at, out: Date.now(), why: o.why }); M.trades = M.trades.slice(0, 200);
        say(M, pnl >= 0 ? 'win' : 'loss', `${o.sym} ${(pct * 100).toFixed(1)}% · $${pnl.toFixed(2)} · ${o.why}`, { pnl: r2(pnl) });
        p.qty -= qty; if (p.qty <= 0) delete M.open[o.sym];
      }
    } else if (['canceled', 'expired', 'rejected'].includes(s.status)) { done(); if (o.kind === 'sell' && M.open[o.sym]) M.open[o.sym].retry = true; say(M, 'order ' + s.status, o.sym); }
    else if (Date.now() - o.at > RULES.orderTtlSec * 1000) { try { await T(`/orders/${o.id}`, { method: 'DELETE' }); } catch {} say(M, 'cancel', `${o.sym} not filled in ${RULES.orderTtlSec}s`); }
  }
  // 2) signals from our engine (shadow bots on 1-minute bars)
  const data = await yahooAll(UNDER, '2d'), sess = {}, prev = {}, last = {};
  for (const s of UNDER) { const d = data[s]; if (!d?.bars) continue; const days = splitDays(d.bars), keys = [...days.keys()], k = keys.indexOf(today); sess[s] = (days.get(today) || []).filter((x) => x.t + 60 <= nowS); prev[s] = hlc(days.get(keys[k > 0 ? k - 1 : keys.length - 2])); last[s] = d.meta.regularMarketPrice; }
  if (M.spy0 == null && last.SPY) M.spy0 = last.SPY; M.lastSpy = last.SPY ?? M.lastSpy;
  const er = moodSeries(sess.SPY || []), entries = [], exits = new Set();
  for (const b of BOTS) {
    const bars = sess[b.sym]; if (!bars?.length) continue;
    M.shadow[b.id] ||= newBotDay(today);
    stepBars(M.shadow[b.id], b, bars, indicators(bars), { closeMin, prev: prev[b.sym], er, open: bars[0].o }, CFG, {
      open: (p) => { if (nowS - p.at <= RULES.signalMaxAgeSec) entries.push({ bot: b, side: p.side, why: p.why, px: p.entry }); },
      close: (tr) => { if (nowS - tr.out <= RULES.signalMaxAgeSec) exits.add(b.id); },
    });
  }
  // 3) exits: option stop/target, the bot's own exit signal, end of day, daily lock
  const held = Object.values(M.open), q = await quotes(held.map((p) => p.sym));
  const dayRet = eq / M.dayStartEq - 1;
  if (!M.locked && (dayRet >= RULES.lockUp || dayRet <= RULES.lockDown)) { M.locked = dayRet > 0 ? 'profit lock' : 'loss limit'; say(M, M.locked, `${(dayRet * 100).toFixed(1)}% today, done until tomorrow`); }
  for (const p of held) {
    const x = q[p.sym]; if (!x || !x.bp) continue;
    const mid = (x.bp + x.ap) / 2; p.last = mid; const ret = mid / p.entry - 1;
    if (M.orders.some((o) => o.sym === p.sym && o.kind === 'sell')) continue;
    const why = ret <= RULES.stop ? 'option stop (-40%)' : ret >= RULES.target ? 'option target (+60%)' : m >= flatAt ? 'end of day' : M.locked ? M.locked : exits.has(p.bot) ? 'bot exit signal' : null;
    if (!why) continue;
    const aggressive = p.retry || m >= flatAt || why.includes('stop');
    await placeLimit(M, { kind: 'sell', sym: p.sym, under: p.under, side: p.side, bot: p.bot, qty: p.qty, limit: aggressive ? x.bp : r2(mid), mid, bid: x.bp, ask: x.ap, why });
  }
  // 4) entries
  if (!entries.length) return;
  const exp = await nextTradingDay(today);
  for (const e of entries) {
    const busy = Object.keys(M.open).length + M.orders.filter((o) => o.kind === 'buy').length;
    const skip = M.locked ? M.locked : m >= lastEntry ? 'too late in the day' : busy >= RULES.maxOpen ? `already ${RULES.maxOpen} open` : null;
    if (skip) { say(M, 'skip', `${e.bot.name} ${e.side > 0 ? 'call' : 'put'} signal: ${skip}`); continue; }
    const c = await pickContract(e.bot.sym, e.side, last[e.bot.sym] || e.px, exp);
    if (!c) { say(M, 'skip', `no ${exp} contract found for ${e.bot.sym}`); continue; }
    const x = (await quotes([c.symbol]))[c.symbol];
    if (!x?.bp || !x?.ap) { say(M, 'skip', `no quote for ${c.symbol}`); continue; }
    const mid = (x.bp + x.ap) / 2; M.spreads.push(r4((x.ap - x.bp) / mid)); M.spreads = M.spreads.slice(-500);
    const qty = Math.floor((RULES.perTrade * eq) / (mid * 100));
    if (qty < 1) { say(M, 'skip', `${c.symbol} too expensive for 5% of the account`); continue; }
    await placeLimit(M, { kind: 'buy', sym: c.symbol, under: e.bot.sym, side: e.side, bot: e.bot.id, qty, limit: r2(mid), mid, bid: x.bp, ask: x.ap, why: `${e.bot.name}: ${e.why}` });
  }
}
export function mirrorView(M) {
  if (!M) return null;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { startedAt: M.startedAt, startEq: M.startEq, equity: M.lastEq, total: M.startEq ? r4(M.lastEq / M.startEq - 1) : 0, today: M.dayStartEq ? r4(M.lastEq / M.dayStartEq - 1) : 0,
    spy: M.spy0 && M.lastSpy ? r4(M.lastSpy / M.spy0 - 1) : null, locked: M.locked, err: M.err, rules: RULES,
    open: Object.values(M.open).map((p) => ({ sym: p.sym, under: p.under, side: p.side > 0 ? 'call' : 'put', qty: p.qty, entry: p.entry, last: r2(p.last), pct: r4((p.last / p.entry - 1) * 100), why: p.why })),
    trades: M.trades.slice(0, 30), log: M.log.slice(0, 40), days: M.days.slice(-10), n: M.trades.length, wins: M.trades.filter((t) => t.pnl > 0).length,
    avgSpread: avg(M.spreads), avgSlip: avg(M.slips) };
}
