# 3D → 2D render camera baseline: 60° Top-Down Oblique (LIV-127)

Analysis + recommendation only, per [LIV-126](/LIV/issues/LIV-126) board policy.
This issue **does not re-render production assets**; the one landed code change is
the opt-in `--yaw` arg plus the new 60° default documented below, and no committed
sprite def was regenerated. Findings are restated here and posted on
[LIV-127](/LIV/issues/LIV-127).

> **Resolution ([LIV-130](/LIV/issues/LIV-130), 2026-10-10).** The board accepted
> this analysis in [LIV-126](/LIV/issues/LIV-126) plan rev 1, and the contract in
> [art-direction.md §12](art-direction.md) now encodes it. Two open questions below
> are closed: **Q1** — the 60° reference is **from the horizon** (`rise=60`);
> **Q3** — **actors are the exception and stay shallower than 60°** to preserve the
> walk-cycle side read (§12.1), so this doc's actor row in §6 (which lists the actor
> at `rise:60`) is superseded for actors only: buildings/props take `rise:60`, actors
> follow the pending actor look. This doc remains the technical reference.

---

## 1. Board policy (restated)

Moving forward, every **3D-rendered artifact** must use a **Top-Down Oblique "3/4"
false (parallel/orthographic) perspective** as the baseline, with a **60° virtual
camera pitch**. Objects may additionally be rotated **~45° yaw** for an isometric
feel (breaking perfect N/S/E/W alignment). Projection stays
**orthographic/parallel**. Hand-pixelled / non-3D-rendered assets are
**grandfathered** — no retro-fit.

---

## 2. Current camera model

The pipeline is `tools/gltf-to-sprite.mjs` — a zero-native-dependency
orthographic software rasteriser. The camera is fully described by two angles:

