# City bots

Five practice trading bots on real market prices (Yahoo 1-minute bars) with fake money: $20 to start. No AI, no broker, no keys. They can't place real orders.

- Bots: 17 tickers (index ETFs, sector ETFs, big tech stocks) x 3 strategies (trend, opening-range "OG", RSI fade) = 51 bots. Rules in `city.mjs` (`STRATS`).
- Adaptive: every bot trades every day in practice mode to build a record. Each morning they're ranked on the last 10 sessions (average daily return, shrunk toward 0 when there's little history) and the money pool goes to the top 8, weighted by rank (#1 gets 8 shares, #8 gets 1). A fresh or reset city warms up by replaying the last ~6 sessions first.
- Up bet / down bet = fractional ETF position, no leverage (stand-in for a call / put).
- Daily: trades 9:30-4:00 ET, flat 5 min before the close, +2% profit lock / -3% loss limit per bot.
- Runs on GitHub Actions (`.github/workflows/run.yml`): hourly weekday triggers, each run trades up to ~5h45m and hands off to the next.
- State: `live` branch (`state.json` full engine state, `city.json` what the VideoDash City tab reads). It's force-pushed as a single commit so history doesn't grow.
- Reset: write `{"at": <ms timestamp>}` to `reset.json` on `main` (the City tab's Reset button does this).
- Backtest locally: `node city.mjs --backtest`
