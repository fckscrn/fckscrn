import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { readZip } from "./zip.js";

export const ACCEPTED = ["pdf", "pptx", "ppt", "key", "odp"];

/** First-slide image stored inside .pptx (docProps/thumbnail.jpeg) or .key (preview.jpg). Returns a Buffer or null. */
export function packageThumbnail(src) {
  let zip;
  try {
    zip = readZip(src);
    for (const name of ["docProps/thumbnail.jpeg", "docProps/thumbnail.jpg", "preview.jpg", "QuickLook/Thumbnail.jpg", "Thumbnails/thumbnail.png"]) {
      if (zip.has(name)) return zip.get(name)();
    }
  } catch {} finally { zip?.close(); }
  return null;
}
const VIDEO = /\.(mp4|mov|m4v|avi|wmv|mpe?g|webm)$/i;
// what the player (Chromium) plays; other formats have to be uploaded again as MP4
export const VIDEO_TYPES = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

/**
 * Inspect an uploaded presentation and produce a PDF for the player.
 * Returns { pdf: path|null, pageCount, notes: string[], issues: [{level, text}] }.
 */
// pdfFile: a ready PDF (e.g. exported by Google Slides) — then no conversion is needed
export async function analyze(file, ext, outDir, { soffice, pdfFile = null } = {}) {
  const issues = [];
  let notes = [];
  let pdf = null;
  let pageCount = null;
  let ratio = null;
  let info = null;

  if (ext === "pptx") {
    try {
      info = pptxInfo(file);
      notes = info.notes;
      pageCount = info.notes.length;
      ratio = info.ratio;
      if (notes.some(Boolean)) issues.push({ level: "ok", code: "notes", text: "Poznámky řečníka nalezeny, uvidíte je na monitoru u pódia." });
    } catch {
      issues.push({ level: "warn", code: "pptx_unreadable", text: "Soubor PowerPointu se nepodařilo přečíst. Zkuste ho uložit znovu nebo nahrajte PDF." });
    }
  }
  if (ext === "key") issues.push({ level: "warn", code: "keynote_notes", text: "Poznámky z Keynote zatím nečteme. Dopište je v náhledu ke každému slidu." });
  if (ext === "ppt") issues.push({ level: "warn", code: "ppt_old", text: "Starý formát .ppt. Doporučujeme uložit jako .pptx." });

  if (ext === "pdf") {
    pdf = file;
  } else if (pdfFile) {
    pdf = pdfFile;
  } else if (soffice) {
    try {
      pdf = await convertToPdf(soffice, file, outDir);
    } catch (e) {
      issues.push({ level: "error", code: "pdf_failed", text: "Převod do PDF selhal. V sále půjde spustit jen originál." });
    }
  } else {
    issues.push({ level: "info", code: "no_converter", text: "Server nemá převodník do PDF. V sále se otevře originál v PowerPointu nebo Keynote." });
  }

  if (pdf) {
    const p = await pdfFileInfo(pdf);
    pageCount = p.pageCount ?? pageCount;
    ratio = ratio ?? p.ratio;
  }

  // videos play in the player on top of the PDF slide; without a PDF the original runs in PowerPoint
  let videos = [];
  if (pdf && info?.slideVideos.length) {
    videos = info.slideVideos;
    await extractVideos(file, videos, outDir);
    issues.push(...videoIssues(videos));
  } else if (info?.videos.length) {
    issues.push({ level: "warn", code: "video", n: info.videos.length, text: `Obsahuje video (${info.videos.length}×). V PDF režimu se nepřehraje, v sále spusťte originál v PowerPointu.` });
  }

  if (ratio) {
    if (Math.abs(ratio - 16 / 9) < 0.02) issues.push({ level: "ok", code: "ratio_ok", text: "Formát 16:9 odpovídá projekci." });
    else issues.push({ level: "warn", code: "ratio", ratio: ratioLabel(ratio), text: `Formát ${ratioLabel(ratio)}. Na projekci 16:9 budou po stranách černé pruhy.` });
  }

  return { pdf, pageCount, notes, issues, videos };
}

/** One line per video that needs the speaker (online or missing file), one summary for the rest. */
export function videoIssues(videos) {
  const out = [];
  const ok = videos.filter(v => v.kind === "file").length;
  if (ok) out.push({ level: "ok", code: "video_ok", n: ok, text: `Video (${ok}×) se přehraje přímo v prezentaci, bez PowerPointu.` });
  for (const v of videos) {
    const at = { i: v.i, page: v.page, name: v.name };
    if (v.kind === "online") out.push({ level: "warn", code: "video_online", ...at, site: v.site, text: `Slide ${v.page}: video z ${v.site}. Přehraje se jen s internetem v sále a může před ním běžet reklama. Máte-li video jako soubor, nahrajte ho.` });
    if (v.kind === "missing") out.push({ level: "warn", code: "video_missing", ...at, text: `Slide ${v.page}: video „${v.name}“ v souboru není, prezentace na něj jen odkazuje. Nahrajte ho prosím.` });
    if (v.kind === "unsupported") out.push({ level: "warn", code: "video_format", ...at, text: `Slide ${v.page}: video „${v.name}“ je ve formátu, který přehrávač neumí. Nahrajte ho prosím jako MP4.` });
  }
  return out;
}

