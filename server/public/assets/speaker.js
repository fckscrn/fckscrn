import { $, esc, api, toast, fmtSize, tokenFromPath } from "./common.js";
import { openPreview } from "./preview.js";
import { lang, t, langSwitch, issueText, errorText } from "./i18n.js";
import { mountPolls } from "./poll-ui.js";

const token = tokenFromPath();
const base = `/api/speaker/${token}`;
const app = $("#app");
let data = null;
let error = null;
let uploading = null; // { name, pct }

const checking = () => t({ cs: "Kontroluji soubor a připravuji ho pro sál…", en: "Checking the file and getting it ready for the room…" });
const slidesText = n => lang === "cs" ? `${n} ${n === 1 ? "slide" : n >= 2 && n <= 4 ? "slidy" : "slidů"}` : `${n} slide${n === 1 ? "" : "s"}`;
const dateText = d => {
  const x = new Date(d + "T12:00:00");
  return isNaN(x) ? d : x.toLocaleDateString(lang === "cs" ? "cs-CZ" : "en-GB", { weekday: "short", day: "numeric", month: lang === "cs" ? "numeric" : "long", year: "numeric" });
};

async function load() {
  try { data = await api("GET", base); error = null; }
  catch (e) { error = e; }
  render();
}

function render() {
  document.title = t({ cs: "Nahrát prezentaci · FckScrn", en: "Upload your presentation · FckScrn" });
  $(".top .muted").textContent = t({ cs: "nahrání prezentace", en: "presentation upload" });
  $("#credit").innerHTML = t({
    cs: `<a href="/napoveda">Nápověda</a> · FckScrn je open source · vytvořil <b>Tomáš Foltas</b>, autor <a href="https://domee.app" rel="noopener">Domee.app</a> – aplikace pro správu nemovitostí`,
    en: `<a href="/en/help">Help</a> · FckScrn is open source · made by <b>Tomáš Foltas</b>, creator of <a href="https://domee.app" rel="noopener">Domee.app</a> – a property management app`,
  });
  if (error) { app.innerHTML = `<p class="error">${esc(errorText(error))}</p>`; return; }
  if (!data) return;

  const { event, room, talk, accepted } = data;
  const first = (talk.speaker || "").split(" ")[0];
  const exts = accepted.map(x => "." + x).join(",");
  let body;

  if (uploading) {
    body = `<div class="drop">
      <div class="big">${t({ cs: "Nahrávám", en: "Uploading" })} <span class="mono">${esc(uploading.name)}</span></div>
      <div class="bar"><i style="width:${uploading.pct}%"></i></div>
      <div class="small">${uploading.pct < 100 ? `${uploading.pct} %` : checking()}</div>
    </div>`;
  } else if (!talk.version) {
    const today = new Date().toISOString().slice(0, 10);
    body = (event.deadline ? `<p class="notice deadline ${event.deadline < today ? "late" : ""}">${event.deadline < today
      ? t({ cs: `Termín pro nahrání byl <b>${esc(dateText(event.deadline))}</b>. Nahrajte prosím prezentaci co nejdřív.`, en: `The upload deadline was <b>${esc(dateText(event.deadline))}</b>. Please upload your presentation as soon as possible.` })
      : t({ cs: `Prosím nahrajte prezentaci do <b>${esc(dateText(event.deadline))}</b>.`, en: `Please upload your presentation by <b>${esc(dateText(event.deadline))}</b>.` })}</p>` : "")
      + dropHTML(exts, t({ cs: "Přetáhněte sem prezentaci", en: "Drop your presentation here" }));
  } else {
    const icon = { ok: "✓", warn: "!", error: "×" };
    // venue-side notes (PDF converter) are the organizer's business, not the speaker's
    const issues = talk.issues.filter(i => i.level !== "info" && i.code !== "new_version");
    const broken = talk.status === "error";
    // a video the room can't get without the speaker: say so instead of "nothing else to do"
    const needsVideo = !broken && issues.some(i => ["video_missing", "video_format"].includes(i.code));
    // "warning" may only mean the organizer has a new version to look at
    const when = talk.uploadedAt ? new Date(talk.uploadedAt.replace(" ", "T") + "Z").toLocaleString(lang === "cs" ? "cs-CZ" : "en-GB", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    body = `<div class="done-card ${broken ? "bad" : ""}" role="status">
        <span class="done-icon" aria-hidden="true">${broken ? "!" : "✓"}</span>
        <div>
          <h2>${broken
            ? t({ cs: "Soubor je nahraný, ale je potřeba ho opravit", en: "The file is uploaded, but it needs fixing" })
            : needsVideo ? t({ cs: "Prezentace je nahraná, ještě chybí video", en: "Your presentation is uploaded, a video is missing" })
            : t({ cs: "Prezentace je nahraná", en: "Your presentation is uploaded" })}</h2>
          <p>${broken
            ? t({ cs: "Podívejte se na upozornění níže a nahrajte opravenou verzi.", en: "See the notes below and upload a fixed version." })
            : needsVideo ? t({ cs: "Nahrajte prosím video níže. Bez něj se v sále na jeho místě ukáže jen obrázek.", en: "Please upload the video below. Without it the room shows just a still image in its place." })
            : t({ cs: "<b>Nic dalšího dělat nemusíte.</b> Sál si ji stáhne sám a na pódiu bude připravená.", en: "<b>Nothing else to do.</b> The room downloads it automatically and it will be ready on stage." })}</p>
          <p class="muted"><span class="mono">${esc(talk.fileName)}</span> · ${fmtSize(talk.fileSize)}${talk.pageCount ? ` · ${slidesText(talk.pageCount)}` : ""}${when ? ` · ${t({ cs: "nahráno", en: "uploaded" })} ${esc(when)}` : ""}</p>
        </div>
        ${talk.hasPdf || talk.hasThumb ? `<div class="done-slide" id="first-slide">${talk.hasPdf ? `<canvas></canvas>` : `<img src="${base}/thumb?v=${talk.version}" alt="">`}</div>` : ""}
      </div>
      <ul class="checks">${issues.map(i => `<li><span>${icon[i.level]}</span><div>${esc(issueText(i))}${VIDEO_FIX.includes(i.code) ? `
        <div class="video-fix"><input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" data-video="${i.i}" hidden>
          <button class="btn small" type="button" data-video-pick="${i.i}">${videoBusy === i.i ? t({ cs: "Nahrávám…", en: "Uploading…" }) : t({ cs: "Nahrát video (MP4)", en: "Upload the video (MP4)" })}</button></div>` : ""}</div></li>`).join("")}</ul>
      <div class="actions">
        <button class="btn" id="preview" type="button">${talk.hasPdf && !talk.notes.some(Boolean)
          ? t({ cs: "Prohlédnout slidy a dopsat poznámky (nepovinné)", en: "Look through slides and add notes (optional)" })
          : t({ cs: "Prohlédnout slidy a poznámky (nepovinné)", en: "Look through slides and notes (optional)" })}</button>
      </div>
      ${talk.hasPdf ? `<label class="toggle share-toggle"><input type="checkbox" id="share" ${talk.shareSlides ? "checked" : ""}>
        <span>${t({ cs: "Po akci zveřejnit moje slidy na stránce akce pro účastníky", en: "After the event, publish my slides on the event page for attendees" })}
          <small class="muted">${t({ cs: "Nepovinné. Jen PDF, bez poznámek. Kdykoli můžete vypnout.", en: "Optional. PDF only, without notes. You can turn it off any time." })}</small></span></label>` : ""}
      ${talk.sourceUrl ? `<p class="sub" style="margin-top:16px">${t({ cs: "Načteno z Google Slides.", en: "Imported from Google Slides." })}
        <button class="btn small" id="reimport" type="button">${t({ cs: "Načíst znovu", en: "Import again" })}</button>
        <span class="muted">${t({ cs: "(po úpravách v Google Slides)", en: "(after editing in Google Slides)" })}</span></p>` : ""}
      ${talk.uploadedBy === "organizer" ? `<p class="sub">${t({ cs: "Prezentaci nahrál organizátor.", en: "The organizer uploaded this presentation." })}</p>` : ""}
      <div style="margin-top:28px">${dropHTML(exts, t({ cs: "Nahrát novou verzi", en: "Upload a new version" }))}</div>`;
  }

  app.innerHTML = `
    <div class="head"><div>
      <div class="label">${esc(event.name)}</div>
      <h1>${first ? t({ cs: `Dobrý den, ${esc(first)}`, en: `Hello ${esc(first)}` }) : t({ cs: "Nahrání prezentace", en: "Upload your presentation" })}</h1>
      <p class="sub">${t({
        cs: "Nahrajte prezentaci ke svému vystoupení. Do začátku ji můžete kdykoli vyměnit. Na místo pak nemusíte nosit flashku.",
        en: "Upload the presentation for your talk. You can replace it any time before you start. No need to bring a USB stick.",
      })}</p>
    </div></div>
    <div class="speaker">
      <div>${body}</div>
      <aside class="meta">
        <section class="spk-qa" id="spk-qa"></section>
        <section class="spk-poll" id="spk-poll"></section>
        <div class="label">${t({ cs: "Vaše vystoupení", en: "Your talk" })}</div>
        <h2>${esc(talk.title)}</h2>
        <dl>
          ${event.date ? `<dt>${t({ cs: "Kdy", en: "When" })}</dt><dd>${esc(dateText(event.date))}${talk.startsAt ? `, <span class="mono">${esc(talk.startsAt)}</span>` : ""}</dd>` : ""}
          <dt>${t({ cs: "Délka", en: "Length" })}</dt><dd>${talk.durationMin} min</dd>
          ${event.deadline ? `<dt>${t({ cs: "Nahrát do", en: "Upload by" })}</dt><dd>${esc(dateText(event.deadline))}</dd>` : ""}
          ${room ? `<dt>${t({ cs: "Sál", en: "Room" })}</dt><dd>${esc(room)}</dd>` : ""}
          ${event.place ? `<dt>${t({ cs: "Místo", en: "Venue" })}</dt><dd>${esc(event.place)}</dd>` : ""}
        </dl>
      </aside>
    </div>`;

  const firstCanvas = $("#first-slide canvas");
  if (firstCanvas) drawFirst(firstCanvas, `${base}/pdf?v=${talk.version}`);
  $("#preview")?.addEventListener("click", () => openPreview({
    title: talk.title, subtitle: talk.fileName,
    pdfUrl: talk.hasPdf ? `${base}/pdf?v=${talk.version}` : null,
    thumbUrl: talk.hasThumb ? `${base}/thumb?v=${talk.version}` : null,
    notes: talk.notes, videos: talk.videos, issues: talk.issues.map(i => ({ ...i, text: issueText(i) })), fileName: talk.fileName,
    saveNotes: async notes => { data.talk = await api("PUT", `${base}/notes`, { notes }); render(); },
  }));
  $("#share")?.addEventListener("change", async e => {
    try {
      data.talk = { ...data.talk, ...(await api("PATCH", base, { shareSlides: e.target.checked })) };
      toast(e.target.checked ? t({ cs: "Slidy se po akci zveřejní, pokud organizátor zapne stránku akce.", en: "Your slides will be published after the event if the organizer turns on the event page." }) : t({ cs: "Slidy zůstanou neveřejné.", en: "Your slides stay private." }));
    } catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
  });
  const gs = $("#gslides");
  if (gs) gs.onsubmit = e => { e.preventDefault(); importLink($("#gs-url").value); };
  $("#reimport")?.addEventListener("click", () => importLink(talk.sourceUrl));
  app.querySelectorAll("[data-video-pick]").forEach(b => (b.onclick = () => videoBusy === null && app.querySelector(`[data-video="${b.dataset.videoPick}"]`).click()));
  app.querySelectorAll("[data-video]").forEach(inp => (inp.onchange = () => inp.files[0] && uploadVideo(+inp.dataset.video, inp.files[0])));
  const input = $("#file"), drop = $(".drop");
  if (input) {
    input.onchange = () => input.files[0] && upload(input.files[0]);
    $("#pick").onclick = () => input.click();
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]); };
  }
}

