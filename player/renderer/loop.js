// Partner loop: photos for N seconds, videos to the end (muted), cross-faded.
import { env } from "./shared.js";
export class Loop {
  constructor(el) {
    this.el = el;
    this.items = [];
    this.key = "";
    this.i = -1;
    this.timer = null;
  }

  /** Start/keep playing these items. Same list = no restart. */
  play(items) {
    const key = items.map(m => m.id).join(",");
    if (key === this.key && this.timer !== null) return;
    this.stop();
    this.key = key;
    this.items = items;
    if (!items.length) return;
    this.i = -1;
    this.next();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.key = "";
    this.el.replaceChildren();
  }

  next() {
    clearTimeout(this.timer);
    this.timer = 0; // playing
    this.i = (this.i + 1) % this.items.length;
    const m = this.items[this.i];
    const src = env.mediaUrl(m);
    let node;
    if (m.kind === "video") {
      node = document.createElement("video");
      Object.assign(node, { src, muted: true, autoplay: true, playsInline: true });
      // one-item loop: just repeat the video
      if (this.items.length === 1) node.loop = true;
      node.onended = () => this.next();
      node.onerror = () => { this.timer = setTimeout(() => this.next(), 500); };
    } else {
      node = document.createElement("img");
      node.src = src;
      node.onerror = () => { this.timer = setTimeout(() => this.next(), 500); };
      if (this.items.length > 1) this.timer = setTimeout(() => this.next(), m.durationSec * 1000);
    }
    node.className = "loop-item";
    this.el.append(node);
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("in")));
    // drop older layers once the new one has faded in
    setTimeout(() => { while (this.el.children.length > 1 && this.el.firstChild !== node) this.el.firstChild.remove(); }, 900);
  }
}
