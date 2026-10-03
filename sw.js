/* Keeps the app working with no connection (an indoor track often has none). */
const CACHE = "apex-trace-kart-2.0.0";
const FILES = ["./", "index.html", "app.css", "core.js", "sim.js", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // the page from the network when there is one (so an update arrives), from the cache when there is not
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