function dropHTML(exts, title) {
  return `<div class="drop">
    <div class="big">${title}</div>
    <div class="small">${t({
      cs: "PowerPoint (.pptx), Keynote (.key), PDF nebo OpenOffice (.odp) · max 2 GB · v PowerPointu i Keynote můžete exportovat do PDF",
      en: "PowerPoint (.pptx), Keynote (.key), PDF or OpenOffice (.odp) · up to 2 GB · PowerPoint and Keynote can also export to PDF",
    })}</div>
    <input type="file" id="file" accept="${exts}" hidden>
    <button class="btn primary" id="pick" type="button">${t({ cs: "Vybrat soubor", en: "Choose file" })}</button>
  </div>
  <form class="gslides" id="gslides">
    <label class="field grow"><span>${t({ cs: "Nebo vložte odkaz na Google Slides", en: "Or paste a Google Slides link" })}</span>
      <input id="gs-url" name="url" type="url" placeholder="https://docs.google.com/presentation/d/…" required></label>
    <button class="btn">${t({ cs: "Načíst", en: "Import" })}</button>
  </form>
  <p class="muted gs-hint">${t({ cs: "Prezentace musí být sdílená „Kdokoli s odkazem“. Načtou se slidy i poznámky.", en: "The presentation must be shared with “Anyone with the link”. Slides and notes are imported." })}</p>`;
}

