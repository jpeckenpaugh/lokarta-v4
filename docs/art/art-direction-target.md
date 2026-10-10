# Lokarta Visual Target: NES → SNES/DKC (LIV-105)

Art-direction decision for the board's ask on [LIV-103](/LIV/issues/LIV-103): the
game "reads as 8-bit NES Zelda" and the board wants a 16-bit SNES *Donkey Kong
Country*-inspired feel, potentially via 3D assets baked to 2D sprites.

Owner: Game Designer. Technical pipeline: [LIV-104](/LIV/issues/LIV-104) (Tech Lead).
Authoritative runtime contract remains [art-direction.md](art-direction.md); this
doc **amends** it with a second, opt-in fidelity tier.

---

## 1. TL;DR decision

**Keep the flat-pixel contract as the default; evolve it — do not replace it.**
Introduce a second, opt-in **Tier B "baked"** asset class beside the existing
**Tier A "indexed"** tier. Tier B keeps the same 32×32 native grid, the same 1px
outline, the same pixelated rendering, and the same ≥3:1 rim rule, but roughly
**doubles the per-asset color budget (≤16 → ≤32)** and mandates **4-step shading
ramps + ordered dither + a baked key-light rim**.

"SNES" and "DKC" are *not* the same target. A full DKC emulation (un-outlined,
smoothly shaded, many-color sprites on parallax layers) would break our
silhouette readability on near-black dungeon floors and our data-driven test
contract. The achievable, valuable target is **"SNES-plus"**: richer ramps and
baked light inside a readable pixel silhouette. The two GLBs (rukiya, hut) are a
useful *authoring method* for Tier B, not a runtime switch.

---

## 2. Target definition

| Term | What we mean here |
| :--- | :--- |
| **NES read (current)** | ≤16 indexed colors, 1–2 step flat ramps, uniform 1px black outline, single ground-shadow ellipse, flat-fill tiles. Chunky, high-contrast, "sticker" silhouettes. |
| **SNES era (console)** | More colors on screen, more ROM, Mode 7 bg, larger sprites, more animation frames. The *console generation* bar. |
| **DKC look** | Pre-rendered SGI 3D → sprites: deep baked lighting, soft volumetric shading, textured surfaces, ~dozens of colors per sprite, minimal outline, layered atmospheric backgrounds. |
| **Our target ("SNES-plus")** | Tier B sprites: 4-step ramps + dither to *simulate* DKC's soft shading inside the pixel grid, one consistent baked key light, a bright rim-light step, outline kept for readability. Reads as "SNES with pre-rendered lighting," not "NES flat fill." |

We explicitly **reject** two DKC traits: (a) no outline — unsafe over our ≤0.02
luminance floors; (b) full smooth gradients — they need off-grid sub-pixel colors
that fight the `image-rendering: pixelated` rule and the char-grid JSON contract.

---

## 3. Why the game currently reads "NES"

Each row is a distinct lever; the fix column says where we spend budget.

| Lever | Current state | NES tell | Target |
| :--- | :--- | :--- | :--- |
| Palette depth | ≤16 entries incl. outline + transparent (~14 usable) | Flat, banded materials | **≤32** usable for Tier B |
| Shading ramp | 1–2 steps per material | No form, no volume | **≥4 steps** (shadow→base→light→rim) |
| Shading technique | Flat fill only | Hard color boundaries | **2×2 ordered dither** between ramp steps |
| Lighting | One ground ellipse; additive light mask | Uniform, "lit from nowhere" | **Baked $135^\circ$ top-left key** + cool bounce shade + rim step |
| Outline | 1px `#0b0d12` everywhere | Sticker edge, no inner form | Keep outline; **add inner rim-light** on key edge |
| Resolution | 32×32 at 2× = 64px | Coarse silhouette budget | Keep 32 (see §7); spend it on ramp, not more pixels |
| Animation frames | idle 1 / walk 2 / attack 3 | Robotic walk | Phase 3: Tier B heroes idle 2 / walk 4 |
| Backgrounds | Flat-fill tiles + hash shade + decor | Flat stage | Keep (top-down, not a parallax platformer) |
| Prop density | theme `density` 2, `maxPerRoom` 3 | Sparse rooms | Phase 4: raise hero-room decor |

