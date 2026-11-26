// One-day trial: grade every bot on the sessions before DAY (practice, no money), then hand $20 to the top 8
// and play DAY minute by minute exactly like the live runner would.   node trial.mjs [YYYY-MM-DD]
import { freshState, newDay, stepBot, yahoo, et, SYMS, botEquity, totalEquity, score } from './city.mjs';

const data = {};
await Promise.all(SYMS.map(async (s) => { try { data[s] = (await yahoo(s, '7d')).bars; } catch { data[s] = []; } }));
const days = [...new Set(data.SPY.map((x) => et(x.t).day))];
const DAY = process.argv[2] || days.at(-1), prior = days.filter((d) => d < DAY);
const S = freshState(); S.cash = 0;
const play = (d) => {
  const sess = Object.fromEntries(SYMS.map((s) => [s, data[s].filter((x) => et(x.t).day === d)]));
  newDay(S, d, sess.SPY[0].t);
  const closeMin = et(sess.SPY.at(-1).t).min + 1;
  for (const s of SYMS) if (sess[s].length) for (const b of S.bots.filter((y) => y.sym === s)) stepBot(S, b, sess[s], closeMin);
};
for (const d of prior) play(d);
for (const b of S.bots) { b.trades = []; b.cash = 0; b.alloc = 0; }
S.log = []; S.cash = 20;
play(DAY);
const f = S.bots.filter((b) => b.alloc > 0).sort((a, b) => b.alloc - a.alloc);
console.log(JSON.stringify({ day: DAY, graded: prior, total: totalEquity(S),
  funded: f.map((b) => ({ name: b.name, start: b.alloc, end: botEquity(b), trades: b.trades.slice().reverse().map((t) => `${new Date(t.in * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ${t.side} ${t.pct > 0 ? '+' : ''}${t.pct.toFixed(2)}% (${t.why})`) })),
  bestAll: [...S.bots].sort((a, b) => (b.sv / b.sd) - (a.sv / a.sd)).slice(0, 5).map((b) => [b.name, ((b.sv / b.sd - 1) * 100).toFixed(2)]),
  evenSplit: 20 * S.bots.reduce((a, b) => a + b.sv / b.sd, 0) / S.bots.length,
  spy: (data.SPY.filter((x) => et(x.t).day === DAY).at(-1).c / data.SPY.filter((x) => et(x.t).day === DAY)[0].o - 1) * 100 }, null, 1));
