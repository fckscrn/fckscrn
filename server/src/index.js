import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { findSoffice } from "./analyze.js";
import { createInvoicing } from "./billing.js";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = +(process.env.PORT || 8080);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, "../data"));
const soffice = process.env.SOFFICE_PATH === "off" ? null : findSoffice();

const playerDir = path.resolve(process.env.PLAYER_DIR || path.join(here, "../../player/renderer"));
const retentionDays = process.env.EVENT_RETENTION_DAYS === undefined ? 14 : +process.env.EVENT_RETENTION_DAYS;
const landing = process.env.HOMEPAGE !== "app"; // HOMEPAGE=app: skip the product page on your own server
// hosted version only: proformas and invoices through the invoicing service. Without these variables everything is free.
const env = process.env;
const invoicingToken = env.FAKTURACE_API_TOKEN_FILE ? fs.readFileSync(env.FAKTURACE_API_TOKEN_FILE, "utf8").trim() : env.FAKTURACE_API_TOKEN;
const billing = env.FAKTURACE_URL && invoicingToken ? {
  invoicing: createInvoicing({ url: env.FAKTURACE_URL, token: invoicingToken }),
  prices: { single: +(env.PRICE_SINGLE || 1490), multi: +(env.PRICE_MULTI || 4990) },
} : null;
// PUBLIC_URL=https://fckscrn.com: absolute links for search engines (otherwise taken from the request)
const handler = createApp({ dataDir, publicDir: path.join(here, "../public"), playerDir, soffice, retentionDays, landing, billing, publicUrl: process.env.PUBLIC_URL || null,
  indexable: process.env.SEARCH_INDEX !== "off", gtmId: process.env.GTM_ID || null, envLabel: process.env.ENV_LABEL || null });

// delete events whose lifetime ended (at start, then hourly)
const purge = () => {
  handler.purgeExpired().then(n => n && console.log(`deleted ${n} expired event(s)`)).catch(e => console.error("purge failed", e));
  handler.checkPayments().then(n => n && console.log(`${n} invoice(s) paid`)).catch(e => console.error("payment check failed", e));
};
purge();
setInterval(purge, 60 * 60 * 1000).unref();
const server = http.createServer(handler);
server.requestTimeout = 0; // large uploads on slow venue wifi
server.listen(port, () => {
  console.log(`FckScrn server: http://localhost:${port}`);
  console.log(`data: ${dataDir}`);
  console.log(retentionDays ? `events are deleted ${retentionDays} days after their date` : "events are kept forever");
  console.log(billing ? `billing: invoicing service (${env.FAKTURACE_URL}), ${billing.prices.single} / ${billing.prices.multi} Kč` : "billing: off (everything free, no watermark)");
  console.log(soffice ? `PDF conversion: ${soffice}` : "PDF conversion: off (install LibreOffice to enable)");
});
