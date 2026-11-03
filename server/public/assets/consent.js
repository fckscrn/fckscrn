// Cookie bar for analytics (Google Consent Mode v2). Nothing is measured with cookies until "Allow".
// The choice is remembered; "Cookies" in the footer opens the bar again.
(() => {
  const KEY = "fckscrn-consent";
  const en = document.documentElement.lang === "en";
  const T = en
    ? { text: "We'd like to measure how people use this site (Google Analytics). Only if you allow it.", yes: "Allow", no: "Decline", link: "Cookies" }
    : { text: "Rádi bychom měřili, jak se web používá (Google Analytics). Jen pokud to povolíte.", yes: "Povolit", no: "Odmítnout", link: "Cookies" };
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const set = v => { try { localStorage.setItem(KEY, v); } catch {} };
  const grant = v => window.gtag?.("consent", "update", v === "yes"
    ? { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" }
    : { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });

  function show() {
    if (document.getElementById("consent")) return;
    const bar = document.createElement("div");
    bar.id = "consent";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", T.link);
    bar.innerHTML = `<span>${T.text}</span><span class="consent-btns"><button type="button" class="btn small" data-c="no">${T.no}</button><button type="button" class="btn small primary" data-c="yes">${T.yes}</button></span>`;
    bar.querySelectorAll("[data-c]").forEach(b => (b.onclick = () => { set(b.dataset.c); grant(b.dataset.c); bar.remove(); }));
    document.body.append(bar);
  }
  if (!get()) show();
  // a way back to the choice, in the footer
  const foot = document.querySelector("footer.credit");
  if (foot) {
    const a = document.createElement("button");
    a.type = "button"; a.className = "linkbtn consent-link"; a.textContent = T.link;
    a.onclick = show;
    foot.append(" · ", a);
  }
})();
