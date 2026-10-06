/**
 * Lokarta: Come Into The Light - Per-Deployment Build Version Guard
 *
 * Guarantees that a browser always runs the newly deployed build and discards
 * stale client-side state after a rebuild. The mechanism is intentionally
 * dependency-free and split into two layers:
 *
 *  1. Pure decision logic (`evaluateBuildVersion`, `versionedUrl`, ...) that is
 *     fully unit-testable under Node with no DOM or browser globals.
 *  2. A browser orchestrator (`ensureCurrentBuild`, `flushClientState`) that
 *     receives every browser API through an injected environment object, so the
 *     destructive flush can be exercised against fakes in the T0 suite.
 *
 * The deployed build id is read from `build-id.json`, fetched with
 * `cache: 'no-store'` so a new deployment is detected even when the surrounding
 * HTML/JS is still being served from a warm HTTP cache. On a mismatch the client
 * state is hard-flushed and the page clean-reloads once into the new build.
 */

/** localStorage key holding the build id the client last ran. */
export const BUILD_ID_KEY = 'lokarta.buildId';

/** sessionStorage key holding the loop-safety guard for the last flush. */
export const FLUSH_GUARD_KEY = 'lokarta.buildFlushGuard';

/** URL query param stamped onto the entry point (and reload URL). */
export const BUILD_QUERY_PARAM = 'v';

/** URL query param stamped onto a post-flush reload to break reload loops. */
export const FLUSH_TOKEN_PARAM = 'flushed';

/** Relative location of the deployed build manifest. */
export const BUILD_MANIFEST_URL = './build-id.json';

/**
 * IndexedDB databases owned by the game. Kept here so the flush has a safe
 * fallback on browsers without `indexedDB.databases()`. `storage.js` re-exports
 * `DB_NAME` from this list to keep a single source of truth.
 */
export const LOKARTA_DATABASE_NAMES = Object.freeze(['lokarta_browser_db']);

/** Default filename of the service worker that keeps module fetches fresh. */
export const SERVICE_WORKER_PATH = './sw.js';

/** `evaluateBuildVersion` outcomes. */
export const BUILD_ACTION = Object.freeze({
  LOAD: 'load',
  FLUSH: 'flush',
  RECOVER: 'recover',
});

/**
 * Normalizes a candidate build id. Missing/blank values become `null` so callers
 * can distinguish "unknown" from a real id.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeBuildId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates and normalizes a parsed `build-id.json` object.
 * @param {unknown} raw
 * @returns {{ buildId: string, builtAt: string|null, source: string|null }|null}
 */
export function parseBuildManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const buildId = normalizeBuildId(raw.buildId);
  if (!buildId) return null;
  return {
    buildId,
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null,
    source: typeof raw.source === 'string' ? raw.source : null,
  };
}

/**
 * Returns `url` with the build-id query param set to `buildId`, preserving any
 * existing query params and hash. Returns `url` unchanged when `buildId` is
 * unknown.
 * @param {string} url
 * @param {string|null|undefined} buildId
 * @returns {string}
 */
export function versionedUrl(url, buildId) {
  const id = normalizeBuildId(buildId);
  if (!id) return url;
  const raw = String(url);
  const hashIndex = raw.indexOf('#');
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
  const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const queryIndex = base.indexOf('?');
  const path = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const query = queryIndex >= 0 ? base.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(query);
  params.set(BUILD_QUERY_PARAM, id);
  const nextQuery = params.toString();
  return `${path}${nextQuery ? `?${nextQuery}` : ''}${hash}`;
}

/**
 * Reads the last-run build id from storage. Never throws (private mode, disabled
 * storage, or a hostile storage shim).
 * @param {Storage|null|undefined} storage
 * @returns {string|null}
 */
export function readStoredBuildId(storage) {
  try {
    return normalizeBuildId(storage?.getItem?.(BUILD_ID_KEY));
  } catch {
    return null;
  }
}

/**
 * Persists the build id. Returns whether the write was accepted.
 * @param {Storage|null|undefined} storage
 * @param {string|null|undefined} buildId
 * @returns {boolean}
 */
export function writeStoredBuildId(storage, buildId) {
  const id = normalizeBuildId(buildId);
  if (!id) return false;
  try {
    storage?.setItem?.(BUILD_ID_KEY, id);
    return readStoredBuildId(storage) === id;
  } catch {
    return false;
  }
}

