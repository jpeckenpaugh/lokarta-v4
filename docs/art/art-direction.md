# Lokarta: Art Direction Specification

Authoritative 16-bit SNES-inspired pixel art direction and rendering contract for *Lokarta: Come Into The Light*.

---

## 1. Resolution, Coordinate Space & Tile Footprint

* **Atomic tile $= 32\times32$ native px.** **ONE $32\times32$ canvas is exactly
  ONE tile.** Everything is authored, placed, and collision-tested on this single
  tile grid; there is no sub-tile sprite grid. A scene element is therefore
  always a *whole number of tiles* on each axis — never squished to fit one tile.
* **Single-tile canvases ($1\times1$ tile):** the $32\times32\text{ px}$ canvas is
  mandatory for actors, player vocations, regular monsters, NPCs, single-tile
  props, and tiles. These never exceed one tile.
* **Boss canvas ($1\times1$ tile + overhang):** $48\times48\text{ px}$ for The
  Spire Warden (`abyssal_overlord`), rendered bottom-aligned with horizontal
  centering. $48$ is not a tile multiple, so the boss is a *single-tile entity*
  whose canvas overhangs its cell by $8\text{ px}$ per horizontal side (and $16$
  at top). It occupies **one** tile for collision/occupancy — it is **not** a
  multi-tile sprite. A boss canvas larger than $48\times48$ (e.g. $64\times64$)
  requires an engine occupancy change and is deferred to the Tech Lead.
* **Multi-tile scene objects ($W\times H$ tiles):** signature props/landmarks
  (fishing hut, Longhouse, boat) and town buildings use $32W\times32H$ native px.
  Allowed footprints: $W, H \in \{1,2,3,4\}$ (non-square allowed), i.e. canvases
  from $32\times32$ up to $128\times128$ native px. A $128\times64$ hut is
  $4\times2$ tiles; a $96\times96$ landmark is $3\times3$.
* **Tile-grid alignment.** A multi-tile piece's top-left origin is snapped to an
  integer tile $(x_0, y_0)$; its canvas covers exactly the inclusive tile rect
  $[x_0, y_0] \ldots [x_0{+}W{-}1, y_0{+}H{-}1]$ — the engine's existing
  `footprint:[x0,y0,x1,y1]` form consumed by `renderBuildingSilhouettes`
  (`html/app/canvas-renderer.js`). No partial-tile offsets, no fractional
  placement.
* **Native vs. display scaling.** Display tile $=$ `CONFIG.GRID_SIZE = 64\text{ px}`,
  `SCALE = CONFIG.GRID_SIZE / 32 = \times2`. A piece scales by the *same* integer
  `SCALE` across its whole canvas in one blit, so a $W\times H$ native canvas
  displays at $(64W)\times(64H)\text{ px}$ covering exactly $W\times H$ display
  tiles. No per-tile scaling and no squish-to-one-tile.
* **"Chopping."** Multi-tile assets are authored/rendered at full multi-tile
  native resolution, then decomposed against the $32\text{ px}$ tile grid —
  either sliced into $32\times32$ tile chunks or stored as one $W\times H$
  char-grid bitmap blitted into its footprint. **Placement rides the existing
  building footprint + `BUILDING_SILHOUETTE_RENDERERS` dispatch — not a new
  sprite path.** The exact blit-vs-slice binding and the asset JSON field names
  are [LIV-106](/LIV/issues/LIV-106)'s (Tech Lead).
* **Rendering Style:** `image-rendering: pixelated; crisp-edges`. No
  anti-aliasing or sub-pixel coordinate offsets.

### 1.1 Multi-tile eligibility by asset class

| Class | Tile footprint | Native canvas | Notes |
| :--- | :--- | :--- | :--- |
| Tiles | $1\times1$ | $32\times32$ | atomic stage cell |
| Actor / monster / vocation / NPC | $1\times1$ | $32\times32$ | collision + animation contract |
| Regular prop (`prop_*`) | $1\times1$ | $32\times32$ | placed per grid cell, walk-over |
| Boss | $1\times1$ (+overhang) | $48\times48$ | single-tile entity, centered/bottom-aligned |
| Signature prop / landmark | $W\times H$ | $32W\times32H$ | boat, drying-rack, fishing hut |
| Town building | $W\times H$ | $32W\times32H$ | occupies its footprint; feeds collision |

Single-tile props stay single-tile. A scene element only becomes multi-tile when
it is a *building/landmark* that rides the footprint mechanism above.

---

## 2. Facing & Animation Models

* **3-Direction Facing:** Sprites are authored for three directions (`down`, `up`, `side`). `left` is rendered by mirroring `side` horizontally.
* **Frame Sets per Actor:**
  * `idle`: 3 directions (1 frame each)
  * `walk`: 3 directions (2 frames each, step-driven)
  * `attack`: 3 directions (3 frames each)
  * `hit`: 3 directions (1 frame each)
  * `death`: 4 frames (`death_0`..`death_3`) non-directional (Boss `abyssal_overlord` has 6 frames: `death_0`..`death_5`).
* **Outline & Shading:** Standard $1\text{ px}$ silhouette outline (`#0b0d12`) with $\le 16$-color indexed palettes and flat pixel ramps. A new opt-in **Tier B "baked"** class (≤32 colors, 4-step ramps, ordered dither, baked key light) is specified in [art-direction-target.md](art-direction-target.md) for heroes, bosses, and signature NPCs/props; it keeps the pixelated rule and the ≥3:1 rim bar.
  * **Tier B outline exception (LIV-115, round 2.2):** 3D-baked (Tier B) renders **drop the $1\text{ px}$ outline** — the board read the `#0b0d12` ring as a "pencil trace", so baked colours now end naturally at the silhouette. The bake emits `outline:false` and the renderer honours it (sprite + building + prop paths). **Tier A flat sprites keep the outline unchanged.** Rim-light/ramp shading stays: it is form, not an outline.

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
