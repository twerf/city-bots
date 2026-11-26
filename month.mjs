// Month trial: pull ~30 days of real 1-minute bars (Yahoo caps 1m at 30 days, 8 days per request),
// grade the bots on the first WARM sessions with no money, then run $20 through every remaining day.
//   node month.mjs [warmDays=5]
import { freshState, newDay, stepBot, et, SYMS, botEquity, totalEquity } from './city.mjs';

const WARM = +(process.argv[2] || 5);
async function bars30(sym) {
  const out = new Map(), now = Math.floor(Date.now() / 1000);
  for (let end = now; end > now - 29 * 86400; end -= 7 * 86400) {
    const start = Math.max(end - 7 * 86400, now - 29 * 86400);
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&period1=${start}&period2=${end}&includePrePost=false`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) throw new Error(r.status);
        const j = (await r.json()).chart.result[0], q = j.indicators.quote[0];
        (j.timestamp || []).forEach((t, k) => { if (q.close[k] != null && q.high[k] != null) out.set(t, { t, o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k], v: q.volume[k] || 0 }); });
        break;
      } catch (e) { if (i === 2) console.error(sym, 'chunk failed', e.message); await new Promise((r) => setTimeout(r, 1500)); }
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

const data = {}, q = [...SYMS];
await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) { const s = q.shift(); data[s] = await bars30(s); } }));
const days = [...new Set(data.SPY.map((x) => et(x.t).day))].filter((d) => data.SPY.filter((x) => et(x.t).day === d).length > 100);
const S = freshState(); S.cash = 0;
const rows = [];
let even = 20, spy0 = null;
days.forEach((d, i) => {
  if (i === WARM) { for (const b of S.bots) { b.trades = []; } S.cash = 20; }
  const sess = Object.fromEntries(SYMS.map((s) => [s, data[s].filter((x) => et(x.t).day === d)]));
  newDay(S, d, sess.SPY[0].t);
  const before = totalEquity(S), funded = S.bots.filter((b) => b.alloc > 0).sort((a, b) => b.alloc - a.alloc).map((b) => b.name);
  const closeMin = et(sess.SPY.at(-1).t).min + 1;
  for (const s of SYMS) if (sess[s].length) for (const b of S.bots.filter((y) => y.sym === s)) stepBot(S, b, sess[s], closeMin);
  if (i >= WARM) {
    if (spy0 == null) spy0 = sess.SPY[0].o;
    even *= S.bots.reduce((a, b) => a + b.sv / b.sd, 0) / S.bots.length;
    const best = S.bots.filter((b) => b.alloc > 0).sort((a, b) => (botEquity(b) - b.alloc) - (botEquity(a) - a.alloc));
    rows.push({ d, start: before, end: totalEquity(S), even, spy: 20 * sess.SPY.at(-1).c / spy0, top: funded.slice(0, 3), best: best.at(-1)?.name, worst: best[0]?.name });
  }
});
const all = S.bots.flatMap((b) => b.trades.filter((t) => t.real));
console.log(JSON.stringify({ days: days.length, warm: days.slice(0, WARM), rows, trades: all.length, wins: all.filter((t) => t.pnl > 0).length,
  botBest: [...S.bots].sort((a, b) => b.sv - a.sv).slice(0, 5).map((b) => [b.name, ((b.sv - 1) * 100).toFixed(1)]),
  botWorst: [...S.bots].sort((a, b) => a.sv - b.sv).slice(0, 5).map((b) => [b.name, ((b.sv - 1) * 100).toFixed(1)]) }));
