# Lokarta: Come Into The Light — AI Agent Development Guidelines & Best Practices

This document provides mandatory architectural rules, engineering guidelines, and development best practices for AI coding agents and human contributors working on **Lokarta: Come Into The Light**.

---

## 1. Core Architectural Philosophy

Lokarta is a zero-backend, client-side 2D roguelike RPG designed to run natively in modern web browsers using pure web standards. It enforces a strict separation of concerns across two threads:

1. **Main UI Thread:** Owns 60 FPS interpolated Canvas 2D rendering, static DOM HUD management, procedural Web Audio API synthesis, and user input capture.
2. **Dedicated Web Worker Thread (`game-worker.js`):** Owns heavy computational tasks, deterministic procedural floor generation, BFS path validation, and asynchronous IndexedDB state persistence.

All changes must preserve this zero-backend, dual-loop, multi-threaded architecture.

### Operating team & verification ownership

The project is delivered by a **flat three-seat team**, not a layered org chart:

1. **CEO** — thin facilitator and single gate between the team and the board. Sets priorities, routes work, hires/unblocks. Not an implementation or quality gate.
2. **Tech Lead (engineering)** — owns all code, tests, CI, deploy, and infra. Absorbs the former CTO, Engineer, and QA seats.
3. **Designer** — owns UX, visual/art direction, and design specs. Absorbs the former Game Designer.

