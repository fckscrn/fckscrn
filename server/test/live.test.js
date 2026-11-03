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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-live-"));
  server = http.createServer(createApp({ dataDir, publicDir: path.resolve("public") }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: Buffer.isBuffer(body) ? {} : { "Content-Type": "application/json" }, body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, headers: res.headers, data: type.includes("json") ? await res.json() : await res.text() };
};
async function setup() {
  const { adminToken } = (await api("POST", "/api/events", { name: "Live Day", mode: "single", date: "2026-11-20" })).data;
  const admin = `/api/admin/${adminToken}`;
  const room = (await api("GET", admin)).data.rooms[0];
  const talk = (await api("POST", `${admin}/talks`, { roomId: room.id, title: "Talk", speaker: "Jana" })).data.talks[0];
  return { admin, room, talk };
}
// read server-sent events into an array
function listen(url) {
  const got = [], ctrl = new AbortController();
  const ready = fetch(base + url, { signal: ctrl.signal }).then(async res => {
    const dec = new TextDecoder(); let buf = "";
    (async () => { try { for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const d = block.split("\n").find(l => l.startsWith("data: ")); if (d) got.push(JSON.parse(d.slice(6))); }
    } } catch {} })();
    return res;
  });
  return { got, ready, close: () => ctrl.abort() };
}
const wait = (fn, ms = 2000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error("timeout")); } }, 20); });

test("deadline: set, shown to the speaker, cleared, validated", async () => {
  const { admin, talk } = await setup();
  assert.equal((await api("PATCH", admin, { deadline: "zítra" })).status, 400);
  assert.equal((await api("PATCH", admin, { deadline: "2026-11-15" })).data.event.deadline, "2026-11-15");
  assert.equal((await api("GET", `/api/speaker/${talk.speakerToken}`)).data.event.deadline, "2026-11-15");
  assert.equal((await api("PATCH", admin, { deadline: "" })).data.event.deadline, null);
});

test("phone link + organizer message reach the room live; phone clicks drive the player", async () => {
  const { admin, room, talk } = await setup();
  const man = (await api("GET", `/api/player/${room.playerToken}`)).data;
  const remoteToken = man.remote.url.split("/r/")[1];
  assert.match(man.remote.qr, /^<svg/);
  const r = `/api/remote/${remoteToken}`;
  assert.equal((await api("GET", r)).data.talks[0].title, "Talk");
  // nobody in the room yet
  assert.equal((await api("POST", `${r}/cmd`, { cmd: "next" })).status, 409);
  assert.equal((await api("POST", `${admin}/rooms/${room.id}/message`, { text: "5 minut" })).status, 409);

  const phone = listen(`${r}/live`); await phone.ready;
  await wait(() => phone.got.length === 1);
  assert.deepEqual([phone.got[0].connected, phone.got[0].state], [false, null]);
  const player = listen(`/api/player/${room.playerToken}/live`); await player.ready;
  await wait(() => phone.got.at(-1).connected === true);

  // clicker
  assert.equal((await api("POST", `${r}/cmd`, { cmd: "rm -rf" })).status, 400);
  assert.equal((await api("POST", `${r}/cmd`, { cmd: "next" })).data.delivered, 1);
  await wait(() => player.got.some(m => m.cmd === "next"));
  // organizer message
  await api("POST", `${admin}/rooms/${room.id}/message`, { text: "Ještě 5 minut" });
  await wait(() => player.got.some(m => m.cmd === "message" && m.arg.text === "Ještě 5 minut"));
  // player state goes to the phone and to the organizer
  await api("POST", `/api/player/${room.playerToken}/live`, { live: { talkId: talk.id, mode: "pdf", page: 3, pages: 6, startedAt: 1 }, message: { text: "Ještě 5 minut" } });
  await wait(() => phone.got.at(-1).state?.live?.page === 3);
  assert.equal(phone.got.at(-1).state.message.text, "Ještě 5 minut");
  assert.deepEqual((await api("GET", admin)).data.rooms[0].live, { talkId: talk.id, mode: "pdf", page: 3, pages: 6, startedAt: 1, help: null });
  // questions on the screen from the phone, ticked off there, and back again
  assert.equal((await api("POST", `${r}/cmd`, { cmd: "showQuestions" })).data.delivered, 1);
  await wait(() => player.got.some(m => m.cmd === "showQuestions"));
  const qa = (await api("GET", r)).data.talks[0];
  const qt = (await api("GET", `/api/player/${room.playerToken}`)).data.talks.find(x => x.id === qa.id).qaUrl.split("/q/")[1];
  await api("POST", `/api/qa/${qt}/questions`, { text: "Funguje to?" });
  const qid = (await api("GET", `${r}/questions`)).data.questions[talk.id][0].id;
  assert.equal((await api("PATCH", `${r}/questions/${qid}`, { answered: true })).status, 200);
  assert.equal((await api("GET", `${r}/questions`)).data.questions[talk.id][0].answered, true);
  await api("PATCH", `${r}/questions/${qid}`, { answered: false });
  assert.equal((await api("GET", `${r}/questions`)).data.questions[talk.id][0].answered, false);
  // the speaker calls for help from the phone → the room gets it
  assert.equal((await api("POST", `${r}/help`)).data.delivered, 1);
  await wait(() => player.got.some(m => m.cmd === "help"));
  player.close();
  await wait(() => phone.got.at(-1).connected === false);
  phone.close();
});

