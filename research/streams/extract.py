"""Rule-based (no AI) trade-call finder for stream captions.
Looks for the host's own first-person entries: "I'll take Tesla puts", "I'm in the Apple calls", "I'm short Google",
"we're going long SPY", "took Apple to the downside". Misses some calls and misreads a few: it's a rough filter.
usage: python research/streams/extract.py [--days 7]  -> research/streams/calls_auto.json
"""
import json, os, re, glob, datetime, zoneinfo, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ET = zoneinfo.ZoneInfo('America/New_York')
DAYS = int(sys.argv[sys.argv.index('--days') + 1]) if '--days' in sys.argv else 7
NAMES = {
    'spy': 'SPY', 's&p': 'SPY', 'spx': 'SPY', 'qqq': 'QQQ', "q's": 'QQQ', 'qs': 'QQQ', 'queues': 'QQQ', 'cues': 'QQQ', 'nasdaq': 'QQQ', 'iwm': 'IWM', 'small caps': 'IWM', 'small cap': 'IWM',
    'tesla': 'TSLA', 'tsla': 'TSLA', 'nvidia': 'NVDA', 'nvda': 'NVDA', 'apple': 'AAPL', 'aapl': 'AAPL', 'amazon': 'AMZN', 'amzn': 'AMZN', 'microsoft': 'MSFT', 'msft': 'MSFT',
    'meta': 'META', 'amd': 'AMD', 'google': 'GOOGL', 'googl': 'GOOGL', 'netflix': 'NFLX', 'broadcom': 'AVGO', 'avgo': 'AVGO', 'palantir': 'PLTR', 'palanteer': 'PLTR', 'pltr': 'PLTR',
    'micron': 'MU', 'walmart': 'WMT', 'smci': 'SMCI', 'super micro': 'SMCI', 'coinbase': 'COIN', 'coin': 'COIN', 'mstr': 'MSTR', 'microstrategy': 'MSTR', 'oracle': 'ORCL', 'uber': 'UBER',
}
TK = '(' + '|'.join(sorted((re.escape(k) for k in NAMES), key=len, reverse=True)) + ')'
UP, DN = r'(calls?|long|upside)', r'(puts?|short|downside)'
PATS = [
    (rf"\b(?:i'?ll|i will|i'?m (?:going to|gonna)|let me|i'?m gonna) (?:take|buy|grab|go|get|try)\b(?: (?:some|the|a|right))? ?(?:\w+ ){{0,3}}?{TK}\b(?: \w+){{0,3}}? {UP}\b", 1),
    (rf"\b(?:i'?ll|i will|i'?m (?:going to|gonna)|let me|i'?m gonna) (?:take|buy|grab|go|get|try)\b(?: (?:some|the|a|right))? ?(?:\w+ ){{0,3}}?{TK}\b(?: \w+){{0,3}}? {DN}\b", -1),
    (rf"\b(?:i'?m|i am|we'?re) in (?:the |some )?{TK} {UP}\b", 1),
    (rf"\b(?:i'?m|i am|we'?re) in (?:the |some )?{TK} {DN}\b", -1),
    (rf"\b(?:i'?m|i am|we'?re|we are) (?:going |getting )?long (?:the |some )?{TK}\b", 1),
    (rf"\b(?:i'?m|i am|we'?re|we are) (?:going |getting )?short (?:the |some )?{TK}\b", -1),
    (rf"\b(?:took|taking|bought|grabbed) (?:some |the )?{TK}(?: \w+)? (?:calls?|to the upside)\b", 1),
    (rf"\b(?:took|taking|bought|grabbed) (?:some |the )?{TK}(?: \w+)? (?:puts?|to the downside)\b", -1),
    (rf"\bgoing long (?:on )?(?:the )?{TK}\b", 1),
]
PATS = [(re.compile(p, re.I), d) for p, d in PATS]

def find(text):
    for rx, d in PATS:
        m = rx.search(text)
        if m:
            name = next(g for g in m.groups() if g and g.lower() in NAMES)
            return NAMES[name.lower()], d, m.group(0)
    return None

calls, cutoff = [], datetime.datetime.now(ET) - datetime.timedelta(days=DAYS)
for f in sorted(glob.glob(os.path.join(HERE, 'raw', '*.json'))):
    j = json.load(open(f, encoding='utf-8'))
    if not j.get('start'): continue
    w, last = j['words'], {}
    for i, (t, _) in enumerate(w):
        ts = datetime.datetime.fromtimestamp(j['start'] + t, ET)
        if ts < cutoff or not (9 * 60 + 30 <= ts.hour * 60 + ts.minute <= 15 * 60 + 45): continue
        text = ' '.join(x[1] for x in w[i:i + 2]).replace('\u2019', "'")
        hit = find(text)
        if not hit: continue
        sym, d, said = hit
        if sym in last and t - last[sym] < 300: continue  # same ticker within 5 min = same trade
        last[sym] = t
        calls.append({'channel': j['channel'], 'day': ts.strftime('%Y-%m-%d'), 'time': ts.strftime('%H:%M'), 'sym': sym, 'dir': d, 'who': 'host', 'said': said, 'video': j['id']})
json.dump(calls, open(os.path.join(HERE, 'calls_auto.json'), 'w', encoding='utf-8'), indent=1)
print(len(calls), 'calls found')
for c in calls: print(' ', c['channel'][:14], c['day'], c['time'], c['sym'], 'UP' if c['dir'] > 0 else 'DOWN', '|', c['said'])
