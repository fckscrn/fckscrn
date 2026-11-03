import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import { openDb } from "./db.js";
import { analyze, ACCEPTED, packageThumbnail, videoIssues, VIDEO_TYPES } from "./analyze.js";
import { writeZip } from "./zipwriter.js";
import { aresLookup } from "./billing.js";
import { createMcp, tokenFrom } from "./mcp.js";
import qrcode from "qrcode-generator";

const MAX_UPLOAD = 2 * 1024 ** 3;
const MAX_MEDIA = 1024 ** 3;
const MEDIA_TYPES = {
  jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], png: ["image", "image/png"], webp: ["image", "image/webp"], gif: ["image", "image/gif"],
  svg: ["image", "image/svg+xml"], avif: ["image", "image/avif"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], webm: ["video", "video/webm"], mov: ["video", "video/quicktime"],
};
const PLAYER_ONLINE_MS = 90_000;
// pdf.js for slide previews, served from node_modules so it works offline
const PDFJS_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "build");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".pdf": "application/pdf", ".png": "image/png", ".webmanifest": "application/manifest+json" };

// panel backgrounds: a still or a looping video
// door signs may also use SVG artwork
const SIGN_TYPES = () => ({ ...BG_TYPES, svg: ["image", "image/svg+xml"] });
const BG_TYPES = { jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], png: ["image", "image/png"], webp: ["image", "image/webp"], gif: ["image", "image/gif"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], webm: ["video", "video/webm"], mov: ["video", "video/quicktime"] };