**Diagnosis:** the NES read is dominated by *palette depth + flat ramps + absent
baked lighting*, not by resolution. That is good news — the cheapest fix is data
(bigger palettes, dithered ramps, a light rule) with **zero engine change**.

---

## 4. Keep-vs-change decision

**Keep Tier A unchanged. Add Tier B as opt-in data.** A sprite opts in with a
new `renderTier` field on its sprite definition JSON:

```jsonc
{
  "id": "archer",
  "renderTier": "baked",     // "indexed" (default) | "baked"
  "native": { "w": 32, "h": 32 },
  "palette": { ".", "0", "1".."t" },   // ≤32 entries incl. '.' and '0'
  "frames": { ... }
}
```

The runtime renderer (`SpriteRenderer.drawActor` → `getFrameCanvas`) already
consumes arbitrary palette maps and char-grid frames, so **no render path
changes**. `renderTier` is metadata for validation and for future authors/tools.

### Asset-class assignment

| Class | Tier | Rationale |
| :--- | :--- | :--- |
| Tiles, wall/floor decor | A | Top-down stage; flat reads fine, budget better spent elsewhere |
| Ambient props, VFX, projectiles | A | Small, transient; contrast is the cue |
| Portraits (48×48 busts) | A → B later | Already readable; upsell later |
| Common monsters (rat, skeleton, cultist…) | A initially | Highest count × lowest screen time |
| **Player vocations (4)** | **B** | On screen 100% of the run — best ROI |
| **Bosses (4)** | **B** | Emotional peak; DKC-style presence matters most here |
| **Quest-critical NPCs** | **B** | Dialogue close-ups + identity |
| **Signature props** (fishing hut/Longhouse, boat) | **B** | The board's own examples; scene anchors |

---

## 5. Tier B concrete rules (the amended contract)

1. **Canvas / grid / scaling — unchanged.** 32×32 native, integer 2× scale,
   `image-rendering: pixelated; crisp-edges`. No sub-pixel offsets.
2. **Palette ceiling — ≤32 entries.** Includes the `.` transparent slot and the
   reserved `0` outline slot, so ≤30 usable colors. Single-character keys stay
   mandatory (the renderer indexes by char); reserved chars: `.`, `0`.
3. **Shading ramps — mandatory.** Every dominant material (skin, cloth, metal,
   wood, hair) authors **≥4 ordered steps** *shadow → base → light → rim*. Step
   deltas should be perceptible (aim ≥12% relative luminance between adjacent
   steps) so the ramp reads at 2×.
4. **Dithering — allowed, not required.** 2×2 Bayer ordered dither expressed as
   a checkerboard of two *adjacent* ramp-step chars. It is an authoring pattern,
   **not a new field**, and shades only *between* declared ramp steps. No
   arbitrary per-pixel color noise.
5. **Baked light — one global direction.** Key light from screen-space upper-left
   (`$135^\circ$`); a cool, darker bounce shade on the lower-right; the rim step
   on the key edge. This is authored once and held across all Tier B assets so
   the cast reads as one scene.
6. **Outline — unchanged.** 1px `#0b0d12` silhouette via the existing
   `applyOutline` pass. Tier B **adds** an optional inner **rim-light** row
   (lightest ramp step) on the key-lit edge. No anti-aliased, soft, or
   colored outlines.
7. **Ground contact (optional).** ≤2 interior AO chars at the base of a Tier B
   actor. The shared renderer ellipse stays the ground shadow for all actors.
8. **Frame counts — unchanged in Phase 1.** idle 1 / walk 2 / attack 3 / hit 1 /
   death 4. Phase 3 may raise Tier B **heroes** to idle 2 / walk 4 (see §8).
9. **Contrast — unchanged and enforced.** At least one palette entry must clear
   **≥3:1** WCAG vs the floor (luminance ≤0.02). Tier B's rim step is the
   intended carrier and must itself clear it.

---

## 6. Reconciliation with existing rules

