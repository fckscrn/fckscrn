// Load test: many events at once. Seeds a throwaway data dir, then hammers the endpoints
// that run all day during events (audience Q&A page, room polling, organizer admin, public now/next).
// usage: node tools/loadtest.mjs [events=500] [seconds=20] [concurrency=64]
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/src/app.js";

const [EVENTS = 500, SECONDS = 20, CONC = 64] = process.argv.slice(2).map(Number);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fckscrn-load-"));
const server = http.createServer(createApp({ dataDir, publicDir: path.join(here, "../server/public"), landing: true }));
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const agent = new http.Agent({ keepAlive: true, maxSockets: CONC * 2 });

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + url, { method, agent, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const json = async (m, u, b) => JSON.parse((await req(m, u, b)).body);

// ---------- seed ----------
console.log(`seeding ${EVENTS} events…`);
const t0 = Date.now();
const targets = [];
for (let e = 0; e < EVENTS; e++) {
  const { adminToken } = await json("POST", "/api/events", { name: `Konference ${e}`, mode: "multi", rooms: ["A", "B", "C"], date: new Date().toISOString().slice(0, 10) });
  const admin = `/api/admin/${adminToken}`;
  let v = await json("GET", admin);
  const rows = [];
  for (const r of ["A", "B", "C"]) for (let i = 0; i < 8; i++) rows.push({ startsAt: `${String(9 + i).padStart(2, "0")}:00`, durationMin: 45, title: `Přednáška ${r}${i}`, speaker: `Řečník ${i}`, room: r });
  v = await json("POST", `${admin}/import`, { rows });
  await json("PATCH", admin, { publicEnabled: true });
  v = await json("GET", admin);
  const talk = v.talks[0];
  for (let q = 0; q < 20; q++) await req("POST", `/api/qa/${talk.qaToken}/questions`, { text: `Dotaz číslo ${q} k přednášce?` }).catch(() => {});
  await json("POST", `${admin}/talks/${talk.id}/polls`, { question: "Odkud jste?", options: "Brno\nPraha\nOstrava" });
  targets.push({ admin, qa: `/api/qa/${talk.qaToken}`, player: `/api/player/${v.rooms[0].playerToken}`, pub: `/api/public/${v.event.publicPath.split("/a/")[1]}/now` });
}
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s (${EVENTS * 24} talks)`);

// ---------- traffic mix (roughly what a busy day looks like) ----------
const mix = [
  [70, t => req("GET", `${t.qa}?voter=voter-${Math.random().toString(36).slice(2, 12)}`)],      // audience phones polling
  [8, t => req("GET", `${t.player}/questions`)],                                                  // room players polling
  [4, t => req("GET", t.player)],                                                                 // room manifest sync
  [6, t => req("GET", t.pub)],                                                                    // now/next pages + door signs
  [4, t => req("GET", t.admin)],                                                                  // organizers
  [8, t => req("POST", `${t.qa}/polls/0/vote`, { voter: "x".repeat(10), answer: 0 })],            // votes (404 path, still work)
];
const total = mix.reduce((a, [w]) => a + w, 0);
const pick = () => { let r = Math.random() * total; for (const m of mix) { if ((r -= m[0]) < 0) return m[1]; } return mix[0][1]; };

const lat = [], errors = {};
let done = 0;
const end = Date.now() + SECONDS * 1000;
const rss0 = process.memoryUsage().rss;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (Date.now() < end) {
    const t = targets[Math.floor(Math.random() * targets.length)];
    const s = performance.now();
    try {
      const r = await pick()(t);
      if (r.status >= 500) errors[r.status] = (errors[r.status] || 0) + 1;
    } catch (e) { errors[e.code || "err"] = (errors[e.code || "err"] || 0) + 1; }
    lat.push(performance.now() - s);
    done++;
  }
}));
lat.sort((a, b) => a - b);
const p = q => lat[Math.floor(lat.length * q)].toFixed(1);
console.log(`requests: ${done} in ${SECONDS} s = ${(done / SECONDS).toFixed(0)} req/s (concurrency ${CONC})`);
console.log(`latency ms: p50 ${p(0.5)} · p95 ${p(0.95)} · p99 ${p(0.99)} · max ${lat.at(-1).toFixed(1)}`);
console.log(`server errors: ${JSON.stringify(errors)}`);
console.log(`memory: ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB rss (+${((process.memoryUsage().rss - rss0) / 1e6).toFixed(0)} MB during load)`);
console.log(`database: ${(fs.statSync(path.join(dataDir, "fckscrn.db")).size / 1e6).toFixed(1)} MB`);
server.close(); agent.destroy();
fs.rmSync(dataDir, { recursive: true, force: true });
