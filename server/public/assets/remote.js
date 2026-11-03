// Phone as the speaker monitor + clicker (opened from the QR code in the room player).
// Shows what the room computer is playing: slide, next slide, notes, time, questions.
// Buttons send next / previous to the room over the server (no Black: the speaker could tap it by mistake).
import { esc } from "./common.js";
import { t } from "./i18n.js";

const token = decodeURIComponent(location.pathname.split("/")[2] || "");
const base = `/api/remote/${token}`;
const $ = id => document.getElementById(id);
const app = $("app");

let info = null, error = null;      // room programme with notes and PDF links
let live = { connected: false, state: null };
let questions = {};
let msgAt = 0, drawn = "";

let pdfjs = null;
const docs = new Map();             // talk id + version -> PDF document
async function docOf(talk) {
  if (!talk?.pdf) return null;
  if (!pdfjs) {
    pdfjs = await import("/vendor/pdfjs/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
  }
  const key = talk.pdf;
  if (!docs.has(key)) docs.set(key, pdfjs.getDocument({ url: talk.pdf, isEvalSupported: false }).promise.catch(() => null));
  return docs.get(key);
}
async function draw(canvas, doc, n) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!doc || n < 1 || n > doc.numPages) { canvas.width = 16; canvas.height = 9; ctx.fillStyle = "#111"; ctx.fillRect(0, 0, 16, 9); return; }
  const page = await doc.getPage(n);
  const box = canvas.parentElement.clientWidth || 360;
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (box / v1.width) * (devicePixelRatio || 1) });
  canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
  await page.render({ canvas, viewport: vp }).promise;
}

function timer(lv, talk) {
  const left = Math.round((talk.durationMin * 60_000 - (Date.now() - lv.startedAt)) / 1000);
  const a = Math.abs(left);
  return { text: (left < 0 ? "+" : "") + Math.floor(a / 60) + ":" + String(a % 60).padStart(2, "0"), cls: left < 0 ? "over" : left < 300 ? "warn" : "" };
}

async function load() {
  try {
    const res = await fetch(base, { cache: "no-store" });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    info = d; error = null;
  } catch (e) { error = e.message; }
  render();
}
async function loadQuestions() {
  try { const res = await fetch(`${base}/questions`, { cache: "no-store" }); if (res.ok) { questions = (await res.json()).questions; render(); } } catch {}
}

async function send(cmd) {
  navigator.vibrate?.(12);
  try {
    const res = await fetch(`${base}/cmd`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error);
  } catch (e) { flashConn(e.message || t({ cs: "Nepodařilo se odeslat", en: "Couldn't send" })); }
}
function flashConn(text) { const c = $("conn"); c.textContent = text; setTimeout(drawConn, 2500); }
function drawConn() {
  const c = $("conn");
  c.className = "conn" + (live.connected ? " on" : "");
  c.textContent = live.connected ? t({ cs: "sál připojený", en: "room connected" }) : t({ cs: "sál nepřipojený", en: "room offline" });
}

