/* ─────────────────────────────────────────────────────────────
   Offline service worker for the budget tracker.

   The whole app is a single page plus its own styles/scripts, so
   everything it needs is precached on install. After one online
   visit the site opens with no network at all — on GitHub Pages,
   on a phone in airplane mode, anywhere.

   Bump CACHE whenever the shipped files change; the old cache is
   deleted on activate.
   ───────────────────────────────────────────────────────────── */

const CACHE = 'tracker-v21';

/* Everything the app shell is made of. Paths are relative so the
   worker also works from a project subfolder (github.io/<repo>/). */
const PRECACHE = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.webmanifest',
    './icon.svg',
    './apple-touch-icon.png',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    /* the default theme's backdrop, so a first offline open still has it.
       The other themes' boards are a few megabytes together, so they are
       left to cache themselves the first time each one is shown. */
    './Background/1.png',
    './Background/2.png'
];

/* Fonts live on Google's servers; once fetched they are cached here
   too, so the typography survives going offline. */
function isFontHost(url) {
    return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        /* One missing file must not fail the whole install, so each
           entry is fetched on its own and failures are tolerated. */
        await Promise.all(PRECACHE.map(async path => {
            try {
                const res = await fetch(new Request(path, { cache: 'reload' }));
                if (res && res.ok) await cache.put(path, res);
            } catch (e) { /* offline or file not shipped — skip it */ }
        }));
        /* no skipWaiting here — an update waits until the user accepts it */
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k))));
        if (self.registration.navigationPreload) {
            try { await self.registration.navigationPreload.enable() } catch (e) { }
        }
        await self.clients.claim();
    })());
});

/* The page asks for this after the user accepts an update. */
self.addEventListener('message', event => {
    if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;
    if (!sameOrigin && !isFontHost(url)) return;   /* let anything else go straight to the network */

    /* Opening the app: try the network so a new version lands, but
       fall back to the cached page the moment there is no signal. */
    if (req.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const preload = await event.preloadResponse;
                const res = preload || await fetch(req);
                const cache = await caches.open(CACHE);
                cache.put(req, res.clone());
                return res;
            } catch (e) {
                const cache = await caches.open(CACHE);
                return (await cache.match(req)) ||
                    (await cache.match('./index.html')) ||
                    (await cache.match('./')) ||
                    new Response('Offline and this page was never saved.', {
                        status: 503, headers: { 'Content-Type': 'text/plain' }
                    });
            }
        })());
        return;
    }

    /* Everything else — styles, scripts, icon, fonts: serve from the
       cache instantly, then quietly refresh the copy in the
       background so the next load is up to date. */
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        const network = fetch(req).then(res => {
            if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
            return res;
        }).catch(() => null);
        return hit || (await network) || Response.error();
    })());
});
