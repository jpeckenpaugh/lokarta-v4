# Tier B "baked" — Phase 2 method & quality delta (LIV-110)

Companion to [3d-to-2d-pipeline.md](3d-to-2d-pipeline.md) and
[art-direction-target.md](art-direction-target.md). Phase 1 proved the Tier B
"SNES-plus" look on the board's two 3D-sourced assets (archer, fishing hut).
Phase 2 moves the **4 player vocations** and the **4 tower bosses** to the same
look.

**Constraint:** meshy.ai is not a connectable service in this workspace and the
only 3D source meshes that exist are `rukiya_optimized.glb` (archer) and
`fisherman_hut_optimized.glb`. The other 3 vocations and all 4 bosses have **no
3D source**, so net-new 3D baking is not executable this phase. Phase 2 therefore
ships the **derive-from-2D** path: reuse the *existing* Tier A char-grid art and
run it through the *same* Tier B stage. No engine change; Tier A stays the
default; Tier B is opt-in per asset.

---

## 1. Method

Tool: `tools/derive-tierb-from-2d.mjs` (dev-only, zero dependencies; reuses the
Phase 1 `rampPalette` / `quantizeRamp` / `outlinePass` / `encodePNG` passes from
`tools/gltf-to-sprite.mjs`).

```
flat Tier A char-grid
  -> silhouette chamfer distance transform  (a pseudo "dome" height field)
  -> 3x3 blur -> gradient -> per-pixel surface normal
  -> baked 135deg upper-left key light + cool lower-right bounce + inner rim
  -> chromaticity k-means families x 4 ordered luma ramp steps
  -> 2x2 Bayer dither between adjacent steps
  -> 1px #0b0d12 outline
  -> Tier B char-grid JSON (renderTier:"baked")
```

The silhouette (opaque alpha mask) is **never touched** — shading only rewrites
interior colours. The native test asserts frame-by-frame that the material mask is
identical before/after, so collision, footprint, anchors and animation reads are
unchanged. Only the interior ramp changes.

**Why a distance-transform pseudo-normal:** a flat 2D sprite has one colour per
material and no geometry, so there is no normal to light. Treating
distance-to-edge as a height field makes the sprite an inflated dome whose
gradient is a plausible normal; the 135deg key then lights the upper-left edge and
shadows the lower-right edge, and the grazing key-facing normals carry the rim
step. This reproduces the Phase 1 read (lit edge + shaded edge + rim) without a
mesh. It is an approximation of a real bake — see §4.

Reproduce:

```bash
node tools/derive-tierb-from-2d.mjs            # writes docs/art/3d-poc/phase2/
node --test html/tests/liv110-tierb-phase2.test.mjs
```

---

## 2. Delivered assets (per-asset method note)

All defs are under `docs/art/3d-poc/phase2/*_baked.sprite.json` with committed
`_before.png` / `_after.png` / `_before_after.png` proof panels. Palette is
`6 families x 4 steps = 24` ramp colours + `0` outline + `.` transparent = **26
entries** (Tier B ceiling ≤32), for every asset.

| Asset | Kind / size | Method | Source | Rim vs floor |
| :--- | :--- | :--- | :--- | :--- |
| `archer` | vocation 32×32 | **baked-from-3D** (Phase 1) | `rukiya_optimized.glb` | 6.5:1 |
| `magician` | vocation 32×32 | derived-from-2D | `html/assets/sprites/vocations/magician.json` | 15.5:1 |
| `paladin` | vocation 32×32 | derived-from-2D | `html/assets/sprites/vocations/paladin.json` | 16.6:1 |
| `fighter` | vocation 32×32 | derived-from-2D | `html/assets/sprites/vocations/fighter.json` | 8.6:1 |
| `abyssal_overlord` (Spire Warden) | boss 48×48 | derived-from-2D | `html/assets/sprites/monsters/abyssal_overlord.json` | 12.2:1 |
| `tidebound_king` | boss 48×48 | derived-from-2D + HSL retint | abyssal_overlord silhouette | 14.0:1 |
| `forgemaster_kol` | boss 48×48 | derived-from-2D + HSL retint | abyssal_overlord silhouette | 5.4:1 |
| `frostbound_choirmaster` | boss 48×48 | derived-from-2D + HSL retint | abyssal_overlord silhouette | 16.0:1 |

Notes:

