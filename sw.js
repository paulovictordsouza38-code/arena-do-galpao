// Service worker mínimo: deixa o jogo instalável. Sempre busca a versão nova na internet
// (o jogo só funciona online mesmo), então nunca fica preso numa versão antiga.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).catch(function () {
    return new Response("Sem internet. Abra o jogo de novo quando estiver conectado.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }));
});