| Parameter | Where | Meaning | Current default |
| :--- | :--- | :--- | :--- |
| `rise` | `render()` [line 152](tools/gltf-to-sprite.mjs#L152), `buildAsset()`, `buildAnimatedAsset()`, `parseArgs()` | Camera **elevation above the horizon**, in degrees. `rise=0` is a flat side elevation; `rise=90` is a straight top-down plan. | `--rise 10` (static) / `rise:8` (animated); wrappers pin 10 / 8 |
| `azimuth` | `render()`, `buildAnimatedAsset()` | View **yaw about the vertical (Y) axis**, applied to the model. | `views=[0,90,180,270]` — axis-aligned only |

Projection is **parallel/orthographic** by construction: the transform
(gltf-to-sprite.mjs:180) maps a world point `(x, y, z)` to
`vx = cos(az)·x + sin(az)·z`, `vy = cos(rise)·y − sin(rise)·vz`, then a fixed linear
scale + centre. There is **no perspective divide** anywhere in `render` /
`renderWorld`. Good — the board's orthographic requirement is already met.

`rise` is therefore measured **from the horizon** (from the horizontal plane), which
is the same convention as a game camera's "pitch"/tilt. At the current `rise=10`
the camera sits 10° above the horizon, which reads as an almost pure side elevation
for every asset. Confirmed empirically: re-projecting the committed GLB bounding
boxes at `rise=10` gives near-horizontal elevation silhouettes (see §4).

There is currently **no 45° yaw option**: `views` are arbitrary azimuths, so 45 is
reachable by passing `--views 45`, but the bake wrappers and every committed def
use only `0/90/180/270`.

### 2.1 Exact args that produced the committed bakes

- **Buildings + props** (`tools/bake-fisher-assets.mjs:87`): `tier:'baked'`,
  `rise:10`, `pxPerTile:64`, `outline:false`, `fitProjected:true` (multi-tile),
  per-spec `views`/`tiles`/`stretchX`/`margin`. Bundled by
  `bakeFisherAssets()` → 10 specs.
- **Rigged archer** (`tools/bake-rigged-archer.mjs:160`): `tier:'baked'`, `rise:8`,
  `size:64`, `renderRes:1024`, `rim:1.1`, `ambient:0.62`, `exposure:1.28`,
  `outline:false`, assembled from `Walking` by `tools/integrate-actor-bake.mjs`.
- **Historical per-variant rises** (10/14/6/26/18) documented in
  `tierb-variants-and-motion.md` §2 were superseded by the LIV-121 N64 re-bake,
  which re-baked **all** specs at a uniform `rise:10`. The committed defs
  correspond to `rise:10` (buildings/props) and `rise:8` (archer).

> **Gap:** the emitted `method` string records render resolution + quantiser but
> **not** the camera (`rise`/`azimuth`/projection). Conformance is therefore not
> machine-checkable from a def. See recommendation R3.

---

## 3. Asset inventory & conformance

`rise=10` / `rise=8` are **non-conforming** against the 60° policy for every
3D-rendered artifact. Nothing currently conforms. The two families below are
distinguished because the board grandfathers non-3D-rendered art.

### 3.1 3D-rendered artifacts (in scope)

All are axis-aligned (0/90/180/270); none is rotated 45°. "Conforms?" is against
the 60°-pitch baseline.

| Def | Kind | Source GLB | Views (az) | `rise` | Rotated? | Conforms? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `fisherman_hut_2x3` / runtime `buildings/fishing_hut` | building | `fisherman_hut_optimized.glb` | 0,90,180,270 | 10 | no | ❌ |
| `variants/fishing_hut_back` / runtime `fishing_hut_back` | building | `fisherman_hut_optimized.glb` | 180 | 10 | no | ❌ |
| `variants/fishing_hut_large` / runtime `fishing_hut_large` | building | `fisherman_hut_optimized.glb` | 0 | 10 | no | ❌ |
| `variants/fishing_hut_left` / runtime `fishing_hut_left` | building | `fisherman_hut_optimized.glb` | 270 | 10 | no | ❌ |
| `variants/fishing_hut_right` / runtime `fishing_hut_right` | building | `fisherman_hut_optimized.glb` | 90 | 10 | no | ❌ |
| `fishers_house` / runtime `buildings/fishers_house` | building | `fishers_house_optimized.glb` | 0 | 10 | no | ❌ |
| `fishers_house_large` / runtime `buildings/fishers_house_large` | building | `fishers_house_optimized.glb` | 0 | 10 | no | ❌ |
| `longhouse` / runtime `buildings/longhouse` | building | `longhouse_optimized.glb` | 0 | 10 | no | ❌ |
| `prop_fishers_net` / runtime `props/prop_fishers_net` | prop | `fishers_net_optimized.glb` | 0,180 | 10 | no | ❌ |
| `prop_fishers_net_vertical` / runtime `props/prop_fishers_net_vertical` | prop | `fishers_net_optimized.glb` | 90,270 | 10 | no | ❌ |
| `rukiya_archer_rigged` / runtime `vocations/archer` | actor | `rukiya_walking_optimized.glb` | 0(down),180(up),90(side) | 8 | no | ❌ |

Count: **11** 3D-rendered defs (8 buildings + 2 props + 1 actor); all 10 runtime
3D-baked sprites plus the doc artifact for the archer.

### 3.2 Legacy 3D-rendered PoC artifacts (in scope but not production)

Rendered through the same rasteriser at the old `rise=10` default; kept as
historical proofs / Tier A baselines, not wired into the live renderer.

| Def | Native | Note |
| :--- | :--- | :--- |
| `rukiya_poc` | 32×32 | Tier A single-tile PoC (indexed) |
| `fisherman_hut_poc` | 32×32 | Tier A single-tile PoC (indexed) |
| `fisherman_hut_2x3_indexed` | 64×96 | Tier A multi-tile "before" |
| `fisherman_hut_4x2` | 128×64 | Tier A board-example footprint |
| `rukiya_archer_baked` | 32×32 | Phase-1 Tier B proof (older ramp path, pre-`baked3d`) |

### 3.3 Non-3D-rendered "baked" artifacts (grandfathered)

These declare `renderTier:"baked"` but are **derived from flat 2D art** by
`tools/derive-tierb-from-2d.mjs` (silhouette distance-transform pseudo-normals,
not a mesh/camera). There is **no camera pitch or azimuth** to conform. The board's
grandfather clause applies; leave untouched.

| Defs | Kind | Method |
| :--- | :--- | :--- |
| `phase2/{fighter,magician,paladin}_baked` | vocation 32×32 | derived-from-2D |
| `phase2/{abyssal_overlord,tidebound_king,forgemaster_kol,frostbound_choirmaster}_baked` | boss 48×48 | derived-from-2D (+HSL retint) |
| `variants/fishing_hut` | building | derived-from-2D (old 26-colour) |

> Note the naming trap: `renderTier:"baked"` does **not** imply 3D-rendered. The
> in-scope flag is `baked3d:true` (or a `source:` referencing `*_optimized.glb`).
> Any future conformance test should key on the `baked3d`/source, not on
> `renderTier`.

---

## 4. Geometry interaction of a steeper pitch

A steeper `rise` adds a `depth·sin(rise)` term to projected height while shrinking
the vertical contribution of the model's own height (`height·cos(rise)`). For a
**tall/compact** object the aspect is roughly stable; for a **long, low, and deep**
object the projected aspect changes a lot. Measured from the committed GLB bounding
boxes (x = width, y = height, z = depth; aspect = projected W / projected H):

| Asset | bbox (W×H×D) | aspect @ rise=10 | aspect @ rise=60 | Δ |
| :--- | :--- | :--- | :--- | :--- |
| `fisherman_hut` (az0) | 1.19×1.90×1.27 | 0.57 | 0.58 | ~stable |
| `fisherman_hut` (az90) | 1.19×1.90×1.27 | 0.61 | 0.64 | ~stable |
| `fishers_house` (az0) | 1.75×1.90×1.74 | 0.80 | 0.71 | +taller |
| `longhouse` (az0) | 1.90×0.65×1.06 | **2.30** | **1.53** | **strongly taller / less wide** |
| `fishers_net` (az0) | 1.90×0.88×0.21 | 2.10 | 3.03 | **wider/flatter** |
| `fishers_net` (az90) | 1.90×0.88×0.21 | 0.18 | 0.10 | **thinner** |
| `rukiya` (az0) | 1.54×1.90×1.10 | 0.75 | 0.81 | +taller |

**Consequences for `native`/`tiles`/`footprint`:**

- `fisherman_hut*` and `fishers_house*` are near-vertical solids; their footprints
  (2×3, 3×3, 3×4) survive a 60° pitch essentially unchanged.
- `longhouse` is the big one. Its current 12×4 (=768×256 native) footprint was
  derived at aspect 2.30. At 60° the aspect is 1.53, so the same 12-tile width
  would frame ~7.8 tiles tall. Either the tile grid is re-derived from the new
  projected aspect (art-direction §3.1 rule: tile count is derived from projected
  aspect) or the model is re-framed to fit 12×4 with lateral margin. This is a
  **content/footprint re-decision**, not a code change.
- The **nets** invert their aspect dependence: the face-on view gets wider/flatter
  (3.03) and the edge-on view thinner (0.10). Their 2×1 / 1×2 canvases will read
  with more empty margin; re-check or re-spec at re-bake time.
- `fitProjected:true` (multi-tile path) already measures the true projected bbox,
  so it **absorbs** the pitch change automatically — the framing will not clip.
  Only the chosen tile counts need review.

---

## 5. Recommended renderer changes

**R1 — Default camera pitch = 60° from the horizon (landed as the tool default).**
The renderer's `rise` is measured from the horizon, so the board's "60° virtual
camera pitch" maps directly to **`rise = 60`**. Landed as
`DEFAULT_CAMERA_RISE = 60` in `tools/gltf-to-sprite.mjs`, now the default for
`render()`, `buildAsset()`, `buildAnimatedAsset()`, and `--rise`. Orthographic
projection is unchanged.

**R2 — Optional 45° yaw (landed).** Added `--yaw <deg>` (−360…360) to the CLI and a
`yaw` param to `buildAsset()`. It offsets **every** view azimuth by a fixed angle
(`effViews = (az + yaw) mod 360`), so frame keys become `view_<effectiveAz>` and
`placement.defaultFrame` tracks the first effective view. `yaw=0` (the default)
reproduces the existing axis-aligned path byte-for-byte. Example:
`--views 0 --yaw 45` emits a single `view_45` diagonal front.

```bash
# byte-stable default path (unchanged):
node tools/gltf-to-sprite.mjs hut.glb --id hut --tiles 2x3 --kind building --tier baked
# 60° + 45° isometric diagonal, explicit:
node tools/gltf-to-sprite.mjs hut.glb --id hut --tiles 2x3 --kind building --tier baked --rise 60 --yaw 45
```

**R3 — Record the camera in the emitted def (recommended, not landed).** Add a
`camera: { projection: "orthographic", rise, yaw, views }` block to `buildAsset` /
`buildAnimatedAsset` output so a conformance check can assert `rise === 60`
mechanically. Requires a sprite-schema field and a T0 assertion.

**R4 — Byte-stability of the single-tile/actor path is preserved.** No committed
sprite def was regenerated. The change only affects *future* authoring runs that
omit `--rise`. Existing drift/preview tests (`sprite-assets.test.mjs`, the
`*_before_after`/preview byte-compares) still pass. The bake wrappers still pin
their old rises (§2.1) so re-running them today reproduces the current committed
bytes; they move to 60 in the re-render pass (§6).

> **Interpretation ambiguity (see §8 Q1).** If the board means 60° measured **from
> the vertical** rather than from the horizon, the correct value is **`rise = 30`**.
> I recommend the from-horizon reading (rise=60): it is the standard game-camera
> tilt convention, matches the tool's existing parameter, and is a genuine
> "3/4 top-down oblique" (30° off the vertical). A one-line change flips it to 30
> if the board confirms the other reading.

---

## 6. Re-render list & effort

Re-render is a deterministic, GLB-backed authoring run (no meshy spend, no new
meshes). **Not performed in this issue** — needs board go-ahead because it changes
committed production bytes and footprints.

| Class | Assets | Work | Est. effort |
| :--- | :--- | :--- | :--- |
| Buildings | 8 (`fishing_hut*` ×5, `fishers_house*` ×2, `longhouse`) | Re-run `bake-fisher-assets.mjs` at `rise:60` (add `yaw` per item if the 45° read is wanted); re-confirm `tiles`; regenerate grid/chop proofs + previews | ~1–2 h automated; ~0.5 d footprint/test re-tune |
| Props | 2 nets | Same, plus re-decide 2×1 / 1×2 under the new aspect | ~0.25 d |
| Actor | `rukiya_archer_rigged` → `vocations/archer` | **Actor exception (§12.1): stay shallower than 60°** — re-bake `bake-rigged-archer.mjs` only when the pending actor look fixes its `rise`, then `integrate-actor-bake.mjs`; re-lock motion/orientation (LIV-111) | ~0.5 d (after the actor look) |
| Tests/proofs | `liv109/111/113/114/115/121/123/125`, `sprite-assets` | Update any pinned aspect/tile/byte expectations; regenerate proof PNGs | ~0.5 d |
| **Total** | 11 defs | | **~1.5–2.5 eng-days** |

Re-bake **must** be a separate, approved change (this issue forbids it).
The wrappers should be updated in that pass to pin `rise:60` explicitly (rather
than relying on the new default) so the camera is visible in the code.

---

## 7. Grandfathering

- **Hand-pixelled Tier A** (all `indexed` defs: NPCs, monsters, vocations,
  items, props, tiles, decor) — untouched; not 3D-rendered.
- **2D-derived "baked"** defs (§3.3, `phase2/*`, `variants/fishing_hut`) —
  untouched; no camera to conform.
- **Legacy 3D PoC/indexed artifacts** (§3.2) — historical proofs; leave as-is
  (the legacy single-tile `native:{32,32}` shapes are pinned by T0).

---

## 8. Open questions / ambiguities

1. **60° reference axis — RESOLVED (from the horizon).** From the horizon
   (`rise=60`, **accepted** [LIV-126](/LIV/issues/LIV-126) / [LIV-130](/LIV/issues/LIV-130))
   or from the vertical (`rise=30`)? The board chose **from the horizon**; art-direction.md
   §12.1 locks it.
2. **45° yaw form.** Per-asset offset on the existing 4-view defs
   (`--yaw 45`, recommended — keeps `view_0/90/180/270` naming and the runtime
   facing model) or a whole new `45/135/225/315` view set? A full rotated set
   would need new `placement.defaultFrame` values and re-tested facings.
3. **Actors at 60° — RESOLVED (shallower exception).** The board accepted the
   **actor exception**: 3D-rendered actors stay **shallower than 60°** to keep the
   walk-cycle side read; a separate actor look is pending (art-direction.md §12.1).
   Buildings/props still take 60°.
4. **Longhouse footprint.** Re-derive `tiles` from the new aspect (≈12×8) or keep
   12×4 with lateral margin? Needs a content decision before re-bake.
5. **Camera metadata (R3).** Add `camera` to the sprite schema so conformance is
   testable? Requires a schema + T0 change.
6. **Wrapper defaults.** Update `bake-fisher-assets.mjs` / `bake-rigged-archer.mjs`
   to pin `rise:60` in the re-render pass?

---

## 9. Recommendation summary

- Adopt **`rise=60` = 60° from the horizon** as the 3D camera baseline (landed as
  the tool default); keep orthographic.
- Add **`--yaw`** for the 45° isometric read (landed; default 0, byte-stable).
- **Grandfather** all hand-pixelled and 2D-derived art.
- Re-render the **11 3D-rendered defs** in an approved follow-up, re-deriving
  tiles/footprints from the new projected aspect (longhouse + nets need the most
  attention) — **~1.5–2.5 eng-days**.
- **Except actors:** the 3D actor(s) stay **shallower than 60°** per the accepted
  actor exception (art-direction.md §12.1); the archer actor re-bake waits on the
  pending actor look, only buildings/props go to `rise:60` in the re-render pass.
- Record the camera in emitted defs (R3) and update wrappers to pin `rise:60`
  (scene objects).
