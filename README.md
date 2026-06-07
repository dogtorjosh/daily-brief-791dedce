# Daily Brief — your phone app

A small private web app that shows your morning, evening, and weekly briefs on your phone,
plus a to-do list you can check off. One link, no login screen to fuss with — just a passcode.

**Live link:** https://dogtorjosh.github.io/daily-brief-791dedce/

---

## How it works (plain English)

1. Your scheduled brief tasks write HTML files into `../outputs/{am,eod,weekly}/`.
2. `publish.py` reads those files, pulls out the data, **encrypts it with your passcode**, and
   saves it into `data/`. Then it pushes everything to GitHub.
3. GitHub serves the app at the link above. Your phone opens it, you type your passcode once,
   and it unlocks today's brief. The passcode is remembered on each device after the first time.

Because the data is encrypted, the files living on GitHub are scrambled gibberish to anyone
who doesn't have your passcode — even though the link itself is public.

## Add it to your iPhone home screen

1. Open the live link in **Safari** (not Chrome — only Safari can install web apps on iOS).
2. Tap the **Share** button (the square with an up-arrow).
3. Tap **Add to Home Screen**, then **Add**.
4. You'll get a "Daily Brief" icon. Open it and it runs full-screen like a normal app.

## Your passcode

- It lives in **`secret/passcode.txt`** on your computer only. It is never uploaded to GitHub
  (the `.gitignore` file blocks it).
- **To change it:** open `secret/passcode.txt`, type a new passcode, save. Then run a publish
  (double-click `..\publish-runner.bat`, or wait for the next scheduled run). On your phone,
  you'll be asked for the new passcode next time — open the app, and if it won't unlock, it will
  show the passcode box again. (If it silently fails, clear the site data in Safari settings and
  re-enter.)

## When it updates automatically

A Windows scheduled task called **"DailyBrief - Publish"** runs the publish three times:

- **6:30 AM** daily — after your morning brief
- **6:30 PM** daily — after your end-of-day brief
- **7:00 PM Sunday** — after your weekly brief

Your computer needs to be on and signed in at those times. If it was asleep, the task catches up
when you next sign in.

**To change the times:** open **Task Scheduler** (search for it in the Start menu), find
"DailyBrief - Publish" in the list, and edit its Triggers. Or just ask Claude to change it.

## Running a publish by hand

Double-click **`..\publish-runner.bat`** (one folder up), or in a terminal:

```
cd app
python publish.py
```

Each run writes to `..\publish-log.txt` so you can see what happened.

## Files

| File | What it is |
|------|-----------|
| `index.html`, `styles.css`, `app.js` | The app itself |
| `publish.py` | Builds + encrypts the data and pushes to GitHub |
| `manifest.json`, `sw.js`, `icons/` | Makes it installable + work offline |
| `make_icons.py` | Regenerates the app icon (only if you want to change it) |
| `data/` | The encrypted brief data the app reads |
| `secret/passcode.txt` | Your passcode — **local only, never uploaded** |

Don't edit anything in `../outputs/` — those are your source brief files and the app only reads them.
