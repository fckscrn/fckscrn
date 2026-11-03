// Speaker monitor view: time + slides on the left, the speaker's notes as the main thing on the right.
// Used by the speaker monitor window and by the control window in "control + speaker monitor" mode.
import { loadDoc, draw, timerText, hhmm, esc } from "./shared.js";
import { L } from "./i18n.js";
import { showing, waiting } from "./videos.mjs";

const MARKUP = `
  <div class="pres talkview" id="pres">
    <div class="side">
      <div><div class="lbl" id="timerlbl">Zbývá</div><div class="timer mono" id="timer">0:00</div><div class="clockline" id="clock"></div></div>
      <div class="slot curslot"><canvas id="cur"></canvas><span class="blackbadge" id="blk" hidden>PROJEKCE ZATEMNĚNA</span><span class="vidbadge" id="vid" hidden></span><span class="count" id="count"></span></div>
      <div class="pn">
        <div><div class="slot"><canvas id="prev"></canvas></div><div class="lbl" id="prevlbl">Předchozí</div></div>
        <div><div class="slot"><canvas id="next"></canvas></div><div class="lbl" id="nextlbl">Další</div></div>
      </div>
    </div>
    <div class="main">
      <div class="lbl" id="curlbl">Teď</div>
      <div class="notesbox" id="notesbox"><div class="notes" id="notes"></div></div>
      <div class="qabox" id="qabox" hidden></div>
      <div class="msgslot" id="msgslot"></div>
    </div>
  </div>
  <div class="pres panelview" id="panelview" hidden>
    <div class="pv-left"><div class="lbl" id="pvlbl"></div><div class="pv-topic" id="pvtopic"></div><ul class="pv-people" id="pvpeople"></ul><div class="pv-mod" id="pvmod"></div></div>
    <div class="right"><div><div class="lbl" id="pvtimerlbl"></div><div class="timer mono" id="pvtimer">0:00</div><div class="clockline" id="pvclock"></div></div><div class="pq" id="pvq"></div></div>
  </div>
  <div class="spkmsg" id="spkmsg" hidden role="alert"></div>
  <div class="full" id="standby" hidden><div class="standby"><div class="ev" id="standby-label">Další na řadě</div><div class="ti" id="ti"></div><div class="sp" id="sp"></div><div class="sp mono" id="clock2"></div></div></div>`;

