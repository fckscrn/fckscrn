// Dev server with a FAKE Fakturoid (nothing is invoiced), to click through the activation flow.
// usage: node tools/dev-billing-server.mjs [port]   → data in a temp dir, deleted on exit
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/src/app.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = +(process.argv[2] || 8091);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-billing-dev-"));
let n = 0;
const paid = new Set();
const fakturoid = {
  async subject(c) { console.log("[fake fakturoid] subject", c.name, c.ico || ""); return 1; },
  async invoice(i) { n++; console.log("[fake fakturoid] invoice", i.price, "Kč –", i.text); return { id: n, number: `TEST-${String(n).padStart(4, "0")}`, public_html_url: "https://www.fakturoid.cz/", status: "open" }; },
  async send(id, m) { console.log("[fake fakturoid] e-mail to", m.email); },
  async get(id) { return { id, status: paid.has(id) ? "paid" : "open" }; },
};
const app = createApp({ dataDir, publicDir: path.join(root, "../server/public"), playerDir: path.join(root, "../player/renderer"),
  billing: { fakturoid, prices: { single: 1490, multi: 4990 }, webhookToken: "dev" } });
http.createServer(app).listen(port, () => console.log(`billing dev server: http://localhost:${port} (fake Fakturoid, data ${dataDir})`));
// pay invoice N: curl -X POST localhost:PORT/api/billing/fakturoid -H 'Authorization: Bearer dev' -d '{"event_name":"invoice_paid","body":{"invoice":{"id":N}}}'
process.on("SIGTERM", () => { fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); });