| Existing rule | Verdict | Why |
| :--- | :--- | :--- |
| **≥3:1 rim contrast vs floor** | **Kept, reinforced** | Tier B rim step is the carrier; tests scan every palette entry, so a richer palette still passes (best-of). |
| **`image-rendering: pixelated; crisp-edges`** | **Kept** | No AA/smoothing; dither is on-grid; integer scaling unchanged. |
| **1px `#0b0d12` outline** | **Kept** | Silhouette legibility over ≤0.02 floors; Tier B only *adds* an inner rim light. |
| **32×32 native / integer 2×** | **Kept** | Avoids an engine `GRID_SIZE` change (48-native would need 96/144). |
| **≤16 palette (Art §2, test 3/28)** | **Amended** | Becomes tier-aware: `renderTier==='baked' ? 32 : 16`. The single thing that changes in the test contract. |
| **3-direction facing** | **Kept** | No new directions. |

---

## 7. On 3D→2D baking (coordinate with LIV-104)

Baking a render is a valid **authoring method for Tier B**, not a new runtime
tier. The provided GLBs are static, unrigged, and very high-poly (rukiya ≈79.9k
tris / 3.3 MB; hut ≈30.2k tris / 1.5 MB; JPEG textures) — they cannot ship as-is
and a naive 32px render would be mush. The bake must end in the same char-grid
JSON:

```
GLB → orthographic render (fixed 135° key) → downscale to 32/48 →
quantize to ≤32 palette → apply ordered dither → outline pass → char-grid JSON
```

Value delivered by the bake is **consistent baked lighting and correct form**,
not raw detail. This keeps runtime zero-dependency and the drift tests intact.
The pipeline mechanics + meshy.ai mode/license/cost are LIV-104's deliverable;
this doc fixes the **output budget** the pipeline must hit.

---

## 8. Prioritized, cheap-first rollout

Each phase is independently shippable and testable; stop anywhere.

| # | Phase | Work | Cost | Acceptance |
| :--: | :--- | :--- | :--- | :--- |
| **0** | Contract | Land this doc; Tech Lead adds tier-aware palette cap + optional ramp assertion | XS | `sprite-assets.test.mjs` green; Tier A untouched |
| **1** | Board's own examples | Re-author **`archer`** (vocation) + the **fishing hut / Longhouse** prop as Tier B "before/after" proof | S | Preview PNG shows 4-step ramp + rim light; archer palette 16→≤32; drift test green |
| **2** | Hero class | 4 vocations + 4 bosses → Tier B | M | All boss/vocation previews show baked key light; 3:1 holds |
| **3** | Animation juice | Tier B heroes idle 2 / walk 4 (test 4/25 update) | S | Frame-count assertions tier-aware; walk reads smoother |
| **4** | Identity + stage | Quest-critical NPCs → Tier B; raise hero-room prop density | M | NPC previews enriched; `docs/art/preview/` re-exported |

### Before/after acceptance example (Phase 1 target)

| Check | Before (Tier A) | After (Tier B) | How verified |
| :--- | :--- | :--- | :--- |
| Palette entries | ≤16 | ≤32 | `sprite-assets.test.mjs` tier-aware cap |
| Ramp steps per material | 1–2 | ≥4 | new optional assertion (Tech Lead) |
| Dither present | none | 2×2 Bayer on ≥1 ramp | author/reviewer eyeball; optional assert |
| Rim clears 3:1 vs floor | yes (best-of) | yes (best-of) | test 8, unchanged |
| Outline | 1px `#0b0d12` | 1px `#0b0d12` + inner rim | preview PNG |
| Preview drift | committed | re-exported | tests 10/18/27 |

---

## 9. Lenses cited (traceability)

- **Readability & legibility** — outline + rim rule preserved; richer ramp must
  not smear the silhouette (§5.6, §6).
- **Game feel / juice** — baked key light + rim gives form and "pop" at 2×;
  Phase 3 frames add secondary motion (§8).
- **Kano model** — Tier B is a performance/delighter upgrade on the
  highest-screen-time actors, gated behind a real cheap-first budget (§8).
- **MDA** — the *felt* upgrade is volume and lighting, not pixel count; ramp
  steps are the mechanic that produces the SNES aesthetic (§2, §5.3).
- **Theme coherence** — one global baked light direction across Tier B (§5.5).
- **Balance levers** — smallest lever that fixes the read is palette depth +
  dither, not resolution or an engine change (§3, §4).
- **Scope discipline** — two-tier opt-in keeps every existing asset and test
  valid; no wholesale replacement (§4, §6).

No dark patterns or manipulative engagement mechanics are introduced.
