import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { pptxInfo, pdfInfo, pdfFileInfo } from "../src/analyze.js";
import { samplePptx, samplePdf } from "./helpers.js";
import { readZip } from "../src/zip.js";

let server, base, dataDir, app;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-test-"));
  app = createApp({ dataDir, publicDir: path.resolve("public"), playerDir: path.resolve("../player/renderer"), soffice: null });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const api = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, {
    method, headers: body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json", ...headers } : headers,
    body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, data: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

test("pptxInfo reads ratio, notes in slide order, skips hidden slides, finds video", () => {
  const info = pptxInfo(samplePptx());
  assert.equal(info.ratio.toFixed(3), (4 / 3).toFixed(3));
  assert.deepEqual(info.notes, ["Pozdravit sál\nŘíct, kdo jsem & proč", "Díky"]);
  assert.deepEqual(info.videos, ["ppt/media/media1.mp4"]);
});

test("pptxInfo and pdfFileInfo work straight from disk (big files never load whole)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-file-"));
  const f = path.join(dir, "talk.pptx");
  fs.writeFileSync(f, samplePptx());
  assert.deepEqual(pptxInfo(f).notes, pptxInfo(samplePptx()).notes);
  const p = path.join(dir, "talk.pdf");
  fs.writeFileSync(p, samplePdf);
  assert.deepEqual(await pdfFileInfo(p), pdfInfo(samplePdf));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pdfInfo reads page count and ratio", () => {
  const info = pdfInfo(samplePdf);
  assert.equal(info.pageCount, 2);
  assert.equal(info.ratio.toFixed(3), (16 / 9).toFixed(3));
});

test("full flow: event → room → talk → speaker upload → player manifest", async () => {
  const created = await api("POST", "/api/events", { name: "Test Day", date: "2026-11-14", place: "Brno" });
  assert.equal(created.status, 201);
  const admin = `/api/admin/${created.data.adminToken}`;

  let view = (await api("GET", admin)).data;
  assert.equal(view.rooms.length, 2, "multi-room event without names gets Sál A + Sál B");
  const room = view.rooms[0];
  assert.equal(room.playerOnline, false);
  assert.equal(view.event.mode, "multi");

  view = (await api("POST", `${admin}/talks`, { roomId: room.id, startsAt: "09:30", durationMin: 25, title: "Úvod", speaker: "Jana" })).data;
  view = (await api("POST", `${admin}/talks`, { roomId: room.id, startsAt: "10:00", title: "PDF talk" })).data;
  const [talk, pdfTalk] = view.talks;
  assert.equal(talk.status, "missing");

  // validation
  assert.equal((await api("POST", `${admin}/talks`, { title: "" })).status, 400);
  assert.equal((await api("POST", `${admin}/talks`, { title: "x", startsAt: "25:00" })).status, 400);

  // speaker sees their talk
  const spk = await api("GET", `/api/speaker/${talk.speakerToken}`);
  assert.equal(spk.data.talk.title, "Úvod");
  assert.equal(spk.data.room, "Sál A");
  assert.equal(spk.data.talk.speakerToken, undefined, "speaker view must not leak tokens");

  // wrong format
  const bad = await api("PUT", `/api/speaker/${talk.speakerToken}/file?name=talk.docx`, Buffer.from("x"));
  assert.deepEqual([bad.status, bad.data.code], [400, "format"]);

  // pptx without converter → warning, notes stored, no pdf
  const up = await api("PUT", `/api/speaker/${talk.speakerToken}/file?name=${encodeURIComponent("můj talk.pptx")}`, samplePptx());
  assert.equal(up.status, 200);
  assert.equal(up.data.status, "warning");
  assert.equal(up.data.version, 1);
  assert.equal(up.data.hasPdf, false);
  assert.ok(up.data.issues.some(i => /video/i.test(i.text) && i.code === "video" && i.n === 1));
  assert.ok(up.data.issues.some(i => i.code === "ratio" && i.ratio === "4:3"));
  assert.ok(up.data.issues.some(i => /4:3/.test(i.text)));

  // pdf upload → ready
  const up2 = await api("PUT", `/api/speaker/${pdfTalk.speakerToken}/file?name=slides.pdf`, samplePdf);
  assert.equal(up2.data.status, "ready");
  assert.equal(up2.data.pageCount, 2);

  // re-upload replaces the old version on disk
  await api("PUT", `/api/speaker/${pdfTalk.speakerToken}/file?name=slides2.pdf`, samplePdf);
  const dirs = fs.readdirSync(path.join(dataDir, "files", `talk-${pdfTalk.id}`));
  assert.deepEqual(dirs, ["v2"]);

  // player manifest
  const man = await api("GET", `/api/player/${room.playerToken}`);
  assert.equal(man.data.room.name, "Sál A");
  assert.equal(man.data.talks.length, 2);
  const [m1, m2] = man.data.talks;
  assert.deepEqual(m1.notes, ["Pozdravit sál\nŘíct, kdo jsem & proč", "Díky"]);
  assert.ok(!m1.files.pdf && m1.files.original);
  assert.ok(m2.files.pdf);
  const pdf = await api("GET", m2.files.pdf);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
  const orig = await fetch(base + m1.files.original);
  assert.match(orig.headers.get("content-disposition"), /m%C5%AFj%20talk\.pptx/);

  // player is now online for the organizer
  view = (await api("GET", admin)).data;
  assert.equal(view.rooms[0].playerOnline, true);

  // other room's player cannot read this talk
  view = (await api("POST", `${admin}/rooms`, { name: "Sál B" })).data;
  const other = view.rooms[1];
  assert.equal((await api("GET", `/api/player/${other.playerToken}/talks/${pdfTalk.id}/pdf`)).status, 404);

  // delete talk removes files
  await api("DELETE", `${admin}/talks/${pdfTalk.id}`);
  assert.equal(fs.existsSync(path.join(dataDir, "files", `talk-${pdfTalk.id}`)), false);
});