/** QR code as SVG (white quiet zone, black modules). Remembered: every room asks for its codes every few seconds. */
const qrCache = new Map();
function qrSvg(text) {
  if (qrCache.has(text)) return qrCache.get(text);
  if (qrCache.size > 5000) qrCache.clear();
  const svg = makeQr(text);
  qrCache.set(text, svg);
  return svg;
}
function makeQr(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

const STATUS_CS = { missing: "Chybí soubor", processing: "Zpracovává se", ready: "Připraveno", warning: "Ke kontrole", error: "Chyba" };

const token = () => crypto.randomBytes(12).toString("base64url");

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// retentionDays: event data is deleted this many days after the event date (0 = keep forever).
// Events without a date are kept 60 days from creation.
// landing: true = "/" shows the product page (fckscrn.com); false = "/" goes straight to creating an event (self-host)
// billing: null (self-host: everything free, no watermark) or { fakturoid, prices: { single, multi }, webhookToken }
export function createApp({ dataDir, publicDir, playerDir, soffice = null, retentionDays = 14, landing = true, billing = null, fetchImpl = fetch, publicUrl = null, indexable = true, gtmId = null }) {
  fs.mkdirSync(path.join(dataDir, "files"), { recursive: true });
  const db = openDb(path.join(dataDir, "fckscrn.db"));
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  // ---------- data helpers ----------

  const eventByAdmin = t => one("SELECT * FROM events WHERE admin_token = ?", t) || notFound("Akce neexistuje. Zkontrolujte odkaz.");
  const talkBySpeaker = t => one("SELECT * FROM talks WHERE speaker_token = ? AND kind = 'talk'", t) || (() => { throw new HttpError(404, "Odkaz pro řečníka neplatí. Požádejte organizátora o nový.", "speaker_link"); })();
  const roomByPlayer = t => one("SELECT * FROM rooms WHERE player_token = ?", t) || notFound("Sál neexistuje. Zkontrolujte párovací odkaz.");

  function talkOut(t, { withSpeakerToken = false } = {}) {
    return {
      id: t.id, kind: t.kind, roomId: t.room_id, startsAt: t.starts_at, durationMin: t.duration_min,
      title: t.title, speaker: t.speaker, status: t.status, version: t.version,
      fileName: t.file_name, fileExt: t.file_ext, fileSize: t.file_size, hasPdf: !!t.has_pdf,
      pageCount: t.page_count, issues: JSON.parse(t.issues || "[]"), uploadedAt: t.uploaded_at,
      sourceUrl: t.source_url, uploadedBy: t.uploaded_by,
      hasThumb: !!t.version && fs.existsSync(filePaths(t).thumb),
      reviewed: !!t.reviewed_at,
      moderator: t.moderator, panelists: JSON.parse(t.panelists || "[]"),
      background: t.bg_ext ? (BG_TYPES[t.bg_ext]?.[0] || null) : null,
      qaToken: t.qa_token, qaEnabled: !!t.qa_enabled, shareSlides: !!t.share_slides,
      videos: videosOf(t),
      ...(withSpeakerToken ? { speakerToken: t.speaker_token } : {}),
    };
  }
  const talksOf = eventId => q("SELECT * FROM talks WHERE event_id = ? ORDER BY starts_at, id", eventId);
  const eventOut = e => ({ id: e.id, name: e.name, date: e.date, place: e.place, mode: e.mode, expiresAt: expiresAt(e), deadline: e.deadline || null });

  // ---------- billing ----------

  const priceOf = e => billing ? (e.mode === "single" ? billing.prices.single : billing.prices.multi) : 0;
  const watermark = e => !!billing && e.billing_status === "trial";
  const billingOut = e => !billing ? { enabled: false } : {
    enabled: true, status: e.billing_status, price: e.price || priceOf(e),
    invoiceNumber: e.invoice_number, invoiceUrl: e.invoice_url, orderedAt: e.ordered_at, paidAt: e.paid_at,
    customer: e.billing ? JSON.parse(e.billing) : null,
  };

  async function checkPayments() {
    if (!billing) return 0;
    let n = 0;
    for (const e of q("SELECT * FROM events WHERE billing_status = 'ordered' AND invoice_id IS NOT NULL")) {
      try {
        const inv = await billing.fakturoid.get(e.invoice_id);
        if (inv.status === "paid") { run("UPDATE events SET billing_status = 'paid', paid_at = ? WHERE id = ?", inv.paid_on || new Date().toISOString().slice(0, 10), e.id); n++; }
      } catch (err) { console.error("payment check failed", e.id, err.message); }
    }
    return n;
  }

  // ---------- lifetime ----------

  function expiresAt(e) {
    if (!retentionDays) return null;
    const base = e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : (e.created_at || "").slice(0, 10);
    const d = new Date(base + "T00:00:00Z");
    if (isNaN(d)) return null;
    d.setUTCDate(d.getUTCDate() + (e.date ? retentionDays : 60));
    return d.toISOString().slice(0, 10);
  }

  async function deleteEvent(e) {
    for (const t of q("SELECT * FROM talks WHERE event_id = ?", e.id)) {
      await fsp.rm(talkDir(t), { recursive: true, force: true });
      if (t.bg_ext) await fsp.rm(bgFile(t), { force: true });
    }
    for (const m of q("SELECT * FROM media WHERE event_id = ?", e.id)) await fsp.rm(mediaFile(m), { force: true });
    if (e.sign_ext) await fsp.rm(signFile(e), { force: true });
    run("DELETE FROM events WHERE id = ?", e.id);
  }

  async function purgeExpired(today = new Date().toISOString().slice(0, 10)) {
    let n = 0;
    for (const e of q("SELECT * FROM events")) {
      const exp = expiresAt(e);
      if (exp && exp <= today) { await deleteEvent(e); n++; }
    }
    return n;
  }

  function adminView(e) {
    const now = Date.now();
    return {
      event: { ...eventOut(e), publicEnabled: !!e.public_enabled, publicPath: `/a/${e.public_token}`,
        signBackground: e.sign_ext ? SIGN_TYPES()[e.sign_ext]?.[0] || null : null },
      billing: billingOut(e),
      rooms: q("SELECT * FROM rooms WHERE event_id = ? ORDER BY id", e.id).map(r => ({
        id: r.id, name: r.name, playerToken: r.player_token,
        playerOnline: !!r.player_seen_at && now - r.player_seen_at < PLAYER_ONLINE_MS,
        playerSeenAt: r.player_seen_at,
        live: liveOf(r.id),
      })),
      talks: talksOf(e.id).map(t => ({
        ...talkOut(t, { withSpeakerToken: true }),
        questions: { total: one("SELECT COUNT(*) AS n FROM questions WHERE talk_id = ? AND hidden = 0", t.id).n,
          open: one("SELECT COUNT(*) AS n FROM questions WHERE talk_id = ? AND hidden = 0 AND answered_at IS NULL", t.id).n },
      })),
      media: mediaOf(e.id).map(m => ({ ...mediaOut(m), url: `/api/admin/${e.admin_token}/media/${m.id}` })),
    };
  }

  const mediaOf = (eventId, roomId) => roomId === undefined
    ? q("SELECT * FROM media WHERE event_id = ? ORDER BY position, id", eventId)
    : q("SELECT * FROM media WHERE event_id = ? AND (room_id IS NULL OR room_id = ?) ORDER BY position, id", eventId, roomId);
  const mediaOut = m => ({ id: m.id, kind: m.kind, roomId: m.room_id, fileName: m.file_name, ext: m.file_ext, size: m.file_size, durationSec: m.duration_sec });
  const mediaFile = m => path.join(dataDir, "files", "media", `${m.id}.${m.file_ext}`);
  const mediaSend = m => ({ file: mediaFile(m), type: MEDIA_TYPES[m.file_ext][1] });

  const talkDir = t => path.join(dataDir, "files", `talk-${t.id}`);
  const bgFile = t => path.join(dataDir, "files", "bg", `talk-${t.id}.${t.bg_ext}`);
  const signFile = e => path.join(dataDir, "files", "sign", `event-${e.id}.${e.sign_ext}`);
  const signStamp = e => { try { return Math.round(fs.statSync(signFile(e)).mtimeMs); } catch { return 0; } };
  const bgStamp = t => { try { return Math.round(fs.statSync(bgFile(t)).mtimeMs); } catch { return 0; } };
  // where the audience opens Q&A (absolute, the QR code needs the full address)
  const originOf = req => `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const versionDir = (t, v = t.version) => path.join(talkDir(t), `v${v}`);
  function filePaths(t) {
    const dir = versionDir(t);
    return { original: path.join(dir, `original.${t.file_ext}`), pdf: path.join(dir, "presentation.pdf"), thumb: path.join(dir, "thumbnail.jpg") };
  }
  const videosOf = t => (t.version && t.has_pdf ? JSON.parse(t.videos || "[]") : []);
  const videoFile = (t, v) => path.join(versionDir(t), `video-${v.i}.${v.ext}`);

  // ---------- routes ----------

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });

  route("POST", "/api/events", async req => {
    const b = await body(req);
    const name = str(b.name, "Název akce", true);
    const mode = b.mode === "single" ? "single" : "multi";
    const rooms = mode === "single" ? [str(Array.isArray(b.rooms) ? b.rooms[0] : null) || "Sál"]
      : [...new Set((Array.isArray(b.rooms) ? b.rooms : []).map(r => str(r)).filter(Boolean))].slice(0, 20);
    const e = run("INSERT INTO events (name, date, place, admin_token, mode, public_token) VALUES (?, ?, ?, ?, ?, ?)", name, str(b.date), str(b.place), token(), mode, token());
    const ev = one("SELECT * FROM events WHERE id = ?", e.lastInsertRowid);
    for (const r of rooms.length ? rooms : ["Sál A", "Sál B"]) run("INSERT INTO rooms (event_id, name, player_token, remote_token) VALUES (?, ?, ?, ?)", ev.id, r, token(), token());
    return [201, { adminToken: ev.admin_token }];
  });

  route("GET", "/api/admin/:t", async (req, p) => adminView(eventByAdmin(p.t)));

  route("PATCH", "/api/admin/:t", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    if (b.mode === "single" || b.mode === "multi") run("UPDATE events SET mode = ? WHERE id = ?", b.mode, e.id);
    if (b.deadline !== undefined) {
      if (b.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(b.deadline)) badRequest("Termín zadejte jako datum.");
      run("UPDATE events SET deadline = ? WHERE id = ?", b.deadline || null, e.id);
    }
    if (b.publicEnabled !== undefined) run("UPDATE events SET public_enabled = ? WHERE id = ?", b.publicEnabled ? 1 : 0, e.id);
    run("UPDATE events SET name = ?, date = ?, place = ? WHERE id = ?",
      b.name !== undefined ? str(b.name, "Název akce", true) : e.name,
      b.date !== undefined ? str(b.date) : e.date, b.place !== undefined ? str(b.place) : e.place, e.id);
    return adminView(eventByAdmin(p.t));
  });

  route("GET", "/api/ares/:ico", async (req, p) => {
    if (!/^\d{8}$/.test(p.ico)) badRequest("IČO má 8 číslic.");
    let r;
    try { r = await aresLookup(p.ico, fetchImpl); } catch { throw new HttpError(502, "Rejstřík ARES teď neodpovídá. Vyplňte údaje ručně."); }
    return r || notFound("Firmu s tímto IČO jsme v ARES nenašli.");
  });

  // order = activate now (no watermark), invoice goes out by e-mail, payment comes later
  route("POST", "/api/admin/:t/order", async (req, p) => {
    if (!billing) notFound("Platby nejsou zapnuté.");
    const e = eventByAdmin(p.t), b = await body(req);
    if (e.billing_status !== "trial") throw new HttpError(409, "Akce už je objednaná.");
    const c = {
      name: str(b.name, "Název firmy nebo jméno", true), ico: b.ico ? String(b.ico).replace(/\s/g, "") : null, dic: str(b.dic),
      street: str(b.street, "Ulice", true), city: str(b.city, "Město", true), zip: str(b.zip, "PSČ", true), email: str(b.email, "E-mail", true),
    };
    if (c.ico && !/^\d{8}$/.test(c.ico)) badRequest("IČO má 8 číslic.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) badRequest("E-mail nevypadá správně.");
    const price = priceOf(e);
    let inv;
    try {
      const subjectId = await billing.fakturoid.subject(c);
      const when = e.date ? ` (${e.date.split("-").reverse().join(". ").replace(/^0/, "")})` : "";
      inv = await billing.fakturoid.invoice({
        subjectId, price, customId: `fckscrn-${e.id}`,
        text: `FckScrn – prezentace na akci „${e.name}“${when}, ${e.mode === "single" ? "jeden sál" : "víc sálů"}`,
      });
    } catch (err) {
      console.error("order failed", err.message);
      throw new HttpError(502, "Fakturu se teď nepodařilo vystavit. Zkuste to prosím za chvíli znovu.");
    }
    run(`UPDATE events SET billing_status = 'ordered', billing = ?, invoice_id = ?, invoice_number = ?, invoice_url = ?, price = ?, ordered_at = ? WHERE id = ?`,
      JSON.stringify(c), inv.id, inv.number, inv.public_html_url, price, new Date().toISOString(), e.id);
    try { await billing.fakturoid.send(inv.id, { email: c.email, eventName: e.name }); }
    catch (err) { console.error("invoice e-mail failed", err.message); } // the invoice link is shown in the admin anyway
    return adminView(eventByAdmin(p.t));
  });

  // Fakturoid webhook: invoice_paid / invoice_payment_removed
  route("POST", "/api/billing/fakturoid", async req => {
    if (!billing || !billing.webhookToken || req.headers.authorization !== `Bearer ${billing.webhookToken}`) throw new HttpError(401, "Unauthorized");
    const m = await body(req);
    const inv = m.body?.invoice;
    const e = inv && one("SELECT * FROM events WHERE invoice_id = ?", inv.id);
    if (e && m.event_name === "invoice_paid") run("UPDATE events SET billing_status = 'paid', paid_at = ? WHERE id = ?", inv.paid_on || new Date().toISOString().slice(0, 10), e.id);
    if (e && m.event_name === "invoice_payment_removed") run("UPDATE events SET billing_status = 'ordered', paid_at = NULL WHERE id = ?", e.id);
    return { ok: true };
  });

  // new secret link (= API key); the old one stops working right away
  route("POST", "/api/admin/:t/rotate", async (req, p) => {
    const e = eventByAdmin(p.t);
    const t = token();
    run("UPDATE events SET admin_token = ? WHERE id = ?", t, e.id);
    return { adminToken: t };
  });

  // ---------- panel background ----------

  const panelOf = (e, id) => one("SELECT * FROM talks WHERE id = ? AND event_id = ?", +id, e.id) || notFound("Položka neexistuje.");

  route("PUT", "/api/admin/:t/talks/:id/background", async (req, p, url) => {
    const e = eventByAdmin(p.t), t = panelOf(e, p.id);
    const ext = path.extname(url.searchParams.get("name") || "").slice(1).toLowerCase();
    if (!BG_TYPES[ext]) throw new HttpError(400, "Pozadí panelu může být obrázek (JPG, PNG, WebP, GIF) nebo video (MP4, WebM, MOV).", "bg_format");
    if (+req.headers["content-length"] > MAX_MEDIA) throw new HttpError(413, "Soubor je větší než 1 GB.", "too_large");
    await fsp.mkdir(path.join(dataDir, "files", "bg"), { recursive: true });
    if (t.bg_ext) await fsp.rm(bgFile(t), { force: true });
    const dest = bgFile({ ...t, bg_ext: ext });
    let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_MEDIA) req.destroy(new HttpError(413, "Soubor je větší než 1 GB.", "too_large")); });
    await pipeline(req, fs.createWriteStream(dest));
    if (!size) { await fsp.rm(dest, { force: true }); throw new HttpError(400, "Soubor je prázdný.", "empty"); }
    run("UPDATE talks SET bg_ext = ? WHERE id = ?", ext, t.id);
    return adminView(e);
  });

  route("DELETE", "/api/admin/:t/talks/:id/background", async (req, p) => {
    const e = eventByAdmin(p.t), t = panelOf(e, p.id);
    if (t.bg_ext) { await fsp.rm(bgFile(t), { force: true }); run("UPDATE talks SET bg_ext = NULL WHERE id = ?", t.id); }
    return adminView(e);
  });

  route("GET", "/api/admin/:t/talks/:id/background", async (req, p) => {
    const e = eventByAdmin(p.t), t = panelOf(e, p.id);
    if (!t.bg_ext) notFound("Pozadí není.");
    return { file: bgFile(t), type: BG_TYPES[t.bg_ext][1] };
  });

  // door sign background: the organizer's own image, animation or video behind "Now / Next"
  route("PUT", "/api/admin/:t/sign-background", async (req, p, url) => {
    const e = eventByAdmin(p.t);
    const ext = path.extname(url.searchParams.get("name") || "").slice(1).toLowerCase();
    if (!SIGN_TYPES()[ext]) throw new HttpError(400, "Pozadí cedulky může být obrázek (JPG, PNG, WebP, GIF, SVG) nebo video (MP4, WebM, MOV).", "bg_format");
    if (+req.headers["content-length"] > MAX_MEDIA) throw new HttpError(413, "Soubor je větší než 1 GB.", "too_large");
    await fsp.mkdir(path.join(dataDir, "files", "sign"), { recursive: true });
    if (e.sign_ext) await fsp.rm(signFile(e), { force: true });
    const dest = signFile({ ...e, sign_ext: ext });
    let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_MEDIA) req.destroy(new HttpError(413, "Soubor je větší než 1 GB.", "too_large")); });
    await pipeline(req, fs.createWriteStream(dest));
    if (!size) { await fsp.rm(dest, { force: true }); throw new HttpError(400, "Soubor je prázdný.", "empty"); }
    run("UPDATE events SET sign_ext = ? WHERE id = ?", ext, e.id);
    return adminView(eventByAdmin(p.t));
  });
  route("DELETE", "/api/admin/:t/sign-background", async (req, p) => {
    const e = eventByAdmin(p.t);
    if (e.sign_ext) { await fsp.rm(signFile(e), { force: true }); run("UPDATE events SET sign_ext = NULL WHERE id = ?", e.id); }
    return adminView(eventByAdmin(p.t));
  });
  route("GET", "/api/admin/:t/sign-background", async (req, p) => {
    const e = eventByAdmin(p.t);
    if (!e.sign_ext) notFound("Pozadí není.");
    return { file: signFile(e), type: SIGN_TYPES()[e.sign_ext][1] };
  });

  // ---------- Q&A ----------

  const questionOut = x => ({ id: x.id, author: x.author, text: x.text, votes: x.votes, answered: !!x.answered_at, hidden: !!x.hidden, createdAt: x.created_at });
  // most wanted first, answered ones at the end
  const questionsOf = (talkId, { withHidden = false } = {}) =>
    q(`SELECT * FROM questions WHERE talk_id = ? ${withHidden ? "" : "AND hidden = 0"} ORDER BY answered_at IS NOT NULL, votes DESC, id`, talkId).map(questionOut);
  const qaTalk = tok => one("SELECT * FROM talks WHERE qa_token = ? AND kind != 'break'", tok) || notFound("Dotazy k téhle přednášce nejsou.");

  // a few questions a minute per person is plenty; stops floods without accounts
  const recent = new Map();
  function rateLimit(key, max = 6, windowMs = 60_000) {
    const now = Date.now();
    const list = (recent.get(key) || []).filter(x => now - x < windowMs);
    if (list.length >= max) throw new HttpError(429, "Pomaleji, prosím. Zkuste to za chvíli.", "slow_down");
    list.push(now);
    recent.set(key, list);
    // forget idle senders (instead of resetting everyone's limits at once)
    if (recent.size > 5000) for (const [k, v] of recent) if (!v.length || now - v[v.length - 1] > windowMs) recent.delete(k);
  }
  const ipOf = req => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;

  function setAnswered(id, talkIds, answered) {
    if (!talkIds.length) notFound("Dotaz neexistuje.");
    const x = one(`SELECT * FROM questions WHERE id = ? AND talk_id IN (${talkIds.map(() => "?").join(",")})`, +id, ...talkIds) || notFound("Dotaz neexistuje.");
    run("UPDATE questions SET answered_at = ? WHERE id = ?", answered ? new Date().toISOString() : null, x.id);
  }

  // audience
  route("GET", "/api/qa/:q", async (req, p, url) => {
    const t = qaTalk(p.q);
    const e = one("SELECT * FROM events WHERE id = ?", t.event_id);
    const voter = url.searchParams.get("voter");
    const mine = voter ? q("SELECT v.question_id FROM question_votes v JOIN questions x ON x.id = v.question_id WHERE x.talk_id = ? AND v.voter = ?", t.id, voter).map(r => r.question_id) : [];
    return {
      event: { name: e.name },
      talk: { kind: t.kind, title: t.title, speaker: t.speaker, moderator: t.moderator, panelists: JSON.parse(t.panelists || "[]"), open: !!t.qa_enabled },
      questions: questionsOf(t.id), voted: mine,
      poll: (() => { const pl = currentPoll(t.id, voter || ""); return pl?.open ? pl : null; })(),
    };
  });

  route("POST", "/api/qa/:q/questions", async (req, p) => {
    const t = qaTalk(p.q), b = await body(req);
    if (!t.qa_enabled) throw new HttpError(403, "Dotazy k téhle přednášce jsou vypnuté.", "qa_closed");
    const text = String(b.text || "").trim().slice(0, 400);
    if (text.length < 2) throw new HttpError(400, "Napište dotaz.", "qa_empty");
    rateLimit(`q:${ipOf(req)}:${t.id}`);
    const author = String(b.author || "").trim().slice(0, 60) || null;
    run("INSERT INTO questions (talk_id, author, text) VALUES (?, ?, ?)", t.id, author, text);
    return [201, { questions: questionsOf(t.id) }];
  });

  route("POST", "/api/qa/:q/questions/:id/vote", async (req, p) => {
    const t = qaTalk(p.q), b = await body(req);
    const voter = String(b.voter || "").slice(0, 64);
    if (voter.length < 8) badRequest("Chybí identifikace hlasujícího.");
    const x = one("SELECT * FROM questions WHERE id = ? AND talk_id = ? AND hidden = 0", +p.id, t.id) || notFound("Dotaz neexistuje.");
    rateLimit(`v:${ipOf(req)}`, 60);
    const had = one("SELECT 1 AS y FROM question_votes WHERE question_id = ? AND voter = ?", x.id, voter);
    if (had) run("DELETE FROM question_votes WHERE question_id = ? AND voter = ?", x.id, voter);
    else run("INSERT INTO question_votes (question_id, voter) VALUES (?, ?)", x.id, voter);
    run("UPDATE questions SET votes = (SELECT COUNT(*) FROM question_votes WHERE question_id = ?) WHERE id = ?", x.id, x.id);
    return { questions: questionsOf(t.id), voted: !had };
  });

  route("GET", "/api/qa/:q/qr.svg", async (req, p, url, res) => {
    const t = qaTalk(p.q);
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
    res.end(qrSvg(`${originOf(req)}/q/${t.qa_token}`));
    return { handled: true };
  });

  // speaker: their own talk's questions, can tick them off
  route("GET", "/api/speaker/:t/questions", async (req, p) => {
    const t = talkBySpeaker(p.t);
    return { qaUrl: `${originOf(req)}/q/${t.qa_token}`, qaEnabled: !!t.qa_enabled, questions: questionsOf(t.id) };
  });
  route("PATCH", "/api/speaker/:t/questions/:id", async (req, p) => {
    const t = talkBySpeaker(p.t), b = await body(req);
    setAnswered(p.id, [t.id], !!b.answered);
    return { questions: questionsOf(t.id) };
  });

  // organizer: all questions of a talk, answer or hide
  route("GET", "/api/admin/:t/talks/:id/questions", async (req, p) => {
    const e = eventByAdmin(p.t), t = panelOf(e, p.id);
    return { qaUrl: `${originOf(req)}/q/${t.qa_token}`, qaEnabled: !!t.qa_enabled, questions: questionsOf(t.id, { withHidden: true }) };
  });
  route("PATCH", "/api/admin/:t/questions/:id", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const x = one("SELECT x.* FROM questions x JOIN talks t ON t.id = x.talk_id WHERE x.id = ? AND t.event_id = ?", +p.id, e.id) || notFound("Dotaz neexistuje.");
    if (b.answered !== undefined) run("UPDATE questions SET answered_at = ? WHERE id = ?", b.answered ? new Date().toISOString() : null, x.id);
    if (b.hidden !== undefined) run("UPDATE questions SET hidden = ? WHERE id = ?", b.hidden ? 1 : 0, x.id);
    return { questions: questionsOf(x.talk_id, { withHidden: true }) };
  });

  // room: questions of every talk in the room (polled during the day), technician can tick them off
  route("GET", "/api/player/:t/questions", async (req, p) => {
    const r = roomByPlayer(p.t);
    const out = {}, polls = {};
    for (const t of q("SELECT id FROM talks WHERE room_id = ? AND kind != 'break'", r.id)) {
      out[t.id] = questionsOf(t.id);
      const poll = currentPoll(t.id);
      if (poll) polls[t.id] = poll;
    }
    return { questions: out, polls };
  });

  // ---------- live polls (one question: pick an option, or answer with a word → word cloud) ----------
  function pollOut(pl, voter) {
    const options = JSON.parse(pl.options || "null");
    const votes = q("SELECT answer, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY answer", pl.id);
    const total = votes.reduce((a, v) => a + v.n, 0);
    const results = options
      ? options.map((o, i) => ({ label: o, votes: votes.find(v => v.answer === String(i))?.n || 0 }))
      : votes.map(v => ({ label: v.answer, votes: v.n })).sort((a, b) => b.votes - a.votes || a.label.localeCompare(b.label)).slice(0, 40);
    const mine = voter ? one("SELECT answer FROM poll_votes WHERE poll_id = ? AND voter = ?", pl.id, voter)?.answer ?? null : undefined;
    return { id: pl.id, question: pl.question, kind: options ? "choice" : "words", options, open: !!pl.open, total, results, ...(mine !== undefined ? { mine } : {}) };
  }
  // the open poll of a talk, or the last one (results stay visible after closing)
  const currentPoll = (talkId, voter) => {
    const pl = one("SELECT * FROM polls WHERE talk_id = ? ORDER BY open DESC, id DESC LIMIT 1", talkId);
    return pl ? pollOut(pl, voter) : null;
  };
  const pollsOf = talkId => q("SELECT * FROM polls WHERE talk_id = ? ORDER BY id DESC", talkId).map(pl => pollOut(pl));
  function createPoll(t, b) {
    const question = str(b.question, "Otázka", true);
    const options = names(String(b.options || "").split("\n")).slice(0, 8);
    if (options.length === 1) badRequest("Napište aspoň dvě možnosti, nebo žádnou (pak lidé odpovídají slovem).");
    run("UPDATE polls SET open = 0 WHERE talk_id = ?", t.id);
    run("INSERT INTO polls (talk_id, question, options) VALUES (?, ?, ?)", t.id, question, options.length ? JSON.stringify(options) : null);
    return pollsOf(t.id);
  }
  function setPollOpen(talkIds, pollId, open) {
    const pl = one(`SELECT * FROM polls WHERE id = ? AND talk_id IN (${talkIds.map(() => "?").join(",")})`, +pollId, ...talkIds) || notFound("Hlasování neexistuje.");
    if (open) run("UPDATE polls SET open = 0 WHERE talk_id = ?", pl.talk_id);
    run("UPDATE polls SET open = ? WHERE id = ?", open ? 1 : 0, pl.id);
    return pollsOf(pl.talk_id);
  }
  route("GET", "/api/admin/:t/talks/:id/polls", async (req, p) => ({ polls: pollsOf(adminTalk(eventByAdmin(p.t), p.id).id) }));
  route("POST", "/api/admin/:t/talks/:id/polls", async (req, p) => [201, { polls: createPoll(adminTalk(eventByAdmin(p.t), p.id), await body(req)) }]);
  route("PATCH", "/api/admin/:t/polls/:pid", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    return { polls: setPollOpen(q("SELECT id FROM talks WHERE event_id = ?", e.id).map(x => x.id), p.pid, !!b.open) };
  });
  route("GET", "/api/speaker/:t/polls", async (req, p) => ({ polls: pollsOf(talkBySpeaker(p.t).id) }));
  route("POST", "/api/speaker/:t/polls", async (req, p) => [201, { polls: createPoll(talkBySpeaker(p.t), await body(req)) }]);
  route("PATCH", "/api/speaker/:t/polls/:pid", async (req, p) => ({ polls: setPollOpen([talkBySpeaker(p.t).id], p.pid, !!(await body(req)).open) }));
  route("POST", "/api/qa/:q/polls/:pid/vote", async (req, p) => {
    const t = qaTalk(p.q), b = await body(req);
    const pl = one("SELECT * FROM polls WHERE id = ? AND talk_id = ?", +p.pid, t.id) || notFound("Hlasování neexistuje.");
    if (!pl.open) throw new HttpError(409, "Hlasování už skončilo.", "poll_closed");
    const voter = String(b.voter || "").slice(0, 80);
    if (voter.length < 8) badRequest("Chybí identifikace hlasujícího.");
    rateLimit(`p:${ipOf(req)}`, 60);
    const options = JSON.parse(pl.options || "null");
    let answer;
    if (options) { answer = String(+b.answer); if (!(+b.answer >= 0 && +b.answer < options.length)) badRequest("Vyberte možnost."); }
    else { answer = String(b.answer || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40); if (!answer) throw new HttpError(400, "Napište odpověď.", "poll_empty"); }
    run("INSERT INTO poll_votes (poll_id, voter, answer) VALUES (?, ?, ?) ON CONFLICT(poll_id, voter) DO UPDATE SET answer = excluded.answer", pl.id, voter, answer);
    return { poll: pollOut(pl, voter) };
  });
  route("PATCH", "/api/player/:t/questions/:id", async (req, p) => {
    const r = roomByPlayer(p.t), b = await body(req);
    setAnswered(p.id, q("SELECT id FROM talks WHERE room_id = ?", r.id).map(x => x.id), !!b.answered);
    return { ok: true };
  });

  // hosted MCP (Streamable HTTP, JSON responses): claude mcp add --transport http fckscrn https://<server>/mcp --header "Authorization: Bearer <admin token>"
  // the key goes in the Authorization header (Claude Code) or in the address /mcp/<key> (connectors in
  // ChatGPT, Claude.ai and other apps that only take a URL); every request stands on its own
  const mcpRoute = async (req, p, url, res) => {
    const auth = p.t || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const proto = req.headers["x-forwarded-proto"] || "http";
    const mcp = createMcp({
      server: `http://127.0.0.1:${req.socket.localPort}`,
      publicUrl: `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`,
      token: tokenFrom(auth),
    });
    const msg = await body(req);
    const out = Array.isArray(msg) ? (await Promise.all(msg.map(m => mcp.handle(m)))).filter(Boolean) : await mcp.handle(msg);
    if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); res.end(); return { handled: true }; }
    return Array.isArray(out) ? [200, out] : out; // a batch answer is an array: don't let it read as [status, body]
  };
  route("POST", "/mcp", mcpRoute);
  route("POST", "/mcp/:t", mcpRoute);
  const noGet = async (req, p, url, res) => { res.writeHead(405, { Allow: "POST" }); res.end(); return { handled: true }; };
  route("GET", "/mcp", noGet);
  route("GET", "/mcp/:t", noGet);

  route("DELETE", "/api/admin/:t", async (req, p) => {
    await deleteEvent(eventByAdmin(p.t));
    return { deleted: true };
  });

  // everything in one ZIP: program, presentations (original + PDF), speaker notes, partner loop
  route("GET", "/api/admin/:t/export", async (req, p, url, res) => {
    const e = eventByAdmin(p.t);
    const rooms = Object.fromEntries(q("SELECT id, name FROM rooms WHERE event_id = ?", e.id).map(r => [r.id, r.name]));
    const talks = talksOf(e.id);
    const safe = s => String(s || "").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
    const entries = [];
    const csv = [["Začátek", "Délka (min)", "Sál", "Typ", "Název", "Řečník", "Soubor", "Stav"]];
    const notesTxt = [];
    for (const t of talks) {
      const room = rooms[t.room_id] || "Bez sálu";
      csv.push([t.starts_at || "", t.duration_min, room, t.kind === "break" ? "Přestávka" : "Přednáška", t.title, t.speaker || "", t.file_name || "", t.kind === "break" ? "" : STATUS_CS[t.status] || t.status]);
      if (!t.version) continue;
      const base = `prezentace/${safe(room)}/${(t.starts_at || "--").replace(":", "-")} ${safe(t.title)}${t.speaker ? " - " + safe(t.speaker) : ""}`;
      const f = filePaths(t);
      entries.push({ name: `${base}.${t.file_ext}`, file: f.original });
      if (t.has_pdf && t.file_ext !== "pdf") entries.push({ name: `${base}.pdf`, file: f.pdf });
      const notes = JSON.parse(t.notes || "[]");
      if (notes.some(Boolean)) notesTxt.push(`# ${t.title}${t.speaker ? " – " + t.speaker : ""}\n\n` + notes.map((n, i) => `Slide ${i + 1}: ${n || "–"}`).join("\n") + "\n");
    }
    mediaOf(e.id).forEach((m, i) => entries.push({ name: `smycka-partneru/${String(i + 1).padStart(2, "0")} ${safe(m.file_name)}`, file: mediaFile(m) }));
    const csvText = "\ufeff" + csv.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    entries.unshift(
      { name: "program.csv", data: csvText },
      { name: "program.json", data: JSON.stringify({ event: eventOut(e), rooms: Object.values(rooms), talks: talks.map(t => ({ ...talkOut(t), room: rooms[t.room_id] || null, notes: JSON.parse(t.notes || "[]") })) }, null, 2) },
      ...(notesTxt.length ? [{ name: "poznamky-recniku.txt", data: notesTxt.join("\n") }] : []),
    );
    for (const en of entries) if (en.file && !fs.existsSync(en.file)) en.data = "", delete en.file;
    const fname = `fckscrn-${safe(e.name).replace(/\s/g, "-") || "akce"}.zip`;
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`, "Cache-Control": "no-store" });
    await writeZip(res, entries);
    return { handled: true };
  });

  route("POST", "/api/admin/:t/rooms", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    run("INSERT INTO rooms (event_id, name, player_token, remote_token) VALUES (?, ?, ?, ?)", e.id, str(b.name, "Název sálu", true), token(), token());
    return [201, adminView(e)];
  });

  route("PATCH", "/api/admin/:t/rooms/:id", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const r = one("SELECT * FROM rooms WHERE id = ? AND event_id = ?", +p.id, e.id) || notFound("Sál neexistuje.");
    run("UPDATE rooms SET name = ? WHERE id = ?", str(b.name, "Název sálu", true), r.id);
    return adminView(e);
  });

  route("DELETE", "/api/admin/:t/rooms/:id", async (req, p) => {
    const e = eventByAdmin(p.t);
    run("DELETE FROM rooms WHERE id = ? AND event_id = ?", +p.id, e.id);
    return adminView(e);
  });

  route("POST", "/api/admin/:t/talks", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const roomId = b.roomId ? (one("SELECT id FROM rooms WHERE id = ? AND event_id = ?", +b.roomId, e.id) || badRequest("Vyberte sál.")).id : null;
    const kind = ["break", "panel"].includes(b.kind) ? b.kind : "talk";
    const title = kind === "break" ? (str(b.title) || "Přestávka")
      : kind === "panel" ? (str(b.title) || "Panelová diskuse")
      : str(b.title, "Název přednášky", true);
    run(`INSERT INTO talks (event_id, room_id, starts_at, duration_min, title, speaker, speaker_token, kind, moderator, panelists, qa_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id, roomId, time(b.startsAt), duration(b.durationMin), title,
      kind === "talk" ? str(b.speaker) : null, token(), kind,
      kind === "panel" ? str(b.moderator) : null, kind === "panel" ? JSON.stringify(names(b.panelists)) : null, token());
    return [201, adminView(e)];
  });

  // programme pasted from Excel / Google Sheets (parsed in the browser): rooms are matched by name or created
  route("POST", "/api/admin/:t/import", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 300);
    if (!rows.length) badRequest("Nenašli jsme žádné řádky programu.");
    let rooms = q("SELECT * FROM rooms WHERE event_id = ? ORDER BY id", e.id);
    const names = [...new Set(rows.map(r => str(r.room)).filter(Boolean))];
    const byName = n => rooms.find(r => r.name.toLowerCase() === n.toLowerCase());
    // a fresh event has one empty room with a default name: it becomes the table's first room
    if (rooms.length === 1 && names.length && !byName(names[0]) && !q("SELECT 1 FROM talks WHERE event_id = ?", e.id).length) {
      run("UPDATE rooms SET name = ? WHERE id = ?", names[0].slice(0, 120), rooms[0].id);
      rooms = q("SELECT * FROM rooms WHERE event_id = ? ORDER BY id", e.id);
    }
    for (const n of names) if (!byName(n)) run("INSERT INTO rooms (event_id, name, player_token, remote_token) VALUES (?, ?, ?, ?)", e.id, n.slice(0, 120), token(), token());
    rooms = q("SELECT * FROM rooms WHERE event_id = ? ORDER BY id", e.id);
    if (rooms.length > 1 && e.mode === "single") run("UPDATE events SET mode = 'multi' WHERE id = ?", e.id);
    let n = 0;
    for (const r of rows) {
      const kind = r.kind === "break" ? "break" : "talk";
      const title = str(r.title) || (kind === "break" ? "Přestávka" : null);
      if (!title) continue;
      const room = (r.room && byName(String(r.room).trim())) || rooms.find(x => x.id === +b.roomId) || rooms[0];
      const start = /^([01]\d|2[0-3]):[0-5]\d$/.test(r.startsAt || "") ? r.startsAt : null;
      const dur = Math.min(Math.max(Math.round(+r.durationMin || (kind === "break" ? 15 : 20)), 1), 600);
      run(`INSERT INTO talks (event_id, room_id, starts_at, duration_min, title, speaker, speaker_token, kind, qa_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.id, room.id, start, dur, title, kind === "talk" ? str(r.speaker) : null, token(), kind, token());
      n++;
    }
    return { ...adminView(eventByAdmin(p.t)), imported: n };
  });

  // preview for the organizer: slides + speaker notes

  const adminTalk = (e, id) => one("SELECT * FROM talks WHERE id = ? AND event_id = ?", +id, e.id) || notFound("Přednáška neexistuje.");

  route("GET", "/api/admin/:t/talks/:id/preview", async (req, p) => {
    const e = eventByAdmin(p.t), t = adminTalk(e, p.id);
    const base = `/api/admin/${p.t}/talks/${t.id}`;
    return {
      talk: talkOut(t),
      notes: JSON.parse(t.notes || "[]"),
      pdfUrl: t.has_pdf ? `${base}/pdf?v=${t.version}` : null,
      thumbUrl: t.version && fs.existsSync(filePaths(t).thumb) ? `${base}/thumb?v=${t.version}` : null,
      originalUrl: t.version ? `${base}/original` : null,
    };
  });

  route("GET", "/api/admin/:t/talks/:id/:kind", async (req, p) => {
    const e = eventByAdmin(p.t), t = adminTalk(e, p.id);
    if (!t.version || !["pdf", "original", "thumb"].includes(p.kind) || (p.kind === "pdf" && !t.has_pdf)) notFound("Soubor není.");
    if (p.kind === "thumb" && !fs.existsSync(filePaths(t).thumb)) notFound("Náhled není.");
    return { file: filePaths(t)[p.kind], type: { pdf: "application/pdf", thumb: "image/jpeg" }[p.kind] || "application/octet-stream", download: p.kind === "original" ? t.file_name : null };
  });

  // partner loop

  route("PUT", "/api/admin/:t/media", async (req, p, url) => {
    const e = eventByAdmin(p.t);
    const name = path.basename(url.searchParams.get("name") || "").slice(0, 200);
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!MEDIA_TYPES[ext]) throw new HttpError(400, "Do smyčky jde nahrát obrázek (JPG, PNG, WebP, GIF, SVG) nebo video (MP4, WebM, MOV).", "media_format");
    if (+req.headers["content-length"] > MAX_MEDIA) throw new HttpError(413, "Soubor je větší než 1 GB.");
    const roomId = url.searchParams.get("roomId") ? +url.searchParams.get("roomId") : null;
    if (roomId && !one("SELECT id FROM rooms WHERE id = ? AND event_id = ?", roomId, e.id)) badRequest("Vyberte sál.");

    const pos = one("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM media WHERE event_id = ?", e.id).p;
    const id = run("INSERT INTO media (event_id, room_id, kind, file_name, file_ext, position) VALUES (?, ?, ?, ?, ?, ?)",
      e.id, roomId, MEDIA_TYPES[ext][0], name, ext, pos).lastInsertRowid;
    const m = one("SELECT * FROM media WHERE id = ?", id);
    await fsp.mkdir(path.dirname(mediaFile(m)), { recursive: true });
    let size = 0;
    try {
      req.on("data", c => { size += c.length; if (size > MAX_MEDIA) req.destroy(new HttpError(413, "Soubor je větší než 1 GB.")); });
      await pipeline(req, fs.createWriteStream(mediaFile(m)));
      if (!size) badRequest("Soubor je prázdný.");
    } catch (err) {
      run("DELETE FROM media WHERE id = ?", id);
      await fsp.rm(mediaFile(m), { force: true });
      throw err;
    }
    run("UPDATE media SET file_size = ? WHERE id = ?", size, id);
    return [201, adminView(e)];
  });

  route("PATCH", "/api/admin/:t/media/:id", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const m = one("SELECT * FROM media WHERE id = ? AND event_id = ?", +p.id, e.id) || notFound("Položka smyčky neexistuje.");
    if (b.durationSec !== undefined) {
      const d = Math.round(+b.durationSec);
      if (!(d >= 2 && d <= 600)) badRequest("Délka zobrazení musí být 2 až 600 sekund.");
      run("UPDATE media SET duration_sec = ? WHERE id = ?", d, m.id);
    }
    if (b.roomId !== undefined) {
      const roomId = b.roomId ? (one("SELECT id FROM rooms WHERE id = ? AND event_id = ?", +b.roomId, e.id) || badRequest("Vyberte sál.")).id : null;
      run("UPDATE media SET room_id = ? WHERE id = ?", roomId, m.id);
    }
    if (b.move === -1 || b.move === 1) {
      // renumber, then swap with the neighbour
      const list = mediaOf(e.id);
      const i = list.findIndex(x => x.id === m.id), j = i + b.move;
      if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
      list.forEach((x, k) => run("UPDATE media SET position = ? WHERE id = ?", k + 1, x.id));
    }
    return adminView(e);
  });

  route("DELETE", "/api/admin/:t/media/:id", async (req, p) => {
    const e = eventByAdmin(p.t);
    const m = one("SELECT * FROM media WHERE id = ? AND event_id = ?", +p.id, e.id);
    if (m) { run("DELETE FROM media WHERE id = ?", m.id); await fsp.rm(mediaFile(m), { force: true }); }
    return adminView(e);
  });

  route("GET", "/api/admin/:t/media/:id", async (req, p) => {
    const e = eventByAdmin(p.t);
    return mediaSend(one("SELECT * FROM media WHERE id = ? AND event_id = ?", +p.id, e.id) || notFound("Položka smyčky neexistuje."));
  });

  route("PATCH", "/api/admin/:t/talks/:id", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const t = one("SELECT * FROM talks WHERE id = ? AND event_id = ?", +p.id, e.id) || notFound("Přednáška neexistuje.");
    if (b.reviewed !== undefined && t.version) {
      run("UPDATE talks SET reviewed_at = ?, status = ? WHERE id = ?", b.reviewed ? new Date().toISOString() : null,
        statusOf(JSON.parse(t.issues || "[]"), !!t.has_pdf, !!b.reviewed), t.id);
      if (Object.keys(b).length === 1) return adminView(e);
    }
    const roomId = b.roomId !== undefined
      ? (b.roomId ? (one("SELECT id FROM rooms WHERE id = ? AND event_id = ?", +b.roomId, e.id) || badRequest("Vyberte sál.")).id : null)
      : t.room_id;
    const fallback = { break: "Přestávka", panel: "Panelová diskuse" }[t.kind];
    run("UPDATE talks SET room_id = ?, starts_at = ?, duration_min = ?, title = ?, speaker = ?, moderator = ?, panelists = ?, qa_enabled = ? WHERE id = ?",
      roomId,
      b.startsAt !== undefined ? time(b.startsAt) : t.starts_at,
      b.durationMin !== undefined ? duration(b.durationMin) : t.duration_min,
      b.title !== undefined ? (fallback ? (str(b.title) || fallback) : str(b.title, "Název přednášky", true)) : t.title,
      b.speaker !== undefined ? str(b.speaker) : t.speaker,
      b.moderator !== undefined ? str(b.moderator) : t.moderator,
      b.panelists !== undefined ? JSON.stringify(names(b.panelists)) : t.panelists,
      b.qaEnabled !== undefined ? (b.qaEnabled ? 1 : 0) : t.qa_enabled, t.id);
    return adminView(e);
  });

  route("DELETE", "/api/admin/:t/talks/:id", async (req, p) => {
    const e = eventByAdmin(p.t);
    const t = one("SELECT * FROM talks WHERE id = ? AND event_id = ?", +p.id, e.id);
    if (t) {
      run("DELETE FROM talks WHERE id = ?", t.id);
      await fsp.rm(talkDir(t), { recursive: true, force: true });
      if (t.bg_ext) await fsp.rm(bgFile(t), { force: true });
    }
    return adminView(e);
  });

  // speaker

  route("GET", "/api/speaker/:t", async (req, p) => {
    const t = talkBySpeaker(p.t);
    const e = one("SELECT * FROM events WHERE id = ?", t.event_id);
    const r = t.room_id ? one("SELECT name FROM rooms WHERE id = ?", t.room_id) : null;
    return { event: eventOut(e), room: r?.name || null, talk: { ...talkOut(t), notes: JSON.parse(t.notes || "[]") }, accepted: ACCEPTED };
  });

  // speaker: may show their slides on the event's public page after the event
  route("PATCH", "/api/speaker/:t", async (req, p) => {
    const t = talkBySpeaker(p.t), b = await body(req);
    if (b.shareSlides !== undefined) run("UPDATE talks SET share_slides = ? WHERE id = ?", b.shareSlides ? 1 : 0, t.id);
    return talkOut(one("SELECT * FROM talks WHERE id = ?", t.id));
  });

  // ---------- presentation upload (speaker, organizer, or Google Slides link) ----------

  // "info" never needs attention; warnings can be signed off by the organizer
  function statusOf(issues, hasPdf, reviewed) {
    const levels = issues.map(i => i.level);
    if (levels.includes("error") && !hasPdf) return "error";
    if (levels.includes("error") || levels.includes("warn")) return reviewed ? "ready" : "warning";
    return "ready";
  }

  // fill(dir, version) writes original.<ext> (and optionally presentation.pdf) and returns { name, ext, size, pdfFile? }
  async function storePresentation(t, fill, { by, sourceUrl = null }) {
    const version = t.version + 1;
    const dir = versionDir(t, version);
    await fsp.mkdir(dir, { recursive: true });
    let got;
    try { got = await fill(dir); }
    catch (e) { await fsp.rm(dir, { recursive: true, force: true }); throw e; }
    const { name, ext, size, pdfFile } = got;
    const original = path.join(dir, `original.${ext}`);

    run("UPDATE talks SET status = 'processing' WHERE id = ?", t.id);
    if (["pptx", "key", "odp"].includes(ext)) {
      const thumb = packageThumbnail(original);
      if (thumb) await fsp.writeFile(path.join(dir, "thumbnail.jpg"), thumb);
    }
    const result = await analyze(original, ext, dir, { soffice, pdfFile });
    if (result.pdf && result.pdf !== path.join(dir, "presentation.pdf")) {
      if (ext === "pdf") await fsp.copyFile(result.pdf, path.join(dir, "presentation.pdf"));
      else await fsp.rename(result.pdf, path.join(dir, "presentation.pdf"));
    }
    // a speaker replacing an existing file always goes back to the organizer for a look
    if (t.version > 0 && by === "speaker") {
      result.issues.unshift({ level: "warn", code: "new_version", n: version, text: `Řečník nahrál novou verzi (${version}.). Projděte ji a odsouhlaste.` });
    }
    // notes typed by hand survive a new upload that brings none of its own (Keynote, PDF)
    let manual = 0;
    if (!result.notes.some(Boolean) && t.notes_manual && JSON.parse(t.notes || "[]").some(Boolean)) {
      result.notes = JSON.parse(t.notes);
      manual = 1;
      result.issues = result.issues.filter(i => i.code !== "keynote_notes");
      result.issues.push({ level: "ok", code: "notes_kept", text: "Ponechali jsme poznámky dopsané k minulé verzi. Zkontrolujte, že sedí ke slidům." });
    }
    const status = statusOf(result.issues, !!result.pdf, false);
    run(`UPDATE talks SET notes_manual = ${manual}, version = ?, file_name = ?, file_ext = ?, file_size = ?, has_pdf = ?, page_count = ?,
         notes = ?, issues = ?, status = ?, uploaded_at = CURRENT_TIMESTAMP, source_url = ?, uploaded_by = ?, reviewed_at = NULL, videos = ? WHERE id = ?`,
      version, name, ext, size, result.pdf ? 1 : 0, result.pageCount, JSON.stringify(result.notes), JSON.stringify(result.issues), status, sourceUrl, by,
      JSON.stringify(result.videos), t.id);

    // keep only the newest version on disk
    for (const d of await fsp.readdir(talkDir(t))) if (d !== `v${version}`) await fsp.rm(path.join(talkDir(t), d), { recursive: true, force: true });
    await fsp.rm(path.join(dir, ".lo-profile"), { recursive: true, force: true });
    return one("SELECT * FROM talks WHERE id = ?", t.id);
  }

  // file in the request body, name in ?name=
  function fromRequest(req, url) {
    const name = path.basename(url.searchParams.get("name") || "").slice(0, 200);
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!ACCEPTED.includes(ext)) throw new HttpError(400, `Tenhle formát neumíme. Nahrajte ${ACCEPTED.map(x => "." + x).join(", ")}.`, "format");
    if (+req.headers["content-length"] > MAX_UPLOAD) throw new HttpError(413, "Soubor je větší než 2 GB.", "too_large");
    return async dir => {
      let size = 0;
      req.on("data", c => { size += c.length; if (size > MAX_UPLOAD) req.destroy(new HttpError(413, "Soubor je větší než 2 GB.", "too_large")); });
      await pipeline(req, fs.createWriteStream(path.join(dir, `original.${ext}`)));
      if (!size) throw new HttpError(400, "Soubor je prázdný.", "empty");
      return { name, ext, size };
    };
  }

  // Google Slides: export PDF (exact slides) + PPTX (speaker notes). Must be shared "anyone with the link".
  function fromGoogleSlides(link) {
    const id = String(link || "").match(/docs\.google\.com\/presentation\/d\/([\w-]{20,})/)?.[1];
    if (!id) throw new HttpError(400, "Tohle není odkaz na Google Slides. Zkopírujte adresu prezentace z prohlížeče.", "gslides_link");
    // streamed straight to disk (exports with videos can be big)
    const get = async (fmt, dest) => {
      const res = await fetchImpl(`https://docs.google.com/presentation/d/${id}/export/${fmt}`, { redirect: "follow" });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || type.includes("text/html") || !res.body) {
        throw new HttpError(400, "Prezentaci se nepodařilo stáhnout. V Google Slides nastavte Sdílet › Kdokoli s odkazem › Zobrazení a zkuste to znovu.", "gslides_private");
      }
      let size = 0;
      const body = Readable.fromWeb(res.body);
      body.on("data", c => { size += c.length; if (size > MAX_UPLOAD) body.destroy(new HttpError(413, "Soubor je větší než 2 GB.", "too_large")); });
      await pipeline(body, fs.createWriteStream(dest));
      const cd = res.headers.get("content-disposition") || "";
      const fname = decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || cd.match(/filename="([^"]+)"/i)?.[1] || "");
      return { size, fname };
    };
    return async dir => {
      const [, pptx] = await Promise.all([get("pdf", path.join(dir, "presentation.pdf")), get("pptx", path.join(dir, "original.pptx"))]);
      const name = (pptx.fname || "Google Slides.pptx").replace(/[\/\\]/g, "-").slice(0, 200);
      return { name: name.endsWith(".pptx") ? name : name + ".pptx", ext: "pptx", size: pptx.size, pdfFile: path.join(dir, "presentation.pdf") };
    };
  }

  // speaker notes typed next to each slide in the preview (Keynote and PDF bring none, or a quick fix)
  function saveNotes(t, notes) {
    if (!t.version || !t.page_count) throw new HttpError(409, "Poznámky jde dopsat, až budou vidět slidy.", "no_slides");
    if (!Array.isArray(notes)) throw new HttpError(400, "Chybí poznámky.", "notes");
    const clean = Array.from({ length: Math.min(t.page_count, 1000) }, (_, i) => String(notes[i] ?? "").replace(/\r/g, "").slice(0, 5000).trimEnd());
    const has = clean.some(Boolean);
    const issues = JSON.parse(t.issues || "[]").filter(i => !(has && i.code === "keynote_notes") && i.code !== "notes_kept");
    run("UPDATE talks SET notes = ?, notes_manual = 1, issues = ?, status = ? WHERE id = ?",
      JSON.stringify(clean), JSON.stringify(issues), statusOf(issues, !!t.has_pdf, !!t.reviewed_at), t.id);
    return one("SELECT * FROM talks WHERE id = ?", t.id);
  }
  route("PUT", "/api/speaker/:t/notes", async (req, p) => {
    const t = saveNotes(talkBySpeaker(p.t), (await body(req)).notes);
    return { ...talkOut(t), notes: JSON.parse(t.notes) };
  });
  route("PUT", "/api/admin/:t/talks/:id/notes", async (req, p) => {
    const e = eventByAdmin(p.t);
    const t = one("SELECT * FROM talks WHERE id = ? AND event_id = ? AND kind = 'talk'", +p.id, e.id) || notFound("Přednáška neexistuje.");
    saveNotes(t, (await body(req)).notes);
    return adminView(e);
  });

  route("PUT", "/api/speaker/:t/file", async (req, p, url) => {
    const t = talkBySpeaker(p.t);
    return talkOut(await storePresentation(t, fromRequest(req, url), { by: "speaker" }));
  });

  route("POST", "/api/speaker/:t/link", async (req, p) => {
    const t = talkBySpeaker(p.t), b = await body(req);
    return talkOut(await storePresentation(t, fromGoogleSlides(b.url), { by: "speaker", sourceUrl: b.url }));
  });

  // the organizer uploads on the speaker's behalf (e.g. a partner's slot)
  route("PUT", "/api/admin/:t/talks/:id/file", async (req, p, url) => {
    const e = eventByAdmin(p.t);
    const t = one("SELECT * FROM talks WHERE id = ? AND event_id = ? AND kind = 'talk'", +p.id, e.id) || notFound("Přednáška neexistuje.");
    await storePresentation(t, fromRequest(req, url), { by: "organizer" });
    return adminView(e);
  });

  route("POST", "/api/admin/:t/talks/:id/link", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const t = one("SELECT * FROM talks WHERE id = ? AND event_id = ? AND kind = 'talk'", +p.id, e.id) || notFound("Přednáška neexistuje.");
    await storePresentation(t, fromGoogleSlides(b.url), { by: "organizer", sourceUrl: b.url });
    return adminView(e);
  });

  // a video the presentation only links to (YouTube, a file on the author's computer) or can't play:
  // the speaker uploads the file and it plays offline like an embedded one
  async function replaceVideo(t, i, req, url) {
    const videos = videosOf(t), v = videos.find(x => x.i === +i);
    if (!v) notFound("Video v prezentaci není.");
    const name = path.basename(url.searchParams.get("name") || "").slice(0, 200);
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!VIDEO_TYPES[ext]) throw new HttpError(400, "Nahrajte video jako MP4 (případně MOV nebo WebM).", "video_format");
    if (+req.headers["content-length"] > MAX_MEDIA) throw new HttpError(413, "Soubor je větší než 1 GB.", "too_large");
    const dest = videoFile(t, { i: v.i, ext }), tmp = dest + ".part";
    let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_MEDIA) req.destroy(new HttpError(413, "Soubor je větší než 1 GB.", "too_large")); });
    try { await pipeline(req, fs.createWriteStream(tmp)); }
    catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
    if (!size) { await fsp.rm(tmp, { force: true }); throw new HttpError(400, "Soubor je prázdný.", "empty"); }
    if (v.kind === "file" && v.ext !== ext) await fsp.rm(videoFile(t, v), { force: true });
    await fsp.rename(tmp, dest);
    // stamp: the room downloads the new file even though the presentation version stays the same
    Object.assign(v, { kind: "file", ext, name, replaced: true, stamp: Date.now() });
    delete v.url; delete v.site;
    // video lines stay where they were in the list
    const old = JSON.parse(t.issues || "[]"), at = Math.max(0, old.findIndex(x => /^video_/.test(x.code)));
    const rest = old.filter(x => !/^video_/.test(x.code));
    const issues = [...rest.slice(0, at), ...videoIssues(videos), ...rest.slice(at)];
    run("UPDATE talks SET videos = ?, issues = ?, status = ? WHERE id = ?",
      JSON.stringify(videos), JSON.stringify(issues), statusOf(issues, !!t.has_pdf, !!t.reviewed_at), t.id);
    return one("SELECT * FROM talks WHERE id = ?", t.id);
  }
  route("PUT", "/api/speaker/:t/videos/:i", async (req, p, url) => talkOut(await replaceVideo(talkBySpeaker(p.t), p.i, req, url)));
  route("PUT", "/api/admin/:t/talks/:id/videos/:i", async (req, p, url) => {
    const e = eventByAdmin(p.t);
    const t = one("SELECT * FROM talks WHERE id = ? AND event_id = ? AND kind = 'talk'", +p.id, e.id) || notFound("Přednáška neexistuje.");
    await replaceVideo(t, p.i, req, url);
    return adminView(e);
  });

  route("GET", "/api/speaker/:t/thumb", async (req, p) => {
    const t = talkBySpeaker(p.t);
    if (!t.version || !fs.existsSync(filePaths(t).thumb)) notFound("Náhled není.");
    return { file: filePaths(t).thumb, type: "image/jpeg" };
  });

  route("GET", "/api/speaker/:t/pdf", async (req, p) => {
    const t = talkBySpeaker(p.t);
    if (!t.has_pdf) notFound("PDF verze zatím není.");
    return { file: filePaths(t).pdf, type: "application/pdf" };
  });

  // player

  route("GET", "/api/player/:t", async (req, p) => {
    const r = roomByPlayer(p.t);
    run("UPDATE rooms SET player_seen_at = ? WHERE id = ?", Date.now(), r.id);
    const e = one("SELECT * FROM events WHERE id = ?", r.event_id);
    const base = `/api/player/${p.t}/talks`;
    return {
      event: eventOut(e),
      room: { id: r.id, name: r.name },
      watermark: watermark(e),
      talks: q("SELECT * FROM talks WHERE room_id = ? ORDER BY starts_at, id", r.id).map(t => ({
        ...talkOut(t),
        notes: JSON.parse(t.notes || "[]"),
        files: {
          ...(t.version && t.has_pdf ? { pdf: `${base}/${t.id}/pdf` } : {}),
          ...(t.version ? { original: `${base}/${t.id}/original` } : {}),
          ...(t.bg_ext ? { background: `${base}/${t.id}/background?v=${bgStamp(t)}` } : {}),
        },
        videos: videosOf(t).map(v => v.kind === "file" ? { ...v, url: `${base}/${t.id}/video/${v.i}?v=${v.stamp || t.version}` } : v),
        ...(t.kind !== "break" ? { qaUrl: `${originOf(req)}/q/${t.qa_token}`, qaQr: qrSvg(`${originOf(req)}/q/${t.qa_token}`) } : {}),
      })),
      loop: mediaOf(e.id, r.id).filter(m => m.file_size).map(m => ({ ...mediaOut(m), url: `/api/player/${p.t}/media/${m.id}` })),
      remote: { url: `${originOf(req)}/r/${r.remote_token}`, qr: qrSvg(`${originOf(req)}/r/${r.remote_token}`) },
    };
  });

  route("GET", "/api/player/:t/media/:id", async (req, p) => {
    const r = roomByPlayer(p.t);
    return mediaSend(one("SELECT * FROM media WHERE id = ? AND event_id = ? AND (room_id IS NULL OR room_id = ?)", +p.id, r.event_id, r.id)
      || notFound("Položka smyčky v tomto sále není."));
  });

  route("GET", "/api/player/:t/talks/:id/video/:i", async (req, p) => {
    const r = roomByPlayer(p.t);
    const t = one("SELECT * FROM talks WHERE id = ? AND room_id = ?", +p.id, r.id) || notFound("Přednáška v tomto sále není.");
    const v = videosOf(t).find(x => x.i === +p.i && x.kind === "file") || notFound("Video není.");
    return { file: videoFile(t, v), type: VIDEO_TYPES[v.ext] };
  });

  route("GET", "/api/player/:t/talks/:id/:kind", async (req, p) => {
    const r = roomByPlayer(p.t);
    const t = one("SELECT * FROM talks WHERE id = ? AND room_id = ?", +p.id, r.id) || notFound("Přednáška v tomto sále není.");
    if (p.kind === "background") {
      if (!t.bg_ext || !fs.existsSync(bgFile(t))) notFound("Pozadí není.");
      return { file: bgFile(t), type: BG_TYPES[t.bg_ext][1] };
    }
    if (!t.version || (p.kind === "pdf" && !t.has_pdf) || !["pdf", "original"].includes(p.kind)) notFound("Soubor není.");
    const f = filePaths(t)[p.kind];
    return { file: f, type: p.kind === "pdf" ? "application/pdf" : "application/octet-stream", download: p.kind === "original" ? t.file_name : null };
  });

  // ---------- live link: room player <-> phone (speaker monitor + clicker) and organizer messages ----------
  // In memory only: the player pushes its state, phones listen; phones and the organizer send commands.
  const hubs = new Map(); // roomId -> { state, at, players: Set<res>, remotes: Set<res> }
  const hubOf = id => hubs.get(id) || (hubs.set(id, { state: null, at: 0, players: new Set(), remotes: new Set() }), hubs.get(id));
  const sse = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  function openStream(req, res, set, first) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    set.add(res);
    if (first) sse(res, first);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => { clearInterval(ping); set.delete(res); });
  }
  const remoteView = h => ({ type: "state", connected: h.players.size > 0, state: h.state });
  const tellRemotes = h => h.remotes.forEach(r => sse(r, remoteView(h)));
  // what's on in a room right now (for the organizer)
  function liveOf(roomId) {
    const h = hubs.get(roomId);
    if (!h?.players.size || (!h.state?.live && !h.state?.help)) return null;
    const { talkId, mode, page, pages, startedAt } = h.state.live || {};
    return { talkId: talkId || null, mode: mode || null, page, pages, startedAt: startedAt || null, help: h.state.help || null };
  }
  function sendToRoom(roomId, cmd, arg) {
    const h = hubOf(roomId);
    h.players.forEach(r => sse(r, { type: "cmd", cmd, arg }));
    return h.players.size;
  }

  route("GET", "/api/player/:t/live", async (req, p, url, res) => {
    const r = roomByPlayer(p.t), h = hubOf(r.id);
    openStream(req, res, h.players);
    tellRemotes(h);
    req.on("close", () => tellRemotes(h));
    return { handled: true };
  });
  route("POST", "/api/player/:t/live", async (req, p) => {
    const r = roomByPlayer(p.t), b = await body(req), h = hubOf(r.id);
    run("UPDATE rooms SET player_seen_at = ? WHERE id = ?", Date.now(), r.id);
    const live = b.live && typeof b.live === "object" ? {
      talkId: +b.live.talkId || null, mode: String(b.live.mode || ""), page: +b.live.page || null, pages: +b.live.pages || null,
      black: !!b.live.black, startedAt: +b.live.startedAt || null,
      video: ["waiting", "playing"].includes(b.live.video) ? b.live.video : null, showQuestions: !!b.live.showQuestions,
    } : null;
    const message = b.message?.text ? { text: String(b.message.text).slice(0, 200), at: +b.message.at || Date.now() } : null;
    const help = b.help?.at ? { at: +b.help.at } : null;
    h.state = { live, message, help, nextTalkId: +b.nextTalkId || null };
    h.at = Date.now();
    tellRemotes(h);
    return { ok: true };
  });

  // running late: move everything after a talk by N minutes (organizer or the room's technician)
  function shiftAfter(roomId, talkId, minutes) {
    const m = Math.round(+minutes);
    if (!m || Math.abs(m) > 240) badRequest("Posun musí být 1 až 240 minut.");
    const from = one("SELECT * FROM talks WHERE id = ? AND room_id = ?", +talkId, roomId) || notFound("Přednáška v tomto sále není.");
    if (!from.starts_at) badRequest("Přednáška nemá čas začátku.");
    const later = q("SELECT * FROM talks WHERE room_id = ? AND starts_at IS NOT NULL AND (starts_at > ? OR (starts_at = ? AND id > ?))", roomId, from.starts_at, from.starts_at, from.id);
    for (const t of later) {
      const [h, mm] = t.starts_at.split(":").map(Number);
      const v = Math.min(Math.max(h * 60 + mm + m, 0), 23 * 60 + 59);
      run("UPDATE talks SET starts_at = ? WHERE id = ?", `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`, t.id);
    }
    return later.length;
  }
  route("POST", "/api/admin/:t/rooms/:id/shift", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const r = one("SELECT * FROM rooms WHERE id = ? AND event_id = ?", +p.id, e.id) || notFound("Sál neexistuje.");
    const n = shiftAfter(r.id, b.afterTalkId, b.minutes);
    return { ...adminView(e), shifted: n };
  });
  route("POST", "/api/player/:t/shift", async (req, p) => {
    const r = roomByPlayer(p.t), b = await body(req);
    return { shifted: shiftAfter(r.id, b.afterTalkId, b.minutes) };
  });

  // the speaker asks for help (phone): the room's technician sees it, the organizer too
  route("POST", "/api/remote/:r/help", async (req, p) => {
    const r = roomByRemote(p.r);
    rateLimit(`h:${r.id}`, 6);
    const delivered = sendToRoom(r.id, "help", { at: Date.now() });
    if (!delivered) throw new HttpError(409, "Počítač v sále není připojený. Zamávejte na technika.", "room_offline");
    return { delivered };
  });

  // the organizer writes to the speaker monitor of a room ("5 minutes left")
  route("POST", "/api/admin/:t/rooms/:id/message", async (req, p) => {
    const e = eventByAdmin(p.t), b = await body(req);
    const r = one("SELECT * FROM rooms WHERE id = ? AND event_id = ?", +p.id, e.id) || notFound("Sál neexistuje.");
    const text = String(b.text || "").trim().slice(0, 200);
    const delivered = sendToRoom(r.id, "message", text ? { text } : null);
    if (!delivered) throw new HttpError(409, "Sál není připojený. Zprávu teď nejde doručit.", "room_offline");
    return { delivered };
  });

  // phone: the room's program with notes, the PDFs, live state, clicker commands
  const roomByRemote = t => one("SELECT * FROM rooms WHERE remote_token = ?", t) || notFound("Odkaz pro telefon neplatí. Naskenujte QR kód v sále znovu.");
  route("GET", "/api/remote/:r", async (req, p) => {
    const r = roomByRemote(p.r), e = one("SELECT * FROM events WHERE id = ?", r.event_id);
    return {
      event: eventOut(e), room: { id: r.id, name: r.name },
      talks: q("SELECT * FROM talks WHERE room_id = ? ORDER BY starts_at, id", r.id).map(t => ({
        id: t.id, kind: t.kind, title: t.title, speaker: t.speaker, startsAt: t.starts_at, durationMin: t.duration_min,
        pageCount: t.page_count, version: t.version, qaEnabled: !!t.qa_enabled, moderator: t.moderator, panelists: JSON.parse(t.panelists || "[]"),
        notes: JSON.parse(t.notes || "[]"),
        pdf: t.version && t.has_pdf ? `/api/remote/${p.r}/talks/${t.id}/pdf?v=${t.version}` : null,
      })),
    };
  });
  route("GET", "/api/remote/:r/talks/:id/pdf", async (req, p) => {
    const r = roomByRemote(p.r);
    const t = one("SELECT * FROM talks WHERE id = ? AND room_id = ?", +p.id, r.id) || notFound("Přednáška v tomto sále není.");
    if (!t.version || !t.has_pdf) notFound("Soubor není.");
    return { file: filePaths(t).pdf, type: "application/pdf" };
  });
  route("GET", "/api/remote/:r/questions", async (req, p) => {
    const r = roomByRemote(p.r), out = {};
    for (const t of q("SELECT id FROM talks WHERE room_id = ? AND kind != 'break'", r.id)) out[t.id] = questionsOf(t.id);
    return { questions: out };
  });
  route("GET", "/api/remote/:r/live", async (req, p, url, res) => {
    const r = roomByRemote(p.r), h = hubOf(r.id);
    openStream(req, res, h.remotes, remoteView(h));
    return { handled: true };
  });
  const REMOTE_CMDS = ["next", "prev", "black", "first", "showQuestions"];
  // the speaker ticks off audience questions on the phone (or brings one back after a misclick)
  route("PATCH", "/api/remote/:r/questions/:id", async (req, p) => {
    const r = roomByRemote(p.r), b = await body(req);
    setAnswered(p.id, q("SELECT id FROM talks WHERE room_id = ?", r.id).map(x => x.id), !!b.answered);
    return { ok: true };
  });
  route("POST", "/api/remote/:r/cmd", async (req, p) => {
    const r = roomByRemote(p.r), b = await body(req);
    if (!REMOTE_CMDS.includes(b.cmd)) badRequest("Neznámý příkaz.");
    const delivered = sendToRoom(r.id, b.cmd);
    if (!delivered) throw new HttpError(409, "Počítač v sále není připojený.", "room_offline");
    return { delivered };
  });

  // ---------- public page after the event: programme + slides the speakers agreed to share ----------
  const eventByPublic = t => one("SELECT * FROM events WHERE public_token = ? AND public_enabled = 1", t) || notFound("Stránka akce neexistuje nebo ji organizátor nezveřejnil.");
  route("GET", "/api/public/:pt", async (req, p) => {
    const e = eventByPublic(p.pt);
    const rooms = Object.fromEntries(q("SELECT id, name FROM rooms WHERE event_id = ?", e.id).map(r => [r.id, r.name]));
    return {
      event: { name: e.name, date: e.date, place: e.place, mode: e.mode, expiresAt: expiresAt(e) },
      talks: talksOf(e.id).filter(t => t.kind !== "break").map(t => ({
        id: t.id, kind: t.kind, title: t.title, speaker: t.speaker, startsAt: t.starts_at, durationMin: t.duration_min,
        room: rooms[t.room_id] || null, moderator: t.moderator, panelists: JSON.parse(t.panelists || "[]"),
        slides: t.share_slides && t.version && t.has_pdf ? `/api/public/${p.pt}/talks/${t.id}/pdf?v=${t.version}` : null,
        pageCount: t.share_slides ? t.page_count : null,
        questions: one("SELECT COUNT(*) AS n FROM questions WHERE talk_id = ? AND hidden = 0", t.id).n,
      })),
    };
  });
  // what's on now in each room (the room player's live state; the page falls back to the schedule)
  route("GET", "/api/public/:pt/now", async (req, p) => {
    const e = eventByPublic(p.pt);
    return {
      event: { name: e.name, date: e.date },
      sign: e.sign_ext ? { kind: SIGN_TYPES()[e.sign_ext][0], url: `/api/public/${p.pt}/sign-background?v=${signStamp(e)}` } : null,
      rooms: q("SELECT * FROM rooms WHERE event_id = ? ORDER BY id", e.id).map(r => {
        const h = hubs.get(r.id);
        return {
          id: r.id, name: r.name,
          liveTalkId: h?.players.size && h.state?.live?.talkId ? h.state.live.talkId : null,
          talks: q("SELECT * FROM talks WHERE room_id = ? ORDER BY starts_at, id", r.id).map(t => ({
            id: t.id, kind: t.kind, title: t.title, speaker: t.speaker, startsAt: t.starts_at, durationMin: t.duration_min,
            moderator: t.moderator, panelists: JSON.parse(t.panelists || "[]"),
          })),
        };
      }),
    };
  });
  route("GET", "/api/public/:pt/sign-background", async (req, p) => {
    const e = eventByPublic(p.pt);
    if (!e.sign_ext) notFound("Pozadí není.");
    return { file: signFile(e), type: SIGN_TYPES()[e.sign_ext][1] };
  });
  route("GET", "/api/public/:pt/talks/:id/pdf", async (req, p) => {
    const e = eventByPublic(p.pt);
    const t = one("SELECT * FROM talks WHERE id = ? AND event_id = ?", +p.id, e.id);
    if (!t || !t.share_slides || !t.version || !t.has_pdf) notFound("Slidy nejsou veřejné.");
    return { file: filePaths(t).pdf, type: "application/pdf" };
  });

  // ---------- pages ----------

  const pages = [
    [/^\/$/, landing ? "index.html" : "nova-akce.html"],
    [/^\/nova-akce$/, "nova-akce.html"],
    [/^\/napoveda$/, "napoveda.html"],
    [/^\/q\/[^/]+$/, "qa.html"],
    [/^\/en\/?$/, "en/index.html"],
    [/^\/en\/help$/, "en/help.html"],
    [/^\/cookies$/, "cookies.html"],
    [/^\/en\/cookies$/, "en/cookies.html"],
    [/^\/e\/[^/]+$/, "admin.html"],
    [/^\/s\/[^/]+$/, "speaker.html"],
    [/^\/r\/[^/]+$/, "remote.html"],
    [/^\/a\/[^/]+$/, "public.html"],
    [/^\/a\/[^/]+\/sal\/\d+$/, "sign.html"],
  ];
  // web player (shares its screens with the desktop app)
  const playerPages = [
    [/^\/p\/[^/]+$/, "web-control.html"],
    [/^\/p\/[^/]+\/projection$/, "web-projection.html"],
    [/^\/p\/[^/]+\/presenter$/, "web-presenter.html"],
  ];

  // ---------- search engines and AI assistants ----------

  // public, indexable pages (only on the product site; a self-hosted instance stays out of search)
  // a test server (SEARCH_INDEX=off) or a self-hosted one stays out of search engines completely
  const PUBLIC = landing && indexable ? ["/", "/en", "/napoveda", "/en/help", "/nova-akce", "/cookies", "/en/cookies"] : [];
  const siteUrl = req => (publicUrl || originOf(req)).replace(/\/$/, "");
  const ALT = { "/": ["/", "/en"], "/en": ["/", "/en"], "/napoveda": ["/napoveda", "/en/help"], "/en/help": ["/napoveda", "/en/help"], "/cookies": ["/cookies", "/en/cookies"], "/en/cookies": ["/cookies", "/en/cookies"] };
  route("GET", "/robots.txt", async (req, p, url, res) => {
    const site = siteUrl(req);
    const txt = landing && indexable
      ? `# fckscrn: the product pages are public, event links are private
User-agent: *
Allow: /
Disallow: /e/
Disallow: /s/
Disallow: /p/
Disallow: /q/
Disallow: /r/
Disallow: /api/
Disallow: /mcp

Sitemap: ${site}/sitemap.xml
`
      : "User-agent: *\nDisallow: /\n";
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(txt);
    return { handled: true };
  });
  route("GET", "/sitemap.xml", async (req, p, url, res) => {
    if (!landing) notFound("Nenalezeno.");
    const site = siteUrl(req);
    const entry = u => `  <url><loc>${site}${u}</loc>${(ALT[u] || []).map((a, i) => `<xhtml:link rel="alternate" hreflang="${i ? "en" : "cs"}" href="${site}${a}"/>`).join("")}</url>`;
    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${PUBLIC.map(entry).join("\n")}\n</urlset>\n`);
    return { handled: true };
  });
  // llms.txt: a plain summary for AI assistants (llmstxt.org)
  route("GET", "/llms.txt", async (req, p, url, res) => {
    if (!landing) notFound("Nenalezeno.");
    const txt = (await fsp.readFile(path.join(publicDir, "llms.txt"), "utf8")).replaceAll("%ORIGIN%", siteUrl(req));
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(txt);
    return { handled: true };
  });

  // the public event page carries its own title and Event data for search engines
  function publicPageHead(html, pathname, site) {
    const e = one("SELECT * FROM events WHERE public_token = ? AND public_enabled = 1", pathname.slice(3));
    const attr = v => String(v).replace(/[&"<>]/g, c => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" }[c]));
    if (!e) return html.replaceAll("%TITLE%", "FckScrn").replaceAll("%DESC%", "").replaceAll("%PATH%", pathname).replace("%LD%", '<meta name="robots" content="noindex">');
    const talks = talksOf(e.id).filter(t => t.kind !== "break");
    const desc = `Program${e.date ? ` (${e.date})` : ""}${e.place ? `, ${e.place}` : ""}: ${talks.slice(0, 4).map(t => t.title).join(", ")}${talks.length > 4 ? "…" : ""}`;
    const ld = {
      "@context": "https://schema.org", "@type": "Event", name: e.name, url: `${site}${pathname}`,
      ...(e.date ? { startDate: e.date } : {}),
      ...(e.place ? { location: { "@type": "Place", name: e.place, address: e.place } } : {}),
      subEvent: talks.map(t => ({ "@type": "Event", name: t.title, ...(t.speaker ? { performer: { "@type": "Person", name: t.speaker } } : {}),
        ...(e.date && t.starts_at ? { startDate: `${e.date}T${t.starts_at}` } : {}) })),
    };
    return html.replaceAll("%TITLE%", attr(`${e.name} · program a slidy`)).replaceAll("%DESC%", attr(desc.slice(0, 300))).replaceAll("%PATH%", pathname)
      .replace("%LD%", `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`);
  }

  // Google Tag Manager only on the product pages of the hosted site (GTM_ID), never on event links,
  // and with Consent Mode: nothing is stored until the visitor allows it in the cookie bar
  const GTM = gtmId && landing && indexable && /^GTM-[A-Z0-9]+$/.test(gtmId) ? gtmId : null;
  function analytics(html) {
    if (!GTM) return html.replace("<!--analytics-head-->", "").replace("<!--analytics-body-->", "");
    return html
      .replace("<!--analytics-head-->", `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
  gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:"denied",wait_for_update:500});
  try{if(localStorage.getItem("fckscrn-consent")==="yes")gtag("consent","update",{analytics_storage:"granted",ad_storage:"granted",ad_user_data:"granted",ad_personalization:"granted"})}catch(e){}</script>
  <!-- Google Tag Manager -->
  <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM}');</script>
  <!-- End Google Tag Manager -->`)
      .replace("<!--analytics-body-->", `<!-- Google Tag Manager (noscript) -->
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${GTM}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
  <!-- End Google Tag Manager (noscript) -->
  <script src="/assets/consent.js" defer></script>`);
  }

  async function serveStatic(req, res, pathname) {
    let file = pages.find(([re]) => re.test(pathname))?.[1];
    let root = publicDir;
    if (!file && pathname === "/sw.js") file = "sw.js";
    if (!file && pathname === "/favicon.ico") file = "assets/logo/favicon-48.png";
    if (!file && pathname === "/apple-touch-icon.png") file = "assets/logo/apple-touch-icon.png";
    if (!file && pathname === "/site.webmanifest") file = "site.webmanifest";
    if (!file && playerDir) {
      file = playerPages.find(([re]) => re.test(pathname))?.[1];
      if (!file && pathname.startsWith("/player/")) file = pathname.slice("/player/".length);
      if (file) root = playerDir;
    }
    if (!file && pathname.startsWith("/assets/")) file = pathname.slice(1);
    if (!file && pathname.startsWith("/vendor/pdfjs/")) { root = PDFJS_DIR; file = pathname.slice("/vendor/pdfjs/".length); }
    if (!file) return false;
    const full = path.join(root, path.normalize(file));
    if (!full.startsWith(root + path.sep)) return false;
    try {
      let data = await fsp.readFile(full);
      // absolute URLs (canonical, hreflang, og:image) need the public address
      if (full.endsWith(".html") && root === publicDir) data = data.toString("utf8").replaceAll("%ORIGIN%", siteUrl(req));
      if (file === "public.html") data = publicPageHead(data, pathname, siteUrl(req));
      if (typeof data === "string") data = analytics(data);
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(data);
      return true;
    } catch { return false; }
  }

  async function sendFile(req, res, { file, type, download }) {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) return sendJson(res, 404, { error: "Soubor chybí." });
    const headers = { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:", "X-Content-Type-Options": "nosniff" };
    if (download) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
    // byte ranges: Safari (iPad door signs, iPhones) only plays video this way; also lets big files resume
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? +m[1] : Math.max(0, stat.size - +m[2]);
      let end = m[1] && m[2] ? Math.min(+m[2], stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}` });
      if (req.method === "HEAD") return res.end();
      return pipeline(fs.createReadStream(file, { start, end }), res);
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    await pipeline(fs.createReadStream(file), res);
  }

  // ---------- handler ----------

  handle.purgeExpired = purgeExpired;
  handle.checkPayments = checkPayments;
  return handle;

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    // event links are secret: keep them (and everything that isn't a product page) out of search results
    const publicEvent = landing && indexable && /^\/a\/[^/]+$/.test(url.pathname) && !!one("SELECT 1 FROM events WHERE public_token = ? AND public_enabled = 1", url.pathname.slice(3));
    if (!publicEvent && !PUBLIC.includes(url.pathname.replace(/(.)\/$/, "$1")) && !/^\/(assets|vendor)\/|^\/(robots\.txt|sitemap\.xml|llms\.txt)$/.test(url.pathname)) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
    try {
      for (const r of routes) {
        if (r.method !== req.method && !(req.method === "HEAD" && r.method === "GET")) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        const out = await r.handler(req, params, url, res);
        if (out && out.handled) return;
        if (out && out.file) return await sendFile(req, res, out);
        const [status, data] = Array.isArray(out) ? out : [200, out];
        return sendJson(res, status, data);
      }
      if (req.method === "GET" && await serveStatic(req, res, url.pathname)) return;
      // a person who mistyped a link gets a page, not JSON
      if (req.method === "GET" && !url.pathname.startsWith("/api/") && /text\/html/.test(req.headers.accept || "")) {
        const html = analytics((await fsp.readFile(path.join(publicDir, "404.html"), "utf8")).replaceAll("%ORIGIN%", siteUrl(req)));
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(html);
      }
      sendJson(res, 404, { error: "Nenalezeno." });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) sendJson(res, e.status || 500, e instanceof HttpError ? { error: e.message, ...(e.code ? { code: e.code } : {}) } : { error: "Chyba serveru. Zkuste to znovu.", code: "server" });
      else res.destroy();
    }
  };
}

// ---------- utils ----------

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 100_000) throw new HttpError(413, "Požadavek je moc velký."); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "Neplatný JSON."); }
}

function str(v, label, required = false) {
  const s = v == null ? "" : String(v).trim().slice(0, 300);
  if (required && !s) badRequest(`${label} je povinný údaj.`);
  return s || null;
}

function time(v) {
  if (!v) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) badRequest("Čas zadejte ve tvaru HH:MM.");
  return v;
}

function duration(v) {
  const n = Math.round(+v || 20);
  if (n < 1 || n > 600) badRequest("Délka musí být 1 až 600 minut.");
  return n;
}

// list of names (panelists): trimmed, no empties, sane limits
function names(v) {
  const list = Array.isArray(v) ? v : String(v || "").split(/\n|,/);
  return list.map(x => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 12);
}

function notFound(msg) { throw new HttpError(404, msg); }
function badRequest(msg) { throw new HttpError(400, msg); }
