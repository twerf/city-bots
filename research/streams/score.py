"""Score streamer calls against real 1-minute prices.
calls.json: [{channel, day, time (HH:MM ET), sym, dir (+1 up / -1 down), who ('host'|'signal'), said, claim?}]
usage: python research/streams/score.py
"""
import json, os, datetime, zoneinfo, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__)); CACHE = os.path.join(HERE, '..', 'cache')
ET = zoneinfo.ZoneInfo('America/New_York')
calls = json.load(open(os.path.join(HERE, 'calls.json'), encoding='utf-8'))
bars = {}
def px(sym, day, hhmm, plus=0):
    if sym not in bars: bars[sym] = json.load(open(os.path.join(CACHE, f'{sym}_1m.json')))
    t0 = int(datetime.datetime.strptime(f'{day} {hhmm}', '%Y-%m-%d %H:%M').replace(tzinfo=ET).timestamp()) + (plus * 60 if plus != 'close' else 0)
    same = [b for b in bars[sym] if datetime.datetime.fromtimestamp(b['t'], ET).strftime('%Y-%m-%d') == day]
    if plus == 'close': return same[-1]['c']
    after = [b for b in same if b['t'] >= t0]
    return after[0]['o'] if after else same[-1]['c']
rows = []
for c in calls:
    e = px(c['sym'], c['day'], c['time'], 1)  # enter at the next minute's open (you hear it, then you click)
    r = {k: c['dir'] * (px(c['sym'], c['day'], c['time'], m) / e - 1) for k, m in (('15m', 16), ('60m', 61))}
    r['close'] = c['dir'] * (px(c['sym'], c['day'], c['time'], 'close') / e - 1)
    rows.append({**c, **{k: round(v * 100, 3) for k, v in r.items()}})
json.dump(rows, open(os.path.join(HERE, 'scored.json'), 'w'), indent=1)
by = {}
for r in rows: by.setdefault(r['channel'], []).append(r)
for ch, rs in by.items():
    print(f"\n{ch}: {len(rs)} calls")
    for k in ('15m', '60m', 'close'):
        v = [r[k] for r in rs]
        print(f"  after {k:5}: right direction {sum(x > 0 for x in v)}/{len(v)}, avg move {st.mean(v):+.2f}% (stock move, before option leverage)")
    for r in rs: print(f"   {r['day']} {r['time']} {r['sym']:5} {'UP' if r['dir'] > 0 else 'DOWN':4} {r['who']:6} 15m {r['15m']:+.2f}% 60m {r['60m']:+.2f}% close {r['close']:+.2f}%  | {r.get('claim', '')}")
