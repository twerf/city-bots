"""Turn stream captions into candidate trade-call snippets with real clock times (ET) for the scorecard.
usage: python research/streams/snippets.py  -> research/streams/snippets/<channel>.txt (one numbered snippet per line)
"""
import json, os, re, glob, datetime, zoneinfo

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'snippets'); os.makedirs(OUT, exist_ok=True)
ET = zoneinfo.ZoneInfo('America/New_York')
TICK = re.compile(r"\b(spy|spx|qqq|queues|cues|iwm|nvda|nvidia|tsla|tesla|aapl|apple|amd|meta|amzn|amazon|msft|microsoft|es|nq|s&p|nasdaq|googl|google|pltr|palantir|mu|micron|coin|smci|avgo|broadcom|nflx|netflix)\b", re.I)
ACT = re.compile(r"\b(calls?|puts?|long|short|buy(ing)?|bought|sell(ing)?|sold|entry|enter(ed|ing)?|in at|out at|took|taking|trim(med)?|stop(ped)?|target|profit|loaded|scalp|position)\b", re.I)

by = {}
for f in sorted(glob.glob(os.path.join(HERE, 'raw', '*.json'))):
    j = json.load(open(f, encoding='utf-8'))
    if not j.get('start'): continue
    w = j['words']
    for i, (t, txt) in enumerate(w):
        if not (TICK.search(txt) and ACT.search(txt)): continue
        ctx = ' '.join(x[1] for x in w[max(0, i - 2): i + 3])
        ts = datetime.datetime.fromtimestamp(j['start'] + t, ET)
        if not (9 * 60 + 25 <= ts.hour * 60 + ts.minute <= 16 * 60 + 5): continue  # market hours only
        by.setdefault(j['channel'], []).append((ts.strftime('%Y-%m-%d %H:%M'), j['id'], round(t), re.sub(r'\s+', ' ', ctx)[:400]))
for ch, rows in by.items():
    # drop near-duplicates (same stream, within 20s)
    keep, last = [], {}
    for r in rows:
        if r[1] in last and r[2] - last[r[1]] < 20: continue
        last[r[1]] = r[2]; keep.append(r)
    with open(os.path.join(OUT, re.sub(r'\W+', '_', ch) + '.txt'), 'w', encoding='utf-8') as fh:
        for k, (ts, vid, t, ctx) in enumerate(keep): fh.write(f'{k}\t{ts} ET\t{vid}@{t}s\t{ctx}\n')
    print(ch, len(rows), '->', len(keep), 'snippets')
