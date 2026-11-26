// Evening job: save today's 1-minute bars for every ticker in UNIVERSE to archive/<day>.json.gz
// (run by .github/workflows/archive.yml after the close; skips holidays / days already saved)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE, yahooAll, splitDays, et } from '../city.mjs';
import { writeArchiveDay } from './data.mjs';

const ARCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'archive');
const data = await yahooAll(UNIVERSE, '1d');
const day = data.SPY?.bars?.length ? et(data.SPY.bars.at(-1).t).day : null;
if (!day) { console.log('no SPY data, nothing to save'); process.exit(0); }
if (day !== et(Date.now() / 1000).day) { console.log('last session is', day, '(not today, market holiday?) - nothing new'); process.exit(0); }
if (fs.existsSync(path.join(ARCH, `${day}.json.gz`))) { console.log(day, 'already archived'); process.exit(0); }
const by = {};
for (const s of UNIVERSE) { const b = data[s]?.bars; if (b?.length) by[s] = splitDays(b).get(day) || []; }
const f = writeArchiveDay(day, by);
console.log('saved', day, Object.values(by).filter((b) => b.length).length, 'tickers', fs.statSync(f).size, 'bytes', 'missing:', UNIVERSE.filter((s) => !by[s]?.length).join(',') || 'none');
