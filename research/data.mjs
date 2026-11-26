// Pull and cache real bars for every ticker: 1-minute (last ~30 days, Yahoo's limit, 7-day chunks) and
// 5-minute (last ~60 days). Cached in research/cache/ so every test run sees identical data.
//   node research/data.mjs          fetch if missing     node research/data.mjs --refresh   re-fetch
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMS } from '../city.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache');
const UA = { 'User-Agent': 'Mozilla/5.0' };
const toBars = (j) => { const q = j.indicators.quote[0], out = []; (j.timestamp || []).forEach((t, k) => { if (q.close[k] != null && q.high[k] != null) out.push({ t, o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k], v: q.volume[k] || 0 }); }); return out; };
async function get(url) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status); return (await r.json()).chart.result[0]; } catch (e) { if (i === 3) throw e; await new Promise((r) => setTimeout(r, 2000)); } } }

async function oneMin(sym) {
  const m = new Map(), now = Math.floor(Date.now() / 1000);
  for (let end = now; end > now - 29 * 86400; end -= 7 * 86400) {
    const start = Math.max(end - 7 * 86400, now - 29 * 86400);
    for (const b of toBars(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&period1=${start}&period2=${end}&includePrePost=false`))) m.set(b.t, b);
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}
const fiveMin = async (sym) => toBars(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=60d&includePrePost=false`));

export function load(tf) { return Object.fromEntries(SYMS.map((s) => [s, JSON.parse(fs.readFileSync(path.join(DIR, `${s}_${tf}.json`), 'utf8'))])); }

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.mkdirSync(DIR, { recursive: true });
  const refresh = process.argv.includes('--refresh'), q = [...SYMS];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (q.length) {
      const s = q.shift();
      for (const [tf, fn] of [['1m', oneMin], ['5m', fiveMin]]) {
        const f = path.join(DIR, `${s}_${tf}.json`);
        if (!refresh && fs.existsSync(f)) continue;
        const bars = await fn(s); fs.writeFileSync(f, JSON.stringify(bars));
        console.log(s, tf, bars.length, 'bars');
      }
    }
  }));
}
