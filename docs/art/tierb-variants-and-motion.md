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

## 2. Multiple hut views & sizes from the one GLB (LIV-111 orientation pass)

The same `fisherman_hut_optimized.glb` is baked at several **camera azimuths**
and **tile sizes** with `tools/gltf-to-sprite.mjs --tier baked --views <az>
--tiles <WxH> --rise <deg>`. The board's orientation rule is applied by azimuth
and the near-symmetric hull is made **visibly distinct through differing camera
elevation (`--rise`)**:

| Catalog key | Facing | View (az) | Tiles (native px) | `--rise` | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `fishing_hut` | forward | 0 | 2×3 (64×96) | 10 | the Phase 1 front bake (door + ladder) |
| `fishing_hut_large` | forward | 0 | 3×4 (96×128) | 14 | bigger front landmark |
| `fishing_hut_right` | right-facing | 90 | 3×3 (96×96) | 6 | low-angle side, faces the road |
| `fishing_hut_left` | left-facing | 270 | 3×3 (96×96) | 26 | steep side, faces the road |
| `fishing_hut_back` | backward | 180 | 2×3 (64×96) | 18 | windowed rear |

Each def sets `placement.defaultFrame` to its single baked `view_<az>`, so the
shared `spriteBuilding` renderer picks the right orientation **with no
per-building JS branch**. Runtime defs live in
`html/assets/sprites/buildings/*.json` (registered in `BUILDING_CATALOG`);
authoring artifacts in `docs/art/3d-poc/variants/`.

**Havenreach placement (board rule):** 3 forward huts across the top row, a
**right-facing** hut on the left side and a **left-facing** hut on the right side
(each facing the central road), and 1–2 **backward-facing** huts along the bottom
as artwork. See `html/data/towns.json` `buildings[]`. Proofs:
`docs/art/3d-poc/phase3/hut_variants.png`, `phase3/town_before.png` vs
`phase3/town_havenreach.png` (rendered through the engine path by
`tools/render-town-preview.mjs` / `tools/render-phase3-proof.mjs`).

**To add more variety** (e.g. more sizes), re-run the pipeline:

```bash
GLB=.paperclip-repositories/<...>/fisherman_hut_optimized.glb
node tools/gltf-to-sprite.mjs "$GLB" --id hut_x --out docs/art/3d-poc/variants \
  --tiles 4x5 --kind building --tier baked --views 0 --rise 8
```

**Which read best:** the **large front** (`fishing_hut_large`, 3×4) is the
strongest landmark, and the **steep left-facing** side (`--rise 26`) is the most
distinct of the two sides — a low `--rise` side and the front read closest to one
another, which is expected for a symmetric hull.

---

## 3. Archer movement — baked from the genuinely-rigged mesh (LIV-111)

`rukiya_walking_optimized.glb` **is rigged** (`SmartRigArmature`, 42 joints,
`skin 0`, one `Walking` clip, `JOINTS_0/1/2` + `WEIGHTS_0/1/2` — up to 12
influences/vertex). `tools/gltf-to-sprite.mjs` now consumes a **skinned GLB +
animation clip**: it samples the skeleton per frame, builds the joint matrices
(`world[joint] · inverseBind`), linear-blend-skins every vertex + normal, and
renders each pose through one **fixed projection** (the union bbox across all
frames) so the animation never jitters.

`tools/bake-rigged-archer.mjs` bakes the runtime frame ids directly from that
clip at chosen phases, and `tools/integrate-actor-bake.mjs` reads the committed
artifact (`docs/art/3d-poc/rukiya_archer_rigged.sprite.json`) to assemble
`html/assets/sprites/vocations/archer.json` — so the T0 suite stays GLB-free in
CI.

- **Walk** — two stride-extreme phases (t≈0.26 / 0.781) per facing (down az 0,
  up az 180, side az 90; the runtime mirrors `side` for the opposite direction).
- **Idle** — a neutral walk phase (t=0).
- **Attack** — a **posed** draw → fire → settle sequence (bow arm raised, string
  drawn, then released), built by offsetting the rig's own arm/forearm bind
  rotations; only the `Walking` clip exists, so this is posed, not a bespoke clip.
- **Hit / death** — posed recoil + a progressive collapse (lean + hips drop).

**Honest limits:** attack/hit/death are *derived from* the walk rig, so they do
not articulate as cleanly as purpose-authored clips; the real fix is a dedicated
`idle/walk/attack/hit/death` clip set. Motion is locked by
`html/tests/liv111-rig-and-orientation.test.mjs` (walk/idle/attack frames are
distinct; facings differ; 25-frame runtime contract holds). Proof:
`docs/art/3d-poc/phase3/archer_rig.png`; the live archer renders it in Havenreach
via **New Game → Archer**.

