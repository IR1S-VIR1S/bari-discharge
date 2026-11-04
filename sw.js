// Offline cache for the app shell. Patient data never pass through this file: requests to the
// workbook go straight to the network and are never cached.
const CACHE = 'bari-062d036eee80';
const FILES = ["./", "index.html", "app.js", "app.css", "logic.js", "qrcode.js", "manifest.webmanifest", "logo.jpg", "qr.jpg", "urdu.woff2", "v.html", "v.js", "v.css", "v-trust.js", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).catch(() => caches.match('index.html'))));
});
