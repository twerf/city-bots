// Real bars for research, cached on disk so every test run sees identical data.
// - 1-minute: last ~30 days from Yahoo (its limit, fetched in 7-day chunks) MERGED with archive/ (one gzip file per
//   trading day, written every evening by .github/workflows/archive.yml), so the 1-minute history keeps growing.
// - 5-minute: last ~60 days from Yahoo.
//   node research/data.mjs [--refresh]      node research/data.mjs --seed-archive   (write archive files from the cache)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { UNIVERSE, splitDays } from '../city.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), DIR = path.join(HERE, 'cache'), ARCH = path.join(HERE, '..', 'archive');
const UA = { 'User-Agent': 'Mozilla/5.0' };
const toBars = (j) => { const q = j.indicators.quote[0], out = []; (j.timestamp || []).forEach((t, k) => { if (q.close[k] != null && q.high[k] != null) out.push({ t, o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k], v: q.volume[k] || 0 }); }); return out; };
async function get(url) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status); return (await r.json()).chart.result[0]; } catch (e) { if (i === 3) throw e; await new Promise((r) => setTimeout(r, 2000)); } } }
export async function oneMin(sym, days = 29) {
  const m = new Map(), now = Math.floor(Date.now() / 1000);
  for (let end = now; end > now - days * 86400; end -= 7 * 86400) {
    const start = Math.max(end - 7 * 86400, now - days * 86400);
    for (const b of toBars(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&period1=${start}&period2=${end}&includePrePost=false`))) m.set(b.t, b);
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}
const fiveMin = async (sym) => toBars(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=60d&includePrePost=false`));

// archive format: { day, bars: { SYM: [[t,o,h,l,c,v], ...] } }, gzipped
const pack = (bars) => bars.map((b) => [b.t, +b.o.toFixed(4), +b.h.toFixed(4), +b.l.toFixed(4), +b.c.toFixed(4), b.v]);
const unpack = (a) => a.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
export function writeArchiveDay(day, bySym) {
  fs.mkdirSync(ARCH, { recursive: true });
  const f = path.join(ARCH, `${day}.json.gz`);
  fs.writeFileSync(f, zlib.gzipSync(JSON.stringify({ day, bars: Object.fromEntries(Object.entries(bySym).filter(([, b]) => b?.length).map(([s, b]) => [s, pack(b)])) }), { level: 9 }));
  return f;
}
export function readArchive() {
  if (!fs.existsSync(ARCH)) return {};
  const out = {};
  for (const f of fs.readdirSync(ARCH).filter((x) => x.endsWith('.json.gz')).sort()) {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCH, f))));
    for (const [s, a] of Object.entries(j.bars)) (out[s] ||= []).push(...unpack(a));
  }
  return out;
}
// syms -> { SYM: bars[] }. 1m = archive + cache merged (deduped by timestamp).
export function load(tf, syms = UNIVERSE) {
  const arch = tf === '1m' ? readArchive() : {};
  const out = {};
  for (const s of syms) {
    const f = path.join(DIR, `${s}_${tf}.json`), m = new Map();
    for (const b of arch[s] || []) m.set(b.t, b);
    if (fs.existsSync(f)) for (const b of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(b.t, b);
    if (m.size) out[s] = [...m.values()].sort((a, b) => a.t - b.t);
  }
  return out;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.mkdirSync(DIR, { recursive: true });
  if (process.argv.includes('--seed-archive')) {
    const all = load('1m'), days = new Map();
    for (const [s, bars] of Object.entries(all)) for (const [d, b] of splitDays(bars)) { if (!days.has(d)) days.set(d, {}); days.get(d)[s] = b; }
    for (const [d, by] of days) { if (Object.keys(by).length < 10) continue; const f = writeArchiveDay(d, by); console.log(d, Object.keys(by).length, 'tickers', fs.statSync(f).size, 'bytes'); }
  } else {
    const refresh = process.argv.includes('--refresh'), q = [...UNIVERSE];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (q.length) {
        const s = q.shift();
        for (const [tf, fn] of [['1m', oneMin], ['5m', fiveMin]]) {
          const f = path.join(DIR, `${s}_${tf}.json`);
          if (!refresh && fs.existsSync(f)) continue;
          try { const bars = await fn(s); fs.writeFileSync(f, JSON.stringify(bars)); console.log(s, tf, bars.length); } catch (e) { console.log(s, tf, 'FAILED', e.message); }
        }
      }
    }));
  }
}