// first slide of the uploaded PDF, so the speaker sees at a glance it's the right file
async function drawFirst(canvas, url) {
  try {
    const pdfjs = await import("/vendor/pdfjs/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
    const doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (360 / vp1.width) * (devicePixelRatio || 1) });
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvas, viewport: vp }).promise;
  } catch {}
}

async function importLink(url) {
  uploading = { name: "Google Slides", pct: 100 };
  render();
  try {
    await api("POST", `${base}/link`, { url });
    uploading = null;
    await load();
    toast(t({ cs: "Načteno. Sál si prezentaci stáhne automaticky.", en: "Imported. The room will download it automatically." }));
  } catch (e) { uploading = null; render(); toast(errorText(e)); }
}

// a video the presentation only links to (YouTube, a file on the speaker's computer) or can't play
const VIDEO_FIX = ["video_online", "video_missing", "video_format"];
let videoBusy = null;
function uploadVideo(i, file) {
  videoBusy = i;
  render();
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `${base}/videos/${i}?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = e => {
    const b = app.querySelector(`[data-video-pick="${i}"]`);
    if (b && e.lengthComputable) b.textContent = `${t({ cs: "Nahrávám", en: "Uploading" })} ${Math.round((e.loaded / e.total) * 100)} %`;
  };
  xhr.onload = () => {
    videoBusy = null;
    let res = {};
    try { res = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 400) { render(); return toast(res.error ? errorText({ code: res.code, message: res.error }) : t({ cs: "Nahrání se nepovedlo. Zkuste to znovu.", en: "Upload failed. Please try again." })); }
    data.talk = { ...data.talk, ...res };
    render();
    toast(t({ cs: "Video nahráno. V sále se přehraje i bez internetu.", en: "Video uploaded. It plays in the room even without internet." }));
  };
  xhr.onerror = () => { videoBusy = null; render(); toast(t({ cs: "Spojení se přerušilo. Zkuste to znovu.", en: "The connection dropped. Please try again." })); };
  xhr.send(file);
}

function upload(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (!data.accepted.includes(ext)) return toast(errorText({ code: "format", message: "Tenhle formát neumíme. Nahrajte PowerPoint, Keynote nebo PDF." }));
  if (ext === "key" && file.type === "" && file.size === 0) return toast(t({ cs: "Tento Keynote je složka. V Keynote zvolte Soubor › Uložit jako jeden soubor.", en: "This Keynote file is a folder. In Keynote choose File › Save as a single file." }));
  uploading = { name: file.name, pct: 0 };
  render();
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `${base}/file?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = e => {
    if (!e.lengthComputable) return;
    uploading.pct = Math.round((e.loaded / e.total) * 100);
    const bar = $(".bar i"), txt = $(".drop .small");
    if (bar) bar.style.width = uploading.pct + "%";
    if (txt) txt.textContent = uploading.pct < 100 ? `${uploading.pct} %` : checking();
  };
  xhr.onload = () => {
    uploading = null;
    let res = {};
    try { res = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 400) {
      toast(res.error ? errorText({ code: res.code, message: res.error }) : t({ cs: "Nahrání se nepovedlo. Zkuste to znovu.", en: "Upload failed. Please try again." }));
      render(); return;
    }
    load().then(() => { $(".done-card")?.scrollIntoView({ behavior: "smooth", block: "center" }); toast(t({ cs: "Nahráno", en: "Uploaded" })); });
  };
  xhr.onerror = () => { uploading = null; render(); toast(t({ cs: "Spojení se přerušilo. Zkuste to znovu.", en: "The connection dropped. Please try again." })); };
  xhr.send(file);
}

