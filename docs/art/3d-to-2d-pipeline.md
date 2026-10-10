# 3D → 2D sprite pipeline: GLB asset & meshy.ai feasibility (LIV-104)

Technical investigation for LIV-103 (*Report on 3d glb assets*). Companion design-target
questions are owned by the Game Designer child issue; the contract-change decision is
owned by LIV-105 (*Art-direction target: evolve the 16-bit contract?*).

**Bottom line:** the two committed GLBs are clean single-mesh, PBR-textured, **unrigged**
glTF 2.0 assets. A zero-native-dependency software rasteriser can drive both through the
existing sprite contract (32×32 → ≤16-colour indexed palette → 1px `#0b0d12` outline →
sprite JSON) and this is proven end-to-end in `docs/art/3d-poc/` (see proof below).
meshy.ai is a good *source* for meshes + auto-rigged animation clips (what the two assets
currently lack), but its output must still pass through this render-and-quantise stage to
match the contract. Net: the pipeline is cheap and viable; the real cost is **rigging +
animation for actors** and a **Game Designer style decision** about whether a
pre-rendered-3D (DKC) look replaces the hand-pixeled style.

---

## 1. Asset characterization (parsed directly from the GLB JSON chunk)

Both were produced by **glTF-Transform v4.5.1**, glTF 2.0, **no `asset.copyright`**, one
node / one mesh / one primitive / one material, **zero skins, zero animations, zero
cameras**. Geometry is TRIANGLES (`mode: 4`), indices `UNSIGNED_SHORT`, attributes are
`POSITION` + `NORMAL` + `TEXCOORD_0` only — **no tangents, no vertex colours, no second
UV set**. Material is `doubleSided: true`, `alphaMode: OPAQUE`, base-colour + normal +
metallic-roughness textures, no occlusion/emissive.

| | `rukiya_optimized.glb` ("archer") | `fisherman_hut_optimized.glb` ("fisher's hut") |
| :-- | :-- | :-- |
| File / GLB chunk | 3,308,048 B | 1,586,860 B |
| Triangles / vertices | **79,866** / 60,587 | **30,186** / 31,008 |
| bbox (size, Y-up) | 1.54 × **1.90** × 1.10 | 1.19 × **1.90** × 1.27 |
| Images | baseColor 2048² JPEG 415 KB, normal 2048² JPEG 261 KB, metallicRoughness 2048² JPEG 212 KB | baseColor 1024² JPEG 212 KB, normal 1024² JPEG 132 KB, metallicRoughness 1024² JPEG 68 KB |
| Rig / animation | **none** (static posed mesh) | **none** (static prop) |

*All three maps are baseline JPEG (SOF0, 3-component). PBR metallic/roughness factors are
defaults (`1.0`); the embedded metallicRoughness map carries the actual variation.*

**What they actually are** (verified by orthographic re-render, see
`docs/art/3d-poc/*_characterization_front.png`):
- **`rukiya`** is a **Y-up chibi archer**: a large green hood/cowl, quiver of arrows over
  one shoulder, a bow in the off hand, tunic, boots. It is a *posed* character (bow arm
  out), not a neutral T/A-pose — this matters for auto-rigging (§4).
- **`fisherman_hut`** is a **Y-up stilted timber hut** on posts, with a thatched conical
  roof, a doorway, and a ladder — i.e. a static prop/landmark, not an actor.

Both being Y-up confirms standard glTF orientation; a naive renderer only needs a yaw
spin (0°/90°/180°, optional `+45°`) plus the camera pitch (60° **from the horizon**
= `rise:60` for scene objects; **actors shallower**, art-direction.md §12) to produce
the three facing directions.

---

## 2. Contract gap analysis vs `docs/art/art-direction.md`

