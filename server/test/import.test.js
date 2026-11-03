import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { samplePptx, samplePdf } from "./helpers.js";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const calls = [];
// fake Google: shared deck works, "private" deck returns the sign-in page
const fakeFetch = async url => {
  calls.push(url);
  if (url.includes("/private-deck-0000000000000/")) return new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
  if (url.endsWith("/export/pdf")) return new Response(samplePdf, { headers: { "content-type": "application/pdf" } });
  if (url.endsWith("/export/pptx")) return new Response(samplePptx(), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "content-disposition": "attachment; filename=\"deck.pptx\"; filename*=UTF-8''M%C5%AFj%20deck.pptx" } });
  return new Response("nope", { status: 404 });
};

let server, base, dataDir;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-import-"));
  server = http.createServer(createApp({ dataDir, publicDir: path.resolve("public"), fetchImpl: fakeFetch }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: Buffer.isBuffer(body) ? {} : { "Content-Type": "application/json" }, body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

async function eventWithTalk() {
  const { adminToken } = (await api("POST", "/api/events", { name: "Import", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  const v = (await api("POST", `${admin}/talks`, { roomId: (await api("GET", admin)).data.rooms[0].id, title: "Partner slot", speaker: "Sponsor" })).data;
  return { admin, talk: v.talks[0] };
}

test("Google Slides link: PDF from Google (no converter needed), notes from the PPTX", async () => {
  const { talk } = await eventWithTalk();
  const r = await api("POST", `/api/speaker/${talk.speakerToken}/link`, { url: `https://docs.google.com/presentation/d/${ID}/edit#slide=id.p` });
  assert.equal(r.status, 200);
  assert.equal(r.data.fileName, "Můj deck.pptx");
  assert.equal(r.data.hasPdf, true, "Google's PDF is used");
  assert.equal(r.data.pageCount, 2, "page count from the PDF");
  assert.ok(!r.data.issues.some(i => i.code === "no_converter"));
  assert.equal(r.data.sourceUrl.includes(ID), true);
  assert.deepEqual(calls.slice(-2).sort(), [`https://docs.google.com/presentation/d/${ID}/export/pdf`, `https://docs.google.com/presentation/d/${ID}/export/pptx`]);
  const spk = (await api("GET", `/api/speaker/${talk.speakerToken}`)).data;
  assert.equal(spk.talk.notes[1], "Díky");
});

test("Google Slides errors: not a link, not shared", async () => {
  const { talk } = await eventWithTalk();
  const bad = await api("POST", `/api/speaker/${talk.speakerToken}/link`, { url: "https://example.com/deck" });
  assert.deepEqual([bad.status, bad.data.code], [400, "gslides_link"]);
  const priv = await api("POST", `/api/speaker/${talk.speakerToken}/link`, { url: "https://docs.google.com/presentation/d/private-deck-0000000000000/edit" });
  assert.deepEqual([priv.status, priv.data.code], [400, "gslides_private"]);
  assert.equal((await api("GET", `/api/speaker/${talk.speakerToken}`)).data.talk.version, 0, "nothing stored");
});

test("organizer uploads on the speaker's behalf (file and Google link)", async () => {
  const { admin, talk } = await eventWithTalk();
  let v = (await api("PUT", `${admin}/talks/${talk.id}/file?name=partner.pdf`, samplePdf)).data;
  let t = v.talks.find(x => x.id === talk.id);
  assert.deepEqual([t.status, t.fileName, t.uploadedBy], ["ready", "partner.pdf", "organizer"]);
  v = (await api("POST", `${admin}/talks/${talk.id}/link`, { url: `https://docs.google.com/presentation/d/${ID}/edit` })).data;
  t = v.talks.find(x => x.id === talk.id);
  assert.deepEqual([t.version, t.fileExt, t.uploadedBy], [2, "pptx", "organizer"]);
  // another event's admin can't touch it
  const other = (await api("POST", "/api/events", { name: "X" })).data.adminToken;
  assert.equal((await api("PUT", `/api/admin/${other}/talks/${talk.id}/file?name=a.pdf`, samplePdf)).status, 404);
});
