"""Fetch recent trading livestream replays + their auto-captions (with timestamps) for the streamer scorecard.
usage: python research/streams/fetch.py [--per 6]
Writes research/streams/raw/<video_id>.json = {id, channel, title, start (unix), duration, words: [[sec_offset, text], ...]}
"""
import json, os, subprocess, sys, glob, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw'); os.makedirs(RAW, exist_ok=True)
CHANNELS = {
    'Live SPY Trading': 'https://www.youtube.com/channel/UCsIfX9-JIcvaY3cC6hHu46Q/streams',
    'Adam Options': 'https://www.youtube.com/channel/UCXtmQTNzndZxh49PwnGpJ8g/streams',
    'Hamed Trades': 'https://www.youtube.com/channel/UCBA31ZLZZe_ywAaPXATsZoA/streams',
    'SmartAction Trading': 'https://www.youtube.com/channel/UCh1OFXIchv4AF22btkeoXhg/streams',
    'TraderTV Live': 'https://www.youtube.com/channel/UCn75vF3UxwWeWPAY4-5Z6HQ/streams',
}
PER = int(sys.argv[sys.argv.index('--per') + 1]) if '--per' in sys.argv else 6
NODE = shutil.which('node')
YT = [sys.executable, '-m', 'yt_dlp', '--js-runtimes', f'node:{NODE}', '--no-warnings']

def run(args, timeout=600):
    return subprocess.run(YT + args, capture_output=True, text=True, timeout=timeout, encoding='utf-8', errors='replace')

for ch, url in CHANNELS.items():
    ids = [l.split(' | ')[0] for l in run(['--flat-playlist', '--playlist-end', str(PER * 2), '--print', '%(id)s | %(live_status)s', url]).stdout.splitlines() if 'was_live' in l][:PER]
    for vid in ids:
        out = os.path.join(RAW, f'{vid}.json')
        if os.path.exists(out): continue
        meta = run(['--skip-download', '--print', '%(release_timestamp)s|%(timestamp)s|%(duration)s|%(title)s', f'https://www.youtube.com/watch?v={vid}']).stdout.strip().split('|', 3)
        if len(meta) < 4: print('skip (no meta)', vid); continue
        start = meta[0] if meta[0] not in ('NA', 'None', '') else meta[1]
        base = os.path.join(RAW, f'tmp_{vid}')
        run(['--skip-download', '--write-auto-subs', '--sub-langs', 'en', '--sub-format', 'json3', '-o', base, f'https://www.youtube.com/watch?v={vid}'], timeout=900)
        f = next(iter(glob.glob(base + '*.json3')), None)
        if not f: print('skip (no captions)', ch, vid); continue
        ev = json.load(open(f, encoding='utf-8')).get('events', [])
        words = []
        for e in ev:
            t = e.get('tStartMs', 0) / 1000
            txt = ''.join(s.get('utf8', '') for s in e.get('segs', []) or []).replace('\n', ' ').strip()
            if txt: words.append([round(t, 1), txt])
        os.remove(f)
        json.dump({'id': vid, 'channel': ch, 'title': meta[3], 'start': int(float(start)) if start not in ('NA', 'None', '') else None, 'duration': meta[2], 'words': words}, open(out, 'w', encoding='utf-8'))
        print('saved', ch, vid, meta[3][:60], len(words), 'caption lines')
