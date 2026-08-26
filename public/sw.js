// Service worker for the AHS Site Safety Inspection app (rev 3).
// Deploy next to index.html (e.g. public/sw.js). The app registers it only
// when served over http(s); opened from disk it does nothing.
//
// Strategy:
//   - App document (index.html): NETWORK-FIRST with a 3.5s timeout, cache
//     fallback. A new build shows as soon as the device has signal; a poor
//     connection or being fully offline falls back to the cached copy. (This
//     replaced the old cache-first shell, which left iPads/PWAs a build behind
//     after each deploy and could get stuck there.)
//   - The two CDN PDF libraries: cache-first (versioned URLs, never change).
//   - /api/ requests: never cached (always network) — sync handles retries.
//   - Everything else: network first, cache fallback.
// Still bump CACHE when you ship a build so old cached entries are dropped.
const CACHE = 'ahs-ssi-rev4-17';
const SHELL = ['./index.html'];
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
];

self.addEventListener('install', (e) => {
  // index.html must cache or install fails; the PDF libraries are best-effort
  // here and are also cached the first time the page loads them.
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL);
    await Promise.all(LIBS.map((u) => c.add(u).catch(() => null)));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) return; // sync traffic: straight to network

  // App document: network-first with a short timeout, cache fallback, so a new
  // build appears the moment the device is online instead of a load (or several)
  // behind. Offline or slow signal still gets the cached shell immediately after.
  if (req.mode === 'navigate' || /\/index\.html$/.test(url.pathname)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const key = req.mode === 'navigate' ? './index.html' : req;
      try {
        const net = await Promise.race([
          fetch(req, { cache: 'no-store' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
        ]);
        if (net && net.ok) { c.put(key, net.clone()); return net; }
      } catch (_) { /* offline or too slow — fall back to cache below */ }
      const cached = await c.match(key);
      return cached || new Response('Offline and the app has not been cached yet. Open it once with signal.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    })());
    return;
  }

  // CDN PDF libraries: cache-first (the URLs are version-pinned and immutable)
  if (/cdnjs\.cloudflare\.com/.test(req.url)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const cached = await c.match(req);
      return cached || fetch(req).then((res) => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => cached);
    }));
    return;
  }

  // everything else: network first, cache fallback
  e.respondWith(fetch(req).then((res) => {
    if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
    return res;
  }).catch(() => caches.match(req)));
});
