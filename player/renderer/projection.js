import { loadDoc, draw, bindKeys, subscribe, env } from "./shared.js";
import { showing, pickSink } from "./videos.mjs";
import { Loop } from "./loop.js";
import { L } from "./i18n.js";

const $ = id => document.getElementById(id);
const loop = new Loop($("loop"));
let last = null;
let bgKey = "";

const endTime = (start, min) => {
  if (!start) return "";
  const [h, m] = start.split(":").map(Number), e = h * 60 + m + min;
  return `${String(Math.floor(e / 60) % 24).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`;
};
const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function render(s) {
  last = s;
  // unpaid hosted event: diagonal watermark over everything the audience sees
  $("wm").hidden = !s.watermark;
  $("wmtext").textContent = L("ZKUŠEBNÍ REŽIM · FckScrn", "TRIAL MODE · FckScrn");
  const live = s.live;
  const current = live && s.talks.find(t => t.id === live.talkId);
  const talk = live?.mode === "pdf" && current;
  const panel = live?.mode === "panel" && current;
  const brk = live?.mode === "break" && current;

  $("slide").hidden = !talk || live.black;
  if (!talk) renderVideos(null);
  renderPanel(panel, s);
  renderQa(current, live, s);
  const idle = !talk && !panel;

  // between talks and during breaks: partner loop if there is one, otherwise a calm black card
  const useLoop = idle && s.loopEnabled && s.loop.length > 0;
  $("loop").hidden = !useLoop;
  $("standby").hidden = !idle || useLoop;
  $("bar").hidden = !useLoop;
  if (useLoop) loop.play(s.loop); else loop.stop();

  if (idle) {
    const next = s.talks.find(t => t.id === s.nextTalkId);
    if (brk) {
      const back = s.talks.find(t => t.id === s.nextTalkId);
      $("bar").innerHTML = `<b>${escape(brk.title)}</b>${back?.startsAt || brk.startsAt ? ` · ${L("pokračujeme v", "back at")} ${back?.startsAt || endTime(brk.startsAt, brk.durationMin)}` : ""}`;
      $("ev").textContent = s.event?.name || "";
      $("ti").textContent = brk.title;
      $("sp").textContent = back ? `${L("Pokračujeme", "Back")} ${back.startsAt ? L("v ", "at ") + back.startsAt : L("za chvíli", "shortly")}: ${back.title}` : "";
    } else {
      $("bar").innerHTML = next ? `${L("Další", "Next")}: <b>${escape(next.title)}</b>${next.speaker ? " · " + escape(next.speaker) : ""}${next.startsAt ? " · " + next.startsAt : ""}` : escape(s.event?.name || "");
      $("ev").textContent = s.event?.name || "";
      $("ti").textContent = next ? next.title : "";
      $("sp").textContent = next ? [next.speaker, next.startsAt].filter(Boolean).join(" · ") : "";
    }
    return;
  }
  if (talk) {
    const doc = await loadDoc(talk);
    if (doc && doc.numPages !== live.pages) fck.cmd("pages", doc.numPages);
    await draw($("c"), doc, live.page);
    if (last === s) renderVideos(talk, live, s);
  }
}

// ---------- videos on the slide ----------
// Kept across renders (a re-render must not restart a playing video); gone when the slide changes.
const vids = new Map(); // key → element
let devices = [];
async function loadDevices() {
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput"); } catch { devices = []; }
  if (last) applySink(last);
}
navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);
loadDevices();

let namesAt = 0;
function applySink(s) {
  if ((s.audioNames || 0) !== namesAt) { namesAt = s.audioNames || 0; loadDevices(); return; }
  const proj = s.displays?.find(d => d.role === "proj");
  const id = pickSink(devices, s.audioOutput, proj?.label);
  for (const el of vids.values()) if (el.tagName === "VIDEO" && el.sinkId !== id) el.setSinkId?.(id).catch(() => {});
}

function renderVideos(talk, live, s) {
  // black screen: videos pause (an online player can't be paused from here, so it goes)
  const want = talk ? showing(live, talk).filter(v => !(live.black && v.kind === "online")) : [];
  const key = v => `${talk.id}:${talk.version}:${live.page}:${v.i}:${v.stamp || ""}`;
  const keys = new Set(want.map(key));
  for (const [k, el] of vids) if (!keys.has(k)) { if (el.tagName === "VIDEO") { el.pause(); el.removeAttribute("src"); el.load(); } el.remove(); vids.delete(k); }
  if (!talk) return;
  const box = $("vids"), c = $("c").getBoundingClientRect();
  Object.assign(box.style, { left: c.left + "px", top: c.top + "px", width: c.width + "px", height: c.height + "px" });
  for (const v of want) {
    let el = vids.get(key(v));
    if (!el) {
      if (v.kind === "online") {
        el = document.createElement("iframe");
        el.allow = "autoplay; fullscreen";
        el.referrerPolicy = "origin"; // the players need to know the site; never the secret room link
        el.src = v.url + (v.url.includes("?") ? "&" : "?") + "autoplay=1&rel=0";
      } else {
        el = document.createElement("video");
        Object.assign(el, { src: env.videoUrl(talk, v), autoplay: true, playsInline: true });
      }
      Object.assign(el.style, { left: v.x * 100 + "%", top: v.y * 100 + "%", width: v.w * 100 + "%", height: v.h * 100 + "%" });
      vids.set(key(v), el);
      box.append(el);
    }
    if (el.tagName === "VIDEO") { if (live.black) el.pause(); else if (el.paused && !el.ended) el.play().catch(() => {}); }
  }
  applySink(s);
}

