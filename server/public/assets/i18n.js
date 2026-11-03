// Czech / English for pages that foreign guests see (speaker page, preview).
// Language: saved choice → browser language (cs/sk → Czech) → English.
const KEY = "fckscrn-lang";

function detect() {
  try { const s = localStorage.getItem(KEY); if (s === "cs" || s === "en") return s; } catch {}
  return /^(cs|sk)\b/i.test(navigator.language || "") ? "cs" : "en";
}

export let lang = detect();
document.documentElement.lang = lang;

/** t({ cs: "…", en: "…" }) */
export const t = d => d[lang] ?? d.cs;

/** Adds a CZ | EN switch to the page header; calls onChange after switching. */
export function langSwitch(onChange) {
  const top = document.querySelector(".top");
  if (!top || top.querySelector(".lang")) return;
  const box = document.createElement("div");
  box.className = "lang seg";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Jazyk / Language");
  for (const l of ["cs", "en"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = l === "cs" ? "CZ" : "EN";
    b.setAttribute("aria-pressed", String(l === lang));
    b.onclick = () => {
      lang = l;
      document.documentElement.lang = l;
      try { localStorage.setItem(KEY, l); } catch {}
      box.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      onChange?.();
    };
    box.append(b);
  }
  top.append(box);
}

// file checks from the server come with a code; text is the Czech fallback
export function issueText(i) {
  if (lang === "cs" || !i.code) return i.text;
  return {
    video: `Contains video (${i.n || 1}×). It won't play in PDF mode; run the original in PowerPoint at the venue.`,
    video_ok: `Video (${i.n || 1}×) plays right in the presentation, no PowerPoint needed.`,
    video_online: `Slide ${i.page}: a ${i.site} video. It only plays if the room has internet, and an ad may run before it. If you have the video as a file, upload it.`,
    video_missing: `Slide ${i.page}: the video “${i.name}” isn't in the file, the presentation only links to it. Please upload it.`,
    video_format: `Slide ${i.page}: the video “${i.name}” is in a format the player can't play. Please upload it as MP4.`,
    notes: "Speaker notes found. You'll see them on the monitor at the stage.",
    pptx_unreadable: "We couldn't read this PowerPoint file. Try saving it again or upload a PDF.",
    keynote_notes: "We can't read Keynote notes yet. Type them in the preview, next to each slide.",
    notes_kept: "We kept the notes you typed for the previous version. Check they still match the slides.",
    ppt_old: "Old .ppt format. We recommend saving it as .pptx.",
    pdf_failed: "Conversion to PDF failed. Only the original can be run at the venue.",
    no_converter: "The server can't convert to PDF. The original will open in PowerPoint or Keynote at the venue.",
    ratio_ok: "16:9 format matches the projector.",
    new_version: `The speaker uploaded a new version (#${i.n}). Have a look and approve it.`,
    ratio: `${i.ratio} format. On a 16:9 projector there will be black bars on the sides.`,
  }[i.code] || i.text;
}

export function errorText(e) {
  if (lang === "cs" || !e.code) return e.message;
  return {
    speaker_link: "This speaker link is no longer valid. Ask the organizer for a new one.",
    format: "We can't read this format. Upload PowerPoint (.pptx), Keynote (.key), PDF or OpenOffice (.odp).",
    too_large: "The file is larger than 2 GB.",
    empty: "The file is empty.",
    video_format: "Upload the video as MP4 (or MOV or WebM).",
    server: "Server error. Please try again.",
    gslides_link: "That's not a Google Slides link. Copy the presentation's address from your browser.",
    gslides_private: "We couldn't download the presentation. In Google Slides set Share › Anyone with the link › Viewer and try again.",
  }[e.code] || e.message;
}

/** Static pages: elements carry their English text in data-en (and data-en-placeholder / data-en-label). */
export function translateStatic(root = document) {
  for (const el of root.querySelectorAll("[data-en]")) {
    if (el.dataset.cs === undefined) el.dataset.cs = el.innerHTML;
    el.innerHTML = lang === "en" ? el.dataset.en : el.dataset.cs;
  }
  for (const [attr, key] of [["placeholder", "enPlaceholder"], ["aria-label", "enLabel"]]) {
    for (const el of root.querySelectorAll(`[data-en-${attr === "placeholder" ? "placeholder" : "label"}]`)) {
      const csKey = key.replace("en", "cs");
      if (el.dataset[csKey] === undefined) el.dataset[csKey] = el.getAttribute(attr) || "";
      el.setAttribute(attr, lang === "en" ? el.dataset[key] : el.dataset[csKey]);
    }
  }
}
