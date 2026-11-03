// Programme pasted from Excel / Google Sheets / CSV: guess the columns, show a preview, import in one click.
import { esc } from "./common.js";
import { t } from "./i18n.js";

const TIME = /^(\d{1,2})[:.](\d{2})(?:\s*[-–—]\s*(\d{1,2})[:.](\d{2}))?$/;
const BREAK = /přestávk|oběd|obed|coffee|káva|kava|break|lunch|pauza|networking|registrace|registration|snídaně|večeře|dinner/i;
const HEAD = {
  time: /^(čas|cas|time|začátek|zacatek|start|od|from|kdy|when)$/i,
  end: /^(konec|end|do|to|until)$/i,
  duration: /^(délka|delka|duration|min|minut|minuty|length)/i,
  title: /^(název|nazev|téma|tema|title|přednáška|prednaska|talk|session|program|topic|co)$/i,
  speaker: /^(řečník|recnik|řečníci|speaker|speakers|jméno|jmeno|přednášející|prednasejici|kdo|who|name)$/i,
  room: /^(sál|sal|room|místnost|mistnost|stage|track|stream|hall)$/i,
};

const hhmm = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const toMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
function parseTime(v) {
  const m = String(v || "").trim().match(TIME);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  const start = hhmm(+m[1], +m[2]);
  const end = m[3] ? hhmm(+m[3], +m[4]) : null;
  return { start, dur: end && toMin(end) > toMin(start) ? toMin(end) - toMin(start) : null };
}
const parseDur = v => { const m = String(v || "").trim().match(/^(\d{1,3})\s*(min|m|minut\w*)?$/i); return m && +m[1] > 0 && +m[1] <= 600 ? +m[1] : null; };

