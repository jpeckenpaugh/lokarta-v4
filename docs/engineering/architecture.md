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
| [`html/app/`](../../html/app/) | UI & Controllers | `app-controller.js` (orchestrator), `game-loop.js` (10 Hz ticker & swept projectile physics), `save-controller.js` (slots/flow), `combat-controller.js`, `inventory-controller.js`, `floor-controller.js`, `shop-controller.js`, `canvas-renderer.js`, `sprite-renderer.js`, `hud-manager.js`, `modal-manager.js`, `input-controller.js`, `ability-bar.js`, `autofire.js`, `animation-state.js`, `hud-fx.js`, `splash-screen.js`, `title-ambient.js`, `transition-controller.js`. |
| [`html/engine/`](../../html/engine/) | Core Simulation | `config.js` (archetypes + tunables), `party.js` (party model + tower progress), `campaign.js` (recruitment + tower completion), `party-ai.js` (auto-ally AI), `party-progression.js`, `party-swap.js`, `faction.js`, `grid-map.js`, `lighting-system.js`, `progression-system.js`, `combat-system.js`, `inventory-system.js`, `entity-ai.js`, `fate-grant-system.js`, `economy-system.js`, `item-progression.js`, `item-stats.js`, `gesture-engine.js`, `projectile-collision.js`, `chest-system.js`, `door-system.js`, `stair-system.js`. |
| [`html/services/`](../../html/services/) | Services | `floor-generator.js` (procedural generation), `storage.js` (IndexedDB layer), `save-slots.js` (multi-slot persistence & migration), `build-version.js` (cache-busting guard). |
| [`html/worker/`](../../html/worker/) | Worker RPC | `game-worker.js` (stateless RPC dispatcher) and `game-client.js` (Promise-based client wrapper). |
| [`html/audio/`](../../html/audio/) | Audio Engine | `audio-system.js` (Web Audio procedural synthesizer driven by `sounds.json`). |
| [`html/data/`](../../html/data/) | Data Catalogs | 17 decoupled JSON catalogs (`cards`, `monsters`, `items`, `vocations`, `sounds`, `abilities`, `biomes`, `encounters`, `dungeons`, `tower_levels`, `doors`, `chests`, `tile_themes`, `keybindings`, `ui`, `economy`, `party_ai`). |
| [`html/styles/`](../../html/styles/) | Presentation | `styles.css` root bundle and modular sheets (`base.css`, `hud.css`, `modals.css`). |
| [`html/assets/`](../../html/assets/) | Assets | JSON sprite matrices (`sprites/`), OpenMoji SVG icons, and brand graphics. |

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

### Handled RPC Commands (20 Handlers)

The dispatch table is `COMMAND_HANDLERS` in [`html/worker/game-worker.js`](../../html/worker/game-worker.js); [`game-client.js`](../../html/worker/game-client.js) exposes one Promise-wrapped method per command.

| Command | Purpose |
| :--- | :--- |
| `bootstrap` | Initializes database, checks profile/options, applies migrations, returns active save status. |
| `listSlots` | Returns metadata array for all 5 save slots. |
| `createSlot` | Initializes a new character for slot `1..5` and generates the first level of the selected tower. |
| `loadSlot` | Loads the character and floor cache for an existing occupied slot (lazily applying the party migration). |
| `selectTower` | Moves an occupied slot to a tower's level 1; rejects a tower whose campaign `unlockRequires` are unmet and resets per-run keys/springs. |
| `completeTower` | Records a tower in `towerProgress`, unlocks the next tower in campaign order, and returns campaign state (`allComplete`, `nextTowerId`, `recruitableVocations`). |
| `recruitMember` | Adds a not-yet-recruited vocation to the party at level 1 and makes it the active member; rejects unknown/duplicate/over-cap recruits. |
| `deleteSlot` | Clears character, metadata, and cached floors for a slot. |
| `restartFloor` | Restores character to the arrival snapshot (`floorEntry`) on the active floor. |
| `respawnAfterDeath` | Sets entrance coordinates and restores vitals for town respawn. |
| `newGame` | Legacy single-save slot initializer. |
| `saveCharacter` | Debounced or immediate persistence of player state and slot metadata (captures the active member first). |
| `getFloor` | Retrieves cached floor or invokes `floor-generator.js` to create a new level. |
| `saveFloorState` | Persists chest opened/looted states for the active floor. |
| `advanceFloor` | Updates player level index, resolves stair arrival coordinates, and saves snapshot. |
| `getOptions` / `setOptions` / `resetOptions` | Reads, writes, or resets game settings and audio preferences. |
| `setSoundEnabled` | Toggles audio setting in persistent storage. |
| `resetProgress` | Clears all stores across slots, characters, and floors (including all three migration guards). |

---

## 5. Tower Campaign & Multi-Tower Registry

The launch "five-level spire" is now one entry in a data-driven registry. [`html/data/tower_levels.json`](../../html/data/tower_levels.json) is a root object `{ defaultTowerId, campaign, towers[] }`; each tower declares its own `order`, `unlockRequires`, `theme`, `levels[]`, `monsterGroups`, `boss`, and `levelCount`.

