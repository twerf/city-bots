# City bots

Five practice trading bots on real market prices (Yahoo 1-minute bars) with fake money: $20 to start, $4 per bot. No AI, no broker, no keys. They can't place real orders.

- Bots: QQQ / SPY / IWM trend, QQQ opening-range breakout ("OG"), QQQ RSI fade. Rules are in `city.mjs` (`STRATS`).
- Up bet / down bet = fractional ETF position, no leverage (stand-in for a call / put).
- Daily: trades 9:30-4:00 ET, flat 5 min before the close, +2% profit lock / -3% loss limit per bot.
- Runs on GitHub Actions (`.github/workflows/run.yml`): hourly weekday triggers, each run trades up to ~5h45m and hands off to the next.
- State: `live` branch (`state.json` full engine state, `city.json` what the VideoDash City tab reads). It's force-pushed as a single commit so history doesn't grow.
- Reset: write `{"at": <ms timestamp>}` to `reset.json` on `main` (the City tab's Reset button does this).
- Backtest locally: `node city.mjs --backtest`
