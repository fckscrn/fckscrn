import { esc, fmtSize } from "./common.js";

// the speaker page may be in English (see i18n.js); everything else is Czech
const L = (cs, en) => (document.documentElement.lang === "en" ? en : cs);

let pdfjs = null;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import("/vendor/pdfjs/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
  }
  return pdfjs;
}

/**
 * Full-screen preview: every slide next to its speaker notes.
 * opts: { title, subtitle, pdfUrl, notes[], issues[], videos[], originalUrl, fileName, fileSize,
 *         saveNotes?: async notes[] => notes[] — makes the notes editable next to each slide }
 */
export async function openPreview(opts) {
  const dlg = document.createElement("dialog");
  dlg.className = "preview";
  const warns = (opts.issues || []).filter(i => i.level !== "ok");
  dlg.innerHTML = `
    <header class="pv-head">
      <div><div class="label">${L("Náhled prezentace", "Presentation preview")}</div><h2>${esc(opts.title)}</h2>
        <div class="muted">${esc(opts.subtitle || "")}</div></div>
      <div class="pv-actions">
        ${opts.originalUrl ? `<a class="btn small" href="${opts.originalUrl}">${L("Stáhnout originál", "Download original")}${opts.fileSize ? ` (${fmtSize(opts.fileSize)})` : ""}</a>` : ""}
        ${opts.approve ? `<button class="btn small primary" data-approve>${L("V pořádku", "Looks good")}</button>` : ""}
        <span class="pv-saved muted small" aria-live="polite"></span>
        <button class="btn small ${opts.approve ? "" : "primary"}" data-close>${L("Zavřít", "Close")}</button>
      </div>
    </header>
    ${warns.length ? `<ul class="pv-issues">${warns.map(i => `<li>${esc(i.text)}</li>`).join("")}</ul>` : ""}
    <div class="pv-body"><p class="muted">${L("Načítám slidy…", "Loading slides…")}</p></div>`;
  document.body.append(dlg);
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  dlg.querySelector("[data-approve]")?.addEventListener("click", async () => { dlg.close(); await opts.approve(); });
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();

  const body = dlg.querySelector(".pv-body");
  const notes = opts.notes || [];
  let doc = null;
  if (opts.pdfUrl) {
    try { doc = await (await lib()).getDocument({ url: opts.pdfUrl, isEvalSupported: false }).promise; }
    catch { doc = null; }
  }
  // no PDF: show the first-slide image PowerPoint/Keynote keep inside the file instead of an empty list
  if (!doc) {
    body.innerHTML = `
      ${opts.thumbUrl ? `<div class="pv-thumb"><img src="${opts.thumbUrl}" alt=""><span class="muted">${L("První slide (náhled uložený v souboru)", "First slide (preview stored in the file)")}</span></div>` : ""}
      <p class="pv-note">${L("Všechny slidy tu uvidíte, až server prezentaci převede do PDF. Na tomhle serveru chybí převodník (LibreOffice); na fckscrn.com je vždy.", "You'll see all slides once the server converts the presentation to PDF. This server has no converter (LibreOffice); fckscrn.com always has one.")}</p>
      ${notes.some(Boolean) ? `<ol class="pv-list">${notes.map((n, i) => n ? `<li class="pv-row"><div class="pv-num">${i + 1}</div><div class="pv-notes">${esc(n)}</div></li>` : "").join("")}</ol>` : ""}`;
    return;
  }
  const count = doc.numPages;
  if (!count) {
    body.innerHTML = `<p class="muted">${L("Prezentace zatím nemá PDF verzi ani poznámky. Stáhněte si originál a zkontrolujte ho v PowerPointu nebo Keynote.", "No PDF version or notes yet. Download the original and check it in PowerPoint or Keynote.")}</p>`;
    return;
  }

  const edit = !!opts.saveNotes;
  const isPdf = opts.fileName?.toLowerCase().endsWith(".pdf");
  const isKey = opts.fileName?.toLowerCase().endsWith(".key");
  const hint = !notes.some(Boolean)
    ? edit
      ? L(`Prezentace nemá poznámky řečníka${isPdf ? " (PDF je neobsahuje)" : isKey ? " (z Keynote je zatím nečteme)" : ""}. Můžete je dopsat ke každému slidu, uvidíte je na monitoru u pódia.`,
          `The presentation has no speaker notes${isPdf ? " (PDF files don't contain them)" : isKey ? " (we can't read Keynote notes yet)" : ""}. You can type them next to each slide and see them on the monitor at the stage.`)
      : L("Prezentace nemá poznámky řečníka", "The presentation has no speaker notes") + (isPdf ? L(" (PDF poznámky neobsahuje)", " (PDF files don't contain notes)") : "") + "."
    : edit ? L("Poznámky můžete upravit, ukládají se samy.", "You can edit the notes; they save automatically.") : "";
  const grid = !notes.some(Boolean) && !edit;
  body.innerHTML = `
    ${hint ? `<p class="pv-note">${hint}</p>` : ""}
    <ol class="pv-list ${grid ? "pv-grid" : ""}">${Array.from({ length: count }, (_, i) => `
      <li class="pv-row">
        <div class="pv-num">${i + 1}</div>
        <div class="pv-slide"><canvas data-page="${i + 1}"></canvas>${videoTags(opts.videos, i + 1)}</div>
        ${edit
          ? `<textarea class="pv-notes pv-edit" data-note="${i}" rows="4" maxlength="5000" aria-label="${L(`Poznámka ke slidu ${i + 1}`, `Note for slide ${i + 1}`)}"
              placeholder="${L("Poznámka k tomuto slidu…", "Note for this slide…")}">${esc(notes[i] || "")}</textarea>`
          : !grid ? `<div class="pv-notes">${notes[i] ? esc(notes[i]) : `<span class="muted">${L("Bez poznámek", "No notes")}</span>`}</div>` : ""}
      </li>`).join("")}</ol>`;

  if (edit) {
    const status = dlg.querySelector(".pv-saved");
    const current = Array.from({ length: count }, (_, i) => notes[i] || "");
    let timer = null, saving = Promise.resolve();
    const save = () => {
      clearTimeout(timer); timer = null;
      status.textContent = L("Ukládám…", "Saving…");
      saving = saving.then(() => opts.saveNotes([...current]))
        .then(() => (status.textContent = L("Uloženo", "Saved")))
        .catch(e => (status.textContent = e.message || L("Nepodařilo se uložit", "Couldn't save")));
    };
    body.querySelectorAll("[data-note]").forEach(ta => {
      ta.oninput = () => { current[+ta.dataset.note] = ta.value; status.textContent = ""; clearTimeout(timer); timer = setTimeout(save, 800); };
      ta.onblur = () => timer && save();
    });
    // closing with unsaved typing still saves it
    dlg.addEventListener("close", () => timer && save());
  }

  if (!doc) return;
  // draw slides as they scroll into view
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      draw(doc, en.target);
    }
  }, { root: dlg, rootMargin: "400px" });
  body.querySelectorAll("canvas[data-page]").forEach(c => io.observe(c));
  dlg.addEventListener("close", () => { io.disconnect(); doc.destroy(); });
}

// "▶ video" tag on slides with a video, so nobody is surprised at the venue
function videoTags(videos, page) {
  const list = (videos || []).filter(v => v.page === page);
  if (!list.length) return "";
  const text = v => v.kind === "file" ? (v.start === "auto" ? L("▶ Video · spustí se samo", "▶ Video · starts by itself") : L("▶ Video · spustí se kliknutím", "▶ Video · starts on click"))
    : v.kind === "online" ? L(`▶ ${v.site || "Video"} · jen s internetem`, `▶ ${v.site || "Video"} · needs internet`)
    : L("▶ Video chybí · nahrajte MP4", "▶ Video missing · upload an MP4");
  return `<div class="pv-tags">${list.map(v => `<span class="pv-tag ${v.kind === "file" || v.kind === "online" ? "" : "missing"}">${esc(text(v))}</span>`).join("")}</div>`;
}

async function draw(doc, canvas) {
  const page = await doc.getPage(+canvas.dataset.page);
  const box = canvas.parentElement.clientWidth || 400;
  const base = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: (box / base.width) * dpr });
  canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
  canvas.style.width = "100%";
  await page.render({ canvas, viewport: vp }).promise;
}