test("public page: off by default, only shared slides, indexable once on", async () => {
  const { admin, talk } = await setup();
  const sp = `/api/speaker/${talk.speakerToken}`;
  await api("PUT", `${sp}/file?name=talk.pdf`, samplePdf);
  const pub = (await api("GET", admin)).data.event.publicPath;
  const pt = pub.split("/a/")[1];
  assert.equal((await api("GET", `/api/public/${pt}`)).status, 404, "off by default");
  assert.equal((await fetch(base + pub)).headers.get("x-robots-tag"), "noindex, nofollow");

  await api("PATCH", admin, { publicEnabled: true });
  let p = (await api("GET", `/api/public/${pt}`)).data;
  assert.equal(p.talks[0].slides, null, "speaker hasn't agreed");
  assert.equal((await api("GET", `/api/public/${pt}/talks/${talk.id}/pdf`)).status, 404);

  assert.equal((await api("PATCH", sp, { shareSlides: true })).data.shareSlides, true);
  p = (await api("GET", `/api/public/${pt}`)).data;
  assert.match(p.talks[0].slides, /\/pdf\?v=1$/);
  const pdf = await fetch(base + p.talks[0].slides);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal((await fetch(base + pub)).headers.get("x-robots-tag"), null);
  assert.match(await (await fetch(base + pub)).text(), /<html/);
});

test("import programme pasted from a spreadsheet: rooms by name, breaks, defaults", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Import", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  assert.equal((await api("POST", `${admin}/import`, { rows: [] })).status, 400);
  const v = (await api("POST", `${admin}/import`, { rows: [
    { startsAt: "09:00", durationMin: 30, title: "Úvod", speaker: "Jana", room: "Velký sál" },
    { startsAt: "09:30", title: "Přestávka", kind: "break", room: "Velký sál" },
    { startsAt: "09:00", title: "Workshop", speaker: "Petr", room: "Malý sál" },
    { title: "" },
  ] })).data;
  assert.equal(v.imported, 3);
  assert.deepEqual(v.rooms.map(r => r.name), ["Velký sál", "Malý sál"], "the only room got the first name, the second was added");
  assert.equal(v.event.mode, "multi");
  const brk = v.talks.find(t => t.kind === "break");
  assert.equal(brk.durationMin, 15);
});

