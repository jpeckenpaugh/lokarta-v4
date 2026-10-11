import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  BUILD_ACTION,
  BUILD_ID_KEY,
  FLUSH_GUARD_KEY,
  evaluateBuildVersion,
  buildReloadUrl,
  versionedUrl,
  parseBuildManifest,
  readStoredBuildId,
  writeStoredBuildId,
  readFlushGuard,
  readFlushToken,
  flushClientState,
  hasPersistedClientState,
  ensureCurrentBuild,
  isCurrentServiceWorker,
  awaitServiceWorkerControl,
  normalizeBuildId,
} from '../services/build-version.js';
import {
  resolveBuildId,
  utcStamp,
  writeBuildManifest,
} from '../../tools/write-build-id.mjs';

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    clear: () => { map.clear(); },
    key: index => [...map.keys()][index] ?? null,
    _map: map,
  };
}

function makeIndexedDB({ names = ['lokarta_browser_db'] } = {}) {
  const deleted = [];
  return {
    deleted,
    databases: async () => names.map(name => ({ name })),
    deleteDatabase(name) {
      deleted.push(name);
      const request = {};
      queueMicrotask(() => { if (request.onsuccess) request.onsuccess(); });
      return request;
    },
  };
}

function makeCaches(keys = []) {
  const deleted = [];
  return {
    deleted,
    keys: async () => [...keys],
    delete: async (key) => { deleted.push(key); return true; },
    open: async () => ({ put: async () => {} }),
    match: async () => null,
  };
}

function makeServiceWorker(registrations = []) {
  const unregistered = [];
  return {
    unregistered,
    getRegistrations: async () => registrations.map(entry => ({
      active: { scriptURL: entry.scriptURL },
      unregister: async () => { unregistered.push(entry.scriptURL); return true; },
    })),
  };
}

function makeFetch(manifest, { ok = true } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (!ok) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => manifest };
  };
  fn.calls = calls;
  return fn;
}

function makeLocation(href = 'https://example.com/lokarta/index.html') {
  const navigations = [];
  return {
    href,
    replace: url => { navigations.push(url); },
    _navigations: navigations,
  };
}

const SW_URL = 'https://example.com/lokarta/sw.js';

