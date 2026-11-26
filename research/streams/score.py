"""Score streamer calls against real 1-minute prices (enter at the next minute's open, judge the stock move at
+15m, +60m and the close, in the called direction).
usage: python research/streams/score.py [--file calls.json] [--out scored.json] [--quiet]
Uses research/cache/<SYM>_1m.json when present, else pulls the last 8 days of 1-minute bars from Yahoo.
"""
import json, os, sys, datetime, zoneinfo, statistics as st, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); CACHE = os.path.join(HERE, '..', 'cache')
ET = zoneinfo.ZoneInfo('America/New_York')
arg = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
calls = json.load(open(os.path.join(HERE, arg('--file', 'calls.json')), encoding='utf-8'))
bars = {}
def load(sym):
    f = os.path.join(CACHE, f'{sym}_1m.json')
    if os.path.exists(f): return json.load(open(f))
    req = urllib.request.Request(f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&range=8d&includePrePost=false', headers={'User-Agent': 'Mozilla/5.0'})
    j = json.load(urllib.request.urlopen(req, timeout=30))['chart']['result'][0]; q = j['indicators']['quote'][0]
    return [{'t': t, 'o': q['open'][i], 'c': q['close'][i]} for i, t in enumerate(j.get('timestamp') or []) if q['close'][i] is not None and q['open'][i] is not None]
def px(sym, day, hhmm, plus):
    if sym not in bars: bars[sym] = load(sym)
    same = [b for b in bars[sym] if datetime.datetime.fromtimestamp(b['t'], ET).strftime('%Y-%m-%d') == day]
    if not same: return None
    if plus == 'close': return same[-1]['c']
    t0 = int(datetime.datetime.strptime(f'{day} {hhmm}', '%Y-%m-%d %H:%M').replace(tzinfo=ET).timestamp()) + plus * 60
    after = [b for b in same if b['t'] >= t0]
    return after[0]['o'] if after else same[-1]['c']
rows = []
for c in calls:
    try: e = px(c['sym'], c['day'], c['time'], 1)
    except Exception as ex: print('no data', c['sym'], ex); continue
    if not e: continue
    r = {k: c['dir'] * (px(c['sym'], c['day'], c['time'], m) / e - 1) for k, m in (('15m', 16), ('60m', 61), ('close', 'close'))}
    rows.append({**c, **{k: round(v * 100, 3) for k, v in r.items()}})
json.dump(rows, open(os.path.join(HERE, arg('--out', 'scored.json')), 'w', encoding='utf-8'), indent=1)
if '--quiet' not in sys.argv:
    by = {}
    for r in rows: by.setdefault(r['channel'], []).append(r)
    for ch, rs in by.items():
        print(f"\n{ch}: {len(rs)} calls")
        for k in ('15m', '60m', 'close'):
            v = [r[k] for r in rs]; print(f"  after {k:5}: right direction {sum(x > 0 for x in v)}/{len(v)}, avg move {st.mean(v):+.2f}%")
