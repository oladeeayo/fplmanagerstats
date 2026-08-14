const CACHE_NAME = 'fpl-stats-react-v4';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/common.js?v=react-4',
    '/design-system.css?v=react-4',
    '/football.ico',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-192.svg',
    '/icon-512.svg',
    '/manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => Promise.allSettled(
            STATIC_ASSETS.map((asset) => cache.add(asset))
        ))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Don't cache API calls - always fetch fresh
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // HTML: network first (always get latest)
    if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
        event.respondWith(
            fetch(event.request).then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
        );
        return;
    }

    // Static assets: network first so deployments never run stale JavaScript.
    event.respondWith(
        fetch(event.request).then((response) => {
            if (response && response.status === 200) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
        }).catch(() => caches.match(event.request))
    );
});