export function mountPresenter(root) {
  root.insertAdjacentHTML("beforeend", MARKUP);
  const $ = id => root.querySelector("#" + id);
  // tick off a question (or bring it back after a misclick), from the speaker monitor itself
  root.addEventListener("click", e => {
    const b = e.target.closest("[data-ans]");
    if (b) fck.cmd("answer", { id: +b.dataset.ans, answered: b.dataset.v === "1" });
  });
  let last = null;
  // a message from the technician or organizer ("5 minutes left"): big, on top, flashes when new
  let msgAt = 0;
  function drawMessage(s) {
    const box = $("spkmsg"), m = s.message;
    box.hidden = !m;
    // during a talk it sits under the notes, so it never covers them; elsewhere on top
    const slot = !$("pres").hidden ? $("msgslot") : root;
    if (box.parentElement !== slot) slot.append(box);
    $("pres").classList.toggle("hasmsg", !!m && slot !== root);
    if (!m) return;
    box.textContent = m.text;
    if (m.at !== msgAt) { msgAt = m.at; box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash"); }
  }

  async function render(s) {
    last = s;
    const live = s.live?.mode === "pdf" ? s.live : null;
    const talk = live && s.talks.find(t => t.id === live.talkId);
    const panel = s.live?.mode === "panel" && s.talks.find(t => t.id === s.live.talkId);
    $("pres").hidden = !talk;
    $("panelview").hidden = !panel;
    $("standby").hidden = !!talk || !!panel;
    drawMessage(s);
    tick();

    if (panel) {
      $("pvlbl").textContent = L("Panelová diskuse", "Panel discussion");
      $("pvtopic").textContent = panel.title;
      $("pvpeople").innerHTML = panel.panelists.map(n => `<li>${esc(n)}</li>`).join("");
      $("pvmod").textContent = panel.moderator ? `${L("Moderuje", "Moderator")}: ${panel.moderator}` : "";
      $("pvtimerlbl").textContent = L(`Zbývá z ${panel.durationMin} min`, `Left of ${panel.durationMin} min`);
      drawQuestions($("pvq"), panel, s);
      return;
    }
    if (!talk) {
      const next = s.talks.find(t => t.id === s.nextTalkId);
      const brk = s.live?.mode === "break" && s.talks.find(t => t.id === s.live.talkId);
      $("standby-label").textContent = brk ? brk.title : L("Další na řadě", "Up next");
      if (brk) {
        $("ti").textContent = timerText(s.live, brk).text;
        $("sp").textContent = next ? `${L("Pak", "Then")}: ${next.title}` : "";
        return;
      }
      $("ti").textContent = next ? next.title : L("Žádná další přednáška", "No more talks");
      $("sp").textContent = next ? [next.speaker, next.startsAt && `${L("v", "at")} ${next.startsAt}`, `${next.durationMin} min`].filter(Boolean).join(" · ") : "";
      return;
    }
    $("curlbl").textContent = `${L("Teď", "Now")} · ${talk.title}`;
    $("nextlbl").textContent = live.page < live.pages ? `${L("Další", "Next")} · ${live.page + 1}` : L("Poslední slide", "Last slide");
    $("prevlbl").textContent = live.page > 1 ? `${L("Předchozí", "Previous")} · ${live.page - 1}` : "";
    $("blk").textContent = L("PROJEKCE ZATEMNĚNA", "PROJECTION BLACKED OUT");
    $("count").textContent = `${live.page} / ${live.pages}`;
    $("blk").hidden = !live.black;
    // the speaker knows the next click plays the video, not the next slide
    const playing = showing(live, talk).length > 0, next = waiting(live, talk);
    $("vid").hidden = !playing && !next;
    $("vid").className = "vidbadge" + (playing ? " on" : "");
    $("vid").textContent = next ? L("▷ VIDEO · SPUSTÍ SE KLIKNUTÍM", "▷ VIDEO · NEXT CLICK PLAYS IT") : L("▶ VIDEO SPUŠTĚNO", "▶ VIDEO STARTED");
    $("timerlbl").textContent = L(`Zbývá z ${talk.durationMin} min`, `Left of ${talk.durationMin} min`);
    // audience questions only once the technician puts them on the screen (Q&A at the end); mid-talk they'd distract
    const qa = talk.qaEnabled && live.showQuestions;
    $("qabox").hidden = !qa;
    if (qa) drawQuestions($("qabox"), talk, s);
    const note = talk.notes?.[live.page - 1] || "";
    $("notes").textContent = note || L("K tomuto slidu nemáte poznámky.", "No notes for this slide.");
    $("notes").classList.toggle("none", !note);
    fitNotes();

    const doc = await loadDoc(talk);
    await Promise.all([draw($("cur"), doc, live.page), draw($("prev"), doc, live.page - 1), draw($("next"), doc, live.page + 1)]);
  }

  // notes as large as they fit: the whole note is always visible, short ones are huge
  function fitNotes() {
    const box = $("notesbox"), el = $("notes");
    if ($("pres").hidden || !box.clientHeight) return;
    const vh = innerHeight / 100;
    let lo = 2.2 * vh, hi = (el.classList.contains("none") ? 3 : 9) * vh;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = mid + "px";
      if (el.scrollHeight <= box.clientHeight && el.scrollWidth <= box.clientWidth) lo = mid; else hi = mid;
    }
    el.style.fontSize = lo + "px";
  }

  // audience questions, most wanted first; answered ones drop below (hatched) and can be brought back
  function drawQuestions(box, talk, s) {
    if (!talk.qaEnabled) { box.innerHTML = ""; box.dataset.key = ""; return; }
    const all = s.questions?.[talk.id] || [];
    const open = all.filter(q => !q.answered), done = all.filter(q => q.answered);
    const key = JSON.stringify([all, document.documentElement.lang]);
    if (box.dataset.key === key) return; // keep the buttons steady under the pointer
    box.dataset.key = key;
    const item = q => `<li class="qa-item ${q.answered ? "done" : ""}"><b class="qa-v">${q.votes}</b>
      <div class="qa-t"><p>${esc(q.text)}</p>${q.author ? `<span>${esc(q.author)}</span>` : ""}</div>
      <button class="qa-btn" data-ans="${q.id}" data-v="${q.answered ? 0 : 1}">${q.answered ? L("Vrátit", "Bring back") : L("✓ Zodpovězeno", "✓ Answered")}</button></li>`;
    box.innerHTML = `<div class="lbl">${L("Dotazy z publika", "Audience questions")} · ${open.length}${done.length ? ` · ${L("zodpovězeno", "answered")} ${done.length}` : ""}</div>
      ${all.length ? `<ol class="qa-list">${open.map(item).join("")}${done.map(item).join("")}</ol>`
        : `<p class="qa-empty">${L("Zatím žádné dotazy.", "No questions yet.")}</p>`}`;
  }

  function tick() {
    const s = last;
    const live = s?.live?.mode === "pdf" ? s.live : null;
    const talk = live && s.talks.find(t => t.id === live.talkId);
    $("clock").textContent = $("clock2").textContent = hhmm();
    const brk = s?.live?.mode === "break" && s.talks.find(t => t.id === s.live.talkId);
    if (brk) $("ti").textContent = timerText(s.live, brk).text;
    const panel = s?.live?.mode === "panel" && s.talks.find(t => t.id === s.live.talkId);
    if (panel) {
      const { text, cls } = timerText(s.live, panel);
      $("pvtimer").textContent = text; $("pvtimer").className = "timer mono " + cls;
      $("pvclock").textContent = hhmm();
    }
    if (!talk) return;
    const { text, cls } = timerText(live, talk);
    const el = $("timer");
    el.textContent = text;
    el.className = "timer mono " + cls;
  }

  return { render, tick, refit: () => last && render(last) };
}
