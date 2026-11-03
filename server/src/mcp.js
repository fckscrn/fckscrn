// FckScrn MCP: tools for managing an event by talking to Claude, plus the JSON-RPC handler.
// Shared by the local stdio server (mcp/fckscrn-mcp.mjs) and the hosted HTTP endpoint (/mcp).
// Every call goes through the public REST API with the event's admin token, so MCP can do
// exactly what the admin page can, nothing more.

export function tokenFrom(link) {
  const m = String(link || "").trim().match(/\/e\/([^/?#\s]+)/);
  return m ? m[1] : String(link || "").trim() || null;
}

/**
 * server:    base URL the REST calls go to
 * publicUrl: base URL shown in links (differs when running behind a proxy)
 * token:     admin token of the current event (may be null until create_event / use_event)
 */
export function createMcp({ server, publicUrl = server, token = null }) {
  const SERVER = server.replace(/\/$/, "");
  const PUBLIC = publicUrl.replace(/\/$/, "");
  let adminToken = token;

  async function http(method, path, body) {
    const res = await fetch(SERVER + path, {
      method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server odpověděl ${res.status}`);
    return data;
  }

  const admin = (method, path = "", body) => {
    if (!adminToken) throw new Error("Není vybraná akce. Založ ji (create_event) nebo vlož odkaz na správu akce (use_event).");
    return http(method, `/api/admin/${adminToken}${path}`, body);
  };

  // ---------- helpers ----------

  const adminUrl = () => `${PUBLIC}/e/${adminToken}`;
  const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const toTime = n => `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  const STATUS = { missing: "chybí soubor", processing: "zpracovává se", ready: "připraveno", warning: "ke kontrole", error: "chyba" };

  function findRoom(view, name) {
    if (!name) {
      if (view.rooms.length === 1) return view.rooms[0];
      throw new Error(`Akce má víc sálů (${view.rooms.map(r => r.name).join(", ")}). Řekni, do kterého.`);
    }
    const n = name.toLowerCase().trim();
    const r = view.rooms.find(r => r.name.toLowerCase() === n) || view.rooms.find(r => r.name.toLowerCase().includes(n));
    if (!r) throw new Error(`Sál „${name}“ neexistuje. Sály: ${view.rooms.map(r => r.name).join(", ")}.`);
    return r;
  }

  function findTalk(view, ref) {
    if (ref == null || ref === "") throw new Error("Řekni, kterou přednášku (číslo nebo část názvu).");
    if (/^\d+$/.test(String(ref))) {
      const t = view.talks.find(t => t.id === +ref);
      if (t) return t;
    }
    const n = String(ref).toLowerCase();
    const hits = view.talks.filter(t => t.title.toLowerCase().includes(n) || (t.speaker || "").toLowerCase().includes(n) || t.startsAt === ref);
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`Nic jako „${ref}“ v programu není.`);
    throw new Error(`„${ref}“ odpovídá víc položkám: ${hits.map(t => `#${t.id} ${t.startsAt || ""} ${t.title}`).join("; ")}. Upřesni.`);
  }

  function nextStart(view, roomId) {
    const list = view.talks.filter(t => t.roomId === roomId && t.startsAt);
    return list.length ? toTime(Math.max(...list.map(t => toMin(t.startsAt) + t.durationMin))) : "09:00";
  }

  function program(view) {
    const lines = [`${view.event.name}${view.event.date ? ` · ${view.event.date}` : ""}${view.event.place ? ` · ${view.event.place}` : ""}`];
    for (const r of view.rooms) {
      if (view.rooms.length > 1 || view.event.mode !== "single") lines.push(`\n## ${r.name}${r.playerOnline ? " (projekce připojena)" : ""}`);
      const list = view.talks.filter(t => t.roomId === r.id);
      if (!list.length) lines.push("  (zatím prázdno)");
      for (const t of list) {
        const end = t.startsAt ? `–${toTime(toMin(t.startsAt) + t.durationMin)}` : "";
        lines.push(t.kind === "break"
          ? `  #${t.id} ${t.startsAt || "--:--"}${end}  ☕ ${t.title}`
          : t.kind === "panel" // a panel needs no file
          ? `  #${t.id} ${t.startsAt || "--:--"}${end}  🎙 ${t.title}${t.moderator ? ` – moderuje ${t.moderator}` : ""}${t.panelists?.length ? ` (${t.panelists.join(", ")})` : ""}  [panel]`
          : `  #${t.id} ${t.startsAt || "--:--"}${end}  ${t.title}${t.speaker ? ` – ${t.speaker}` : ""}  [${STATUS[t.status] || t.status}]`);
      }
    }
    return lines.join("\n");
  }

  // ---------- tools ----------

  const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
  const str = d => ({ type: "string", description: d });
  const int = d => ({ type: "integer", description: d });

  const tools = {
    create_event: {
      description: "Založí novou akci. Vrátí tajný odkaz na správu (ten si ulož, je to jediný přístup). Další nástroje pak pracují s touto akcí.",
      inputSchema: S({
        name: str("Název akce"), date: str("Datum YYYY-MM-DD"), place: str("Místo"),
        mode: { type: "string", enum: ["single", "multi"], description: "single = jeden sál, multi = víc sálů" },
        rooms: { type: "array", items: { type: "string" }, description: "Názvy sálů (jen pro multi)" },
      }, ["name"]),
      async run(a) {
        const r = await http("POST", "/api/events", { name: a.name, date: a.date, place: a.place, mode: a.mode || (a.rooms?.length > 1 ? "multi" : "single"), rooms: a.rooms });
        adminToken = r.adminToken;
        const v = await admin("GET");
        return `Akce založena. Správa (tajný odkaz, ulož si ho): ${adminUrl()}\n\n${program(v)}`;
      },
    },
    use_event: {
      description: "Přepne na existující akci podle odkazu na její správu (https://…/e/…).",
      inputSchema: S({ admin_link: str("Odkaz na správu akce") }, ["admin_link"]),
      async run(a) { adminToken = tokenFrom(a.admin_link); return program(await admin("GET")); },
    },
    get_program: {
      description: "Vypíše program akce po sálech: čas, název, řečník, stav prezentace. Čísla #id slouží k úpravám.",
      inputSchema: S({}),
      async run() { return program(await admin("GET")); },
    },
    add_talk: {
      description: "Přidá přednášku. Bez času začne tam, kde skončil předchozí blok v sále. Bez délky 20 minut.",
      inputSchema: S({ title: str("Název přednášky"), speaker: str("Řečník"), starts_at: str("Začátek HH:MM"), duration_min: int("Délka v minutách"), room: str("Sál (u víc sálů)") }, ["title"]),
      async run(a) {
        let v = await admin("GET");
        const room = findRoom(v, a.room);
        const startsAt = a.starts_at || nextStart(v, room.id);
        v = await admin("POST", "/talks", { roomId: room.id, title: a.title, speaker: a.speaker, startsAt, durationMin: a.duration_min || 20 });
        const t = v.talks.filter(t => t.title === a.title).at(-1);
        return `Přidáno: ${startsAt} ${a.title}${a.speaker ? ` – ${a.speaker}` : ""}.\nOdkaz pro řečníka: ${PUBLIC}/s/${t.speakerToken}\n\n${program(v)}`;
      },
    },
    add_break: {
      description: "Přidá přestávku (na projekci poběží smyčka partnerů). Bez času navazuje na předchozí blok, bez délky 15 minut.",
      inputSchema: S({ title: str("Např. Přestávka na kávu, Oběd"), starts_at: str("Začátek HH:MM"), duration_min: int("Délka v minutách"), room: str("Sál") }),
      async run(a) {
        let v = await admin("GET");
        const room = findRoom(v, a.room);
        const startsAt = a.starts_at || nextStart(v, room.id);
        v = await admin("POST", "/talks", { kind: "break", roomId: room.id, title: a.title, startsAt, durationMin: a.duration_min || 15 });
        return `Přestávka přidána od ${startsAt}.\n\n${program(v)}`;
      },
    },
    update_talk: {
      description: "Upraví přednášku nebo přestávku (čas, délku, název, řečníka, sál). Položku najde podle #id, části názvu nebo jména řečníka.",
      inputSchema: S({ talk: str("#id, část názvu nebo řečník"), title: str("Nový název"), speaker: str("Nový řečník"), starts_at: str("Nový začátek HH:MM"), duration_min: int("Nová délka"), room: str("Přesunout do sálu") }, ["talk"]),
      async run(a) {
        let v = await admin("GET");
        const t = findTalk(v, a.talk);
        const body = {};
        if (a.title !== undefined) body.title = a.title;
        if (a.speaker !== undefined) body.speaker = a.speaker;
        if (a.starts_at !== undefined) body.startsAt = a.starts_at;
        if (a.duration_min !== undefined) body.durationMin = a.duration_min;
        if (a.room !== undefined) body.roomId = findRoom(v, a.room).id;
        v = await admin("PATCH", `/talks/${t.id}`, body);
        return `Upraveno: #${t.id}.\n\n${program(v)}`;
      },
    },
    delete_talk: {
      description: "Smaže přednášku nebo přestávku i s nahraným souborem. Před smazáním se uživatele zeptej.",
      inputSchema: S({ talk: str("#id, část názvu nebo řečník") }, ["talk"]),
      async run(a) {
        const t = findTalk(await admin("GET"), a.talk);
        const v = await admin("DELETE", `/talks/${t.id}`);
        return `Smazáno: ${t.title}.\n\n${program(v)}`;
      },
    },
    add_room: {
      description: "Přidá sál (akce se přepne na víc sálů).",
      inputSchema: S({ name: str("Název sálu") }, ["name"]),
      async run(a) {
        let v = await admin("GET");
        if (v.event.mode === "single") await admin("PATCH", "", { mode: "multi" });
        v = await admin("POST", "/rooms", { name: a.name });
        return `Sál „${a.name}“ přidán. Sály: ${v.rooms.map(r => r.name).join(", ")}.`;
      },
    },
    rename_room: {
      description: "Přejmenuje sál.",
      inputSchema: S({ room: str("Současný název"), name: str("Nový název") }, ["room", "name"]),
      async run(a) {
        const r = findRoom(await admin("GET"), a.room);
        const v = await admin("PATCH", `/rooms/${r.id}`, { name: a.name });
        return `Sály: ${v.rooms.map(r => r.name).join(", ")}.`;
      },
    },
    speaker_links: {
      description: "Odkazy pro řečníky (každý si přes svůj nahraje prezentaci). Volitelně jen těm, kdo ještě nenahráli.",
      inputSchema: S({ only_missing: { type: "boolean", description: "Jen řečníci bez nahrané prezentace" } }),
      async run(a) {
        const v = await admin("GET");
        const list = v.talks.filter(t => t.kind !== "break" && (!a.only_missing || t.status === "missing"));
        if (!list.length) return a.only_missing ? "Všichni řečníci už nahráli." : "V programu zatím nejsou přednášky.";
        return list.map(t => `${t.speaker || "(bez řečníka)"} – ${t.title} [${STATUS[t.status]}]\n  ${PUBLIC}/s/${t.speakerToken}`).join("\n");
      },
    },
    event_status: {
      description: "Přehled akce: kolik prezentací je nahráno, co je ke kontrole, připojené sály, aktivace a kdy se akce smaže.",
      inputSchema: S({}),
      async run() {
        const v = await admin("GET");
        const talks = v.talks.filter(t => t.kind !== "break");
        const by = s => talks.filter(t => t.status === s);
        const out = [
          `${v.event.name}: nahráno ${by("ready").length + by("warning").length}/${talks.length}, chybí ${by("missing").length}, ke kontrole ${by("warning").length + by("error").length}.`,
          `Sály: ${v.rooms.map(r => `${r.name} (${r.playerOnline ? "projekce připojena" : "nepřipojeno"})`).join(", ")}.`,
          `Smyčka partnerů: ${v.media.length} položek.`,
        ];
        for (const t of [...by("warning"), ...by("error")]) out.push(`⚠ ${t.title}: ${t.issues.filter(i => i.level !== "ok").map(i => i.text).join(" ")}`);
        if (v.billing?.enabled) out.push(`Aktivace: ${{ trial: "zkušební režim (vodoznak na projekci)", ordered: "aktivní, čeká se na úhradu", paid: "aktivní a zaplaceno" }[v.billing.status]}.`);
        if (v.event.expiresAt) out.push(`Akce se smaže ${v.event.expiresAt}.`);
        out.push(`Správa: ${adminUrl()}`);
        return out.join("\n");
      },
    },
  };

async function handle(msg) {
    const send = m => ({ jsonrpc: "2.0", ...m });
  const { id, method, params } = msg;
  if (id === undefined) return null; // notifications (initialized, cancelled…)
  try {
    if (method === "initialize") {
      return send({ id, result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fckscrn", version: "0.1.0" },
        instructions: "Správa akce ve fckscrn: program, sály, přestávky, odkazy pro řečníky. Časy HH:MM, délky v minutách. Mluv česky.",
      } });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") {
      return send({ id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
    }
    if (method === "tools/call") {
      const tool = tools[params?.name];
      if (!tool) return send({ id, error: { code: -32602, message: `Neznámý nástroj ${params?.name}` } });
      try {
        const text = await tool.run(params.arguments || {});
        return send({ id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        return send({ id, result: { content: [{ type: "text", text: e.message }], isError: true } });
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ id, error: { code: -32603, message: e.message } });
  }
}

  return { handle, tools, get token() { return adminToken; } };
}
