// The "support us" banner at the top of README.md (docs/podpora.svg): inverted (black) card with a Czech
// QR payment for 490 Kč; a click leads to fckscrn.com/podpora where any amount can be picked.
// usage: node tools/make-support-banner.mjs [amount]
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const qrcode = require("qrcode-generator");

const amount = +(process.argv[2] || 490);
const spd = `SPD*1.0*ACC:CZ8020100000000096777198*AM:${amount.toFixed(2)}*CC:CZK*MSG:Podpora FckScrn`;
const q = qrcode(0, "M"); q.addData(spd); q.make();
const n = q.getModuleCount(), size = 196, cell = size / n;
let mods = "";
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) mods += `M${(c * cell).toFixed(2)} ${(r * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
const font = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;
const W = 1200, H = 300;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Podpořte FckScrn: QR platba ${amount} Kč, jiná částka na fckscrn.com/podpora">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="#0b0b0b" stroke="#ffffff" stroke-opacity=".25" stroke-width="2"/>
  <g ${font} fill="#ffffff">
    <text x="48" y="64" font-size="15" letter-spacing="2.4" fill-opacity=".6">OPEN SOURCE · DOBROVOLNÝ PŘÍSPĚVEK</text>
    <text x="48" y="122" font-size="46" font-weight="800" letter-spacing="-1.2">Líbí se vám FckScrn?</text>
    <text x="48" y="166" font-size="21" fill-opacity=".85">Je open source a zdarma. Provoz serveru a vývoj ale něco stojí.</text>
    <text x="48" y="196" font-size="21" fill-opacity=".85">Nepohrdneme menším příspěvkem na údržbu. Díky!</text>
    <text x="48" y="246" font-size="17" font-weight="700">QR platba ${amount.toLocaleString("cs-CZ")} Kč (částku jde v bance změnit) · jiná částka: fckscrn.com/podpora</text>
    <text x="48" y="272" font-size="14" fill-opacity=".55">Like FckScrn? Support hosting and development: fckscrn.com/en/support</text>
  </g>
  <rect x="${W - 48 - size - 24}" y="${(H - size - 24) / 2}" width="${size + 24}" height="${size + 24}" rx="12" fill="#ffffff"/>
  <path transform="translate(${W - 48 - size - 12} ${(H - size - 24) / 2 + 12})" fill="#000000" d="${mods}"/>
</svg>
`;
fs.mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../docs/podpora.svg", import.meta.url), svg);
console.log(`docs/podpora.svg (${amount} Kč)`);
