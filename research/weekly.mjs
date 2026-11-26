// Weekly report card (Fridays after the close, .github/workflows/weekly.yml):
// 1) live paper results vs what the replay engine predicts for the same days
// 2) re-run the research on all data so far (archive + Yahoo)
// 3) post a short plain-words summary to Discord (DISCORD_WEBHOOK secret). Suggests changes, never ships them.
//   node research/weekly.mjs [--dry] [--state path/to/state.json]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SHIPPED, BASE_CFG, VERSION } from '../city.mjs';
import { load } from './data.mjs';
import { buildDays, runCfg, portfolio, evenSplit, growth, maxDD, spyHold, WARM, TOGGLES, apply } from './lab.mjs';
import { pAboveZero } from './stats.mjs';

const dry = process.argv.includes('--dry'), si = process.argv.indexOf('--state');
const P = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(2) + '%';
const usd = (x) => '$' + x.toFixed(2);

// ---- live state
let S = null;
try { S = JSON.parse(si > 0 ? fs.readFileSync(process.argv[si + 1], 'utf8') : execFileSync('git', ['show', 'origin/live:state.json'], { encoding: 'utf8', maxBuffer: 64e6 })); } catch (e) { console.log('no live state:', e.message); }
const liveDays = (S?.v === VERSION ? S.days || [] : []).filter((x) => Date.parse(x.d) >= Date.now() - 8 * 86400e3);

// ---- data
const D1 = buildDays(load('1m'), 1, 300), D5 = buildDays(load('5m'), 5, 60).filter((x) => x.d < D1[0].d);
const idx = Object.fromEntries(D1.map((x, i) => [x.d, i]));
const evalP = (cfg, D, tag) => portfolio(runCfg(cfg, D, tag), cfg.fund, WARM, D.length, D);

// 1) live vs predicted
const predAll = evalP(SHIPPED, D1, '1m'), pred = {};
predAll.forEach((r, k) => (pred[D1[WARM + k].d] = r));
const rows = liveDays.map((x) => ({ d: x.d, live: x.ret, pred: pred[x.d] ?? null }));
const lw = growth(rows.map((r) => r.live)), pw = growth(rows.filter((r) => r.pred != null).map((r) => r.pred));
const gap = rows.filter((r) => r.pred != null).map((r) => Math.abs(r.live - r.pred));
const avgGap = gap.length ? gap.reduce((a, x) => a + x, 0) / gap.length : null;

// 2) research on everything so far
const cur1 = evalP(SHIPPED, D1, '1m'), cur5 = evalP(SHIPPED, D5, '5m');
const ev1 = evenSplit(runCfg(SHIPPED, D1, '1m'), WARM, D1.length), spy1 = spyHold(D1, WARM, D1.length), spy5 = spyHold(D5, WARM, D5.length);
const ideas = [];
for (const n of Object.keys(TOGGLES)) {
  const cfg = apply(SHIPPED, n);
  if (!cfg.strats.length || JSON.stringify(cfg) === JSON.stringify(SHIPPED)) continue;
  const a = evalP(cfg, D1, '1m'), b = evalP(cfg, D5, '5m');
  const d1 = growth(a) - growth(cur1), d5 = growth(b) - growth(cur5);
  if (d1 > 0.003 && d5 > 0 && pAboveZero(a) >= 0.8) ideas.push({ n, d1, d5, luck: pAboveZero(a) });
}
ideas.sort((x, y) => y.d1 - x.d1);

