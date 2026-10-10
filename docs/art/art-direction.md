# Lokarta: Art Direction Specification

Authoritative 16-bit SNES-inspired pixel art direction and rendering contract for *Lokarta: Come Into The Light*.

---

## 1. Resolution & Coordinate Space

* **Native Sprite Canvas:** $32 \times 32\text{ px}$ for actors, player vocations, regular monsters, props, and tiles.
* **Boss Canvas:** $48 \times 48\text{ px}$ for The Spire Warden (`abyssal_overlord`), bottom-aligned with horizontal centering.
* **Display Tile Grid:** Scaled by integer scaling factor `SCALE = CONFIG.GRID_SIZE / 32` ($\times 2$ at $64\text{ px}$ tiles).
* **Rendering Style:** `image-rendering: pixelated; crisp-edges`. No anti-aliasing or sub-pixel coordinate offsets.

---

## 2. Facing & Animation Models

* **3-Direction Facing:** Sprites are authored for three directions (`down`, `up`, `side`). `left` is rendered by mirroring `side` horizontally.
* **Frame Sets per Actor:**
  * `idle`: 3 directions (1 frame each)
  * `walk`: 3 directions (2 frames each, step-driven)
  * `attack`: 3 directions (3 frames each)
  * `hit`: 3 directions (1 frame each)
  * `death`: 4 frames (`death_0`..`death_3`) non-directional (Boss `abyssal_overlord` has 6 frames: `death_0`..`death_5`).
* **Outline & Shading:** Standard $1\text{ px}$ silhouette outline (`#0b0d12`) with $\le 16$-color indexed palettes and flat pixel ramps.

---

## 3. Contrast & Visibility Rule

To guarantee visibility in dark dungeon environments:
* Every actor and monster must maintain a **$\ge 3:1$ WCAG contrast ratio** rim color against the floor background (`tile_themes.floor.fill`, luminance $\le 0.02$).
* Layer render order in `CanvasRenderer` draws tile decor and chests under the light mask, while actors, player VFX, and projectiles are rendered above the light mask to keep silhouettes distinct.

---

## 4. Tile Themes & Decor Props

* **Tile Themes:** Authored per level in `html/data/tile_themes.json` (*The Gatehouse, The Hall of Banners, The Bell Keep, The Solar Gallery, The Crown Spire*), mapped to tier IDs (`crypt`, `catacombs`, `shadow_vaults`, `abyssal_sanctum`, `crown_spire`). LIV-5 adds named tower palettes resolved through each tower's `theme.levelTheme` map: **The Emberforge** (`cinder_gate`, `slagworks`, `molten_hall`, `forge_heart`, `anvil_crown`) and **The Rime Aerie** (`frost_threshold`, `bell_aerie`, `choir_loft`). Root **scene themes** `island_dawnreach` and `town_havenreach` (LIV-58) author palettes for the appended overworld tile types (`WATER, GRASS, SAND, PATH, TREE, BRIDGE, BUILDING_WALL, DOORWAY, TOWER_ENTRANCE`); they live outside `levels` so the tower contrast scan is unchanged. Every palette keeps floor luminance ≤ 0.02 to preserve the ≥ 3:1 actor rim contrast bar.
* **Biomes:** `html/data/biomes.json` carries the per-level display name and light colour. Tower tiers added by LIV-5 resolve by `tierId` and carry no `minLevel`/`maxLevel`, so the launch five keep the legacy floor scan.
* **Room Decor & Props:** Authored in `html/data/tower_levels.json` (`propPolicy`):
  * Furniture & decor: `throne`, `altar`, `sarcophagus`, `candelabra`, `bookshelf`, `brazier`, `table`, `crate`, `barrel`, `rug`.
  * Braziers emit dynamic ambient light (`brazierLightRadius: 2.5`, max 2 per room).
* **Preview PNGs:** Committed export previews reside in `docs/art/preview/` and are drift-checked by `html/tests/sprite-assets.test.mjs`.

---

## 5. Fishing-Village Re-Theme (LIV-100 / LIV-101)

The walkable town re-skins into a **Shore People fishing village** without new art
systems — every element rides an existing contract.

* **Coastal palette:** `town_havenreach` authors `outside.mode:"water"` plus scene
  palettes for `WATER` (deep/fill/crest/foam, drift animation), `SAND` (shell +
  wet edge), `BRIDGE`, and **`DOCK`** (timber planks, posts, seafoam edge). Driftwood
  greys/browns, sea-greens, sandy tans, bright river-blue — per the concept doc's
  *Visual Notes*. Off-map tiles paint open water, never grass.
* **Harbor geography:** the town map carves a `WATER` basin, a `SAND` beach, and a
  walkable `DOCK` quay to the south gate. `DOCK` is appended as tile code `16` (never
  renumbering existing codes) and is walkable.
* **Props:** authored 32×32 fishing props — `prop_net`, `prop_drying_rack`,
  `prop_fish_barrel`, `prop_boat`, `prop_buoy`, `prop_smoke_plume` — placed as
  catalog data (walk-over; no per-prop JS). The **Longhouse** opts into the
  data-driven `BUILDING_SILHOUETTE_RENDERERS` hook (`ark_hull`) for its inverted-keel
  roof-ridge; silhouette selection is a catalog value, not a per-building branch.
* **NPC cast:** 13 distinct `npc_*` silhouettes (8 named + 5 ambient Shore folk),
  each one outline-changing signature prop and a 48×48 × 3-expression portrait set,
  authored by `tools/author-npc-assets.mjs` to [npc-identity-spec.md](../design/npc-identity-spec.md)
  §2. New fishing-flavored OpenMoji icons committed under `html/assets/openmoji/`
  (`1F3A3` fishing pole, `1F41F` fish, `1F9FA` basket, `1F9D1` person).
