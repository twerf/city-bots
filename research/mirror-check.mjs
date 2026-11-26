// End-to-end check of the Alpaca PAPER connection (run by .github/workflows/mirror-check.yml):
// confirms the account is paper, options are enabled, quotes work, then places a tiny far-out-of-the-money
// limit order at $0.01 and cancels it. Prints no keys.
import { assertPaper, quotes } from '../mirror.mjs';

const BASE = 'https://paper-api.alpaca.markets';
const H = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET, 'Content-Type': 'application/json' };
const T = async (p, o = {}) => { const r = await fetch(BASE + '/v2' + p, { ...o, headers: H }); const t = await r.text(); if (!r.ok) throw new Error(`${r.status} ${p.split('?')[0]}: ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null; };
const ok = (m) => console.log('OK  ', m), bad = (m) => { console.log('FAIL', m); process.exitCode = 1; };

if (!process.env.ALPACA_KEY || !process.env.ALPACA_SECRET) { bad('ALPACA_KEY / ALPACA_SECRET secrets are missing'); process.exit(1); }
const a = await assertPaper();
ok(`paper account (number starts with PA), status ${a.status}, equity $${(+a.equity).toFixed(2)}, buying power $${(+a.buying_power).toFixed(2)}`);
const lvl = +(a.options_trading_level ?? a.options_approved_level ?? 0);
lvl >= 2 ? ok(`options level ${lvl} (buying calls/puts needs 2+)`) : bad(`options level ${lvl}: enable options trading (level 2+) in the Alpaca paper dashboard`);
const clock = await T('/clock'); ok(`market ${clock.is_open ? 'OPEN' : 'closed'}, next open ${clock.next_open}`);
const spy = (await (await fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()).chart.result[0].meta.regularMarketPrice;
const today = new Date().toISOString().slice(0, 10), later = new Date(Date.now() + 21 * 86400e3).toISOString().slice(0, 10);
const cs = (await T(`/options/contracts?underlying_symbols=SPY&type=call&expiration_date_gte=${today}&expiration_date_lte=${later}&strike_price_gte=${Math.round(spy * 1.15)}&limit=50`)).option_contracts || [];
if (!cs.length) { bad('no SPY option contracts returned'); process.exit(1); }
const c = cs.sort((x, y) => y.strike_price - x.strike_price)[0];
ok(`option chain works: ${c.symbol} (strike ${c.strike_price}, expires ${c.expiration_date}), SPY at ${spy}`);
try { const q = (await quotes([c.symbol]))[c.symbol]; q ? ok(`option quote works: bid ${q.bp} / ask ${q.ap}`) : bad('no quote returned (market closed quotes may be empty)'); } catch (e) { bad('quote: ' + e.message); }
const o = await T('/orders', { method: 'POST', body: JSON.stringify({ symbol: c.symbol, qty: '1', side: 'buy', type: 'limit', limit_price: '0.01', time_in_force: 'day' }) });
ok(`placed test order ${o.id.slice(0, 8)}… status ${o.status}`);
await new Promise((r) => setTimeout(r, 2000));
await T(`/orders/${o.id}`, { method: 'DELETE' });
await new Promise((r) => setTimeout(r, 2000));
const after = await T(`/orders/${o.id}`);
after.status === 'canceled' ? ok('test order canceled') : bad(`test order status after cancel: ${after.status}`);
