// Service worker for the AHS Site Safety Inspection app (rev 3).
// Deploy next to index.html (e.g. public/sw.js). The app registers it only
// when served over http(s); opened from disk it does nothing.
//
// Strategy:
//   - App shell (index.html + the two CDN libraries): cached on install,
//     served cache-first, refreshed in the background when online, so the
//     app opens with no signal once it has been opened once.
//   - /api/ requests: never cached (always network) — sync handles retries.
//   - Everything else: network first, cache fallback.
// Bump CACHE when you ship a new build so old shells are dropped.
const CACHE = 'ahs-ssi-rev4-7';
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

  const isShell = req.mode === 'navigate' || /\/index\.html$/.test(url.pathname) || /cdnjs\.cloudflare\.com/.test(req.url);

  if (isShell) {
    // cache-first, then refresh the cached copy in the background
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const key = req.mode === 'navigate' ? './index.html' : req;
      const cached = await c.match(key);
      const refresh = fetch(req).then((res) => { if (res && res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
      return cached || (await refresh) || new Response('Offline and the app has not been cached yet. Open it once with signal.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }));
    return;
  }

  // everything else: network first, cache fallback
  e.respondWith(fetch(req).then((res) => {
    if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
    return res;
  }).catch(() => caches.match(req)));
});
