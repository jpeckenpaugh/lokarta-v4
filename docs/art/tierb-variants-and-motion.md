# Tier B building variants & actor motion (LIV-110 follow-up)

Follow-up to [tierb-phase2-method.md](tierb-phase2-method.md) and
[3d-to-2d-pipeline.md](3d-to-2d-pipeline.md), addressing the board's test notes on
the integrated 3D→2D assets.

---

## 1. The town now renders huts on grass, not on house tiles

The Havenreach map no longer authors `BUILDING_WALL`/`DOORWAY` tiles. Buildings are
**decorative baked-hut silhouettes on grass**, and their solid body comes from the
catalog **footprint** (`scene-controller.applySceneData` blocks footprint tiles,
data-driven). The old house doorways and their walk-on activators were removed:
buildings now carry only `id`, `name`, `footprint`, `silhouette`. NPCs and their
bump-to-talk dialogue are unchanged.

Adding/placing a building is therefore a catalog entry: an `id`/`name`, a
`footprint` matching the sprite's tile span, and a `silhouette` key.

---

## 2. Multiple hut views & sizes from the one GLB

The board's point: one front-facing 2×3 hut is not enough variety. The same
`fisherman_hut_optimized.glb` is now baked at several **camera azimuths** and
**tile sizes** with the existing pipeline
(`tools/gltf-to-sprite.mjs --tier baked --views <az> --tiles <WxH>`):

| Silhouette key | View | Tiles (native px) | Notes |
| :--- | :--- | :--- | :--- |
| `fishing_hut` | front (az 0) | 2×3 (64×96) | the Phase 1 bake |
| `fishing_hut_back` | back (az 180) | 2×3 (64×96) | windowed rear |
| `fishing_hut_side` | side (az 90) | 3×3 (96×96) | wider profile |
| `fishing_hut_side_alt` | side (az 270) | 3×3 (96×96) | the mirrored other side |
| `fishing_hut_large` | front (az 0) | 3×4 (96×128) | bigger variant |

Runtime defs live in `html/assets/sprites/buildings/*.json` (registered in
`BUILDING_CATALOG`); authoring artifacts in `docs/art/3d-poc/variants/`. The
shared `spriteBuilding` renderer picks the frame from the def's
`placement.defaultFrame`, and **any key backed by a `BUILDING_CATALOG` sprite
auto-dispatches** — adding a new view is a catalog entry plus a file, never a
per-building JS branch.

Havenreach now shows a mix: front, large, side, side-alt and back huts.

**To add more variety** (e.g. more sizes), re-run the pipeline:

```bash
GLB=.paperclip-repositories/<...>/fisherman_hut_optimized.glb
node tools/gltf-to-sprite.mjs "$GLB" --id hut_x --out docs/art/3d-poc/variants \
  --tiles 4x5 --kind building --tier baked --views 0 --rise 8
```

Note: the hull is roughly symmetric, so the side views read close to the front;
the back view and the large variant are the visually strongest differentiators.

---

## 3. Archer movement — no skeleton in the GLB; cheap motion shipped

**Does the 3D model support a skeleton/joints?** No. Verified on
`rukiya_optimized.glb`: **1 node, 0 skins, 0 joint attributes, 0 animations** — it
is a single static posed mesh. There is nothing to drive limb motion from.

**What was implemented (cheap, seam-preserving, no rig):** `tools/integrate-actor-bake.mjs`
now synthesises walk/attack frames from the baked pose with two transforms that
cannot tear the silhouette:

- **Walk** — a *leg shear*: rows below the hip shift progressively (feet swing)
  while the hips stay connected, plus a 1px vertical bob on the alternate frame.
- **Attack** — an *upper-body lean*: a wind-up (−1px), a release (+2px toward the
  target) and a settle, so the draw/release reads across the 3 attack frames.

These run at authoring time and bake into the committed frames; the runtime
re-applies the outline per frame, so sheared edges stay clean. Motion is locked by
tests (walk frames differ frame-to-frame; attack frames differ; geometry stays
32×32).

**Honest limits:** this fakes motion from a single pose — it does not articulate
joints and will not match a hand-animated walk. It is a stopgap.

### Options to do better (advice)

| Option | Effort | Result |
| :--- | :--- | :--- |
| **Cut-out puppet** (segment head/torso/arms/legs from the baked sprite, offset per frame) | M | Real limb swings from the same 2D art; needs per-view masks, risks seams. |
| **Re-skin the existing Tier A animation** (apply the baked palette/shading to the archer's existing walk/attack poses) | S | Correct poses immediately, but the silhouette becomes the Tier A archer, not the GLB. |
| **Rig the mesh** and re-bake per animation frame (the proper fix) | L | True animated bake; the only path to the real 16-bit-DKC read. |
| **meshy.ai Auto-Rig** on the mesh | blocked | meshy is not available in this workspace. |

### Net-new-mesh requirement for a truly animated archer

To replace the stopgap with a real walk/fire cycle, the board would need a
**rigged** rukiya mesh: same GLB spec as
[tierb-phase2-method.md §5](tierb-phase2-method.md), **plus** a humanoid skeleton
(hips/spine/head + arms/legs), and **baked animation clips** — at minimum
`idle` (2), `walk` (4–6), `attack` (3), `hit` (1), `death` (4). Render each clip's
key frames through `tools/gltf-to-sprite.mjs --tier baked` and map them onto the
existing `animations` table. Static props/buildings need no rig.
