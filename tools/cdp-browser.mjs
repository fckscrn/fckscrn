// Browser-level DevTools commands for tests: grant permissions, press a key in a page.
// usage: node tools/cdp-browser.mjs grant <origin> | key <titleMatch> [key]
const [cmd, a, b] = process.argv.slice(2);
const connect = async url => {
  const ws = new WebSocket(url);
  await new Promise(r => ws.addEventListener("open", r));
  let id = 0;
  const call = (method, params = {}) => new Promise(res => {
    const my = ++id;
    ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result ?? m); } });
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  return { call, close: () => ws.close() };
};
if (cmd === "grant") {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const c = await connect(webSocketDebuggerUrl);
  console.log(JSON.stringify(await c.call("Browser.grantPermissions", { origin: a, permissions: ["windowManagement"] })));
  c.close();
} else if (cmd === "key") {
  const t = (await (await fetch("http://127.0.0.1:9222/json")).json()).find(p => p.type === "page" && (p.title.includes(a) || p.url.includes(a)));
  const c = await connect(t.webSocketDebuggerUrl);
  const key = b || "PageDown";
  await c.call("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: 34 });
  await c.call("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: 34 });
  console.log("pressed", key, "in", t.title);
  c.close();
}