| Contract rule | Pipeline status | Note |
| :-- | :-- | :-- |
| 32×32 actor/prop/tile canvas (48×48 boss) | ✅ | tool renders to any square size |
| integer `SCALE=2`, `image-rendering: pixelated` | ✅ | runtime concern, untouched |
| 3-direction facing, left = mirrored `side` | ✅ | render 0°/90°/180°, mirror is runtime |
| `idle/walk/attack/hit/death` frame sets | ❌ **gap** | assets are unrigged → only 1 static frame/dir. Needs a rig + clips (§4) |
| 1px `#0b0d12` silhouette outline | ✅ | outline pass mirrors `sprite-renderer.js` `applyOutline` |
| ≤16-colour indexed palette | ✅ | median-cut to 14 + outline index = 15 entries |
| flat pixel ramps | ⚠️ **needs policy** | median-cut gives an ordered-ish palette, not authored per-hue ramps; add a ramp-remap/posterise pass |
| ≥3:1 rim contrast vs floor | ⚠️ **needs pass+test** | raw renders can contain near-floor darks; add a rim/contrast pass and a T0 assertion |
| zero-backend, offline-first | ✅ | tool is dev-only, in `tools/`, app never imports it |

**Do not relax the contract unilaterally.** The two ⚠️ items and the DKC look itself are
art-direction decisions → route to the Game Designer / LIV-105.

---

## 3. Native tile scale chain & "chopping" (LIV-106)

**The rule:** `32×32` is **ONE tile**, not "the size everything is squeezed into". An actor,
prop or `1×1` landmark is authored at 32×32. A building/landmark is authored as a
**multi-tile bitmap** at `(tiles_w × 32) × (tiles_h × 32)` native pixels (e.g. 128×64 =
4×2 tiles) and blitted **once** into its grid footprint. Downscaling a whole hut into a
single 32×32 sprite destroys detail and is **not** how buildings are authored.

### 3.1 The full scale chain (exact stages)

| # | Stage | Unit | Rule |
| :- | :-- | :-- | :-- |
| 1 | 3D source | world units (glTF, Y-up) | bbox e.g. hut `1.19 W × 1.27 D × 1.90 H` |
| 2 | Ortho pixel render | render px | **3D-render baseline** (art-direction.md §12): ortho, **scene objects pitch 60° from the horizon = `rise:60`, actors shallower (§12.1)**, cardinal azimuths `0/90/180/270` (optional `+45°` yaw), `targetH` (e.g. 512); crop dead border |
| 3 | **Native tile grid** | px @ **32 px = 1 tile** | actors/props: **32×32 = 1 tile**. buildings: `N×M` tiles ⇒ native `N*32 × M*32` |
| 4 | Display grid | screen px | `CONFIG.GRID_SIZE = 64 = 32 native × SCALE(2)` — integer nearest-neighbour upscale |
| 5 | Placed tiles | grid cells | footprint `[x0,y0,x1,y1]` (inclusive); screen rect = `(N*64) × (M*64)` px |

**When to downscale per-tile vs keep native multi-tile:**

- **Downscale the whole render into one 32×32 tile** for *single-tile* classes: actors,
  NPCs, monsters, small props/decor, `1×1` landmarks. `scale = floor(GRID_SIZE / 32) = 2`
  (integer only — never fractional, or the pixel grid tears).
- **Keep native multi-tile resolution** for *multi-tile* classes: buildings/townships,
  landmarks, large set-pieces, and (recommended) the boss. The native canvas is
  `tiles*32`; it is **never** box-squished to 32×32. The display blit is `native × SCALE`,
  so a 128×64 bitmap draws to `256×128` px inside its 4×2-tile (256×128 px) footprint.

Tile count is **derived from the projected aspect**, not guessed. A portrait object (hut
aspect ≈ 0.63) that is forced into a landscape `4×2` canvas leaves ~68% transparent lateral
margin; the aspect-matched canvas is `2×3` (fills ~94% width, 100% height). See §3.4.

### 3.2 "Chopping": decomposition vs one blitted bitmap

Two ways to place a large raster on the tile grid:

| Approach | How it aligns | Verdict |
| :-- | :-- | :-- |
| **Per-tile slicing** | split 128×64 into `4×2` separate 32×32 sprites, one per grid cell via the props path | ❌ seams, per-tile internal outlines, no cross-tile overhang/occlusion, N×M catalog entries |
| **One multi-tile bitmap** | keep 128×64 whole; blit once into the footprint rect | ✅ **recommended for buildings** — already supported; single catalog entry |

