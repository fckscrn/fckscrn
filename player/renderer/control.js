import { esc, hhmm, loadDoc, draw, bindKeys, subscribe, timerText } from "./shared.js";
import { L, lang, langSwitch } from "./i18n.js";
import { waiting, pickSink } from "./videos.mjs";
import { mountPresenter } from "./presenter-view.mjs";
const slides = n => lang === "en" ? `${n} slide${n === 1 ? "" : "s"}` : `${n} ${n === 1 ? "slide" : n >= 2 && n <= 4 ? "slidy" : "slidů"}`;

const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
// "both" (control + speaker monitor in this window) only with exactly two screens: laptop + projector
const ROLES = s => ({ proj: L("Projekce pro publikum", "Audience projection"),
  ...(s.displays.length === 2 ? { both: L("Ovládání + monitor řečníka", "Control + speaker monitor") } : {}),
  spk: L("Monitor řečníka", "Speaker monitor"), ctrl: L("Ovládání (toto okno)", "Control (this window)"), off: L("Nepoužívat", "Not used") });
let state = null;
let lastKey = "";

function render(s) {
  state = s;
  renderSync(s);
  if (!s.paired) return renderPair(s);

  // rebuild only when structure changes; live page/timer updates are patched in place
  const key = JSON.stringify([s.talks.map(t => [t.id, t.version, t.local, t.status, t.title, t.startsAt]), s.displays, s.live?.talkId, s.live?.mode, s.outputsOpen, s.nextTalkId, s.room, s.event, s.loop.length, s.loopEnabled, s.screenAccess, s.outputs, s.popupBlocked, s.watermark, s.remote?.url, s.billing, s.order, billOpen]);
  if (key !== lastKey) { lastKey = key; renderRoom(s); }
  renderLive(s);
  renderCombo(s);
  renderAudio(s);
  renderMessage(s);
  drawHelp(s);
}

const MESSAGES = () => lang === "en"
  ? ["5 minutes left", "2 minutes left", "Time's up, please wrap up", "Closer to the microphone, please"]
  : ["Ještě 5 minut", "Ještě 2 minuty", "Čas vypršel, prosím končete", "Mluvte víc do mikrofonu"];

// what's on the speaker monitor right now
function renderMessage(s) {
  const box = $("#msgnow");
  if (!box) return;
  const text = s.message?.text || "";
  if (box.dataset.text === text) return;
  box.dataset.text = text;
  box.hidden = !text;
  box.innerHTML = text ? `<span>„${esc(text)}“</span><button class="btn small" id="msgclear">${L("Smazat", "Clear")}</button>` : "";
  $("#msgclear")?.addEventListener("click", () => fck.cmd("message", null));
}

function renderSync(s) {
  $("#where").textContent = s.room ? `${s.room.name} · ${s.event?.name || ""}` : "";
  if (!s.paired) { $("#sync").innerHTML = ""; return; }
  const n = s.talks.filter(t => t.local.pdf || t.local.original).length;
  const txt = {
    syncing: s.sync.message,
    ok: `${L("Vše staženo", "All downloaded")} · ${n} ${L("prezentací", "presentations")}${s.sync.at ? ` · ${hhmm(new Date(s.sync.at))}` : ""}`,
    offline: s.sync.message || L("Offline. Používám stažené soubory.", "Offline. Using downloaded files."),
    idle: L("Připojuji…", "Connecting…"),
  }[s.sync.state];
  $("#sync").innerHTML = `<span class="dot ${s.sync.state}"></span><span>${esc(txt)}</span><button class="btn small" id="sync-now">${L("Synchronizovat", "Sync")}</button>`;
  $("#sync-now").onclick = () => fck.cmd("sync");
}

