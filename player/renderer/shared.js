// Where files come from: the desktop app serves them on fck://, the web player sets
// globalThis.fckEnv (web-shim.js) before this module runs.
export const env = globalThis.fckEnv || {
  pdfjs: "../pdfjs/pdf.mjs",
  worker: "../pdfjs/pdf.worker.mjs",
  pdfUrl: t => `fck://app/cache/${t.id}/${t.version}.pdf`,
  mediaUrl: m => `fck://app/media/${m.id}`,
  bgUrl: t => `fck://app/bg/${t.id}`,
  videoUrl: (t, v) => `fck://app/video/${t.id}/${v.i}`,
};
const pdfjs = await import(env.pdfjs);
pdfjs.GlobalWorkerOptions.workerSrc = env.worker;

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const hhmm = (d = new Date()) => d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });

const docs = new Map();
export function loadDoc(talk) {
  if (!talk?.local?.pdf) return Promise.resolve(null);
  const key = `${talk.id}:${talk.version}`;
  if (!docs.has(key)) {
    docs.set(key, pdfjs.getDocument({
      url: env.pdfUrl(talk),
      disableRange: true, disableStream: true, isEvalSupported: false,
    }).promise.catch(() => { docs.delete(key); return null; }));
  }
  return docs.get(key);
}

// Render off-screen, then swap in, so fast clicking never shows a half-drawn slide.
const seq = new WeakMap();
export async function draw(canvas, doc, n) {
  const id = (seq.get(canvas) || 0) + 1;
  seq.set(canvas, id);
  if (!doc || n < 1 || n > doc.numPages) { canvas.width = canvas.height = 0; return; }
  const page = await doc.getPage(n);
  const box = canvas.parentElement.getBoundingClientRect();
  const base = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(box.width / base.width, box.height / base.height) * dpr;
  if (!(scale > 0)) return;
  const vp = page.getViewport({ scale });
  const off = document.createElement("canvas");
  off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
  await page.render({ canvas: off, viewport: vp }).promise;
  if (seq.get(canvas) !== id) return;
  canvas.width = off.width; canvas.height = off.height;
  canvas.style.width = off.width / dpr + "px"; canvas.style.height = off.height / dpr + "px";
  canvas.getContext("2d").drawImage(off, 0, 0);
}

// Clickers send PageDown/PageUp, arrows, or "." / "b" for black screen.
export function bindKeys({ allowEnd = false } = {}) {
  addEventListener("keydown", e => {
    if (e.target.closest?.("input, select, textarea")) return;
    const k = e.key;
    let c = null;
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(k)) c = "next";
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(k)) c = "prev";
    else if (["b", "B", ".", "w", "W"].includes(k)) c = "black";
    else if (k === "Home") c = "first";
    else if (k === "Escape" && (typeof allowEnd === "function" ? allowEnd() : allowEnd)) c = "end";
    if (c) { e.preventDefault(); fck.cmd(c); }
  });
}

export function timerText(live, talk) {
  const left = Math.round((talk.durationMin * 60_000 - (Date.now() - live.startedAt)) / 1000);
  const a = Math.abs(left);
  const text = (left < 0 ? "+" : "") + Math.floor(a / 60) + ":" + String(a % 60).padStart(2, "0");
  return { text, cls: left < 0 ? "over" : left < 300 ? "warn" : "" };
}

/** Subscribe to state; calls render(state) on every change. */
export async function subscribe(render) {
  fck.onState(render);
  render(await fck.getState());
}

export const slides = n => `${n} ${n === 1 ? "slide" : n >= 2 && n <= 4 ? "slidy" : "slidů"}`;