The engine **already supports the multi-tile path**, so a 3D-baked hut does **not** need a
new placement model:

- **`renderBuildingSilhouettes`** (`html/app/canvas-renderer.js:1205`) iterates the scene's
  `buildings`, resolves a draw fn via the `BUILDING_SILHOUETTE_RENDERERS` dispatch table
  keyed on `building.silhouette` (or `building.id`), and hands it the footprint rect in
  screen px (`left, top, width, height`). Footprints fully off-screen are culled.
- **Scenes emit footprints:** `html/services/scene-composer.js:208` copies
  `buildings[].footprint = [x0,y0,x1,y1]` (and `silhouette`) from `towns.json`/`islands.json`.
- **Single-tile props** use a different path: `renderProps` (`canvas-renderer.js:1176`) blits
  one sprite per grid cell via `SpriteRenderer.drawProp`.

**So the hut uses the building path: one multi-tile bitmap, one `BUILDING_SILHOUETTE_
RENDERERS` entry, one catalog building with a footprint.** "Chopping" therefore means
**aligning the raster to whole tiles** (crop → fit → pad bottom-centre), not physically
slicing it. The decomposition into tile slices (`tileSlices`) is an authoring/verification
device only, used to prove alignment in the committed `*_chop.png` proof sheets.

**Exact asset JSON shape** (intrinsic, emitted by the tool):

```jsonc
{
  "id": "fisherman_hut_2x3",
  "kind": "building",              // actor | prop | building | boss
  "native": { "w": 64, "h": 96 },  // pixels = tiles * 32
  "tiles":  { "w": 2,  "h": 3 },   // native w/h IN TILES (the new field)
  "anchor": { "x": 32, "y": 94 },  // ground-contact point (bottom-centre) inside the bitmap
  "palette": { /* <=16 indexed colours */ },
  "frames": { "view_0": [ /* native.h rows, each native.w chars */ ] },
  "placement": {
    "mode": "multi-tile-blit",     // one blitted bitmap (vs "tiled" per-cell)
    "footprint": [0, 0, 1, 2]      // DEFAULT relative footprint [x0,y0,x1,y1], inclusive
  }
}
```

The **scene** authors the absolute placement (`towns.json` `buildings[]`), linking asset →
renderer via `silhouette`:

```jsonc
{ "id": "fisherman_hut", "silhouette": "fisherman_hut_2x3",
  "footprint": [10, 6, 11, 8], "door": { "x": 10, "y": 9 } }
```

`footprint` is inclusive of both corners: a 4×2 building at `(3,5)` → `[3,5,6,6]`
(`footprintFor`). `native`/`tiles` are intrinsic; `footprint` is scene placement.

### 3.3 Single-tile vs multi-tile by class

| Class | Native canvas | Tiles | Path | Engine change |
| :-- | :-- | :-- | :-- | :-- |
| Actor (player, NPC, monster) | 32×32 | 1×1 | `drawActor` (centred, bottom-aligned in one cell) | none |
| Small prop / decor / chest | 32×32 | 1×1 | `drawProp` / `drawItem` (one blit per cell) | none |
| **Boss** | currently **48×48** | **1.5×1.5** | `drawActor` at `SCALE=2` → 96 px, **overhangs** its 64 px cell | ⚠️ **see below** |
| Building / landmark | `N*32 × M*32` | N×M | `renderBuildingSilhouettes` (one blit into footprint) | +1 dispatch entry |
| Tile (wall/floor/water) | 32×32, procedural | 1×1 | `TILE_RENDERERS` | none |

**Boss call-out:** the boss is authored at **48×48** — `1.5` tiles — and `drawActor`
(scale 2) renders it at **96×96 display px** about the tile's bottom-centre, so it overhangs
its cell and is **not** tile-aligned. [LIV-107](/LIV/issues/LIV-107) settled this as an
**intentional single-tile entity with overhang** (not a multi-tile sprite); no engine change
is required, and the tool's `--tiles` path is not applied to it. No runtime path change is
required for the hut either: the existing `buildings`/footprint + `BUILDING_SILHOUETTE_
RENDERERS` machinery is reused; a production build only needs **one new sprite-backed
silhouette renderer** that integer-blits the `kind: building` bitmap into the footprint rect.

