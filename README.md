# Lokarta: Come Into The Light

*A zero-backend, client-side 2D roguelike RPG running natively in modern web browsers.*

---

## 🏰 Overview

**Lokarta: Come Into The Light** is a retro-inspired 2D roguelike RPG featuring a real-time 10 Hz simulation tick and 60 FPS HTML5 Canvas rendering. Built entirely with native web standards (ES Modules, Web Workers, Canvas 2D, Web Audio API, and IndexedDB), Lokarta delivers a complete, offline-capable dungeon crawler experience with zero external dependencies.

---

## 🚀 Quickstart

Serve the game locally over HTTP using the launcher script:

```bash
./run.sh
```

Then open **`http://localhost:3000`** in any modern web browser. For custom ports (`PORT=8080`) and server options, see [Environment & System Notes](docs/engineering/environment.md).

---

## 🧪 Automated Testing

Run the full zero-dependency native test suite:

```bash
node --test html/tests/*.test.mjs
```

---

## 📖 Documentation Index

All authoritative design and engineering specifications live under [`docs/`](docs/):

| Category | Specification Document | Focus Area |
| :--- | :--- | :--- |
| **Game Design** | [`docs/design/game-design.md`](docs/design/game-design.md) | Core game loop, 4 vocations, Dawnreach Isle overworld + Havenreach town hub, the island quest chain, tower ascent, controls, and inventory rules. |
| **Art Direction** | [`docs/art/art-direction.md`](docs/art/art-direction.md) | 16-bit SNES-style pixel art contracts, frame sets, resolution rules, and contrast standards. |
| **Architecture** | [`docs/engineering/architecture.md`](docs/engineering/architecture.md) | Dual-loop threading model, modular UI controllers, 22 Web Worker RPC handlers, and IndexedDB schema. |
| **Engineering Rules** | [`docs/engineering/agents.md`](docs/engineering/agents.md) | Mandatory architectural rules, 23 data catalogs, hot-path GC budgets, DOM hygiene, and T0/T1/T2 testing models. |
| **Build Versioning** | [`docs/engineering/build-versioning.md`](docs/engineering/build-versioning.md) | Build ID generation (`tools/write-build-id.mjs`), `boot.js` verification, and client cache-flush invalidation. |
| **Environment** | [`docs/engineering/environment.md`](docs/engineering/environment.md) | Runtime browser prerequisites, local server setup, Node 22 CI, and test execution procedures. |
| **Asset Previews** | [`docs/art/preview/`](docs/art/preview/) | Committed sprite preview PNGs drift-checked by automated test suites. |