// hosted version: trial (watermark) → activate right here in the room → proforma with a QR to pay on the spot
let billOpen = false;
const billDraft = {};
function billingBox(s) {
  const b = s.billing;
  if (!b?.enabled || b.status === "paid") return "";
  const money = n => `${Number(n).toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} Kč`;
  if (b.status === "ordered") {
    const p = b.pay;
    return `<div class="billbox">
      <div><b>${L("Akce je aktivní", "The event is active")}</b>${p ? ` · ${L(`zálohová faktura ${esc(p.number)} čeká na úhradu`, `proforma ${esc(p.number)} awaiting payment`)}` : ""}</div>
      ${p ? `<div class="billpay">${p.qr ? `<div class="qr">${p.qr}</div>` : ""}
        <dl><dt>${L("Částka", "Amount")}</dt><dd class="mono">${money(p.amount)}</dd>
          <dt>${L("Účet", "Account")}</dt><dd class="mono">${esc(p.account)}</dd>
          <dt>${L("Variabilní symbol", "Reference (VS)")}</dt><dd class="mono">${esc(p.variableSymbol)}</dd></dl>
        <p class="hint">${L("Zaplatit jde hned teď QR kódem. Fakturu pak organizátor najde ve správě akce.", "Pay right now with the QR code. The organizer then finds the invoice in the event admin.")}</p></div>` : ""}
    </div>`;
  }
  const o = s.order || {};
  if (o.ares) { Object.assign(billDraft, { ico: o.ares.ico, name: o.ares.name, dic: o.ares.dic || "", street: o.ares.street, city: o.ares.city, zip: o.ares.zip }); s.order.ares = null; }
  const d = billDraft, v = k => esc(d[k] || "");
  const site = esc(s.server || "https://fckscrn.com"); // the room's server (web player: this site; desktop: the paired one)
  return `<div class="billbox trial">
    <div class="billhead"><div><b>${L("Zkušební režim", "Trial mode")}</b>
      <span>${L("Všechno funguje, jen na projekci je vodoznak. Aktivujte akci a zmizí hned.", "Everything works, the projection just shows a watermark. Activate the event and it's gone right away.")}</span></div>
      ${billOpen ? "" : `<button class="btn primary" id="bill-open">${L("Aktivovat akci", "Activate event")} · ${money(b.price)}</button>`}</div>
    ${billOpen ? `<form id="bill-form" class="billform">
      <div class="r"><label><span>${L("IČO", "Company ID")}</span><input name="ico" inputmode="numeric" maxlength="8" value="${v("ico")}"></label>
        <button class="btn" type="button" id="bill-ares" ${o.busy ? "disabled" : ""}>${L("Doplnit z ARES", "Fill in from ARES")}</button></div>
      <div class="r"><label class="g"><span>${L("Firma nebo jméno", "Company or name")}</span><input name="name" required value="${v("name")}"></label>
        <label><span>${L("DIČ (nepovinné)", "VAT ID (optional)")}</span><input name="dic" value="${v("dic")}"></label></div>
      <div class="r"><label class="g"><span>${L("Ulice a číslo", "Street and number")}</span><input name="street" required value="${v("street")}"></label>
        <label><span>${L("Město", "City")}</span><input name="city" required value="${v("city")}"></label>
        <label><span>${L("PSČ", "Postcode")}</span><input name="zip" required value="${v("zip")}"></label></div>
      <label><span>${L("E-mail pro fakturu", "E-mail for the invoice")}</span><input name="email" type="email" required value="${v("email")}"></label>
      <label class="chk"><input type="checkbox" name="terms" required ${d.terms ? "checked" : ""}>
        <span>${L(`Souhlasím s <a href="${site}/obchodni-podminky" target="_blank" rel="noopener">obchodními podmínkami</a> a beru na vědomí <a href="${site}/ochrana-udaju" target="_blank" rel="noopener">zpracování osobních údajů</a>.`,
          `I agree to the <a href="${site}/en/terms" target="_blank" rel="noopener">terms of service</a> and acknowledge the <a href="${site}/en/privacy" target="_blank" rel="noopener">privacy policy</a>.`)}</span></label>
      ${o.error ? `<p class="error">${esc(o.error)}</p>` : ""}
      <div class="r"><button class="btn primary" ${o.busy ? "disabled" : ""}>${o.busy ? L("Odesílám…", "Sending…") : `${L("Objednat a aktivovat", "Order and activate")} · ${money(b.price)}`}</button>
        <button class="btn ghost" type="button" id="bill-close">${L("Zrušit", "Cancel")}</button></div>
      <p class="hint">${L("Zálohová faktura se splatností 14 dní se vystaví hned a ukáže se tady s QR kódem. Nejsem plátce DPH, cena je konečná.", "A proforma due in 14 days is issued right away and shown here with a QR code. Not a VAT payer; the price is final.")}</p>
    </form>` : ""}
  </div>`;
}
function wireBilling() {
  $("#bill-open")?.addEventListener("click", () => { billOpen = true; lastKey = ""; render(state); });
  $("#bill-close")?.addEventListener("click", () => { billOpen = false; lastKey = ""; render(state); });
  const f = $("#bill-form");
  if (!f) return;
  const keep = () => { for (const el of f.elements) if (el.name) billDraft[el.name] = el.type === "checkbox" ? el.checked : el.value; };
  f.addEventListener("input", keep);
  $("#bill-ares").onclick = () => { keep(); if (billDraft.ico) fck.cmd("ares", billDraft.ico); };
  f.onsubmit = e => { e.preventDefault(); keep(); fck.cmd("order", { ...billDraft, terms: !!billDraft.terms }); };
}

function renderPair(s) {
  lastKey = "";
  if ($("#pair-url")) { $("#pair-err").hidden = !s.pairError; $("#pair-err").textContent = s.pairError || ""; return; }
  app.innerHTML = `<form class="pair" id="pair">
    <h1>${L("Připojit sál", "Connect a room")}</h1>
    <p class="muted">${L("Ve správě akce klikněte u sálu na <b>Připojit projekci</b> a vložte sem odkaz. Player pak stáhne všechny prezentace sálu a bude je průběžně aktualizovat.", "In the event admin, click <b>Connect projection</b> next to the room and paste the link here. The player then downloads all the room's presentations and keeps them up to date.")}</p>
    <input id="pair-url" placeholder="https://…/p/…" autofocus>
    <p class="error" id="pair-err" ${s.pairError ? "" : "hidden"}>${esc(s.pairError)}</p>
    <div><button class="btn primary big">${L("Připojit", "Connect")}</button></div>
    <p class="credit">${L("FckScrn vytvořil Tomáš Foltas, autor Domee.app – aplikace pro správu nemovitostí", "FckScrn is made by Tomáš Foltas, creator of Domee.app – a property management app")}</p>
  </form>`;
  $("#pair").onsubmit = e => { e.preventDefault(); fck.cmd("pair", $("#pair-url").value); };
}

