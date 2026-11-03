const { app, BrowserWindow, screen, ipcMain, protocol, net, powerSaveBlocker, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { Library, parsePairUrl } = require("./library");
let resolveRoles, assignRole, createLiveLink, videos; // ESM, shared with the web player; loaded in whenReady
const { openNative } = require("./native");

const SYNC_EVERY_MS = 20_000;
const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const PDFJS_DIR = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "build");
const PRELOAD = path.join(__dirname, "preload.js");

protocol.registerSchemesAsPrivileged([
  { scheme: "fck", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let config = { roles: {} };
let library;
const wins = { control: null, projection: null, presenter: null };
let live = null;      // { talkId, mode: "pdf" | "native", page, pages, black, startedAt, played: [video i started by a click] }
let lastTalkId = null; // for "next up" after a talk ends
let outputsOpen = false;
let sync = { state: "idle", at: null, message: "" };
let pairError = null;
let syncTimer = null;
let sleepBlocker = null;
let questions = {};      // { talkId: [question] } from the server, polled every few seconds
let questionsKey = "";
let message = null, messageTimer = null; // { text, at } for the speaker monitor
let help = null;         // { at }: the speaker asked for help from the phone
let polls = {};          // { talkId: poll } current audience poll per talk
let link = null;         // live link to the server: phone remote + organizer messages

// ---------- config ----------

const configFile = () => path.join(app.getPath("userData"), "config.json");
function loadConfig() {
  try { config = { roles: {}, ...JSON.parse(fs.readFileSync(configFile(), "utf8")) }; } catch {}
}
function saveConfig() { fs.writeFileSync(configFile(), JSON.stringify(config, null, 2)); }

// ---------- displays ----------

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  const all = screen.getAllDisplays().map((d, i) => ({
    id: d.id, n: i + 1, bounds: d.bounds, workArea: d.workArea, internal: !!d.internal, primary: d.id === primary,
    label: d.label || (d.internal ? "Vestavěný displej" : `Obrazovka ${i + 1}`),
    size: `${Math.round(d.size.width * d.scaleFactor)} × ${Math.round(d.size.height * d.scaleFactor)}`,
  }));
  const roles = resolveRoles(all, config.roles);
  return all.map(d => ({ ...d, role: roles[d.id] }));
}
const displayFor = role => displayList().find(d => d.role === role || (d.role === "both" && (role === "ctrl" || role === "spk"))) || null; // both = control + speaker monitor

// ---------- state ----------

function talks() { return library.talks(); }

function nextTalk() {
  const list = talks();
  const current = live?.talkId ?? lastTalkId;
  const idx = current ? list.findIndex(t => t.id === current) : -1;
  const ready = t => t.kind === "break" || t.kind === "panel" || t.version;
  if (idx >= 0) return list.slice(idx + 1).find(ready) || null;
  const now = new Date().toTimeString().slice(0, 5);
  return list.find(t => ready(t) && (!t.startsAt || t.startsAt >= now)) || list.find(ready) || null;
}

function snapshot() {
  const m = library.manifest;
  return {
    paired: !!config.token,
    server: config.server || null,
    event: m?.event || null,
    room: m?.room || null,
    talks: talks(),
    loop: library.loop(),
    watermark: !!m?.watermark,
    questions, polls, message, help, remote: m?.remote || null,
    loopEnabled: config.loopEnabled !== false,
    audioOutput: config.audioOutput || null,
    sync, pairError,
    displays: displayList().map(({ bounds, workArea, ...d }) => d),
    live, outputsOpen,
    placements: { combined: displayFor("spk")?.role === "both" },
    nextTalkId: nextTalk()?.id ?? null,
    platform: "desktop",
    screenAccess: "granted",
  };
}

function broadcast() {
  const s = snapshot();
  for (const w of Object.values(wins)) if (w && !w.isDestroyed()) w.webContents.send("state", s);
  link?.push(s);
}

function connectLive() {
  link?.stop();
  link = config.token && createLiveLink ? createLiveLink({
    server: config.server, token: config.token,
    onCmd: (type, arg) => ["next", "prev", "black", "first", "message", "help", "showQuestions"].includes(type) && onCmd(null, { type, arg }),
  }) : null;
}

// ---------- sync ----------

async function runSync() {
  if (!config.token) return;
  clearTimeout(syncTimer);
  sync = { ...sync, state: "syncing", message: "Kontroluji změny…" };
  broadcast();
  try {
    const keep = live?.talkId ? [live.talkId] : [];
    const r = await library.sync(config.server, config.token, {
      keep,
      onProgress: p => { sync = { ...sync, state: "syncing", message: `Stahuji ${p.done + 1}/${p.total}: ${p.title}` }; broadcast(); },
    });
    sync = { state: "ok", at: new Date().toISOString(), message: r.downloaded ? `Nově staženo: ${r.downloaded}` : "" };
  } catch (e) {
    if (e.status === 404) { pairError = e.message; }
    sync = { state: "offline", at: sync.at, message: e.status ? e.message : "Server je nedostupný. Používám stažené soubory." };
  }
  broadcast();
  syncTimer = setTimeout(runSync, SYNC_EVERY_MS);
}

async function pair(input) {
  const p = parsePairUrl(input);
  if (!p) { pairError = "Tohle není párovací odkaz. Najdete ho ve správě akce u sálu pod tlačítkem Párování."; return broadcast(); }
  try {
    const res = await fetch(`${p.server}/api/player/${encodeURIComponent(p.token)}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server odpověděl ${res.status}`);
  } catch (e) {
    pairError = e.name === "TimeoutError" || e.cause ? "Server se nepodařilo kontaktovat. Zkontrolujte internet a odkaz." : e.message;
    return broadcast();
  }
  if (config.token !== p.token) await library.clear();
  Object.assign(config, p);
  pairError = null;
  saveConfig();
  connectLive();
  runSync();
}

async function unpair() {
  await stopOutputs();
  delete config.server; delete config.token;
  saveConfig();
  clearTimeout(syncTimer);
  await library.clear();
  connectLive();
  sync = { state: "idle", at: null, message: "" };
  broadcast();
}

// ---------- output windows ----------

function createOutput(kind) {
  const role = kind === "projection" ? "proj" : "spk";
  const target = displayFor(role);
  const ctrl = displayFor("ctrl") || displayList()[0];
  // venue without a speaker monitor: skip it. Nothing assigned at all (a laptop
  // rehearsal): show both as windows so the speaker can try it out.
  if (!target && kind === "presenter" && displayFor("proj")) return null;
  if (kind === "presenter" && target?.role === "both") return null; // the control window shows it
  const dedicated = target && target.id !== ctrl.id;

  const win = new BrowserWindow({
    show: false,
    backgroundColor: "#000000",
    frame: !dedicated,
    title: kind === "projection" ? "Projekce" : "Monitor řečníka",
    autoHideMenuBar: true,
    // assigned to the control screen (laptop at the podium): a window over that whole screen
    ...(dedicated ? target.bounds : target && kind === "presenter" ? target.workArea : { width: 960, height: 560 }),
    webPreferences: { preload: PRELOAD, autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false },
  });
  win.loadURL(`fck://app/renderer/${kind}.html`);
  win.once("ready-to-show", () => {
    if (dedicated) {
      win.setBounds(target.bounds);
      win.showInactive();
      if (process.platform === "darwin") win.setSimpleFullScreen(true); else win.setFullScreen(true);
      win.setAlwaysOnTop(true, "screen-saver");
    } else {
      win.showInactive(); // single screen: windowed preview next to the control window
    }
  });
  win.on("closed", () => { wins[kind] = null; });
  return win;
}

function openOutputs() {
  if (!wins.projection) wins.projection = createOutput("projection");
  if (!wins.presenter) wins.presenter = createOutput("presenter");
  outputsOpen = true;
  if (sleepBlocker === null) sleepBlocker = powerSaveBlocker.start("prevent-display-sleep");
}

async function stopOutputs() {
  live = null;
  outputsOpen = false;
  for (const k of ["projection", "presenter"]) { if (wins[k] && !wins[k].isDestroyed()) wins[k].destroy(); wins[k] = null; }
  if (sleepBlocker !== null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
  broadcast();
}

function reopenOutputs() {
  if (!outputsOpen) return;
  for (const k of ["projection", "presenter"]) { if (wins[k] && !wins[k].isDestroyed()) wins[k].destroy(); wins[k] = null; }
  openOutputs();
}

// ---------- commands ----------

async function start(talkId) {
  const t = library.find(talkId);
  if (!t) return;
  lastTalkId = talkId;
  clearTimeout(messageTimer); message = null; // a message was for the previous speaker
  if (t.kind === "break") {
    live = { talkId, mode: "break", startedAt: Date.now() };
    openOutputs();
  } else if (t.kind === "panel") {
    live = { talkId, mode: "panel", startedAt: Date.now(), showQuestions: false };
    openOutputs();
  } else if (library.pdfPath(talkId)) {
    live = { talkId, mode: "pdf", page: 1, pages: t.pageCount || 1, black: false, startedAt: Date.now(), showQuestions: false };
    openOutputs();
  } else if (library.originalPath(talkId)) {
    // the native app takes over the screens; our windows would cover it
    await stopOutputs();
    live = { talkId, mode: "native", startedAt: Date.now() };
    try { await openNative(library.originalPath(talkId), t.fileExt); }
    catch (e) { live = null; sync = { ...sync, message: `Originál se nepodařilo otevřít: ${e.message}` }; }
  }
  broadcast();
}

function onCmd(_e, { type, arg }) {
  const pdfLive = live?.mode === "pdf";
  switch (type) {
    case "start": return start(arg);
    case "next": if (pdfLive) videos.next(live, talks().find(t => t.id === live.talkId)); break;
    case "prev": if (pdfLive && live.page > 1) videos.goTo(live, live.page - 1); break;
    case "first": if (pdfLive) videos.goTo(live, 1); break;
    case "goto": if (pdfLive) videos.goTo(live, Math.min(Math.max(1, +arg || 1), live.pages)); break;
    case "black": if (pdfLive) live.black = !live.black; break;
    case "pages": if (pdfLive && +arg > 0) live.pages = +arg; break;
    case "end": live = null; break; // outputs stay open in standby (black + next talk)
    case "stopOutputs": return stopOutputs();
    case "showQuestions": if (live && live.mode !== "break") { live.showQuestions = !live.showQuestions; live.showPoll = false; } break;
    case "showPoll": if (live && live.mode !== "break") { live.showPoll = !live.showPoll; live.showQuestions = false; } break;
    case "qr": if (live && live.mode !== "break") live.hideQr = !live.hideQr; break; // Q&A QR in the corner on/off
    case "help": help = { at: Date.now() }; break;
    case "helpDone":
      help = null;
      clearTimeout(messageTimer);
      message = { text: "Technik je na cestě.", at: Date.now() };
      messageTimer = setTimeout(() => { message = null; broadcast(); }, 60_000);
      break;
    case "shift": return shift(arg);
    case "message": // to the speaker monitor, clears itself after 5 min
      clearTimeout(messageTimer);
      message = arg?.text ? { text: String(arg.text).slice(0, 200), at: Date.now() } : null;
      if (message) messageTimer = setTimeout(() => { message = null; broadcast(); }, 5 * 60_000);
      break;
    case "answer": return answer(arg);
    case "standby": live = null; openOutputs(); break; // black / loop without starting anything
    case "loop": config.loopEnabled = !!arg; saveConfig(); break;
    case "audioOutput": config.audioOutput = arg?.id ? { id: String(arg.id), label: String(arg.label || "") } : null; saveConfig(); break;
    case "role":
      config.roles = assignRole(config.roles, displayList(), arg.displayId, arg.role);
      saveConfig(); reopenOutputs(); break;
    case "identify": return identify();
    case "pair": return pair(arg);
    case "unpair": return unpair();
    case "sync": return runSync();
    default: return;
  }
  broadcast();
}

// ---------- audience questions ----------

async function pollQuestions() {
  if (!config.token) return;
  try {
    const res = await fetch(`${config.server}/api/player/${encodeURIComponent(config.token)}/questions`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const body = await res.json();
    const key = JSON.stringify([body.questions, body.polls]);
    if (key !== questionsKey) { questionsKey = key; questions = body.questions; polls = body.polls || {}; broadcast(); }
  } catch {}
}

// running late: move the rest of the room's programme, then pick up the new times
async function shift(arg) {
  try {
    await fetch(`${config.server}/api/player/${encodeURIComponent(config.token)}/shift`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(arg),
    });
  } catch {}
  runSync();
}

async function answer({ id, answered }) {
  try {
    await fetch(`${config.server}/api/player/${encodeURIComponent(config.token)}/questions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answered }),
    });
  } catch {}
  pollQuestions();
}

function identify() {
  for (const d of displayList()) {
    const w = new BrowserWindow({ ...d.bounds, frame: false, transparent: true, alwaysOnTop: true, focusable: false, hasShadow: false, show: false });
    const html = `<body style="margin:0;height:100vh;display:grid;place-items:center;background:rgba(0,0,0,.85);color:#fff;font:800 30vh/1 -apple-system,Segoe UI,sans-serif;text-align:center">
      <div>${d.n}<div style="font:500 3vh -apple-system,Segoe UI,sans-serif;opacity:.7;margin-top:2vh">${d.label.replace(/[<&]/g, "")}</div></div></body>`;
    w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    w.once("ready-to-show", () => w.showInactive());
    setTimeout(() => !w.isDestroyed() && w.destroy(), 2500);
  }
}

// ---------- app ----------

function serveProtocol() {
  protocol.handle("fck", req => {
    const { pathname } = new URL(req.url);
    const parts = decodeURIComponent(pathname).split("/").filter(Boolean);
    let file = null;
    if (parts[0] === "renderer") file = safeJoin(RENDERER_DIR, parts.slice(1));
    else if (parts[0] === "pdfjs") file = safeJoin(PDFJS_DIR, parts.slice(1));
    else if (parts[0] === "cache") file = library.pdfPath(+parts[1]); // /cache/<talkId>/<version>.pdf
    else if (parts[0] === "media") file = library.mediaPath(+parts[1]); // /media/<id>
    else if (parts[0] === "bg") file = library.bgPath(+parts[1]); // /bg/<talkId>
    else if (parts[0] === "video") file = library.videoPath(+parts[1], +parts[2]); // /video/<talkId>/<i>
    if (!file || !fs.existsSync(file)) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function safeJoin(root, parts) {
  const p = path.join(root, ...parts);
  return p.startsWith(root + path.sep) ? p : null;
}

app.whenReady().then(async () => {
  ({ resolveRoles, assignRole } = await import("../renderer/roles.mjs"));
  ({ createLiveLink } = await import("../renderer/live-link.mjs"));
  videos = await import("../renderer/videos.mjs");
  // YouTube/Vimeo players refuse to start without knowing which site embeds them; ours is the paired server
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["https://*.youtube-nocookie.com/*", "https://*.youtube.com/*", "https://player.vimeo.com/*"] }, (d, cb) => {
    if (!d.requestHeaders.Referer && config.server) d.requestHeaders.Referer = config.server + "/";
    cb({ requestHeaders: d.requestHeaders });
  });
  loadConfig();
  library = new Library(path.join(app.getPath("userData"), "library"));
  serveProtocol();
  ipcMain.handle("state", () => snapshot());
  ipcMain.on("cmd", onCmd);

  const ctrl = displayFor("ctrl") || displayList()[0];
  wins.control = new BrowserWindow({
    width: 1180, height: 800, minWidth: 720, minHeight: 520,
    x: ctrl.workArea.x + 40, y: ctrl.workArea.y + 40,
    title: "FckScrn Player", backgroundColor: "#ffffff", autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD },
  });
  wins.control.loadURL("fck://app/renderer/control.html");
  wins.control.on("closed", () => app.quit());

  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.on(ev, () => { reopenOutputs(); broadcast(); });
  }
  connectLive();
  runSync();
  setInterval(pollQuestions, 5000);
});

app.on("second-instance", () => wins.control?.focus());
app.on("window-all-closed", () => app.quit());