* **Authored towers (default):** `spire_of_light` (order 1, 5 levels), `sunken_catacombs` (order 2, 4 levels), `emberforge` (order 3, 5 levels), `rime_aerie` (order 4, 3 levels). Adding or reordering a tower is a catalog edit, not a code change.
* **Registry helpers** ([`html/data/index.js`](../../html/data/index.js)): `getTowerDefinition`, `listTowerDefinitions`, `listTowerDefinitionsByOrder`, `towerLevelCount`, `clampToTowerLevel`, `towerLevelSpec`, `towerOrder`, `firstTowerId`, `isTowerId`, `towerUnlockRequires`, `towersUnlockedBy`, `nextTowerIdAfter`.
* **Party-size balance:** `campaign.partyScale` (hp/atk multipliers keyed by active party size) is applied by `generateFloor` on top of each tower's `monsterGroups.statScale`, so a four-member run stays challenging without damage-sponge bosses.
* **Generation:** `generateFloor(floorNumber, seed, towerId, partySize)` in [`html/services/floor-generator.js`](../../html/services/floor-generator.js) clamps the requested level to the selected tower's `levelCount`, resolves the tower theme/biome and monster pool, and uses the canonical seed `1337 + levelId * 42`. It runs inside the worker.
* **Progression loop:** clearing a tower's summit calls `completeTower` (worker) → `completePlayerTower` ([`html/engine/campaign.js`](../../html/engine/campaign.js)), which records the tower in `player.towerProgress` and unlocks the next by order. The flow is non-terminal: **Tower Complete → Recruit → enter the next tower**; **Ultimate Victory** fires only when every authored tower is `allComplete`.
* **Hub & selection:** the Havenreach Town Hub ([`ui.json`](../../html/data/ui.json) `town`) routes into the tower picker (`listTowerDefinitions` + `towerUnlockInfo`); locked towers render disabled, and `selectTower` enforces the same `unlockRequires` gate server-side in the worker even if the picker is bypassed. Completed towers stay replayable.

See [`party-data-model.md`](party-data-model.md) §3 and §6 for the locked `towerProgress` shape and campaign helpers.

---

## 6. Party Data Model, Save Migration & Campaign

The player object is now a party. The **top level remains the active member's live state** (so every input/render/combat path is unchanged) and three fields extend it: `player.party` (`PartyMember[]`), `player.activeMemberId`, and `player.towerProgress`. Shared resources — `backpack` and `levelKeys` — live only on the top level. [`html/engine/party.js`](../../html/engine/party.js) owns the sync contract (`captureActiveMember`, `applyActiveMember`, `setActiveMember`, `cycleActiveMember`, `migratePlayerParty`).

Persistence rides on the existing `characters` object store; slot metadata mirrors `towerProgress` via `deriveSlotMeta` so the tower picker can gate without loading the character. Migrations run in [`html/services/storage.js`](../../html/services/storage.js), each guarded in `game_settings`: `migration_slot_v2`, `migration_tower_v3`, `migration_party_v4`. `migratePlayerParty` is also applied lazily on `loadSlot`, `selectTower`, `restartFloor`, `respawnAfterDeath`, `advanceFloor`, `saveCharacter`, and `newGame`, so a save is always party-shaped before it is persisted.

The full locked contract — member shape, `MEMBER_EXCLUDED_KEYS`, migration semantics, `party_ai.json`/`tower_levels.json` schemas, and the combat-actor/faction rules — lives in [`party-data-model.md`](party-data-model.md).

---

## 7. Generalized Combat Actors & Party Auto-AI

Combat is actor-agnostic; there is no global player.

* **Faction model** ([`html/engine/faction.js`](../../html/engine/faction.js)): every player-shaped actor carries `faction: "party"`; catalog monsters declare `faction: "monsters"`. `isFriendly(a, b)` is true only when both declare the same non-empty faction; `isHostile(a, b)` is its negation (undeclared is hostile).
* **Actor contract:** every `CombatSystem.executeX` method takes the acting member as its first argument and owns its own cooldowns, vitals, gear, and position. `tickActorTimers` / `decrementCooldowns` advance per member.
* **Friendly fire:** `CombatSystem.applyIncomingDamage(target, damage, attacker)` is the single zeroed-damage seam for friendly hits (melee, projectile, AoE, dash, status). `projectile-collision.js` accepts an optional `isHostile` predicate.
* **Party auto-AI** ([`html/engine/party-ai.js`](../../html/engine/party-ai.js)): pure, browser-free. `PartyAI.updateAllies(player, { gridMap, monsters, deltaSec })` runs each non-active `auto` member through a catalog-driven order — retreat → cast → engage → search → follow — using `party_ai.json` profiles (`profileForVocation`). Ability dispatch is `ABILITY_HANDLERS` keyed by the catalog `actionKey`; an unknown key is skipped, never guessed. `game-loop.js` turns returned events into animation, sound, combat log, floating text, and shared party loot/XP.
* **Monster targeting:** `EntityAI.updateMonsters(monsters, player, gridMap, dt, targets)` and `EntityAI.selectTarget(monster, targets)` are faction-gated and pick the nearest living party member; each result carries the struck `target`.

---

## 8. Enemy AI Dispatch (`aiType`)

[`html/engine/entity-ai.js`](../../html/engine/entity-ai.js) selects positioning/attack behavior from the catalog `aiType` through the `AI_HANDLERS` dispatch table (exposed as `EntityAI.AI_TYPES`). The shipped handlers are `chase`, `standoff`, `ranged`, `charger`, `bomber`, and `summoner`. Unknown or missing `aiType` falls back to `chase`, so adding an opponent is (at minimum) a `monsters.json` entry plus, if visually unique, a renderer/dispatch function — never a JS branch on a monster name.
