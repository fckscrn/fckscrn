// What's on now and next in a room: the room player's live state wins, otherwise the schedule by the clock.
const toMin = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };

export function nowNext(room, event, at = new Date()) {
  const today = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  const talks = room.talks.filter(x => x.startsAt);
  const m = at.getHours() * 60 + at.getMinutes();
  const live = room.liveTalkId && room.talks.find(x => x.id === room.liveTalkId);
  if (live) {
    const i = room.talks.indexOf(live);
    return { now: live, next: room.talks.slice(i + 1).find(x => x.startsAt) || null, live: true };
  }
  if (event.date && event.date !== today) return { now: null, next: event.date > today ? talks[0] || null : null, live: false };
  return {
    now: talks.find(x => toMin(x.startsAt) <= m && m < toMin(x.startsAt) + x.durationMin) || null,
    next: talks.find(x => toMin(x.startsAt) > m) || null,
    live: false,
  };
}

export const whoOf = (x, L) => x.kind === "panel"
  ? [x.moderator && `${L.moderator} ${x.moderator}`, (x.panelists || []).join(", ")].filter(Boolean).join(" · ")
  : x.kind === "break" ? "" : x.speaker || "";