**Reconciliation with [LIV-107](/LIV/issues/LIV-107):** the settled contract allows
multi-tile canvases `32W×32H` with `W,H ∈ {1,2,3,4}`, `≤128×128`, whole tiles, non-square
(e.g. 4×2). The tool's `--tiles WxH` produces exactly these (`tileCanvasSize` enforces
`tiles*32`), plus the `tiles`/`placement`/`footprint` JSON fields and the inclusive
`footprint:[x0,y0,x1,y1]` binding, which LIV-107 deferred to this issue.

### 3.4 Revised proof (committed, `docs/art/3d-poc/`)

Re-rendered from the real GLB with `--tiles`; the 32×32 actor path is untouched.

- `fisherman_hut_2x3.sprite.json` — **64×96 native = 2×3 tiles**, `kind: building`,
  `placement.mode: multi-tile-blit`, footprint `[0,0,1,2]`. **Aspect-matched** variant
  (fills ~94% W / 100% H).
- `fisherman_hut_2x3_64x96_x4_grid.png` — x4 blit with cyan **32 px native grid lines**;
  the roof/body/stilts straddle whole tiles and the ground contact sits on the bottom edge.
- `fisherman_hut_2x3_chop.png` — the 6 exact 32×32 tile slices (`tileSlices`), proving the
  raster decomposes cleanly on the 32 px grid (roof-L/R, wall-L/R, stilts-L/R).
- `fisherman_hut_4x2.sprite.json` + `..._128x64_x4_grid.png` — the board's **4×2 = 128×64**
  example, showing the mechanism works for any N×M; it also surfaces that a portrait hut in
  a landscape canvas keeps ~68% transparent lateral margin (hence prefer aspect-matched
  tile counts — §3.1). **Not squished to 32×32** in either variant.
- The legacy `fisherman_hut_poc*_32px_x8.png` (single-tile) is retained and its
  `native: {w:32,h:32}` shape is locked by a T0 test so the actor path can't drift.

### 3.5 Updated effort / plan

| Item | Old single-tile plan | Multi-tile path |
| :-- | :-- | :-- |
| Tooling: add `--tiles NxM`, chop/crop, grid + chop proofs | — | **~0.5 eng-day** (done in this change) |
| Per-building authoring (render + place footprint) | hours (32×32) | **~0.25 eng-day/building** (bigger canvas + aspect tuning) |
| Boss re-author to 64×64 (2×2 tiles) | — | **contract decision (LIV-107)**, then ~0.25 day |
| Sprite-backed building silhouette renderer | — | **~0.5 eng-day** (one dispatch entry + integer blit) |
| Actors unaffected | ~0.5–1 day/actor (rig+clips) | **unchanged** |

Net tooling delta for the multi-tile path: **≈1 eng-day** on top of the 3–5-day
productionisation estimate; content cost scales with canvas size, not tile count.

---

## 4. meshy.ai fit (modes, license, cost)

**Modes** (docs.meshy.ai, 2026): Text-to-3D; **Image-to-3D** (single image, or multi-view
2–8 images — multi-view needs Pro+); **Smart Topology** (`meshy-t2`, quad/tri,
`target_polycount` 100–15,000 — best fit for a game mesh); **Remesh** (decimate
100–300,000, default 30k); **AI Texturing** (upload an existing GLB/FBX/OBJ and repaint);
**Auto-Rigging** (humanoid/quadruped, GLB, <300k faces); **Animation** (600+ presets:
walk/run/attack/etc., export GLB/FBX).

**Credits** (API pricing): Image-to-3D 20 (mesh) / 30 (2K) / 35 (8K), Ultra geometry +5;
Rigging 5; Animation 3/clip; Remesh 0.

**License / cost tiers:**

| Plan | Price | Credits/mo | License | Commercial |
| :-- | :-- | :-- | :-- | :-- |
| Free | $0 | 100 | **CC BY 4.0** | ✅ **with attribution**; no API, downloads restricted |
| Pro | $20 | 1,000 | Private (you own output) | ✅ full, no attribution, API + multi-view |
| Premium | $40 | 3,000 | Private | ✅ |
| Ultra | $100 | 8,000 | Private | ✅ |
| Studio / Enterprise | $70/seat / custom | pool / custom | Private | ✅ |

