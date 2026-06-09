"""
publish.py - the data pipeline for the Daily Brief app.

What it does, every run:
  1. Reads the brief HTML files in ../outputs/{am,eod,weekly}/
  2. Pulls the <script id="brief-data"> JSON island out of each (the source of truth)
  3. Writes clean JSON into ./data/ for the static front end to fetch
  4. Builds a single de-duplicated To-Do feed
  5. Commits and pushes to GitHub (so GitHub Pages serves the fresh data)

It is deliberately resilient: if a brief for today doesn't exist, it falls back to
the most recent file of that kind, records the real date, and never crashes. When it
does fall back, it stamps the data with a staleNotice so the app shows a loud banner
instead of silently serving yesterday's brief.

It NEVER modifies anything in ../outputs/ - those files are read-only source.

Run:  python publish.py
"""

import base64
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("America/New_York")
except Exception:
    TZ = None  # falls back to system local time

PBKDF2_ITER = 200_000  # must match app.js

HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUTS = os.path.normpath(os.path.join(HERE, "..", "outputs"))
DATA = os.path.join(HERE, "data")
os.makedirs(DATA, exist_ok=True)

BRIEF_RE = re.compile(
    r'<script[^>]*id=["\']brief-data["\'][^>]*>(.*?)</script>',
    re.S | re.I,
)
# Date stamp anywhere in a filename: YYYY-MM-DD
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def now_local():
    return datetime.now(TZ) if TZ else datetime.now()


def log(msg):
    print(f"[publish] {msg}")


def extract_json(path):
    """Return the parsed #brief-data object from an HTML file, or None on any problem."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as e:
        log(f"could not read {path}: {e}")
        return None
    m = BRIEF_RE.search(text)
    if not m:
        log(f"no #brief-data block in {os.path.basename(path)}")
        return None
    try:
        return json.loads(m.group(1).strip())
    except json.JSONDecodeError as e:
        log(f"bad JSON in {os.path.basename(path)}: {e}")
        return None


def list_dated_files(subdir):
    """List (date_str, fullpath) for every .html in a subfolder, newest date first."""
    folder = os.path.join(OUTPUTS, subdir)
    out = []
    if not os.path.isdir(folder):
        return out
    for name in os.listdir(folder):
        if not name.lower().endswith(".html"):
            continue
        m = DATE_RE.search(name)
        if not m:
            continue
        out.append((m.group(1), os.path.join(folder, name)))
    out.sort(key=lambda t: t[0], reverse=True)
    return out


def pick(subdir, today_str, want_today=True):
    """Pick today's file if it exists, else the most recent. Return (data, meta) or (None, None)."""
    files = list_dated_files(subdir)
    if not files:
        return None, None
    chosen = None
    if want_today:
        for d, p in files:
            if d == today_str:
                chosen = (d, p)
                break
    if chosen is None:
        chosen = files[0]  # most recent
    date_str, path = chosen
    data = extract_json(path)
    if data is None:
        return None, None
    meta = {
        "date": data.get("date", date_str),
        "fileDate": date_str,
        "isToday": date_str == today_str,
        "generatedAt": data.get("generatedAt"),
        "source": os.path.basename(path),
    }
    return data, meta


def load_passcode():
    """Read the encryption passcode from a local, gitignored file (or env var).
    The passcode never enters the repo. Returns None if not configured."""
    secret_path = os.path.join(HERE, "secret", "passcode.txt")
    if os.path.isfile(secret_path):
        with open(secret_path, "r", encoding="utf-8") as fh:
            pc = fh.read().strip()
            if pc:
                return pc
    return os.environ.get("DAILY_BRIEF_PASSCODE") or None


def derive_key(passcode, salt):
    return hashlib.pbkdf2_hmac("sha256", passcode.encode("utf-8"), salt, PBKDF2_ITER, 32)


