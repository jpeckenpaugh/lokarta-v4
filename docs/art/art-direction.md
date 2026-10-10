# Lokarta: Art Direction Specification

Authoritative 16-bit SNES-inspired pixel art direction and rendering contract for *Lokarta: Come Into The Light*.

---

## 1. Resolution, Coordinate Space & Tile Footprint

* **Atomic tile = ONE whole tile.** Everything is authored, placed, and
  collision-tested on a single whole-tile grid; there is no sub-tile sprite grid. A
  scene element is therefore always a *whole number of tiles* on each axis — never
  squished to fit one tile. **As of [LIV-116](/LIV/issues/LIV-116) / [LIV-120](/LIV/issues/LIV-120)
  the tile has two native densities (§6):** hand-authored / 2D-derived art is
  **$32\times32$ native px per tile (N32)**; **3D-baked** art is **$64\times64$
  native px per tile (N64)**.
* **Single-tile canvases ($1\times1$ tile):** a **$32\times32\text{ px}$** canvas (N32)
  for hand-authored actors, player vocations, regular monsters, NPCs, single-tile
  props, and tiles; a **$64\times64\text{ px}$** canvas (N64) for **3D-baked** actors
  (§6). Either way the canvas is exactly one tile and never exceeds it.
* **Boss canvas ($1\times1$ tile + overhang):** $48\times48\text{ px}$ for The
  Spire Warden (`abyssal_overlord`), rendered bottom-aligned with horizontal
  centering. $48$ is not a tile multiple, so the boss is a *single-tile entity*
  whose canvas overhangs its cell by $8\text{ px}$ per horizontal side (and $16$
  at top). It occupies **one** tile for collision/occupancy — it is **not** a
  multi-tile sprite. A boss canvas larger than $48\times48$ (e.g. $64\times64$)
  requires an engine occupancy change and is deferred to the Tech Lead.
* **Multi-tile scene objects ($W\times H$ tiles):** signature props/landmarks
  (fishing hut, Longhouse, boat) and town buildings use $32W\times32H$ native px
  (N32), or **$64W\times64H$** when **3D-baked** (N64, §6). Allowed footprints:
  $W, H \in \{1,2,3,4\}$ (non-square allowed): $32\times32$–$128\times128$ native px
  for N32; $64\times64$–$256\times256$ for N64. A $4\times2$ N32 hut is
  $128\times64$; the $12\times4$ N64 longhouse is $768\times256$.
* **Tile-grid alignment.** A multi-tile piece's top-left origin is snapped to an
  integer tile $(x_0, y_0)$; its canvas covers exactly the inclusive tile rect
  $[x_0, y_0] \ldots [x_0{+}W{-}1, y_0{+}H{-}1]$ — the engine's existing
  `footprint:[x0,y0,x1,y1]` form consumed by `renderBuildingSilhouettes`
  (`html/app/canvas-renderer.js`). No partial-tile offsets, no fractional
  placement.
* **Native vs. display scaling — see §6.** Display tile $=$ `CONFIG.GRID_SIZE = 64\text{ px}`.
  A sprite blits at the **largest integer scale** that fits its tile(s):
  `scale = max(1, floor(displayTile / nativeTile))`. At the default 64 px tile a
  **64-native (N64, 3D-baked)** asset renders **1:1** (`scale = 1`) and a **32-native
  (N32)** asset renders $\times2$ (`scale = 2`), unchanged. A piece scales by the
  *same* integer `scale` across its whole canvas in one blit; no per-tile scaling and
  no squish-to-one-tile.
* **"Chopping."** Multi-tile assets are authored/rendered at full multi-tile
  native resolution, then decomposed against the tier's per-tile native grid
  ($32\text{ px}$ N32, $64\text{ px}$ N64 — §6) — either sliced into tile-sized
  chunks or stored as one $W\times H$ char-grid bitmap blitted into its footprint.
  **Placement rides the existing building footprint + `BUILDING_SILHOUETTE_RENDERERS`
  dispatch — not a new sprite path.** The exact blit-vs-slice binding and the asset
  JSON field names are [LIV-106](/LIV/issues/LIV-106)'s (Tech Lead).
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

Native canvas $= \text{tiles} \times$ the tier's per-tile native — $32\text{ px}$ for
N32, $64\text{ px}$ for 3D-baked N64 (§6). The $64\text{ px}$ native applies **only**
to assets re-sourced from a 3D render; every other row stays N32 until re-sourced.

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
* **Outline & Shading:** Standard $1\text{ px}$ silhouette outline (`#0b0d12`) with $\le 16$-color indexed palettes and flat pixel ramps. A new opt-in **Tier B "baked"** class (≤32 colors for 2D-derived defs; **≤256 entries / 255 opaque for 3D-baked defs, §11** (supersedes §10), ordered dither, baked key light) is specified in [art-direction-target.md](art-direction-target.md) for heroes, bosses, and signature NPCs/props; it keeps the pixelated rule and the ≥3:1 rim bar.
  * **Tier B outline exception (LIV-115, round 2.2):** 3D-baked (Tier B) renders **drop the $1\text{ px}$ outline** — the board read the `#0b0d12` ring as a "pencil trace", so baked colours now end naturally at the silhouette. The bake emits `outline:false` and the renderer honours it (sprite + building + prop paths). **Tier A flat sprites keep the outline unchanged.** Rim-light/ramp shading stays: it is form, not an outline.
* **Ground contact (all actors):** the silhouette ground-shadow of §7 — the shared renderer ellipse is retired. It is deliberately distinct from the outline (squashed, offset, $\alpha\le0.55$, only under the actor).

---

## 3. Contrast & Visibility Rule