// panel: the organizer's background (still or looping video), or a generated title slide
function renderPanel(panel, s) {
  const box = $("panel");
  box.hidden = !panel;
  if (!panel) { if (bgKey) { $("panelbg").replaceChildren(); bgKey = ""; } return; }
  const hasBg = panel.background && panel.local?.bg !== false;
  const key = `${panel.id}:${hasBg ? panel.files?.background : "card"}`;
  if (key !== bgKey) {
    bgKey = key;
    const holder = $("panelbg");
    holder.replaceChildren();
    if (hasBg) {
      const el = document.createElement(panel.background === "video" ? "video" : "img");
      el.src = env.bgUrl(panel);
      if (el.tagName === "VIDEO") Object.assign(el, { muted: true, autoplay: true, loop: true, playsInline: true });
      holder.append(el);
    }
  }
  $("panelcard").hidden = !!hasBg;
  $("panelcard").innerHTML = `
    <div class="pc-ev">${escape(s.event?.name || "")}</div>
    <div class="pc-kind">${L("Panelová diskuse", "Panel discussion")}</div>
    ${panel.title && panel.title !== "Panelová diskuse" ? `<div class="pc-title">${escape(panel.title)}</div>` : ""}
    <ul class="pc-people">${panel.panelists.map(n => `<li>${escape(n)}</li>`).join("")}</ul>
    ${panel.moderator ? `<div class="pc-mod">${L("Moderuje", "Moderated by")} ${escape(panel.moderator)}</div>` : ""}`;
}

// Q&A: small QR in the top-left corner; on request the open questions over the whole screen
function renderQa(current, live, s) {
  const on = current && current.kind !== "break" && current.qaEnabled && current.qaQr;
  const list = on ? (s.questions?.[current.id] || []).filter(q => !q.answered) : [];
  const poll = current && s.polls?.[current.id];
  $("qa").hidden = !on || live.hideQr || live.black || live.showQuestions || live.showPoll;
  $("qalist").hidden = !current || !((on && live.showQuestions) || (live.showPoll && poll));
  if (live.showPoll && poll && current) return renderPoll(current, poll);
  if (!on) return;
  if ($("qa").dataset.talk !== String(current.id)) {
    $("qa").dataset.talk = current.id;
    $("qaqr").innerHTML = current.qaQr;
  }
  $("qatext").innerHTML = `<b>${L("Máte dotaz?", "Got a question?")}</b><span>${L("Naskenujte", "Scan me")}${list.length ? ` · ${list.length}` : ""}</span>`;
  if (live.showQuestions) {
    $("qalist").innerHTML = `<div class="ql-head"><b>${L("Dotazy z publika", "Audience questions")}</b><span>${escape(current.title)}</span></div>
      ${list.length ? `<ol>${list.slice(0, 6).map(q => `<li><span class="ql-v">${q.votes}</span><div><p>${escape(q.text)}</p><span>${escape(q.author || L("Anonym", "Anonymous"))}</span></div></li>`).join("")}</ol>`
        : `<p class="ql-empty">${L("Zatím žádné dotazy. Naskenujte QR kód a zeptejte se.", "No questions yet. Scan the QR code and ask.")}</p>`}
      <div class="ql-qr">${current.qaQr}</div>`;
  }
}

function renderPoll(current, poll) {
  const max = Math.max(1, ...poll.results.map(r => r.votes));
  $("qalist").innerHTML = `<div class="ql-head"><b>${escape(poll.question)}</b><span>${poll.total} ${L("hlasů", "votes")}${poll.open ? "" : " · " + L("hlasování skončilo", "poll closed")}</span></div>
    ${!poll.total ? `<p class="ql-empty">${L("Naskenujte QR kód a hlasujte.", "Scan the QR code and vote.")}</p>`
      : poll.kind === "words" ? `<div class="pj-cloud">${poll.results.map(r => `<span style="font-size:${(2.6 + 6 * (r.votes / max)).toFixed(1)}vh">${escape(r.label)}</span>`).join(" ")}</div>`
      : `<div class="pj-bars">${poll.results.map(r => { const pct = Math.round((r.votes / poll.total) * 100); return `<div class="pj-bar"><div class="pl"><span>${escape(r.label)}</span><b>${pct} %</b></div><div class="track"><i style="width:${pct}%"></i></div></div>`; }).join("")}</div>`}
    ${current.qaQr ? `<div class="ql-qr">${current.qaQr}</div>` : ""}`;
}

bindKeys();
subscribe(render);
addEventListener("resize", () => last && render(last));