def encrypt_obj(obj, key, salt):
    """Return an AES-256-GCM envelope the browser (Web Crypto) can decrypt."""
    plaintext = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plaintext, None)  # ciphertext + 16-byte tag
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return {"v": 1, "iter": PBKDF2_ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def make_writer():
    """Return (write_fn, encrypted_bool). If a passcode is set, write_fn encrypts;
    otherwise it writes plain JSON and warns."""
    passcode = load_passcode()
    if passcode:
        salt = os.urandom(16)
        key = derive_key(passcode, salt)

        def write_fn(name, obj):
            path = os.path.join(DATA, name)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(encrypt_obj(obj, key, salt), fh)
            log(f"wrote data/{name} (encrypted)")

        return write_fn, True

    log("WARNING: no passcode configured (secret/passcode.txt) - writing data UNENCRYPTED")

    def write_plain(name, obj):
        path = os.path.join(DATA, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)
        log(f"wrote data/{name}")

    return write_plain, False


def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")
    return s[:80] or "item"


def collect_todos(am, eod, weekly):
    """Gather to-dos from the briefs and de-duplicate by title (case-insensitive)."""
    todos = []
    seen = set()

    def add(item, source):
        title = (item.get("title") or "").strip()
        if not title:
            return
        key = title.lower()
        if key in seen:
            return
        seen.add(key)
        todo = {
            "id": slugify(title),
            "title": title,
            "source": source,
        }
        if item.get("summary"):
            todo["summary"] = item["summary"]
        if item.get("priority"):
            todo["priority"] = item["priority"]
        if item.get("link"):
            todo["link"] = item["link"]
        todos.append(todo)

    def section(data, section_id):
        if not data:
            return []
        for sec in data.get("sections", []):
            if sec.get("id") == section_id:
                return sec.get("items", [])
        return []

    # Order matters for which source label wins on a dup: most actionable first.
    for it in section(eod, "needs-action-today"):
        add(it, "EOD - needs action today")
    for it in section(weekly, "urgent-tasks"):
        add(it, "This week - needs you")
    for it in section(am, "humans-waiting"):
        add(it, "Humans waiting (AM)")
    for it in section(eod, "humans-waiting"):
        add(it, "Humans waiting (EOD)")

    # High priority floats to the top, otherwise keep gather order.
    todos.sort(key=lambda t: 0 if t.get("priority") == "high" else 1)
    return todos


def pretty_date(date_str):
    """'2026-06-08' -> 'Mon, Jun 8'. Falls back to the raw string on any problem."""
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
        return f"{d.strftime('%a')}, {d.strftime('%b')} {d.day}"
    except (ValueError, TypeError):
        return date_str or ""


def flag_if_stale(data, meta, label, due_hour):
    """If a brief should exist for today but doesn't (pick() fell back to an older
    file), stamp the data with a staleNotice so the app shows a loud banner instead
    of silently serving yesterday's. Durable guard - lives here in the pipeline.

    due_hour is the local hour after which today's brief is expected (AM after the
    6 AM run, EOD after the 6 PM run). Before that hour an older file is normal and
    we say nothing - this avoids crying wolf every morning when last night's EOD is
    legitimately the newest one."""
    if not data or not meta or meta.get("isToday") is not False:
        return
    if now_local().hour < due_hour:
        return  # today's brief isn't due yet; an older one is expected
    shown = meta.get("fileDate") or meta.get("date")
    notice = "Today's " + label + " brief didn't generate - showing " \
             + pretty_date(shown) + " instead."
    data["staleNotice"] = {
        "message": "⚠️ " + notice,
        "shownDate": shown,
    }
    log(f"STALE: {label} brief for today is missing; flagged fallback to {shown}")


def git_push():
    """Commit any data changes and push. Returns True on a successful push.
    Skips quietly if this folder isn't a git repo with a remote yet."""
    def git(*args):
        return subprocess.run(
            ["git", *args], cwd=HERE,
            capture_output=True, text=True,
        )

    inside = git("rev-parse", "--is-inside-work-tree")
    if inside.returncode != 0:
        log("not a git repo yet - skipping push (run the GitHub setup once)")
        return False
    has_remote = git("remote").stdout.strip()
    if not has_remote:
        log("no git remote configured yet - skipping push")
        return False

    git("add", "-A")
    status = git("status", "--porcelain").stdout.strip()
    if not status:
        log("no changes to commit - data already current")
        return True

    stamp = now_local().strftime("%Y-%m-%d %H:%M")
    commit = git("commit", "-m", f"Publish briefs {stamp}")
    if commit.returncode != 0:
        log(f"commit failed: {commit.stderr.strip()}")
        return False
    push = git("push")
    if push.returncode != 0:
        log(f"push failed: {push.stderr.strip()}")
        return False
    log("pushed to GitHub")
    return True


def main():
    today = now_local()
    today_str = today.strftime("%Y-%m-%d")
    log(f"local date (America/New_York): {today_str}")

    write, encrypted = make_writer()

    am, am_meta = pick("am", today_str)
    eod, eod_meta = pick("eod", today_str)
    weekly, weekly_meta = pick("weekly", today_str, want_today=False)

    # Guard: if today's AM or EOD brief never wrote a file, pick() falls back to the
    # most recent one. Flag that loudly so the app never silently shows a stale card.
    # AM is due after the 6 AM run; EOD after the 6 PM run.
    flag_if_stale(am, am_meta, "morning", due_hour=6)
    flag_if_stale(eod, eod_meta, "evening", due_hour=18)

    write("today-am.json", am or {"empty": True})
    write("today-eod.json", eod or {"empty": True})
    write("this-week.json", weekly or {"empty": True})

    todos = collect_todos(am, eod, weekly)
    write("todos.json", {"generatedAt": today.isoformat(), "todos": todos})

    index = {
        "generatedAt": today.isoformat(),
        "today": today_str,
        "am": am_meta,
        "eod": eod_meta,
        "weekly": weekly_meta,
        "todoCount": len(todos),
        "encrypted": encrypted,
    }
    write("index.json", index)

    log(f"summary: am={'yes' if am else 'none'} "
        f"eod={'yes' if eod else 'none'} "
        f"weekly={'yes' if weekly else 'none'} "
        f"todos={len(todos)}")

    pushed = git_push()
    # publishing data is the job; a failed/absent push should not fail the run
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never crash the scheduled task
        log(f"unexpected error (continuing): {e}")
        sys.exit(0)
