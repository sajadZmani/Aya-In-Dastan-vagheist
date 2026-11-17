/*
 * Keeps the game's files on the phone so the one-phone game opens without internet.
 * Network first (so updates arrive as soon as there is internet), the saved copy when offline.
 * The online rooms (socket.io) are never cached.
 */
const CACHE = 'ayaa-v2';
const FILES = [
  '/', '/index.html', '/style.css', '/app.js', '/core.js', '/manifest.webmanifest', '/icon.svg',
  '/data/blocklist.json',
  '/fonts/vazirmatn-arabic-400-normal.woff2', '/fonts/vazirmatn-arabic-700-normal.woff2',
  '/fonts/vazirmatn-arabic-900-normal.woff2', '/fonts/vazirmatn-latin-700-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/socket.io/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('/index.html')))
  );
});
