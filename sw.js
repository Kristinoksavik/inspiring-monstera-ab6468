// Fotomaleri Light — service worker (offline-støtte)
// Nettet først: appen henter alltid nyeste versjon når du er på nett,
// og faller tilbake til den lagrede kopien når du ikke er det.
const CACHE = 'fotomaleri-light-v1';

self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(function (resp) {
        const copy = resp.clone();
        caches.open(CACHE).then(function (c) {
          try { c.put(e.request, copy); } catch (err) {}
        });
        return resp;
      })
      .catch(function () {
        return caches.match(e.request);
      })
  );
});
