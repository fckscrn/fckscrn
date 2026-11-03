// Live link between a room player and the server: the player pushes what's on (for the phone
// remote and the organizer) and receives commands (phone clicker, organizer messages).
// Plain fetch streaming, so it runs in the browser (web player) and in Electron's main process.
// Optional: when the server can't be reached the player works exactly as before.

import { waiting, showing } from "./videos.mjs";

export function createLiveLink({ server = "", token, onCmd, fetchImpl = fetch }) {
  const base = `${server}/api/player/${encodeURIComponent(token)}/live`;
  let stopped = false, ctrl = null, lastKey = "", pending = null, timer = null;

  async function listen() {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await fetchImpl(base, { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok || !res.body) throw new Error(`live ${res.status}`);
        lastKey = ""; // a fresh connection: send the state again
        flush();
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, i).split("\n").find(l => l.startsWith("data: "));
            buf = buf.slice(i + 2);
            if (!line) continue;
            try { const m = JSON.parse(line.slice(6)); if (m.type === "cmd") onCmd(m.cmd, m.arg); } catch {}
          }
        }
      } catch {}
      if (!stopped) await new Promise(r => setTimeout(r, 3000));
    }
  }

  function flush() {
    if (!pending) return;
    const key = JSON.stringify(pending);
    if (key === lastKey) return;
    lastKey = key;
    fetchImpl(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: key }).catch(() => { lastKey = ""; });
  }

  // state: { live, message, help, nextTalkId } — coalesced, only changes are sent
  function push(state) {
    // the phone shows "▶ Play video" instead of "Next" when the next click starts a video
    const talk = state.live?.mode === "pdf" && state.talks?.find(t => t.id === state.live.talkId);
    const video = talk ? (waiting(state.live, talk) ? "waiting" : showing(state.live, talk).length ? "playing" : null) : null;
    pending = { live: state.live ? { ...state.live, video } : null, message: state.message || null, help: state.help || null, nextTalkId: state.nextTalkId ?? null };
    clearTimeout(timer);
    timer = setTimeout(flush, 120);
  }

  listen();
  // re-send now and then so the server's "room online" stays fresh during long talks
  const keepAlive = setInterval(() => { lastKey = ""; flush(); }, 60_000);
  return { push, stop() { stopped = true; clearInterval(keepAlive); ctrl?.abort(); } };
}
