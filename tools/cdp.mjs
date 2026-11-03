// Drive a running Chrome/Electron over the DevTools Protocol (port 9222): eval JS, take screenshots.
// usage: node tools/cdp.mjs eval "<js>" [titleMatch] | shot <outfile> <titleMatch> | list
import fs from "node:fs";
const [cmd, a, b] = process.argv.slice(2);
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const pages = targets.filter(t => t.type === "page");
if (cmd === "list") { console.log(pages.map(p => `${p.title} | ${p.url}`).join("\n")); process.exit(0); }
const match = cmd === "eval" ? (b || "fckscrn Player") : b;
const t = pages.find(p => p.title.includes(match) || p.url.includes(match));
if (!t) { console.error("no target", match, pages.map(p => p.title)); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0;
const call = (method, params = {}) => new Promise(res => {
  const my = ++id;
  ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result ?? m); } });
  ws.send(JSON.stringify({ id: my, method, params }));
});
if (cmd === "eval") {
  const r = await call("Runtime.evaluate", { expression: a, awaitPromise: true, returnByValue: true, userGesture: true });
  console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails ?? r, null, 1));
} else if (cmd === "shot") {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(a, Buffer.from(r.data, "base64"));
  console.log("saved", a);
}
ws.close();
