// Local copy of a room's presentations. Everything needed to run the day
// lives on disk, so the player keeps working when the venue wifi dies.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

class Library {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.manifest = readJson(path.join(dir, "manifest.json"));
  }

  talkDir(t) { return path.join(this.dir, `talk-${t.id}-v${t.version}`); }
  isComplete(t) { return fs.existsSync(path.join(this.talkDir(t), ".done")); }
  find(id) { return this.manifest?.talks.find(t => t.id === id) || null; }

  pdfPath(id) {
    const t = this.find(id);
    const p = t && path.join(this.talkDir(t), "presentation.pdf");
    return p && fs.existsSync(p) ? p : null;
  }

  originalPath(id) {
    const t = this.find(id);
    const p = t && t.fileExt && path.join(this.talkDir(t), `original.${t.fileExt}`);
    return p && fs.existsSync(p) ? p : null;
  }

  // slide video: video-<i>-<stamp>.<ext> (stamp changes when the speaker uploads a replacement)
  videoName(t, v) { return `video-${v.i}-${String(v.stamp || t.version).replace(/\D/g, "")}.${v.ext}`; }
  videoPath(id, i) {
    const t = this.find(id);
    const v = t?.videos?.find(x => x.i === i && x.kind === "file");
    const p = v && path.join(this.talkDir(t), this.videoName(t, v));
    return p && fs.existsSync(p) ? p : null;
  }

  // panel background: bg/talk-<id>-<stamp>.<ext> (stamp changes when the organizer replaces it)
  bgName(t) {
    const u = t.files?.background;
    if (!u) return null;
    const stamp = (u.match(/[?&]v=([^&]+)/)?.[1] || "0").replace(/[^\w-]/g, "");
    return `talk-${t.id}-${stamp}`;
  }
  bgPath(id) {
    const t = this.find(id);
    const name = t && this.bgName(t);
    if (!name) return null;
    const dir = path.join(this.dir, "bg");
    const f = fs.existsSync(dir) && fs.readdirSync(dir).find(x => x.startsWith(name + "."));
    return f ? path.join(dir, f) : null;
  }

  mediaPath(id) {
    const m = this.manifest?.loop?.find(x => x.id === id);
    const p = m && path.join(this.dir, "media", `${m.id}.${m.ext}`);
    return p && fs.existsSync(p) ? p : null;
  }

  /** Partner loop items that are on disk, in order. */
  loop() {
    return (this.manifest?.loop || []).filter(m => this.mediaPath(m.id)).map(({ url, ...m }) => m);
  }

  talks() {
    return (this.manifest?.talks || []).map(t => ({
      ...t,
      videos: (t.videos || []).map(({ url, ...v }) => ({ ...v, ...(url && v.kind === "online" ? { url } : {}), ready: v.kind === "online" || (v.kind === "file" && !!this.videoPath(t.id, v.i)) })),
      local: { pdf: !!this.pdfPath(t.id), original: !!this.originalPath(t.id), bg: !!this.bgPath(t.id) },
    }));
  }

  /** Fetch the room manifest and download new versions. `keep` = talk ids whose files must not be pruned. */
  async sync(server, token, { onProgress = () => {}, keep = [] } = {}) {
    const res = await fetch(`${server}/api/player/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Server odpověděl ${res.status}`), { status: res.status });

    const todo = body.talks.filter(t => t.version && !this.isComplete(t));
    let done = 0;
    for (const t of todo) {
      onProgress({ done, total: todo.length, title: t.title });
      const dir = this.talkDir(t);
      const tmp = dir + ".part";
      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.mkdir(tmp, { recursive: true });
      if (t.files.pdf) await download(server + t.files.pdf, path.join(tmp, "presentation.pdf"));
      if (t.files.original) await download(server + t.files.original, path.join(tmp, `original.${t.fileExt}`));
      await fsp.writeFile(path.join(tmp, ".done"), new Date().toISOString());
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rename(tmp, dir);
      done++;
    }

    // slide videos: embedded ones come with the version, replacements uploaded later get a new stamp
    const files = body.talks.filter(t => t.version && this.isComplete(t)).map(t => [t, (t.videos || []).filter(v => v.kind === "file" && v.url)]);
    const vtodo = files.flatMap(([t, vs]) => vs.filter(v => !fs.existsSync(path.join(this.talkDir(t), this.videoName(t, v)))).map(v => [t, v]));
    for (const [i, [t, v]] of vtodo.entries()) {
      onProgress({ done: i, total: vtodo.length, title: `${t.title} · video ${i + 1}` });
      const dest = path.join(this.talkDir(t), this.videoName(t, v));
      await download(server + v.url, dest + ".part");
      await fsp.rename(dest + ".part", dest);
      done++;
    }
    for (const [t, vs] of files.filter(([t]) => !keep.includes(t.id))) {
      const wantedVideos = new Set(vs.map(v => this.videoName(t, v)));
      for (const name of await fsp.readdir(this.talkDir(t))) if (name.startsWith("video-") && !wantedVideos.has(name)) await fsp.rm(path.join(this.talkDir(t), name), { force: true });
    }

    // partner loop: files never change in place (a replaced file gets a new id)
    const mediaDir = path.join(this.dir, "media");
    await fsp.mkdir(mediaDir, { recursive: true });
    const loop = body.loop || [];
    const missing = loop.filter(m => !fs.existsSync(path.join(mediaDir, `${m.id}.${m.ext}`)));
    for (const [i, m] of missing.entries()) {
      onProgress({ done: i, total: missing.length, title: m.fileName });
      const dest = path.join(mediaDir, `${m.id}.${m.ext}`);
      await download(server + m.url, dest + ".part");
      await fsp.rename(dest + ".part", dest);
      done++;
    }
    const wantedMedia = new Set(loop.map(m => `${m.id}.${m.ext}`));
    for (const name of await fsp.readdir(mediaDir)) if (!wantedMedia.has(name)) await fsp.rm(path.join(mediaDir, name), { force: true });

    // panel backgrounds
    const bgDir = path.join(this.dir, "bg");
    await fsp.mkdir(bgDir, { recursive: true });
    const wantedBg = new Set();
    for (const t of body.talks.filter(t => t.files?.background)) {
      const name = this.bgName(t);
      const res = await fetch(server + t.files.background, { method: "HEAD" }).catch(() => null);
      const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" })[res?.headers.get("content-type")] || "bin";
      wantedBg.add(`${name}.${ext}`);
      const dest = path.join(bgDir, `${name}.${ext}`);
      if (!fs.existsSync(dest)) { await download(server + t.files.background, dest + ".part"); await fsp.rename(dest + ".part", dest); done++; }
    }
    for (const f of await fsp.readdir(bgDir)) if (!wantedBg.has(f)) await fsp.rm(path.join(bgDir, f), { force: true });

    this.manifest = { ...body, syncedAt: new Date().toISOString() };
    await fsp.writeFile(path.join(this.dir, "manifest.json"), JSON.stringify(this.manifest));

    // drop old versions and deleted talks
    const wanted = new Set(this.manifest.talks.filter(t => t.version).map(t => path.basename(this.talkDir(t))));
    for (const name of await fsp.readdir(this.dir)) {
      if (!name.startsWith("talk-") || wanted.has(name)) continue;
      if (keep.some(id => name.startsWith(`talk-${id}-`))) continue;
      await fsp.rm(path.join(this.dir, name), { recursive: true, force: true });
    }
    return { downloaded: done };
  }

  async clear() {
    this.manifest = null;
    await fsp.rm(this.dir, { recursive: true, force: true });
    await fsp.mkdir(this.dir, { recursive: true });
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stažení selhalo (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Accepts the pairing link from the admin page: https://host/p/<token> */
function parsePairUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const m = u.pathname.match(/^\/p\/([^/]+)\/?$/);
  if (!m || !/^https?:$/.test(u.protocol)) return null;
  return { server: u.origin, token: decodeURIComponent(m[1]) };
}

module.exports = { Library, parsePairUrl };