**Fit to the sprite contract:** meshy's output is *irrelevant* to the contract for its PBR
maps and tri count, because we only rasterise it — what we actually consume is **low/mid
mesh + a rig + animation clips**. So the valuable Meshy outputs are (a) Smart-Topology
meshes for props, and (b) auto-rigged humanoid clips for actors. Text-to-3D is **not**
recommended (style/direction control is weak); **Image-to-3D from Game-Designer concept
art is the right mode.** Caveat: auto-rigging works best on neutral T/A-pose meshes — the
provided `rukiya` is posed holding a bow and would likely need re-posing or manual
Blender rigging.

---

## 5. Recommended pipeline (named tooling + where it plugs in)

```
concept art (Game Designer)
   └▶ Image-to-3D  (meshy Pro, multi-view, Smart Topology ~4–8k faces)  ── actors & props
        └▶ Auto-rig + animation presets (meshy, actors only) ── idle/walk/attack/hit/death
             └▶ orthographic render @ baseline (§12: scene objects pitch=rise:60,
                actors shallower rise:<60; azimuths 0/90/180/270, optional +45° yaw)
                × frame  ── tools/gltf-to-sprite.mjs (prototype)
                  └▶ crop dead transparent margin
                       ├─ single-tile (actor/prop): box-downscale → 32×32 (one tile)
                       └─ multi-tile (building/boss): chop-to-tile-canvas → (tiles_w*32)×(tiles_h*32)   [LIV-106]
                            └▶ median-cut ≤16 colours → flat-ramp posterise
                                 └▶ 1px outline → rim/contrast pass
                                      └▶ sprite JSON (html/assets/sprites/**) + preview PNG (docs/art/preview/**)
                                           └▶ register in manifest.json; T0 drift test byte-compares exports
```

| Stage | Tool | Where | Dependency |
| :-- | :-- | :-- | :-- |
| 3D source | meshy.ai (web/API) | offline authoring, not CI | Meshy subscription |
| Rig + clips | meshy Auto-Rig + Animation | offline authoring | Meshy credits |
| Inspect/optimise | `@gltf-transform/cli` (v4.5.1) | `tools/` (dev) | dev-only |
| Render | **`tools/gltf-to-sprite.mjs`** (this prototype, pure JS) — or Blender `--background` ortho Workbench/EEVEE, or `three` + `headless-gl` | `tools/` (dev) | pure JS zero-native; Blender optional |
| Image post | built-in median-cut; optional `quantize`, `sharp`/`pngquant`, `pngjs` | `tools/` (dev) | dev-only |
| Emit/consume | existing `sprite-renderer.js` dispatch + `manifest.json` | `html/` | none new |

> **Camera baseline (LIV-128 / LIV-130).** The render stage must use the
> [art-direction.md §12](art-direction.md) **Top-Down Oblique 3/4** baseline:
> **buildings/props pitch 60° from the horizon = `rise:60`**, **3D actors shallower
> than 60°** (the actor exception, §12.1) to keep the walk-cycle side read,
> **parallel/orthographic** projection, cardinal azimuths `0/90/180/270`, with an
> **optional `+45°` yaw** for static scene objects. The prototype's current defaults
> (`rise=10` static / `rise=8` animated) and the committed bakes (variants authored
> at `rise` 6–26) are **pre-baseline / non-conforming**; new 3D **scene-object**
> bakes must default to `rise:60`, actors follow the pending actor look, and the
> renderer needs a `--yaw` option (landed, LIV-127). Per-asset conformance + the
> re-render list are [LIV-127](/LIV/issues/LIV-127)'s; 2D/hand-pixelled assets are
> grandfathered and must not be re-baked. A steeper pitch compresses projected
> height (`cos 60°`), so multi-tile `tiles`/`footprint` choices must be re-derived
> from the projected aspect (§3.1). Technical camera reference:
> [3d-camera-baseline.md](3d-camera-baseline.md).

