// Offline support. Big files that never change (piano samples, hand-tracking model and library) are
// served from the cache; the app's own pages and code are fetched fresh when online (so updates
// arrive) and fall back to the cache when offline. Nothing about the player is stored here.
// Bump this whenever anything in samples/ or vendor/ changes (those are served cache-first).
const CACHE = 'desk-piano-v1';
const BIG = /\/(samples|vendor)\//;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (BIG.test(new URL(req.url).pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
  } else {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw new Error('offline and not cached');
      }
    })());
  }
});
