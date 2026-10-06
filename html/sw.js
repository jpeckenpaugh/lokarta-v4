/**
 * Lokarta: Come Into The Light - Freshness Service Worker
 *
 * Purpose: guarantee that a new deployment is always fetched, including the
 * nested ES module graph that `index.html` -> `boot.js` -> `app.js` pulls in.
 * Query-busting only the entry point is not enough because a module's static
 * `import` specifiers are cached by their own URLs. This worker intercepts
 * same-origin GET requests and serves them network-first with `cache: 'no-store'`
 * (bypassing the HTTP cache), falling back to a small runtime cache only when
 * the network is unavailable.
 *
 * Cross-origin requests (e.g. Google Fonts) are left untouched so the app keeps
 * working offline-capable without proxying third parties.
 */

const RUNTIME_CACHE = 'lokarta-fresh-v1';

self.addEventListener('install', () => {
  // Activate the new worker immediately; there is no precache to warm.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache written by this or a previous build so nothing stale can
    // be served by the fallback path.
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(request, { cache: 'no-store', credentials: 'same-origin' });
      if (fresh && fresh.ok) {
        try {
          const cache = await caches.open(RUNTIME_CACHE);
          await cache.put(request, fresh.clone());
        } catch {
          // Caching is optional; never fail the response over it.
        }
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw err;
    }
  })());
});
