// Public event page (after the event): programme + slides the speakers agreed to share.
import { $, esc } from "./common.js";
import { lang, t, langSwitch } from "./i18n.js";
import { nowNext, whoOf } from "./nownext.js";

const token = decodeURIComponent(location.pathname.split("/")[2] || "");
const base = `/api/public/${token}`;
const app = $("#app");
let data = null, error = null, now = null;

let pdfjs = null;
async function firstSlide(canvas, url) {
  try {
    if (!pdfjs) {
      pdfjs = await import("/vendor/pdfjs/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
    }
    const doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: ((canvas.parentElement.clientWidth || 220) / v1.width) * (devicePixelRatio || 1) });
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await page.render({ canvas, viewport: vp }).promise;
  } catch {}
}

const dateText = d => { const x = new Date(d + "T12:00:00"); return isNaN(x) ? d : x.toLocaleDateString(lang === "en" ? "en-GB" : "cs-CZ", { day: "numeric", month: "long", year: "numeric" }); };
const slidesText = n => lang === "en" ? `${n} slide${n === 1 ? "" : "s"}` : `${n} ${n === 1 ? "slide" : n >= 2 && n <= 4 ? "slidy" : "slidů"}`;

function talkHTML(x) {
  const who = x.kind === "panel"
    ? [x.moderator && `${t({ cs: "moderuje", en: "moderator" })} ${x.moderator}`, x.panelists.join(", ")].filter(Boolean).join(" · ")
    : x.speaker || "";
  return `<article class="ptalk">
    <span class="t">${esc(x.startsAt || "")}</span>
    <div>
      <h2>${x.kind === "panel" ? `${t({ cs: "Panel", en: "Panel" })}: ` : ""}${esc(x.title)}</h2>
      ${who ? `<div class="sp">${esc(who)}</div>` : ""}
      ${x.slides ? `<div class="acts"><a class="btn small primary" href="${esc(x.slides)}" target="_blank" rel="noopener">${t({ cs: "Slidy (PDF)", en: "Slides (PDF)" })}${x.pageCount ? ` · ${slidesText(x.pageCount)}` : ""}</a></div>` : ""}
    </div>
    ${x.slides ? `<a class="thumb" href="${esc(x.slides)}" target="_blank" rel="noopener" aria-label="${t({ cs: "Otevřít slidy", en: "Open slides" })}"><canvas data-pdf="${esc(x.slides)}"></canvas></a>` : "<span></span>"}
  </article>`;
}

function render() {
  $("#sub").textContent = t({ cs: "program a slidy", en: "programme and slides" });
  $("#credit").innerHTML = t({
    cs: `Prezentace na akci běžely přes <a href="/">FckScrn</a> · open source · vytvořil <b>Tomáš Foltas</b>, autor <a href="https://domee.app" rel="noopener">Domee.app</a>`,
    en: `Presentations at this event ran on <a href="/en">FckScrn</a> · open source · made by <b>Tomáš Foltas</b>, creator of <a href="https://domee.app" rel="noopener">Domee.app</a>`,
  });
  if (error) { app.innerHTML = `<p class="error">${esc(error)}</p>`; return; }
  if (!data) return;
  const { event, talks } = data;
  document.title = `${event.name} · ${t({ cs: "program a slidy", en: "programme and slides" })}`;
  const rooms = [...new Set(talks.map(x => x.room).filter(Boolean))];
  const shared = talks.filter(x => x.slides).length;
  app.innerHTML = `
    <div class="label">${t({ cs: "Program a slidy", en: "Programme and slides" })}</div>
    <h1>${esc(event.name)}</h1>
    ${nowHTML()}
    <p class="pmeta">${esc([event.date && dateText(event.date), event.place, shared && t({ cs: `slidy ke stažení: ${shared}`, en: `slides to download: ${shared}` })].filter(Boolean).join(" · "))}</p>
    ${(event.mode === "single" || rooms.length < 2 ? [null] : rooms).map(r => `
      ${r ? `<h2 class="room-h">${esc(r)}</h2>` : ""}
      ${talks.filter(x => !r || x.room === r).map(talkHTML).join("")}`).join("")}
    <div class="made"><span>${t({ cs: "Pořádáte akci? Ať prezentace prostě fungují.", en: "Running an event? Let the presentations just work." })}</span>
      <a class="btn primary" href="${lang === "en" ? "/en" : "/"}">${t({ cs: "Vyzkoušet FckScrn", en: "Try FckScrn" })}</a></div>`;
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { io.unobserve(en.target); firstSlide(en.target, en.target.dataset.pdf); } }), { rootMargin: "300px" });
  app.querySelectorAll("canvas[data-pdf]").forEach(c => io.observe(c));
}

// "Now / Next" on the event day: refreshed while the page is open
function nowHTML() {
  if (!now) return "";
  const W = { moderator: t({ cs: "moderuje", en: "moderator" }) };
  const rooms = now.rooms.map(r => ({ r, ...nowNext(r, now.event) })).filter(x => x.now || x.next);
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (!rooms.length || (now.event.date && now.event.date !== today && !rooms.some(x => x.live))) return "";
  return `<section class="nownext">${rooms.map(({ r, now: n, next }) => `
    <div class="nn">${now.rooms.length > 1 ? `<div class="label">${esc(r.name)}</div>` : ""}
      ${n ? `<div class="nn-now"><span class="nn-tag">${t({ cs: "Teď", en: "Now" })}</span><b>${esc(n.title)}</b><span class="muted">${esc(whoOf(n, W))}</span></div>` : ""}
      ${next ? `<div class="nn-next"><span class="nn-tag ghost">${esc(next.startsAt)}</span><b>${esc(next.title)}</b><span class="muted">${esc(whoOf(next, W))}</span></div>` : ""}
    </div>`).join("")}</section>`;
}
async function loadNow() {
  try { const res = await fetch(`${base}/now`, { cache: "no-store" }); if (res.ok) { now = await res.json(); render(); } } catch {}
}

try {
  const res = await fetch(base);
  const d = await res.json();
  if (!res.ok) throw new Error(d.error);
  data = d;
} catch (e) { error = e.message; }
langSwitch(render);
render();
loadNow();
setInterval(loadNow, 20_000);
