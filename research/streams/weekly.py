"""Weekly streamer leaderboard (no AI): fetch the week's replays, find calls with rules, score them, keep a running
leaderboard in research/streams/leaderboard.json and write a short Discord-ready summary to research/streams/week.txt.
usage: python research/streams/weekly.py
"""
import json, os, subprocess, sys, statistics as st, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); PY = sys.executable
run = lambda *a: subprocess.run([PY, os.path.join(HERE, a[0]), *a[1:]], check=False)
run('fetch.py', '--per', '6')
run('extract.py', '--days', '7')
run('score.py', '--file', 'calls_auto.json', '--out', 'scored_week.json', '--quiet')
week = json.load(open(os.path.join(HERE, 'scored_week.json'), encoding='utf-8'))
LB = os.path.join(HERE, 'leaderboard.json')
lb = json.load(open(LB, encoding='utf-8')) if os.path.exists(LB) else {'calls': []}
seen = {(c['video'], c['time'], c['sym']) for c in lb['calls']}
lb['calls'] += [c for c in week if (c['video'], c['time'], c['sym']) not in seen]
lb['updated'] = datetime.date.today().isoformat()
json.dump(lb, open(LB, 'w', encoding='utf-8'), indent=1)

def line(rs):
    if not rs: return None
    h = sum(r['60m'] > 0 for r in rs)
    return f"{h}/{len(rs)} right after 1h ({round(100 * h / len(rs))}%), avg {st.mean(r['60m']):+.2f}%"
chans = sorted({c['channel'] for c in lb['calls']})
out = ['**Streamer leaderboard** (rule-based, no AI: host calls like "I\'ll take Tesla puts", scored on the stock 1 hour later)']
rank = []
for ch in chans:
    allc = [c for c in lb['calls'] if c['channel'] == ch]; wk = [c for c in week if c['channel'] == ch]
    rank.append((sum(r['60m'] > 0 for r in allc) / len(allc), ch, allc, wk))
for hit, ch, allc, wk in sorted(rank, reverse=True):
    out.append(f"- {ch}: this week {line(wk) or 'no calls caught'} · all-time {line(allc)}{' (too few to judge)' if len(allc) < 30 else ''}")
out.append('A coin flip is 50%. Under 30 calls means it could easily be luck.')
open(os.path.join(HERE, 'week.txt'), 'w', encoding='utf-8').write('\n'.join(out))
print('\n'.join(out))