test("breaks and partner loop", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Loop Day" })).data;
  const admin = `/api/admin/${adminToken}`;
  let view = (await api("POST", `${admin}/rooms`, { name: "Sál B" })).data;
  const [roomA, roomB] = view.rooms;

  // a break needs no title or speaker and has no upload link
  view = (await api("POST", `${admin}/talks`, { roomId: roomA.id, kind: "break", startsAt: "10:30", durationMin: 15 })).data;
  const brk = view.talks[0];
  assert.equal(brk.kind, "break");
  assert.equal(brk.title, "Přestávka");
  assert.equal((await api("GET", `/api/speaker/${brk.speakerToken}`)).status, 404);

  // upload: one image for all rooms, one video only for room B
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  assert.equal((await api("PUT", `${admin}/media?name=logo.png`, png)).status, 201);
  view = (await api("PUT", `${admin}/media?name=promo.mp4&roomId=${roomB.id}`, Buffer.from("video"))).data;
  assert.equal((await api("PUT", `${admin}/media?name=deck.pdf`, png)).status, 400);
  const [img, vid] = view.media;
  assert.deepEqual([img.kind, img.roomId, vid.kind, vid.roomId], ["image", null, "video", roomB.id]);

  // reorder and change duration
  view = (await api("PATCH", `${admin}/media/${vid.id}`, { move: -1 })).data;
  assert.deepEqual(view.media.map(m => m.id), [vid.id, img.id]);
  view = (await api("PATCH", `${admin}/media/${img.id}`, { durationSec: 12 })).data;
  assert.equal(view.media.find(m => m.id === img.id).durationSec, 12);
  assert.equal((await api("PATCH", `${admin}/media/${img.id}`, { durationSec: 1 })).status, 400);

  // room A sees only the shared image, room B sees both in order
  const loopA = (await api("GET", `/api/player/${roomA.playerToken}`)).data.loop;
  const loopB = (await api("GET", `/api/player/${roomB.playerToken}`)).data.loop;
  assert.deepEqual(loopA.map(m => m.fileName), ["logo.png"]);
  assert.deepEqual(loopB.map(m => m.fileName), ["promo.mp4", "logo.png"]);
  const file = await fetch(base + loopB[0].url);
  assert.equal(file.headers.get("content-type"), "video/mp4");
  assert.equal((await api("GET", `/api/player/${roomA.playerToken}/media/${vid.id}`)).status, 404);

  // delete removes the file
  view = (await api("DELETE", `${admin}/media/${vid.id}`)).data;
  assert.equal(view.media.length, 1);
  assert.equal(fs.existsSync(path.join(dataDir, "files", "media", `${vid.id}.mp4`)), false);
});

test("unknown tokens give 404 with a readable message", async () => {
  const r = await api("GET", "/api/speaker/nope");
  assert.equal(r.status, 404);
  assert.match(r.data.error, /neplatí/);
  assert.equal(r.data.code, "speaker_link");
});