// embedded videos → video-<i>.<ext> next to the PDF, streamed (they can be big)
async function extractVideos(src, videos, outDir) {
  const todo = videos.filter(v => v.kind === "file" && v.entry);
  if (!todo.length) return;
  const zip = readZip(src);
  try {
    for (const v of todo) {
      try { await pipeline(zip.get(v.entry).stream(), fs.createWriteStream(path.join(outDir, `video-${v.i}.${v.ext}`))); }
      catch { Object.assign(v, { kind: "missing", ext: undefined }); }
      delete v.entry;
    }
  } finally { zip.close(); }
}

function ratioLabel(r) {
  const known = { "4:3": 4 / 3, "16:10": 16 / 10, "16:9": 16 / 9, "A4": Math.SQRT2 };
  for (const [k, v] of Object.entries(known)) if (Math.abs(r - v) < 0.02) return k;
  return r.toFixed(2) + ":1";
}

export function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

// LibreOffice takes ~1 CPU and a few hundred MB per file: when many speakers upload at once,
// conversions wait in line instead of bringing the server down (SOFFICE_JOBS overrides).
const JOBS = Math.max(1, +process.env.SOFFICE_JOBS || Math.min(2, os.cpus().length - 1));
let running = 0;
const waiting = [];
async function inLine(fn) {
  if (running >= JOBS) await new Promise(r => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

function convertToPdf(soffice, file, outDir) {
  return inLine(() => convertNow(soffice, file, outDir));
}
function convertNow(soffice, file, outDir) {
  return new Promise((resolve, reject) => {
    // separate profile dir so parallel conversions don't fight over one lock
    const profile = "file://" + path.join(outDir, ".lo-profile");
    execFile(soffice, [`-env:UserInstallation=${profile}`, "--headless", "--convert-to", "pdf", "--outdir", outDir, file],
      { timeout: 180_000 }, err => {
        const out = path.join(outDir, path.basename(file, path.extname(file)) + ".pdf");
        if (err || !fs.existsSync(out)) return reject(err || new Error("no output"));
        resolve(out);
      });
  });
}

// ---------- PPTX ----------

export function pptxInfo(src) {
  const zip = readZip(src);
  try { return pptxRead(zip); } finally { zip.close(); }
}
function pptxRead(zip) {
  const text = name => { const e = zip.get(name); return e ? e().toString("utf8") : null; };
  const pres = text("ppt/presentation.xml");
  if (!pres) throw new Error("missing presentation.xml");

  const size = pres.match(/<p:sldSz\b[^>]*>/)?.[0];
  const cx = +attr(size, "cx"), cy = +attr(size, "cy");
  const rels = parseRels(text("ppt/_rels/presentation.xml.rels"), "ppt");

  const notes = [], slideVideos = [];
  for (const tag of pres.match(/<p:sldId\b[^>]*>/g) || []) {
    const slidePath = rels[attr(tag, "r:id")];
    const slide = slidePath && text(slidePath);
    if (!slide) continue;
    // hidden slides are left out of the PDF export, so skip their notes too
    if (/<p:sld\b[^>]*\bshow="0"/.test(slide)) continue;
    const relsXml = text(relsPath(slidePath));
    const slideRels = parseRels(relsXml, path.posix.dirname(slidePath));
    const notesPath = Object.values(slideRels).find(t => /notesSlide\d*\.xml$/.test(t));
    notes.push(notesPath ? notesText(text(notesPath) || "") : "");
    for (const v of slideVideosOf(slide, parseRels(relsXml, path.posix.dirname(slidePath), true), cx, cy)) {
      slideVideos.push({ i: slideVideos.length, page: notes.length, ...v, ...(v.entry && !zip.has(v.entry) ? { kind: "missing", entry: undefined, ext: undefined } : {}) });
    }
  }

  const videos = [...zip.keys()].filter(n => n.startsWith("ppt/media/") && VIDEO.test(n));
  return { ratio: cx && cy ? cx / cy : null, notes, videos, slideVideos };
}

// <p:pic> with <a:videoFile r:link>: embedded (ppt/media/…), linked to a file on the author's
// computer, or an online video (YouTube, Vimeo). Position as a fraction of the slide.
function slideVideosOf(slide, rels, cx, cy) {
  const out = [];
  for (const pic of slide.match(/<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/g) || []) {
    const link = pic.match(/<a:videoFile\b[^>]*>/)?.[0];
    if (!link) continue;
    const rel = rels[attr(link, "r:link")] || rels[attr(pic.match(/<p14:media\b[^>]*>/)?.[0], "r:embed")];
    if (!rel) continue;
    const off = pic.match(/<a:off\b[^>]*>/)?.[0], ext = pic.match(/<a:ext\b[^>]*\bcx=[^>]*>/)?.[0];
    const box = off && ext && cx && cy
      ? { x: +attr(off, "x") / cx, y: +attr(off, "y") / cy, w: +attr(ext, "cx") / cx, h: +attr(ext, "cy") / cy }
      : { x: 0, y: 0, w: 1, h: 1 };
    const round = n => Math.round(Math.min(Math.max(n, 0), 1) * 10000) / 10000;
    const pos = Object.fromEntries(Object.entries(box).map(([k, n]) => [k, round(n || 0)]));
    out.push({ ...pos, start: startOf(slide, attr(pic.match(/<p:cNvPr\b[^>]*>/)?.[0], "id")), ...videoSource(rel) });
  }
  return out;
}

function videoSource({ target, external }) {
  if (!external) {
    const ext = path.posix.extname(target).slice(1).toLowerCase();
    const name = path.posix.basename(target);
    return VIDEO_TYPES[ext] ? { kind: "file", name, ext, entry: target } : { kind: "unsupported", name };
  }
  const yt = target.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
  if (yt) return { kind: "online", site: "YouTube", name: `youtu.be/${yt[1]}`, url: `https://www.youtube-nocookie.com/embed/${yt[1]}` };
  const vimeo = target.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo) return { kind: "online", site: "Vimeo", name: `vimeo.com/${vimeo[1]}`, url: `https://player.vimeo.com/video/${vimeo[1]}` };
  // a file on the author's computer (file:///C:/…) or some other web page
  let name = target;
  try { name = decodeURIComponent(target); } catch {}
  return { kind: "missing", name: name.split(/[\\/]/).filter(Boolean).pop() || name };
}

// PowerPoint's "Start: Automatically" = a media call that runs with or after the slide's start;
// everything else ("On click", "In click sequence", trigger) waits for the next click
function startOf(slide, spid) {
  const timing = slide.match(/<p:timing>[\s\S]*<\/p:timing>/)?.[0];
  if (!timing || !spid) return "click";
  // one part per effect: from its <p:cTn presetClass=…> up to the next effect
  for (const part of timing.split(/(?=<p:cTn\b[^>]*\bpresetClass=)/)) {
    const ctn = part.match(/^<p:cTn\b[^>]*>/)?.[0];
    if (!ctn || attr(ctn, "presetClass") !== "mediacall" || !new RegExp(`<p:spTgt spid="${spid}"`).test(part)) continue;
    if (attr(ctn, "nodeType") !== "clickEffect" && /evt="onBegin"/.test(timing)) return "auto";
  }
  return "click";
}

function attr(tag, name) {
  return tag?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function relsPath(p) {
  return path.posix.join(path.posix.dirname(p), "_rels", path.posix.basename(p) + ".rels");
}

// withExternal: { id: { target, external } } including links outside the package
function parseRels(xml, baseDir, withExternal = false) {
  const out = {};
  for (const tag of xml?.match(/<Relationship\b[^>]*>/g) || []) {
    const target = attr(tag, "Target") && decode(attr(tag, "Target"));
    const external = attr(tag, "TargetMode") === "External";
    if (!target || (external && !withExternal)) continue;
    const full = external ? target : target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(baseDir, target));
    out[attr(tag, "Id")] = withExternal ? { target: full, external } : full;
  }
  return out;
}

function notesText(xml) {
  const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const body = shapes.filter(s => /<p:ph\b[^>]*type="body"/.test(s));
  return body.map(s => (s.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g) || [])
    .map(p => [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => decode(m[1])).join(""))
    .join("\n")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decode(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
}

// ---------- PDF ----------

// Best effort: PDFs with compressed object streams hide these, the player reads them with pdf.js anyway.
// big PDFs are scanned in chunks (a whole 1 GB file as one string would not fit)
export async function pdfFileInfo(file) {
  const fh = await fsp.open(file, "r");
  try {
    const size = (await fh.stat()).size, CH = 16 << 20, OVER = 4096;
    let pageCount = null, ratio = null;
    for (let pos = 0; pos < size; pos += CH) {
      const len = Math.min(CH + OVER, size - pos);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      const i = pdfInfo(buf);
      if (i.pageCount) pageCount = Math.max(pageCount || 0, i.pageCount);
      ratio ??= i.ratio;
    }
    return { pageCount, ratio };
  } finally { await fh.close(); }
}

export function pdfInfo(buf) {
  const s = buf.toString("latin1");
  const counts = [...s.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g)].map(m => +m[1]);
  const box = s.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
  const w = box ? box[3] - box[1] : 0, h = box ? box[4] - box[2] : 0;
  return { pageCount: counts.length ? Math.max(...counts) : null, ratio: w && h ? w / h : null };
}