To guarantee visibility in dark dungeon environments:
* Every actor and monster must maintain a **$\ge 3:1$ WCAG contrast ratio** rim color against the floor background (`tile_themes.floor.fill`, luminance $\le 0.02$).
* Layer render order in `CanvasRenderer` draws tile decor and chests under the light mask, while actors, player VFX, and projectiles are rendered above the light mask to keep silhouettes distinct.
* The **ground shadow** (§7) is deliberately tuned to a **modest** contrast band *below* the actor's $\ge 3{:}1$ rim (target $1.08{:}1$–$1.5{:}1$ vs floor) so it reads as ground contact, never as a second silhouette or as an outline.

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

---

## 6. Native Resolution Tiers (LIV-116 / LIV-120)

The board directed (2026-10-10) that **every sprite rendered from a 3D asset is
re-rendered at 1:1 — native 64 px per tile** — while existing non-3D art stays at
its current 32 px per tile (being phased out; **no upscaling**). This section is the
authoritative migration rule that [LIV-121](/LIV/issues/LIV-121) implements. It
amends §1's single "32 px native" assumption without changing any other runtime
contract.

### 6.1 The two native tiers

| Tier | Source | Native tile | At the default 64 px display tile | Examples |
| :--- | :--- | :--- | :--- | :--- |
| **N32** | hand-authored / 2D-derived (Tier A, and 2D-derived Tier B) | $32\times32$ px | $\times2$ (each source px = a $2\times2$ block) | monsters, NPCs, tiles, magician/paladin/fighter, bosses |
| **N64** | **3D-baked** | $64\times64$ px | **1:1** (each source px = one display px) | `archer` (rukiya), 3D-baked buildings & nets |

### 6.2 Rules

1. **3D-sourced → native 64 px per tile.** A $1\times1$ actor is a $64\times64$
   canvas; a multi-tile building/landmark is $64W\times64H$ (e.g. a longhouse that
   is $12\times4$ tiles is $768\times256$ native).
2. **Non-3D → native 32 px per tile, unchanged.** No upscaling; the current
   $32\times32$ / $32W\times32H$ canvases stay exactly as they are.
3. **Display scale is native-aware:** `scale = max(1, floor(displayTile / nativeTile))`.
   At the default `displayTile = 64`: N64 → scale **1** (1:1), N32 → scale **2**.
   The same integer scale applies to a piece's whole canvas in one blit.
4. **Mixed-resolution scenes are legal.** N32 and N64 assets render side-by-side in
   one scene at their own scale; the cached frame canvas is `displayTile`-sized
   either way, so runtime draw cost is unchanged. Only source JSON + bake targets grow.
5. **Everything else is unchanged:** frame sets (§2), the $\ge 3{:}1$ rim (§3),
   `image-rendering: pixelated`, palette caps (tier-aware, [art-direction-target.md](art-direction-target.md)),
   footprints and placement. The dropped outline for 3D bakes (LIV-115, §2) stays.

### 6.3 3D-sourced scope (native $=$ tiles $\times$ 64)

| Runtime def | Kind | Tiles | Old native (N32) | **New native (N64)** |
| :--- | :--- | :--- | :--- | :--- |
| `vocations/archer.json` (rukiya) | actor | $1\times1$ | $32\times32$ | **$64\times64$** |
| `buildings/fishing_hut.json` | building | $2\times3$ | $64\times96$ | **$128\times192$** |
| `buildings/fishing_hut_back.json` | building | $2\times3$ | $64\times96$ | **$128\times192$** |
| `buildings/fishing_hut_large.json` | building | $3\times4$ | $96\times128$ | **$192\times256$** |
| `buildings/fishing_hut_left.json` | building | $4\times3$ | $128\times96$ | **$256\times192$** |
| `buildings/fishing_hut_right.json` | building | $4\times3$ | $128\times96$ | **$256\times192$** |
| `buildings/fishers_house.json` | building | $3\times3$ | $96\times96$ | **$192\times192$** |
| `buildings/fishers_house_large.json` | building | $3\times4$ | $96\times128$ | **$192\times256$** |
| `buildings/longhouse.json` | building | $12\times4$ | $384\times128$ | **$768\times256$** |
| `props/prop_fishers_net.json` | prop | $2\times1$ | $64\times32$ | **$128\times64$** |
| `props/prop_fishers_net_vertical.json` | prop | $1\times2$ | $32\times64$ | **$64\times128$** |

Sources: `rukiya_walking_optimized.glb`, `fisherman_hut_optimized.glb`, and the
longhouse / fishers-house / net GLBs in `lokarta-private`. The bake **must hit the
tier's native size** (§6.2.1): a 64-native actor at `scale = 1` is what removes the
$2\times2$ source blocks the board flagged.

**Camera baseline ([LIV-126](/LIV/issues/LIV-126) / [LIV-127](/LIV/issues/LIV-127) /
[LIV-130](/LIV/issues/LIV-130)).**
Every 3D-rendered artifact uses a **Top-Down Oblique "3/4" orthographic** projection.
**Buildings/props** use a **60° camera pitch measured from the horizon** (`rise=60`),
optionally rotated **~45° yaw** for an isometric read; **3D actors are the exception
and stay shallower than 60°** to keep the walk-cycle side read (§12.1). Hand-pixelled
/ 2D-derived art is grandfathered. Full model, per-asset conformance table, and the
re-render plan: [3d-camera-baseline.md](3d-camera-baseline.md). This does not change
any runtime contract; it constrains the 3D bake camera only.

### 6.4 Authoring artifacts & tests (implementation = [LIV-121](/LIV/issues/LIV-121))

* The bake pipeline (`tools/gltf-to-sprite.mjs`, `tools/bake-rigged-archer.mjs`,
  integrators) gains a **px-per-tile** parameter (32 today → **64** for 3D bakes);
  raise the render target so detail survives the downscale. See
  [3d-to-2d-pipeline.md](3d-to-2d-pipeline.md) §3.
