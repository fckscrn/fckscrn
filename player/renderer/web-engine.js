// Web player engine: runs in the technician's tab (/p/<token>) and does what the desktop
// app's main process does: state, sync + offline cache, screens, output windows, commands.
// Output windows (projection, presenter) talk to it over a BroadcastChannel.
import { resolveRoles, assignRole } from "./roles.mjs";
import { L } from "./i18n.js";
import { createLiveLink } from "./live-link.mjs";
import * as videos from "./videos.mjs";

const SYNC_EVERY_MS = 20_000;
const FILES_CACHE = "fckscrn-files";

export function createEngine({ token, emit }) {
  const KEY = `fckscrn:${token}`;
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(`${KEY}:${k}`)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`${KEY}:${k}`, JSON.stringify(v)); } catch {} },
  };

  let manifest = store.get("manifest", null);
  let audioNames = 0; // bumped when the control tab unlocked output names
  let order = { busy: false, error: null, ares: null }; // activating the event from the room (hosted version)
  let config = store.get("config", { roles: {}, loopEnabled: true });
  let cached = new Set();               // file URLs available offline
  let sync = { state: "idle", at: manifest?.syncedAt || null, message: "" };
  let live = null;
  let lastTalkId = null;
  let outputsOpen = false;
  let outputs = { projection: "closed", presenter: "closed" }; // closed | waiting | open | fullscreen
  let popupBlocked = false;
  let screenDetails = null;
  let screenAccess = "unsupported";      // unsupported | prompt | granted | denied
  let syncTimer = null;
  let questions = {}, questionsKey = "";
  let message = null, messageTimer = null; // { text, at } shown big on the speaker monitor
  let help = null;                          // { at }: the speaker asked for help from the phone
  let polls = {};                           // { talkId: poll } current audience poll per talk
  const hasCache = "caches" in self;

  const pdfUrl = t => `${t.files.pdf}?v=${t.version}`;
  const saveConfig = () => store.set("config", config);

  // ---------- screens ----------

  async function initScreens() {
    if (!("getScreenDetails" in window)) { screenAccess = "unsupported"; return; }
    try {
      const p = await navigator.permissions.query({ name: "window-management" });
      screenAccess = p.state;
      p.onchange = () => { screenAccess = p.state; if (p.state === "granted") loadScreens(); else changed(); };
      if (p.state === "granted") await loadScreens();
    } catch { screenAccess = "prompt"; }
  }

  async function loadScreens() {
    try {
      screenDetails = await window.getScreenDetails();
      screenAccess = "granted";
      screenDetails.onscreenschange = () => changed();
    } catch { screenAccess = "denied"; }
    changed();
  }

  function displayList() {
    const list = screenDetails ? screenDetails.screens : [Object.assign(Object.create(null), {
      label: L("Tato obrazovka", "This screen"), isPrimary: true, isInternal: true,
      availLeft: screen.availLeft ?? 0, availTop: screen.availTop ?? 0, availWidth: screen.availWidth, availHeight: screen.availHeight,
      left: 0, top: 0, width: screen.width, height: screen.height, devicePixelRatio: devicePixelRatio,
    })];
    const ds = list.map((s, i) => ({
      id: `${s.label || "screen"}@${s.left},${s.top}`,
      n: i + 1,
      label: s.label || (s.isInternal ? L("Vestavěný displej", "Built-in display") : `${L("Obrazovka", "Screen")} ${i + 1}`),
      size: `${Math.round(s.width * (s.devicePixelRatio || 1))} × ${Math.round(s.height * (s.devicePixelRatio || 1))}`,
      primary: !!s.isPrimary, internal: !!s.isInternal,
      rect: { left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight },
    }));
    const roles = resolveRoles(ds, config.roles);
    return ds.map(d => ({ ...d, role: roles[d.id] }));
  }
  const displayFor = role => displayList().find(d => d.role === role || (d.role === "both" && (role === "ctrl" || role === "spk"))) || null; // both = control + speaker monitor

  // Where output windows go. "dedicated" = its own screen, so it should be fullscreen.
  function placements() {
    const ctrl = displayFor("ctrl") || displayList()[0];
    const at = (role, fallback) => {
      const d = displayFor(role);
      if (d && d.id !== ctrl.id) return { ...d.rect, dedicated: true };
      return fallback ? { left: ctrl.rect.left + 60, top: ctrl.rect.top + 60, width: 960, height: 560, dedicated: false } : null;
    };
    const projection = at("proj", true);
    // speaker monitor on the technician's own screen (laptop at the podium): a window over the whole
    // screen, not fullscreen, so the control tab stays one Cmd+Tab away
    const spk = displayFor("spk");
    // control + speaker monitor in one window: no separate speaker window, the control tab shows it
    if (spk?.role === "both") return { projection, presenter: null, combined: true };
    if (spk && spk.id === ctrl.id) return { projection, presenter: { ...spk.rect, dedicated: false } };
    // no speaker monitor at a real venue: skip it; nothing assigned (laptop rehearsal): show both as windows
    const presenter = at("spk", !projection.dedicated);
    return { projection, presenter };
  }

  // ---------- talks ----------

  function talks() {
    return (manifest?.talks || []).map(t => ({
      ...t,
      videos: (t.videos || []).map(v => ({ ...v, ready: v.kind === "online" || (v.kind === "file" && (!hasCache || cached.has(v.url))) })),
      local: { pdf: !!t.files?.pdf && (!hasCache || cached.has(pdfUrl(t))), original: false, bg: !!t.files?.background && (!hasCache || cached.has(t.files.background)) },
    }));
  }
  function loop() {
    return (manifest?.loop || []).filter(m => !hasCache || cached.has(m.url));
  }
  const find = id => talks().find(t => t.id === id);

  function nextTalk() {
    const list = talks();
    const current = live?.talkId ?? lastTalkId;
    const idx = current ? list.findIndex(t => t.id === current) : -1;
    const ready = t => t.kind === "break" || t.kind === "panel" || t.local.pdf;
    if (idx >= 0) return list.slice(idx + 1).find(ready) || null;
    const now = new Date().toTimeString().slice(0, 5);
    return list.find(t => ready(t) && (!t.startsAt || t.startsAt >= now)) || list.find(ready) || null;
  }

  function snapshot() {
    return {
      paired: true, server: location.origin,
      event: manifest?.event || null, room: manifest?.room || null,
      talks: talks(), loop: loop(), loopEnabled: config.loopEnabled !== false, audioOutput: config.audioOutput || null, audioNames,
      watermark: !!manifest?.watermark, billing: manifest?.billing || { enabled: false }, order,
      questions, polls, message, help, remote: manifest?.remote || null,
      sync, pairError: null,
      displays: displayList().map(({ rect, ...d }) => d),
      live, outputsOpen, outputs, popupBlocked, placements: placements(),
      nextTalkId: nextTalk()?.id ?? null,
      platform: "web", screenAccess,
    };
  }
  let link = null;
  const changed = () => { const s = snapshot(); emit(s); link?.push(s); };

  // ---------- sync ----------

  async function runSync() {
    clearTimeout(syncTimer);
    sync = { ...sync, state: "syncing", message: L("Kontroluji změny…", "Checking for changes…") };
    changed();
    try {
      const res = await fetch(`/api/player/${encodeURIComponent(token)}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error || `Server odpověděl ${res.status}`), { status: res.status });
      manifest = { ...body, syncedAt: new Date().toISOString() };
      store.set("manifest", manifest);
      let downloaded = 0;
      if (hasCache) {
        const cache = await caches.open(FILES_CACHE);
        const urls = [
          ...manifest.talks.filter(t => t.files?.pdf).map(pdfUrl),
          ...(manifest.loop || []).map(m => m.url),
          ...manifest.talks.filter(t => t.files?.background).map(t => t.files.background),
          ...manifest.talks.flatMap(t => (t.videos || []).filter(v => v.kind === "file" && v.url).map(v => v.url)),
        ];
        const todo = [];
        for (const u of urls) if (!(await cache.match(u))) todo.push(u);
        for (const [i, u] of todo.entries()) {
          sync = { ...sync, state: "syncing", message: `${L("Stahuji", "Downloading")} ${i + 1}/${todo.length}` };
          changed();
          try { await cache.add(u); downloaded++; } catch {}
        }
        // drop files of this room that are no longer in the program
        const keep = new Set(urls.map(u => new URL(u, location.origin).href));
        for (const req of await cache.keys()) {
          if (req.url.includes(`/api/player/${token}/`) && !keep.has(req.url) && !(live && req.url.includes(`/talks/${live.talkId}/`))) await cache.delete(req);
        }
        await refreshCached();
      }
      sync = { state: "ok", at: manifest.syncedAt, message: downloaded ? `${L("Nově staženo", "Newly downloaded")}: ${downloaded}` : "" };
    } catch (e) {
      if (hasCache) await refreshCached();
      sync = { state: "offline", at: sync.at, message: e.status ? e.message : L("Server je nedostupný. Používám stažené soubory.", "Server unreachable. Using downloaded files.") };
    }
    changed();
    syncTimer = setTimeout(runSync, SYNC_EVERY_MS);
  }

  async function refreshCached() {
    const cache = await caches.open(FILES_CACHE);
    cached = new Set((await cache.keys()).map(r => { const u = new URL(r.url); return u.pathname + u.search; }));
  }

  // ---------- outputs ----------

  function features(p, fullscreen) {
    return `popup,left=${Math.round(p.left)},top=${Math.round(p.top)},width=${Math.round(p.width)},height=${Math.round(p.height)}${fullscreen ? ",fullscreen" : ""}`;
  }

  // Must run inside a click (user activation). The presenter window is opened by the
  // projection window on its first key press (one activation = fullscreen + companion window).
  function openOutputs() {
    const p = placements();
    if (outputs.projection === "closed") {
      const w = window.open(`/p/${encodeURIComponent(token)}/projection`, `fckscrn-projection-${token}`, features(p.projection, p.projection.dedicated));
      popupBlocked = !w;
      if (w) outputs = { ...outputs, projection: "waiting" };
    }
    outputsOpen = !popupBlocked;
  }

  function stopOutputs() {
    live = null;
    outputsOpen = false;
    outputs = { projection: "closed", presenter: "closed" };
    emit(snapshot(), { close: true });
    changed();
  }

  // ---------- commands ----------

  function cmd(type, arg) {
    const pdfLive = live?.mode === "pdf";
    switch (type) {
      case "start": {
        const t = find(arg);
        if (!t) return;
        lastTalkId = t.id;
        clearTimeout(messageTimer); message = null; // a message was for the previous speaker
        if (t.kind === "break") live = { talkId: t.id, mode: "break", startedAt: Date.now() };
        else if (t.kind === "panel") live = { talkId: t.id, mode: "panel", startedAt: Date.now(), showQuestions: false };
        else if (t.local.pdf) live = { talkId: t.id, mode: "pdf", page: 1, pages: t.pageCount || 1, black: false, startedAt: Date.now(), showQuestions: false };
        else return;
        openOutputs();
        break;
      }
      case "next": if (pdfLive) videos.next(live, find(live.talkId)); break;
      case "prev": if (pdfLive && live.page > 1) videos.goTo(live, live.page - 1); break;
      case "first": if (pdfLive) videos.goTo(live, 1); break;
      case "black": if (pdfLive) live.black = !live.black; break;
      case "pages": if (pdfLive && +arg > 0) live.pages = +arg; break;
      case "end": live = null; break;
      case "standby": live = null; openOutputs(); break;
      case "stopOutputs": return stopOutputs();
      case "message": // to the speaker monitor; from the control screen or the organizer; clears itself after 5 min
        clearTimeout(messageTimer);
        message = arg?.text ? { text: String(arg.text).slice(0, 200), at: Date.now() } : null;
        if (message) messageTimer = setTimeout(() => { message = null; changed(); }, 5 * 60_000);
        break;
      case "showQuestions": if (live && live.mode !== "break") { live.showQuestions = !live.showQuestions; live.showPoll = false; } break;
      case "showPoll": if (live && live.mode !== "break") { live.showPoll = !live.showPoll; live.showQuestions = false; } break;
      case "qr": if (live && live.mode !== "break") live.hideQr = !live.hideQr; break; // Q&A QR in the corner on/off
      case "help": help = { at: Date.now() }; break;
      case "helpDone": // the technician is on the way: tell the speaker
        help = null;
        clearTimeout(messageTimer);
        message = { text: L("Technik je na cestě.", "The technician is on the way."), at: Date.now() };
        messageTimer = setTimeout(() => { message = null; changed(); }, 60_000);
        break;
      case "shift": // running late: move the rest of the room's programme
        fetch(`/api/player/${encodeURIComponent(token)}/shift`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(arg) })
          .catch(() => {}).then(runSync);
        return;
      case "answer":
        fetch(`/api/player/${encodeURIComponent(token)}/questions/${arg.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answered: arg.answered }) })
          .catch(() => {}).then(pollQuestions);
        return;
      case "ares": // company details by IČO for the order form
        order = { ...order, busy: true, error: null }; changed();
        fetch(`/api/ares/${encodeURIComponent(String(arg || "").replace(/\s/g, ""))}`).then(async r => {
          const j = await r.json().catch(() => ({}));
          order = r.ok ? { busy: false, error: null, ares: j } : { busy: false, error: j.error || L("IČO jsme v ARES nenašli.", "Company ID not found in ARES."), ares: null };
        }).catch(() => { order = { busy: false, error: L("ARES teď neodpovídá.", "ARES isn't answering."), ares: null }; }).then(changed);
        return;
      case "order": // the technician activates the event on site: proforma right away, QR until it's paid
        order = { ...order, busy: true, error: null }; changed();
        fetch(`/api/player/${encodeURIComponent(token)}/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(arg) })
          .then(async r => {
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || L("Objednávka se nepovedla.", "The order failed."));
            order = { busy: false, error: null, ares: null };
            return runSync();
          })
          .catch(e => { order = { ...order, busy: false, error: e.message }; })
          .then(changed);
        return;
      case "loop": config.loopEnabled = !!arg; saveConfig(); break;
      case "audioNames": audioNames = Date.now(); break;
      case "audioOutput": config.audioOutput = arg?.id ? { id: String(arg.id), label: String(arg.label || "") } : null; saveConfig(); break;
      case "role":
        config.roles = assignRole(config.roles, displayList(), arg.displayId, arg.role);
        saveConfig(); break;
      case "screens": return loadScreens(); // inside a click: shows the browser permission prompt
      case "sync": return runSync();
      case "output": // status report from an output window
        outputs = { ...outputs, [arg.role]: arg.status };
        if (arg.status !== "closed" && arg.role === "projection") outputsOpen = true;
        break;
      default: return;
    }
    changed();
  }

  // ---------- audience questions ----------

  async function pollQuestions() {
    try {
      const res = await fetch(`/api/player/${encodeURIComponent(token)}/questions`, { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      const key = JSON.stringify([body.questions, body.polls]);
      if (key !== questionsKey) { questionsKey = key; questions = body.questions; polls = body.polls || {}; changed(); }
    } catch {}
  }
  setInterval(pollQuestions, 5000);

  // ---------- start ----------

  (async () => {
    if (hasCache) await refreshCached().catch(() => {});
    await initScreens();
    link = createLiveLink({ token, onCmd: (c, a) => ["next", "prev", "black", "first", "message", "help", "showQuestions"].includes(c) && cmd(c, a) });
    changed();
    runSync();
  })();
  addEventListener("online", () => runSync());

  return { snapshot, cmd };
}
