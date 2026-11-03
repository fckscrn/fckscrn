// Web player glue. Loaded first on /p/<token> pages. Provides the same `fck` API the desktop
// app exposes from its preload, so control.js, projection.js and presenter.js run unchanged.
//   /p/<token>             → technician tab, hosts the engine
//   /p/<token>/projection  → audience screen
//   /p/<token>/presenter   → speaker monitor
import "./i18n.js"; // sets <html lang> from the saved choice / browser
const parts = location.pathname.split("/").filter(Boolean);
const token = decodeURIComponent(parts[1] || "");
const role = parts[2] || "control";

globalThis.fckEnv = {
  pdfjs: "/vendor/pdfjs/pdf.mjs",
  worker: "/vendor/pdfjs/pdf.worker.mjs",
  pdfUrl: t => `${t.files.pdf}?v=${t.version}`,
  mediaUrl: m => m.url,
  bgUrl: t => t.files.background,
  videoUrl: (t, v) => v.url,
};

const channel = new BroadcastChannel(`fckscrn:${token}`);
let gate = null, presenterOpened = false, lock = null, wasFull = false; // output windows
const listeners = [];
let last = null;
const deliver = s => { last = s; for (const cb of listeners) cb(s); };

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

if (role === "control") {
  let engine;
  const ready = import("./web-engine.js").then(({ createEngine }) => {
    engine = createEngine({
      token,
      emit: (s, extra = {}) => { deliver(s); channel.postMessage({ type: "state", state: s, ...extra }); },
    });
    return engine;
  });
  channel.onmessage = e => {
    const m = e.data;
    if (m.type === "hello") ready.then(en => channel.postMessage({ type: "state", state: en.snapshot() }));
    if (m.type === "cmd") ready.then(en => en.cmd(m.cmd, m.arg));
  };
  // closing the technician tab takes the screens with it
  addEventListener("pagehide", () => channel.postMessage({ type: "state", state: last, close: true }));
  globalThis.fck = {
    getState: () => ready.then(en => en.snapshot()),
    onState: cb => listeners.push(cb),
    cmd: (type, arg) => (engine ? engine.cmd(type, arg) : ready.then(en => en.cmd(type, arg))),
  };
} else {
  globalThis.fck = {
    getState: () => new Promise(res => { if (last) res(last); else listeners.push(function once(s) { listeners.splice(listeners.indexOf(once), 1); res(s); }); }),
    onState: cb => listeners.push(cb),
    cmd: (type, arg) => channel.postMessage({ type: "cmd", cmd: type, arg }),
  };
  channel.onmessage = e => {
    if (e.data.type !== "state") return;
    if (e.data.close) { report("closed"); window.close(); return; }
    deliver(e.data.state);
    // switched to control + speaker monitor in one window: this separate monitor isn't needed
    if (role === "presenter" && e.data.state?.placements?.combined) { report("closed"); window.close(); return; }
    updateGate();
  };
  channel.postMessage({ type: "hello" });
  setupOutput();
}

// ---------- output windows: fullscreen gate, companion window, wake lock ----------

function report(status) { channel.postMessage({ type: "cmd", cmd: "output", arg: { role, status } }); }

function setupOutput() {
  gate = document.createElement("div");
  gate.className = "gate";
  gate.hidden = true;
  document.addEventListener("DOMContentLoaded", () => document.body.append(gate));
  // first key/click: go fullscreen and (projection) open the speaker monitor
  const activate = e => {
    if (gate.hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const p = last?.placements?.[role];
    if (p?.dedicated && !document.fullscreenElement) document.documentElement.requestFullscreen().then(lockEsc).catch(() => {});
    if (role === "projection" && last?.placements?.presenter && !presenterOpened) {
      const q = last.placements.presenter;
      const w = window.open(`/p/${encodeURIComponent(token)}/presenter`, `fckscrn-presenter-${token}`,
        `popup,left=${Math.round(q.left)},top=${Math.round(q.top)},width=${Math.round(q.width)},height=${Math.round(q.height)}`);
      presenterOpened = !!w;
    }
    setTimeout(updateGate, 300);
  };
  addEventListener("keydown", activate, true);
  addEventListener("pointerdown", activate, true);
  document.addEventListener("fullscreenchange", () => { if (document.fullscreenElement) { wasFull = true; lockEsc(); } updateGate(); report(document.fullscreenElement ? "fullscreen" : "open"); keepAwake(); });
  addEventListener("beforeunload", () => report("closed"));
  report("open");
  keepAwake();
  document.addEventListener("visibilitychange", keepAwake);
}

function updateGate() {
  if (!gate || !last) return;
  const p = last.placements?.[role];
  const needFull = p?.dedicated && !document.fullscreenElement;
  const needPresenter = role === "projection" && last.placements?.presenter && !presenterOpened && last.outputs?.presenter === "closed";
  gate.hidden = !(needFull || needPresenter);
  const en = document.documentElement.lang === "en";
  // after Esc (or the browser) dropped fullscreen, say what happened instead of the first-time text
  const back = needFull && wasFull;
  gate.innerHTML = en
    ? (back ? `<div><b>Press any key</b><span>The projection left fullscreen. Any key brings it back.</span></div>`
      : `<div><b>Press any key</b><span>${needFull ? "This switches this screen to fullscreen" : "This opens the speaker monitor"}. Then it stays until you close the window.</span></div>`)
    : (back ? `<div><b>Stiskněte libovolnou klávesu</b><span>Projekce vyskočila z celé obrazovky. Libovolná klávesa ji vrátí.</span></div>`
      : `<div><b>Stiskněte libovolnou klávesu</b><span>${needFull ? "Tím se tato obrazovka přepne na celou plochu" : "Tím se otevře monitor řečníka"}. Pak to vydrží, dokud okno nezavřete.</span></div>`);
}

// Chrome: in fullscreen a short Esc (a stray key or a clicker) does nothing; only holding Esc leaves
function lockEsc() { navigator.keyboard?.lock?.(["Escape"]).catch(() => {}); }

async function keepAwake() {
  if (lock || document.visibilityState !== "visible" || !navigator.wakeLock) return;
  try { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => { lock = null; }); } catch {}
}
