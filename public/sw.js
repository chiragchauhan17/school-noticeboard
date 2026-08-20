/* Service worker for the notice board display.
   Purpose: after a power cut the box often boots before the school
   router does. This lets the page and its media load with no network
   at all, so the screen shows the last board instead of an error. */

const VERSION = 'nb-v1';
const SHELL = ['/', '/index.html'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(VERSION)
            .then(cache => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== VERSION).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // The notices API is never cached here — index.html keeps its own
    // copy in localStorage and knows how to label it as stale.
    if (url.pathname.startsWith('/api/')) return;

    // Uploaded media: serve from cache when we have it, otherwise
    // fetch and keep a copy for the next cold boot.
    if (url.pathname.startsWith('/uploads/')) {
        event.respondWith(
            caches.match(req).then(hit => {
                if (hit) return hit;
                return fetch(req).then(res => {
                    if (res.ok) {
                        const copy = res.clone();
                        caches.open(VERSION).then(c => c.put(req, copy));
                    }
                    return res;
                });
            })
        );
        return;
    }

    // Page shell: prefer the network so updates land, fall back to
    // cache the moment the network is unavailable.
    event.respondWith(
        fetch(req)
            .then(res => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(VERSION).then(c => c.put(req, copy));
                }
                return res;
            })
            .catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
    );
});