* Validators/tests that assume `native == 32` become **per-def / per-tier**
  (`html/tests/sprite-assets.test.mjs`, `tools/validate-sprite-def.mjs`, drift
  checks) — asserted, not deleted.
* Re-export drift-checked previews + before/after proofs.

---

## 7. Ground-Shadow Style (LIV-116 / LIV-120)

The shared actor shadow was a hard-coded generic ellipse drawn under every actor
(`sprite-renderer.js` `drawActor`, `ctx.ellipse(..., size/3, size/6)` at
`rgba(0,0,0,0.4)`); the board read it as a "round circle". The shadow is now a
**per-frame, silhouette-shaped, data-driven contact cue**: it answers "where does
this actor stand?", reads as ground contact, and never competes with the actor's own
readability. (Game-feel lens: contact + grounding without a black ring; readability
lens: distinct from the outline.)

### 7.1 Mechanism (what [LIV-121](/LIV/issues/LIV-121) implements)

1. Take the **same per-frame alpha mask** used to blit the actor (the baked frame's
   opaque pixels) — no separate shadow art.
2. **Squash** the mask vertically about its **bottom (ground) edge** by `squashY`,
   flattening it onto the ground plane.
3. **Offset** it by `(offset.x, offset.y)` toward the **lower-right**, agreeing with
   the Tier B baked key light (upper-left at $135^\circ$,
   [art-direction-target.md](art-direction-target.md) §5.5).
4. **Tint + composite** the mask in `color` at `alpha`, drawn **just before the
   actor, above the light mask** (same layer as the actor, §3) so it stays visible.
5. **Pixelated:** no blur/AA; hard edges on the pixel grid
   (`imageSmoothingEnabled = false`).
6. Route the **procedural fallback** (`sprite-renderer.js` `drawPlayer`) through the
   same style path with `shape:"ellipse"` so tone/squash/offset still match.

### 7.2 Data-driven style (defaults; overridable per sprite def)

```jsonc
"groundShadow": {
  "enabled": true,
  "shape": "silhouette",        // "silhouette" (default) | "ellipse" (procedural fallback only)
  "color": "#0a0d16",           // cool near-black ink (deliberately cooler than warm floor fills)
  "alpha": 0.45,                // peak opacity; authored band 0.35–0.55
  "squashY": 0.34,              // vertical compression of the mask (shadow height ≈ 1/3 of the actor)
  "offset": { "x": 0.05, "y": 0.02 } // fractions of the display tile, toward lower-right
}
```

* `offset` is in **tile fractions** ($\pm0.05$ tile $\approx$ +3 px right, +1 px down
  at the default 64 px tile) so it is zoom-independent.
* Ellipse fallback radii: `rx = 0.28 · tile`, `ry = 0.14 · tile`, same offset/alpha.
* The shadow is confined to the **lower band** of the squashed silhouette (from the
  feet up `squashY` of the opaque height) — it **never** wraps the head/top edges.

### 7.3 Contrast band & distinctness from the outline

Floors are clamped to luminance $\le 0.02$ (§3), so a darkening contact shadow can
only ever reach a small ratio against the floor. The style targets a **modest band**:

* **Target:** $1.08{:}1 \le \mathrm{CR}(\text{shadow},\text{floor}) \le 1.5{:}1$ —
  strictly **below** the actor's $\ge 3{:}1$ rim, so the shadow reads as ground, not
  as a second silhouette.
* On the **darkest** floors (e.g. `gridLine` `#100c08`, $L\approx0.004$) the
  luminance ratio is bounded near $1.02{:}1$; there the shadow's **cool hue shift**
  (ink `#0a0d16` against warm fills such as `#201a17`) carries perceptibility, and
  the **silhouette shape + offset** carry the spatial cue. At least one of
  {luminance $\Delta \ge 1.08{:}1$, chroma shift} must hold on every shipped floor.
* **Distinct from the dropped outline:** the outline (when present) is **opaque**
  ($\alpha = 1.0$) 1 px `#0b0d12` hugging the **full** silhouette; the shadow is
  **$\alpha \le 0.55$**, vertically squashed to $\approx 1/3$, offset down-right, and
  appears only **under** the actor. 3D bakes drop the outline entirely (LIV-115, §2),
  so for N64 actors the shadow is the only dark contact cue and its role is
  unambiguous.
* If a floor reads too flat in A/B, **raise `alpha` within the 0.55 cap** or shift
  the ink cooler — do **not** add a lighter rim (that would read as a glow/outline).

### 7.4 Acceptance (checked by [LIV-121](/LIV/issues/LIV-121) + preview)

* Per-frame shadow follows the actor silhouette (not a fixed ellipse); no black ring.
* Sits below the $\ge 3{:}1$ rim; visible in a shadow/no-shadow A/B at $1\times$ on
  the $\le 0.02$ floor themes.
* Same style for Tier A and Tier B; falls back to `shape:"ellipse"` only when no
  frame mask exists.

---

## 8. Pixel-Zoom Presets — the `1x` decision (LIV-116 / LIV-120)

`ui.json` (`settings.ranges.pixelScale`) offers display-tile sizes
`{ auto: 64, "1x": 32, "2x": 64, "3x": 96 }`. A **pixel-zoom preset is legal only
if its display tile is an integer multiple of every shipped native tile.** With
native tiles of 32 (N32) and 64 (N64), the legal base is **64 px** (multiples:
64, 128, 192, …); integer scaling is what preserves `image-rendering: pixelated`
and the 1:1 fidelity added in §6.

