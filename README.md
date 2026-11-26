# City bots

Five practice trading bots on real market prices (Yahoo 1-minute bars) with fake money: $20 to start. No AI, no broker, no keys. They can't place real orders.

- Bots: 17 tickers x 5 strategies (opening-range "OG", RSI fade, yesterday high/low breakout, gap fill, VWAP bounce) = 85 bots. Rules in `city.mjs`; live settings = `SHIPPED`. Every trade pays 0.02% slippage + 0.01% fees per side.
- Adaptive: every bot trades every day in practice mode. Each morning bots are ranked on the last 10 sessions (steadiness score) and the money goes to the top 8, rank-weighted. Bots with 3 red days in a row are benched.
- Research: `research/` (data cache, walk-forward lab, cross-check). Results in `research/REPORT.md`.
- Up bet / down bet = fractional ETF position, no leverage (stand-in for a call / put).
- Daily: trades 9:30-4:00 ET, flat 5 min before the close, +2% profit lock / -3% loss limit per bot.
- Runs on GitHub Actions (`.github/workflows/run.yml`): hourly weekday triggers, each run trades up to ~5h45m and hands off to the next.
- State: `live` branch (`state.json` full engine state, `city.json` what the VideoDash City tab reads). It's force-pushed as a single commit so history doesn't grow.
- Reset: write `{"at": <ms timestamp>}` to `reset.json` on `main` (the City tab's Reset button does this).
- Backtest locally: `node city.mjs --backtest` (last ~7 days with live settings)