test('build version guard', async (t) => {
  await t.test('normalizeBuildId trims and rejects blanks', () => {
    assert.equal(normalizeBuildId('  abc  '), 'abc');
    assert.equal(normalizeBuildId('   '), null);
    assert.equal(normalizeBuildId(''), null);
    assert.equal(normalizeBuildId(null), null);
    assert.equal(normalizeBuildId(42), null);
  });

  await t.test('versionedUrl sets, preserves, and replaces the version param', () => {
    assert.equal(versionedUrl('./app.js', 'abc'), './app.js?v=abc');
    assert.equal(versionedUrl('./styles.css?theme=dark', 'abc'), './styles.css?theme=dark&v=abc');
    assert.equal(versionedUrl('./app.js?v=old&x=1', 'new'), './app.js?v=new&x=1');
    assert.equal(versionedUrl('./app.js#frag', 'abc'), './app.js?v=abc#frag');
    assert.equal(versionedUrl('./app.js', null), './app.js');
    assert.equal(versionedUrl('./app.js', '  '), './app.js');
  });

  await t.test('parseBuildManifest validates shape', () => {
    assert.deepEqual(parseBuildManifest({ buildId: 'b1', builtAt: 't', source: 'env' }), {
      buildId: 'b1', builtAt: 't', source: 'env',
    });
    assert.equal(parseBuildManifest({ buildId: '' }), null);
    assert.equal(parseBuildManifest({}), null);
    assert.equal(parseBuildManifest(null), null);
    assert.equal(parseBuildManifest('b1'), null);
  });

  await t.test('evaluateBuildVersion decides load / flush / recover', () => {
    assert.deepEqual(
      evaluateBuildVersion({ storedBuildId: 'a', deployedBuildId: null }),
      { action: BUILD_ACTION.LOAD, deployedBuildId: null, reason: 'no-deployed-build' }
    );
    assert.deepEqual(
      evaluateBuildVersion({ storedBuildId: 'a', deployedBuildId: 'a' }),
      { action: BUILD_ACTION.LOAD, deployedBuildId: 'a', reason: 'up-to-date' }
    );
    assert.deepEqual(
      evaluateBuildVersion({ storedBuildId: 'a', deployedBuildId: 'b' }),
      { action: BUILD_ACTION.FLUSH, deployedBuildId: 'b', reason: 'version-mismatch' }
    );
    assert.deepEqual(
      evaluateBuildVersion({ storedBuildId: null, deployedBuildId: 'b' }),
      { action: BUILD_ACTION.FLUSH, deployedBuildId: 'b', reason: 'first-run' }
    );
    assert.equal(
      evaluateBuildVersion({ storedBuildId: 'a', deployedBuildId: 'b', guard: { buildId: 'b', at: 1, attempts: 1 } }).action,
      BUILD_ACTION.RECOVER
    );
    assert.equal(
      evaluateBuildVersion({ storedBuildId: 'a', deployedBuildId: 'b', urlFlushToken: 'b' }).action,
      BUILD_ACTION.RECOVER
    );
    // A new deploy after a previous flush is a real mismatch again.
    assert.equal(
      evaluateBuildVersion({ storedBuildId: 'a', deployedBuildId: 'c', guard: { buildId: 'b', at: 1, attempts: 1 } }).action,
      BUILD_ACTION.FLUSH
    );
    // Exhausted attempts on a different build still recover rather than loop.
    assert.equal(
      evaluateBuildVersion({ storedBuildId: 'a', deployedBuildId: 'c', guard: { buildId: 'b', at: 1, attempts: 9 }, maxFlushAttempts: 3 }).action,
      BUILD_ACTION.RECOVER
    );
  });

  await t.test('read/write stored build id and guard parsing', () => {
    const storage = makeStorage();
    assert.equal(readStoredBuildId(storage), null);
    assert.equal(writeStoredBuildId(storage, 'abc'), true);
    assert.equal(readStoredBuildId(storage), 'abc');
    assert.equal(storage.getItem(BUILD_ID_KEY), 'abc');

    const session = makeStorage({ [FLUSH_GUARD_KEY]: JSON.stringify({ buildId: 'b', at: 123, attempts: 2 }) });
    assert.deepEqual(readFlushGuard(session), { buildId: 'b', at: 123, attempts: 2 });
    assert.equal(readFlushGuard(makeStorage({ [FLUSH_GUARD_KEY]: 'not json' })), null);
    assert.equal(readFlushGuard(makeStorage({ [FLUSH_GUARD_KEY]: JSON.stringify({ at: 1 }) })), null);
  });

  await t.test('readFlushToken and buildReloadUrl are loop-safe', () => {
    assert.equal(readFlushToken('https://x/index.html?flushed=b1'), 'b1');
    assert.equal(readFlushToken('https://x/index.html'), null);
    assert.equal(readFlushToken(null), null);

    assert.equal(
      buildReloadUrl('https://x/lokarta/index.html?foo=1', 'b2'),
      'https://x/lokarta/index.html?foo=1&v=b2&flushed=b2'
    );
    // Re-running the flush URL replaces, never stacks, the params.
    assert.equal(
      buildReloadUrl('/lokarta/index.html?v=b1&flushed=b1', 'b2'),
      '/lokarta/index.html?v=b2&flushed=b2'
    );
  });

  await t.test('awaitServiceWorkerControl resolves on control / timeout', async () => {
    // No worker support -> immediately false (caller imports anyway).
    assert.equal(await awaitServiceWorkerControl(null), false);
    assert.equal(await awaitServiceWorkerControl({}), false);

    // Already controlled -> true without waiting.
    assert.equal(await awaitServiceWorkerControl({ controller: {}, addEventListener() {} }), true);

    // Controller arrives via `controllerchange`.
    {
      const listeners = new Map();
      const sw = {
        controller: null,
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type) => listeners.delete(type),
      };
      let cleared = null;
      const p = awaitServiceWorkerControl(sw, {
        timeoutMs: 5000,
        setTimeout: () => 'timer-1',
        clearTimeout: (id) => { cleared = id; },
      });
      sw.controller = {};
      listeners.get('controllerchange')();
      assert.equal(await p, true);
      assert.equal(cleared, 'timer-1', 'the timeout is cleared once control lands');
      assert.equal(listeners.has('controllerchange'), false, 'the listener is removed');
    }

    // No control before the timeout -> resolves to the current (false) state.
    {
      let fire = null;
      const listeners = new Map();
      const sw = {
        controller: null,
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type) => listeners.delete(type),
      };
      const p = awaitServiceWorkerControl(sw, {
        timeoutMs: 1234,
        setTimeout: (fn) => { fire = fn; return 'timer-2'; },
        clearTimeout: () => {},
      });
      fire();
      assert.equal(await p, false);
    }
  });

  await t.test('isCurrentServiceWorker matches by path', () => {
    assert.equal(isCurrentServiceWorker('https://example.com/lokarta/sw.js', SW_URL), true);
    assert.equal(isCurrentServiceWorker('https://example.com/other-sw.js', SW_URL), false);
    assert.equal(isCurrentServiceWorker('', SW_URL), false);
    assert.equal(isCurrentServiceWorker('https://example.com/lokarta/sw.js', null), false);
  });

  await t.test('flushClientState clears every store and keeps the current worker', async () => {
    const storage = makeStorage({ lokarta: '1' });
    const session = makeStorage({ tmp: '1' });
    const indexedDB = makeIndexedDB({ names: ['lokarta_browser_db', 'other_db'] });
    const caches = makeCaches(['lokarta-fresh-v1', 'legacy-cache']);
    const serviceWorker = makeServiceWorker([
      { scriptURL: 'https://example.com/lokarta/sw.js' },
      { scriptURL: 'https://example.com/legacy-sw.js' },
    ]);

    const summary = await flushClientState({
      storage,
      session,
      indexedDB,
      caches,
      serviceWorker,
      expectedServiceWorkerUrl: SW_URL,
    });

    assert.equal(storage.length, 0);
    assert.equal(session.length, 0);
    assert.deepEqual(indexedDB.deleted.sort(), ['lokarta_browser_db', 'other_db']);
    assert.deepEqual(caches.deleted.sort(), ['legacy-cache', 'lokarta-fresh-v1']);
    assert.deepEqual(serviceWorker.unregistered, ['https://example.com/legacy-sw.js']);
    assert.equal(summary.localStorage, true);
    assert.equal(summary.sessionStorage, true);
    assert.deepEqual(summary.indexedDB, ['lokarta_browser_db', 'other_db']);
  });

  await t.test('hasPersistedClientState detects each store', async () => {
    assert.equal(await hasPersistedClientState({
      storage: makeStorage(), session: makeStorage(), caches: makeCaches([]), indexedDB: makeIndexedDB({ names: [] }),
    }), false);
    assert.equal(await hasPersistedClientState({ storage: makeStorage({ a: '1' }) }), true);
    assert.equal(await hasPersistedClientState({ session: makeStorage({ a: '1' }) }), true);
    assert.equal(await hasPersistedClientState({ caches: makeCaches(['x']) }), true);
    assert.equal(await hasPersistedClientState({ indexedDB: makeIndexedDB({ names: ['x'] }) }), true);
  });

  await t.test('ensureCurrentBuild loads when the build is current', async () => {
    const storage = makeStorage({ [BUILD_ID_KEY]: 'b1' });
    const fetchImpl = makeFetch({ buildId: 'b1' });
    const result = await ensureCurrentBuild({ storage, fetch: fetchImpl, location: makeLocation() });
    assert.equal(result.action, 'load');
    assert.equal(result.reload, false);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].init.cache, 'no-store');
  });

  await t.test('ensureCurrentBuild flushes storage on mismatch and returns a clean reload', async () => {
    const storage = makeStorage({ [BUILD_ID_KEY]: 'old', saved: 'yes' });
    const session = makeStorage();
    const indexedDB = makeIndexedDB({ names: ['lokarta_browser_db'] });
    const caches = makeCaches(['lokarta-fresh-v1']);
    const serviceWorker = makeServiceWorker([
      { scriptURL: SW_URL },
      { scriptURL: 'https://example.com/legacy-sw.js' },
    ]);
    const location = makeLocation();

    const result = await ensureCurrentBuild({
      storage,
      session,
      indexedDB,
      caches,
      serviceWorker,
      expectedServiceWorkerUrl: SW_URL,
      fetch: makeFetch({ buildId: 'new' }),
      location,
    });

    assert.equal(result.action, 'flush');
    assert.equal(result.reload, true);
    assert.equal(result.buildId, 'new');
    assert.deepEqual(storage._map.keys().next().value, BUILD_ID_KEY);
    assert.equal(storage.getItem(BUILD_ID_KEY), 'new');
    assert.ok(!storage.getItem('saved'));
    assert.deepEqual(serviceWorker.unregistered, ['https://example.com/legacy-sw.js']);
    assert.match(result.reloadUrl, /[?&]v=new/);
    assert.match(result.reloadUrl, /[?&]flushed=new/);
    assert.deepEqual(readFlushGuard(session), { buildId: 'new', at: readFlushGuard(session).at, attempts: 1 });

    // A second load after the flush is stable (no further reload).
    const second = await ensureCurrentBuild({ storage, session, fetch: makeFetch({ buildId: 'new' }), location });
    assert.equal(second.action, 'load');
    assert.equal(second.reload, false);
  });

  await t.test('ensureCurrentBuild does not reload a brand-new visitor with no state', async () => {
    const storage = makeStorage();
    const result = await ensureCurrentBuild({
      storage,
      session: makeStorage(),
      indexedDB: makeIndexedDB({ names: [] }),
      caches: makeCaches([]),
      fetch: makeFetch({ buildId: 'new' }),
      location: makeLocation(),
    });
    assert.equal(result.action, 'load');
    assert.equal(result.reload, false);
    assert.equal(storage.getItem(BUILD_ID_KEY), 'new');
  });

  await t.test('ensureCurrentBuild flushes a first-run visitor with legacy state', async () => {
    const storage = makeStorage({ legacy: '1' });
    const result = await ensureCurrentBuild({
      storage,
      session: makeStorage(),
      fetch: makeFetch({ buildId: 'new' }),
      location: makeLocation(),
    });
    assert.equal(result.action, 'flush');
    assert.equal(result.reload, true);
  });

  await t.test('ensureCurrentBuild recovers instead of looping when a flush already ran', async () => {
    const storage = makeStorage({ [BUILD_ID_KEY]: 'old' });
    const session = makeStorage({ [FLUSH_GUARD_KEY]: JSON.stringify({ buildId: 'new', at: Date.now(), attempts: 1 }) });
    const result = await ensureCurrentBuild({
      storage, session, fetch: makeFetch({ buildId: 'new' }), location: makeLocation(),
    });
    assert.equal(result.action, 'recover');
    assert.equal(result.reload, false);
    assert.equal(storage.getItem(BUILD_ID_KEY), 'new');
  });

  await t.test('ensureCurrentBuild recovers when the reload URL carries the flush token', async () => {
    const location = makeLocation('https://example.com/lokarta/index.html?flushed=new');
    const result = await ensureCurrentBuild({
      storage: makeStorage({ [BUILD_ID_KEY]: 'old' }),
      session: makeStorage(),
      fetch: makeFetch({ buildId: 'new' }),
      location,
    });
    assert.equal(result.action, 'recover');
    assert.equal(result.reload, false);
  });

  await t.test('ensureCurrentBuild degrades to a normal load when the manifest is missing', async () => {
    const storage = makeStorage({ [BUILD_ID_KEY]: 'old' });
    const result = await ensureCurrentBuild({
      storage, session: makeStorage(), fetch: makeFetch(null, { ok: false }), location: makeLocation(),
    });
    assert.equal(result.action, 'load');
    assert.equal(result.reload, false);
    assert.equal(storage.getItem(BUILD_ID_KEY), 'old');
  });

  await t.test('build id tool resolves overrides, git fallback, and writes the manifest', () => {
    assert.deepEqual(resolveBuildId({ override: 'test-123' }), { buildId: 'test-123', source: 'env' });
    assert.equal(utcStamp(new Date('2026-10-05T18:45:00.000Z')), '20261005T184500Z');

    const fromGit = resolveBuildId({ root: resolve(process.cwd()) });
    assert.ok(['git', 'clock'].includes(fromGit.source));
    if (fromGit.source === 'git') {
      assert.match(fromGit.buildId, /^[0-9a-f]+-\d{8}T\d{6}Z$/);
    } else {
      assert.match(fromGit.buildId, /^build-\d{8}T\d{6}Z$/);
    }

    const dir = mkdtempSync(resolve(tmpdir(), 'lokarta-buildid-'));
    try {
      const manifest = writeBuildManifest({ outDir: dir, override: 'written-1' });
      assert.equal(manifest.buildId, 'written-1');
      assert.equal(manifest.source, 'env');
      const onDisk = JSON.parse(readFileSync(resolve(dir, 'build-id.json'), 'utf8'));
      assert.equal(onDisk.buildId, 'written-1');
      assert.equal(typeof onDisk.builtAt, 'string');

      // CLI path: --out honored, env override respected.
      const cliDir = mkdtempSync(resolve(tmpdir(), 'lokarta-buildid-cli-'));
      try {
        const toolPath = resolve(process.cwd(), 'tools/write-build-id.mjs');
        const output = execFileSync('node', [toolPath, '--out', cliDir], {
          encoding: 'utf8',
          env: { ...process.env, LOKARTA_BUILD_ID: 'cli-42' },
        });
        assert.match(output, /cli-42/);
        assert.equal(JSON.parse(readFileSync(resolve(cliDir, 'build-id.json'), 'utf8')).buildId, 'cli-42');
      } finally {
        rmSync(cliDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