* **`1x` (32 px) is incompatible with N64 sprites → retired.** 32 is a multiple of
  32 but a **$0.5\times$ downscale** of a 64-native sprite: an integer
  nearest-neighbour downscale would discard every other pixel and row, producing
  aliasing and destroying exactly the 1:1 detail the migration adds (§6).
* **Alternative considered — clamp.** Render N64 sprites at a minimum of 64 px and
  downscale only N32 sprites at low zoom. **Rejected:** it mixes sprite densities in
  one scene at low zoom (visually inconsistent) and adds a per-native branch for a
  niche debug zoom.
* **Migration:** a persisted `pixelScale: "1x"` preference falls back to `auto` (64).
* **`auto` (64) is the default and now equals 1:1** for N64 assets; integer-multiple
  zooms (64, 128) remain. `2x` (64) is a redundant alias of `auto`.
* **Flagged, not decided here:** `3x` (96 px) is the same class of hazard
  ($96 = 1.5\times64$, non-integer for N64). Recommend [LIV-121](/LIV/issues/LIV-121)
  re-express it as **128** (2× of 64) under the legality rule above.

---

## 9. Lenses cited (LIV-120 amendment)

* **Readability & legibility** — the shadow is a *contact* cue kept strictly below
  the actor rim and distinct from the outline (§7.3); 1:1 bakes sharpen the
  silhouette the rim defends (§6).
* **Game feel / juice** — silhouette-shaped, key-light-offset shadows ground actors
  and remove the "floating sticker" read of the old ellipse (§7.1).
* **Theme coherence** — the shadow offset follows the one global $135^\circ$ baked
  key light ([art-direction-target.md](art-direction-target.md) §5.5) so cast and
  shadow agree.
* **Balance levers** — the smallest levers that fix the read are **native density**
  (32→64 for 3D sources, §6) and **shadow form** (§7), not an engine occupancy or
  grid change (§6.2.5).
* **Scope discipline** — two native tiers are opt-in by source: non-3D art and every
  existing test/footprint contract are untouched; only 3D-sourced defs migrate (§6.2.2).

No dark patterns or manipulative engagement mechanics are introduced.

---

## 10. 3D-Baked Palette Capacity ×3 (LIV-122)

> **SUPERSEDED for 3D-baked defs by §11 (LIV-124).**
> §10's $75$-opaque / $\le96$-slot rule and its $5\times15$ ramp-family structure no
> longer govern the 11 3D-baked defs; the current rule is the full 8-bit palette
> ($\le256$ slots / $255$ opaque) in §11. Tier A and 2D-derived Tier B never used
> §10 and are unchanged.

Board direction (2026-10-10, via the final visual gate): a 3D-baked sprite still
carries **too few colors**. Triple the number of unique palette numbers available
to 3D-rendered assets and regenerate in Phase 1. This section amends the palette
ceiling **for 3D-baked defs only**; Tier A (indexed) and 2D-derived Tier B are
untouched. Owner: Game Designer. Implementation: Phase 1 (Tech Lead) per the
[LIV-116](/LIV/issues/LIV-116) plan.

### 10.1 The rule

* **3D-baked palette capacity: $25 \to 75$ opaque colors ($3\times$)**, i.e.
  **$\le 76$ palette slots** (75 opaque $+$ the `.` transparent slot).
* **Tier B palette cap for 3D-baked defs: $\le 32 \to \le 96$ entries.** $96$ is
  headroom; the authored target is $76$ slots.
