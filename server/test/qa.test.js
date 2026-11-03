import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { samplePdf } from "./helpers.js";

let server, base, dataDir;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-qa-"));
  server = http.createServer(createApp({ dataDir, publicDir: path.resolve("public") }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const api = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, { method, headers: Buffer.isBuffer(body) ? headers : { "Content-Type": "application/json", ...headers }, body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, type, data: type.includes("json") ? await res.json() : await res.text() };
};

async function setup() {
  const { adminToken } = (await api("POST", "/api/events", { name: "QA Day", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  const room = (await api("GET", admin)).data.rooms[0];
  return { admin, room };
}

test("panel: topic, moderator, panelists one by one, default title, background", async () => {
  const { admin, room } = await setup();
  let v = (await api("POST", `${admin}/talks`, { kind: "panel", roomId: room.id, startsAt: "11:00", durationMin: 40, moderator: "Lucie Malá", panelists: ["Jana", " ", "Martin", "Petra"] })).data;
  let p = v.talks[0];
  assert.deepEqual([p.kind, p.title, p.moderator, p.panelists], ["panel", "Panelová diskuse", "Lucie Malá", ["Jana", "Martin", "Petra"]]);
  v = (await api("PATCH", `${admin}/talks/${p.id}`, { title: "Budoucnost B2B", panelists: ["Jana", "Martin", "Petra", "Ondřej"] })).data;
  p = v.talks[0];
  assert.deepEqual([p.title, p.panelists.length], ["Budoucnost B2B", 4]);

  assert.equal((await api("PUT", `${admin}/talks/${p.id}/background?name=bg.pdf`, Buffer.from("x"))).status, 400);
  v = (await api("PUT", `${admin}/talks/${p.id}/background?name=bg.mp4`, Buffer.from("video"))).data;
  assert.equal(v.talks[0].background, "video");
  const man = (await api("GET", `/api/player/${room.playerToken}`)).data.talks[0];
  assert.match(man.files.background, /\/background\?v=/);
  assert.equal((await fetch(base + man.files.background)).headers.get("content-type"), "video/mp4");
  v = (await api("DELETE", `${admin}/talks/${p.id}/background`)).data;
  assert.equal(v.talks[0].background, null);
});

test("Q&A: ask (named / anonymous), vote once per person, answer, hide, QR in the manifest", async () => {
  const { admin, room } = await setup();
  let v = (await api("POST", `${admin}/talks`, { roomId: room.id, title: "Talk", speaker: "Jana" })).data;
  const talk = v.talks[0];
  const qa = `/api/qa/${talk.qaToken}`;

  let r = await api("GET", qa);
  assert.deepEqual([r.data.talk.title, r.data.talk.open, r.data.questions.length], ["Talk", true, 0]);
  assert.equal((await api("POST", `${qa}/questions`, { text: " " })).status, 400);
  await api("POST", `${qa}/questions`, { text: "První dotaz?", author: "Karel" });
  await api("POST", `${qa}/questions`, { text: "Anonymní dotaz?" });
  r = await api("GET", qa);
  const [a, b] = r.data.questions;
  assert.deepEqual([a.author, b.author], ["Karel", null]);

  // votes: second question gets two votes and moves up; same voter toggles
  await api("POST", `${qa}/questions/${b.id}/vote`, { voter: "voter-aaaaaaaa" });
  await api("POST", `${qa}/questions/${b.id}/vote`, { voter: "voter-bbbbbbbb" });
  await api("POST", `${qa}/questions/${a.id}/vote`, { voter: "voter-aaaaaaaa" });
  r = await api("POST", `${qa}/questions/${a.id}/vote`, { voter: "voter-aaaaaaaa" });
  assert.equal(r.data.voted, false, "second click takes the vote back");
  assert.deepEqual(r.data.questions.map(x => [x.id, x.votes]), [[b.id, 2], [a.id, 0]]);
  assert.deepEqual((await api("GET", `${qa}?voter=voter-aaaaaaaa`)).data.voted, [b.id]);

  // speaker ticks one off → answered go to the end
  r = await api("PATCH", `/api/speaker/${talk.speakerToken}/questions/${b.id}`, { answered: true });
  assert.deepEqual(r.data.questions.map(x => [x.id, x.answered]), [[a.id, false], [b.id, true]]);
  // organizer hides one → gone for the audience, still visible to the organizer
  await api("PATCH", `${admin}/questions/${a.id}`, { hidden: true });
  assert.equal((await api("GET", qa)).data.questions.length, 1);
  assert.equal((await api("GET", `${admin}/talks/${talk.id}/questions`)).data.questions.length, 2);

  // room: polling + technician answer
  const pq = (await api("GET", `/api/player/${room.playerToken}/questions`)).data.questions;
  assert.equal(pq[talk.id].length, 1);
  assert.equal((await api("PATCH", `/api/player/${room.playerToken}/questions/${b.id}`, { answered: false })).status, 200);

  const man = (await api("GET", `/api/player/${room.playerToken}`)).data.talks[0];
  assert.match(man.qaUrl, new RegExp(`/q/${talk.qaToken}$`));
  assert.match(man.qaQr, /^<svg/);
  const svg = await api("GET", `${qa}/qr.svg`);
  assert.match(svg.type, /svg/);

  // switched off → no new questions
  await api("PATCH", `${admin}/talks/${talk.id}`, { qaEnabled: false });
  assert.equal((await api("POST", `${qa}/questions`, { text: "Ještě?" })).status, 403);
  // audience page is served
  assert.match((await api("GET", `/q/${talk.qaToken}`)).type, /html/);
});

test("Q&A rate limit stops floods", async () => {
  const { admin, room } = await setup();
  const talk = (await api("POST", `${admin}/talks`, { roomId: room.id, title: "Flood" })).data.talks[0];
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await api("POST", `/api/qa/${talk.qaToken}/questions`, { text: `Dotaz ${i}` })).status);
  assert.deepEqual(statuses.slice(0, 6), [201, 201, 201, 201, 201, 201]);
  assert.equal(statuses[7], 429);
});

test("speaker notes typed by hand: per slide, kept across a new upload without notes", async () => {
  const { admin, room } = await setup();
  const talk = (await api("POST", `${admin}/talks`, { roomId: room.id, title: "Keynote talk" })).data.talks[0];
  const sp = `/api/speaker/${talk.speakerToken}`;
  assert.equal((await api("PUT", `${sp}/notes`, { notes: ["x"] })).status, 409, "nothing uploaded yet");
  const pdf = samplePdf;
  await api("PUT", `${sp}/file?name=talk.pdf`, pdf);
  const pages = (await api("GET", sp)).data.talk.pageCount;
  let r = await api("PUT", `${sp}/notes`, { notes: ["Úvod", "Pozdravit sál\r\n", "navíc", "x"] });
  assert.equal(r.status, 200);
  assert.equal(r.data.notes.length, pages);
  assert.deepEqual(r.data.notes, ["Úvod", "Pozdravit sál"], "one note per slide, extras dropped");
  // the room gets them
  const man = (await api("GET", `/api/player/${room.playerToken}`)).data.talks[0];
  assert.equal(man.notes[0], "Úvod");
  // a new PDF has no notes of its own → the typed ones stay, with a hint to check them
  await api("PUT", `${sp}/file?name=talk-v2.pdf`, pdf);
  const t2 = (await api("GET", sp)).data.talk;
  assert.equal(t2.notes[1], "Pozdravit sál");
  assert.ok(t2.issues.some(i => i.code === "notes_kept"));
  // the organizer can edit them too
  const v = (await api("PUT", `${admin}/talks/${talk.id}/notes`, { notes: ["Od organizátora"] })).data;
  assert.ok(v.talks);
  assert.equal((await api("GET", sp)).data.talk.notes[0], "Od organizátora");
});
