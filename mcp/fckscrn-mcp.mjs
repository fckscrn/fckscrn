#!/usr/bin/env node
// fckscrn MCP server over stdio, for a local Claude Code / self-hosted fckscrn.
// Hosted fckscrn has the same tools over HTTP at https://<server>/mcp (see /napoveda#claude).
//
//   claude mcp add fckscrn -e FCKSCRN_URL=http://localhost:8080 -e FCKSCRN_EVENT=<admin link> -- node /path/to/mcp/fckscrn-mcp.mjs
//
// FCKSCRN_URL    server (default http://localhost:8080)
// FCKSCRN_EVENT  optional: admin link (https://…/e/<token>) of the event to work with
import readline from "node:readline";
import { createMcp, tokenFrom } from "../server/src/mcp.js";

const server = process.env.FCKSCRN_URL || "http://localhost:8080";
const mcp = createMcp({ server, token: tokenFrom(process.env.FCKSCRN_EVENT) });
const out = msg => process.stdout.write(JSON.stringify(msg) + "\n");

readline.createInterface({ input: process.stdin }).on("line", async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const res = await mcp.handle(msg);
  if (res) out(res);
});
