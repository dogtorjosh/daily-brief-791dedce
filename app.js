/* Daily Brief - front-end logic
   Fetches the JSON the publish script wrote and renders three tabs.
   No framework, no build step. To-do checked-state and manual tasks live in localStorage. */

(() => {
  "use strict";

  const LEAD_HOUR = 14; // 2pm: switch the Today lead from AM to EOD
  const LS_CHECKED = "db.checked";   // { "<title lower>": true }
  const LS_MANUAL = "db.manual";     // [ {id,title,addedAt} ]
  const ACTIONS = ["reply", "decline", "fyi", "engage", "review"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // ---- localStorage helpers (fail-safe) ----
  const lsGet = (k, fallback) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ---- crypto (matches publish.py: PBKDF2-SHA256 -> AES-256-GCM) ----
  const LS_PASS = "db.pass";
  let cryptoKey = null; // CryptoKey, set once a correct passcode is entered

  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const isEnvelope = (o) => o && typeof o === "object" && o.ct && o.iv && o.salt;

  async function deriveKey(passcode, saltBytes, iter) {
    const base = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations: iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }

  async function decryptEnvelope(env, key) {
    const iv = b64ToBytes(env.iv);
    const ct = b64ToBytes(env.ct);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // ---- data load ----
  const DATA = {};
  async function loadRaw(name) {
    try {
      const r = await fetch(`data/${name}?v=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      try {
        const r2 = await fetch(`data/${name}`); // service-worker cache fallback (offline)
        if (r2.ok) return await r2.json();
      } catch {}
      return null;
    }
  }

  // Returns parsed object, decrypting if it's an envelope. Throws "LOCKED" if no key yet.
  async function resolve(raw) {
    if (!raw) return null;
    if (!isEnvelope(raw)) return raw; // unencrypted
    if (!cryptoKey) throw new Error("LOCKED");
    return decryptEnvelope(raw, cryptoKey);
  }

  async function loadAll() {
    const [index, am, eod, week, todos] = await Promise.all([
      loadRaw("index.json").then(resolve),
      loadRaw("today-am.json").then(resolve),
      loadRaw("today-eod.json").then(resolve),
      loadRaw("this-week.json").then(resolve),
      loadRaw("todos.json").then(resolve),
    ]);
    DATA.index = index;
    DATA.am = am && !am.empty ? am : null;
    DATA.eod = eod && !eod.empty ? eod : null;
    DATA.week = week && !week.empty ? week : null;
    DATA.todos = todos && todos.todos ? todos.todos : [];
  }

  // ---- passcode gate ----
  async function tryUnlock(passcode) {
    const raw = await loadRaw("index.json");
    if (!isEnvelope(raw)) return true; // data isn't encrypted; nothing to unlock
    try {
      const key = await deriveKey(passcode, b64ToBytes(raw.salt), raw.iter || 200000);
      await decryptEnvelope(raw, key); // throws if wrong passcode
      cryptoKey = key;
      return true;
    } catch {
      return false;
    }
  }

  function showLock() {
    const lock = $("#lockscreen");
    const app = $("#app");
    lock.hidden = false;
    app.hidden = true;
    const form = $("#lock-form");
    const input = $("#lock-input");
    const err = $("#lock-error");
    input.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.hidden = true;
      const ok = await tryUnlock(input.value);
      if (ok) {
        if ($("#lock-remember").checked) lsSet(LS_PASS, input.value);
        lock.hidden = true;
        app.hidden = false;
        await start();
      } else {
        err.hidden = false;
        input.select();
      }
    };
  }

  async function gate() {
    // peek at index.json to learn whether data is encrypted
    const raw = await loadRaw("index.json");
    if (!isEnvelope(raw)) return true; // unencrypted -> straight in
    const saved = lsGet(LS_PASS, null);
    if (saved && (await tryUnlock(saved))) return true; // remembered passcode works
    showLock();
    return false; // waiting on the user
  }

  // ---- formatting ----
  function fmtDate(iso) {
    if (!iso) return "";
    // iso like 2026-06-07
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }
  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // ---- renderers ----
  function actionPill(action) {
    if (!action || action === "none" || !ACTIONS.includes(action)) return "";
    const cls = action === "decline" ? "pill pill-decline" : "pill";
    return `<span class="${cls}">${esc(action)}</span>`;
  }

  function renderItem(item) {
    const high = item.priority === "high";
    const node = el("article", "item" + (high ? " is-high" : ""));
    let h = `<p class="item-title">${actionPill(item.action)}${esc(item.title)}</p>`;
    if (item.summary) h += `<p class="item-summary">${esc(item.summary)}</p>`;
    if (item.meta) h += `<p class="item-meta">${esc(item.meta)}</p>`;
    if (item.link) h += `<a class="item-link" href="${esc(item.link)}" target="_blank" rel="noopener">open</a>`;
    node.innerHTML = h;
    return node;
  }

  function renderSection(sec, opts = {}) {
    if (!sec || !sec.items || !sec.items.length) return null;
    const card = el("section", "card" + (opts.daylist ? " daylist" : ""));
    const count = sec.count != null ? ` <span class="count">(${sec.count})</span>` : "";
    card.appendChild(el("h3", null, esc(sec.title || sec.id) + count));
    sec.items.forEach((it) => card.appendChild(renderItem(it)));
    return card;
  }

  function emptyState(big, line1, line2) {
    const n = el("div", "empty");
    n.innerHTML = `<div class="big">${big}</div><p>${esc(line1)}</p>` +
      (line2 ? `<p>${esc(line2)}</p>` : "");
    return n;
  }

  // ----- TODAY -----
  function renderToday() {
    const panel = $("#panel-today");
    panel.innerHTML = "";

    const am = DATA.am, eod = DATA.eod;
    if (!am && !eod) {
      panel.appendChild(emptyState("&#9728;", "No brief yet today.",
        "Your morning brief will appear here once it runs."));
      return;
    }

    const hour = new Date().getHours();
    const eodToday = DATA.index && DATA.index.eod && DATA.index.eod.isToday;
    const leadEod = !!eod && (hour >= LEAD_HOUR || eodToday);

    const primary = leadEod ? eod : (am || eod);
    const secondary = leadEod ? am : (am ? eod : null);

    panel.appendChild(buildBriefBlock(primary, true));

    if (secondary) {
      const det = el("details", "secondary");
      const label = secondary.type === "eod" ? "Tonight's wrap-up" : "This morning's brief";
      det.appendChild(el("summary", null, label));
      det.appendChild(buildBriefBlock(secondary, false));
      panel.appendChild(det);
    }
  }

  function buildBriefBlock(brief, withLead) {
    const wrap = document.createDocumentFragment();
    const meta = metaFor(brief);

    if (withLead) {
      const lead = el("div", "lead");
      const greeting = brief.type === "eod" ? "This evening" : "Good morning, Josh";
      let h = `<h2>${esc(greeting)}</h2>`;
      h += `<p class="lead-sub">${esc(fmtDate(brief.date))}` +
        (meta && meta.generatedAt ? ` &middot; updated ${esc(fmtTime(meta.generatedAt))}` : "") + `</p>`;
      if (brief.headline) h += `<p class="headline">${esc(brief.headline)}</p>`;
      lead.innerHTML = h;
      wrap.appendChild(lead);

      // Loud staleness banner: publish.py stamps brief.staleNotice when today's
      // brief didn't generate and it fell back to an older file. Fall back to the
      // index isToday flag if the notice is ever absent.
      const stale = brief.staleNotice && brief.staleNotice.message
        ? brief.staleNotice.message
        : (meta && meta.isToday === false
            ? "⚠️ Today's brief didn't generate — showing " + fmtDate(brief.date) + " instead."
            : null);
      if (stale) {
        wrap.appendChild(el("div", "stale-banner", esc(stale)));
      }
    }

    const secs = (brief.sections || []).filter((s) => s.items && s.items.length);
    if (!secs.length) {
      wrap.appendChild(emptyState("&#9749;", brief.headline || "Nothing needs you.",
        "A calm one. Check back later."));
    } else {
      secs.forEach((s) => {
        const c = renderSection(s);
        if (c) wrap.appendChild(c);
      });
    }
    return wrap;
  }

  function metaFor(brief) {
    if (!DATA.index) return null;
    if (brief.type === "eod") return DATA.index.eod;
    if (brief.type === "weekly") return DATA.index.weekly;
    return DATA.index.am;
  }

  // ----- THIS WEEK -----
  function renderWeek() {
    const panel = $("#panel-week");
    panel.innerHTML = "";
    const w = DATA.week;
    if (!w) {
      panel.appendChild(emptyState("&#128197;", "No weekly brief yet.",
        "Your Sunday review will show up here."));
      return;
    }

    const lead = el("div", "lead");
    let h = `<h2>${esc(w.headline || "This week")}</h2>`;
    const meta = DATA.index && DATA.index.weekly;
    h += `<p class="lead-sub">Week of ${esc(fmtDate(w.date))}` +
      (meta && meta.generatedAt ? ` &middot; updated ${esc(fmtTime(meta.generatedAt))}` : "") + `</p>`;
    lead.innerHTML = h;
    panel.appendChild(lead);

    const daylistIds = new Set(["week-ahead", "upcoming-events"]);
    (w.sections || []).forEach((s) => {
      const c = renderSection(s, { daylist: daylistIds.has(s.id) });
      if (c) panel.appendChild(c);
    });
  }

  // ----- TO-DOS -----
  function getMerged() {
    // brief todos + manual todos, deduped by lowercased title (brief wins)
    const checked = lsGet(LS_CHECKED, {});
    const manual = lsGet(LS_MANUAL, []);
    const seen = new Set();
    const out = [];
    (DATA.todos || []).forEach((t) => {
      const key = t.title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...t, manual: false, done: !!checked[key] });
    });
    manual.forEach((t) => {
      const key = t.title.toLowerCase();
      if (seen.has(key)) return; // a manual task that now exists in a brief: keep the brief one
      seen.add(key);
      out.push({ ...t, manual: true, done: !!checked[key] });
    });
    return out;
  }

  function setChecked(title, val) {
    const checked = lsGet(LS_CHECKED, {});
    const key = title.toLowerCase();
    if (val) checked[key] = true; else delete checked[key];
    lsSet(LS_CHECKED, checked);
  }

  function addManual(title) {
    title = title.trim();
    if (!title) return;
    const manual = lsGet(LS_MANUAL, []);
    if (manual.some((t) => t.title.toLowerCase() === title.toLowerCase())) return;
    manual.unshift({ id: "manual-" + Date.now(), title });
    lsSet(LS_MANUAL, manual);
  }

  function removeManual(title) {
    const manual = lsGet(LS_MANUAL, []).filter((t) => t.title.toLowerCase() !== title.toLowerCase());
    lsSet(LS_MANUAL, manual);
    setChecked(title, false);
  }

  function renderTodos() {
    const panel = $("#panel-todos");
    panel.innerHTML = "";

    // add box
    const add = el("form", "todo-add");
    add.innerHTML = `<input type="text" placeholder="Add a task&hellip;" aria-label="Add a task" autocomplete="off">` +
      `<button type="submit">Add</button>`;
    add.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("input", add);
      addManual(input.value);
      input.value = "";
      renderTodos();
    });
    panel.appendChild(add);

    const items = getMerged();
    const open = items.filter((t) => !t.done);
    const done = items.filter((t) => t.done);

    if (!items.length) {
      panel.appendChild(emptyState("&#10003;", "Nothing on the list.",
        "To-dos from your briefs land here. Add your own above."));
      return;
    }

    if (open.length) {
      open.forEach((t) => panel.appendChild(renderTodo(t)));
    } else {
      panel.appendChild(el("p", "todo-section-label", "All clear &mdash; nicely done"));
    }

    if (done.length) {
      panel.appendChild(el("p", "todo-section-label", `Done (${done.length})`));
      done.forEach((t) => panel.appendChild(renderTodo(t)));
    }
  }

  function renderTodo(t) {
    const high = t.priority === "high";
    const row = el("div", "todo" + (t.done ? " done" : "") + (high ? " is-high" : ""));

    const box = el("input");
    box.type = "checkbox";
    box.checked = t.done;
    box.setAttribute("aria-label", t.done ? "Mark not done" : "Mark done");
    box.addEventListener("change", () => { setChecked(t.title, box.checked); renderTodos(); });

    const body = el("div", "todo-body");
    let h = `<p class="todo-title">${esc(t.title)}</p>`;
    if (t.summary) h += `<p class="todo-summary">${esc(t.summary)}</p>`;
    const tag = t.manual ? "Added by you" : (t.source || "");
    if (t.link) h += `<a class="item-link" href="${esc(t.link)}" target="_blank" rel="noopener">open</a>`;
    if (tag) h += `<p class="todo-source">${esc(tag)}</p>`;
    body.innerHTML = h;

    row.appendChild(box);
    row.appendChild(body);

    if (t.manual) {
      const del = el("button", "todo-del", "&times;");
      del.setAttribute("aria-label", "Delete task");
      del.title = "Delete task";
      del.addEventListener("click", () => { removeManual(t.title); renderTodos(); });
      row.appendChild(del);
    }
    return row;
  }

  // ---- freshness line ----
  function renderFreshness() {
    const f = $("#freshness");
    const idx = DATA.index;
    if (!idx) { f.textContent = "No data yet"; return; }
    // most recent generatedAt across the briefs we actually have
    const times = [idx.am, idx.eod, idx.weekly]
      .filter((m) => m && m.generatedAt)
      .map((m) => m.generatedAt)
      .sort();
    const latest = times.length ? times[times.length - 1] : null;
    if (latest) {
      f.textContent = "Updated " + fmtDate(latest.slice(0, 10)) + ", " + fmtTime(latest);
    } else {
      f.textContent = "Loaded";
    }
  }

  // ---- tabs ----
  function initTabs() {
    const tabs = document.querySelectorAll(".tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
        const name = tab.dataset.tab;
        document.querySelectorAll(".panel").forEach((p) => p.classList.remove("is-active"));
        $("#panel-" + name).classList.add("is-active");
        window.scrollTo({ top: 0 });
      });
    });
  }

  // ---- boot ----
  let tabsReady = false;
  async function start() {
    if (!tabsReady) { initTabs(); tabsReady = true; }
    try {
      await loadAll();
    } catch (e) {
      if (e.message === "LOCKED") { showLock(); return; }
      // any other failure: don't leave a blank screen - show the app with empty states
    }
    // reveal the app on EVERY successful start, however we got unlocked
    // (saved-passcode path skips the lock form, so it must happen here too)
    $("#lockscreen").hidden = true;
    $("#app").hidden = false;
    renderToday();
    renderWeek();
    renderTodos();
    renderFreshness();
  }

  async function boot() {
    const unlocked = await gate();
    if (unlocked) await start();
  }

  // register service worker for offline + instant open.
  // When a new version activates and takes control, reload once so the
  // latest code is used (prevents getting stuck on an old cached shell).
  if ("serviceWorker" in navigator) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        .then((reg) => reg.update())
        .catch(() => {});
    });
  }

  // refresh data when the app is reopened from the home screen
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") boot();
  });

  boot();
})();
