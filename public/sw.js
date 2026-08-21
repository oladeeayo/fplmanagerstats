const CACHE_NAME = 'fpl-stats-react-v28';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/common.js?v=24',
    '/design-system.css?v=20',
    '/fpl-icon.svg?v=3',
    '/pwa-icon-192.png?v=3',
    '/pwa-icon-512.png?v=3',
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

    // Don't cache API calls — always fetch fresh
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // HTML: network-first with cache-busting revalidation
    if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
        event.respondWith(
            fetch(event.request).then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/offline.html')))
        );
        return;
    }

    // Hashed Vite assets and local fonts are immutable — cache-first
    if (event.request.method === 'GET' && (url.pathname.startsWith('/assets/') || /\.(?:ico|png|svg|woff2?)$/i.test(url.pathname))) {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }))
        );
        return;
    }

    // Everything else: network-first so deployments never serve stale content
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
