// Service worker: rede primeiro (sempre pega a versão nova), com cópia guardada para abrir sem internet.
const CACHE = "arena-v3";
const FILES = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FILES.map((f) => c.add(f).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin !== location.origin || u.pathname === "/healthz") return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match("/index.html")))
  );
});
