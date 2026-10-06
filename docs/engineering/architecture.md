# Lokarta: Technical Architecture Specification

Authoritative system architecture, threading model, module boundaries, and RPC protocols for *Lokarta: Come Into The Light*.

---

## 1. Threading & Dual-Loop Architecture

Lokarta operates as a zero-backend, multi-threaded client application running natively in modern web browsers:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Main UI Thread                                     │
│                                                                                 │
│   ┌──────────────────┐    ┌───────────────────────────┐   ┌─────────────────┐   │
│   │   DOM & HUD UI   │    │  HTML5 Canvas 2D Renderer │   │ Web Audio API   │   │
│   │   (HTML/CSS/JS)  │    │      (60 FPS Loop)        │   │  (Synthesizer)  │   │
│   └────────┬─────────┘    └─────────────┬─────────────┘   └────────┬────────┘   │
│            │                            │                          │            │
│            └─────────────────────┐      │      ┌───────────────────┘            │
│                                  ▼      ▼      ▼                                │
│                            ┌──────────────────────────┐                         │
│                            │ 10 Hz Simulation Ticker  │                         │
│                            │ (game-loop.js & systems) │                         │
│                            └────────────┬─────────────┘                         │
│                                         │ (GameClient RPC)                      │
└─────────────────────────────────────────┼───────────────────────────────────────┘
                                          │ Worker postMessage (Async Promises)
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         Dedicated Web Worker Thread                             │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                    game-worker.js (Stateless RPC)                       │   │
│   └──────┬──────────────────────────────┬───────────────────────────┬───────┘   │
│          │                              │                           │           │
│          ▼                              ▼                           ▼           │
│  ┌───────────────┐              ┌───────────────┐           ┌───────────────┐   │
│  │ Procedural    │              │ Save Slots &  │           │ IndexedDB     │   │
│  │ Floor Gen     │              │ Migrations    │           │ Persistence   │   │
│  │ (services/)   │              │ (services/)   │           │ (storage.js)  │   │
│  └───────────────┘              └───────────────┘           └───────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

* **Main UI Thread:**
  * **60 FPS Render Loop (`requestAnimationFrame`):** Canvas coordinate interpolation, lighting shroud overlay, sprite animations, floating combat text, and particle FX.
  * **10 Hz Simulation Ticker (`window.setInterval`, `TICK_INTERVAL_MS = 100`):** Player movement input, swept projectile physics, ability execution, cooldown timers, dynamic lighting recalculations, monster AI evaluation, and stair traversal checks.
  * **Presentation & Audio:** DOM HUD/Loadout/Backpack event delegation, modals, and procedural Web Audio synthesis.
* **Dedicated Web Worker (`html/worker/game-worker.js`):**
  * Asynchronous RPC service for deterministic procedural floor generation (Mulberry32 PRNG + BFS path verification), IndexedDB read/write I/O, slot management, and data migrations.

---

## 2. Directory Structure & Subsystems

All client application code resides under `html/` and is structured as native ES Modules:

