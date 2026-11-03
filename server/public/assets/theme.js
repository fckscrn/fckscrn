// Light/dark toggle. Loaded in <head> (not a module) so the page never flashes the wrong theme.
(function () {
  var KEY = "fckscrn-theme";
  var root = document.documentElement;
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function isDark() {
    var t = root.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  }
  var s = saved();
  if (s === "dark" || s === "light") root.dataset.theme = s;

  function sync(btn) {
    var dark = isDark();
    btn.setAttribute("aria-pressed", String(dark));
    var en = root.lang === "en";
    btn.title = en ? (dark ? "Switch to light mode" : "Switch to dark mode") : (dark ? "Přepnout na světlý režim" : "Přepnout na tmavý režim");
    btn.setAttribute("aria-label", btn.title); // on phones only the icon shows
    btn.querySelector("span").textContent = en ? (dark ? "Dark" : "Light") : (dark ? "Tmavý" : "Světlý");
  }
  document.addEventListener("click", function (e) {
    document.querySelectorAll("details.langmenu[open]").forEach(function (d) { if (!d.contains(e.target)) d.open = false; });
  });
  document.addEventListener("DOMContentLoaded", function () {
    var top = document.querySelector(".top");
    if (!top) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    btn.innerHTML = '<i aria-hidden="true"></i><span></span>';
    btn.onclick = function () {
      var next = isDark() ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch (e) {}
      sync(btn);
    };
    top.append(btn);
    sync(btn);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { sync(btn); });
    // follow the CZ / EN switch
    new MutationObserver(function () { sync(btn); }).observe(root, { attributes: true, attributeFilter: ["lang"] });
  });
})();
