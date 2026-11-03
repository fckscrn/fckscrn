// Speaker monitor window (desktop and web): the shared view, driven by the room state.
import { bindKeys, subscribe } from "./shared.js";
import { mountPresenter } from "./presenter-view.mjs";

const view = mountPresenter(document.body);
bindKeys();
subscribe(view.render);
setInterval(view.tick, 500);
addEventListener("resize", view.refit);
