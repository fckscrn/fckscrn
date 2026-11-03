// Live poll box for the speaker page and the organizer's questions dialog:
// write a question (+ options, or none for one-word answers), start, see results, end.
import { esc, api, toast } from "./common.js";
import { t } from "./i18n.js";

/** results as bars (choice) or a simple word cloud (words) */
export function resultsHTML(p, { mine = null } = {}) {
  if (!p.total) return `<p class="muted poll-empty">${t({ cs: "Zatím nikdo nehlasoval.", en: "No votes yet." })}</p>`;
  if (p.kind === "words") {
    const max = Math.max(...p.results.map(r => r.votes));
    return `<div class="cloud">${p.results.map(r => `<span style="font-size:${(0.9 + 1.6 * (r.votes / max)).toFixed(2)}em">${esc(r.label)}</span>`).join(" ")}</div>`;
  }
  return `<div class="pbars">${p.results.map((r, i) => {
    const pct = Math.round((r.votes / p.total) * 100);
    return `<div class="pbar ${mine === String(i) ? "mine" : ""}"><div class="pl"><span>${esc(r.label)}${mine === String(i) ? " ✓" : ""}</span><b>${pct} %</b></div><div class="track"><i style="width:${pct}%"></i></div></div>`;
  }).join("")}</div>`;
}

/**
 * Mounts the poll box into `box`. base = API prefix for this talk's polls:
 * list/create at `${listUrl}`, open/close at `${itemUrl(id)}`.
 */
export function mountPolls(box, { listUrl, itemUrl }) {
  let polls = [], timer = null, formOpen = false;
  async function load() {
    try { polls = (await api("GET", listUrl)).polls; } catch {}
    draw();
  }
  function draw(force = false) {
    if (!box.isConnected) return; // not placed yet (or dialog closed: the owner calls stop())
    // don't wipe what someone is typing
    if (!force && box.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
    const live = polls.find(p => p.open);
    const last = !live && polls[0];
    box.innerHTML = `
      <div class="label">${t({ cs: "Hlasování", en: "Poll" })}</div>
      ${live ? `<div class="poll-live"><b>${esc(live.question)}</b> <span class="muted">· ${live.total} ${t({ cs: "hlasů", en: "votes" })}</span>
          ${resultsHTML(live)}
          <button class="btn small" data-end="${live.id}">${t({ cs: "Ukončit hlasování", en: "End poll" })}</button></div>`
        : last ? `<div class="poll-last"><span class="muted">${t({ cs: "Poslední", en: "Last" })}:</span> <b>${esc(last.question)}</b> <span class="muted">· ${last.total} ${t({ cs: "hlasů", en: "votes" })}</span>
          ${resultsHTML(last)}<button class="btn small ghost" data-reopen="${last.id}">${t({ cs: "Otevřít znovu", en: "Reopen" })}</button></div>` : ""}
      ${formOpen ? `<form class="poll-form">
          <label class="field"><span>${t({ cs: "Otázka", en: "Question" })}</span><input name="question" required maxlength="200" placeholder="${t({ cs: "Kolik z vás pracuje na dálku?", en: "How many of you work remotely?" })}"></label>
          <label class="field"><span>${t({ cs: "Možnosti, každá na nový řádek", en: "Options, one per line" })}</span>
            <textarea name="options" rows="3" placeholder="${t({ cs: "Ano\nNe\nNapůl", en: "Yes\nNo\nHalf the time" })}"></textarea>
            <small class="muted">${t({ cs: "Necháte-li prázdné, lidé odpoví jedním slovem a uvidíte mrak slov.", en: "Leave empty and people answer with one word, shown as a word cloud." })}</small></label>
          <div class="row"><button class="btn primary">${t({ cs: "Spustit hlasování", en: "Start poll" })}</button><button class="btn ghost" type="button" data-cancel>${t({ cs: "Zrušit", en: "Cancel" })}</button></div>
        </form>`
        : `<button class="btn small ${live ? "ghost" : ""}" data-new>${t({ cs: "+ Nové hlasování", en: "+ New poll" })}</button>`}
      <p class="muted small-note">${t({ cs: "Diváci hlasují přes stejný QR kód jako u dotazů. Výsledky jdou na plátno tlačítkem v ovládání sálu.", en: "The audience votes via the same QR code as questions. The room control puts results on the screen." })}</p>`;
    box.querySelector("[data-new]")?.addEventListener("click", () => { formOpen = true; draw(); box.querySelector("input[name=question]").focus(); });
    box.querySelector("[data-cancel]")?.addEventListener("click", () => { formOpen = false; draw(true); });
    box.querySelector(".poll-form")?.addEventListener("submit", async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { polls = (await api("POST", listUrl, f)).polls; formOpen = false; draw(true); toast(t({ cs: "Hlasování běží. Diváci ho uvidí přes QR kód.", en: "The poll is live. The audience sees it via the QR code." })); }
      catch (err) { toast(err.message); }
    });
    box.querySelectorAll("[data-end],[data-reopen]").forEach(b => (b.onclick = async () => {
      const id = b.dataset.end || b.dataset.reopen;
      try { polls = (await api("PATCH", itemUrl(id), { open: !!b.dataset.reopen })).polls; draw(); } catch (err) { toast(err.message); }
    }));
  }
  load();
  timer = setInterval(load, 4000);
  // show: draw now (after the box was placed into the page)
  return { stop: () => clearInterval(timer), show: () => draw() };
}