function talkNote(t) {
  if (t.kind === "break") {
    const n = state.loop.length;
    return state.loopEnabled && n ? L(`Na projekci poběží smyčka partnerů (${n})`, `The partner loop will play on the projection (${n})`) : L("Na projekci bude černá s názvem další přednášky", "The projection shows black with the next talk");
  }
  if (t.kind === "panel") return [t.moderator && `${L("moderuje", "moderator")} ${t.moderator}`, t.panelists.join(", "),
    t.background ? L("vlastní pozadí", "own background") : L("slide s tématem a jmény", "slide with topic and names")].filter(Boolean).join(" · ");
  if (!t.version) return L("Řečník ještě nenahrál prezentaci", "The speaker hasn't uploaded yet");
  if (t.local.pdf) return t.issues.filter(i => i.level !== "ok").map(i => i.text).join(" ") || "";
  if (t.local.original) return L(`Spustí se v ${t.fileExt === "key" ? "Keynote" : "PowerPointu"}`, `Runs in ${t.fileExt === "key" ? "Keynote" : "PowerPoint"}`);
  if (state.platform === "web" && !t.hasPdf) return L("V prohlížeči jde spustit jen PDF verze. Požádejte řečníka o PDF, nebo použijte aplikaci FckScrn Player.", "Only a PDF version can run in the browser. Ask the speaker for a PDF or use the FckScrn Player app.");
  return L("Stahuje se…", "Downloading…");
}

