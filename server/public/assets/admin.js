import { $, esc, api, toast, copy, st, fmtDate, fmtSize, tokenFromPath } from "./common.js";
import { openPreview } from "./preview.js";
import { lang, t, langSwitch, issueText } from "./i18n.js";
import { playLoop } from "./loop-preview.js";
import { openImport } from "./import.js";
import { mountPolls } from "./poll-ui.js";

const token = tokenFromPath();
const base = `/api/admin/${token}`;
const app = $("#app");
let view = null;
let editing = null;   // talk id being edited
let adding = null;    // { roomId, kind } for the inline add form
let addingRoom = false;
let pairOpen = new Set();
let uploading = null; // { i, n, pct } while loop files upload
let billOpen = false, billDraft = {};
let uploadFor = null; // talk id with the "upload on behalf" panel open
let busy = null;      // { id, pct } while uploading for a talk
let loopReport = null; // { ok, failed: [{ name, why }] } after a loop upload

let docs = null; // billing documents (proforma, invoice) from the invoicing service

async function load() {
  try { view = await api("GET", base); render(); loadDocs(); }
  catch (e) { app.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function act(method, url, body, msg) {
  try { view = await api(method, base + url, body); render(); if (msg) toast(msg); return true; }
  catch (e) { toast(e.message); return false; }
}

async function loadDocs() {
  if (!view?.billing?.enabled || view.billing.status === "trial") return;
  try { docs = (await api("GET", `${base}/documents`)).documents; } catch (e) { docs = { error: e.message }; }
  render();
}

// hosted version: proforma to pay (with QR) and, once paid, the invoice; organizers download them here
function docsHTML() {
  const b = view.billing;
  if (!b?.enabled || b.status === "trial") return "";
  const money = n => `${Number(n).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Kč`;
  const name = d => d.kind === "proforma" ? t({ cs: "Zálohová faktura", en: "Proforma invoice" }) : t({ cs: "Faktura", en: "Invoice" });
  const list = Array.isArray(docs) ? docs : [];
  return `<section class="add" id="fakturace">
    <h2>${t({ cs: "Fakturace", en: "Invoices" })}</h2>
    <p class="sub">${t({ cs: "Doklady k této akci. Po připsání platby zálohy tu přibude faktura, obvykle do druhého dne.", en: "Documents for this event. Once the proforma is paid, the invoice appears here, usually by the next day." })}</p>
    ${docs === null ? `<p class="muted">${t({ cs: "Načítám doklady…", en: "Loading documents…" })}</p>`
      : docs.error ? `<p class="error">${esc(docs.error)}</p>`
      : `<div class="docs">${list.map(d => `<div class="doc">
          <div class="doc-head"><b>${name(d)} ${esc(d.number)}</b><span class="mono">${money(d.total)}</span>
            <span class="st ${d.status === "paid" ? "ready" : "warning"}">${d.status === "paid"
              ? t({ cs: `Uhrazeno${d.paidDate ? " " + esc(fmtDay(d.paidDate)) : ""}`, en: `Paid${d.paidDate ? " " + esc(fmtDay(d.paidDate)) : ""}` })
              : t({ cs: `Čeká na úhradu, splatnost ${esc(fmtDay(d.dueDate))}`, en: `Awaiting payment, due ${esc(fmtDay(d.dueDate))}` })}</span>
            <a class="btn small" href="${base}/documents/${esc(d.id)}/pdf">${t({ cs: "Stáhnout PDF", en: "Download PDF" })}</a></div>
          ${d.pay ? `<div class="pay">${d.pay.qr ? `<div class="qr">${d.pay.qr}</div>` : ""}
            <dl><dt>${t({ cs: "Účet", en: "Account" })}</dt><dd class="mono">${esc(d.pay.account)}</dd>
              <dt>IBAN</dt><dd class="mono">${esc(d.pay.iban)}</dd>
              <dt>${t({ cs: "Variabilní symbol", en: "Reference (VS)" })}</dt><dd class="mono">${esc(d.pay.variableSymbol)}</dd>
              <dt>${t({ cs: "Částka", en: "Amount" })}</dt><dd class="mono">${money(d.pay.amount)}</dd></dl></div>` : ""}
        </div>`).join("")}</div>`}
  </section>`;
}

const talksOnly = () => view.talks.filter(x => x.kind !== "break");
const formData = f => Object.fromEntries(new FormData(f));
const mcpUrl = () => `${location.origin}/mcp/${token}`; // for connectors that only take an address (ChatGPT, Claude.ai…)
const mcpCommand = () => `claude mcp add --transport http fckscrn ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;
const fmtDay = d => new Date(d + "T12:00:00").toLocaleDateString(lang === "en" ? "en-GB" : "cs-CZ", { day: "numeric", month: lang === "en" ? "long" : "numeric", year: "numeric" });
const speakerUrl = x => `${location.origin}/s/${x.speakerToken}`;
const pairUrl = r => `${location.origin}/p/${r.playerToken}`;
const helpUrl = hash => (lang === "en" ? "/en/help" : "/napoveda") + (hash ? `#${hash}` : "");

// next free time in a room = end of its last block
function nextStart(roomId) {
  const list = view.talks.filter(x => x.roomId === roomId && x.startsAt);
  if (!list.length) return "09:00";
  const ends = list.map(x => { const [h, m] = x.startsAt.split(":").map(Number); return h * 60 + m + x.durationMin; });
  const end = Math.min(Math.max(...ends), 23 * 60 + 59);
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

function chrome() {
  document.title = t({ cs: "Správa akce · FckScrn", en: "Event admin · FckScrn" });
  $(".top .muted").textContent = t({ cs: "správa akce · tento odkaz nikomu neposílejte", en: "event admin · don't share this link" });
  $("#credit").innerHTML = t({
    cs: `<a href="/napoveda">Nápověda</a> · FckScrn je open source · vytvořil <b>Tomáš Foltas</b>, autor <a href="https://domee.app" rel="noopener">Domee.app</a> – aplikace pro správu nemovitostí`,
    en: `<a href="/en/help">Help</a> · FckScrn is open source · made by <b>Tomáš Foltas</b>, creator of <a href="https://domee.app" rel="noopener">Domee.app</a> – a property management app`,
  });
}

function render() {
  chrome();
  if (!view) return;
  const { event, rooms, talks } = view;
  const list = talks.filter(x => x.kind === "talk"); // only talks carry a presentation
  const count = s => list.filter(x => x.status === s).length;
  const missing = count("missing");
  const unassigned = talks.filter(x => !x.roomId);
  const single = event.mode === "single";
  const today = new Date().toISOString().slice(0, 10);
  const late = !!event.deadline && event.deadline < today && missing > 0;

  app.innerHTML = `
    <div class="head">
      <div><div class="label">${esc([fmtDate(event.date), event.place].filter(Boolean).join(" · ") || t({ cs: "Akce", en: "Event" }))}</div>
        <h1>${esc(event.name)}</h1>
        ${event.expiresAt ? `<p class="sub">${t({
          cs: `Akce i všechny soubory se automaticky smažou <b>${esc(fmtDay(event.expiresAt))}</b>. Předtím si můžete vše <a href="${base}/export">stáhnout</a>.`,
          en: `The event and all its files will be deleted automatically on <b>${esc(fmtDay(event.expiresAt))}</b>. Before that you can <a href="${base}/export">download everything</a>.`,
        })}</p>` : ""}</div>
      ${missing ? `<button class="btn ${late ? "primary" : ""}" id="remind">${t({ cs: `Připomenout řečníkům, kteří ještě nenahráli (${missing})`, en: `Remind speakers who haven't uploaded (${missing})` })}</button>` : ""}
    </div>

    <ol class="steps">
      <li class="${talks.length ? "done" : ""}"><b>${t({ cs: "Program", en: "Programme" })}</b><span>${t({ cs: `Přidejte přednášky a přestávky${single ? "" : " do sálů"}.`, en: `Add talks and breaks${single ? "" : " to the rooms"}.` })}</span></li>
      <li class="${list.length && !missing ? "done" : ""}"><b>${t({ cs: "Řečníci", en: "Speakers" })}</b><span>${t({ cs: "Pošlete každému jeho odkaz. Prezentace nahraje sám.", en: "Send each one their link. They upload their slides themselves." })}</span>
</li>
      <li class="${rooms.length && rooms.every(r => r.playerOnline) ? "done" : ""}"><b>${single ? t({ cs: "Projekce", en: "Projection" }) : t({ cs: "Sály", en: "Rooms" })}</b><span>${t({
        cs: `Na počítači u projektoru otevřete odkaz ${single ? "projekce" : "sálu"} v Chrome. Nic se neinstaluje.`,
        en: `Open the ${single ? "projection" : "room"} link in Chrome on the computer at the projector. Nothing to install.`,
      })}</span></li>
    </ol>

    <label class="deadline-row"><b>${t({ cs: "Termín pro nahrání prezentací", en: "Upload deadline" })}</b>
      <input type="date" id="deadline" value="${esc(event.deadline || "")}" ${event.date ? `max="${esc(event.date)}"` : ""}>
      <span class="muted">${t({ cs: "Nepovinné. Řečníci ho uvidí na svém odkazu i v připomínce.", en: "Optional. Speakers see it on their link and in the reminder." })}</span></label>

    ${billingHTML()}

    <div class="stats">
      <div class="stat ${late ? "late" : ""}"><div class="n">${count("ready") + count("warning")}/${list.length}</div><div class="l">${t({ cs: "prezentací nahráno", en: "presentations uploaded" })}${event.deadline ? ` · ${late ? t({ cs: "po termínu", en: "past deadline" }) : t({ cs: "do", en: "by" }) + " " + esc(fmtDay(event.deadline))}` : ""}</div></div>
      <div class="stat"><div class="n">${count("warning") + count("error")}</div><div class="l">${t({ cs: "ke kontrole", en: "need a look" })}</div></div>
      ${single
        ? `<div class="stat"><div class="n">${rooms[0]?.playerOnline ? t({ cs: "Ano", en: "Yes" }) : t({ cs: "Ne", en: "No" })}</div><div class="l">${t({ cs: "projekce připojena", en: "projection connected" })}</div></div>`
        : `<div class="stat"><div class="n">${rooms.filter(r => r.playerOnline).length}/${rooms.length}</div><div class="l">${t({ cs: "sálů připojeno", en: "rooms connected" })}</div></div>`}
      <div class="stat"><div class="n">${view.media.length}</div><div class="l">${t({ cs: "ve smyčce partnerů", en: "in the partner loop" })}</div></div>
    </div>

    <div class="rooms">
      ${rooms.map(r => roomHTML(r, talks.filter(x => x.roomId === r.id))).join("")}
      ${unassigned.length ? roomHTML(null, unassigned) : ""}
      ${single ? `<div><button class="btn small ghost" id="to-multi">${t({ cs: "Potřebujete víc sálů? Přepnout na víc sálů", en: "Need more rooms? Switch to several rooms" })}</button></div>` : `<div>${addingRoom
        ? `<form id="add-room" class="row"><label class="field grow"><span>${t({ cs: "Název sálu", en: "Room name" })}</span><input id="room-name" name="name" required placeholder="${t({ cs: "Sál B", en: "Room B" })}" autofocus></label>
            <button class="btn primary">${t({ cs: "Přidat sál", en: "Add room" })}</button><button class="btn ghost" type="button" id="cancel-room">${t({ cs: "Zrušit", en: "Cancel" })}</button></form>`
        : `<button class="btn" id="new-room">${t({ cs: "+ Přidat další sál", en: "+ Add another room" })}</button>`}</div>`}
    </div>

    ${loopHTML()}

    <section class="add">
      <h2>${t({ cs: "Ovládání přes AI", en: "Control with AI" })}</h2>
      <p class="sub">${t({
        cs: "Program můžete diktovat AI asistentovi (Claude, ChatGPT a další s MCP): „Přidej přednášku Jany Dvořákové v 10:30 na 25 minut“, „Komu chybí prezentace?“. Pro Claude Code spusťte v terminálu tento příkaz (jednou, pro tuhle akci), v jiných aplikacích přidejte konektor MCP s adresou níže:",
        en: "Dictate the programme to an AI assistant (Claude, ChatGPT and others with MCP): “Add a talk by Jana Dvořáková at 10:30 for 25 minutes”, “Who hasn't uploaded yet?”. For Claude Code run this command in your terminal (once, for this event); in other apps add an MCP connector with the address below:",
      })}</p>
      <pre class="cmd" id="mcp-cmd">${esc(mcpCommand())}</pre>
      <pre class="cmd" id="mcp-url">${esc(mcpUrl())}</pre>
      <div class="row" style="margin-top:10px">
        <button class="btn small primary" id="copy-mcp">${t({ cs: "Zkopírovat příkaz (Claude Code)", en: "Copy command (Claude Code)" })}</button>
        <button class="btn small" id="copy-mcp-url">${t({ cs: "Zkopírovat adresu konektoru", en: "Copy connector address" })}</button>
        <a class="btn small ghost" href="${helpUrl("claude")}" target="_blank" rel="noopener">${t({ cs: "Jak to funguje", en: "How it works" })}</a>
      </div>
      <p class="sub" style="margin-top:16px">${t({
        cs: "Odkaz na tuhle správu je zároveň klíč pro AI asistenta a API. Kdyby se dostal k někomu, komu nemá, vytvořte nový. Starý okamžitě přestane platit.",
        en: "The link to this admin is also the key for the AI assistant and the API. If it reaches the wrong person, create a new one. The old one stops working immediately.",
      })}</p>
      <div><button class="btn small" id="rotate">${t({ cs: "Vytvořit nový odkaz", en: "Create a new link" })}</button></div>
    </section>

    ${docsHTML()}

    <section class="add">
      <h2>${t({ cs: "Po akci", en: "After the event" })}</h2>
      <p class="sub">${t({
        cs: `Stáhněte si všechno v jednom ZIPu: program (CSV pro Excel), prezentace v originále i PDF, poznámky řečníků a smyčku partnerů.${event.expiresAt ? ` Pak se akce ${esc(fmtDay(event.expiresAt))} sama smaže, nebo ji smažte hned.` : ""}`,
        en: `Download everything in one ZIP: programme (CSV for Excel), presentations as originals and PDF, speaker notes and the partner loop.${event.expiresAt ? ` The event then deletes itself on ${esc(fmtDay(event.expiresAt))}, or delete it now.` : ""}`,
      })}</p>
      <label class="toggle share-toggle"><input type="checkbox" id="public-on" ${event.publicEnabled ? "checked" : ""}>
        <span><b>${t({ cs: "Veřejná stránka akce", en: "Public event page" })}</b>
          <small class="muted">${t({ cs: "Během akce ukazuje, co právě běží v sálech, a jde dát i na televizi u dveří. Po akci jsou na ní slidy.", en: "During the event it shows what's on in each room and can go on a TV by the door. After the event it has the slides." })}</small>
          <small class="muted">${t({ cs: `Program a slidy řečníků, kteří zveřejnění povolili (${talks.filter(x => x.shareSlides && x.hasPdf).length} z ${list.length}). Řečník to zapíná na svém odkazu. Stránka zmizí spolu s akcí.`, en: `Programme and slides of speakers who agreed (${talks.filter(x => x.shareSlides && x.hasPdf).length} of ${list.length}). Speakers opt in on their own link. The page goes away with the event.` })}</small></span></label>
      ${event.publicEnabled ? `<div class="pair" style="margin-top:10px"><code>${esc(location.origin + event.publicPath)}</code>
        <div class="row"><button class="btn small primary" id="copy-public">${t({ cs: "Zkopírovat odkaz", en: "Copy link" })}</button>
          <a class="btn small" href="${esc(event.publicPath)}" target="_blank" rel="noopener">${t({ cs: "Otevřít", en: "Open" })}</a></div>
        <div class="signs"><span class="muted">${t({ cs: "Cedulka na televizi nebo tablet u dveří sálu (stačí otevřít v prohlížeči a nechat):", en: "Door sign for a TV or tablet by the room (open it in a browser and leave it):" })}</span>
          ${rooms.map(r => `<a class="btn small ghost" href="${esc(event.publicPath)}/sal/${r.id}" target="_blank" rel="noopener">${esc(single ? t({ cs: "Cedulka u dveří", en: "Door sign" }) : r.name)}</a>`).join("")}</div>
        <div class="signs"><span class="muted">${t({ cs: "Vlastní pozadí cedulky: obrázek, animace (GIF) nebo video. Text „Teď / Další“ zůstane přes něj.", en: "Your own door sign background: image, animation (GIF) or video. “Now / Next” stays on top." })}</span>
          ${event.signBackground ? `<a class="btn small ghost" href="${base}/sign-background" target="_blank" rel="noopener">${event.signBackground === "video" ? t({ cs: "Zobrazit video", en: "View video" }) : t({ cs: "Zobrazit obrázek", en: "View image" })}</a>` : ""}
          <button class="btn small" id="sign-pick">${event.signBackground ? t({ cs: "Změnit pozadí", en: "Change background" }) : t({ cs: "Nahrát pozadí", en: "Upload background" })}</button>
          ${event.signBackground ? `<button class="btn small ghost" id="sign-del">${t({ cs: "Odebrat", en: "Remove" })}</button>` : ""}
          <input type="file" id="sign-file" accept="image/*,video/mp4,video/webm,video/quicktime,.mov,.svg" hidden></div></div>` : ""}
      <div class="row" style="margin-top:12px">
        <a class="btn primary" href="${base}/export">${t({ cs: "Stáhnout vše (ZIP)", en: "Download all (ZIP)" })}</a>
        <button class="btn ghost" id="delete-event">${t({ cs: "Smazat akci hned", en: "Delete event now" })}</button>
      </div>
    </section>`;

  bind();
}

function roomHTML(room, list) {
  const rid = room ? room.id : null;
  const single = view.event.mode === "single";
  return `<section>
    <div class="room-h">
      <h2>${single ? t({ cs: "Program", en: "Programme" }) : room ? esc(room.name) : t({ cs: "Bez sálu", en: "No room" })}</h2>
      ${room ? `<div class="tools">
        <span class="st ${room.playerOnline ? "ready" : "missing"}">${room.playerOnline ? t({ cs: "Projekce připojena", en: "Projection connected" }) : t({ cs: "Projekce nepřipojena", en: "Projection not connected" })}</span>
        <button class="btn small" data-pair="${room.id}">${pairOpen.has(room.id) ? t({ cs: "Skrýt", en: "Hide" }) : t({ cs: "Připojit projekci", en: "Connect projection" })}</button>
        ${single ? "" : `<button class="btn small ghost" data-del-room="${room.id}">${t({ cs: "Smazat sál", en: "Delete room" })}</button>`}
      </div>` : ""}
    </div>
    ${room && pairOpen.has(room.id) ? `<div class="pair">
      <div>${t({ cs: "Na počítači, který je v sále připojený k projektoru, otevřete tento odkaz v <b>Chrome</b> nebo <b>Edge</b>. Nic se neinstaluje.", en: "On the computer connected to the projector, open this link in <b>Chrome</b> or <b>Edge</b>. Nothing to install." })}</div>
      <code>${esc(pairUrl(room))}</code>
      <div class="row">
        <button class="btn small primary" data-copy-pair="${room.id}">${t({ cs: "Zkopírovat odkaz", en: "Copy link" })}</button>
        <a class="btn small" href="${esc(pairUrl(room))}" target="_blank" rel="noopener">${t({ cs: "Otevřít tady", en: "Open here" })}</a>
      </div>
      <div class="muted">${t({ cs: "Máte desktopovou aplikaci FckScrn Player? Vložte odkaz do ní, umí navíc spustit originál v PowerPointu nebo Keynote.", en: "Using the FckScrn Player desktop app? Paste the link there; it can also run the original in PowerPoint or Keynote." })}</div>
    </div>` : ""}
    ${room?.playerOnline ? roomLiveHTML(room) : ""}
    ${list.length ? list.map(talkHTML).join("") : room ? `<div class="empty import-hint">${t({ cs: "Zatím prázdno. Máte program v Excelu nebo Google Sheets? Zkopírujte ho a vložte, přednášky se vytvoří samy.", en: "Nothing here yet. Got the programme in Excel or Google Sheets? Copy and paste it, the talks are created for you." })}
      <button class="btn primary" data-import="${rid}">${t({ cs: "Vložit program z Excelu", en: "Paste programme from Excel" })}</button></div>` : `<div class="empty">${t({ cs: "Zatím prázdno.", en: "Nothing here yet." })}</div>`}
    ${room ? (adding?.roomId === rid ? addFormHTML(rid, adding.kind) : `<div class="adders">
      <button class="btn small" data-add="${rid}" data-kind="talk">${t({ cs: "+ Přednáška", en: "+ Talk" })}</button>
      <button class="btn small" data-add="${rid}" data-kind="break">${t({ cs: "+ Přestávka", en: "+ Break" })}</button>
      <button class="btn small" data-add="${rid}" data-kind="panel">${t({ cs: "+ Panel", en: "+ Panel" })}</button>
      ${list.length ? `<button class="btn small ghost" data-import="${rid}">${t({ cs: "Vložit z Excelu", en: "Paste from Excel" })}</button>` : ""}
    </div>`) : ""}
  </section>`;
}

const MESSAGES = () => lang === "en"
  ? ["5 minutes left", "2 minutes left", "Time's up, please wrap up", "Closer to the microphone, please"]
  : ["Ještě 5 minut", "Ještě 2 minuty", "Čas vypršel, prosím končete", "Mluvte víc do mikrofonu"];
// running late: the talk on now ends after the next one should start
function roomLate(room) {
  const lv = room.live, talk = lv?.startedAt && view.talks.find(x => x.id === lv.talkId);
  if (!talk) return null;
  const list = view.talks.filter(x => x.roomId === room.id);
  const next = list.slice(list.findIndex(x => x.id === talk.id) + 1).find(x => x.startsAt);
  if (!next) return null;
  const toMin = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const min = Math.round((Math.max(lv.startedAt + talk.durationMin * 60_000, Date.now()) - (d.getTime() + toMin(next.startsAt) * 60_000)) / 60_000);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (view.event.date && view.event.date !== day) return null;
  return min >= 3 && min <= 120 ? { min, talk, next } : null;
}
function roomLiveHTML(room) {
  const lv = room.live, talk = lv && view.talks.find(x => x.id === lv.talkId);
  const late = roomLate(room);
  const alerts = `${lv?.help ? `<div class="room-alert">${t({ cs: "<b>Řečník volá o pomoc.</b> Technik v sále to vidí na ovládání.", en: "<b>The speaker needs help.</b> The room technician sees it on the control screen." })}</div>` : ""}
    ${late ? `<div class="room-alert">${t({ cs: `Sál jede o <b>${late.min} min</b> pozadu („${esc(late.next.title)}“ má začít v ${esc(late.next.startsAt)}).`, en: `The room is <b>${late.min} min</b> behind (“${esc(late.next.title)}” is due at ${esc(late.next.startsAt)}).` })}
      <button class="btn small primary" type="button" data-shift="${room.id}" data-after="${late.talk.id}" data-min="${late.min}">${t({ cs: `Posunout další program o ${late.min} min`, en: `Move the rest by ${late.min} min` })}</button></div>` : ""}`;
  const now = !talk ? t({ cs: "V sále teď nic neběží", en: "Nothing running in the room" })
    : `${t({ cs: "Teď", en: "Now" })}: ${esc(talk.title)}${lv.mode === "pdf" && lv.page ? ` · ${t({ cs: "slide", en: "slide" })} ${lv.page}/${lv.pages}` : ""}`;
  return `${alerts}<form class="room-live" data-msg="${room.id}">
    <span class="now">${now}</span>
    <select name="preset" aria-label="${t({ cs: "Zpráva řečníkovi", en: "Message to the speaker" })}"><option value="">${t({ cs: "Zpráva řečníkovi…", en: "Message to the speaker…" })}</option>${MESSAGES().map(m => `<option>${esc(m)}</option>`).join("")}</select>
    <input name="text" maxlength="200" placeholder="${t({ cs: "nebo vlastní text", en: "or your own text" })}">
    <button class="btn small primary">${t({ cs: "Poslat na monitor řečníka", en: "Send to speaker monitor" })}</button>
    <button class="btn small ghost" type="button" data-msg-clear="${room.id}">${t({ cs: "Smazat zprávu", en: "Clear message" })}</button>
  </form>`;
}

function talkHTML(x) {
  if (editing === x.id) {
    return `<form class="talk-form" data-save="${x.id}">
      ${fieldsHTML(x, x.kind)}
      <div class="row"><button class="btn primary">${t({ cs: "Uložit", en: "Save" })}</button><button class="btn ghost" type="button" data-cancel>${t({ cs: "Zrušit", en: "Cancel" })}</button></div>
    </form>`;
  }
  const edit = `<button class="btn small ghost" data-edit="${x.id}">${t({ cs: "Upravit", en: "Edit" })}</button><button class="btn small ghost" data-del="${x.id}">${t({ cs: "Smazat", en: "Delete" })}</button>`;
  const qaBtn = `<button class="btn small ${x.questions?.open ? "primary" : ""}" data-qa="${x.id}">${t({ cs: "Dotazy", en: "Questions" })}${x.questions?.total ? ` (${x.questions.open ? `${x.questions.open}/` : ""}${x.questions.total})` : ""}</button>`;
  if (x.kind === "panel") {
    return `<div class="talk panel">
      <span class="t">${esc(x.startsAt || "–")}</span>
      <div><div class="ti"><span class="kindtag">${t({ cs: "Panel", en: "Panel" })}</span> ${esc(x.title)}</div>
        <div class="sp">${[x.moderator && `${t({ cs: "moderuje", en: "moderator" })} ${esc(x.moderator)}`, x.panelists.map(esc).join(", "), `${x.durationMin} min`].filter(Boolean).join(" · ")}</div>
        <div class="sp">${t({ cs: "Pozadí", en: "Background" })}: ${x.background
          ? `${x.background === "video" ? t({ cs: "vlastní video", en: "your video" }) : t({ cs: "vlastní obrázek", en: "your image" })} · <a href="${base}/talks/${x.id}/background" target="_blank" rel="noopener">${t({ cs: "zobrazit", en: "view" })}</a> · <button class="linkbtn" data-bg-del="${x.id}">${t({ cs: "odebrat", en: "remove" })}</button>`
          : t({ cs: "slide s tématem a jmény", en: "slide with topic and names" })}</div>
      </div>
      <div class="side"><div class="acts">
        ${qaBtn}
        <button class="btn small" data-bg="${x.id}">${x.background ? t({ cs: "Změnit pozadí", en: "Change background" }) : t({ cs: "Nahrát pozadí", en: "Upload background" })}</button>
        <input type="file" id="bg-${x.id}" data-bg-file="${x.id}" accept="image/*,video/mp4,video/webm,video/quicktime,.mov" hidden>
        ${edit}
      </div></div>
    </div>`;
  }
  if (x.kind === "break") {
    return `<div class="talk break">
      <span class="t">${esc(x.startsAt || "–")}</span>
      <div><div class="ti">${esc(x.title)}</div><div class="sp">${x.durationMin} min · ${view.media.length ? t({ cs: "na projekci běží smyčka partnerů", en: "the partner loop runs on the projection" }) : t({ cs: "na projekci černá s názvem další přednášky", en: "the projection shows black with the next talk" })}</div></div>
      <div class="side"><div class="acts">${edit}</div></div>
    </div>`;
  }
  const warns = x.issues.filter(i => i.level === "warn" || i.level === "error");
  return `<div class="talk">
    <span class="t">${esc(x.startsAt || "–")}</span>
    <div>
      <div class="ti">${esc(x.title)}</div>
      <div class="sp">${esc(x.speaker || "")}${x.speaker ? " · " : ""}${x.durationMin} min${x.fileName ? ` · <span class="mono">${esc(x.fileName)}</span>` : ""}${x.shareSlides && x.hasPdf ? ` <span class="pubtag">${t({ cs: "slidy zveřejní", en: "shares slides" })}</span>` : ""}</div>
      ${warns.map(i => `<div class="issue ${x.reviewed ? "muted" : ""}">${esc(issueText(i))}${/^video_(online|missing|format)$/.test(i.code) ? `
        <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" data-vfile="${x.id}:${i.i}" hidden>
        <button class="btn small ghost" type="button" data-vpick="${x.id}:${i.i}">${busy?.id === `${x.id}:${i.i}` ? t({ cs: "Nahrávám…", en: "Uploading…" }) : t({ cs: "Nahrát video", en: "Upload video" })}</button>` : ""}</div>`).join("")}
    </div>
    <div class="side">
      <div class="status-line">${st(x.status)}${x.reviewed ? `<span class="muted small-note">${t({ cs: "zkontrolováno", en: "reviewed" })}</span>` : ""}
        ${x.status === "warning" ? `<button class="btn small primary" data-approve="${x.id}">${t({ cs: "V pořádku", en: "Looks good" })}</button>` : ""}</div>
      <div class="acts">
        ${x.version ? `<button class="btn small" data-preview="${x.id}">${t({ cs: "Náhled", en: "Preview" })}</button>` : ""}
        ${qaBtn}
        <button class="btn small ${x.status === "missing" ? "primary" : ""}" data-copy="${x.id}">${t({ cs: "Odkaz pro řečníka", en: "Speaker link" })}</button>
        <button class="btn small ghost" data-upfor="${x.id}">${t({ cs: "Nahrát za řečníka", en: "Upload for speaker" })}</button>
        ${edit}
      </div>
    </div>
    ${uploadFor === x.id ? `<div class="upfor">
      ${busy?.id === x.id
        ? `<div class="big">${t({ cs: "Nahrávám a kontroluji…", en: "Uploading and checking…" })} ${busy.pct < 100 ? busy.pct + " %" : ""}</div>`
        : `<div class="drop small-drop" data-updrop="${x.id}">
            <div>${t({ cs: "Přetáhněte sem prezentaci (PowerPoint, Keynote, PDF)", en: "Drop the presentation here (PowerPoint, Keynote, PDF)" })}</div>
            <input type="file" id="upfile-${x.id}" data-upfile="${x.id}" accept=".pptx,.ppt,.key,.pdf,.odp" hidden>
            <button class="btn small primary" type="button" data-uppick="${x.id}">${t({ cs: "Vybrat soubor", en: "Choose file" })}</button>
          </div>
          <form class="gslides" data-uplink="${x.id}">
            <label class="field grow"><span>${t({ cs: "Nebo odkaz na Google Slides (sdílený „Kdokoli s odkazem“)", en: "Or a Google Slides link (shared with “Anyone with the link”)" })}</span>
              <input id="uplink-${x.id}" name="url" type="url" required placeholder="https://docs.google.com/presentation/d/…"></label>
            <button class="btn small">${t({ cs: "Načíst", en: "Import" })}</button>
          </form>`}
    </div>` : ""}
  </div>`;
}

function addFormHTML(roomId, kind) {
  return `<form class="talk-form" id="add-talk">
    <div class="seg" role="group" aria-label="${t({ cs: "Co přidáváte", en: "What are you adding" })}">
      <button type="button" data-switch="talk" aria-pressed="${kind === "talk"}">${t({ cs: "Přednáška", en: "Talk" })}</button>
      <button type="button" data-switch="break" aria-pressed="${kind === "break"}">${t({ cs: "Přestávka", en: "Break" })}</button>
      <button type="button" data-switch="panel" aria-pressed="${kind === "panel"}">${t({ cs: "Panel", en: "Panel" })}</button>
    </div>
    ${fieldsHTML({ roomId, startsAt: adding.startsAt || nextStart(roomId), durationMin: { break: 15, panel: 40 }[kind] || 20 }, kind)}
    <input type="hidden" name="kind" value="${kind}">
    <div class="row"><button class="btn primary">${t({ cs: "Přidat", en: "Add" })}</button><button class="btn ghost" type="button" data-cancel>${t({ cs: "Zrušit", en: "Cancel" })}</button></div>
  </form>`;
}

function fieldsHTML(x, kind) {
  const id = x.id ? `e${x.id}` : "n";
  if (kind === "panel") return panelFieldsHTML(x, id);
  return `
    <div class="row">
      ${kind === "break"
        ? `<label class="field grow"><span>${t({ cs: "Název", en: "Name" })}</span><input id="${id}-title" name="title" value="${esc(x.title || "")}" placeholder="${t({ cs: "Přestávka na kávu", en: "Coffee break" })}"></label>`
        : `<label class="field grow"><span>${t({ cs: "Název přednášky", en: "Talk title" })}</span><input id="${id}-title" name="title" required value="${esc(x.title || "")}" autofocus></label>
           <label class="field"><span>${t({ cs: "Řečník", en: "Speaker" })}</span><input id="${id}-speaker" name="speaker" value="${esc(x.speaker || "")}"></label>`}
    </div>
    <div class="row">
      <label class="field"><span>${t({ cs: "Začátek", en: "Start" })}</span><input id="${id}-time" name="startsAt" type="time" value="${esc(x.startsAt || "")}"></label>
      <label class="field"><span>${t({ cs: "Délka (min)", en: "Length (min)" })}</span><input id="${id}-len" name="durationMin" type="number" min="1" max="600" value="${x.durationMin || 20}"></label>
      ${view.rooms.length > 1 || !x.roomId ? `<label class="field"><span>${t({ cs: "Sál", en: "Room" })}</span><select id="${id}-room" name="roomId">
        ${view.rooms.map(r => `<option value="${r.id}" ${r.id === x.roomId ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
        <option value="" ${!x.roomId ? "selected" : ""}>${t({ cs: "Bez sálu", en: "No room" })}</option>
      </select></label>` : `<input type="hidden" name="roomId" value="${x.roomId}">`}
    </div>`;
}

function panelFieldsHTML(x, id) {
  const people = x.panelists?.length ? x.panelists : ["", ""];
  return `
    <div class="row">
      <label class="field grow"><span>${t({ cs: "Téma panelu", en: "Panel topic" })}</span><input id="${id}-title" name="title" value="${esc(x.title && x.title !== "Panelová diskuse" ? x.title : "")}" placeholder="${t({ cs: "Budoucnost B2B prodeje", en: "The future of B2B sales" })}" autofocus></label>
      <label class="field"><span>${t({ cs: "Moderátor", en: "Moderator" })}</span><input id="${id}-moderator" name="moderator" value="${esc(x.moderator || "")}"></label>
    </div>
    <fieldset class="field panelists" data-panelists>
      <legend>${t({ cs: "Řečníci v panelu", en: "Panelists" })}</legend>
      ${people.map((n, i) => panelistRow(id, i, n)).join("")}
      <button type="button" class="btn small" data-add-panelist="${id}">${t({ cs: "+ Přidat řečníka", en: "+ Add panelist" })}</button>
    </fieldset>
    <div class="row">
      <label class="field"><span>${t({ cs: "Začátek", en: "Start" })}</span><input id="${id}-time" name="startsAt" type="time" value="${esc(x.startsAt || "")}"></label>
      <label class="field"><span>${t({ cs: "Délka (min)", en: "Length (min)" })}</span><input id="${id}-len" name="durationMin" type="number" min="1" max="600" value="${x.durationMin || 40}"></label>
      ${view.rooms.length > 1 || !x.roomId ? `<label class="field"><span>${t({ cs: "Sál", en: "Room" })}</span><select id="${id}-room" name="roomId">
        ${view.rooms.map(r => `<option value="${r.id}" ${r.id === x.roomId ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
      </select></label>` : `<input type="hidden" name="roomId" value="${x.roomId}">`}
    </div>
    <p class="muted" style="font-size:13px;margin:0">${t({ cs: "Pozadí na projekci nahrajete po uložení. Bez něj se ukáže slide s tématem a jmény.", en: "Upload a projection background after saving. Without one, a slide with the topic and names is shown." })}</p>`;
}
const panelistRow = (id, i, name = "") => `<div class="room-row"><input name="panelist" id="${id}-p${i}" value="${esc(name)}" placeholder="${t({ cs: "Jméno a firma", en: "Name and company" })}" aria-label="${t({ cs: "Řečník", en: "Panelist" })} ${i + 1}"><button type="button" class="btn small ghost" data-del-panelist aria-label="${t({ cs: "Odebrat", en: "Remove" })}">✕</button></div>`;

// form values incl. the repeated "panelist" fields
function talkFormData(f) {
  const d = Object.fromEntries(new FormData(f));
  if (f.querySelector("[data-panelists]")) { d.panelists = new FormData(f).getAll("panelist").map(s => s.trim()).filter(Boolean); delete d.panelist; }
  return d;
}

// hosted version: activation = order with invoice; until then the projection shows a watermark
function billingHTML() {
  const b = view.billing;
  if (!b?.enabled) return "";
  const price = `${b.price.toLocaleString("cs-CZ")} Kč`;
  const invoice = `<a href="#fakturace">${t({ cs: "Doklady najdete dole v sekci Fakturace", en: "Documents are in the Invoices section below" })}</a>`;
  if (b.status === "paid") return `<div class="bill done"><span class="st ready">${t({ cs: "Akce je aktivní a zaplacená", en: "The event is active and paid" })}</span>${invoice}<span class="muted">${t({ cs: "Děkujeme.", en: "Thank you." })}</span></div>`;
  if (b.status === "ordered") return `<div class="bill done"><span class="st warning">${t({ cs: "Akce je aktivní, čekáme na úhradu", en: "The event is active, waiting for payment" })}</span>${invoice}
    <span class="muted">${t({ cs: `Zálohová faktura ${esc(b.invoiceNumber || "")}, splatnost 14 dní.`, en: `Proforma ${esc(b.invoiceNumber || "")}, due in 14 days.` })}</span></div>`;
  const c = billDraft;
  return `<section class="bill">
    <div class="bill-head">
      <div><h2>${t({ cs: "Zkušební režim", en: "Trial mode" })}</h2>
        <p class="sub">${t({
          cs: "Všechno funguje, jen na projekci je přes slidy vodoznak „Zkušební režim“. Program, řečníky i generálku v sále si klidně vyzkoušejte. Až budete chtít čistou projekci, aktivujte akci.",
          en: "Everything works; the projection just shows a “trial” watermark over the slides. Try the programme, speakers and a rehearsal in the room. When you want a clean projection, activate the event.",
        })}</p></div>
      ${billOpen ? "" : `<button class="btn primary" id="bill-open">${t({ cs: "Aktivovat akci", en: "Activate event" })} · ${price}</button>`}
    </div>
    ${billOpen ? `<form id="bill-form" class="stack">
      <div class="row">
        <label class="field"><span>${t({ cs: "IČO", en: "Company ID (IČO)" })}</span><input id="b-ico" name="ico" inputmode="numeric" maxlength="8" value="${esc(c.ico || "")}" placeholder="12345678"></label>
        <button class="btn" type="button" id="b-ares">${t({ cs: "Doplnit z ARES", en: "Fill in from ARES" })}</button>
      </div>
      <div class="row">
        <label class="field grow"><span>${t({ cs: "Firma nebo jméno", en: "Company or name" })}</span><input id="b-name" name="name" required value="${esc(c.name || "")}"></label>
        <label class="field"><span>${t({ cs: "DIČ (nepovinné)", en: "VAT ID (optional)" })}</span><input id="b-dic" name="dic" value="${esc(c.dic || "")}"></label>
      </div>
      <div class="row">
        <label class="field grow"><span>${t({ cs: "Ulice a číslo", en: "Street and number" })}</span><input id="b-street" name="street" required value="${esc(c.street || "")}"></label>
        <label class="field"><span>${t({ cs: "Město", en: "City" })}</span><input id="b-city" name="city" required value="${esc(c.city || "")}"></label>
        <label class="field"><span>${t({ cs: "PSČ", en: "Postcode" })}</span><input id="b-zip" name="zip" required value="${esc(c.zip || "")}"></label>
      </div>
      <label class="field"><span>${t({ cs: "E-mail pro fakturu", en: "E-mail for the invoice" })}</span><input id="b-email" name="email" type="email" required value="${esc(c.email || "")}"></label>
      <div class="row"><button class="btn primary">${t({ cs: "Objednat a aktivovat", en: "Order and activate" })} · ${price}</button><button class="btn ghost" type="button" id="bill-close">${t({ cs: "Zrušit", en: "Cancel" })}</button></div>
      <p class="muted" style="font-size:13px;margin:0">${t({
        cs: "Akce se aktivuje hned. Zálohovou fakturu (splatnost 14 dní) najdete tady ve správě akce v sekci Fakturace, po úhradě tam přibude faktura. Nejsem plátce DPH, cena je konečná.",
        en: "The event is activated right away. The proforma invoice (due in 14 days) is right here in the Invoices section; after payment the invoice appears there too. Not a VAT payer; the price is final.",
      })}</p>
    </form>` : ""}
  </section>`;
}

function loopHTML() {
  const rooms = view.rooms;
  return `<section class="loop">
    <div class="room-h"><h2>${t({ cs: "Smyčka partnerů", en: "Partner loop" })}</h2>
      <div class="tools"><span class="muted">${t({ cs: "Běží na projekci o přestávkách a mezi přednáškami", en: "Plays on the projection during breaks and between talks" })}</span>
        ${view.media.length ? `<button class="btn small primary" id="loop-play">▶ ${t({ cs: "Přehrát smyčku", en: "Play the loop" })}</button>` : ""}</div></div>
    <div class="drop small-drop" id="loop-drop">
      ${uploading
        ? `<div class="big">${t({ cs: "Nahrávám", en: "Uploading" })} ${uploading.i}/${uploading.n}</div><div class="bar"><i style="width:${uploading.pct}%"></i></div>`
        : `<div class="big">${t({ cs: "Přetáhněte sem fotky a videa partnerů", en: "Drop partner photos and videos here" })}</div>
           <div class="small">${t({ cs: "JPG, PNG, WebP, GIF, SVG, MP4, MOV · klidně víc najednou · videa hrají bez zvuku", en: "JPG, PNG, WebP, GIF, SVG, MP4, MOV · several at once is fine · videos play muted" })}</div>
           <input type="file" id="loop-file" accept="image/*,.svg,video/mp4,video/webm,video/quicktime,.mov,.m4v" multiple hidden>
           <button class="btn primary" id="loop-pick" type="button">${t({ cs: "Vybrat soubory", en: "Choose files" })}</button>`}
    </div>
    ${loopReport ? `<div class="loop-report ${loopReport.failed.length ? "bad" : ""}" role="status">
      <b>${t({ cs: `Nahráno ${loopReport.ok} z ${loopReport.ok + loopReport.failed.length}`, en: `Uploaded ${loopReport.ok} of ${loopReport.ok + loopReport.failed.length}` })}</b>
      ${loopReport.failed.length ? `<ul>${loopReport.failed.map(f => `<li><span class="mono">${esc(f.name)}</span>: ${esc(f.why)}</li>`).join("")}</ul>` : ""}
      <button class="btn small ghost" type="button" id="loop-report-close">${t({ cs: "Zavřít", en: "Close" })}</button>
    </div>` : ""}
    ${view.media.length ? `<div class="media">${view.media.map((m, i) => `
      <div class="mitem">
        <div class="mthumb">${m.kind === "video"
          ? `<video src="${m.url}" muted preload="metadata" playsinline></video><span class="mtag">Video</span>`
          : `<img src="${m.url}" alt="" loading="lazy">`}</div>
        <div class="mname" title="${esc(m.fileName)}">${esc(m.fileName)}</div>
        <div class="mrow">
          ${m.kind === "image"
            ? `<label class="mdur">${t({ cs: "Zobrazit", en: "Show for" })} <input id="dur-${m.id}" data-dur="${m.id}" type="number" min="2" max="600" value="${m.durationSec}"> s</label>`
            : `<span class="muted">${fmtSize(m.size)} · ${t({ cs: "celé video", en: "full video" })}</span>`}
        </div>
        ${rooms.length > 1 ? `<select id="mroom-${m.id}" data-mroom="${m.id}" aria-label="${t({ cs: "Kde se zobrazí", en: "Where it shows" })}">
          <option value="">${t({ cs: "Všechny sály", en: "All rooms" })}</option>
          ${rooms.map(r => `<option value="${r.id}" ${r.id === m.roomId ? "selected" : ""}>${t({ cs: "Jen", en: "Only" })} ${esc(r.name)}</option>`).join("")}
        </select>` : ""}
        <div class="mrow">
          <span>
            <button class="btn small ghost" data-move="${m.id}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="${t({ cs: "Posunout dopředu", en: "Move earlier" })}">←</button>
            <button class="btn small ghost" data-move="${m.id}" data-dir="1" ${i === view.media.length - 1 ? "disabled" : ""} aria-label="${t({ cs: "Posunout dozadu", en: "Move later" })}">→</button>
          </span>
          <button class="btn small ghost" data-mdel="${m.id}">${t({ cs: "Smazat", en: "Delete" })}</button>
        </div>
      </div>`).join("")}</div>` : ""}
  </section>`;
}

function bind() {
  const on = (sel, fn) => app.querySelectorAll(sel).forEach(el => fn(el));
  const { talks, rooms } = view;
  const sure = t({ cs: "Opravdu?", en: "Sure?" });

  $("#remind")?.addEventListener("click", openReminders);
  on("[data-import]", b => (b.onclick = () => openImport(async rows => {
    try {
      view = await api("POST", `${base}/import`, { rows, roomId: +b.dataset.import });
      render();
      toast(t({ cs: `Přidáno do programu: ${view.imported}. Teď pošlete řečníkům jejich odkazy.`, en: `Added to the programme: ${view.imported}. Now send the speakers their links.` }));
    } catch (e) { toast(e.message); throw e; }
  })));
  $("#deadline")?.addEventListener("change", e => act("PATCH", "", { deadline: e.target.value }, e.target.value ? t({ cs: "Termín uložen. Řečníci ho uvidí na svém odkazu.", en: "Deadline saved. Speakers see it on their link." }) : t({ cs: "Termín zrušen", en: "Deadline removed" })));
  $("#public-on")?.addEventListener("change", e => act("PATCH", "", { publicEnabled: e.target.checked }, e.target.checked ? t({ cs: "Stránka akce je veřejná", en: "The event page is public" }) : t({ cs: "Stránka akce je skrytá", en: "The event page is hidden" })));
  $("#sign-pick")?.addEventListener("click", () => $("#sign-file").click());
  $("#sign-file")?.addEventListener("change", async e => {
    const f = e.target.files[0];
    if (!f) return;
    toast(t({ cs: "Nahrávám pozadí…", en: "Uploading background…" }));
    try { view = await putFile(`${base}/sign-background?name=${encodeURIComponent(f.name)}`, f, () => {}); render(); toast(t({ cs: "Pozadí cedulky nahrané. Cedulky u dveří si ho načtou samy.", en: "Door sign background uploaded. The signs pick it up by themselves." })); }
    catch (err) { toast(err.message); }
  });
  $("#sign-del")?.addEventListener("click", () => act("DELETE", "/sign-background", null, t({ cs: "Pozadí cedulky odebráno", en: "Door sign background removed" })));
  $("#copy-public")?.addEventListener("click", () => copy(location.origin + view.event.publicPath, t({ cs: "Odkaz zkopírován. Pošlete ho účastníkům.", en: "Link copied. Send it to attendees." })));
  on("[data-msg]", f => (f.onsubmit = async e => {
    e.preventDefault();
    const text = (f.elements.text.value || f.elements.preset.value).trim();
    if (!text) return toast(t({ cs: "Vyberte nebo napište zprávu.", en: "Pick or type a message." }));
    try { await api("POST", `${base}/rooms/${f.dataset.msg}/message`, { text }); f.reset(); toast(t({ cs: "Zpráva je na monitoru řečníka", en: "The message is on the speaker monitor" })); }
    catch (err) { toast(err.message); }
  }));
  on("[data-shift]", b => (b.onclick = () => act("POST", `/rooms/${b.dataset.shift}/shift`, { afterTalkId: +b.dataset.after, minutes: +b.dataset.min }, t({ cs: `Program posunut o ${b.dataset.min} min. Sál si nové časy stáhne sám.`, en: `Programme moved by ${b.dataset.min} min. The room picks up the new times by itself.` }))));
  on("[data-msg-clear]", b => (b.onclick = async () => {
    try { await api("POST", `${base}/rooms/${b.dataset.msgClear}/message`, { text: "" }); toast(t({ cs: "Zpráva smazána", en: "Message cleared" })); }
    catch (err) { toast(err.message); }
  }));

  on("[data-add]", b => (b.onclick = () => { adding = { roomId: +b.dataset.add, kind: b.dataset.kind }; editing = null; render(); $("#add-talk input:not([type=hidden])")?.focus(); }));
  // switch talk ↔ break without losing the start time
  on("[data-switch]", b => (b.onclick = () => {
    if (adding.kind === b.dataset.switch) return;
    adding = { ...adding, kind: b.dataset.switch, startsAt: $("#add-talk [name=startsAt]")?.value };
    render();
    $("#add-talk input:not([type=hidden])")?.focus();
  }));
  const addForm = $("#add-talk");
  if (addForm) addForm.onsubmit = async e => {
    e.preventDefault();
    const kind = adding.kind;
    const done = { break: t({ cs: "Přestávka přidána", en: "Break added" }), panel: t({ cs: "Panel přidán", en: "Panel added" }) }[kind] || t({ cs: "Přednáška přidána", en: "Talk added" });
    if (await act("POST", "/talks", talkFormData(addForm), done)) {
      adding = { roomId: adding.roomId, kind: "talk" }; // after a break comes a talk, usually
      render(); // keep the form open for the next one
      $("#add-talk input:not([type=hidden])")?.focus();
    }
  };
  on("[data-cancel]", b => (b.onclick = () => { adding = null; editing = null; render(); }));
  on("[data-copy]", b => (b.onclick = () => copy(speakerUrl(talks.find(x => x.id === +b.dataset.copy)), t({ cs: "Odkaz zkopírován. Pošlete ho řečníkovi.", en: "Link copied. Send it to the speaker." }))));
  on("[data-preview]", b => (b.onclick = async () => {
    try {
      const p = await api("GET", `${base}/talks/${b.dataset.preview}/preview`);
      const id = +b.dataset.preview;
      openPreview({
        title: p.talk.title,
        subtitle: [p.talk.speaker, p.talk.fileName].filter(Boolean).join(" · "),
        pdfUrl: p.pdfUrl, thumbUrl: p.thumbUrl, notes: p.notes, videos: p.talk.videos,
        issues: p.talk.issues.filter(i => i.level === "warn" || i.level === "error").map(i => ({ ...i, text: issueText(i) })),
        originalUrl: p.originalUrl, fileName: p.talk.fileName, fileSize: p.talk.fileSize,
        saveNotes: async notes => { view = await api("PUT", `${base}/talks/${id}/notes`, { notes }); render(); },
        approve: p.talk.status === "warning"
          ? async () => act("PATCH", `/talks/${id}`, { reviewed: true }, t({ cs: "Označeno jako v pořádku", en: "Marked as fine" }))
          : null,
      });
    } catch (e) { toast(e.message); }
  }));
  // upload on the speaker's behalf
  on("[data-upfor]", b => (b.onclick = () => { uploadFor = uploadFor === +b.dataset.upfor ? null : +b.dataset.upfor; render(); }));
  on("[data-vpick]", b => (b.onclick = () => !busy && $(`[data-vfile="${b.dataset.vpick}"]`).click()));
  on("[data-vfile]", i => (i.onchange = () => i.files[0] && uploadVideo(i.dataset.vfile, i.files[0])));
  on("[data-uppick]", b => (b.onclick = () => $(`#upfile-${b.dataset.uppick}`).click()));
  on("[data-upfile]", i => (i.onchange = () => i.files[0] && uploadForTalk(+i.dataset.upfile, i.files[0])));
  on("[data-updrop]", d => {
    d.ondragover = e => { e.preventDefault(); d.classList.add("over"); };
    d.ondragleave = () => d.classList.remove("over");
    d.ondrop = e => { e.preventDefault(); d.classList.remove("over"); e.dataTransfer.files[0] && uploadForTalk(+d.dataset.updrop, e.dataTransfer.files[0]); };
  });
  on("form[data-uplink]", f => (f.onsubmit = async e => {
    e.preventDefault();
    const id = +f.dataset.uplink;
    busy = { id, pct: 100 }; render();
    const ok = await act("POST", `/talks/${id}/link`, formData(f), t({ cs: "Načteno z Google Slides", en: "Imported from Google Slides" }));
    busy = null; if (ok) uploadFor = null; render();
  }));
  // panelists: add / remove rows (one name per row)
  on("[data-add-panelist]", b => (b.onclick = () => {
    const box = b.closest("[data-panelists]");
    const n = box.querySelectorAll("input[name=panelist]").length;
    b.insertAdjacentHTML("beforebegin", panelistRow(b.dataset.addPanelist, n));
    box.querySelectorAll("input[name=panelist]")[n].focus();
    box.querySelectorAll("[data-del-panelist]")[n].onclick = e => e.target.closest(".room-row").remove();
  }));
  on("[data-del-panelist]", b => (b.onclick = () => b.closest(".room-row").remove()));
  // panel background
  on("[data-bg]", b => (b.onclick = () => $(`#bg-${b.dataset.bg}`).click()));
  on("[data-bg-file]", i => (i.onchange = async () => {
    const f = i.files[0]; if (!f) return;
    toast(t({ cs: "Nahrávám pozadí…", en: "Uploading background…" }));
    try { view = await putFile(`${base}/talks/${i.dataset.bgFile}/background?name=${encodeURIComponent(f.name)}`, f, () => {}); render(); toast(t({ cs: "Pozadí nahrané", en: "Background uploaded" })); }
    catch (e) { toast(e.message); }
  }));
  on("[data-bg-del]", b => (b.onclick = () => act("DELETE", `/talks/${b.dataset.bgDel}/background`, null, t({ cs: "Pozadí odebráno", en: "Background removed" }))));
  on("[data-qa]", b => (b.onclick = () => openQuestions(+b.dataset.qa)));
  on("[data-approve]", b => (b.onclick = () => act("PATCH", `/talks/${b.dataset.approve}`, { reviewed: true }, t({ cs: "Označeno jako v pořádku", en: "Marked as fine" }))));
  on("[data-edit]", b => (b.onclick = () => { editing = +b.dataset.edit; adding = null; render(); }));
  on("[data-del]", b => (b.onclick = () => confirmClick(b, t({ cs: "Opravdu smazat?", en: "Really delete?" }), () => act("DELETE", `/talks/${b.dataset.del}`, null, t({ cs: "Smazáno", en: "Deleted" })))));
  on("form[data-save]", f => (f.onsubmit = async e => {
    e.preventDefault();
    if (await act("PATCH", `/talks/${f.dataset.save}`, talkFormData(f), t({ cs: "Uloženo", en: "Saved" }))) { editing = null; render(); }
  }));

  on("[data-pair]", b => (b.onclick = () => { const id = +b.dataset.pair; pairOpen.has(id) ? pairOpen.delete(id) : pairOpen.add(id); render(); }));
  on("[data-copy-pair]", b => (b.onclick = () => copy(pairUrl(rooms.find(r => r.id === +b.dataset.copyPair)), t({ cs: "Odkaz zkopírován. Otevřete ho na počítači v sále.", en: "Link copied. Open it on the computer in the room." }))));
  on("[data-del-room]", b => (b.onclick = () => confirmClick(b, t({ cs: "Opravdu? Program zůstane bez sálu", en: "Sure? Its talks will have no room" }), () => act("DELETE", `/rooms/${b.dataset.delRoom}`, null, t({ cs: "Sál smazán", en: "Room deleted" })))));
  $("#copy-mcp").onclick = () => copy(mcpCommand(), t({ cs: "Příkaz zkopírován. Vložte ho do terminálu.", en: "Command copied. Paste it into your terminal." }));
  $("#copy-mcp-url").onclick = () => copy(mcpUrl(), t({ cs: "Adresa zkopírována. Vložte ji do nastavení konektoru MCP.", en: "Address copied. Paste it into the MCP connector settings." }));
  $("#rotate").onclick = e => confirmClick(e.target, t({ cs: "Opravdu? Starý odkaz přestane platit", en: "Sure? The old link will stop working" }), async () => {
    try {
      const { adminToken } = await api("POST", `${base}/rotate`);
      location.replace(`/e/${adminToken}#novy-odkaz`);
    } catch (err) { toast(err.message); }
  });
  $("#delete-event").onclick = () => confirmTyped(async () => {
    try {
      await api("DELETE", base);
      app.innerHTML = t({
        cs: `<h1>Akce je smazaná.</h1><p class="sub">Všechny soubory i program jsou pryč. <a href="/nova-akce">Založit novou akci</a></p>`,
        en: `<h1>The event is deleted.</h1><p class="sub">All files and the programme are gone. <a href="/nova-akce">Create a new event</a></p>`,
      });
    } catch (err) { toast(err.message); }
  });
  // activation / invoice
  $("#bill-open")?.addEventListener("click", () => { billOpen = true; render(); $("#b-ico").focus(); });
  $("#bill-close")?.addEventListener("click", () => { billOpen = false; render(); });
  const billForm = $("#bill-form");
  if (billForm) {
    billForm.oninput = () => { billDraft = formData(billForm); };
    $("#b-ares").onclick = async () => {
      const ico = $("#b-ico").value.replace(/\s/g, "");
      try {
        const r = await api("GET", `/api/ares/${ico}`);
        billDraft = { ...formData(billForm), ico: r.ico, name: r.name, dic: r.dic || "", street: r.street || "", city: r.city || "", zip: r.zip || "" };
        render(); $("#b-email").focus(); toast(t({ cs: "Údaje doplněné z ARES", en: "Details filled in from ARES" }));
      } catch (e) { toast(e.message); }
    };
    billForm.onsubmit = async e => {
      e.preventDefault();
      const btn = billForm.querySelector("button.primary");
      btn.disabled = true; btn.textContent = t({ cs: "Vystavuji fakturu…", en: "Issuing the invoice…" });
      if (await act("POST", "/order", formData(billForm), t({ cs: "Hotovo. Akce je aktivní, zálohová faktura je dole v sekci Fakturace.", en: "Done. The event is active; the proforma is in the Invoices section below." }))) { billOpen = false; billDraft = {}; render(); loadDocs(); }
      else { btn.disabled = false; render(); }
    };
  }
  $("#to-multi")?.addEventListener("click", () => act("PATCH", "", { mode: "multi" }, t({ cs: "Hotovo, teď můžete přidávat sály", en: "Done, you can add rooms now" })));
  $("#new-room")?.addEventListener("click", () => { addingRoom = true; render(); $("#room-name").focus(); });
  $("#cancel-room")?.addEventListener("click", () => { addingRoom = false; render(); });
  const roomForm = $("#add-room");
  if (roomForm) roomForm.onsubmit = async e => { e.preventDefault(); if (await act("POST", "/rooms", formData(roomForm), t({ cs: "Sál přidán", en: "Room added" }))) { addingRoom = false; render(); } };

  // loop
  const drop = $("#loop-drop"), input = $("#loop-file");
  if (input) {
    $("#loop-pick").onclick = () => input.click();
    input.onchange = () => uploadMedia([...input.files]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); uploadMedia([...e.dataTransfer.files]); };
  }
  $("#loop-play")?.addEventListener("click", () => {
    // the first talk in the programme stands in for "next" in the bar
    const next = talksOnly().find(x => x.startsAt) || talksOnly()[0] || null;
    playLoop(view.media, next);
  });
  $("#loop-report-close")?.addEventListener("click", () => { loopReport = null; render(); });
  on("[data-dur]", i => (i.onchange = () => act("PATCH", `/media/${i.dataset.dur}`, { durationSec: +i.value }, t({ cs: "Uloženo", en: "Saved" }))));
  on("[data-mroom]", s => (s.onchange = () => act("PATCH", `/media/${s.dataset.mroom}`, { roomId: s.value ? +s.value : null }, t({ cs: "Uloženo", en: "Saved" }))));
  on("[data-move]", b => (b.onclick = () => act("PATCH", `/media/${b.dataset.move}`, { move: +b.dataset.dir })));
  on("[data-mdel]", b => (b.onclick = () => confirmClick(b, sure, () => act("DELETE", `/media/${b.dataset.mdel}`, null, t({ cs: "Odebráno ze smyčky", en: "Removed from the loop" })))));
}

// questions of one talk: QR to show/print, live list, answer / hide, Q&A on/off
async function openQuestions(id) {
  const talk = view.talks.find(x => x.id === id);
  const dlg = document.createElement("dialog");
  dlg.className = "preview qa-admin";
  document.body.append(dlg);
  let timer = null;
  // the poll box lives across redraws of the dialog (it refreshes itself)
  const pollBox = document.createElement("div");
  pollBox.className = "qa-poll";
  const polls = mountPolls(pollBox, { listUrl: `${base}/talks/${id}/polls`, itemUrl: pid => `${base}/polls/${pid}` });
  async function draw() {
    let d;
    try { d = await api("GET", `${base}/talks/${id}/questions`); } catch (e) { toast(e.message); return; }
    const list = d.questions;
    dlg.innerHTML = `
      <header class="pv-head">
        <div><div class="label">${t({ cs: "Dotazy z publika", en: "Audience questions" })}</div><h2>${esc(talk.title)}</h2>
          <div class="muted">${list.filter(q => !q.answered && !q.hidden).length} ${t({ cs: "nezodpovězených", en: "open" })} · ${list.length} ${t({ cs: "celkem", en: "total" })}</div></div>
        <div class="pv-actions"><button class="btn small primary" data-close>${t({ cs: "Zavřít", en: "Close" })}</button></div>
      </header>
      <div class="qa-body">
        <aside class="qa-qr">
          <img src="/api/qa/${talk.qaToken}/qr.svg" alt="QR">
          <code>${esc(d.qaUrl)}</code>
          <div class="row"><button class="btn small" data-copyqa>${t({ cs: "Zkopírovat odkaz", en: "Copy link" })}</button>
            <a class="btn small ghost" href="${esc(d.qaUrl)}" target="_blank" rel="noopener">${t({ cs: "Otevřít", en: "Open" })}</a></div>
          <label class="toggle"><input type="checkbox" id="qa-on" ${d.qaEnabled ? "checked" : ""}>
            <span>${t({ cs: "Dotazy zapnuté (QR v rohu projekce)", en: "Questions on (QR in the projection corner)" })}</span></label>
        </aside>
        <ul class="qlist admin">${list.length ? list.map(q => `
          <li class="${q.answered ? "answered" : ""} ${q.hidden ? "hidden-q" : ""}">
            <div class="votes"><b>${q.votes}</b><span class="muted">${t({ cs: "hlasů", en: "votes" })}</span></div>
            <div><p>${esc(q.text)}</p><span class="muted">${esc(q.author || t({ cs: "Anonym", en: "Anonymous" }))}${q.hidden ? ` · ${t({ cs: "skryto", en: "hidden" })}` : ""}</span></div>
            <div class="qa-acts">
              <button class="btn small ${q.answered ? "" : "primary"}" data-ans="${q.id}" data-v="${q.answered ? 0 : 1}">${q.answered ? t({ cs: "Vrátit", en: "Reopen" }) : "✓ " + t({ cs: "Zodpovězeno", en: "Answered" })}</button>
              <button class="btn small ghost" data-hide="${q.id}" data-v="${q.hidden ? 0 : 1}">${q.hidden ? t({ cs: "Zobrazit", en: "Show" }) : t({ cs: "Skrýt", en: "Hide" })}</button>
            </div>
          </li>`).join("") : `<li class="empty-q muted">${t({ cs: "Zatím žádné dotazy. Diváci je pošlou přes QR kód.", en: "No questions yet. The audience sends them via the QR code." })}</li>`}</ul>
      </div>`;
    dlg.querySelector(".qa-qr").append(pollBox);
    if (!pollBox.childElementCount) polls.show();
    dlg.querySelector("[data-close]").onclick = () => dlg.close();
    dlg.querySelector("[data-copyqa]").onclick = () => copy(d.qaUrl, t({ cs: "Odkaz na dotazy zkopírován", en: "Questions link copied" }));
    dlg.querySelector("#qa-on").onchange = async e => { await act("PATCH", `/talks/${id}`, { qaEnabled: e.target.checked }); draw(); };
    dlg.querySelectorAll("[data-ans]").forEach(b => (b.onclick = async () => { await api("PATCH", `${base}/questions/${b.dataset.ans}`, { answered: b.dataset.v === "1" }); draw(); }));
    dlg.querySelectorAll("[data-hide]").forEach(b => (b.onclick = async () => { await api("PATCH", `${base}/questions/${b.dataset.hide}`, { hidden: b.dataset.v === "1" }); draw(); }));
  }
  await draw();
  dlg.showModal();
  timer = setInterval(draw, 5000);
  dlg.addEventListener("close", () => { clearInterval(timer); polls.stop(); dlg.remove(); load(); });
}

// ready-to-send reminders for speakers who haven't uploaded (no e-mail service needed: copy and paste)
function reminderText(x) {
  const e = view.event, first = (x.speaker || "").split(" ")[0];
  const when = [e.date && fmtDay(e.date), x.startsAt].filter(Boolean).join(", ");
  return lang === "en"
    ? `Hello${first ? ` ${first}` : ""},\n\nplease upload the presentation for your talk “${x.title}” at ${e.name}${when ? ` (${when})` : ""}${e.deadline ? ` by ${fmtDay(e.deadline)}` : ""}:\n${speakerUrl(x)}\n\nIt takes a minute and you'll see right away how it will look in the room. No need to bring a USB stick.\n\nThank you!`
    : `Dobrý den,\n\nprosím nahrajte prezentaci k vystoupení „${x.title}“ na akci ${e.name}${when ? ` (${when})` : ""}${e.deadline ? ` do ${fmtDay(e.deadline)}` : ""}:\n${speakerUrl(x)}\n\nNahrání zabere minutu a hned uvidíte, jak bude prezentace vypadat v sále. Flashku pak nemusíte nosit.\n\nDěkuji!`;
}
function openReminders() {
  const list = talksOnly().filter(x => x.kind === "talk" && x.status === "missing");
  const dlg = document.createElement("dialog");
  dlg.className = "preview remind";
  dlg.innerHTML = `
    <header class="pv-head">
      <div><div class="label">${t({ cs: "Připomínky", en: "Reminders" })}</div><h2>${t({ cs: `Ještě nenahráli: ${list.length}`, en: `Not uploaded yet: ${list.length}` })}</h2>
        <div class="muted">${t({ cs: "Zkopírujte text a pošlete ho e-mailem nebo do chatu. Text můžete upravit.", en: "Copy the text and send it by e-mail or chat. You can edit it." })}</div></div>
      <div class="pv-actions"><button class="btn small" data-all>${t({ cs: "Zkopírovat vše", en: "Copy all" })}</button>
        <button class="btn small" data-links>${t({ cs: "Jen odkazy", en: "Links only" })}</button>
        <button class="btn small primary" data-close>${t({ cs: "Zavřít", en: "Close" })}</button></div>
    </header>
    ${view.event.deadline ? "" : `<p class="pv-note">${t({ cs: "Tip: nastavte ve správě termín <b>Nahrát do</b>, objeví se v připomínce i na stránce řečníka.", en: "Tip: set an <b>Upload by</b> date in the admin; it shows in the reminder and on the speaker's page." })}</p>`}
    <div>${list.map(x => `<div class="rm-item">
      <div class="rm-head"><b>${esc(x.speaker || x.title)}</b><button class="btn small primary" data-copy-rm="${x.id}">${t({ cs: "Zkopírovat", en: "Copy" })}</button></div>
      <textarea id="rm-${x.id}" aria-label="${t({ cs: "Text připomínky", en: "Reminder text" })}">${esc(reminderText(x))}</textarea>
    </div>`).join("")}</div>`;
  document.body.append(dlg);
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  dlg.querySelectorAll("[data-copy-rm]").forEach(b => (b.onclick = () => copy(dlg.querySelector(`#rm-${b.dataset.copyRm}`).value, t({ cs: "Připomínka zkopírována", en: "Reminder copied" }))));
  dlg.querySelector("[data-all]").onclick = () => copy(list.map(x => dlg.querySelector(`#rm-${x.id}`).value).join("\n\n———\n\n"), t({ cs: `Zkopírováno ${list.length} připomínek`, en: `Copied ${list.length} reminders` }));
  dlg.querySelector("[data-links]").onclick = () => copy(list.map(x => `${x.speaker || x.title}: ${speakerUrl(x)}`).join("\n"), t({ cs: `Zkopírováno ${list.length} odkazů`, en: `Copied ${list.length} links` }));
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
}

// deleting the whole event: type the word to confirm (no accidental clicks)
function confirmTyped(fn) {
  const word = t({ cs: "SMAZAT", en: "DELETE" });
  const dlg = document.createElement("dialog");
  dlg.className = "confirm";
  dlg.innerHTML = `<form method="dialog" class="stack">
    <h2>${t({ cs: "Smazat celou akci?", en: "Delete the whole event?" })}</h2>
    <p class="sub">${t({
      cs: `Smaže se program, všechny prezentace, smyčka partnerů i dotazy. <b>Nejde to vrátit.</b> Pro jistotu si nejdřív <a href="${base}/export">stáhněte ZIP</a>.`,
      en: `This deletes the programme, all presentations, the partner loop and questions. <b>It can't be undone.</b> To be safe, <a href="${base}/export">download the ZIP</a> first.`,
    })}</p>
    <label class="field"><span>${t({ cs: `Napište ${word} pro potvrzení`, en: `Type ${word} to confirm` })}</span>
      <input id="confirm-word" autocomplete="off" spellcheck="false"></label>
    <div class="row">
      <button class="btn primary" id="confirm-go" value="go" disabled>${t({ cs: "Smazat akci", en: "Delete event" })}</button>
      <button class="btn ghost" value="cancel">${t({ cs: "Zrušit", en: "Cancel" })}</button>
    </div>
  </form>`;
  document.body.append(dlg);
  const input = dlg.querySelector("#confirm-word"), go = dlg.querySelector("#confirm-go");
  input.oninput = () => { go.disabled = input.value.trim().toUpperCase() !== word; };
  dlg.addEventListener("close", () => { const ok = dlg.returnValue === "go" && !go.disabled; dlg.remove(); if (ok) fn(); });
  dlg.showModal();
  input.focus();
}

// destructive actions need a second click instead of a dialog
function confirmClick(b, label, fn) {
  if (b.dataset.confirm) return fn();
  b.dataset.confirm = "1";
  b.textContent = label;
  setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; render(); } }, 4000);
}

async function uploadForTalk(id, file) {
  busy = { id, pct: 0 };
  render();
  try {
    view = await putFile(`${base}/talks/${id}/file?name=${encodeURIComponent(file.name)}`, file, pct => {
      busy.pct = pct;
      const el = $(".upfor .big"); if (el) el.textContent = `${t({ cs: "Nahrávám a kontroluji…", en: "Uploading and checking…" })} ${pct < 100 ? pct + " %" : ""}`;
    });
    uploadFor = null;
    toast(t({ cs: "Nahráno za řečníka. Sál si prezentaci stáhne automaticky.", en: "Uploaded for the speaker. The room will download it automatically." }));
  } catch (e) { toast(e.message); }
  busy = null;
  render();
}

// the video a presentation only links to (YouTube, the speaker's own disk), uploaded by the organizer
async function uploadVideo(key, file) {
  const [id, i] = key.split(":");
  busy = { id: key, pct: 0 };
  render();
  try {
    view = await putFile(`${base}/talks/${id}/videos/${i}?name=${encodeURIComponent(file.name)}`, file, pct => {
      const b = $(`[data-vpick="${key}"]`); if (b) b.textContent = `${t({ cs: "Nahrávám", en: "Uploading" })} ${pct} %`;
    });
    toast(t({ cs: "Video nahráno. Sál si ho stáhne automaticky.", en: "Video uploaded. The room downloads it automatically." }));
  } catch (e) { toast(e.message); }
  busy = null;
  render();
}

const LOOP_EXT = ["jpg", "jpeg", "png", "webp", "gif", "svg", "avif", "mp4", "m4v", "webm", "mov"];
function loopRejectReason(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (LOOP_EXT.includes(ext)) return file.size > 1024 ** 3 ? t({ cs: "soubor je větší než 1 GB", en: "the file is larger than 1 GB" }) : null;
  if (ext === "heic" || ext === "heif") return t({ cs: "fotka z iPhonu (HEIC) – uložte ji jako JPG", en: "iPhone photo (HEIC) – save it as JPG" });
  if (ext === "pdf") return t({ cs: "PDF – exportujte stránku jako PNG nebo JPG", en: "PDF – export the page as PNG or JPG" });
  return t({ cs: "tenhle formát neumíme (jde JPG, PNG, WebP, GIF, SVG, MP4, MOV)", en: "unsupported format (use JPG, PNG, WebP, GIF, SVG, MP4, MOV)" });
}

async function uploadMedia(files) {
  if (!files.length) return;
  const failed = [];
  const good = files.filter(f => { const why = loopRejectReason(f); if (why) failed.push({ name: f.name, why }); return !why; });
  let ok = 0;
  for (let i = 0; i < good.length; i++) {
    uploading = { i: i + 1, n: good.length, pct: 0 };
    render();
    try { await putFile(`${base}/media?name=${encodeURIComponent(good[i].name)}`, good[i]); ok++; }
    catch (e) { failed.push({ name: good[i].name, why: e.message }); }
  }
  uploading = null;
  loopReport = { ok, failed };
  await load();
  toast(failed.length
    ? t({ cs: `Nahráno ${ok} z ${files.length}. Podrobnosti u smyčky.`, en: `Uploaded ${ok} of ${files.length}. Details by the loop.` })
    : t({ cs: ok === 1 ? "Přidáno do smyčky" : `Přidáno do smyčky: ${ok}`, en: ok === 1 ? "Added to the loop" : `Added to the loop: ${ok}` }));
}

function putFile(url, file, onPct) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      if (onPct) return onPct(pct);
      uploading.pct = pct;
      const bar = $("#loop-drop .bar i");
      if (bar) bar.style.width = uploading.pct + "%";
    };
    xhr.onload = () => {
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 400 ? resolve(res) : reject(new Error(res.error || t({ cs: "Nahrání se nepovedlo", en: "Upload failed" })));
    };
    xhr.onerror = () => reject(new Error(t({ cs: "Spojení se přerušilo", en: "The connection dropped" })));
    xhr.send(file);
  });
}

if (location.hash === "#novy-odkaz") {
  history.replaceState(null, "", location.pathname);
  setTimeout(() => toast(t({ cs: "Hotovo. Tohle je nový odkaz, uložte si ho. Příkaz pro Claude spusťte znovu.", en: "Done. This is the new link, save it. Run the Claude command again." })), 300);
}
langSwitch(render);
chrome();
load();
// refresh status (uploads, players online) while nobody is typing
setInterval(() => {
  if (editing === null && adding === null && uploadFor === null && !addingRoom && !uploading && !billOpen && !document.activeElement?.closest("form, .loop")) load();
}, 15000);
