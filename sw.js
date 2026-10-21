// Offline support. Big files that never change (piano samples, hand-tracking model and library) are
// served from the cache; the app's own pages and code are fetched fresh when online (so updates
// arrive) and fall back to the cache when offline. Nothing about the player is stored here.
// Bump this whenever anything in samples/ or vendor/ changes (those are served cache-first).
const CACHE = 'desk-piano-v1';
const BIG = /\/(samples|vendor)\//;

// The app's own files, saved at install so the app also works offline after just one visit
// (on the first visit the page loads before this worker is in control). Missing files are skipped.
const APP = ['./', 'index.html', 'print.html', 'help.html', 'src/app.js', 'src/auto-tune.js', 'src/desk.js', 'src/fusion.js', 'src/hand-connections.js', 'src/hand-ids.js', 'src/homography.js', 'src/layout.js', 'src/marker-worker.js', 'src/markers.js', 'src/metronome.js', 'src/midi.js', 'src/notes.js', 'src/onset.js', 'src/paper.js', 'src/piano.js', 'src/print-page.js', 'src/reverb.js', 'src/settings.js', 'src/strike.js', 'src/style.css', 'src/synths.js', 'src/tap-fusion.js', 'src/tap-resolver.js', 'src/tap-worklet.js', 'src/tunes.js'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(APP.map((u) => cache.add(new Request(u, { cache: 'no-cache' })).catch(() => {})));
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// the page sends the big files it loaded before this worker was running (see saveForOffline)
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'cache' || !Array.isArray(e.data.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of e.data.urls) {
      const url = new URL(u, self.registration.scope);
      if (url.origin !== location.origin || !BIG.test(url.pathname)) continue; // only our own big files
      if (!(await cache.match(url))) await cache.add(url).catch(() => {});
    }
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
      if (res.ok) e.waitUntil(cache.put(req, res.clone()));
      return res;
    })());
  } else {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' }); // revalidate: no stale modules after a deploy
        // one copy per file: store without the query (?debug=1 etc.); offline lookups ignore it anyway
        const key = new URL(req.url); key.search = '';
        if (res.ok) e.waitUntil(cache.put(key.href, res.clone()));
        return res;
      } catch {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw new Error('offline and not cached');
      }
    })());
  }
});
