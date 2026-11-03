import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let server, dataDir, mcp, rl, nextId = 1;
const pending = new Map();

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-mcp-"));
  server = http.createServer(createApp({ dataDir, publicDir: path.join(here, "../server/public") }));
  await new Promise(r => server.listen(0, r));
  mcp = spawn(process.execPath, [path.join(here, "fckscrn-mcp.mjs")], { env: { ...process.env, FCKSCRN_URL: `http://localhost:${server.address().port}`, FCKSCRN_EVENT: "" } });
  rl = readline.createInterface({ input: mcp.stdout });
  rl.on("line", l => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
});
after(() => { mcp.kill(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const rpc = (method, params) => new Promise(res => { const id = nextId++; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { text: r.result.content[0].text, error: !!r.result.isError }; };

test("handshake and tool list", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.serverInfo.name, "fckscrn");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  assert.deepEqual(list.result.tools.map(t => t.name).sort(),
    ["add_break", "add_room", "add_talk", "create_event", "delete_talk", "event_status", "get_program", "rename_room", "speaker_links", "update_talk", "use_event"]);
  assert.ok(list.result.tools.every(t => t.inputSchema.type === "object"));
});

test("dictate a program", async () => {
  assert.match((await call("get_program")).text, /Není vybraná akce/);
  let r = await call("create_event", { name: "Brno Meetup", date: "2026-11-14" });
  assert.match(r.text, /Správa .*\/e\//);
  await call("add_talk", { title: "Úvod", speaker: "Jana Dvořáková", starts_at: "18:00", duration_min: 10 });
  r = await call("add_talk", { title: "AI v podpoře", speaker: "Martin Kolář" });
  assert.match(r.text, /Přidáno: 18:10 AI v podpoře/, "starts when the previous block ends");
  assert.match(r.text, /\/s\//, "returns the speaker link");
  await call("add_break", { title: "Pivo" });
  r = await call("update_talk", { talk: "Kolář", duration_min: 30 });
  assert.match(r.text, /18:10–18:40 {2}AI v podpoře – Martin Kolář/);
  r = await call("get_program");
  assert.match(r.text, /18:30–18:45 {2}☕ Pivo/, "break kept its own start time");
  assert.match((await call("update_talk", { talk: "nic takového" })).text, /není/);
  assert.equal((await call("delete_talk", { talk: "Pivo" })).error, false);
  r = await call("speaker_links", { only_missing: true });
  assert.equal(r.text.split("\n").filter(l => l.includes("/s/")).length, 2);
  r = await call("event_status");
  assert.match(r.text, /nahráno 0\/2/);
});

test("rooms", async () => {
  await call("create_event", { name: "Konf", mode: "multi", rooms: ["Velký sál", "Workshop"] });
  assert.match((await call("add_talk", { title: "Bez sálu" })).text, /víc sálů/);
  await call("add_talk", { title: "Keynote", room: "velký" });
  await call("add_room", { name: "Sál C" });
  await call("rename_room", { room: "Sál C", name: "Foyer" });
  const r = await call("get_program");
  assert.match(r.text, /## Velký sál[\s\S]*Keynote[\s\S]*## Workshop[\s\S]*## Foyer/);
});