| Directory | Layer | Key Submodules & Responsibilities |
| :--- | :--- | :--- |
| [`html/app/`](../html/app/) | UI & Controllers | `app-controller.js` (orchestrator), `game-loop.js` (10 Hz ticker & swept projectile physics), `save-controller.js` (slots/flow), `combat-controller.js`, `inventory-controller.js`, `floor-controller.js`, `shop-controller.js`, `canvas-renderer.js`, `sprite-renderer.js`, `hud-manager.js`, `modal-manager.js`, `input-controller.js`, `ability-bar.js`, `autofire.js`, `animation-state.js`, `hud-fx.js`, `splash-screen.js`, `title-ambient.js`, `transition-controller.js`. |
| [`html/engine/`](../html/engine/) | Core Simulation | `config.js`, `party.js`, `grid-map.js`, `lighting-system.js`, `progression-system.js`, `combat-system.js`, `inventory-system.js`, `entity-ai.js`, `fate-grant-system.js`, `economy-system.js`, `item-progression.js`, `item-stats.js`, `gesture-engine.js`, `projectile-collision.js`, `chest-system.js`, `door-system.js`, `stair-system.js`. |
| [`html/services/`](../html/services/) | Services | `floor-generator.js` (procedural generation), `storage.js` (IndexedDB layer), `save-slots.js` (multi-slot persistence & migration), `build-version.js` (cache-busting guard). |
| [`html/worker/`](../html/worker/) | Worker RPC | `game-worker.js` (stateless RPC dispatcher) and `game-client.js` (Promise-based client wrapper). |
| [`html/audio/`](../html/audio/) | Audio Engine | `audio-system.js` (Web Audio procedural synthesizer driven by `sounds.json`). |
| [`html/data/`](../html/data/) | Data Catalogs | 17 decoupled JSON catalogs (`cards`, `monsters`, `items`, `vocations`, `sounds`, `abilities`, `biomes`, `encounters`, `dungeons`, `tower_levels`, `doors`, `chests`, `tile_themes`, `keybindings`, `ui`, `economy`, `party_ai`). |
| [`html/styles/`](../html/styles/) | Presentation | `styles.css` root bundle and modular sheets (`base.css`, `hud.css`, `modals.css`). |
| [`html/assets/`](../html/assets/) | Assets | JSON sprite matrices (`sprites/`), OpenMoji SVG icons, and brand graphics. |

---

## 3. Storage & Save Slots (IndexedDB)

Persistent storage is managed by `html/services/storage.js` and `html/services/save-slots.js` inside the IndexedDB database **`lokarta_browser_db`** (schema version `2`):

* **Object Stores:**
  1. `save_slots` (keyPath: `'id'`): Metadata records for up to 5 save slots (`slotIndex: 1..5`, `vocation`, `level`, `currentFloor`, `towerProgress`, `playtimeMs`, `saveVersion: 2`).
  2. `characters` (keyPath: `'id'`): Full player state snapshots (vitals, stats, equipment paperdoll, backpack, gold, location: `'town' | 'tower'`, and the campaign `party` / `activeMemberId` / `towerProgress` model described in [`party-data-model.md`](party-data-model.md)).
  3. `slot_floors` (keyPath: `['slotIndex', 'floor_number']`): Per-slot cached floor tile matrices, entity states, and chest interactions.
  4. `game_settings` (keyPath: `'key'`): Persisted options and migration guards (`migration_slot_v2`, `migration_tower_v3`, `migration_party_v4`, `last_played_slot`).
  5. `profile` (keyPath: `'id'`): Global user settings (`soundEnabled`, `volume`, timestamps).
  6. `dungeon_floors` (keyPath: `'floor_number'`): Legacy floor cache store.

---

## 4. Web Worker RPC Protocol

Communication between the main thread and `game-worker.js` uses a structured Promise-wrapped JSON message envelope:

* **Request:** `{ id: string, command: string, payload: object }`
* **Response:** `{ id: string, ok: boolean, data?: any, error?: string }`

### Handled RPC Commands (17 Handlers)

| Command | Purpose |
| :--- | :--- |
| `bootstrap` | Initializes database, checks profile/options, applies migrations, returns active save status. |
| `listSlots` | Returns metadata array for all 5 save slots. |
| `createSlot` | Initializes a new character for slot `1..5` and generates Floor 1. |
| `loadSlot` | Loads the character and floor cache for an existing occupied slot. |
| `deleteSlot` | Clears character, metadata, and cached floors for a slot. |
| `restartFloor` | Restores character to the arrival snapshot (`floorEntry`) on the active floor. |
| `respawnAfterDeath` | Sets entrance coordinates and restores vitals for town respawn. |
| `newGame` | Legacy single-save slot initializer. |
| `saveCharacter` | Debounced or immediate persistence of player state and slot metadata. |
| `getFloor` | Retrieves cached floor or invokes `floor-generator.js` to create a new level. |
| `saveFloorState` | Persists chest opened/looted states for the active floor. |
| `advanceFloor` | Updates player level index, resolves stair arrival coordinates, and saves snapshot. |
| `getOptions` / `setOptions` / `resetOptions` | Reads, writes, or resets game settings and audio preferences. |
| `setSoundEnabled` | Toggles audio setting in persistent storage. |
| `resetProgress` | Clears all stores across slots, characters, and floors. |
