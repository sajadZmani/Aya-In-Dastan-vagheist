/*
 * Keeps the game's files on the phone so it opens without internet (like an app).
 * Network first (so updates arrive as soon as there is internet), the saved copy when offline.
 * Paths are relative, so it works at the site root or under a GitHub Pages project path.
 */
const CACHE = 'ayaa-v3';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'core.js', 'data/blocklist.js', 'manifest.webmanifest', 'icon.svg',
  'fonts/vazirmatn-arabic-400-normal.woff2', 'fonts/vazirmatn-arabic-700-normal.woff2',
  'fonts/vazirmatn-arabic-900-normal.woff2', 'fonts/vazirmatn-latin-700-normal.woff2',
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
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