- **archer** keeps its Phase 1 true 3D-baked artifact
  (`docs/art/3d-poc/rukiya_archer_baked.sprite.json`); it is the one vocation with
  a real mesh. Phase 2 does not re-derive it.
- **The 3 retinted bosses** have no Tier A art in the repo. They reuse the
  `abyssal_overlord` silhouette with a documented HSL shift so the tower cast
  reads distinctly at a glance (tide = teal, forge = warm red/orange, rime = pale
  icy blue). This is the cheapest path that satisfies the Tier B contract; it is
  **not** bespoke boss form — see §4 for the precise net-new-mesh ask.
- Bosses stay single-tile 48×48 entities per `art-direction-target.md` §5.10.

---

## 3. Contract satisfied

Native test `html/tests/liv110-tierb-phase2.test.mjs` validates, for all 7 new
defs (plus the Phase 1 archer artifact):

- `renderTier === "baked"`, palette ≤32 incl. single-char keys.
- `0` outline is exactly `#0b0d12` and is baked into frames.
- Vocations 32×32, bosses 48×48, single tile.
- Usable colours form whole **4-step** families, each **strictly increasing** in
  luma, with the brightest (rim) step clearing **≥3:1** vs the `#1a1c23` floor.
- The opaque material mask is identical before/after (silhouette unchanged).
- A fresh re-derivation byte-matches the committed files (no drift).
- Runtime Tier A defs stay `indexed` at cap 16 (defaults untouched).

---

## 4. Quality delta: derived-from-2D vs true 3D-baked

| Property | Phase 1 baked-from-3D | Phase 2 derived-from-2D |
| :--- | :--- | :--- |
| Silhouette | real mesh silhouette | **same flat art silhouette** |
| Surface normals | true per-triangle normals | approximated from a silhouette dome |
| Interior form (folds, musculature, bevels) | real geometry | **flat fill + shade only** |
| Occlusion / contact shadow | from geometry | none (positional bounce only) |
| Baked 135° key + rim | yes | yes |
| 4-step ramps + dither | yes | yes |
| Outline | 1px `#0b0d12` | 1px `#0b0d12` |
| Palette budget | up to 32 | 26 |
| Cost | needs a GLB | **zero** (reuses existing art) |

**What is lost:** the derived read adds volume and a consistent baked light, but
the *form* still comes from the flat art, so there is no new interior detail a
true bake would extract from geometry. The three retinted bosses share one
silhouette, so they read as recolours until real meshes exist. This is the honest
ceiling of the zero-cost path.

---

## 5. Net-new-mesh requirement (the precise meshy.ai ask)

To reach the **true 3D-baked** look for the 6 assets without a source mesh, the
board would need to authorize net-new meshes with these specs (mirroring what
`rukiya` already satisfies):

1. **Format:** single-mesh glTF 2.0 / GLB, Y-up, PBR base-colour texture
   (JPEG/PNG), no copyright metadata, ≤3 MB optimized.
2. **Rig/pose:** unrigged static is fine for the derive path; for a proper bake a
   neutral A/T-pose avoids the posed-`rukiya` caveat. Phase 3 (animation) would
   want an auto-rig + walk/attack presets.
3. **Poly budget:** the bake needs enough geometry for normals to carry form;
   `rukiya` is ~80k tris. 10k–80k tris per asset is ample at 32/48 px.
4. **Per-vocation meshes:** `magician`, `paladin`, `fighter` — one mesh each with
   distinct silhouette (hat/staff, shield/helm, sword/bulk) so they do not read as
   recolours.
5. **Per-boss meshes:** `tidebound_king`, `forgemaster_kol`,
   `frostbound_choirmaster` — bespoke large-form meshes (≥48 px render target),
   each with a silhouette legible at boss scale; no silhouette sharing.
6. **Provenance:** concept sheets locked before bulk generation (style-coherence
   risk flagged in the LIV-103 plan, rev 3 §5), then the same
   `tools/gltf-to-sprite.mjs --tier baked` pipeline with the shared 135° rig.

Once a mesh lands, the existing pipeline bakes it with no code change; the
derive-from-2D artifacts here remain valid fallbacks and before/after baselines.

---

## 6. Tier A untouched

No runtime sprite def changed. `html/assets/sprites/vocations/*.json` and
`html/assets/sprites/monsters/abyssal_overlord.json` remain Tier A (`indexed`,
≤16 colours). Phase 2 output is opt-in artifacts under `docs/art/3d-poc/phase2/`;
wiring any of them into the live renderer is a separate, deliberate step.
