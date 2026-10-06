/* Keeps the app working with no connection (an indoor track often has none).
   The app is always opened from the copy saved on the phone: it starts at once, and a weak signal in a
   metal hall cannot make it hang. A new version is fetched as a whole in the background when there is
   a connection, and replaces the saved copy only when every file of it has arrived. */
const CACHE = "apex-trace-kart-2.5.0";
const FILES = ["./", "index.html", "app.css", "core.js", "indoor.js", "export.js", "sim.js", "app.js", "accuracy.js", "validation.html", "validation-ui.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(FILES.map(f => fetch(new Request(f, { cache: "reload" })).then(r => { if (!r.ok) throw new Error("could not fetch " + f); return c.put(f, r); }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("apex-trace-kart-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: true }))
    .then(hit => hit || fetch(e.request).catch(() => caches.match("index.html"))));
});
