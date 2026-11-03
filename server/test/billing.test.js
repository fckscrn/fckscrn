import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createInvoicing, aresLookup } from "../src/billing.js";

const json = (status, data) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// fake invoicing service: proforma per order ref, invoice once "paid"
const fake = {
  proformas: [], paid: new Set(),
  async proforma(p) { this.proformas.push(p); return { id: `p-${this.proformas.length}`, number: `Z2026000${this.proformas.length}`, kind: "proforma", status: "unpaid", total: p.items[0].unit_price }; },
  async documents(ref) {
    const i = this.proformas.findIndex(p => p.ref === ref);
    if (i < 0) return [];
    const id = `p-${i + 1}`, paid = this.paid.has(id);
    const pro = { id, kind: "proforma", number: `Z2026000${i + 1}`, status: paid ? "paid" : "unpaid", total: this.proformas[i].items[0].unit_price,
      issueDate: "2026-11-03", dueDate: "2026-11-17", paidDate: paid ? "2026-11-20" : null, variableSymbol: `92026000${i + 1}`, account: "123/2010", iban: "CZ6520100000000000000123" };
    return paid ? [pro, { ...pro, id: `i-${i + 1}`, kind: "invoice", number: `2026002${i + 1}`, variableSymbol: `2026002${i + 1}` }] : [pro];
  },
  async pdf(id) { return new Response("%PDF-1.4 fake " + id, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="doc-${id}.pdf"` } }); },
};
const aresFetch = async url => url.endsWith("/12345679")
  ? json(200, { ico: "12345679", obchodniJmeno: "Testovací s.r.o.", sidlo: { nazevUlice: "Testovací", cisloDomovni: 123, cisloOrientacni: 4, nazevObce: "Brno", psc: 64100 } })
  : json(404, {});

let server, base, dataDir, app;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-bill-"));
  app = createApp({ dataDir, publicDir: path.resolve("public"), billing: { invoicing: fake, prices: { single: 1490, multi: 4990 } }, fetchImpl: aresFetch });
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

test("trial → order (active, proforma) → documents in the admin → paid; watermark only in trial", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Meetup", date: "2026-11-04", mode: "single" })).data;
  const admin = `/api/admin/${adminToken}`;
  let v = (await api("GET", admin)).data;
  assert.deepEqual([v.billing.enabled, v.billing.status, v.billing.price], [true, "trial", 1490]);
  const player = `/api/player/${v.rooms[0].playerToken}`;
  assert.equal((await api("GET", player)).data.watermark, true);
  assert.deepEqual((await api("GET", `${admin}/documents`)).data.documents, [], "nothing before the order");

  assert.equal((await api("POST", `${admin}/order`, { name: "X", street: "a", city: "b", zip: "1", email: "nope" })).status, 400);
  v = (await api("POST", `${admin}/order`, { ico: "12345679", name: "Testovací s.r.o.", street: "Testovací 123/4", city: "Brno", zip: "64100", email: "info@example.cz" })).data;
  assert.equal(v.billing.status, "ordered");
  assert.equal(v.billing.invoiceNumber, "Z20260001");
  const order = fake.proformas[0];
  assert.match(order.ref, /^fckscrn:\d+:[0-9a-f]{8}$/);
  assert.deepEqual([order.items[0].unit_price, order.items[0].unit, order.dueDays], [1490, "akce", 14]);
  assert.match(order.items[0].description, /„Meetup“ \(4\. 11\. 2026\), jeden sál/);
  assert.equal(order.customer.ico, "12345679");
  assert.equal((await api("GET", player)).data.watermark, false, "active right after ordering");
  assert.equal((await api("POST", `${admin}/order`, {})).status, 409);

  // the proforma with payment details and QR; PDF only for this event's documents
  let docs = (await api("GET", `${admin}/documents`)).data.documents;
  assert.deepEqual(docs.map(d => [d.kind, d.number, d.status]), [["proforma", "Z20260001", "unpaid"]]);
  assert.equal(docs[0].pay.variableSymbol, "920260001");
  assert.match(docs[0].pay.qr, /^<svg/);
  const pdf = await fetch(`${base}${admin}/documents/p-1/pdf`);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(await pdf.text(), /^%PDF/);
  assert.equal((await fetch(`${base}${admin}/documents/p-99/pdf`)).status, 404, "not a document of this event");

  // paid → the hourly check picks it up, the invoice is listed
  fake.paid.add("p-1");
  assert.ok(await app.checkPayments() >= 1);
  v = (await api("GET", admin)).data;
  assert.deepEqual([v.billing.status, v.billing.paidAt], ["paid", "2026-11-20"]);
  docs = (await api("GET", `${admin}/documents`)).data.documents;
  assert.deepEqual(docs.map(d => [d.kind, d.status, !!d.pay]), [["proforma", "paid", false], ["invoice", "paid", false]]);
});

test("multi-room price; another event can't read the documents", async () => {
  const { adminToken } = (await api("POST", "/api/events", { name: "Konf", mode: "multi" })).data;
  const admin = `/api/admin/${adminToken}`;
  await api("POST", `${admin}/order`, { name: "Firma", street: "a", city: "b", zip: "1", email: "a@b.cz" });
  assert.equal((await api("GET", admin)).data.billing.price, 4990);
  assert.equal(fake.proformas.at(-1).items[0].unit_price, 4990);
  assert.equal((await fetch(`${base}${admin}/documents/p-1/pdf`)).status, 404, "the first event's proforma");
});

test("invoicing client: token, paths, errors", async () => {
  const calls = [];
  const c = createInvoicing({ url: "http://fakturace:8090/", token: "tok", fetchImpl: async (url, opt) => {
    calls.push({ url, method: opt.method, auth: opt.headers.Authorization, body: opt.body && JSON.parse(opt.body) });
    return url.includes("/documents?") ? json(200, { documents: [{ id: "a" }] }) : url.endsWith("/pdf") ? new Response("%PDF") : json(201, { id: "a", number: "Z1" });
  } });
  assert.equal((await c.proforma({ ref: "r:1", customer: { name: "X" }, items: [] })).number, "Z1");
  assert.deepEqual(await c.documents("r:1"), [{ id: "a" }]);
  assert.equal(await (await c.pdf("a")).text(), "%PDF");
  assert.deepEqual(calls.map(x => [x.method, x.url, x.auth]), [
    ["POST", "http://fakturace:8090/api/proformas", "Bearer tok"],
    ["GET", "http://fakturace:8090/api/documents?ref=r%3A1", "Bearer tok"],
    ["GET", "http://fakturace:8090/api/documents/a/pdf", "Bearer tok"]]);
  assert.equal(calls[0].body.dueDays, 14);
  const failing = createInvoicing({ url: "http://x", token: "t", fetchImpl: async () => json(500, {}) });
  await assert.rejects(failing.documents("r"), /500/);
});
