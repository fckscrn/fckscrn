import { lang } from "./i18n.js";

export const $ = (sel, el = document) => el.querySelector(sel);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const tokenFromPath = () => decodeURIComponent(location.pathname.split("/")[2] || "");

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Chyba ${res.status}`), { code: data.code });
  return data;
}

export function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2600);
}

export async function copy(text, msg = "Zkopírováno") {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { prompt(lang === "en" ? "Copy the link:" : "Zkopírujte odkaz:", text); }
}

const STATUS = {
  cs: { missing: "Chybí soubor", processing: "Zpracovává se", ready: "Připraveno", warning: "Ke kontrole", error: "Chyba" },
  en: { missing: "No file yet", processing: "Processing", ready: "Ready", warning: "Needs a look", error: "Error" },
};
export const st = s => `<span class="st ${s}">${STATUS[lang][s] || s}</span>`;

export function fmtSize(n) {
  if (!n) return "";
  return n > 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " MB" : Math.ceil(n / 1e3) + " kB";
}

export function fmtDate(d) {
  if (!d) return "";
  const x = new Date(d + "T12:00:00");
  return isNaN(x) ? d : x.toLocaleDateString(lang === "en" ? "en-GB" : "cs-CZ", { weekday: "short", day: "numeric", month: lang === "en" ? "short" : "numeric", year: "numeric" });
}

export const slides = n => lang === "en" ? `${n} slide${n === 1 ? "" : "s"}` : `${n} ${n === 1 ? "slide" : n >= 2 && n <= 4 ? "slidy" : "slidů"}`;
