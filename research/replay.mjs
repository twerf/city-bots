// Month replay: $20 through every day with the shipped settings vs the old (v2 + costs) bots, both datasets.
//   node research/replay.mjs
import { SHIPPED, BASE_CFG } from '../city.mjs';
import { load } from './data.mjs';
import { buildDays, runCfg, portfolio, evenSplit, maxDD, WARM } from './lab.mjs';
const D1 = buildDays(load('1m'), 1, 300), D5 = buildDays(load('5m'), 5, 60).filter((x) => x.d < D1[0].d);
for (const [name, D, tag] of [['1-minute month (ideas were picked here)', D1, '1m'], ['older 5-minute days (never tuned on)', D5, '5m']]) {
  const eq = (cfg) => { let v = 20; return portfolio(runCfg(cfg, D, tag), cfg.fund, WARM, D.length).map((r) => (v *= 1 + r)); };
  const a = eq(BASE_CFG), b = eq(SHIPPED), ev = evenSplit(runCfg(BASE_CFG, D, tag), WARM, D.length).reduce((v, r) => v * (1 + r), 20), spy = 20 * D.at(-1).spyClose / D[WARM].spyOpen;
  console.log(`\n${name}: ${D[WARM].d} .. ${D.at(-1).d} (${D.length - WARM} days)`);
  console.log(`  old bots $20 -> $${a.at(-1).toFixed(2)} (low $${Math.min(20, ...a).toFixed(2)}, high $${Math.max(20, ...a).toFixed(2)})`);
  console.log(`  new bots $20 -> $${b.at(-1).toFixed(2)} (low $${Math.min(20, ...b).toFixed(2)}, high $${Math.max(20, ...b).toFixed(2)})`);
  console.log(`  even split of old bots $${ev.toFixed(2)} | hold SPY $${spy.toFixed(2)}`);
}