function renderRoom(s) {
  const live = s.live;
  app.innerHTML = `<main>
    <div class="head">
      <div><div class="label">${esc(s.event?.name || "")}</div><h1>${esc(s.room?.name || L("Sál", "Room"))}</h1>
        ${s.platform === "web" ? `<p class="hint" style="margin:4px 0 0">${L("Tuhle záložku nechte otevřenou, ovládá projekci.", "Keep this tab open, it drives the projection.")}</p>` : ""}
        ${billingBox(s)}</div>
      <span class="clock" id="clock">${hhmm()}</span>
    </div>
    <div class="layout">
      <div>
        <div id="live"></div>
        ${s.talks.length ? s.talks.map(t => {
          const ready = t.kind === "break" || t.kind === "panel" || t.local.pdf || (t.local.original && s.platform !== "web");
          const isCur = live?.talkId === t.id;
          const isNext = !live && t.id === s.nextTalkId;
          return `<div class="q ${t.kind === "break" ? "brk" : ""} ${isCur ? "current" : ""} ${isNext ? "next" : ""}">
            <span class="t">${esc(t.startsAt || "–")}</span>
            <div><div class="ti">${esc(t.title)}</div>
              <div class="sp">${esc([t.kind === "break" ? L("Přestávka", "Break") : t.kind === "panel" ? L("Panel", "Panel") : t.speaker, `${t.durationMin} min`, t.local.pdf && t.pageCount ? slides(t.pageCount) : null].filter(Boolean).join(" · "))}</div>
              <div class="sp note">${esc(talkNote(t))}</div></div>
            <div>${isCur ? `<span class="label" style="color:inherit">${L("Běží", "Live")}</span>`
              : ready ? `<button class="btn ${isNext ? "primary big" : ""}" data-start="${t.id}">${isNext ? "▶ " : ""}${t.kind === "break" ? L("Spustit přestávku", "Start break") : t.kind === "panel" ? L("Spustit panel", "Start panel") : L("Spustit", "Start")}</button>` : ""}</div>
          </div>`;
        }).join("") : `<div class="empty">${L("V tomto sále zatím nejsou žádné přednášky. Přidejte je ve správě akce.", "No talks in this room yet. Add them in the event admin.")}</div>`}
      </div>
      <aside class="side">
        <div class="row"><h2>${L("Obrazovky", "Screens")}</h2>${s.platform === "web" ? "" : `<button class="btn small" id="identify">${L("Identifikovat", "Identify")}</button>`}</div>
        <p class="hint">${L("Nastavíte jednou, player si to pamatuje.", "Set it once, the player remembers.")}</p>
        <div class="screens">${s.displays.map(d => `
          <div class="scr ${d.role}">
            <div class="icon">${d.n}</div>
            <div><div class="nm">${esc(d.label)}</div><div class="res mono">${esc(d.size)}</div>
              <select id="role-${d.n}" data-display="${esc(d.id)}" aria-label="${L("Role obrazovky", "Screen role")} ${d.n}">
                ${Object.entries(ROLES(s)).map(([k, v]) => `<option value="${k}" ${k === d.role ? "selected" : ""}>${v}</option>`).join("")}
              </select></div>
          </div>`).join("")}
        </div>
        ${webNotices(s)}
        <label class="field audio"><span>${L("Zvuk z videí", "Video sound")}</span><select id="audio-out"></select></label>
        ${s.platform === "web" ? `<div class="audio-unlock" id="audio-unlock" hidden><button class="btn small" id="audio-names">${L("Zobrazit zvukové výstupy", "Show audio outputs")}</button>
          <p class="hint">${L("Prohlížeč názvy reproduktorů a HDMI ukáže až po povolení mikrofonu. Nic nenahráváme, mikrofon se hned zase vypne.", "The browser only shows speaker and HDMI names after you allow the microphone. Nothing is recorded, it's switched off right away.")}</p></div>` : ""}
        ${s.displays.length === 1 && s.displays[0].role !== "ctrl" ? `<p class="notice">${L("Je připojená jen jedna obrazovka. Nastavte ji na <b>Ovládání</b>, projekce se pak otevře v okně jako náhled. Až připojíte projektor, nastavte ho na Projekci.", "Only one screen is connected. Set it to <b>Control</b>; the projection then opens in a window as a preview. When you connect a projector, set it to Projection.")}</p>` : ""}
        ${s.displays.length < 2 && s.screenAccess === "granted" ? `<p class="hint">${L("Připojena je jen jedna obrazovka. Projekce se otevře v okně jako náhled.", "Only one screen is connected. The projection opens in a window as a preview.")}</p>` : ""}
        <div class="msgbox">
          <h2>${L("Zpráva řečníkovi", "Message to the speaker")}</h2>
          <p class="hint">${L("Rozsvítí se velce na monitoru řečníka a na jeho telefonu.", "Lights up big on the speaker monitor and on the speaker's phone.")}</p>
          <div class="presets">${MESSAGES().map(m => `<button class="btn small" data-msg="${esc(m)}">${esc(m)}</button>`).join("")}</div>
          <form id="msgform"><input id="msgtext" maxlength="200" placeholder="${L("Vlastní zpráva", "Your own message")}" aria-label="${L("Vlastní zpráva", "Your own message")}"><button class="btn small primary">${L("Poslat", "Send")}</button></form>
          <div class="msgnow" id="msgnow" hidden></div>
        </div>
        ${s.remote ? `<div class="phonebox">
          <h2>${L("Telefon jako monitor řečníka", "Phone as speaker monitor")}</h2>
          <p class="hint">${L("Řečník naskenuje QR kód: na telefonu uvidí slide, poznámky, čas a dotazy a může přepínat slidy. Hodí se, když v sále není monitor u pódia. Telefon potřebuje internet.", "The speaker scans the QR code: the phone shows the slide, notes, time and questions, and can change slides. Handy when there's no stage monitor. The phone needs internet.")}</p>
          <div class="qr">${s.remote.qr}</div>
        </div>` : ""}
        <div class="loopinfo">
          <h2>${L("Smyčka partnerů", "Partner loop")}</h2>
          ${s.loop.length ? `<label class="toggle"><input type="checkbox" id="loop-on" ${s.loopEnabled ? "checked" : ""}>
            <span>${L("Pouštět na projekci o přestávkách a mezi přednáškami", "Play on the projection during breaks and between talks")} (${s.loop.length})</span></label>
`
          : `<p class="hint">${L("Fotky a videa partnerů nahrajete ve správě akce. Objeví se tu samy.", "Upload partner photos and videos in the event admin. They show up here automatically.")}</p>`}
        </div>
        <div class="foot">
          ${s.outputsOpen ? `<button class="btn" id="stop-outputs">${L("Vypnout projekci (ukáže plochu)", "Turn off projection (shows the desktop)")}</button>`
            : `<button class="btn primary" id="outputs-on">${L("Zapnout projekci", "Start projection")}</button><span class="hint">${L("Pustí smyčku nebo černou s názvem další přednášky.", "Shows the loop or black with the next talk.")}</span>`}
          ${s.platform === "web" ? "" : `<button class="btn ghost small" id="unpair">${L("Odpojit sál", "Disconnect room")}</button>`}
        </div>
        <p class="credit">${L("FckScrn vytvořil Tomáš Foltas, autor Domee.app – aplikace pro správu nemovitostí", "FckScrn is made by Tomáš Foltas, creator of Domee.app – a property management app")}</p>
      </aside>
    </div>
  </main>`;

  app.querySelectorAll("[data-start]").forEach(b => (b.onclick = () => fck.cmd("start", +b.dataset.start)));
  wireBilling();
  app.querySelectorAll("[data-msg]").forEach(b => (b.onclick = () => fck.cmd("message", { text: b.dataset.msg })));
  $("#msgform")?.addEventListener("submit", e => { e.preventDefault(); const v = $("#msgtext").value.trim(); if (v) { fck.cmd("message", { text: v }); $("#msgtext").value = ""; } });
  app.querySelectorAll("[data-display]").forEach(sel => (sel.onchange = () => fck.cmd("role", { displayId: sel.dataset.display, role: sel.value })));
  $("#identify")?.addEventListener("click", () => fck.cmd("identify"));
  $("#outputs-on")?.addEventListener("click", () => fck.cmd("standby"));
  $("#allow-screens")?.addEventListener("click", () => fck.cmd("screens"));
  $("#loop-on")?.addEventListener("change", e => fck.cmd("loop", e.target.checked));
  $("#stop-outputs")?.addEventListener("click", () => fck.cmd("stopOutputs"));
  if ($("#unpair")) $("#unpair").onclick = e => {
    if (e.target.dataset.confirm) fck.cmd("unpair");
    else { e.target.dataset.confirm = "1"; e.target.textContent = L("Opravdu? Smaže stažené soubory", "Sure? Deletes downloaded files"); }
  };
}

