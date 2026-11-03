// Which physical screen does what. Shared by the desktop app (main process) and the web player.
//   ctrl = control window (technician) · proj = audience projection · spk = speaker monitor · off = unused
//   both = control + speaker monitor in one window: only with exactly two screens (laptop + projector),
//          where it is the default. With one screen (rehearsal) or three+ the roles stay separate.

export const bothAllowed = displays => displays.length === 2;
const covers = r => (r === "both" ? ["ctrl", "spk"] : r && r !== "off" ? [r] : []);

/**
 * @param displays [{ id, primary, internal }]
 * @param saved    { [displayId]: role }
 * @returns        { [displayId]: role } with at most one ctrl/proj/spk (both counts as ctrl + spk)
 */
export function resolveRoles(displays, saved = {}) {
  const roles = {};
  const taken = new Set();
  const allowBoth = bothAllowed(displays);
  for (const d of displays) {
    let r = saved[d.id];
    if (r === "both" && !allowBoth) r = undefined; // a third screen appeared: back to separate roles
    if (!r) continue;
    if (r === "off" || covers(r).every(x => !taken.has(x))) { roles[d.id] = r; covers(r).forEach(x => taken.add(x)); }
  }
  // defaults: control on the built-in/primary screen, then projection, then speaker monitor
  const order = [...displays].sort((a, b) => score(b) - score(a));
  const defaulted = new Set();
  for (const d of order) {
    if (roles[d.id]) continue;
    const r = ["ctrl", "proj", "spk"].find(x => !taken.has(x)) || "off";
    roles[d.id] = r;
    defaulted.add(d.id);
    if (r !== "off") taken.add(r);
  }
  // laptop + projector: the laptop shows the speaker monitor together with the controls
  if (allowBoth && taken.has("proj") && !taken.has("spk")) {
    const c = displays.find(d => roles[d.id] === "ctrl" && defaulted.has(d.id));
    if (c) roles[c.id] = "both";
  }
  return roles;
}

const score = d => (d.internal ? 2 : 0) + (d.primary ? 1 : 0);

/** Setting a role moves it away from whichever screen had it ("both" gives up only the clashing half). */
export function assignRole(saved, displays, displayId, role) {
  const next = { ...resolveRoles(displays, saved), [displayId]: role };
  const mine = covers(role);
  for (const id of Object.keys(next)) {
    if (String(id) === String(displayId)) continue;
    const left = covers(next[id]).filter(x => !mine.includes(x));
    if (left.length === covers(next[id]).length) continue;
    if (left[0]) next[id] = left[0];
    else if (bothAllowed(displays)) delete next[id]; // two screens: the other one falls back to its default (projection)
    else next[id] = "off";
  }
  return next;
}
