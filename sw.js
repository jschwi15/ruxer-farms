/* Ruxer Farms service worker: keeps the app usable with no signal and shows
   due-soon alerts sent by the server. Data requests to Supabase are never
   cached here; the app keeps its own saved copy of the data. */
const CACHE = 'ruxer-shell-v17';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './logo-64.png',
  './logo-180.png',
  './logo-192.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return; // live data: never from cache
  const sameOrigin = url.origin === self.location.origin;
  const isAsset = sameOrigin || url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com');
  if (!isAsset) return;
  // Network first (so updates arrive), falling back to the saved copy offline.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: sameOrigin });
      if (hit) return hit;
      if (req.mode === 'navigate') { const page = await cache.match('./index.html'); if (page) return page; }
      throw err;
    }
  })());
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  const title = d.title || 'Ruxer Farms';
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: d.body || 'A service is coming due.',
      icon: 'logo-192.png',
      badge: 'logo-64.png',
      tag: d.tag || 'ruxer-due',
      data: { url: d.url || './' }
    }),
    (typeof d.badge === 'number' && self.navigator && self.navigator.setAppBadge) ? self.navigator.setAppBadge(d.badge).catch(() => {}) : Promise.resolve()
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); if ('navigate' in w) { try { await w.navigate(target); } catch { } } return; } }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
