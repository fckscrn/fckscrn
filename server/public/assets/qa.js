// Audience Q&A (opened from the QR code on the projection): ask, vote, see answers.
import { $, esc, toast } from "./common.js";
import { t, langSwitch } from "./i18n.js";
import { resultsHTML } from "./poll-ui.js";

const token = decodeURIComponent(location.pathname.split("/")[2] || "");
const base = `/api/qa/${token}`;
const app = $("#app");
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
// anonymous id so one phone = one vote per question
let voter = store.get("fckscrn-voter");
if (!voter) { voter = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now(); store.set("fckscrn-voter", voter); }

let data = null, error = null, voted = new Set(), sending = false;

async function load() {
  try {
    const res = await fetch(`${base}?voter=${encodeURIComponent(voter)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    data = d; voted = new Set(d.voted); error = null;
  } catch (e) { error = e.message; }
  render();
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(d.error || "Error"), { code: d.code });
  return d;
}

const errText = e => ({
  slow_down: t({ cs: "Pomaleji, prosím. Zkuste to za chvíli.", en: "Slow down a little. Try again in a moment." }),
  qa_closed: t({ cs: "Dotazy k téhle přednášce jsou vypnuté.", en: "Questions are closed for this talk." }),
  qa_empty: t({ cs: "Napište dotaz.", en: "Write your question." }),
  poll_closed: t({ cs: "Hlasování už skončilo.", en: "The poll has ended." }),
  poll_empty: t({ cs: "Napište odpověď.", en: "Write your answer." }),
}[e.code] || e.message);

function who(talk) {
  if (talk.kind === "panel") return [talk.moderator && `${t({ cs: "moderuje", en: "moderated by" })} ${talk.moderator}`, talk.panelists.join(", ")].filter(Boolean).join(" · ");
  return talk.speaker || "";
}

function render() {
  document.title = t({ cs: "Dotazy · FckScrn", en: "Questions · FckScrn" });
  $("#sub").textContent = t({ cs: "dotazy z publika", en: "audience questions" });
  if (error && !data) { app.innerHTML = `<p class="error">${esc(error)}</p>`; return; }
  if (!data) return;
  const { event, talk, questions } = data;
  const open = questions.filter(q => !q.answered), done = questions.filter(q => q.answered);
  const draft = $("#q-text")?.value || "";
  const poll = data.poll;
  const pollHTML = !poll ? "" : `<section class="pollcard">
      <div class="label">${t({ cs: "Hlasování", en: "Poll" })}</div>
      <h2>${esc(poll.question)}</h2>
      ${poll.kind === "choice"
        ? (poll.mine == null
          ? `<div class="pollopts">${poll.options.map((o, i) => `<button class="btn big" data-pick="${i}">${esc(o)}</button>`).join("")}</div>`
          : `${resultsHTML(poll, { mine: poll.mine })}<div class="pollopts small">${poll.options.map((o, i) => `<button class="btn small ${poll.mine === String(i) ? "primary" : "ghost"}" data-pick="${i}">${esc(o)}</button>`).join("")}</div>
             <p class="muted">${t({ cs: "Díky za hlas. Můžete ho změnit.", en: "Thanks for voting. You can change your vote." })}</p>`)
        : `<form class="pollword"><input id="poll-word" maxlength="40" placeholder="${t({ cs: "Jedním slovem…", en: "In one word…" })}" value="${esc(poll.mine || "")}" autocomplete="off"><button class="btn primary">${poll.mine ? t({ cs: "Změnit", en: "Change" }) : t({ cs: "Odeslat", en: "Send" })}</button></form>
           ${poll.mine ? resultsHTML(poll) : ""}`}
    </section>`;
  const nameVal = $("#q-name")?.value ?? store.get("fckscrn-name") ?? "";

  app.innerHTML = `
    <div class="label">${esc(event.name)}</div>
    <h1>${esc(talk.title)}</h1>
    ${who(talk) ? `<p class="sub">${esc(who(talk))}</p>` : ""}
    ${pollHTML}

    ${talk.open ? `<form id="ask" class="ask">
      <label class="field"><span>${t({ cs: "Váš dotaz", en: "Your question" })}</span>
        <textarea id="q-text" name="text" rows="3" maxlength="400" required placeholder="${t({ cs: "Na co se chcete zeptat?", en: "What would you like to ask?" })}">${esc(draft)}</textarea></label>
      <label class="field"><span>${t({ cs: "Jméno (nepovinné, jinak anonymně)", en: "Name (optional, otherwise anonymous)" })}</span>
        <input id="q-name" name="author" maxlength="60" value="${esc(nameVal)}" autocomplete="name"></label>
      <button class="btn primary big" ${sending ? "disabled" : ""}>${sending ? t({ cs: "Odesílám…", en: "Sending…" }) : t({ cs: "Poslat dotaz", en: "Send question" })}</button>
    </form>` : `<p class="notice">${t({ cs: "Dotazy k téhle přednášce jsou uzavřené.", en: "Questions for this talk are closed." })}</p>`}

    <h2 class="qa-h">${t({ cs: "Dotazy", en: "Questions" })} <span class="muted">${questions.length}</span></h2>
    ${questions.length ? "" : `<p class="muted">${t({ cs: "Zatím žádné. Buďte první.", en: "None yet. Be the first." })}</p>`}
    <ul class="qlist">${[...open, ...done].map(q => `
      <li class="${q.answered ? "answered" : ""}">
        <button class="vote ${voted.has(q.id) ? "on" : ""}" data-vote="${q.id}" ${q.answered ? "disabled" : ""}
          aria-pressed="${voted.has(q.id)}" aria-label="${t({ cs: "Taky mě zajímá", en: "I want to know too" })}">
          <span class="arrow" aria-hidden="true"></span><b>${q.votes}</b></button>
        <div><p>${esc(q.text)}</p>
          <span class="muted">${esc(q.author || t({ cs: "Anonym", en: "Anonymous" }))}${q.answered ? ` · <b class="done">${t({ cs: "Zodpovězeno", en: "Answered" })}</b>` : ""}</span></div>
      </li>`).join("")}</ul>
    <p class="muted foot">${t({ cs: "Dotazy vidí všichni v sále, řečník i organizátor.", en: "Everyone in the room, the speaker and the organizer can see the questions." })}</p>`;

  const form = $("#ask");
  if (form) form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    store.set("fckscrn-name", f.author || "");
    sending = true; render();
    try {
      const d = await post(`${base}/questions`, f);
      data.questions = d.questions;
      $("#q-text") && ($("#q-text").value = "");
      sending = false; render();
      $("#q-text").value = "";
      toast(t({ cs: "Dotaz odeslán. Děkujeme!", en: "Question sent. Thank you!" }));
    } catch (err) { sending = false; render(); toast(errText(err)); }
  };
  const votePoll = async answer => {
    try { data.poll = (await post(`${base}/polls/${poll.id}/vote`, { voter, answer })).poll; render(); }
    catch (err) { toast(errText(err)); load(); }
  };
  app.querySelectorAll("[data-pick]").forEach(b => (b.onclick = () => votePoll(+b.dataset.pick)));
  const pw = app.querySelector(".pollword");
  if (pw) pw.onsubmit = e => { e.preventDefault(); const v = $("#poll-word").value.trim(); if (v) votePoll(v); };
  app.querySelectorAll("[data-vote]").forEach(b => (b.onclick = async () => {
    const id = +b.dataset.vote;
    try {
      const d = await post(`${base}/questions/${id}/vote`, { voter });
      data.questions = d.questions;
      d.voted ? voted.add(id) : voted.delete(id);
      render();
    } catch (err) { toast(errText(err)); }
  }));
}

langSwitch(render);
load();
// live: new questions and answers show up without reloading (paused while typing)
setInterval(() => { if (!document.activeElement?.closest("form") && !document.hidden) load(); }, 5000);