// web player only: browser permissions and the one key press each output window needs
function webNotices(s) {
  if (s.platform !== "web") return "";
  const out = [];
  if (s.screenAccess === "unsupported") out.push(`<div class="notice">${L("Tenhle prohlížeč neumí ovládat víc obrazovek. Otevřete tuto stránku v <b>Chrome</b> nebo <b>Edge</b>.", "This browser can't control several screens. Open this page in <b>Chrome</b> or <b>Edge</b>.")}</div>`);
  if (s.screenAccess === "prompt") out.push(`<div class="notice">${L("Aby šla projekce poslat na projektor, prohlížeč potřebuje vidět všechny obrazovky.", "To send the projection to the projector, the browser needs to see all screens.")}<button class="btn small primary" id="allow-screens">${L("Povolit obrazovky", "Allow screens")}</button></div>`);
  if (s.screenAccess === "denied") out.push(`<div class="notice">${L("Přístup k obrazovkám je zakázaný. Klikněte na ikonu vlevo od adresy, povolte <b>Správa oken</b> a obnovte stránku.", "Access to screens is blocked. Click the icon left of the address, allow <b>Window management</b> and reload.")}</div>`);
  if (s.popupBlocked) out.push(`<div class="notice">${L("Prohlížeč zablokoval okno projekce. V adresním řádku povolte vyskakovací okna pro tuto stránku a klikněte znovu.", "The browser blocked the projection window. Allow pop-ups for this page in the address bar and click again.")}</div>`);
  const p = s.placements?.projection;
  if (p?.dedicated && (s.outputs.projection === "open" || s.outputs.projection === "waiting"))
    out.push(`<div class="notice">${L("<b>Ještě jeden krok:</b> klikněte na projekci (nebo stiskněte klikr). Přepne se na celou obrazovku", "<b>One more step:</b> click the projection (or press the clicker). It goes fullscreen")}${s.placements.presenter ? L(" a otevře se monitor řečníka", " and opens the speaker monitor") : ""}.</div>`);
  else if (s.placements?.presenter?.dedicated && s.outputs.presenter === "open")
    out.push(`<div class="notice">${L("<b>Ještě jeden krok:</b> klikněte na monitor řečníka, přepne se na celou obrazovku.", "<b>One more step:</b> click the speaker monitor, it goes fullscreen.")}</div>`);
  return out.join("");
}

// questions of the talk that's on: tick off answered, put them on the projection
function drawLiveQuestions(talk, live, s) {
  const btn = $("#lqs"), box = $("#lq");
  if (!btn || !box) return;
  const all = s.questions?.[talk.id] || [];
  const open = all.filter(q => !q.answered);
  btn.hidden = !talk.qaEnabled;
  btn.classList.toggle("on", !!live.showQuestions);
  btn.textContent = live.showQuestions ? L("Skrýt dotazy z projekce", "Hide questions from projection") : L(`Dotazy na projekci (${open.length})`, `Questions on projection (${open.length})`);
  const qr = $("#lqr");
  if (qr) {
    qr.hidden = !talk.qaEnabled;
    qr.classList.toggle("on", !live.hideQr);
    qr.textContent = live.hideQr ? L("Ukázat QR na dotazy", "Show Q&A QR code") : L("Skrýt QR na dotazy", "Hide Q&A QR code");
  }
  const key = JSON.stringify(all);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = talk.qaEnabled && all.length ? `<div class="label">${L("Dotazy z publika", "Audience questions")}</div>
    ${all.map(q => `<div class="lq-item ${q.answered ? "done" : ""}">
      <button class="tick ${q.answered ? "on" : ""}" data-ans="${q.id}" data-v="${q.answered ? 0 : 1}" aria-label="${L("Zodpovězeno", "Answered")}">✓</button>
      <b>${q.votes}</b><span>${esc(q.text)}${q.author ? ` <i>· ${esc(q.author)}</i>` : ""}</span></div>`).join("")}` : "";
  box.querySelectorAll("[data-ans]").forEach(b => (b.onclick = () => fck.cmd("answer", { id: +b.dataset.ans, answered: b.dataset.v === "1" })));
}

function drawPollButton(talk, live, s) {
  const b = $("#lpoll"), poll = s.polls?.[talk.id];
  if (!b) return;
  b.hidden = !poll;
  if (!poll) return;
  b.classList.toggle("on", !!live.showPoll);
  b.textContent = live.showPoll ? L("Skrýt hlasování z projekce", "Hide poll from projection") : L(`Hlasování na projekci (${poll.total})`, `Poll on projection (${poll.total})`);
}

