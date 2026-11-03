import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createFakturoid, aresLookup } from "../src/billing.js";

const json = (status, data) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// fake Fakturoid: records what we asked for
const fake = {
  subjects: [], invoices: [], sent: [], paid: new Set(),
  async subject(c) { this.subjects.push(c); return 77; },
  async invoice(i) { this.invoices.push(i); return { id: 501, number: "2026-0001", public_html_url: "https://app.fakturoid.cz/x/p/abc", status: "open" }; },
  async send(id, m) { this.sent.push({ id, ...m }); },
  async get(id) { return { id, status: this.paid.has(id) ? "paid" : "open", paid_on: "2026-11-20" }; },
};
const aresFetch = async url => url.endsWith("/12345679")
  ? json(200, { ico: "12345679", obchodniJmeno: "Testovací s.r.o.", sidlo: { nazevUlice: "Testovací", cisloDomovni: 123, cisloOrientacni: 4, nazevObce: "Brno", psc: 64100 } })
  : json(404, {});

let server, base, dataDir, app;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-bill-"));
  app = createApp({ dataDir, publicDir: path.resolve("public"), billing: { fakturoid: fake, prices: { single: 1490, multi: 4990 }, webhookToken: "secret" }, fetchImpl: aresFetch });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const api = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test("ARES lookup fills company details", async () => {
  const r = await api("GET", "/api/ares/12345679");
  assert.deepEqual(r.data, { ico: "12345679", name: "Testovací s.r.o.", dic: null, street: "Testovací 123/4", city: "Brno", zip: "64100" });
  assert.equal((await api("GET", "/api/ares/12345678")).status, 404);
  assert.equal((await api("GET", "/api/ares/123")).status, 400);
});

test("trial → order (active, invoice sent) → paid via webhook; watermark only in trial", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Meetup", date: "2026-11-14", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  let v = (await api("GET", admin)).data;
  assert.deepEqual([v.billing.enabled, v.billing.status, v.billing.price], [true, "trial", 1490]);
  const player = `/api/player/${v.rooms[0].playerToken}`;
  assert.equal((await api("GET", player)).data.watermark, true);

  assert.equal((await api("POST", `${admin}/order`, { name: "X", street: "a", city: "b", zip: "1", email: "nope" })).status, 400);
  v = (await api("POST", `${admin}/order`, { ico: "12345679", name: "Testovací s.r.o.", street: "Testovací 123/4", city: "Brno", zip: "64100", email: "info@example.cz" })).data;
  assert.equal(v.billing.status, "ordered");
  assert.equal(v.billing.invoiceNumber, "2026-0001");
  assert.equal(fake.invoices[0].price, 1490);
  assert.match(fake.invoices[0].text, /„Meetup“ \(14\. 11\. 2026\), jeden sál/);
  assert.deepEqual(fake.sent[0], { id: 501, email: "info@example.cz", eventName: "Meetup" });
  assert.equal((await api("GET", player)).data.watermark, false, "active right after ordering");
  assert.equal((await api("POST", `${admin}/order`, {})).status, 409);

  // webhook needs the shared token
  const hook = { event_name: "invoice_paid", body: { invoice: { id: 501, paid_on: "2026-11-20" }, payment: {} } };
  assert.equal((await api("POST", "/api/billing/fakturoid", hook)).status, 401);
  assert.equal((await api("POST", "/api/billing/fakturoid", hook, { Authorization: "Bearer secret" })).status, 200);
  v = (await api("GET", admin)).data;
  assert.deepEqual([v.billing.status, v.billing.paidAt], ["paid", "2026-11-20"]);
});

test("hourly check marks paid invoices", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Konf", mode: "multi" })).data;
  const admin = `/api/admin/${adminToken}`;
  await api("POST", `${admin}/order`, { name: "Firma", street: "a", city: "b", zip: "1", email: "a@b.cz" });
  assert.equal((await api("GET", admin)).data.billing.price, 4990);
  fake.paid.add(501);
  assert.ok(await app.checkPayments() >= 1);
  assert.equal((await api("GET", admin)).data.billing.status, "paid");
});

test("Fakturoid client: token, headers and paths", async () => {
  const calls = [];
  const f = createFakturoid({ clientId: "id", clientSecret: "sec", account: "tomas", email: "t@x.cz", fetchImpl: async (url, opt) => {
    calls.push({ url, method: opt.method, auth: opt.headers.Authorization, ua: opt.headers["User-Agent"], body: opt.body && JSON.parse(opt.body) });
    if (url.endsWith("/oauth/token")) return json(200, { access_token: "tok", expires_in: 7200 });
    if (url.includes("/subjects/search.json")) return json(200, []);
    if (url.endsWith("/subjects.json")) return json(201, { id: 9 });
    if (url.endsWith("/invoices.json")) return json(201, { id: 10, number: "2026-0002" });
    if (url.endsWith("/message.json")) return new Response(null, { status: 204 });
    return json(404, {});
  } });
  assert.equal(await f.subject({ ico: "12345679", name: "T", email: "a@b.cz" }), 9);
  const inv = await f.invoice({ subjectId: 9, price: 1490, text: "fckscrn" });
  await f.send(inv.id, { email: "a@b.cz", eventName: "Meetup" });
  assert.equal(calls[0].url, "https://app.fakturoid.cz/api/v3/oauth/token");
  assert.equal(calls[0].auth, "Basic " + Buffer.from("id:sec").toString("base64"));
  assert.deepEqual(calls[0].body, { grant_type: "client_credentials" });
  assert.equal(calls.filter(c => c.url.endsWith("/oauth/token")).length, 1, "token is reused");
  assert.ok(calls.slice(1).every(c => c.auth === "Bearer tok" && c.ua === "fckscrn (t@x.cz)"));
  assert.equal(calls[1].url, "https://app.fakturoid.cz/api/v3/accounts/tomas/subjects/search.json?query=12345679");
  assert.deepEqual(calls[3].body.lines, [{ name: "fckscrn", quantity: 1, unit_name: "akce", unit_price: 1490 }]);
  assert.equal(calls[4].url, "https://app.fakturoid.cz/api/v3/accounts/tomas/invoices/10/message.json");
});

test("without billing nothing changes: no order, no watermark", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-free-"));
  const free = http.createServer(createApp({ dataDir: d, publicDir: path.resolve("public") }));
  await new Promise(r => free.listen(0, r));
  const b = `http://localhost:${free.address().port}`;
  const { adminToken } = await (await fetch(b + "/api/events", { method: "POST", body: JSON.stringify({ name: "Free" }) })).json();
  const v = await (await fetch(`${b}/api/admin/${adminToken}`)).json();
  assert.deepEqual(v.billing, { enabled: false });
  assert.equal((await (await fetch(`${b}/api/player/${v.rooms[0].playerToken}`)).json()).watermark, false);
  assert.equal((await fetch(`${b}/api/admin/${adminToken}/order`, { method: "POST", body: "{}" })).status, 404);
  free.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("aresLookup handles missing street name", async () => {
  const r = await aresLookup("1", async () => json(200, { ico: "1", obchodniJmeno: "Obec", sidlo: { nazevCastiObce: "Lhota", cisloDomovni: 5, nazevObce: "Lhota", psc: 12345 } }));
  assert.equal(r.street, "Lhota 5");
});
