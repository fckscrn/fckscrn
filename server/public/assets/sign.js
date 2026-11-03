// Door sign (/a/<event>/sal/<room>): open it on a TV or tablet next to the room and leave it.
import { nowNext, whoOf } from "./nownext.js";
import { lang } from "./i18n.js";

const [, , pt, , roomId] = location.pathname.split("/");
const T = lang === "en"
  ? { now: "Now", next: "Next", nothing: "Nothing on right now", end: "That's all for today", moderator: "moderator" }
  : { now: "Teď", next: "Další", nothing: "Teď tu nic neběží", end: "Pro dnešek je to všechno", moderator: "moderuje" };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let data = null;

async function load() {
  try { const res = await fetch(`/api/public/${pt}/now`, { cache: "no-store" }); if (res.ok) data = await res.json(); } catch {}
  draw();
}
// background only changes when the organizer uploads a new one: don't restart the video every refresh
let bgUrl = null;
function drawBackground() {
  const bg = document.getElementById("bg"), sign = data?.sign;
  if ((sign?.url || null) === bgUrl) return;
  bgUrl = sign?.url || null;
  bg.hidden = !sign;
  bg.innerHTML = "";
  if (!sign) return;
  if (sign.kind === "video") {
    // muted + play() explicitly: browsers only autoplay silent video, and only when told so in script
    const v = Object.assign(document.createElement("video"), { src: sign.url, muted: true, loop: true, autoplay: true, playsInline: true });
    v.setAttribute("muted", "");
    bg.append(v);
    v.play().catch(() => {});
  } else {
    bg.innerHTML = `<img src="${esc(sign.url)}" alt="">`;
  }
}
// a TV that was asleep or a tab in the background: resume the video when visible again
document.addEventListener("visibilitychange", () => document.querySelector("#bg video")?.play().catch(() => {}));

function draw() {
  drawBackground();
  const box = document.getElementById("s");
  const room = data?.rooms.find(r => r.id === +roomId);
  if (!room) { box.innerHTML = `<div class="room">FckScrn</div>`; return; }
  document.title = `${room.name} · ${data.event.name}`;
  const { now, next } = nowNext(room, data.event);
  const time = new Date().toTimeString().slice(0, 5);
  box.innerHTML = `
    <div class="top"><div class="room">${esc(room.name)}</div><div class="clock">${time}</div></div>
    <div class="now">${now
      ? `<div class="lbl">${T.now}</div><h1>${esc(now.title)}</h1><p>${esc(whoOf(now, T))}</p>`
      : `<div class="lbl">${esc(data.event.name)}</div><h1>${next ? T.nothing : T.end}</h1>`}</div>
    <div class="next">${next ? `<div class="lbl">${T.next}</div><h2><span>${esc(next.startsAt)}</span>${esc(next.title)}</h2><p>${esc(whoOf(next, T))}</p>` : ""}</div>
    <div class="foot"><span>${esc(data.event.name)}</span><span class="logo">Fck<span>Scrn</span></span></div>`;
}
// screens next to rooms stay on all day
try { navigator.wakeLock?.request("screen").catch(() => {}); } catch {}
load();
setInterval(load, 15_000);
setInterval(draw, 5_000);