// ---------- questions from the audience (live) ----------
let qa = null;
async function loadQuestions() {
  try { qa = await api("GET", `${base}/questions`); } catch { return; }
  drawQuestions();
}
function drawQuestions() {
  const box = $("#spk-qa");
  if (!box || !qa) return;
  const open = qa.questions.filter(q => !q.answered);
  box.innerHTML = `
    <div class="label">${t({ cs: "Dotazy z publika", en: "Audience questions" })}</div>
    <p class="muted" style="font-size:13px;margin:4px 0 10px">${qa.qaEnabled
      ? t({ cs: "Diváci se ptají přes QR kód na projekci. Zodpovězené odškrtněte.", en: "The audience asks via the QR code on the projection. Tick off what you've answered." })
      : t({ cs: "Dotazy jsou u téhle přednášky vypnuté.", en: "Questions are off for this talk." })}</p>
    ${qa.questions.length ? `<ul class="spk-qlist">${qa.questions.map(q => `
      <li class="${q.answered ? "answered" : ""}">
        <button class="tick ${q.answered ? "on" : ""}" data-tick="${q.id}" data-v="${q.answered ? 0 : 1}" aria-pressed="${q.answered}" aria-label="${t({ cs: "Zodpovězeno", en: "Answered" })}">✓</button>
        <div><p>${esc(q.text)}</p><span class="muted">${esc(q.author || t({ cs: "Anonym", en: "Anonymous" }))} · ${q.votes} ${t({ cs: "hlasů", en: "votes" })}</span></div>
      </li>`).join("")}</ul>` : `<p class="muted" style="font-size:13px">${t({ cs: "Zatím žádné.", en: "None yet." })}</p>`}
    ${open.length ? "" : ""}
    <a class="btn small ghost" href="${esc(qa.qaUrl)}" target="_blank" rel="noopener">${t({ cs: "Otevřít stránku pro diváky", en: "Open the audience page" })}</a>`;
  box.querySelectorAll("[data-tick]").forEach(b => (b.onclick = async () => {
    try { qa.questions = (await api("PATCH", `${base}/questions/${b.dataset.tick}`, { answered: b.dataset.v === "1" })).questions; drawQuestions(); }
    catch (e) { toast(e.message); }
  }));
}
// live poll: one element kept across re-renders (it polls on its own)
const pollBox = document.createElement("div");
let polls = null;
const _render = render;
render = function () {
  _render(); drawQuestions();
  const slot = $("#spk-poll");
  if (slot && data) { slot.append(pollBox); polls ||= mountPolls(pollBox, { listUrl: `${base}/polls`, itemUrl: id => `${base}/polls/${id}` }); polls.show(); }
};

langSwitch(render);
load().then(loadQuestions);
setInterval(() => { if (!document.hidden) loadQuestions(); }, 5000);