* **Scope is opt-in by source.** "3D-baked" means `renderTier:"baked"` **and** a
  GLB/3D bake source — the 11 defs in §6.3 (`archer`, the 8 Havenreach buildings,
  the 2 fisher's nets). **2D-derived baked defs stay $\le 32$; Tier A stays
  $\le 16$.** The consumed current state was $26$ slots (25 opaque $+$
  transparent) on all 11 defs.

### 10.2 Ramp structure — reach $\approx75$, kill banding

The prior review flagged **hard banding**: adjacent ramp steps jumping
**$70\text{–}115\%$ relative luminance**. The fix is **more steps per ramp**, not
more hue ramps — a fixed color budget spent on finer gradients, not extra hues.

* **Normative default: $5$ material families $\times\ 15$ luma steps $=75$ opaque
  colors.**
* **Allowed variant** when a def genuinely needs a 6th material:
  $6$ families $\times\ 12$ steps $=72$ $+$ up to **$3$ accent/emissive colors**
  $= \le 75$. Steps per family must stay **$\ge 12$** and families $\ge 5$.
* **Banding target: adjacent-step relative-luma delta $\le 20\%$ (aim
  $\le 12\%$).** $\ge 12$ steps across a material's luma range meets this; the
  old $4$-step ramps did not.
* Ramp ordering stays shadow $\to$ base $\to$ light $\to$ rim; $2\times2$ Bayer
  ordered dither **between adjacent steps** is unchanged (§5.4 of
  [art-direction-target.md](art-direction-target.md)). The one global $135^\circ$
  baked key light is unchanged.

### 10.3 Key alphabet (single-char, 76 slots)

Single-character keys are **mandatory** (the renderer indexes by char). The
3D-baked palette uses this fixed alphabet, in order:

```text
.                                  transparent (1 reserved slot)
0 1 2 3 4 5 6 7 8 9                digits (10)
a b c ... z                        lowercase (26)
A B C ... Z                        uppercase (26)
! @ # $ % ^ & * ( ) - _ +          punctuation (13)
```

$1 + 10 + 26 + 26 + 13 = \mathbf{76}$ slots (75 opaque $+$ transparent). The
reserved `0` outline slot is **not required** for 3D bakes (`outline:false`,
LIV-115, §2), so `0` is available as an opaque color. Phase 1 replaces the
pipeline's base-36 `(index).toString(36)` key assignment with this alphabet —
indices $\ge 36$ must **not** spill into 2-character keys.

### 10.4 Preview & memory implications

* **Frame byte size is unchanged.** Frames stay one char per pixel and every key
  stays a single character, so the char-grid JSON, the committed preview PNGs,
  and runtime draw cost do **not** grow with palette depth. (Phase-1 correctness
  note: a 2-char key would break both the renderer and row alignment — the
  alphabet above prevents that.)
* **Only the `palette` map grows:** 25 $\to$ 75 entries ($\approx +0.5$ KB per
  def, $\approx +6$ KB across all 11 defs). Negligible.
* **Preview legend** must lay out up to 96 swatches (wrap the row); pixel art and
  the byte-compare drift semantics are unchanged.
* **Tests become 3D-baked-aware.** `paletteCapFor` must return **96** for
  3D-baked defs and the per-def `<= 32` assertions in the Tier B tests migrate to
  that cap. The `rampPalette` family clamp (`Math.floor(30 / steps)`) becomes the
  **75-opaque budget** for 3D bakes, not the old $\le32$ budget.

### 10.5 Lenses cited (LIV-122 amendment)

* **Readability & legibility** — finer ramps add form without new floor colors;
  the $\ge 3{:}1$ rim (§3) and dropped-outline read (LIV-115) are unchanged.
* **Game feel / juice** — smoother stepped gradients remove the banded
  "$70\text{–}115\%$ jump" artifact; volume reads as volume.
* **MDA** — the *felt* upgrade is smoother shading (aesthetics) produced by
  palette depth (mechanic), not by resolution (design the experience, not the
  number).
* **Balance levers** — the smallest lever that fixes the read is **palette
  depth**; native density (§6) and the render path are unchanged.
* **Theme coherence** — one global baked key (§5.5) still ties the cast together.
* **Kano model** — palette depth is a *performance/delighter* upgrade on the
  highest-detail baked defs, gated behind a bounded, cheap data change.
* **Scope discipline** — opt-in by source: Tier A and 2D-derived Tier B keep
  their caps; only the 11 3D-baked defs migrate.

No dark patterns or manipulative engagement mechanics are introduced.

---

## 11. 3D-Baked Palette — Full 8-bit (256 / 255 opaque) (LIV-124)

Board direction (2026-10-10, rev 4): *"It looks much better. We want to see it with
256 (or 255 which ever fits better) unique color palletes per sprite/individual
artwork."* Each 3D-baked sprite now carries a **full 8-bit palette**. This section
**supersedes §10 for 3D-baked defs only**; Tier A (indexed) and 2D-derived Tier B
are untouched. Owner: Game Designer. Implementation: **Phase B** (Tech Lead) per
the [LIV-116](/LIV/issues/LIV-116) plan rev 4.

### 11.1 The rule

* **3D-baked palette capacity: $75 \to 255$ opaque colors**, i.e. **$\le 256$
  palette slots** ($255$ opaque $+$ the `.` transparent slot) — a single byte of
  colors.
* **Tier B palette cap for 3D-baked defs: $\le 96 \to \le 256$ entries.** $256$ is
  the hard cap; the authored target is the full $255$ opaque **when the render
  carries that much color information** (a small/simple def may land lower and is
  not padded).
* **Per-sprite palette.** Each def quantizes its own render to its own $\le256$
  palette (the board's "per sprite / individual artwork"), exactly as today's
  per-def palette map works.
* **Scope is opt-in by source — unchanged.** "3D-baked" means `renderTier:"baked"`
  **and** a GLB/3D bake source: the 11 defs in §6.3 (`archer`, the 8 Havenreach
  buildings, the 2 fisher's nets). **2D-derived baked stays $\le 32$; Tier A
  stays $\le 16$.**
* `.` is reserved for transparent; opaque entries are $N \le 255$. Total
  $\le 256$.

### 11.2 Quantization — direct 256-color, no ramp families

* **Retire the §10.2 ramp-family constraint for 3D bakes.** The
  "$5$ families $\times\ 15$ luma steps" default (and the $6\times12+3$ variant)
  **no longer applies** to 3D-baked defs.
* **Direct quantization.** Take all opaque pixels of the def's native render
  (native $= \text{tiles}\times64$ px, §6) and quantize them to **up to $255$
  opaque colors** with a single global palette (median-cut, octree, k-means, or an
  equivalent), then map each pixel to its palette entry. There is **no requirement
  that ramp steps be equal, that families exist, or that colors be ramp-ordered**;
  the palette is a perceptual approximation of the render's color volume, and
  **families are optional/introduced only by the quantizer, never mandated.**
* **Mixed / anti-aliased samples.** The high-resolution orthographic render is
  downscaled to the native canvas, so edge pixels blend toward the background and
  neighbors. Mapping rules:
  1. **Alpha is binary.** A pixel is transparent (`.`) iff its coverage/alpha is
     below the def's threshold (default $\alpha < 0.5$); otherwise it is opaque.
     There is **no partial-alpha code**: the char grid has no semi-transparent
     pixel, and downscaled edge samples resolve to either `.` or an opaque color.
  2. **Every opaque sample is an ordinary quantization input**, including
     anti-aliased edge pixels. It maps to the **nearest** palette entry under the
     quantizer's distance metric (default: luma-weighted RGB, i.e. a perceptual
     distance). Edge pixels are **not** required to form a ramp or a distinct
     family; they simply consume palette colors where needed.
  3. **Palette order is canonical, not semantic.** Unlike §10's shadow→base→rim
     ordering, a 3D-baked palette is a quantization result. For determinism it is
     emitted in a **fixed canonical order** (default: ascending Rec.601 luma, ties
     broken by the code unit's numeric value) so re-bakes and drift/preview
     comparisons are reproducible.
* **Dither stays allowed, not required** (unchanged from §2 and
  [art-direction-target.md](art-direction-target.md) §5.4): a $2\times2$ Bayer
  ordered dither **between two adjacent quantized colors** is a legal
  quantizer/authoring option to soften banding. No arbitrary per-pixel color
  noise; no off-grid color.
* **Banding.** The old "adjacent-step relative-luma delta $\le 20\%$" numeric
  target is **not** the governing rule for 3D bakes. On a $255$-color palette,
  banding is a *quantization-quality* question, not a *step-count* one: the target
  is a faithful $255$-color approximation of the render, judged per-`renderTier`
  on the committed preview.

### 11.3 Encoding requirement (contract level — concrete encoding is Phase B's)

The per-pixel frame key is a **single-character** code: the renderer indexes frames
by char and every row must decode to exactly `native.w` characters. The old
76-symbol alphabet (§10.3) **cannot express 256 colors**, so the amendment carries
this contract requirement (Phase B owns the concrete implementation):

1. **One code per opaque color.** The def's $N$ opaque palette entries
   ($N \le 255$) each get exactly one code.
2. **Exactly one code reserved for transparent** (`.` by convention). Total codes
   $\le 256$ ($N$ opaque $+$ transparent).
3. **One code unit per pixel.** Every code must be **one Unicode code unit** in the
   decoded JS string, so each frame row is exactly `native.w` code units and a
   pixel is addressable as `row[x]`. **No multi-character keys** — a 2-char key
   would break both char indexing and row alignment.
4. **Fixed, deterministic alphabet shared across all 3D-baked defs**, so a def's
   `palette` map (code → `#rrggbb`) is unambiguous and stable across re-bakes.
5. **Phase B owns the concrete encoding** — which code units and how
   `palette`/`frames` serialize. Phase B MUST verify: (a) decoded row width
   $=$ `native.w`; (b) no palette key is more than one code unit; (c) JSON size
   and runtime draw cost are acceptable; (d) the preview/drift byte-compares still
    pass. **Recommended: $255$ opaque $+$ $1$ transparent**, because that fits one
    byte cleanly, whereas $256$ opaque cannot (the transparent slot needs a code).

#### 11.3.1 Concrete encoding (Phase B, LIV-125)

The implementation is the fixed 256-code alphabet exported as `BAKED_ALPHABET`
(+ `BAKED_TRANSPARENT_KEY = '.'`) from `tools/gltf-to-sprite.mjs`:

* **Code 0–80: 1-byte JSON-safe ASCII** (glyph range `!`–`~`, excluding `.`,
  `"`, `\`, and the ASCII digits — digits are integer-like JS object keys and
  would be reordered ahead of the rest, breaking canonical palette order).
* **Code 81–254: 2-byte BMP code units** `U+0100`–`U+01AD` (Latin Extended).
* No code is a C0 control, `"`, or `\`, so **nothing is JSON-escaped** and every
  code serializes as raw UTF-8 (1 or 2 bytes). Every code is exactly **one UTF-16
  code unit**, so a frame row is `native.w` code units and the renderer's
  `palette[row[x]]` lookup needs no change.
* `palette` is emitted in **canonical ascending-Rec.601-luma order** (ties by hex)
  with `BAKED_ALPHABET[i]` assigned to the i-th entry, so the cheap 1-byte codes
  carry a render's shadow bulk and re-bakes are byte-identical.
* The concrete quantizer is **direct median-cut** (up to 255 opaque colours,
  deduped) — the ramp-family budget is not used for 3D bakes; the legacy
  `rampPalette`/`quantizeRamp` helpers remain for the 2D-derived path.
* Measured result (all 11 scoped defs): palette ≤ 256 entries, used colours
  253–255, runtime JSON $776\ \text{KB} \to 1{,}035\ \text{KB}$ ($\times1.33$)
  with the mixed 1-/2-byte alphabet, versus the naive $\times2$ for all-2-byte
  codes. Runtime per-pixel draw cost is unchanged; only the palette-map length
  grows.


### 11.4 Preview & memory implications

* **Palette map grows:** $76 \to$ up to $256$ entries per def ($\approx +2$ KB/def
  at $\sim\!12$ B/entry, $\approx +22$ KB across all 11 defs). Negligible and
  independent of frame size.
* **Frame pixel count is unchanged** ($\text{native w} \times \text{native h}$),
  but **frame JSON byte size depends on the chosen encoding** — this corrects
  §10.4's "frame byte size is unchanged" for 3D bakes. A 256-code alphabet cannot
  be all-ASCII-printable, so:
  * ASCII-range codes cost $1$ byte/pixel;
  * raw multibyte Unicode costs $2$–$3$ bytes/pixel;
  * JSON-escaped `\uXXXX` codes cost $6$ bytes/pixel.
  Phase B must choose a compact scheme (prefer minimal escaping) and **measure the
  real byte deltas** per def before committing previews.
* **Runtime draw cost** is per-pixel over the same pixel count; only the
  palette-map length grows. No new blit path, no cached-canvas growth.
* **Preview legend** must lay out up to $256$ swatches (wrap the row); pixel art
  and the byte-compare drift semantics are unchanged.
* **Tests become 3D-baked-aware at the new cap.** `paletteCapFor` returns
  $\le 256$ for 3D-baked defs (was $96$), and the per-def assertions migrate to
  that cap. The `rampPalette` family-step budget is **retired for 3D bakes** in
  favor of the direct quantizer (§11.2).

### 11.5 Unchanged

* **1:1 (N64) native render** — 3D-baked sprites stay native $64$ px/tile (§6); no
  resolution change.
* **Pixelated / no-AA / ordered-dither** contract (§1, target doc §5.4) — the
  palette is indexed and on-grid; no smoothing.
* **Dropped outline for 3D bakes** (LIV-115, §2) and the $\ge 3{:}1$ rim rule
  (§3) — the palette must still contain at least one entry clearing $\ge3{:}1$ vs
  the floor; a richer palette only makes this easier (the test scans best-of).
* **Silhouette ground shadow** (§7) — unchanged.
* **Non-3D tiers** — Tier A $\le16$ and 2D-derived Tier B $\le32$ unchanged.

### 11.6 Lenses cited (LIV-124 amendment)

* **Readability & legibility** — a full 8-bit approximation preserves the baked
  key light and material separation; the $\ge3{:}1$ rim and dropped-outline read
  are unchanged (§11.5).
* **Game feel / juice** — smoother, richer render-to-sprite shading removes the
  residual banding a $75$-color cap left in fine gradients.
* **MDA** — the *felt* upgrade is a richer pre-rendered look (aesthetics) produced
  by palette depth (mechanic), not by resolution (already 1:1) or the render path.
* **Balance levers** — the smallest lever is **palette depth $+$ quantizer**;
  native density (§6) and the render path are untouched.
* **Theme coherence** — one global $135^\circ$ baked key still ties the cast
  together; per-sprite palettes change color depth, not light direction.
* **Kano model** — palette depth is the performance/delighter lever on the
  highest-detail baked defs; the cost is a bounded data $+$ encoding change.
* **Scope discipline** — opt-in by source: Tier A and 2D-derived Tier B keep
  their caps; only the 11 3D-baked defs migrate; 1:1 and shadow are unchanged.

No dark patterns or manipulative engagement mechanics are introduced.

---

## 12. 3D-Render Perspective Baseline — Top-Down Oblique "3/4" (LIV-128)

Board direction (2026-10-10, via [LIV-126](/LIV/issues/LIV-126), plan rev 1;
encoded here by [LIV-130](/LIV/issues/LIV-130)): every **3D-rendered artifact** —
i.e. any sprite/building/prop **baked from a 3D source (a GLB)**, the Tier B
"3D-baked" class of §6/§11 — uses a **Top-Down Oblique "3/4" false
(parallel/orthographic) perspective** baseline. **Buildings and props** take the
full **60°-from-horizon** pitch; **character/actor sprites are the one exception and
stay shallower than 60°** (§12.1) to preserve the walk-cycle side read. Hand-pixelled
art and every non-3D-rendered asset are **grandfathered** (§12.5). Owner: Game
Designer. Pipeline implementation + per-asset conformance: Tech Lead
([LIV-127](/LIV/issues/LIV-127)); camera analysis: [3d-camera-baseline.md](3d-camera-baseline.md).

### 12.1 The baseline (normative)

| Parameter | Baseline | Tool binding |
| :--- | :--- | :--- |
| Camera pitch — buildings/props | **60° from the horizon** (30° from vertical) | `rise: 60` |
| Camera pitch — actors | **shallower than 60°** (actor exception, §12.1) | `rise: <60` (exact value pending a separate actor look) |
| Projection | **parallel / orthographic** — no perspective divide, no vanishing point | `render()` (`tools/gltf-to-sprite.mjs:141`) is already orthographic; unchanged |
| Default facing azimuths | axis-aligned cardinals **0° / 90° / 180° / 270°** | `--views 0,90,180,270` |
| Optional yaw | **+45° offset allowed** → **45° / 135° / 225° / 315°** | `--yaw 45` (new; Tech Lead) |
| Key light | screen-space **135° upper-left** (target doc §5.5, §7) | unchanged |
| Framing | projected-bbox fit (`fitProjected`) | unchanged |

**Pitch reference (explicit, locked).** "60° camera pitch" is encoded as **60° down
from the horizon** — 0° = eye-level side view, 90° = straight top-down. This is
exactly the tool's existing `rise` convention: `rise` is measured **from the
horizon** (from the horizontal plane; the old default `rise=10` was near side-on, so
`rise: 60` is the baseline). The board **accepted the from-horizon reading in
[LIV-126](/LIV/issues/LIV-126) plan rev 1** ([LIV-130](/LIV/issues/LIV-130)); it is
**not** 60° from the vertical. Every doc that names the camera `rise` convention
states **"from the horizon"**. Technical reference:
[3d-camera-baseline.md](3d-camera-baseline.md) §2, §5 (R1).

**Actor exception (normative).** Character/actor sprites — the 3D-rendered actor
class (`renderTier:"baked"` **and** `baked3d`/a GLB `source`, e.g. the rigged
`vocations/*` actors, §6/§12.5) — are the **one exception**: they stay **shallower
than 60°** for now, to preserve the **walk-cycle side read**. At a full 60° top-down
the runtime's three-direction facing model (`down`/`up`/`side`, §2) loses the
side-profile silhouette and stride readability the walk cycle depends on. Rationale
(**readability & legibility** + **game feel / juice** lenses): the actor is the
highest-screen-time asset, and the player must parse facing and gait from a shallow
side read within a beat, so a shallower actor camera wins over camera uniformity. A
**separate actor look is pending** (a follow-up shall fix the exact actor `rise` and
re-lock the walk cycle); until then 3D actors are **non-conforming to the 60° baseline
by design**, not by omission, and any conformance check must evaluate them against the
eventual actor-look constant, **not** `rise === 60`. Buildings and props take the full
60° (§12.1 table). Non-3D-rendered actors are grandfathered under §12.5 and
unaffected.

### 12.2 The 3/4 read (MDA)

At a 60° pitch (the buildings/props baseline; actors shallower, §12.1): a vertical
(world-Y) edge projects at `cos 60° = 0.5`, a
horizontal ground edge at `sin 60° ≈ 0.866`. The result is **predominantly
top-down with an oblique face** — roofs/tops dominate while side faces stay visible
enough to read form. This is the "false perspective" 3/4 look: parallel lines do
not converge (orthographic), but the oblique foreshortening still gives volume.

### 12.3 Optional 45° yaw

An asset **may** be authored with a **+45° yaw offset** applied to all its view
azimuths so it reads on a diagonal (isometric feel) and no two edges align exactly
to screen N/S/E/W. Use it when:

* a **scene prop / landmark / building** reads flat or ambiguous dead-on, or
* a row of adjacent objects would otherwise all align exactly on the grid axes
  (the board's "avoid all items aligning exactly N/S/E/W").

Constraints (theme-coherence + readability lenses):

* **Keep yaw consistent within a prop family / scene** so a street of buildings
  reads as one set; do not mix 0° and 45° siblings of the same asset.
* **Actors keep the axis-aligned cardinal set and stay shallower than 60°.** The
  runtime has a 3-direction facing model (`down`/`up`/`side`, `left` = mirrored
  `side`, §2); a 45°-yawed actor would not align with grid movement or its mirror,
  and the 60° pitch is superseded by the actor exception (§12.1). Yaw is for
  **static scene objects**, not actors.
* The **135° key light is screen-space** (target doc §5.5) and therefore **does
  not rotate with yaw** — a yawed object keeps the same lit edge, which is what
  keeps the cast coherent (§12.4).

### 12.4 Interaction with existing rules (all unaffected by the camera change)

The camera baseline changes **projected geometry only** — the pixels the render
produces. It does **not** change any palette, outline, contrast, or lighting rule:

| Rule | Verdict | Why |
| :--- | :--- | :--- |
| **≥3:1 rim contrast vs floor** (§3) | **Unaffected** | Evaluated per palette entry vs the floor *after* the render; independent of camera. |
| **135° key light** (target §5.5, §7) | **Unaffected** | Authored in **screen space** (upper-left), not world space; yaw/pitch do not rotate it. |
| **1px outline** (§2) | **Unaffected** | Tier A keeps it; 3D bakes still **drop** it (LIV-115). Camera does not affect outline. |
| **Palette / quantization** (§11) | **Unaffected** | Post-render quantization; same cap, same encoding. |
| **Pixelated / no-AA / dither** (§1, target §5.4) | **Unaffected** | On-grid raster output; unchanged. |

**Flagged interaction — projected aspect / footprint.** Raising the pitch from the
pre-baseline ~6–26° to **60°** roughly **halves projected height** (`cos 60°`),
turning tall portrait objects **squatter**. Multi-tile `tiles`/`native` and the
**aspect-matched `footprint`** derivation ([3d-to-2d-pipeline.md](3d-to-2d-pipeline.md)
§3.1) must be **re-derived per building** after the pitch change; a formerly `2×3`
portrait hut may become `3×2`. That re-derivation is the Tech Lead's per-asset
conformance work ([LIV-127](/LIV/issues/LIV-127)); the doc rule is: **tile count
follows the projected aspect at the 60° scene-object baseline**, not the pre-baseline
aspect. Actors are single-tile and take the shallower actor exception (§12.1), so the
footprint re-derivation does not apply to them.

### 12.5 Grandfathering (explicit)

* **In scope:** assets rendered/baked from a 3D source (GLB) — the Tier B
  "3D-baked" class (`renderTier:"baked"` **and** a GLB bake source); 2D-derived
  bakes excluded. **Buildings/props** conform at `rise:60`; **3D actors** are in
  scope but carry the shallower actor exception (§12.1) and conform to the pending
  actor-look constant instead.
* **Grandfathered — no retro-fit:** all **hand-pixelled Tier A** art, all
  **2D-derived Tier B** art, legacy 2D sprites/tiles/props, and every existing
  non-3D asset. The baseline is a **moving-forward policy for new 3D renders**; it
  does **not** require re-baking any 2D/hand-pixelled asset.
* **Existing 3D bakes** produced before this rule (the pre-baseline `rise` 6–26
  set) are **non-conforming** and are re-baked **only when next touched** or per
  the Tech Lead's re-render list in [LIV-127](/LIV/issues/LIV-127); this doc does
  not itself force a mass re-bake.

### 12.6 Lenses cited (LIV-128)

* **Readability & legibility** — one 60° 3/4 obliquity makes building/prop tops and
  faces read consistently; the ≥3:1 rim, dropped outline, and 135° key are unchanged,
  so the baseline sharpens form without touching the silhouette defence. The
  **actor exception** (§12.1) keeps the walk-cycle side read that a 60° top-down would
  flatten — legibility of *motion* at the highest-screen-time asset wins over camera
  uniformity.
* **Game feel / juice** — the oblique top-down read gives objects volume and a
  grounded "3/4" presence versus the flat pre-baseline near-side view.
* **Theme coherence** — one camera + one screen-space key tie all 3D-rendered
  props together; optional yaw varies orientation, never light.
* **MDA** — one camera *mechanic* produces the *aesthetic* of a coherent top-down
  3/4 world, not a per-asset art grab-bag (§12.2).
* **Balance levers** — the smallest lever is the **pitch constant + optional yaw
  flag**; projection, palette, outline, and light are untouched (§12.4).
* **Kano model** — a consistent camera is a *must-have* baseline; the optional 45°
  yaw is a cheap *delighter* for scene variety (§12.3).
* **Scope discipline** — opt-in by source: Tier A and all non-3D assets are
  grandfathered; only new 3D bakes carry the baseline (§12.5).

No dark patterns or manipulative engagement mechanics are introduced.
