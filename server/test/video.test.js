import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { pptxInfo } from "../src/analyze.js";
import { videoPptx, samplePdf } from "./helpers.js";

let server, base, dataDir;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-video-"));
  // stand-in for LibreOffice: writes <name>.pdf into --outdir
  const pdf = path.join(dataDir, "sample.pdf");
  fs.writeFileSync(pdf, samplePdf);
  const soffice = path.join(dataDir, "soffice");
  fs.writeFileSync(soffice, `#!/bin/sh\nwhile [ "$1" != "--outdir" ]; do shift; done\nout="$2"; f=$(basename "$3"); cp "${pdf}" "$out/\${f%.*}.pdf"\n`, { mode: 0o755 });
  server = http.createServer(createApp({ dataDir, publicDir: path.resolve("public"), soffice }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: Buffer.isBuffer(body) ? {} : { "Content-Type": "application/json" }, body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, type, data: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

test("pptxInfo finds videos on slides: position, start, embedded / online / linked / unplayable", () => {
  const v = pptxInfo(videoPptx()).slideVideos;
  assert.deepEqual(v.map(x => [x.i, x.page, x.kind, x.start]), [[0, 1, "file", "auto"], [1, 2, "online", "click"], [2, 2, "missing", "click"], [3, 3, "unsupported", "click"]]);
  assert.deepEqual([v[0].x, v[0].y, v[0].w, v[0].h, v[0].ext, v[0].entry], [0.25, 0.25, 0.5, 0.5, "mp4", "ppt/media/media1.mp4"]);
  assert.deepEqual([v[1].site, v[1].url], ["YouTube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]);
  assert.equal(v[2].name, "demo final.mp4");
  assert.equal(v[3].name, "media2.wmv");
});

test("videos play in PDF mode: embedded ones go to the room, the speaker fills in the rest", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Video", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  let view = (await api("GET", admin)).data;
  const room = view.rooms[0];
  view = (await api("POST", `${admin}/talks`, { roomId: room.id, title: "Demo", speaker: "Jan" })).data;
  const spk = `/api/speaker/${view.talks[0].speakerToken}`;

  const up = (await api("PUT", `${spk}/file?name=demo.pptx`, videoPptx())).data;
  assert.equal(up.hasPdf, true);
  assert.equal(up.status, "warning");
  const codes = up.issues.map(i => i.code);
  assert.ok(!codes.includes("video"), "no more 'run it in PowerPoint'");
  assert.deepEqual(up.issues.filter(i => /^video_/.test(i.code)).map(i => [i.code, i.page ?? null]),
    [["video_ok", null], ["video_online", 2], ["video_missing", 2], ["video_format", 3]]);
  assert.equal(up.videos[0].entry, undefined);

  // the room gets the embedded file
  let man = (await api("GET", `/api/player/${room.playerToken}`)).data;
  let vids = man.talks[0].videos;
  assert.ok(vids[0].url.startsWith("/api/player/"));
  assert.deepEqual([vids[1].kind, vids[1].url], ["online", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]);
  let file = await api("GET", vids[0].url);
  assert.deepEqual([file.status, file.type, file.data.toString()], [200, "video/mp4", "fake mp4 bytes"]);
  assert.equal((await api("GET", `/api/player/${room.playerToken}/talks/${man.talks[0].id}/video/2`)).status, 404);

  // the speaker uploads the missing file; wrong format is refused
  assert.equal((await api("PUT", `${spk}/videos/2?name=demo.avi`, Buffer.from("x"))).data.code, "video_format");
  let t = (await api("PUT", `${spk}/videos/2?name=demo%20final.mp4`, Buffer.from("real video"))).data;
  assert.deepEqual([t.videos[2].kind, t.videos[2].ext, t.videos[2].replaced], ["file", "mp4", true]);
  assert.ok(!t.issues.some(i => i.code === "video_missing"));
  assert.equal(t.issues.find(i => i.code === "video_ok").n, 2);
  // YouTube replaced by a file: offline, no ad; organizer can do it too
  view = (await api("PUT", `${admin}/talks/${t.id}/videos/1?name=clip.webm`, Buffer.from("webm"))).data;
  t = view.talks[0];
  assert.deepEqual([t.videos[1].kind, t.videos[1].url], ["file", undefined]);
  assert.ok(!t.issues.some(i => i.code === "video_online"));

  man = (await api("GET", `/api/player/${room.playerToken}`)).data;
  vids = man.talks[0].videos;
  assert.match(vids[2].url, /\/video\/2\?v=\d{10,}/, "stamp makes the room fetch the new file");
  file = await api("GET", vids[1].url);
  assert.deepEqual([file.type, file.data.toString()], ["video/webm", "webm"]);
  assert.equal((await api("PUT", `${spk}/videos/9?name=x.mp4`, Buffer.from("x"))).status, 404);
});
