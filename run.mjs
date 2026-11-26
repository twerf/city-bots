// GitHub Actions runner for the City bots. One run covers up to MAX_MIN minutes of a trading day,
// then hands off to the next scheduled run (state on the `live` branch). Fake money only.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { freshState, publicView, tick, warmup, totalEquity, VERSION, SHIPPED } from './city.mjs';
import { mirrorEnabled, mirrorTick, mirrorView, freshMirror, alpacaSnapshot } from './mirror.mjs';

const REPO = process.env.REPO || 'twerf/city-bots';
const TOKEN = process.env.GITHUB_TOKEN;
const MAX_MS = (+process.env.MAX_MIN || 345) * 60000;
const PRE_OPEN_WAIT_MS = 100 * 60000; // started this early before the open? wait. Earlier than that: exit.
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let S;
try { S = JSON.parse(execFileSync('git', ['show', 'origin/live:state.json'], { encoding: 'utf8', maxBuffer: 64e6 })); if (S.v !== VERSION) throw new Error('old format'); if (S.cfgKey !== JSON.stringify(SHIPPED)) throw new Error('bot settings changed'); log('loaded state, total', totalEquity(S).toFixed(4)); }
catch (e) { S = await fresh('no usable saved state (' + e.message.slice(0, 40) + ')'); }
async function fresh(why) {
  const s = freshState(); log(why, '-> fresh $20, warming up');
  try { log('warmup scored', await warmup(s), 'past sessions'); } catch (e) { log('warmup failed', e.message); }
  return s;
}
const st = { quotes: {}, err: null };
// mirror lane (Alpaca paper options); its own state file on the live branch
let MS = null;
if (mirrorEnabled()) { try { MS = JSON.parse(execFileSync('git', ['show', 'origin/live:mirror.json'], { encoding: 'utf8', maxBuffer: 64e6 })); log('mirror state loaded'); } catch { MS = freshMirror(); log('mirror: fresh state'); } }

async function checkReset() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/reset.json?ref=main&t=${Date.now()}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'city-bots' } });
    if (!r.ok) return;
    const j = await r.json();
    if (j.at && j.at > (S.resetAt || 0)) { S = await fresh('RESET requested ' + new Date(j.at).toISOString()); S.resetAt = j.at; lastSig = ''; }
  } catch (e) { log('reset check failed', e.message); }
}

// force-push a parentless commit to `live` so the branch never grows history
const PUB = 'pub';
var lastSig = '', lastPub = 0;
function publish(force) {
  const view = { ...publicView(S, st), mirror: mirrorView(MS) }, sig = JSON.stringify({ ...view, at: 0 });
  if (!force && sig === lastSig && Date.now() - lastPub < 10 * 60000) return;
  fs.rmSync(PUB, { recursive: true, force: true }); fs.mkdirSync(PUB);
  fs.writeFileSync(`${PUB}/city.json`, JSON.stringify(view));
  fs.writeFileSync(`${PUB}/state.json`, JSON.stringify(S));
  if (MS) fs.writeFileSync(`${PUB}/mirror.json`, JSON.stringify(MS));
  const g = (...a) => execFileSync('git', a, { cwd: PUB, stdio: ['ignore', 'ignore', 'pipe'] });
  g('init', '-q', '-b', 'live'); g('config', 'user.name', 'city-bots'); g('config', 'user.email', 'city-bots@users.noreply.github.com');
  g('add', '.'); g('commit', '-q', '-m', `city ${new Date().toISOString().slice(0, 16)}Z $${view.total.toFixed(4)}`);
  for (let i = 0; i < 3; i++) {
    try { g('push', '-q', '-f', `https://x-access-token:${TOKEN}@github.com/${REPO}.git`, 'live'); lastSig = sig; lastPub = Date.now(); return; }
    catch (e) { log('push failed, retrying', String(e.stderr || e.message).slice(0, 200)); }
  }
}

await checkReset();
let n = 0;
while (true) {
  try { await tick(S, st); st.err = null; }
  catch (e) { st.err = String(e.message).slice(0, 200); log('tick error', st.err); }
  if (MS && st.open) { try { await mirrorTick(MS); MS.err = null; } catch (e) { MS.err = String(e.message).slice(0, 200); log('mirror error', MS.err); } }
  if (MS && (n % 3 === 0 || !st.open)) { try { await alpacaSnapshot(MS); } catch (e) { log('alpaca snapshot failed', String(e.message).slice(0, 150)); } }
  const now = Date.now();
  if (n++ % 5 === 0) await checkReset();
  publish(false);
  if (n % 15 === 1) log(st.open ? 'open' : 'closed', 'total', totalEquity(S).toFixed(4), 'positions', S.bots.filter((b) => b.bs.pos).length, st.err || '');
  const holding = S.bots.some((b) => b.bs.pos) || (MS && Date.now() < (st.closeAt || 0) + 600000 && (Object.keys(MS.open).length > 0 || MS.orders.length > 0));
  if (st.closeAt && now >= st.closeAt + 60000 && !holding) { log('session over'); break; }
  if (st.openAt && now < st.openAt && st.openAt - now > PRE_OPEN_WAIT_MS) { log('too early, next open', new Date(st.openAt).toISOString()); break; }
  if (now - T0 > MAX_MS) { log('time box reached, handing off to the next run'); break; }
  if (st.err && n > 20 && !st.closeAt) { log('cannot reach market data, giving up'); break; }
  await sleep(60000 - (Date.now() % 60000) + 3000); // just after each new 1-minute bar
}
publish(true);
log('done');
