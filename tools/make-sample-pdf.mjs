// Generates a valid multi-page 16:9 PDF with big text, for end-to-end testing.
import fs from "node:fs";
const slides = ["Remote-first tymy", "Vychozi stav: 42 lidi", "Co nefungovalo", "Co zabralo", "Cisla: 18 % -> 7 %", "Diky! Otazky?"];
const W = 960, H = 540;
const objs = [];
const add = s => (objs.push(s), objs.length);
const catalog = add(null), pages = add(null), font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
const kids = [];
slides.forEach((t, i) => {
  const dark = i % 2 === 0;
  const stream = `${dark ? "0 0 0" : "1 1 1"} rg 0 0 ${W} ${H} re f ${dark ? "1 1 1" : "0 0 0"} rg BT /F1 56 Tf 70 280 Td (${t}) Tj ET BT /F1 20 Tf 70 60 Td (Slide ${i + 1} / ${slides.length}) Tj ET`;
  const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
});
objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
let out = "%PDF-1.4\n";
const offsets = objs.map((o, i) => { const off = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return off; });
const xref = out.length;
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
out += `trailer << /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(process.argv[2], out, "latin1");
