import { esc } from "./common.js";
import { t } from "./i18n.js";

/**
 * Plays the partner loop exactly like the projection does: photos for N seconds,
 * videos to the end (muted), cross-fade, "Next: …" bar at the bottom.
 * items: [{ kind, url, durationSec, fileName }], next: { title, speaker, startsAt } | null
 */
export function playLoop(items, next) {
  const dlg = document.createElement("dialog");
  dlg.className = "loopplay";
  dlg.innerHTML = `
    <div class="lp-stage"><div class="lp-layers"></div>
      <div class="lp-bar">${next
        ? `${t({ cs: "Další", en: "Next" })}: <b>${esc(next.title)}</b>${next.speaker ? " · " + esc(next.speaker) : ""}${next.startsAt ? " · " + esc(next.startsAt) : ""}`
        : t({ cs: "Lišta s další přednáškou", en: "Bar with the next talk" })}</div>
    </div>
    <div class="lp-tools">
      <span class="lp-now mono"></span>
      <span class="lp-err"></span>
      <button class="btn small" data-full>${t({ cs: "Celá obrazovka", en: "Fullscreen" })}</button>
      <button class="btn small primary" data-close>${t({ cs: "Zavřít", en: "Close" })}</button>
    </div>`;
  document.body.append(dlg);
  const layers = dlg.querySelector(".lp-layers");
  let i = -1, timer = null, stopped = false;

  function show() {
    if (stopped) return;
    clearTimeout(timer);
    i = (i + 1) % items.length;
    const m = items[i];
    dlg.querySelector(".lp-now").textContent = `${i + 1}/${items.length} · ${m.fileName}`;
    let node;
    if (m.kind === "video") {
      node = document.createElement("video");
      Object.assign(node, { src: m.url, muted: true, autoplay: true, playsInline: true });
      if (items.length === 1) node.loop = true;
      node.onended = show;
      node.onerror = () => {
        // typically a .mov in a codec browsers can't play (HEVC); say so instead of a black screen
        dlg.querySelector(".lp-err").textContent = t({
          cs: `„${m.fileName}“ prohlížeč neumí přehrát. Uložte video jako MP4 (H.264).`,
          en: `The browser can't play “${m.fileName}”. Save the video as MP4 (H.264).`,
        });
        timer = setTimeout(show, 1500);
      };
    } else {
      node = document.createElement("img");
      node.src = m.url;
      if (items.length > 1) timer = setTimeout(show, m.durationSec * 1000);
    }
    node.className = "lp-item";
    layers.append(node);
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("in")));
    setTimeout(() => { while (layers.children.length > 1 && layers.firstChild !== node) layers.firstChild.remove(); }, 900);
  }

  const stop = () => { stopped = true; clearTimeout(timer); dlg.remove(); };
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  dlg.querySelector("[data-full]").onclick = () => dlg.querySelector(".lp-stage").requestFullscreen?.();
  dlg.addEventListener("close", stop);
  dlg.showModal();
  show();
}