The **board** owns product direction, priorities, final approvals, and browser/gameplay verification (T2). There is no separate CTO, no dedicated QA agent, and no Producer seat. The full testing model is in [Section 8](#8--testing-model-t0t1t2).

---

## 2. 🗃️ The Golden Rule: Data-Driven Architecture (No Lazy Hardcoding)

> [!IMPORTANT]
> **Never hardcode game constants, entity behaviors, class stats, or drop tables in JavaScript source files.**
> All game rules must be defined in the decoupled JSON data catalogs located under [`html/data/`](html/data/).

### Specific Rules:
1. **Catalog Ground Truth:**
   All stats, spell radii, weapon types, damage steps, drop tables, sound frequencies, keybindings, monster AI types, party AI profiles, presentation tunables, and room coordinates **must** originate in the 23 JSON catalogs:
   - `cards.json`, `monsters.json`, `items.json`, `vocations.json`, `sounds.json`, `abilities.json`, `biomes.json`, `encounters.json`, `dungeons.json`, `tower_levels.json`, `doors.json`, `chests.json`, `tile_themes.json`, `keybindings.json`, `ui.json`, `economy.json`, `party_ai.json`, `islands.json`, `towns.json`, `npcs.json`, `quests.json`, `dialogues.json`, `codex.json`.
2. **No String Heuristics:**
   Never write heuristics like `itemId.includes('bow')`, `name.includes('cultist')`, or `vocation === 'fighter'` in game logic.
   - If an item needs a specific combat handler: declare `"actionKey": "bow_shot"` in `items.json`.
   - If a monster uses standoff AI: declare `"aiType": "standoff"` in `monsters.json`.
   - If an item belongs to a vocation: declare `"vocationAffinity": "archer"` in `items.json`.
3. **Polymorphic Dispatch Tables:**
   Replace `switch` statements and `if/else` ladders with dictionary dispatch tables (e.g., `AI_HANDLERS`, `EQUIP_TICK_EFFECTS`, `WEAPON_RENDERERS`, `ITEM_RENDERERS`, `TILE_RENDERERS`).
   - Adding a new monster or weapon should only require adding a catalog JSON entry and (if visually unique) a renderer function in the dispatch table.
4. **Graceful Defaults:**
   Always supply a safe fallback in dispatch lookups:
   ```javascript
   // Good: Catalog-driven with fallback
   const handler = AI_HANDLERS[mData?.aiType] || AI_HANDLERS.chase;
   return handler(monster, player, gridMap, monsters, mData);
   ```

---

## 3. ⚡ Hot-Path Performance & Garbage Collection Discipline

Lokarta runs a 60 FPS Canvas rendering loop alongside a 10 Hz (100 ms) simulation tick loop. Hot-path code must execute without causing frame drops or triggering frequent browser young-generation (Scavenge) Garbage Collection pauses.

### Specific Rules:
1. **Zero Transient Allocations in Hot Loops:**
   Never allocate temporary arrays (`[]`) or coordinate objects (`{ x, y }`) inside functions called every tick or every frame (e.g., `updateLighting`, `findNextStepAStar`, `render`, `castLightCircle`).
2. **Integer Coordinate Hashing for Sets and Maps:**
   For grid lookups on a map of width $W$, always use integer hashing (`const hash = y * width + x;`) instead of template strings (`` `${x},${y}` ``). String allocations inside loops cause heavy GC churn.
3. **Canvas Overdraw Culling:**
   In [`CanvasRenderer`](html/app/canvas-renderer.js), never draw tiles, items, or decorations that are shrouded in darkness:
   ```javascript
   // Always cull unlit coordinates before making Canvas 2D calls
   if (!tile.isLit) continue;
   ```
4. **Data Structures for Pathfinding:**
   A\* pathfinding in [`EntityAI`](html/engine/entity-ai.js) must use a binary `MinHeap` for $O(\log N)$ extraction and an integer-keyed `openMap` (`Map<number, Node>`) for $O(1)$ coordinate lookup. Never do linear array searches (`openSet.find(...)` or `openSet.splice(...)`).
5. **Precomputed Spatial Lookups:**
   Precompute monster occupancy hashes (`blockedMonsterSet = new Set()`) once per tick before looping through monsters rather than running `monsters.some(...)` inside pathfinding neighbor steps.

---

## 4. 🖥️ DOM Hygiene & Event Delegation

> [!WARNING]
> **Never blow away container `innerHTML` on periodic simulation ticks.** Rebuilding DOM trees destroys elements mid-interaction, drops input events, and triggers layout thrashing.

### Specific Rules:
1. **Single-Pass Skeleton Initialization:**
   DOM containers for the loadout panel (active slots `1`–`4`, equipment slots `Q,W,E,R`), backpack grid (36 slots), status bars, and combat log must be generated **once** during startup.
2. **Selective Tick Diffing:**
   On every 10 Hz simulation tick, update existing elements selectively (e.g., mutate `.textContent`, `.style.width`, or `.classList.toggle()`) only when values actually change:
   ```javascript
   if (nameEl.textContent !== newName) nameEl.textContent = newName;
   ```
3. **Event Delegation Only:**
   Do not attach event listeners to dynamic list items or action buttons in loops. Attach delegated listeners to static parent containers (e.g., `#loadout-container`, `#backpack-container`) using `e.target.closest('.loadout-slot')` or `e.target.closest('.backpack-slot')`.
4. **Pointer Event Bubbling:**
   Manage pointer drag/drop and slot interactions through unified root delegation (`pointerdown`, `pointermove`, `pointerup`) with coordinate inspection (`document.elementFromPoint`).
5. **Unbounded DOM Capping:**
   Any scrolling log, particle container, or floating text list must enforce a strict upper bound (e.g., ring-buffer pruning via `while (count > MAX) removeChild(firstElementChild)`).

---

## 5. 🧵 Threading, Web Workers & Storage Guidelines

1. **Keep Heavy Work Off the UI Thread:**
   Procedural tower floor generation, BFS room connectivity validation, and IndexedDB I/O belong strictly in [`html/worker/game-worker.js`](html/worker/game-worker.js).
2. **Debounce Persistence Calls:**
   Do not dispatch `saveCharacter` worker messages on every minor user action. Use a trailing debounce timer (e.g., 500 ms) for rapid actions (potions, looting), reserving immediate saves (`persistSave(true)`) for critical transitions:
   - Floor ascent / descent stairs
   - Player leveling up
   - Game over / defeat (persisting revival at the Temple of the Dawn)
3. **Message Serialization (Structured Clone):**
   State sent between the main thread and `game-worker.js` must be pure JSON-serializable state. Never pass functions, DOM elements, or circular object graphs across `postMessage`.

---

## 6. 🎲 Determinism & Procedural Generation

1. **Mulberry32 PRNG:**
   Always use the deterministic Mulberry32 PRNG ([`createPRNG`](html/services/floor-generator.js)) for tower floor carving, room layout, and monster tier selection. Never use `Math.random()` in procedural generation.
2. **BFS Connectivity Guarantee:**
   Any modification to tower templates or floor generation algorithms must guarantee and verify full Breadth-First Search (BFS) path connectivity between the arrival spawn tile and the connecting ascent stair tile on every authored floor of every tower.
3. **Consistent Floor Seeds:**
   Use the canonical formula `(1337 + floorId * 42)` for floor seeds unless an explicit seed parameter is provided.

---

## 7. 🌐 Pure Web Standards & Zero Dependencies

1. **No External Packages or Bundlers:**
   The project has **zero npm dependencies**. Do not add packages from npm, Webpack, Vite, Babel, or external CDN scripts. The application must run cleanly from standard static HTTP servers (`./run.sh`).
2. **Native ES Modules:**
   Use standard ES Modules (`import`/`export`) with explicit file extensions (`.js`, `.json`). Use modern standard import attributes for JSON:
   ```javascript
   import itemsData from './items.json' with { type: 'json' };
   ```
3. **Web Standards First:**
   Rely on standard web APIs: Canvas 2D Context, Web Audio API, Web Workers, and IndexedDB.

---

## 8. 🚦 Testing Model (T0/T1/T2)

> [!IMPORTANT]
> **Only T0 — the unit/code suite plus CI — is an agent gate.** Full browser/gameplay verification belongs to the board (T2). There is **no CTO-owned QA gate, no single-flight lock, no SHA freeze, and no per-PR browser-evidence bundle.** This section supersedes and retires the former "QA Gate Policy v2".

Three tiers:

1. **T0 — unit/code (agents, every change).** Run `node --test html/tests/*.test.mjs` (full native suite, zero dependencies) and keep [`.github/workflows/test.yml`](../../.github/workflows/test.yml) green on push/PR. New behavior updates its tests; never delete a test to go green. This is the definition-of-done gate.
2. **T1 — build/preview smoke (agents, light).** CI deploys `main` to GitHub Pages via [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml); the live preview is <https://lk.livive.net/>. The Tech Lead posts the preview URL plus a 3–5 line manual test script on the issue. No screenshot archive and no committed evidence bundle.
3. **T2 — browser/gameplay (board only).** The board plays the preview and confirms. Agents do not block on browser verification, do not own it, and do not build per-change browser evidence.

**On-demand tooling (not a gate).** Keep `tools/render-*.mjs` available as a self-serve smoke aid for anyone who wants a rendered preview. They are optional, not required for any change, and are not wired into CI.

**Ownership.** The Tech Lead owns T0 and T1. The board owns T2. Verification is never routed through a CTO or a separate QA seat.

---

## 9. 🧪 T0 Unit Test Mandate

> [!IMPORTANT]
> **Every change must pass the automated test suite before completion. This is the only agent verification gate (see [Section 8](#8--testing-model-t0t1t2)).**

1. **Run the Test Suite:**
   Before completing any task, execute the native Node.js test runner from repository root:
   ```bash
   node --test html/tests/*.test.mjs
   ```
   The glob covers every `html/tests/*.test.mjs` file. CI (`test.yml`) runs the same command on every push.
   **Acceptance Criteria:** All test suites must pass with zero failures.
2. **Synchronize Catalog Tests:**
   When adding or modifying entries in `html/data/*.json`, always update or verify the corresponding schema test assertions in [`html/tests/data-catalogs.test.mjs`](html/tests/data-catalogs.test.mjs).
3. **Regression Safety:**
   Never remove existing tests to make a build pass; adapt the test only when the explicit specification for that behavior was updated.

---

## 10. Agent Checklist Before Concluding Any Task

- [ ] Are all new constants, items, monsters, or abilities defined in `html/data/*.json`?
- [ ] Are there zero string sniffing checks (e.g. `itemId.includes(...)`) or hardcoded `if/else` ladders?
- [ ] Does any hot loop (Canvas render or 10 Hz tick) avoid creating temporary arrays or `{x, y}` objects?
- [ ] Are DOM elements reused rather than rebuilt with `innerHTML`?
- [ ] Are event listeners delegated with boundary checks?
- [ ] Did you test procedural generation determinism with Mulberry32?
- [ ] Did you execute `node --test ...` and verify all tests pass?

---

## 11. 🌿 Branching, Merge & Deploy

- **Land on `main`.** Finished work is not done until it is merged to `main` and pushed to `origin`. Never leave a detached feature branch as the handoff; the board tests `main`.
- **`main` auto-deploys.** A push to `main` triggers [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) to GitHub Pages at <https://lk.livive.net/>. The deploy step regenerates `build-id.json`, which drives the per-deployment cache flush ([`docs/engineering/build-versioning.md`](build-versioning.md)).
- **Keep the suite green.** [`.github/workflows/test.yml`](../../.github/workflows/test.yml) must stay green on every push/PR before the change is considered landed.
- **Small, reversible commits.** Add `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.
