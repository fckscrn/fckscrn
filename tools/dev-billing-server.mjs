// Dev server with a FAKE invoicing service (nothing is invoiced), to click through the activation flow.
// usage: node tools/dev-billing-server.mjs [port]   → data in a temp dir, deleted on exit
//        pay proforma N: curl -X POST localhost:PORT/__pay/N   (then the hourly check runs right away)
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/src/app.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = +(process.argv[2] || 8091);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-billing-dev-"));
const orders = [], paid = new Set();
const doc = (o, i) => ({ id: `p${i + 1}`, kind: "proforma", number: `TEST-Z${i + 1}`, status: paid.has(i + 1) ? "paid" : "unpaid",
  total: o.items[0].unit_price, issueDate: "2026-01-01", dueDate: "2026-01-15", paidDate: paid.has(i + 1) ? "2026-01-02" : null,
  variableSymbol: `9${i + 1}`, account: "123456789/0100", iban: "CZ6501000000000123456789" });
const invoicing = {
  async proforma(o) { const i = orders.findIndex(x => x.ref === o.ref); if (i >= 0) return doc(orders[i], i); orders.push(o); console.log("[fake] proforma", o.items[0].unit_price, "Kč –", o.items[0].description); return doc(o, orders.length - 1); },
  async documents(ref) { const i = orders.findIndex(x => x.ref === ref); if (i < 0) return []; const p = doc(orders[i], i); return p.status === "paid" ? [p, { ...p, id: `f${i + 1}`, kind: "invoice", number: `TEST-F${i + 1}` }] : [p]; },
  async pdf(id) { return new Response(`%PDF-1.4\n% fake document ${id}\n`, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${id}.pdf"` } }); },
};
const app = createApp({ dataDir, publicDir: path.join(root, "../server/public"), playerDir: path.join(root, "../player/renderer"),
  billing: { invoicing, prices: { single: 1490, multi: 4990 } } });
http.createServer(async (req, res) => {
  const m = req.method === "POST" && req.url.match(/^\/__pay\/(\d+)$/);
  if (m) { paid.add(+m[1]); const n = await app.checkPayments(); res.end(`paid ${m[1]}, ${n} event(s) updated\n`); return; }
  app(req, res);
}).listen(port, () => console.log(`billing dev server: http://localhost:${port} (fake invoicing, data ${dataDir})`));
process.on("SIGINT", () => { fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); });
