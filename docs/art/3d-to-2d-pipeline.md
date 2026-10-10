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
spin (0°/90°/180°) plus a small pitch to produce the three facing directions.

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

## 3. meshy.ai fit (modes, license, cost)

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

## 4. Recommended pipeline (named tooling + where it plugs in)

```
concept art (Game Designer)
   └▶ Image-to-3D  (meshy Pro, multi-view, Smart Topology ~4–8k faces)  ── actors & props
        └▶ Auto-rig + animation presets (meshy, actors only) ── idle/walk/attack/hit/death
             └▶ orthographic render @ 0°/90°/180° × frame  ── tools/gltf-to-sprite.mjs (prototype)
                  └▶ box-downscale → 32×32
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

**Why the pure-JS rasteriser:** it needs **no native builds, no GPU, no Blender** — it runs
under the same `node --test` / Node 22 CI the repo already has, so committed sprite PNGs
can be **drift-tested byte-for-byte** exactly like `tools/render-sprite-preview.mjs` is
today (test #10/#27). Textured output uses the optional dev dependency **`jpeg-js`**
(`npm i --no-save jpeg-js`); without it the tool falls back to flat Lambert shading of the
geometry, so the pipeline never hard-fails.

### Proof-of-concept (committed, `docs/art/3d-poc/`)

Generated by `node tools/gltf-to-sprite.mjs <glb> --id <id>`:

- `rukiya_poc_32px_x8.png` — the 79.9k-tri archer rendered at 512px, downscaled to
  **32×32**, quantised to a **14-colour** palette + outline, x8 zoom. Readable green-hooded
  archer across 4 yaws.
- `fisherman_hut_poc_32px_x8.png` — same for the 30.2k-tri hut: a legible stilted hut sprite.
- `*_poc.sprite.json` — palette + 32×32 indexed frame matrices in the repo's sprite format.
- `*_characterization_front.png` / `*_characterization_shaded.png` — diagnostic full-res
  renders that established what each asset is.

This validates the geometry → downscale → palette → outline → JSON chain end-to-end with
the real committed assets.

---

## 5. What each asset can/can't become + effort

- **`rukiya` (archer, unrigged):** *can* be a static prop, a shop/menu token, or a
  portrait-bust crop today. *Cannot* be a full actor (walk/attack/hit/death) until it is
  rigged and given clips — it is a posed mesh, so auto-rig quality is the risk. Effort
  once the tooling is settled: **~0.5–1 day/actor** (rig + 5 clips + render + touch-up).
- **`fisherman_hut` (static prop, unrigged):** intrinsically a prop → **directly usable as
  a 32×32 prop sprite right now** (shipped in the PoC). Could also become a larger
  town-building sprite (64²/96²) with a size variant. Effort: **hours** to wire into
  `tower_levels.json` prop policy or a town scene.

**Tooling build effort** to productionise: ~**3–5 eng-days** (harden the rasteriser,
add flat-ramp posterise + rim/contrast pass, manifest wiring, T0 drift test).

---

## 6. Risk / effort / cost

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

## 7. Open questions → Game Designer / CEO (children of LIV-103, gated by LIV-105)

1. Does the house style change to **pre-rendered 3D (DKC)** at all, and for which tiers
   (actors / props / bosses / buildings)?
2. **Flat-ramp policy** for 3D-sourced art: how many ramp steps per hue, and how are they
   authored vs quantised automatically?
3. Do **buildings/bosses** get canvases larger than 48×48? (contract amendment)
4. Target **face-count/poly budget** per tier for the 3D source, and whether to keep any
   3D at runtime (currently: none — all runtime art is 2D indexed JSON).
