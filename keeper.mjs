// Keeper: makes the City bots start every trading day without the laptop and without relying on GitHub's cron.
// One keeper job is always alive (or queued): it sleeps until shortly before the next market open, starts run.yml,
// and hands off to the next keeper. It queues its own successor FIRST, so the chain survives even if this job dies.
const REPO = process.env.REPO, GH = `https://api.github.com/repos/${REPO}`;
const H = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'city-keeper' };
const AH = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET };
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const MAX_SLEEP = (+process.env.MAX_SLEEP_MIN || 340) * 60000, LEAD = 12 * 60000;

async function dispatch(wf) { const r = await fetch(`${GH}/actions/workflows/${wf}/dispatches`, { method: 'POST', headers: H, body: JSON.stringify({ ref: 'main' }) }); log('dispatch', wf, r.status); return r.ok; }
async function runActive() {
  for (const s of ['in_progress', 'queued']) { const j = await (await fetch(`${GH}/actions/workflows/run.yml/runs?status=${s}&per_page=1`, { headers: H })).json(); if (j.total_count) return true; }
  return false;
}
async function clock() {
  const r = await fetch('https://paper-api.alpaca.markets/v2/clock', { headers: AH });
  if (!r.ok) throw new Error('clock ' + r.status);
  const c = await r.json(); return { open: c.is_open, nextOpen: Date.parse(c.next_open), nextClose: Date.parse(c.next_close) };
}
async function ensureRun(why) { if (await runActive()) log('run already active'); else { log('starting bots:', why); await dispatch('run.yml'); } }

if (process.env.CHAIN !== '0') await dispatch('keeper.yml'); // successor waits in the queue until this job ends
let c; for (let i = 0; i < 5; i++) { try { c = await clock(); break; } catch (e) { log(e.message); await sleep(20000); } }
if (!c) { log('no clock, sleeping an hour and handing off'); await sleep(3600e3); process.exit(0); }
const now = Date.now();
log('market', c.open ? 'OPEN' : 'closed', 'next open', new Date(c.nextOpen).toISOString(), 'next close', new Date(c.nextClose).toISOString());
if (c.open || c.nextOpen - now <= LEAD) {
  await ensureRun(c.open ? 'market is open' : 'opening soon');
  // stay until the close so a crashed run gets restarted, then hand off
  const end = Math.min(now + MAX_SLEEP, c.nextClose + 10 * 60000);
  while (Date.now() < end) { await sleep(Math.min(20 * 60000, end - Date.now())); if (Date.now() < c.nextClose - 15 * 60000) await ensureRun('restart check'); }
} else {
  const wake = Math.min(now + MAX_SLEEP, c.nextOpen - LEAD);
  log('sleeping until', new Date(wake).toISOString());
  await sleep(wake - now);
  if (c.nextOpen - Date.now() <= LEAD + 60000) await ensureRun('opening soon');
}
log('handing off');