**Why the pure-JS rasteriser:** it needs **no native builds, no GPU, no Blender** — it runs
under the same `node --test` / Node 22 CI the repo already has, so committed sprite PNGs
can be **drift-tested byte-for-byte** exactly like `tools/render-sprite-preview.mjs` is
today (test #10/#27). Textured output uses the optional dev dependency **`jpeg-js`**
(`npm i --no-save jpeg-js`); without it the tool falls back to flat Lambert shading of the
geometry, so the pipeline never hard-fails.

### Proof-of-concept (committed, `docs/art/3d-poc/`)

Single-tile: `node tools/gltf-to-sprite.mjs <glb> --id <id>`.
Multi-tile: add `--tiles NxM --kind building` (§3.4).

- `rukiya_poc_32px_x8.png` — the 79.9k-tri archer rendered at 512px, downscaled to
  **32×32** (one tile), quantised to a **14-colour** palette + outline, x8 zoom.
- `fisherman_hut_poc_32px_x8.png` — same for the 30.2k-tri hut at the legacy single-tile size.
- `*_poc.sprite.json` — palette + 32×32 indexed frame matrices in the repo's sprite format.
- **Multi-tile (LIV-106):** `fisherman_hut_2x3*` (64×96 = 2×3 tiles, aspect-matched) and
  `fisherman_hut_4x2*` (128×64 = 4×2 tiles, board example) — `kind: building`, `tiles`,
  `placement`, grid-aligned `*_grid.png` and `*_chop.png` proofs. See §3.4.
- `*_characterization_front.png` / `*_characterization_shaded.png` — diagnostic full-res
  renders that established what each asset is.

This validates the geometry → (crop) → [downscale | chop] → palette → outline → JSON chain
end-to-end with the real committed assets, for both single- and multi-tile classes.

### Tier B "baked" output (LIV-109, Phase 1)

`--tier baked` swaps the flat Tier A posterise for the [art-direction-target.md](art-direction-target.md)
§5 Tier B read, with **no geometry-path change**:

```
orthographic render @ scene-object baseline pitch 60° from horizon (rise:60; actors shallower, §12) + 135-degree key (upper-left)
  + inner rim-light on grazing, key-facing normals + cool bounce in shadow
  └▶ [downscale to 32 OR chop-to-tile-canvas]
      └▶ chromaticity k-means (families) × ordered luma steps (<=24 at the 32px era)
          + 2x2 Bayer ordered dither between adjacent steps
          └▶ 1px outline -> sprite JSON with renderTier:"baked" (cap <=32) + preview PNG
```

The palette is authored as **explicit shadow→base→light→rim ramps per material**
(`rampPalette`) rather than an arbitrary median-cut, so the ">=4-step ramp" rule is a
structural property; `quantizeRamp` turns each pixel's continuous ramp position into a
dithered pair of adjacent steps. Run: `node tools/gltf-to-sprite.mjs <glb> --tier baked [--tiles 2x3]`.

> **Superseded for 3D-baked defs ([art-direction.md §11](art-direction.md),
> LIV-124).** 3D-baked sprites now target a **full 8-bit palette — 255 opaque
> colors ($\le256$ slots incl. transparent)** and a **$\le256$-entry** cap, via
> **direct 256-color quantization** of the source render (the 5×15 ramp-family
> structure of the §10 era is retired for 3D bakes). Anti-aliased/mixed samples map
> to the nearest quantized entry; alpha is binary (one `.` transparent code).
> Frames stay one **single-code-unit** key per pixel, but the encoding must supply
> up to 256 codes, so Phase B owns the concrete alphabet and must re-check frame
> JSON size (a 256-code alphabet cannot be all-ASCII, so frames may grow) and draw
> cost. 2D-derived Tier B stays $\le32$.

Committed Phase 1 before/after proof (`docs/art/3d-poc/phase1/`, composed by
`tools/render-tierb-proof.mjs`):

- `archer_before_after.png` — Tier A `rukiya_poc` (14 colours) vs Tier B
  `rukiya_archer_baked` (24 usable, 4-step ramps + rim).
- `fishing_hut_before_after.png` — Tier A `fisherman_hut_2x3_indexed` vs Tier B
  `fisherman_hut_2x3` (2×3 = 64×96 native, baked).

The Tier B hut is registered as a runtime building sprite (`html/assets/sprites/buildings/fishing_hut.json`,
`BUILDING_CATALOG`) and blitted through the existing `renderBuildingSilhouettes` +
`footprint:[x0,y0,x1,y1]` path via `drawSpriteFrameInto` — one bitmap, no new placement model.


---

## 6. What each asset can/can't become + effort

- **`rukiya` (archer, unrigged):** *can* be a static prop, a shop/menu token, or a
  portrait-bust crop today. *Cannot* be a full actor (walk/attack/hit/death) until it is
  rigged and given clips — it is a posed mesh, so auto-rig quality is the risk. Effort
  once the tooling is settled: **~0.5–1 day/actor** (rig + 5 clips + render + touch-up).
- **`fisherman_hut` (static building, unrigged):** intrinsically a building → authored as a
  **multi-tile bitmap** (aspect-matched **2×3 = 64×96**, or the board's 4×2 = 128×64) via
  the footprint path, **not** squished into one 32×32 tile (§3). A tiny `1×1` prop variant is
  still possible for distant decor. Effort: **~0.25 eng-day** to wire the footprint into a
  town scene once the sprite-backed silhouette renderer lands.

**Tooling build effort** to productionise: ~**3–5 eng-days** (harden the rasteriser,
add flat-ramp posterise + rim/contrast pass, manifest wiring, T0 drift test), **+~1 day**
for the multi-tile path (§3.5).

---

## 7. Risk / effort / cost

| Risk | Severity | Mitigation |
| :-- | :-- | :-- |
| License: Free tier is **CC BY 4.0** (attribution required) | med | use **Pro ($20/mo)** for private, no-attribution, commercial-clean output |
| Style coherence across AI-generated meshes | **high** | lock concept sheets first; fixed render/light rig; shared palette ramps; manual cleanup |
| Auto-rig fails on posed meshes (`rukiya`) | med | re-pose / generate T-pose, or manual Blender rig |
| Palette "flat ramp" read not met by median-cut | med | add per-hue ramp-remap pass (design decision, LIV-105) |
| Determinism (Blender/GPU paths drift across versions) | med | prefer the pure-JS rasteriser; pin versions; byte-compare in T0 |
| Unknown provenance of the two committed GLBs (no `copyright`) | med | confirm IP before shipping; human review of any AI output |

**Cost:** tooling is ours ($0). **Meshy Pro $20/mo ≈ 1,000 credits ≈ ~20 fully
rigged/animated actors/month** (≈ 30 cr generate + ~15 cr for 5 clips, or ~200 bare rigs).
Blender path is $0 software but adds eng time. **Effort:** 3–5 days to productionise, then
~0.5–1 day/asset.

---

## 8. Open questions → Game Designer / CEO (children of LIV-103, gated by LIV-105 / LIV-107)

1. Does the house style change to **pre-rendered 3D (DKC)** at all, and for which tiers
   (actors / props / bosses / buildings)?
2. **Flat-ramp policy** for 3D-sourced art: how many ramp steps per hue, and how are they
   authored vs quantised automatically?
3. Do **buildings/bosses** get canvases larger than 48×48? (contract amendment)
4. Target **face-count/poly budget** per tier for the 3D source, and whether to keep any
   3D at runtime (currently: none — all runtime art is 2D indexed JSON).

**Contract amendments to route to the Game Designer child (LIV-107) — flagged by LIV-106:**

- **32×32 = exactly one tile**; buildings/landmarks are multi-tile `N×M` bitmaps
  (`native = tiles × 32`), never squished to one tile. Formalise in `docs/art/art-direction.md`.
- **Tile count is derived from projected aspect** (§3.1) — decide whether the contract
  mandates aspect-matched footprints (recommended) or allows transparent-margin canvases.
- ~~**Boss** 48×48 overhang~~ — **settled by [LIV-107](/LIV/issues/LIV-107):** intentional
  single-tile entity with overhang; not a multi-tile sprite (§3.3).
- Whether multi-tile sprites require a **manifest/loader field** (`kind`, `tiles`,
  `placement`) or stay scene-only until a sprite-backed building renderer is added.