test("organizer preview: notes, pdf and original download, pdf.js served", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Preview" })).data;
  const admin = `/api/admin/${adminToken}`;
  let view = (await api("GET", admin)).data;
  view = (await api("POST", `${admin}/talks`, { roomId: view.rooms[0].id, title: "Talk" })).data;
  const t = view.talks[0];
  assert.equal((await api("GET", `${admin}/talks/${t.id}/pdf`)).status, 404, "nothing uploaded yet");
  await api("PUT", `/api/speaker/${t.speakerToken}/file?name=talk.pptx`, samplePptx());
  const prev = (await api("GET", `${admin}/talks/${t.id}/preview`)).data;
  assert.equal(prev.notes[1], "Díky");
  assert.equal(prev.pdfUrl, null, "no converter in tests");
  assert.equal((await api("GET", prev.originalUrl)).status, 200);
  const spk = (await api("GET", `/api/speaker/${t.speakerToken}`)).data;
  assert.equal(spk.talk.notes.length, 2);
  // another event's token can't read it
  const other = (await api("POST", "/api/events", { name: "Other" })).data.adminToken;
  assert.equal((await api("GET", `/api/admin/${other}/talks/${t.id}/preview`)).status, 404);
  const lib = await fetch(`${base}/vendor/pdfjs/pdf.mjs`);
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(`${base}/vendor/pdfjs/../package.json`)).status, 404);
});

test("web player pages, assets and service worker are served", async () => {
  for (const [url, type] of [["/p/abc", /html/], ["/p/abc/projection", /html/], ["/p/abc/presenter", /html/], ["/player/control.js", /javascript/], ["/player/roles.mjs", /javascript/], ["/sw.js", /javascript/]]) {
    const r = await fetch(base + url);
    assert.equal(r.status, 200, url);
    assert.match(r.headers.get("content-type"), type, url);
  }
  assert.equal((await fetch(base + "/player/../src/main.js")).status, 404);
});

test("onboarding: single-room and named multi-room events", async () => {
  const single = (await api("POST", "/api/events", { name: "Meetup", mode: "single" })).data;
  let v = (await api("GET", `/api/admin/${single.adminToken}`)).data;
  assert.equal(v.event.mode, "single");
  assert.deepEqual(v.rooms.map(r => r.name), ["Sál"]);
  const multi = (await api("POST", "/api/events", { name: "Konf", mode: "multi", rooms: ["Velký sál", " ", "Workshop", "Velký sál"] })).data;
  v = (await api("GET", `/api/admin/${multi.adminToken}`)).data;
  assert.deepEqual(v.rooms.map(r => r.name), ["Velký sál", "Workshop"]);
  v = (await api("PATCH", `/api/admin/${single.adminToken}`, { mode: "multi" })).data;
  assert.equal(v.event.mode, "multi");
});

test("lifetime: expiry date, export ZIP, purge and delete", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Old Conf", date: "2026-11-14", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  let v = (await api("GET", admin)).data;
  assert.equal(v.event.expiresAt, "2026-11-28", "14 days after the event");
  v = (await api("POST", `${admin}/talks`, { roomId: v.rooms[0].id, startsAt: "09:00", title: "Talk / one", speaker: "Jana" })).data;
  await api("PUT", `/api/speaker/${v.talks[0].speakerToken}/file?name=slides.pptx`, samplePptx());
  await api("POST", `${admin}/talks`, { roomId: v.rooms[0].id, kind: "break", startsAt: "09:20" });
  await api("PUT", `${admin}/media?name=logo.png`, Buffer.from("89504e47", "hex"));

  const res = await fetch(base + `${admin}/export`);
  assert.equal(res.headers.get("content-type"), "application/zip");
  const zip = readZip(Buffer.from(await res.arrayBuffer()));
  const names = [...zip.keys()];
  assert.ok(names.includes("program.csv") && names.includes("program.json") && names.includes("poznamky-recniku.txt"), names.join());
  assert.ok(names.includes("prezentace/Sál/09-00 Talk - one - Jana.pptx"), names.join());
  assert.ok(names.includes("smycka-partneru/01 logo.png"));
  assert.match(zip.get("program.csv")().toString(), /Přestávka/);
  assert.deepEqual(zip.get("prezentace/Sál/09-00 Talk - one - Jana.pptx")(), samplePptx());

  // not expired yet, then expired
  assert.equal(await app.purgeExpired("2026-11-27"), 0);
  assert.ok(await app.purgeExpired("2026-11-28") >= 1);
  assert.equal((await api("GET", admin)).status, 404);
  assert.equal(fs.existsSync(path.join(dataDir, "files", `talk-${v.talks[0].id}`)), false);

  // delete now
  const other = (await api("POST", "/api/events", { name: "Bye" })).data.adminToken;
  assert.equal((await api("DELETE", `/api/admin/${other}`)).status, 200);
  assert.equal((await api("GET", `/api/admin/${other}`)).status, 404);
});

