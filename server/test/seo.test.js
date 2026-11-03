import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

const servers = [];
const start = async opts => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-seo-"));
  const server = http.createServer(createApp({ dataDir, publicDir: path.resolve("public"), ...opts }));
  await new Promise(r => server.listen(0, r));
  servers.push([server, dataDir]);
  return `http://localhost:${server.address().port}`;
};
let site, selfHosted;
before(async () => { site = await start({ publicUrl: "https://fckscrn.com" }); selfHosted = await start({ landing: false }); });
after(() => servers.forEach(([s, d]) => { s.close(); fs.rmSync(d, { recursive: true, force: true }); }));

test("product pages: absolute canonical + hreflang, valid JSON-LD, indexable", async () => {
  for (const [p, canon] of [["/", "https://fckscrn.com/"], ["/en", "https://fckscrn.com/en"], ["/napoveda", "https://fckscrn.com/napoveda"], ["/en/help", "https://fckscrn.com/en/help"]]) {
    const res = await fetch(site + p);
    const html = await res.text();
    assert.equal(res.headers.get("x-robots-tag"), null, p);
    assert.ok(html.includes(`<link rel="canonical" href="${canon}">`), p);
    assert.ok(!html.includes("%ORIGIN%"), p);
    assert.match(html, /hreflang="x-default"/);
    assert.match(html, /og:image" content="https:\/\/fckscrn\.com\/assets\/logo\/og-(cs|en)\.png/);
    for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(json);
  }
  const ld = JSON.parse((await (await fetch(site + "/")).text()).match(/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const faq = ld["@graph"].find(x => x["@type"] === "FAQPage");
  assert.ok(faq.mainEntity.length >= 7);
});

test("event links stay out of search; robots, sitemap, llms.txt, 404 page", async () => {
  for (const p of ["/e/abc", "/s/abc", "/p/abc", "/q/abc", "/api/events"]) assert.equal((await fetch(site + p)).headers.get("x-robots-tag"), "noindex, nofollow", p);
  const robots = await (await fetch(site + "/robots.txt")).text();
  assert.match(robots, /Disallow: \/e\//);
  assert.match(robots, /Sitemap: https:\/\/fckscrn\.com\/sitemap\.xml/);
  const map = await (await fetch(site + "/sitemap.xml")).text();
  assert.match(map, /<loc>https:\/\/fckscrn\.com\/en\/help<\/loc>/);
  assert.match(await (await fetch(site + "/llms.txt")).text(), /^# FckScrn/);
  assert.equal((await fetch(site + "/favicon.ico")).headers.get("content-type"), "image/png");
  const nf = await fetch(site + "/nic-takoveho", { headers: { accept: "text/html" } });
  assert.equal(nf.status, 404);
  assert.match(await nf.text(), /zase tady nic není/);
  // self-hosted instance: nothing indexed
  assert.match(await (await fetch(selfHosted + "/robots.txt")).text(), /Disallow: \/\n/);
  assert.equal((await fetch(selfHosted + "/")).headers.get("x-robots-tag"), "noindex, nofollow");
});

test("Google Tag Manager: only product pages of the hosted site, with consent mode; never event links", async () => {
  const gtm = await start({ publicUrl: "https://fckscrn.com", gtmId: "GTM-WRQ732G5" });
  const home = await (await fetch(gtm + "/")).text();
  assert.match(home, /gtm\.js\?id=|'GTM-WRQ732G5'/);
  assert.ok(home.indexOf('gtag("consent","default"') < home.indexOf("googletagmanager.com/gtm.js"), "consent default before GTM loads");
  assert.match(home, /consent\.js/);
  assert.doesNotMatch(await (await fetch(gtm + "/e/whatever")).text(), /GTM-/);
  assert.doesNotMatch(await (await fetch(gtm + "/s/whatever")).text(), /GTM-/);
  // no GTM_ID (self-hosting) or a test server → nothing
  assert.doesNotMatch(await (await fetch(site + "/")).text(), /googletagmanager/);
  const test = await start({ gtmId: "GTM-WRQ732G5", indexable: false });
  assert.doesNotMatch(await (await fetch(test + "/")).text(), /googletagmanager/);
  assert.doesNotMatch(await (await fetch(site + "/")).text(), /analytics-head/);
});

test("staging label: tag and [TEST] title on pages, never on the projection; support page + QR", async () => {
  const staging = await start({ envLabel: "test.fckscrn.com", indexable: false });
  const home = await (await fetch(staging + "/")).text();
  assert.match(home, /<title>\[TEST\] /);
  assert.match(home, /TESTOVACÍ VERZE/);
  assert.doesNotMatch(await (await fetch(site + "/")).text(), /TESTOVACÍ VERZE/, "the live site has no tag");
  // support page and its QR payment with the chosen amount
  const sup = await fetch(site + "/podpora");
  assert.equal(sup.status, 200);
  assert.match(await sup.text(), /96777198\/2010/);
  const qr = await fetch(site + "/api/support/qr.svg?amount=490");
  assert.equal(qr.headers.get("content-type"), "image/svg+xml");
  assert.match(await qr.text(), /^<svg/);
  assert.equal((await fetch(site + "/api/support/qr.svg?amount=0")).status, 400);
  assert.equal((await fetch(site + "/en/support")).status, 200);
  for (const p of ["/obchodni-podminky", "/en/terms", "/ochrana-udaju", "/en/privacy"]) assert.equal((await fetch(site + p)).status, 200, p);
});
