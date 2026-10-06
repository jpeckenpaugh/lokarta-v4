/**
 * Lokarta: Come Into The Light - Boot Entry
 *
 * Loaded by `index.html` before the game bundle. Responsibilities:
 *  1. Fetch the deployed `build-id.json` (no-store) and compare it with the
 *     build id this browser last ran. On a mismatch, hard-flush client state
 *     (localStorage, sessionStorage, IndexedDB, CacheStorage, stale service
 *     workers) and clean-reload once into the new build.
 *  2. Surface the build id to the DOM (`data-build-id`, engine badge, global).
 *  3. Register the network-first service worker so all same-origin assets and
 *     nested ES module imports are re-fetched from the network rather than a
 *     stale HTTP cache.
 *  4. Import the game bundle (`app.js?v=<buildId>`).
 */

import {
  ensureCurrentBuild,
  versionedUrl,
  SERVICE_WORKER_PATH,
} from './services/build-version.js';

function safeStorage(getter) {
  try {
    return getter() || null;
  } catch {
    return null;
  }
}

function currentEnv() {
  return {
    fetch: typeof fetch === 'function' ? (input, init) => fetch(input, init) : null,
    storage: safeStorage(() => window.localStorage),
    session: safeStorage(() => window.sessionStorage),
    indexedDB: typeof window !== 'undefined' ? window.indexedDB : null,
    caches: typeof window !== 'undefined' ? window.caches : null,
    serviceWorker: typeof navigator !== 'undefined' ? navigator.serviceWorker : null,
    expectedServiceWorkerUrl: new URL(SERVICE_WORKER_PATH, window.location.href).href,
    location: window.location,
  };
}

/** Surfaces the deployed build id for debugging and board verification. */
function surfaceBuildId(buildId) {
  if (!document) return;
  if (buildId) {
    document.documentElement.dataset.buildId = buildId;
    window.__LOKARTA_BUILD_ID__ = buildId;
  }
  const badge = document.getElementById('engine-badge');
  if (badge && buildId) {
    badge.dataset.buildId = buildId;
    badge.title = `Lokarta build ${buildId}`;
    const short = buildId.length > 12 ? buildId.slice(0, 12) : buildId;
    if (badge.textContent !== `v2.3 · ${short}`) badge.textContent = `v2.3 · ${short}`;
  }
  if (badge && !buildId) badge.title = 'Lokarta build (dev)';
}

/** Registers the network-first service worker. Failures are non-fatal. */
async function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  try {
    const swUrl = new URL(SERVICE_WORKER_PATH, window.location.href).href;
    await navigator.serviceWorker.register(swUrl, { type: 'module', updateViaCache: 'none' });
  } catch (err) {
    console.warn('[lokarta] Service worker registration skipped:', err);
  }
}

async function boot() {
  const env = currentEnv();

  let result = null;
  try {
    result = await ensureCurrentBuild(env);
  } catch (err) {
    console.warn('[lokarta] Build version check failed; loading current bundle.', err);
  }

  if (result && result.reload && result.reloadUrl) {
    env.location.replace(result.reloadUrl);
    return;
  }

  const buildId = result ? result.buildId : null;
  surfaceBuildId(buildId);

  await registerServiceWorker();

  const appUrl = versionedUrl(new URL('./app.js', import.meta.url).href, buildId);
  await import(appUrl);
}

boot();
