# Environment & System Notes

Authoritative runtime environment, browser prerequisites, local hosting, and test execution procedures for *Lokarta: Come Into The Light*.

---

## 1. Client Runtime Environment

The application runs entirely within standard web browsers without external backend servers, CDNs, or build bundlers:

* **Browser Compatibility:** Evergreen browsers (Google Chrome, Mozilla Firefox, Apple Safari, Microsoft Edge).
* **ES Modules (ESM):** Native `import` / `export` syntax initialized via `<script type="module" src="./boot.js"></script>` in [`html/index.html`](../html/index.html). `boot.js` checks cache freshness and dynamically imports `app.js?v=<buildId>`.
* **Service Worker (`html/sw.js`):** Registered by `boot.js` with a network-first strategy to guarantee fresh module graphs across deploys and offline capability.
* **Web Workers:** Native dedicated Web Worker (`new Worker('worker/game-worker.js', { type: 'module' })`) for off-thread floor generation and IndexedDB persistence.
* **IndexedDB:** Database `lokarta_browser_db` managed by `html/services/storage.js` for 5 save slots, character state, and floor caches.
* **Web Audio API:** Native `AudioContext` in `html/audio/audio-system.js` for procedural 8-bit/16-bit sound synthesis driven by `sounds.json`.
* **HTML5 Canvas 2D:** 60 FPS rendering context (`HTMLCanvasElement.getContext('2d')`) in `CanvasRenderer` and `SpriteRenderer`.

---

## 2. Local HTTP Server & Launching

Because the application relies on Web Workers and ES Modules, files must be served over HTTP/HTTPS rather than `file://`:

```bash
./run.sh
```

`run.sh` generates a build manifest via `tools/write-build-id.mjs` and launches a static server on port `3000` (override with `PORT=8080 ./run.sh`), auto-detecting:
1. `python3 -m http.server -d html "$PORT"`
2. `npx serve html -l "$PORT"`
3. `python -m SimpleHTTPServer "$PORT"` (subshell in `html/`)

---

## 3. Automated Testing Procedure

The test harness uses Node.js's native test runner without third-party frameworks:

* **Prerequisites:** Node.js v18.0.0+ (CI strictly runs on Node 22).
* **Execution:**
  ```bash
  node --test html/tests/*.test.mjs
  ```
* **Coverage Scope (114 test suites / 984 cases):**
  * Procedural tower ascent across all four towers, stair traversal, and key-gated locks.
  * Island/town scene composition, NPC dialogue, the quest chain, and the Spire access gate.
  * 16-bit sprite & prop asset validation, palette contracts, and preview drift checks.
  * Combat mechanics, Golden Sets, and 4-slot consumable / 4-slot equipment inventory.
  * Multi-save slots, legacy migrations (party/world/tower backfill), and build version cache invalidation.
  * Worker RPC lifecycle and audio synthesizer events.

---

## 4. Invariants & Constraints

1. **Zero Backend Required:** No server frameworks (FastAPI, Express, Django) or remote databases.
2. **No Bundlers / Transpilers:** No Webpack, Vite, Babel, or npm build scripts in `html/`. Code runs natively in the browser.
3. **CI & Deploy:** GitHub Actions runs automated tests on push/PR (`.github/workflows/test.yml`) and deploys `html/` with cache-busting to GitHub Pages (`.github/workflows/deploy.yml`).
