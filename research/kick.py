"""Morning kick for the City bots: GitHub's own cron sometimes never fires, so the laptop starts the run too.
(A duplicate run is harmless: runs queue one at a time and a second one just picks up the saved state.)
Scheduled by Windows Task Scheduler "CityBots morning kick", weekdays 8:15am CT."""
import subprocess, json, urllib.request
GIT = r'C:\Program Files\Git\cmd\git.exe'
out = subprocess.run([GIT, 'credential', 'fill'], input='protocol=https\nhost=github.com\nusername=twerf\n\n', capture_output=True, text=True, cwd=r'C:\Users\matth\Documents\CityBots').stdout
tok = dict(l.split('=', 1) for l in out.splitlines() if '=' in l)['password']
req = urllib.request.Request('https://api.github.com/repos/twerf/city-bots/actions/workflows/run.yml/dispatches', method='POST', data=json.dumps({'ref': 'main'}).encode(),
                             headers={'Authorization': 'Bearer ' + tok, 'Accept': 'application/vnd.github+json', 'User-Agent': 'city-kick'})
print('dispatch', urllib.request.urlopen(req, timeout=30).status)
