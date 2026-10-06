# Per-Deployment Cache Flush & Build Versioning

Lokarta is a static, zero-backend game. After a rebuild/redeploy an existing browser window must run the **newly deployed build** and drop stale client-side state — even though HTTP caches, a warm ES-module graph, IndexedDB, and service workers can all pin the previous version. This document describes the mechanism.

---

## Mechanism at a glance

1. **Generate a build id at build/deploy time** into `html/build-id.json`.
2. **`boot.js` fetches that manifest with `cache: 'no-store'`** (bypassing the HTTP cache) before loading the game bundle.
3. **Compare** the deployed id against the id this browser last ran (`localStorage["lokarta.buildId"]`).
4. **On mismatch**: hard-flush client state, then clean-reload once into the new build (`?v=<id>&flushed=<id>`). Repeated loads of the same build are stable.
5. **A network-first service worker** (`sw.js`) re-fetches every same-origin script/style/document/JSON from the network so nested ES module imports are never pinned to a stale HTTP cache.

---

## 1. Build ID Generation

`tools/write-build-id.mjs` writes the manifest:

```json
{ "buildId": "9f889b4-20261005T184500Z", "builtAt": "2026-10-05T18:45:00.000Z", "source": "git" }
```

Source priority:
1. `LOKARTA_BUILD_ID` environment variable override (`source: 'env'`)
2. `git rev-parse --short HEAD` + UTC timestamp (`source: 'git'`)
3. `build-${stamp}` clock fallback (`source: 'clock'`)

Options: Supports `--out <dir>` (target directory) and `--root <repo-root>`.

* **Local dev / `run.sh`:** Runs the generator before starting the server so restarting the server produces a new ID and flushes stale clients on reload.
* **CI / GitHub Pages (`.github/workflows/deploy.yml`):** Runs `node tools/write-build-id.mjs --out _site` after copying `html/` and uploads the artifact. The generated `html/build-id.json` is git-ignored.

---

## 2. Boot Flow (`html/boot.js`)

`index.html` loads `boot.js` instead of loading `app.js` directly:

1. Calls `ensureCurrentBuild()` (`html/services/build-version.js`):
   * Current build $\rightarrow$ no-op, stamps `localStorage` and continues.
   * Mismatch $\rightarrow$ flush + `location.replace('<page>?v=<id>&flushed=<id>')`.
2. Surfaces the ID: `document.documentElement.dataset.buildId`, `window.__LOKARTA_BUILD_ID__`, and the header engine badge (`v2.3 · <short-id>`).
3. Registers the network-first service worker (`sw.js`).
4. Dynamically imports `app.js?v=<buildId>`.

---

## 3. What the Flush Clears

`flushClientState()` clears, independently with isolated `try/catch` handlers:

* `localStorage`
* `sessionStorage`
* IndexedDB database (`lokarta_browser_db`, or all databases via `indexedDB.databases()`)
* All `CacheStorage` caches
* **Stale/foreign service workers** whose script URL is not the active `sw.js`.

---

## 4. Loop Safety (Idempotent, No Infinite Reload)

The flush mechanism refuses to reload twice for the same deployed build:

* **Session Guard:** `sessionStorage["lokarta.buildFlushGuard"]` stores `{ buildId: string, at: number, attempts: number }`.
* **URL Token:** `?flushed=<id>` serves as a storage-independent fallback.
* **Recovery Mode:** If the deployed ID matches either guard, boot switches to `BUILD_ACTION.RECOVER` and adopts the new ID without reloading.
* **Fail-Safe Cap:** If flush attempts reach $\ge 3$ (`maxFlushAttempts = 3`), the loop breaker activates and forces `RECOVER` to prevent infinite reload loops.
* **New Visitors:** Brand-new visitors with zero persisted state bypass the flush and load immediately.

---

## 5. Files

| File | Role |
| :--- | :--- |
| `tools/write-build-id.mjs` | Generates `build-id.json` supporting `--out` and `--root`. |
| `html/build-id.json` | Generated per-deploy manifest (git-ignored). |
| `html/services/build-version.js` | Version evaluation, flush logic, and guard helpers. |
| `html/boot.js` | Bootstrap entry: version check, badge, SW registration, and dynamic bundle import. |
| `html/sw.js` | Network-first freshness service worker. |
| `html/tests/build-version.test.mjs` | 18 unit tests covering all evaluation states, URL rewriting, and CLI behavior. |