// 3) message
const L = [];
L.push(`**City bots weekly report card** (practice money, ${new Date().toISOString().slice(0, 10)})`);
if (!rows.length) L.push('No live trading days this week yet (bots may have just restarted, or the market was closed).');
else {
  L.push(`**This week live:** ${P(lw)} over ${rows.length} day${rows.length > 1 ? 's' : ''}. Balance now ${usd(S.days.at(-1).end + 0)}.`);
  L.push(`**Replay predicted:** ${P(pw)} for the same days.${avgGap != null ? ` Average daily difference ${P(avgGap).replace('+', '')}.` : ''} ${avgGap == null ? '' : avgGap < 0.002 ? 'Live matches the backtest well.' : avgGap < 0.006 ? 'Some drift (missed minutes or late GitHub runs).' : 'Big drift: live is not behaving like the backtest, worth a look.'}`);
  L.push(rows.map((r) => `\`${r.d}\` live ${P(r.live)} · predicted ${r.pred == null ? 'n/a' : P(r.pred)}`).join('\n'));
}
// mirror lane (Alpaca paper options)
let MS = null; try { MS = JSON.parse(execFileSync('git', ['show', 'origin/live:mirror.json'], { encoding: 'utf8', maxBuffer: 64e6 })); } catch {}
if (MS?.startEq) {
  const md = (MS.days || []).filter((x) => Date.parse(x.d) >= Date.now() - 8 * 86400e3), mt = (MS.trades || []).filter((t) => t.out >= Date.now() - 8 * 86400e3);
  const avg = (a) => (a?.length ? a.reduce((x, y) => x + y, 0) / a.length : null), allDays = (MS.days || []).map((x) => x.ret);
  L.push(`**Mirror lane** (1-day options on Alpaca paper, fake $100k): this week ${P(growth(md.map((x) => x.ret)))}, ${mt.length} trades (${mt.filter((t) => t.pnl > 0).length} wins). Since start ${P(MS.lastEq / MS.startEq - 1)}${MS.spy0 && MS.lastSpy ? ` vs SPY ${P(MS.lastSpy / MS.spy0 - 1)}` : ''}. Avg bid/ask spread ${avg(MS.spreads) == null ? 'n/a' : (avg(MS.spreads) * 100).toFixed(1) + '%'}, avg fill vs mid ${avg(MS.slips) == null ? 'n/a' : P(avg(MS.slips))}. Luck check ${allDays.length >= 5 ? Math.round(pAboveZero(allDays) * 100) + '%' : 'needs 5+ days'}.`);
}
L.push(`**All data so far** (${D1.length} days of 1-min + ${D5.length} older 5-min days, fees included):`);
L.push(`- 1-min days: bots ${P(growth(cur1))} (luck check ${Math.round(pAboveZero(cur1) * 100)}%), even split ${P(growth(ev1))}, hold SPY ${P(spy1)}, worst drop ${P(maxDD(cur1))}`);
L.push(`- older days: bots ${P(growth(cur5))} (luck check ${Math.round(pAboveZero(cur5) * 100)}%), hold SPY ${P(spy5)}`);
const beatSpy = growth(cur1) > spy1 && growth(cur5) > spy5, lucky = pAboveZero(cur1) < 0.8;
L.push(`**Honest read:** ${lucky ? 'still can\'t tell this apart from luck' : 'starting to look like more than luck'}${beatSpy ? ', and it beat just holding SPY on both data sets.' : ', and just holding SPY did better on at least one data set.'}`);
L.push(ideas.length ? `**Suggestions (not shipped, ask Fernandis to test):** ${ideas.slice(0, 3).map((i) => `${i.n} (+${(i.d1 * 100).toFixed(1)}% on 1-min days, +${(i.d5 * 100).toFixed(1)}% on older days, luck ${Math.round(i.luck * 100)}%)`).join('; ')}` : '**Suggestions:** none. No single tweak beat the current bots on both data sets with a solid luck check.');
let msg = L.join('\n');
if (msg.length > 1950) msg = msg.slice(0, 1940) + '…';
console.log(msg);

if (!dry) {
  const hook = process.env.DISCORD_WEBHOOK;
  if (!hook) { console.log('DISCORD_WEBHOOK not set, not posting'); process.exit(0); }
  const r = await fetch(hook + '?wait=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: msg, flags: 4, username: 'City bots' }) });
  console.log('posted:', r.status);
  if (!r.ok) process.exit(1);
}