function drawMessage() {
  const box = $("rmsg"), m = live.state?.message;
  box.hidden = !m;
  if (!m) return;
  box.textContent = m.text;
  if (m.at !== msgAt) { msgAt = m.at; box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash"); navigator.vibrate?.([80, 60, 80]); }
}

// questions on the screen: tick them off here; answered ones drop below (hatched) with "Bring back"
function answerList(talk) {
  const all = questions[talk.id] || [];
  const open = all.filter(q => !q.answered), done = all.filter(q => q.answered);
  const item = q => `<li class="qa ${q.answered ? "done" : ""}"><b>${q.votes}</b><span>${esc(q.text)}</span>
    <button data-ans="${q.id}" data-v="${q.answered ? 0 : 1}">${q.answered ? t({ cs: "Vrátit", en: "Bring back" }) : t({ cs: "✓ Zodpovězeno", en: "✓ Answered" })}</button></li>`;
  return `<div class="notes qalist"><div class="lbl">${t({ cs: "Dotazy na plátně", en: "Questions on screen" })} · ${open.length}${done.length ? ` · ${t({ cs: "zodpovězeno", en: "answered" })} ${done.length}` : ""}</div>
    ${all.length ? `<ol>${open.map(item).join("")}${done.map(item).join("")}</ol>` : `<p class="dim">${t({ cs: "Zatím žádné dotazy.", en: "No questions yet." })}</p>`}</div>`;
}
async function answer(id, answered) {
  navigator.vibrate?.(12);
  try {
    const res = await fetch(`${base}/questions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answered }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error);
    await loadQuestions();
  } catch (e) { flashConn(e.message || t({ cs: "Nepodařilo se odeslat", en: "Couldn't send" })); }
}

function questionsHTML(talk) {
  if (!talk.qaEnabled) return "";
  const open = (questions[talk.id] || []).filter(q => !q.answered);
  if (!open.length) return "";
  return `<div class="qs"><div class="lbl">${t({ cs: "Dotazy z publika", en: "Audience questions" })} · ${open.length}</div>
    ${open.slice(0, 6).map(q => `<div class="q"><b>${q.votes}</b><span>${esc(q.text)}</span></div>`).join("")}</div>`;
}

async function render() {
  document.title = t({ cs: "Monitor řečníka · FckScrn", en: "Speaker monitor · FckScrn" });
  drawConn();
  drawMessage();
  if (error && !info) { app.innerHTML = `<p class="standby">${esc(error)}</p>`; return; }
  if (!info) return;
  $("room").textContent = [info.room.name, info.event.name].filter(Boolean).join(" · ");
  if (!$("help").classList.contains("sent")) $("help").textContent = t({ cs: "Pomoc", en: "Help" });

  const lv = live.state?.live;
  const talk = lv && info.talks.find(x => x.id === lv.talkId);
  const pdf = live.connected && lv?.mode === "pdf";
  for (const id of ["prev", "next"]) $(id).disabled = !pdf;
  // the next click starts a video on this slide: say so on the big button
  const vidWaiting = pdf && lv.video === "waiting";
  // last slide (or questions already up): the big button puts the audience questions on the screen / takes them off
  const qaBtn = pdf && !vidWaiting && talk?.qaEnabled && (lv.showQuestions || lv.page >= lv.pages);
  $("next").textContent = vidWaiting ? t({ cs: "▶ Spustit video", en: "▶ Play video" })
    : qaBtn ? (lv.showQuestions ? t({ cs: "Skrýt dotazy z plátna", en: "Hide questions" }) : t({ cs: "Dotazy na plátno", en: "Questions on screen" }))
    : t({ cs: "Další →", en: "Next →" });
  $("next").dataset.cmd = qaBtn ? "showQuestions" : "next";

  // rebuild only when the slide or talk changes; timer ticks in place
  const key = JSON.stringify([live.connected, lv?.talkId, lv?.mode, lv?.page, lv?.pages, lv?.black, lv?.video, live.state?.nextTalkId, (lv?.mode === "panel" || lv?.showQuestions) && talk && questions[talk.id], lv?.showQuestions, info.talks.map(x => [x.id, x.version, x.notes])]);
  if (key === drawn) return tick();
  drawn = key;

  if (!live.connected) {
    app.innerHTML = `<div class="standby"><div class="lbl">${t({ cs: "Čekám na sál", en: "Waiting for the room" })}</div>
      <h1>${t({ cs: "Počítač v sále není připojený", en: "The room computer isn't connected" })}</h1>
      <p class="hint">${t({ cs: "Až technik spustí player a bude mít internet, telefon se připojí sám.", en: "Once the technician starts the player and it's online, the phone connects by itself." })}</p></div>`;
    return;
  }
  if (talk && lv.mode === "break") {
    // the break is what's on: big; what comes after it: small underneath
    const next = info.talks.find(x => x.id === live.state?.nextTalkId);
    app.innerHTML = `<div class="standby brk">
      <div class="lbl">${t({ cs: "Teď běží", en: "Now" })}</div>
      <h1>${esc(talk.title)}</h1>
      <div class="timer" id="tm"></div>
      ${next ? `<div class="then"><div class="lbl">${t({ cs: "Potom", en: "Then" })}</div><b>${esc(next.title)}</b>
        <span class="dim">${esc([next.kind === "panel" ? t({ cs: "Panel", en: "Panel" }) : next.speaker, next.startsAt, `${next.durationMin} min`].filter(Boolean).join(" · "))}</span></div>` : ""}
    </div>`;
    return tick();
  }
  if (!talk || lv.mode === "native") {
    const next = info.talks.find(x => x.id === live.state?.nextTalkId);
    app.innerHTML = `<div class="standby">
      <div class="lbl">${lv?.mode === "break" && talk ? esc(talk.title) : lv?.mode === "native" && talk ? t({ cs: "Běží v PowerPointu", en: "Running in PowerPoint" }) : t({ cs: "Další na řadě", en: "Up next" })}</div>
      ${talk && lv.mode === "break" ? `<div class="timer" id="tm"></div>` : ""}
      <h1>${esc(lv?.mode === "native" && talk ? talk.title : next ? next.title : t({ cs: "Teď nic neběží", en: "Nothing running" }))}</h1>
      ${next && lv?.mode !== "native" ? `<p class="dim">${esc([next.speaker, next.startsAt, `${next.durationMin} min`].filter(Boolean).join(" · "))}</p>` : ""}
      ${lv?.mode === "native" ? `<p class="hint">${t({ cs: "Slidy teď ovládá PowerPoint nebo Keynote na počítači v sále.", en: "PowerPoint or Keynote on the room computer runs the slides now." })}</p>` : ""}
    </div>`;
    return tick();
  }
  if (lv.mode === "panel") {
    app.innerHTML = `<div class="lbl">${t({ cs: "Panelová diskuse", en: "Panel discussion" })}</div>
      <h1>${esc(talk.title)}</h1>
      <div class="timer" id="tm"></div>
      <ul class="people">${talk.panelists.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
      ${talk.moderator ? `<p class="dim">${t({ cs: "Moderuje", en: "Moderator" })}: ${esc(talk.moderator)}</p>` : ""}
      ${questionsHTML(talk)}`;
    return tick();
  }
  // notes first: they are what the speaker reads; slides are a small strip under them
  const note = talk.notes?.[lv.page - 1] || "";
  const qa = talk.qaEnabled && lv.showQuestions;
  const first = lv.page <= 1, last = lv.page >= lv.pages;
  app.innerHTML = `
    <div class="head"><div class="timer" id="tm"></div><div class="htitle"><span class="lbl">${t({ cs: "Teď", en: "Now" })} · ${lv.page} / ${lv.pages}</span><b>${esc(talk.title)}</b></div></div>
    ${qa ? answerList(talk) : `<div class="notes ${note ? "" : "none"}">${note ? esc(note) : t({ cs: "K tomuto slidu nemáte poznámky.", en: "No notes for this slide." })}</div>`}
    <div class="carousel">
      <button class="cs side" id="cprev" ${first ? "disabled" : ""} aria-label="${t({ cs: "Předchozí slide", en: "Previous slide" })}"><div class="slot"><canvas id="pv"></canvas></div><span>${first ? "" : `← ${lv.page - 1}`}</span></button>
      <div class="cs cur"><div class="slot"><canvas id="cur"></canvas>${lv.black ? `<span class="badge">${t({ cs: "ZATEMNĚNO", en: "BLACKED OUT" })}</span>` : ""}</div><span>${lv.video === "waiting" ? t({ cs: "▷ video čeká", en: "▷ video ready" }) : lv.video === "playing" ? t({ cs: "▶ video hraje", en: "▶ video playing" }) : t({ cs: "Na projekci", en: "On screen" })}</span></div>
      <button class="cs side" id="cnext" ${last ? "disabled" : ""} aria-label="${t({ cs: "Další slide", en: "Next slide" })}"><div class="slot"><canvas id="nx"></canvas></div><span>${last ? t({ cs: "Konec", en: "End" }) : `${lv.page + 1} →`}</span></button>
    </div>`; // no audience questions mid-talk: they distract, Q&A comes at the end
  app.querySelectorAll("[data-ans]").forEach(b => (b.onclick = () => answer(+b.dataset.ans, b.dataset.v === "1")));
  $("cprev").onclick = () => send("prev");
  $("cnext").onclick = () => send("next");
  tick();
  const doc = await docOf(talk);
  await Promise.all([draw($("pv"), doc, lv.page - 1), draw($("cur"), doc, lv.page), draw($("nx"), doc, lv.page + 1)]);
}

function tick() {
  const lv = live.state?.live, el = $("tm");
  const talk = lv && info?.talks.find(x => x.id === lv.talkId);
  if (!el || !talk || !lv.startedAt) return;
  const { text, cls } = timer(lv, talk);
  el.textContent = text; el.className = "timer " + cls;
}

// live state from the room
function connect() {
  const es = new EventSource(`${base}/live`);
  es.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type !== "state") return;
    const talkChanged = m.state?.live?.talkId !== live.state?.live?.talkId;
    live = m;
    if (talkChanged && m.state?.live?.talkId && !info?.talks.some(x => x.id === m.state.live.talkId)) load(); // programme changed
    render();
  };
  es.onerror = () => { live = { ...live, connected: false }; render(); };
}

// keep the phone awake on stage
let lock = null;
async function stayAwake() { try { if (document.visibilityState === "visible" && !lock) { lock = await navigator.wakeLock?.request("screen"); lock?.addEventListener("release", () => (lock = null)); } } catch {} }
document.addEventListener("visibilitychange", stayAwake);
document.addEventListener("click", stayAwake, { once: true });

// "Help": the room technician (and the organizer) get an alert; one tap, no menus
$("help").onclick = async () => {
  navigator.vibrate?.(30);
  const b = $("help");
  try {
    const res = await fetch(`${base}/help`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error);
    b.textContent = t({ cs: "Technik ví", en: "Technician notified" }); b.classList.add("sent");
    setTimeout(() => { b.textContent = t({ cs: "Pomoc", en: "Help" }); b.classList.remove("sent"); }, 20_000);
  } catch (e) { flashConn(e.message || t({ cs: "Nepodařilo se odeslat", en: "Couldn't send" })); }
};
$("prev").onclick = () => send("prev");
$("next").onclick = () => {
  const c = $("next").dataset.cmd || "next";
  send(c);
  // a room player opened before an update doesn't know this command yet: say so instead of doing nothing
  if (c === "showQuestions") {
    const before = !!live.state?.live?.showQuestions;
    setTimeout(() => { if (!!live.state?.live?.showQuestions === before) flashConn(t({ cs: "Sál příkaz nepřevzal. Obnovte stránku playeru v sále.", en: "The room didn't take it. Reload the room player." })); }, 4000);
  }
};
addEventListener("resize", () => { drawn = ""; render(); });

await load();
connect();
stayAwake();
loadQuestions();
setInterval(loadQuestions, 5000);
setInterval(load, 60_000);
setInterval(tick, 500);
