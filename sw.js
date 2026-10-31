// Keeps the app shell available offline. Spotify calls always go to the network.
const CACHE = 'cortex-fm-v16';
const SHELL = ['./', 'index.html', 'styles.css', 'js/app.js', 'js/mood.js', 'js/spotify.js', 'js/demo.js', 'js/brain.js', 'js/player.js', 'spatial.html', 'js/spatial.js', 'js/spatial-audio.js', 'js/studio.js', 'js/motion.js', 'js/devicefiles.js', 'js/preview.js', 'js/trajectory.js', 'js/trajectory-worklet.js', 'js/install.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname.endsWith('spotify.com') || url.hostname.endsWith('scdn.co') || url.pathname.startsWith('/api/')) return; // never cache API answers (they can hold your login)
  // Network first so updates show up; fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && (url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net' || url.hostname.includes('fonts.g'))) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
