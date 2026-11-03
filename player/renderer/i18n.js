// Czech / English for the room screens. Same rules as the website: saved choice → browser (cs/sk → Czech) → English.
const KEY = "fckscrn-lang";
function detect() {
  try { const s = localStorage.getItem(KEY); if (s === "cs" || s === "en") return s; } catch {}
  return /^(cs|sk)\b/i.test(navigator.language || "") ? "cs" : "en";
}
export let lang = detect();
document.documentElement.lang = lang;

/** L("česky", "English") */
export const L = (cs, en) => (lang === "en" ? en : cs);

/** CZ | EN switch in the header; onChange re-renders. */
export function langSwitch(onChange) {
  const top = document.querySelector(".top");
  if (!top || top.querySelector(".lang")) return;
  const box = document.createElement("div");
  box.className = "lang seg";
  for (const l of ["cs", "en"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = l === "cs" ? "CZ" : "EN";
    b.setAttribute("aria-pressed", String(l === lang));
    b.onclick = () => {
      lang = l;
      document.documentElement.lang = l;
      try { localStorage.setItem(KEY, l); } catch {}
      box.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      onChange?.();
    };
    box.append(b);
  }
  top.append(box);
}