/**
 * Reads the session-scoped flush guard: which build last triggered a flush, at
 * what time, and how many attempts were made.
 * @param {Storage|null|undefined} session
 * @returns {{ buildId: string, at: number, attempts: number }|null}
 */
export function readFlushGuard(session) {
  try {
    const raw = session?.getItem?.(FLUSH_GUARD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const buildId = normalizeBuildId(parsed.buildId);
    const at = Number(parsed.at);
    if (!buildId || !Number.isFinite(at)) return null;
    const attempts = Number.isFinite(Number(parsed.attempts)) && Number(parsed.attempts) > 0
      ? Math.floor(Number(parsed.attempts))
      : 1;
    return { buildId, at, attempts };
  } catch {
    return null;
  }
}

/**
 * Extracts the post-flush token from a URL (used as a storage-independent loop
 * breaker when localStorage/sessionStorage are unavailable).
 * @param {string|null|undefined} href
 * @returns {string|null}
 */
export function readFlushToken(href) {
  if (!href) return null;
  try {
    const url = new URL(String(href), 'http://localhost/');
    return normalizeBuildId(url.searchParams.get(FLUSH_TOKEN_PARAM));
  } catch {
    return null;
  }
}

/**
 * Pure decision function: what should boot do for the observed build ids?
 *
 * - `LOAD`    no usable deployed id, ids match, or the state is already current.
 * - `FLUSH`   the deployed build differs from the last-run build and no flush
 *             has happened yet.
 * - `RECOVER` a flush already ran for this deployed build (tracked in the
 *             session guard and/or the reload URL token) but the stored id is
 *             still stale; do not reload again — just adopt the new id. This is
 *             the loop-safety valve for blocked storage.
 *
 * @param {object} input
 * @param {string|null} [input.storedBuildId]
 * @param {string|null} [input.deployedBuildId]
 * @param {{ buildId: string, at: number, attempts: number }|null} [input.guard]
 * @param {string|null} [input.urlFlushToken]
 * @param {number} [input.maxFlushAttempts]
 * @returns {{ action: string, deployedBuildId: string|null, reason: string }}
 */
export function evaluateBuildVersion({
  storedBuildId = null,
  deployedBuildId = null,
  guard = null,
  urlFlushToken = null,
  maxFlushAttempts = 3,
} = {}) {
  const deployed = normalizeBuildId(deployedBuildId);
  if (!deployed) {
    return { action: BUILD_ACTION.LOAD, deployedBuildId: null, reason: 'no-deployed-build' };
  }

  const stored = normalizeBuildId(storedBuildId);
  if (stored === deployed) {
    return { action: BUILD_ACTION.LOAD, deployedBuildId: deployed, reason: 'up-to-date' };
  }

  const guardBuildId = normalizeBuildId(guard?.buildId);
  const guarded = guardBuildId === deployed || normalizeBuildId(urlFlushToken) === deployed;
  if (guarded || (guard && guard.attempts >= maxFlushAttempts && guardBuildId !== deployed)) {
    return { action: BUILD_ACTION.RECOVER, deployedBuildId: deployed, reason: 'flush-already-attempted' };
  }

  return {
    action: BUILD_ACTION.FLUSH,
    deployedBuildId: deployed,
    reason: stored ? 'version-mismatch' : 'first-run',
  };
}

/**
 * Builds the clean-reload URL: the current location with both the version and
 * the flush token stamped on. Both are replaced, never appended twice.
 * @param {string} href
 * @param {string} buildId
 * @returns {string}
 */
export function buildReloadUrl(href, buildId) {
  const id = normalizeBuildId(buildId);
  const raw = String(href || './');
  const hashIndex = raw.indexOf('#');
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
  const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const queryIndex = base.indexOf('?');
  const path = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const query = queryIndex >= 0 ? base.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(query);
  if (id) {
    params.set(BUILD_QUERY_PARAM, id);
    params.set(FLUSH_TOKEN_PARAM, id);
  }
  const nextQuery = params.toString();
  return `${path}${nextQuery ? `?${nextQuery}` : ''}${hash}`;
}

async function listDatabaseNames(indexedDB) {
  if (indexedDB && typeof indexedDB.databases === 'function') {
    try {
      const databases = await indexedDB.databases();
      const names = (databases || []).map(entry => entry && entry.name).filter(Boolean);
      if (names.length > 0) return names;
    } catch {
      // Fall through to the known-name fallback.
    }
  }
  return [...LOKARTA_DATABASE_NAMES];
}

function deleteDatabase(indexedDB, name) {
  return new Promise(resolve => {
    if (!indexedDB || typeof indexedDB.deleteDatabase !== 'function') {
      resolve();
      return;
    }
    let request;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    if (!request) {
      resolve();
      return;
    }
    let settled = false;
    let timer = null;
    const done = () => {
      if (!settled) {
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve();
      }
    };
    if (typeof request.then === 'function') {
      request.then(done, done);
      return;
    }
    request.onsuccess = done;
    request.onerror = done;
    request.onblocked = done;
    // Some engines never fire onblocked handlers without live connections.
    timer = setTimeout(done, 2000);
  });
}

/**
 * True when a service-worker script URL points at the current worker. Stale
 * (foreign/old) registrations return false so the flush can drop them while
 * keeping the network-first worker that guarantees fresh module fetches.
 * @param {string} scriptURL
 * @param {string|null|undefined} expectedUrl
 * @returns {boolean}
 */
export function isCurrentServiceWorker(scriptURL, expectedUrl) {
  if (!scriptURL) return false;
  if (!expectedUrl) return false;
  try {
    const actual = new URL(scriptURL, 'http://localhost/').pathname;
    const expected = new URL(expectedUrl, 'http://localhost/').pathname;
    return actual === expected;
  } catch {
    return String(scriptURL).endsWith('/sw.js') && String(expectedUrl).endsWith('sw.js');
  }
}

/**
 * Hard-flushes client-side state: localStorage, sessionStorage, IndexedDB,
 * CacheStorage, and stale/foreign service-worker registrations. The current
 * network-first worker is retained so the subsequent clean reload fetches the
 * new build. Every step is best-effort and isolated — a blocked API never
 * prevents the remaining flushes.
 *
 * @param {object} env injected browser environment
 * @param {Storage} [env.storage] localStorage
 * @param {Storage} [env.session] sessionStorage
 * @param {IDBFactory} [env.indexedDB]
 * @param {CacheStorage} [env.caches]
 * @param {ServiceWorkerContainer} [env.serviceWorker]
 * @param {string} [env.expectedServiceWorkerUrl]
 * @param {string[]} [env.databaseNames]
 * @returns {Promise<{ localStorage: boolean, sessionStorage: boolean, indexedDB: string[], caches: string[], serviceWorkers: string[] }>}
 */
export async function flushClientState(env = {}) {
  const summary = {
    localStorage: false,
    sessionStorage: false,
    indexedDB: [],
    caches: [],
    serviceWorkers: [],
  };

  if (env.storage && typeof env.storage.clear === 'function') {
    try {
      env.storage.clear();
      summary.localStorage = true;
    } catch {
      // best-effort
    }
  }

  if (env.session && typeof env.session.clear === 'function') {
    try {
      env.session.clear();
      summary.sessionStorage = true;
    } catch {
      // best-effort
    }
  }

  const explicitNames = Array.isArray(env.databaseNames) ? env.databaseNames : null;
  const databaseNames = explicitNames && explicitNames.length > 0
    ? explicitNames
    : await listDatabaseNames(env.indexedDB);
  for (const name of databaseNames) {
    await deleteDatabase(env.indexedDB, name);
    summary.indexedDB.push(name);
  }

  if (env.caches && typeof env.caches.keys === 'function') {
    try {
      const keys = await env.caches.keys();
      for (const key of keys || []) {
        try {
          await env.caches.delete(key);
          summary.caches.push(key);
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
  }

  if (env.serviceWorker && typeof env.serviceWorker.getRegistrations === 'function') {
    try {
      const registrations = await env.serviceWorker.getRegistrations();
      for (const registration of registrations || []) {
        const scriptURL = (registration.active && registration.active.scriptURL)
          || (registration.waiting && registration.waiting.scriptURL)
          || (registration.installing && registration.installing.scriptURL)
          || '';
        if (isCurrentServiceWorker(scriptURL, env.expectedServiceWorkerUrl)) continue;
        try {
          await registration.unregister();
          summary.serviceWorkers.push(scriptURL);
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
  }

  return summary;
}

/**
 * Async check for whether there is any pre-existing client state worth a
 * destructive flush. Used to avoid a first-ever-visit reload for brand-new
 * players while still flushing legacy state that predates this mechanism.
 * @param {object} env
 * @returns {Promise<boolean>}
 */
export async function hasPersistedClientState(env = {}) {
  try {
    if (env.storage && Number(env.storage.length) > 0) return true;
  } catch {
    // ignore
  }
  try {
    if (env.session && Number(env.session.length) > 0) return true;
  } catch {
    // ignore
  }
  if (env.caches && typeof env.caches.keys === 'function') {
    try {
      const keys = await env.caches.keys();
      if (keys && keys.length > 0) return true;
    } catch {
      // ignore
    }
  }
  if (env.indexedDB && typeof env.indexedDB.databases === 'function') {
    try {
      const databases = await env.indexedDB.databases();
      if (databases && databases.length > 0) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Browser orchestrator. Fetches the deployed build manifest, decides whether a
 * flush is required, and (when it is) hard-flushes client state and returns a
 * `reloadUrl` for the caller to navigate to. Never throws: any failure degrades
 * to a normal load so the game still starts.
 *
 * @param {object} env injected browser environment (see `flushClientState`)
 * @param {function} [env.fetch] fetch implementation
 * @param {object} [env.location] `{ href }`
 * @param {object} [options]
 * @param {string} [options.manifestUrl]
 * @param {function} [options.now]
 * @returns {Promise<{ action: string, buildId: string|null, flushed: boolean, reload: boolean, reloadUrl?: string, manifest?: object|null }>}
 */
export async function ensureCurrentBuild(env = {}, options = {}) {
  const fetchImpl = options.fetchImpl || env.fetch;
  const manifestUrl = options.manifestUrl || BUILD_MANIFEST_URL;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let manifest = null;
  if (typeof fetchImpl === 'function') {
    try {
      const response = await fetchImpl(manifestUrl, { cache: 'no-store', credentials: 'same-origin' });
      if (response && (response.ok === undefined || response.ok)) {
        const payload = typeof response.json === 'function' ? await response.json() : response.body;
        manifest = parseBuildManifest(payload);
      }
    } catch {
      manifest = null;
    }
  }

  const deployedBuildId = manifest ? manifest.buildId : null;
  const href = env.location && env.location.href ? env.location.href : null;
  const decision = evaluateBuildVersion({
    storedBuildId: readStoredBuildId(env.storage),
    deployedBuildId,
    guard: readFlushGuard(env.session),
    urlFlushToken: readFlushToken(href),
  });

  if (decision.action === BUILD_ACTION.LOAD) {
    if (deployedBuildId) writeStoredBuildId(env.storage, deployedBuildId);
    return { action: 'load', buildId: deployedBuildId, flushed: false, reload: false, manifest };
  }

  if (decision.action === BUILD_ACTION.RECOVER) {
    if (deployedBuildId) writeStoredBuildId(env.storage, deployedBuildId);
    return { action: 'recover', buildId: deployedBuildId, flushed: false, reload: false, manifest };
  }

  // FLUSH. Do not reload brand-new visitors who have no state to clear.
  if (decision.reason === 'first-run') {
    const persisted = await hasPersistedClientState(env);
    if (!persisted) {
      writeStoredBuildId(env.storage, deployedBuildId);
      return { action: 'load', buildId: deployedBuildId, flushed: false, reload: false, manifest };
    }
  }

  const guard = readFlushGuard(env.session);
  const nextGuard = {
    buildId: deployedBuildId,
    at: now(),
    attempts: guard && guard.buildId === deployedBuildId ? guard.attempts + 1 : 1,
  };

  await flushClientState(env);
  writeStoredBuildId(env.storage, deployedBuildId);
  try {
    env.session?.setItem?.(FLUSH_GUARD_KEY, JSON.stringify(nextGuard));
  } catch {
    // best-effort; the reload URL token is the storage-independent guard.
  }

  const reloadUrl = buildReloadUrl(href || './', deployedBuildId);
  return {
    action: 'flush',
    buildId: deployedBuildId,
    flushed: true,
    reload: true,
    reloadUrl,
    manifest,
  };
}