// split one line: tabs (Excel/Sheets), else semicolon or comma (CSV, with simple quotes)
function cells(line, sep) {
  if (sep === "\t") return line.split("\t").map(c => c.trim());
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** text → { rows: [{ startsAt, durationMin, title, speaker, room, kind }], columns: {time, title, ...} } */
export function parseProgramme(text) {
  const lines = String(text || "").split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { rows: [], columns: {} };
  const sep = lines.some(l => l.includes("\t")) ? "\t" : lines.some(l => l.includes(";")) ? ";" : ",";
  let table = lines.map(l => cells(l, sep));
  const width = Math.max(...table.map(r => r.length));
  table = table.map(r => [...r, ...Array(width - r.length).fill("")]);

  // header row → columns by name
  const col = {};
  const head = table[0];
  if (head.some(c => Object.values(HEAD).some(re => re.test(c))) && !head.some(c => parseTime(c))) {
    head.forEach((c, i) => { for (const [k, re] of Object.entries(HEAD)) if (col[k] === undefined && re.test(c)) { col[k] = i; break; } });
    table = table.slice(1);
  }
  // no header (or missing columns): guess from the content
  const share = (i, fn) => table.filter(r => r[i] && fn(r[i])).length / Math.max(1, table.filter(r => r[i]).length);
  const free = () => [...Array(width).keys()].filter(i => !Object.values(col).includes(i) && table.some(r => r[i]));
  if (col.time === undefined) col.time = free().find(i => share(i, parseTime) > 0.6);
  if (col.duration === undefined) col.duration = free().find(i => share(i, parseDur) > 0.8);
  const texts = free();
  const avg = i => table.reduce((a, r) => a + (r[i] || "").length, 0) / table.length;
  const distinct = i => new Set(table.map(r => r[i]).filter(Boolean)).size;
  if (col.room === undefined) col.room = texts.find(i => table.length >= 4 && distinct(i) <= Math.max(2, table.length / 3) && distinct(i) < table.length);
  const rest = free().sort((a, b) => avg(b) - avg(a));
  if (col.title === undefined) col.title = rest.shift();
  if (col.speaker === undefined) col.speaker = rest.shift();

  const rows = table.map(r => {
    const tm = col.time !== undefined ? parseTime(r[col.time]) : null;
    const endT = col.end !== undefined ? parseTime(r[col.end]) : null;
    const title = (col.title !== undefined ? r[col.title] : "") || "";
    const kind = BREAK.test(title) && !(col.speaker !== undefined && r[col.speaker]) ? "break" : "talk";
    let dur = (col.duration !== undefined && parseDur(r[col.duration])) || tm?.dur || (tm && endT && toMin(endT.start) > toMin(tm.start) ? toMin(endT.start) - toMin(tm.start) : null);
    return { startsAt: tm?.start || null, durationMin: dur, title: title.slice(0, 300), speaker: col.speaker !== undefined ? r[col.speaker] || null : null, room: col.room !== undefined ? r[col.room] || null : null, kind };
  }).filter(r => r.title || r.kind === "break");

  // missing length: until the next start in the same room, else 20 min (breaks 15)
  rows.forEach((r, i) => {
    if (r.durationMin || !r.startsAt) return;
    const next = rows.slice(i + 1).find(x => x.startsAt && (x.room || "") === (r.room || "") && toMin(x.startsAt) > toMin(r.startsAt));
    r.durationMin = next ? Math.min(toMin(next.startsAt) - toMin(r.startsAt), 600) : null;
  });
  return { rows, columns: col };
}

/** The import dialog. onImport(rows) → Promise */
export function openImport(onImport) {
  const dlg = document.createElement("dialog");
  dlg.className = "preview importer";
  dlg.innerHTML = `
    <header class="pv-head">
      <div><div class="label">${t({ cs: "Program z Excelu", en: "Programme from Excel" })}</div>
        <h2>${t({ cs: "Vložte program", en: "Paste your programme" })}</h2>
        <div class="muted">${t({ cs: "V Excelu nebo Google Sheets označte tabulku, zkopírujte (Cmd/Ctrl + C) a vložte sem. Sloupce poznáme sami.", en: "Select the table in Excel or Google Sheets, copy (Cmd/Ctrl + C) and paste it here. We'll figure out the columns." })}</div></div>
      <div class="pv-actions"><button class="btn small" data-close>${t({ cs: "Zavřít", en: "Close" })}</button></div>
    </header>
    <textarea id="imp-text" rows="8" placeholder="${t({ cs: "9:00\tÚvod\tJana Dvořáková\n9:20\tJak na remote týmy\tPetr Svoboda\n10:00\tPřestávka na kávu", en: "9:00\tWelcome\tJane Doe\n9:20\tRemote teams\tJohn Smith\n10:00\tCoffee break" })}"></textarea>
    <div id="imp-preview"></div>`;
  document.body.append(dlg);
  const ta = dlg.querySelector("#imp-text"), box = dlg.querySelector("#imp-preview");
  let parsed = { rows: [] };
  const draw = () => {
    parsed = parseProgramme(ta.value);
    const { rows } = parsed;
    if (!ta.value.trim()) { box.innerHTML = ""; return; }
    if (!rows.length) { box.innerHTML = `<p class="pv-note">${t({ cs: "Tady nevidíme žádný program. Zkopírujte celé řádky tabulky (čas, název, řečník).", en: "We can't see a programme here. Copy whole table rows (time, title, speaker)." })}</p>`; return; }
    const rooms = [...new Set(rows.map(r => r.room).filter(Boolean))];
    box.innerHTML = `
      <div class="imp-sum"><span><b>${t({ cs: `Našli jsme ${rows.length} ${rows.length === 1 ? "položku" : rows.length < 5 ? "položky" : "položek"}`, en: `Found ${rows.length} item${rows.length === 1 ? "" : "s"}` })}</b>${rooms.length ? ` · ${t({ cs: "sály", en: "rooms" })}: ${rooms.map(esc).join(", ")}` : ""}</span>
        <button class="btn primary" data-go>${t({ cs: "Přidat do programu", en: "Add to programme" })}</button></div>
      <div class="imp-table"><table><thead><tr><th>${t({ cs: "Čas", en: "Time" })}</th><th>${t({ cs: "Název", en: "Title" })}</th><th>${t({ cs: "Řečník", en: "Speaker" })}</th>${rooms.length ? `<th>${t({ cs: "Sál", en: "Room" })}</th>` : ""}<th>${t({ cs: "Délka", en: "Length" })}</th></tr></thead>
      <tbody>${rows.map(r => `<tr class="${r.kind === "break" ? "imp-break" : ""}"><td class="mono">${esc(r.startsAt || "–")}</td><td>${r.kind === "break" ? `<span class="kindtag">${t({ cs: "Přestávka", en: "Break" })}</span> ` : ""}${esc(r.title)}</td><td>${esc(r.speaker || "")}</td>${rooms.length ? `<td>${esc(r.room || "")}</td>` : ""}<td class="mono">${r.durationMin ? r.durationMin + " min" : `<span class="muted">${r.kind === "break" ? 15 : 20} min</span>`}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small-note">${t({ cs: "Něco nesedí? Opravte to po importu u konkrétní položky (Upravit), nebo upravte tabulku a vložte znovu.", en: "Something off? Fix it after the import (Edit), or fix the table and paste again." })}</p>`;
    box.querySelector("[data-go]").onclick = async e => {
      e.target.disabled = true;
      try { await onImport(parsed.rows); dlg.close(); } catch { e.target.disabled = false; }
    };
  };
  ta.addEventListener("input", draw);
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  ta.focus();
}
