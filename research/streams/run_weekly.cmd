@echo off
rem Weekly streamer leaderboard (no AI). Runs on the laptop because YouTube blocks GitHub's servers.
rem Scheduled by Windows Task Scheduler: Fridays 3:30pm CT, before the 4:15pm CT Discord report card.
cd /d C:\Users\matth\Documents\CityBots
set GIT="C:\Program Files\Git\cmd\git.exe"
set PATH=C:\Program Files\nodejs;%PATH%
%GIT% pull -q --rebase --autostash >> research\streams\task.log 2>&1
"C:\Users\matth\AppData\Local\hermes\tools\python-3.14.9+20261021-win32-x64\python.exe" research\streams\weekly.py >> research\streams\task.log 2>&1
%GIT% add research\streams\leaderboard.json research\streams\week.txt
%GIT% commit -q -m "streamer leaderboard (laptop)" >> research\streams\task.log 2>&1
%GIT% push -q >> research\streams\task.log 2>&1