test("running late: shift the rest of the room; polls: choice + words, one vote per phone", async () => {
  const { admin, room, talk } = await setup();
  await api("PATCH", `${admin}/talks/${talk.id}`, { startsAt: "09:00" });
  await api("POST", `${admin}/talks`, { roomId: room.id, title: "Druhá", startsAt: "09:20" });
  await api("POST", `${admin}/talks`, { roomId: room.id, title: "Třetí", startsAt: "09:40" });
  let v = (await api("POST", `${admin}/rooms/${room.id}/shift`, { afterTalkId: talk.id, minutes: 12 })).data;
  assert.equal(v.shifted, 2);
  assert.deepEqual(v.talks.map(t => t.startsAt), ["09:00", "09:32", "09:52"]);
  assert.equal((await api("POST", `/api/player/${room.playerToken}/shift`, { afterTalkId: talk.id, minutes: -12 })).data.shifted, 2);

  const sp = `/api/speaker/${talk.speakerToken}`, qa = `/api/qa/${talk.qaToken}`;
  assert.equal((await api("POST", `${sp}/polls`, { question: "Kdo?", options: "Jen jedna" })).status, 400);
  const [poll] = (await api("POST", `${sp}/polls`, { question: "Odkud jste?", options: "Brno\nPraha\n\nOstrava" })).data.polls;
  assert.deepEqual(poll.options, ["Brno", "Praha", "Ostrava"]);
  assert.equal((await api("GET", qa)).data.poll.id, poll.id);
  await api("POST", `${qa}/polls/${poll.id}/vote`, { voter: "voter-aaaaaaaa", answer: 0 });
  await api("POST", `${qa}/polls/${poll.id}/vote`, { voter: "voter-aaaaaaaa", answer: 1 }); // changed mind
  const res = (await api("POST", `${qa}/polls/${poll.id}/vote`, { voter: "voter-bbbbbbbb", answer: 1 })).data.poll;
  assert.deepEqual(res.results.map(r => r.votes), [0, 2, 0]);
  assert.equal(res.mine, "1");
  // a new one (word cloud) closes the first
  const polls = (await api("POST", `${admin}/talks/${talk.id}/polls`, { question: "Jedním slovem?" })).data.polls;
  assert.deepEqual(polls.map(x => [x.kind, x.open]), [["words", true], ["choice", false]]);
  assert.equal((await api("POST", `${qa}/polls/${poll.id}/vote`, { voter: "voter-cccccccc", answer: 0 })).status, 409);
  for (const [vt, w] of [["voter-aaaaaaaa", "Super "], ["voter-bbbbbbbb", "super"], ["voter-cccccccc", "dlouhé"]]) await api("POST", `${qa}/polls/${polls[0].id}/vote`, { voter: vt, answer: w });
  const room2 = (await api("GET", `/api/player/${room.playerToken}/questions`)).data.polls[talk.id];
  assert.deepEqual(room2.results[0], { label: "super", votes: 2 });
  assert.equal((await api("PATCH", `${admin}/polls/${polls[0].id}`, { open: false })).data.polls[0].open, false);
  assert.equal((await api("GET", qa)).data.poll, null, "closed polls disappear for the audience");
});

test("now / next for the public page", async () => {
  const { admin } = await setup();
  await api("PATCH", admin, { publicEnabled: true });
  const pt = (await api("GET", admin)).data.event.publicPath.split("/a/")[1];
  const d = (await api("GET", `/api/public/${pt}/now`)).data;
  assert.equal(d.rooms[0].talks[0].title, "Talk");
  assert.equal(d.rooms[0].liveTalkId, null);
  assert.match((await api("GET", `/a/${pt}/sal/${d.rooms[0].id}`)).headers.get("content-type"), /html/);
});

test("door sign background: upload image/video, public only when the page is on, remove", async () => {
  const { admin } = await setup();
  const put = (name, buf) => fetch(base + `${admin}/sign-background?name=${name}`, { method: "PUT", body: buf });
  assert.equal((await put("x.pdf", Buffer.from("x"))).status, 400);
  let v = await (await put("loop.mp4", Buffer.from("video"))).json();
  assert.equal(v.event.signBackground, "video");
  const pt = v.event.publicPath.split("/a/")[1];
  assert.equal((await api("GET", `/api/public/${pt}/now`)).status, 404, "page off → nothing public");
  await api("PATCH", admin, { publicEnabled: true });
  const sign = (await api("GET", `/api/public/${pt}/now`)).data.sign;
  assert.equal(sign.kind, "video");
  assert.equal((await fetch(base + sign.url)).headers.get("content-type"), "video/mp4");
  v = await (await put("art.svg", Buffer.from("<svg/>"))).json();
  assert.equal(v.event.signBackground, "image");
  v = (await api("DELETE", `${admin}/sign-background`)).data;
  assert.equal(v.event.signBackground, null);
  assert.equal((await api("GET", `/api/public/${pt}/now`)).data.sign, null);
});

test("video in parts (Range): Safari / iPad door signs need it", async () => {
  const { admin } = await setup();
  await fetch(base + `${admin}/sign-background?name=v.mp4`, { method: "PUT", body: Buffer.from("0123456789") });
  let res = await fetch(base + `${admin}/sign-background`, { headers: { range: "bytes=2-5" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await res.text(), "2345");
  res = await fetch(base + `${admin}/sign-background`, { headers: { range: "bytes=-3" } });
  assert.equal(await res.text(), "789");
  assert.equal((await fetch(base + `${admin}/sign-background`, { headers: { range: "bytes=50-" } })).status, 416);
  assert.equal((await fetch(base + `${admin}/sign-background`)).headers.get("accept-ranges"), "bytes");
});
