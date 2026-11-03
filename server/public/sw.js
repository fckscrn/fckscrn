// FckScrn service worker: keeps the web player working when the venue wifi dies.
// Presentation and loop files are put into FILES by the player itself (cache-first);
// the player app shell is network-first with a cached fallback.
const SHELL = "fckscrn-shell-v1";
const FILES = "fckscrn-files";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  if (/^\/api\/player\/[^/]+\/(talks|media)\//.test(url.pathname)) {
    e.respondWith(caches.open(FILES).then(c => c.match(req)).then(hit => hit || fetch(req)));
    return;
  }
  const shell = url.pathname.startsWith("/p/") || url.pathname.startsWith("/player/") ||
    url.pathname.startsWith("/vendor/pdfjs/") || url.pathname.startsWith("/assets/");
  if (!shell) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || Response.error()))
  );
});