// running late: when the talk on now ends later than the next one should start
const toMin = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
function lateBy(s) {
  const live = s?.live, talk = live && s.talks.find(t => t.id === live.talkId);
  if (!talk || !live.startedAt || !["pdf", "panel", "break", "native"].includes(live.mode)) return null;
  const list = s.talks, i = list.findIndex(t => t.id === talk.id);
  const next = list.slice(i + 1).find(t => t.startsAt);
  if (!next) return null;
  const end = Math.max(live.startedAt + talk.durationMin * 60_000, Date.now());
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const nextAt = d.getTime() + toMin(next.startsAt) * 60_000;
  const min = Math.round((end - nextAt) / 60_000);
  // only on the event day and within reason (a rehearsal the day before is not "running late")
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (s.event?.date && s.event.date !== day) return null;
  return min >= 3 && min <= 120 ? { min, talk, next } : null;
}
function drawLate(s) {
  const box = $("#late");
  if (!box) return;
  const l = lateBy(s);
  box.hidden = !l;
  if (!l) { box.dataset.min = ""; return; }
  if (box.dataset.min === String(l.min)) return;
  box.dataset.min = l.min;
  box.innerHTML = `<span>${L(`Jedete o <b>${l.min} min</b> pozadu. „${esc(l.next.title)}“ má začít v ${esc(l.next.startsAt)}.`, `You're <b>${l.min} min</b> behind. “${esc(l.next.title)}” is due at ${esc(l.next.startsAt)}.`)}</span>
    <button class="btn small primary" id="shift">${L(`Posunout další program o ${l.min} min`, `Move the rest by ${l.min} min`)}</button>`;
  $("#shift").onclick = () => { fck.cmd("shift", { afterTalkId: l.talk.id, minutes: l.min }); box.hidden = true; };
}

// the speaker pressed "Help" on the phone: impossible to miss, one click to answer
let helpAt = 0;
function drawHelp(s) {
  let bar = document.getElementById("helpbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "helpbar"; bar.className = "helpbar"; bar.hidden = true; bar.setAttribute("role", "alert");
    document.body.append(bar);
  }
  bar.hidden = !s.help;
  if (!s.help) { helpAt = 0; return; }
  if (s.help.at === helpAt) return;
  helpAt = s.help.at;
  bar.innerHTML = `<b>${L("Řečník volá o pomoc!", "The speaker needs help!")}</b><span>${L("Zmáčkl tlačítko Pomoc na telefonu.", "They pressed Help on their phone.")}</span>
    <button class="btn big" id="helpok">${L("Jdu tam", "On my way")}</button>`;
  $("#helpok").onclick = () => fck.cmd("helpDone");
  beep();
}
function beep() {
  try {
    const ac = new AudioContext();
    [0, 0.35, 0.7].forEach(t0 => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; g.gain.value = 0.15;
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + t0); o.stop(ac.currentTime + t0 + 0.2);
    });
  } catch {}
}

async function renderLive(s) {
  const box = $("#live");
  if (!box) return;
  const live = s.live;
  const talk = live && s.talks.find(t => t.id === live.talkId);
  if (!talk) { box.innerHTML = ""; box.dataset.talk = ""; return; }

  if (live.mode === "break") {
    if (box.dataset.talk !== "b" + talk.id) {
      box.dataset.talk = "b" + talk.id;
      box.innerHTML = `<div class="live"><div class="info" style="grid-column:1/-1">
        <div class="label">${L("Běží přestávka", "Break in progress")}</div>
        <h2>${esc(talk.title)}</h2>
        <div class="timer mono" id="ltimer"></div>
        <p class="muted" style="margin:0">${esc(talkNote(talk))}</p>
        <div class="late" id="late" hidden></div>
        <button class="btn primary" id="end">${L("Ukončit přestávku", "End break")}</button>
      </div></div>`;
      $("#end").onclick = () => fck.cmd("end");
    }
    return;
  }

  if (live.mode === "panel") {
    if (box.dataset.talk !== "p" + talk.id) {
      box.dataset.talk = "p" + talk.id;
      box.innerHTML = `<div class="live"><div class="info" style="grid-column:1/-1">
        <div class="label">${L("Běží panel", "Panel in progress")}</div>
        <h2>${esc(talk.title)}</h2>
        <div class="timer mono" id="ltimer"></div>
        <div class="ctrl"><button class="btn" id="lqs"></button><button class="btn" id="lqr"></button><button class="btn" id="lpoll" hidden></button><button class="btn primary" id="end">${L("Ukončit panel", "End panel")}</button></div>
        <div class="late" id="late" hidden></div>
        <div class="lq" id="lq"></div>
      </div></div>`;
      $("#end").onclick = () => fck.cmd("end");
      $("#lqs").onclick = () => fck.cmd("showQuestions");
      $("#lqr").onclick = () => fck.cmd("qr");
      $("#lpoll").onclick = () => fck.cmd("showPoll");
    }
    drawLiveQuestions(talk, live, s);
    drawPollButton(talk, live, s);
    return;
  }

  if (live.mode === "native") {
    box.innerHTML = `<div class="live"><div class="info" style="grid-column:1/-1">
      <div class="label">${L("Běží v", "Running in")} ${talk.fileExt === "key" ? "Keynote" : "PowerPoint"}</div>
      <h2>${esc(talk.title)}</h2>
      <p class="muted" style="margin:0">${L(`Prezentaci teď ovládá ${talk.fileExt === "key" ? "Keynote" : "PowerPoint"}. Až skončí, zavřete ji tam a klikněte na Hotovo.`, `${talk.fileExt === "key" ? "Keynote" : "PowerPoint"} is running the presentation now. When it ends, close it there and click Done.`)}
        ${L(`Obrazovky teď volí ${talk.fileExt === "key" ? "Keynote" : "PowerPoint"} sám: s projektorem dá prezentaci na něj a poznámky (Presenter View) na notebook. S jedinou obrazovkou se poznámky neukážou. QR na dotazy a náš monitor řečníka jsou jen v PDF režimu.`,
            `${talk.fileExt === "key" ? "Keynote" : "PowerPoint"} chooses the screens itself: with a projector the slides go there and Presenter View to the laptop. With a single screen there are no notes. The Q&A QR and our speaker monitor work in PDF mode only.`)}</p>
      <button class="btn primary" id="end">${L("Hotovo", "Done")}</button>
    </div></div>`;
    $("#end").onclick = () => fck.cmd("end");
    return;
  }

  if (box.dataset.talk !== String(talk.id)) {
    box.dataset.talk = talk.id;
    box.innerHTML = `<div class="live">
      <div class="thumb"><canvas id="lc"></canvas><span>${L("Projekce", "Projection")}</span></div>
      <div class="thumb"><canvas id="ln"></canvas><span>${L("Další", "Next")}</span></div>
      <div class="info">
        <div class="label">${L("Živě", "Live")} · <span id="lpage"></span></div>
        <div class="timer mono" id="ltimer"></div>
        <div class="ctrl">
          <button class="btn" id="lprev">←</button>
          <button class="btn primary" id="lnext">${L("Další", "Next")} →</button>
          <button class="btn" id="lblack">${L("Černá", "Black")}</button>
        </div>
        <button class="btn small" id="lend">${L("Ukončit přednášku", "End talk")}</button>
        <button class="btn small" id="lqs"></button>
        <button class="btn small" id="lqr"></button>
        <button class="btn small" id="lpoll" hidden></button>
        <div class="late" id="late" hidden></div>
      </div>
      <div class="lq" id="lq"></div>
    </div>`;
    $("#lqs").onclick = () => fck.cmd("showQuestions");
      $("#lqr").onclick = () => fck.cmd("qr");
    $("#lpoll").onclick = () => fck.cmd("showPoll");
    $("#lprev").onclick = () => fck.cmd("prev");
    $("#lnext").onclick = () => fck.cmd("next");
    $("#lblack").onclick = () => fck.cmd("black");
    $("#lend").onclick = () => fck.cmd("end");
  }
  drawLiveQuestions(talk, live, s);
  drawPollButton(talk, live, s);
  $("#lpage").textContent = `${live.page} / ${live.pages}`;
  $("#lnext").textContent = waiting(live, talk) ? L("▶ Spustit video", "▶ Play video") : `${L("Další", "Next")} →`;
  $("#lblack").classList.toggle("on", live.black);
  const doc = await loadDoc(talk);
  await Promise.all([draw($("#lc"), live.black ? null : doc, live.page), draw($("#ln"), doc, live.page + 1)]);
}

// ---------- control + speaker monitor in one window (laptop + projector) ----------
// While a talk or panel runs, this window becomes the speaker monitor with a slim control bar.
// "Program" peeks at the full control screen; the next talk brings the monitor back.
let combo = null, comboOn = false, peekTalk = null;
function renderCombo(s) {
  const live = s.live;
  const talk = live && s.talks.find(t => t.id === live.talkId);
  const want = !!s.placements?.combined && !!talk && (live.mode === "pdf" || live.mode === "panel");
  if (!want || peekTalk !== live.talkId) peekTalk = want && peekTalk === live.talkId ? peekTalk : null;
  comboOn = want && peekTalk === null;
  document.body.classList.toggle("combined", comboOn);
  if (!combo && want) {
    combo = document.createElement("div");
    combo.className = "combo";
    combo.innerHTML = `<div class="combo-view"></div><nav class="combo-bar" id="cbar"></nav>`;
    document.body.append(combo);
    combo.view = mountPresenter(combo.querySelector(".combo-view"));
    const back = document.createElement("button");
    back.className = "btn primary big combo-back"; back.id = "cback";
    back.onclick = () => { peekTalk = null; render(state); };
    document.body.append(back);
    setInterval(() => comboOn && combo.view.tick(), 500);
    addEventListener("resize", () => comboOn && combo.view.refit());
  }
  if (!combo) return;
  combo.hidden = !comboOn;
  $("#cback").hidden = !(want && !comboOn);
  $("#cback").textContent = L("Zpět na monitor řečníka", "Back to the speaker monitor");
  if (!comboOn) return;
  combo.view.render(s);
  const pdf = live.mode === "pdf";
  const key = JSON.stringify([live.talkId, live.mode, pdf && waiting(live, talk) ? 1 : 0, live.black, live.hideQr, live.showQuestions, talk.qaEnabled, !!document.fullscreenElement, lang]);
  const bar = $("#cbar");
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  bar.innerHTML = `${pdf ? `<button class="btn big" data-c="prev" aria-label="${L("Předchozí slide", "Previous slide")}">←</button>
      <button class="btn big primary go" data-c="next">${waiting(live, talk) ? L("▶ Spustit video", "▶ Play video") : `${L("Další", "Next")} →`}</button>
      <button class="btn big ${live.black ? "on" : ""}" data-c="black">${L("Černá", "Black")}</button>` : ""}
    <span class="combo-sp"></span>
    ${talk.qaEnabled ? `<button class="btn ${live.hideQr ? "" : "on"}" data-c="qr">${live.hideQr ? L("Ukázat QR na dotazy", "Show Q&A QR code") : L("Skrýt QR na dotazy", "Hide Q&A QR code")}</button>
      <button class="btn ${live.showQuestions ? "on" : ""}" data-c="showQuestions">${live.showQuestions ? L("Skrýt dotazy z plátna", "Hide questions") : L("Dotazy na plátno", "Questions on screen")}</button>` : ""}
    <button class="btn" id="cpeek">${L("Program", "Programme")}</button>
    ${document.fullscreenEnabled ? `<button class="btn" id="cfull">${document.fullscreenElement ? L("Zmenšit okno", "Exit full screen") : L("Celá obrazovka", "Full screen")}</button>` : ""}
    <button class="btn" data-c="end">${pdf ? L("Ukončit přednášku", "End talk") : L("Ukončit panel", "End panel")}</button>`;
  bar.querySelectorAll("[data-c]").forEach(b => (b.onclick = () => fck.cmd(b.dataset.c)));
  $("#cpeek").onclick = () => { peekTalk = live.talkId; render(state); };
  $("#cfull")?.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().then(() => navigator.keyboard?.lock?.(["Escape"]).catch(() => {})).catch(() => {});
  });
}
document.addEventListener("fullscreenchange", () => state && renderCombo(state));

// where slide videos sound: automatically the projector's own output (HDMI), or the technician's pick
let outputs = [];
async function loadOutputs() {
  try { outputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput" && d.deviceId && !["default", "communications"].includes(d.deviceId)); } catch { outputs = []; }
  if (state) renderAudio(state);
}
navigator.mediaDevices?.addEventListener?.("devicechange", loadOutputs);
loadOutputs();
// web: Chrome hides output names (HDMI, USB speakers) until the page may use the microphone; ask once, stop it at once
async function unlockOutputNames() {
  try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach(t => t.stop()); } catch {}
  await loadOutputs();
  fck.cmd("audioNames"); // the projection window re-reads the device list
}
function renderAudio(s) {
  const sel = $("#audio-out");
  if (!sel) return;
  const unlock = $("#audio-unlock");
  if (unlock) {
    unlock.hidden = outputs.some(d => d.label);
    $("#audio-names").onclick = unlockOutputNames;
  }
  const auto = pickSink(outputs, null, s.displays.find(d => d.role === "proj")?.label);
  const autoName = outputs.find(d => d.deviceId === auto)?.label;
  // the select is rebuilt with the room view; the key on it says what it shows
  const key = JSON.stringify([outputs.map(d => [d.deviceId, d.label]), s.audioOutput, autoName, lang]);
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  const chosen = s.audioOutput ? pickSink(outputs, s.audioOutput) : "";
  sel.innerHTML = `<option value="">${esc(autoName ? L(`Automaticky: ${autoName}`, `Automatic: ${autoName}`) : L("Automaticky: výchozí zvuk počítače", "Automatic: the computer's default sound"))}</option>`
    + outputs.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === chosen ? "selected" : ""}>${esc(d.label || L(`Zvukový výstup ${i + 1}`, `Audio output ${i + 1}`))}</option>`).join("")
    + (s.audioOutput && !chosen ? `<option selected disabled>${esc(s.audioOutput.label || "?")} ${L("(není připojený)", "(not connected)")}</option>` : "");
  sel.onchange = () => fck.cmd("audioOutput", sel.value ? { id: sel.value, label: sel.selectedOptions[0].textContent } : null);
}

setInterval(() => {
  const c = $("#clock"); if (c) c.textContent = hhmm();
  const t = $("#ltimer"), s = state;
  const talk = ["pdf", "break", "panel"].includes(s?.live?.mode) && s.talks.find(x => x.id === s.live.talkId);
  if (t && talk) { const { text, cls } = timerText(s.live, talk); t.textContent = text; t.className = "timer mono " + cls; }
  drawLate(s);
}, 500);

// Esc ends the talk from the control screen, but not in the combined view (a stray Esc on stage)
bindKeys({ allowEnd: () => !comboOn });
langSwitch(() => { lastKey = ""; if (state) render(state); });
subscribe(render);