test("hosted MCP over HTTP with the admin token, and link rotation", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "MCP Day", mode: "single" })).data;
  const mcp = async (msg, token = adminToken) => {
    const r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(msg) });
    return { status: r.status, data: r.status === 200 ? await r.json() : null };
  };
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.data.result.serverInfo.name, "fckscrn");
  assert.equal((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const add = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_talk", arguments: { title: "Úvod", speaker: "Jana", starts_at: "18:00" } } });
  assert.match(add.data.result.content[0].text, /Přidáno: 18:00 Úvod/);
  assert.match(add.data.result.content[0].text, new RegExp(`${base}/s/`), "links use the public address");
  const noKey = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_program", arguments: {} } }, null);
  assert.equal(noKey.data.result.isError, true);
  assert.equal((await fetch(base + "/mcp")).status, 405);
  // key in the address (connectors that only take a URL), and a JSON-RPC batch answers with an array
  const viaUrl = await fetch(`${base}/mcp/${adminToken}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 5, method: "tools/list" }, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_program", arguments: {} } }]) });
  assert.equal(viaUrl.status, 200);
  const batch = await viaUrl.json();
  assert.equal(batch.length, 2);
  assert.match(batch[1].result.content[0].text, /Úvod/);

  // rotate: old link (and MCP key) stops working
  const { adminToken: fresh } = (await api("POST", `/api/admin/${adminToken}/rotate`)).data;
  assert.equal((await api("GET", `/api/admin/${adminToken}`)).status, 404);
  assert.equal((await api("GET", `/api/admin/${fresh}`)).data.talks.length, 1);
  const old = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_program", arguments: {} } });
  assert.equal(old.data.result.isError, true);
});

test("organizer signs off warnings; a new upload reopens the check", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Review", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  let v = (await api("POST", `${admin}/talks`, { roomId: (await api("GET", admin)).data.rooms[0].id, title: "T" })).data;
  const t = v.talks[0];
  await api("PUT", `/api/speaker/${t.speakerToken}/file?name=a.pptx`, samplePptx()); // 4:3 + video = warnings
  v = (await api("GET", admin)).data;
  assert.equal(v.talks[0].status, "warning");
  assert.ok(v.talks[0].issues.some(i => i.code === "no_converter" && i.level === "info"), "missing converter is only info");
  v = (await api("PATCH", `${admin}/talks/${t.id}`, { reviewed: true })).data;
  assert.deepEqual([v.talks[0].status, v.talks[0].reviewed], ["ready", true]);
  await api("PUT", `/api/speaker/${t.speakerToken}/file?name=b.pptx`, samplePptx());
  v = (await api("GET", admin)).data;
  assert.deepEqual([v.talks[0].status, v.talks[0].reviewed], ["warning", false]);
});

test("a speaker's new version always needs the organizer's look again", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Versions", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  let v = (await api("POST", `${admin}/talks`, { roomId: (await api("GET", admin)).data.rooms[0].id, title: "T" })).data;
  const t = v.talks[0];
  await api("PUT", `/api/speaker/${t.speakerToken}/file?name=a.pdf`, samplePdf);
  assert.equal((await api("GET", admin)).data.talks[0].status, "ready", "first clean upload is fine");
  await api("PUT", `/api/speaker/${t.speakerToken}/file?name=b.pdf`, samplePdf);
  v = (await api("GET", admin)).data;
  assert.equal(v.talks[0].status, "warning");
  assert.equal(v.talks[0].issues[0].code, "new_version");
  v = (await api("PATCH", `${admin}/talks/${t.id}`, { reviewed: true })).data;
  assert.equal(v.talks[0].status, "ready");
  // organizer's own upload doesn't flag itself
  v = (await api("PUT", `${admin}/talks/${t.id}/file?name=c.pdf`, samplePdf)).data;
  assert.equal(v.talks[0].status, "ready");
});
