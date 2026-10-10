# Havenreach NPC Identity Spec

**Per-NPC sprite, portrait & personality contract for the 8 named Havenreach NPCs (I1 of the enrichment report).**

| | |
| :--- | :--- |
| **Issue** | [LIV-81](/LIV/issues/LIV-81) — I1 of the [Dawnreach enrichment report](dawnreach-enrichment-report.md) §3 |
| **Author** | Game Designer |
| **Owner** | Design/Art direction: Game Designer. Renderer + NPC asset atlas + drift check: Tech Lead |
| **Status** | Design intent + catalog content landed; sprite/portrait assets are the Tech Lead child. **§7 supersedes the hand-authored N32 atlas with the N64 3D-baked identities (LIV-133).** |
| **Related** | [LIV-85](/LIV/issues/LIV-85) (I2 schedules, consumes the `ambience` hook); [LIV-132](/LIV/issues/LIV-132) / [LIV-133](/LIV/issues/LIV-133) (3D bake — see [3d-sprite-mapping.md](../art/3d-sprite-mapping.md) §2 and [art-direction.md](../art/art-direction.md) §13) |

This spec expands report §3.1–§3.4 into an implementable contract. It is the
source of truth for *what each NPC looks like and how the engine resolves it*;
the pixel matrices themselves are authored to this spec under the Tech Lead's
NPC atlas child issue.

**Design lenses cited inline:** readability & legibility (silhouette-first),
theme coherence (tower identity carried into town), Kano model (a delighter that
also fixes a readability defect), MDA (authored data → inhabited-world feel),
balance levers (one signature prop per silhouette, not extra systems).

---

## 1. The problem this fixes

All 8 NPCs reuse a player-vocation sprite (`fighter`/`paladin`/`archer`/
`magician`) with a flat `renderTheme` tint and an OpenMoji `portraitEmoji`. Two
NPCs share a silhouette (Mara + Doran are both `fighter`; Aurel + Bessa are both
`paladin`). The player's most reliable identity cue — **silhouette** — is reused
for people who are nothing alike. On the human isle, the people *are* the
content, so this is where art budget goes.

**Fix, in one line:** give every NPC its own 32×32 sprite with **one signature
prop that changes the outline**, and a 48×48 bust that carries **three
expressions** selected by dialogue stage. Nothing here adds a mechanic; it all
rides existing data contracts.

---

## 2. Identity table (report §3.1, expanded)

Silhouette first: the **signature prop must alter the outline**, not just the
palette, so the NPC reads at a glance from motion + shape. Skin tones are drawn
from the §4.1 ramps and deliberately span the full human range; authority is
intersectionally diverse (Vane = chestnut, Halden = tan, Aurel = espresso).

| NPC (`npcSpriteId`) | Silhouette signature | Signature prop (outline-changing) | Body / age read | Skin tone | Hair |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Elder Rowan Vane `npc_elder_rowan_vane` | floor-length robe, tall & stooped | **tall staff + hanging lantern** | tall, mature/stooped | chestnut | gray, long beard |
| Captain Halden `npc_captain_halden` | squared shoulders, upright stance | **tricorn hat + sword at hip** | broad, upright, mid-30s | tan | black, short |
| Wick the Lamplighter `npc_wick` | workman's apron, forward lean | **goggles up + hand-lantern forward** | stocky | olive | sooty dark-brown |
| High Dawnkeeper Aurel `npc_high_dawnkeeper_aurel` | layered floor-length vestments | **swinging censer on a chain** | tall, mature | espresso | silver, cloth veil |
| Mara the Tinker `npc_mara` | busy mid-stance, asymmetric hips | **heavy toolbelt + oversized satchel** | petite/wiry, mid-30s | honey | auburn bun |
| Innkeep Bessa `npc_innkeep_bessa` | broad welcoming frame | **apron + towel over forearm** | stocky, 40s | fair | brown, cloth-tied |
| Old Sailor Doran `npc_old_sailor_doran` | stooped, cane planted forward | **knit cap + cane** | mature/stooped, elder | porcelain | white beard |
| Pilgrim's Apprentice Tam `npc_pilgrims_apprentice_tam` | pack taller than the head, eager lean | **oversized travel pack + short cloak** | lithe, young teen | bronze | black coils |
| Brann the Deckhand `npc_deckhand_brann` | broad, rope-over-shoulder workman | **coiled rope over one shoulder + trailing tether** | broad, mid-20s | tan | dark, cropped |
| Ilo the Young Fisher `npc_young_fisher_ilo` | light, rod-braced stance | **fishing rod raised at an angle + line** | lithe, young teen | olive | black, short |
| Kes `npc_child_kes` | small, bucket alongside | **carry-bucket at the hip + a fish held up** | small child | honey | brown, tousled |
| Odon `npc_villager_m_odon` | steady, load on the back | **long pitchfork + fish basket** | average adult | bronze | black, tied |
| Lena `npc_villager_f_lena` | work-apron, hip-carried basket | **shoulder catch-basket with fish tails** | average adult | fair | auburn, kerchief |

**LIV-101 fishing-village ambient cast.** The five rows below Tam are the
**wander-only Shore folk** added when the town was re-skinned into a fishing
village: Deckhand, Young Fisher, Child, and two Villagers. They carry no quest
hooks — pure inhabited-world flavor (`aiType: "wander"`, own `npcSpriteId`, own
three-expression portrait set) that lets the harbor read as a living settlement.
Rukiya and the Shore-trials narrative remain **out of scope** (see
[LIV-99](/LIV/issues/LIV-99) plan).

**Rules (non-negotiable).**

- ≤16-color indexed palette with the shared outline `#0b0d12`.
- Every palette must contain at least one **high-luminance color** (the
  `abyssal`/vocab precedent) so the ≥3:1 rim-contrast bar passes against every
  scene floor (`sprite-assets.test.mjs` test 8).
- Body proportions change with `bodyTypes` (§4.3) — prop-driven outline, not a
  recolor. No two NPC `idle_down` alpha masks may be identical.
- Dawnreach's own material culture only: driftwood, salt-glass, lantern/beacon,
  rope, oilskin, tidewrack. No real-world ceremonial regalia (§4.4).

### 2.1 Palette tokens

Skin ramps (base / shadow / light) — the shared `skinTones` token set (§4.1):

| Token | Base | Shadow | Light |
| :--- | :--- | :--- | :--- |
| porcelain | `#f0d0b8` | `#d8a888` | `#fbe6d6` |
| fair | `#e8b48c` | `#c98f68` | `#f5d0b0` |
| honey | `#d99a5b` | `#b3763c` | `#eab778` |
| olive | `#b9824f` | `#94623a` | `#d19c66` |
| tan | `#a56a3a` | `#7f4d28` | `#bf8551` |
| bronze | `#8a4f2b` | `#653716` | `#a5653c` |
| umber | `#6b3a22` | `#4d2715` | `#834d30` |
| chestnut | `#50301f` | `#382014` | `#6a442e` |
| espresso | `#36211a` | `#241410` | `#4a2e24` |
| deep | `#241713` | `#160d0a` | `#33201a` |

Per-NPC garment + prop accents (carry the current `renderTheme` hue forward so
the tint fallback stays visually continuous during migration):

| NPC | Garment | Accent | Highlight |
| :--- | :--- | :--- | :--- |
| Vane | indigo `#3b4a6b` | gold trim `#d4af37` | lantern glass `#e2e8f0` |
| Halden | steel `#5b6470` | tidewatch teal `#2f6f73` | plate shine `#cbd5e1` |
| Wick | soot-brown `#5a4632` | ember `#b45309` | flame `#facc15` |
| Aurel | ivory `#e2e8f0` | dawn-gold `#d4af37` | warm rim `#fbe6c8` |
| Mara | leather `#7c4a21` | copper `#b45309` | brass `#d9a441` |
| Bessa | ochre `#9a5b2a` | hearth-red `#b04a3a` | cream `#f5e6cf` |
| Doran | peacoat navy `#33415c` | faded scarf `#9a4a3a` | silver `#cbd5e1` |
| Tam | cloak green `#3f6a33` | travel-brown `#6b4e2e` | parchment `#e8dcc0` |

---

## 3. Portraits & expression (report §3.2)

Each NPC gets a **48×48 bust** (head + shoulders; scales crisply at the SNES
bar) in a committed **portrait sheet**, with **three expressions** selected by
dialogue stage. Catalog ids follow `portrait_{npcId}_{expression}` and live in
the NPC's `portraits` map in `npcs.json`.

> **LIV-136 update (2026-10-10):** the busts are no longer hand-authored. They
> are **stills of the NPC's own 3D model head**, rendered from the same rigged
> GLBs the overworld actors bake from (LIV-134). `tools/bake-npc-portraits.mjs`
> frames the head with a joint-derived orthographic crop (front azimuth), applies
> the baked light model and the NPC's catalog `renderTheme` identity tint, then
> box-downscales to 48×48 and median-cuts to ≤256 colours with **no outline**
> (Tier B, LIV-115); `tools/integrate-npc-portraits.mjs` is the GLB-free step
> that assembles `portraits.json`. The id scheme, the three expression keys, and
> the stage→`expression` resolution are unchanged.

**Expression rubric.** Writers pick the *cheapest honest read*:

| Expression | Meaning | Face direction | Use for |
| :--- | :--- | :--- | :--- |
| `neutral` | level, attentive, default | eyes level, mouth flat/closed | lore, business, offers, journal |
| `warm` | gratitude, welcome, reunion | eyes soft, slight smile | turn-ins, greetings, hospitality, epilogue |
| `urgent` | threat / warning under pressure | brow drawn, eyes wide, lean in | active-quest danger warnings, the rite |

**Expression per stage** (authored as `expression` on each `dialogues.json`
stage; a stage without one reads as `neutral`). The fallback stage of every NPC
dialogue carries a resolvable expression so the bubble *always* has a portrait.

| NPC | `neutral` | `warm` | `urgent` |
| :--- | :--- | :--- | :--- |
| Captain Halden | `offer` | `turned_in`, `complete` | `active` |
| Wick | `not_yet`, `offer` | `turned_in`, `complete` | `active` |
| Elder Rowan Vane | `arrival` | `epilogue`, `ready_to_turn_in` | `rite_active`, `ready_for_rite` |
| Aurel | — (map still complete) | `beacon_lit` | `lore` |
| Mara | `greet` | `veteran` | — (map still complete) |
| Bessa | — (map still complete) | `greet` | — (map still complete) |
| Doran | `flavor` | `flag` | — (map still complete) |
| Tam | `q2`, `journal` | `done` | `q1`, `q3` |

**Readability rule:** the expression must be legible from the bust's silhouette
alone — a raised brow, open mouth, or shifted shoulder — not only from a color
shift. "A quest-giver's urgency should show on their face, not only in the
text" (report §3.2).

Since the bust is a still of a static 3D head, the face itself cannot emote;
LIV-136 realises the three reads by **posing the head on the rig** (data-declared
in `tools/bake-npc-portraits.mjs` → `EXPRESSION_POSES`): `warm` tilts and lifts
the head, `urgent` sets it forward. The silhouette therefore still changes per
expression, honouring the readability rule, while every still stays a genuine
render of the model's own head.

---

## 4. Personality through data (report §3.3)

All of this ships as `dialogues.json` data, no per-NPC JS:

1. **Ambient quips** — `ambience.npcs[id].quips[]` (1–2 per NPC). Short flavour
   lines fired on approach; they never open a dialogue tree and never gate
   anything. Pure delight, zero dark patterns.
2. **Schedule-varied lines hook** — `ambience.npcs[id].scheduleLines.night`.
   The **hook** I1 ships; the LIV-85 schedule/bustle system selects the line by
   time phase and otherwise falls through to the normal stage. Every NPC
   authors a `night` line now so I2 has no content to block on.
3. **Cross-references** — kept and widened so the town reads as a community, not
   eight monologues. Existing: Halden→Wick, Wick→Halden, Tam→Halden/Vane/Doran.
   Added: Aurel→Vane ("Elder Vane keeps the rite; I keep the fire"),
   Mara→Wick/Bessa ("Wick's lamp oil, Bessa's ale, and my steel"),
   Bessa→Doran ("Doran holds his corner most nights"), Doran→Halden.
4. **Relationship beats** (optional side stories) are I9 ([LIV-…](/LIV/issues/LIV-81)),
   not this issue.

---

## 5. Catalog contract (design owns; landed in this issue)

### 5.1 `html/data/npcs.json`

Every NPC gains two fields; **all previous fields are retained as fallbacks**:

```jsonc
{
  "id": "captain_halden",
  "npcSpriteId": "npc_captain_halden",      // NEW: own 32x32 actor sprite id
  "spriteId": "fighter",                    // kept: shared fallback
  "renderTheme": { "hex": "#5b6470", "amount": 0.35 }, // kept: tint fallback
  "svgCode": "1F6E1", "portraitEmoji": "🛡️", // kept: emoji fallback
  "portraits": {                            // NEW: 48x48 bust per expression
    "neutral": "portrait_captain_halden_neutral",
    "warm": "portrait_captain_halden_warm",
    "urgent": "portrait_captain_halden_urgent"
  }
}
```

### 5.2 `html/data/dialogues.json`

- Optional `expression` (`neutral|warm|urgent`) on any stage.
- Top-level `ambience.npcs[id] = { quips: string[1..2], scheduleLines: { night: string } }`.

Both are validated by `html/tests/data-catalogs.test.mjs` (LIV-81 block):
`npcSpriteId` unique and `npc_`-prefixed; `portraits` has exactly the three
keys, unique non-empty ids; every stage expression is in the fixed set; every
NPC dialogue's fallback expression resolves in its owner's `portraits`; every
NPC has quips and a `night` line.

---

## 6. Tech Lead implementation contract (child issue)

The design/data above is inert until the renderer resolves it. The Tech Lead
child issue carries this exact contract and acceptance criteria.

**A. Silhouette resolve order.** `resolveSpriteId(actor)` considers
`actor.npcSpriteId` **first**, then `spriteId`, `vocation`, `type`, `id`. An
unknown/missing `npcSpriteId` **falls through** to `spriteId` so the migration is
safe before every asset exists:

```js
const candidates = [actor.npcSpriteId, actor.spriteId, actor.vocation, actor.type, actor.id];
```

**B. Runtime NPC.** `makeNpcRuntime` forwards `npcSpriteId` and `portraits`
(cloned) so the renderer and dialogue UI read them off the runtime entity — no
per-NPC lookup, no per-NPC branch.

**C. NPC asset atlas.** One sprite JSON per `npcSpriteId` under
`html/assets/sprites/npc/` (kind `npc`), full 5-state × 3-dir contract (idle ×1,
walk ×2 step-driven, attack ×3, hit ×1, death ×4), authored per §2–§3.
Register in `manifest.json` (`actors`) and `assets/sprites/index.js`
(`SPRITE_CATALOG`). Export committed previews via `tools/render-sprite-preview.mjs`.

**D. Portrait sheet.** A portrait catalog keyed by the `portraits` map values
(48×48 busts, 3 expressions each, ≤16 colors, same outline/rim rules). The
dialogue UI selects by the playing stage's `expression` (default `neutral`) and
**falls back to `portraitEmoji`** when the portrait asset is absent — so the
bubble upgrades in place during migration.

**E. Drift test.** Extend `html/tests/sprite-assets.test.mjs` with an NPC atlas
drift check: every authored NPC is in the manifest/catalog; frame geometry;
palette ≤16 + rim contrast ≥3:1; **distinct `idle_down` silhouette per NPC**
(the point of the initiative); committed preview byte-equality.

**F. No bespoke `if`.** All resolution is data + generic dispatch. A per-NPC
condition in game logic fails acceptance.

**Acceptance criteria.**

- First batch may cover the **4 quest-critical NPCs (Halden, Wick, Aurel,
  Vane)**; the remaining 4 stay on the tint fallback with no breakage
  (non-blocking art posture, report §3.4).
- Two NPCs never share an `idle_down` silhouette.
- The portrait expression visibly changes in the dialogue bubble between a
  `warm` turn-in and an `urgent` warning.
- T0 (`node --test html/tests/*.test.mjs`) green on `main`.

---

## 7. N64 3D-baked identities (LIV-133 — supersedes §2/§6 for the baked set)

The board directed ([LIV-133](/LIV/issues/LIV-133), 2026-10-10) that the Havenreach
cast is **baked from the six rigged human GLBs in `lokarta-private`**, using
**reuse + recolor**: six cast members map 1:1 to a mesh, the other seven reuse the
nearest mesh with a distinct palette. The full per-NPC mesh + recolor table lives in
[3d-sprite-mapping.md](../art/3d-sprite-mapping.md) §2; this section records what
changes here and what is retired.

### 7.1 What supersedes

| §2/§6 rule (hand-authored N32) | **N64 baked rule (LIV-133)** |
| :--- | :--- |
| Own $32\times32$ sprite, silhouette-changing signature prop | **Baked from a mesh**; 6 direct + 7 reuse (recolor). Signature props become *optional recolour overlays*, not required outline changes. |
| **No two NPC `idle_down` masks identical** | **Relaxed** — 13 cast / 6 meshes guarantees shared silhouettes. Identity = distinct palette + spatial separation + name/title/dialogue. |
| $32\times32$ native, integer 2× | **$64\times64$ native (N64), 1:1** ([art-direction.md](../art/art-direction.md) §6, §13.1) |
| ≤16-colour indexed palette + `#0b0d12` outline | **≤256 entries (≤255 opaque), `outline:false`** (art-direction §11, §2/§11.5) |
| Renderer ellipse ground shadow | **Silhouette ground shadow** (art-direction §7) |
| Idle-only render (wanderers slide) | **Directional idle ×1 + walk ×2**, wired via `npc.anim` (§7.3) |
| Camera: N/A (2D) | **Actor exception pitch** `< 60°` from horizon, cardinals, no yaw (art-direction §12.1, §13.2) |

Unchanged: the §3 portrait/expression contract (48×48 busts, `neutral|warm|urgent`,
stage `expression`), the §5 `npcs.json` catalog fields (`npcSpriteId`, `spriteId`
fallback, `renderTheme` tint fallback, `portraits`), the resolve order
`npcSpriteId > spriteId > type`, and the §4 personality/ambience hooks. Portraits
were out of scope for the LIV-134 actor bake; **LIV-136** (Phase 3) now renders
them as stills of the same 3D heads (§3), so the bust art is 3D-baked too.

### 7.2 The 13 identities (mesh → palette)

Six direct meshes: `villager_m` (Odon), `villager_f` (Lena), `young_fisher` (Ilo),
`first_fisher` (Old Doran), `deckhand` (Brann), `child_white_hair` (Kes). Seven
reuse with a distinct palette: The Weigher (`first_fisher`), Capt. Halden
(`villager_m`), Wick (`deckhand`), Tidekeeper Aurel (`villager_f`), Mara
(`villager_f`), Innkeep Bessa (`villager_m`), Young Tam (`young_fisher`). Exact
recolor hexes, `aiType`, and rationale: [3d-sprite-mapping.md](../art/3d-sprite-mapping.md) §2.

### 7.3 Quest-giver placement (board answer 2)

The three quest givers move to their top-row doorways, facing `down`, marker and
stage-gating unchanged:

| Giver | Quest | New tile | Building |
| :--- | :--- | :--- | :--- |
| Captain Halden | Q1 | **`(3,5)`** | Fish Market |
| Wick | Q2 | **`(20,5)`** | The Tidehall |
| The Weigher | Q3 | **`(12,7)`** | The Longhouse |

The `!` / `?` marker is data-driven from `quests.json` `giverNpcId`/`turnInNpcId` +
prerequisite state (`scene-controller.js:635-656`) and is untouched by the move. The
convention and soft-lock check are in
[3d-sprite-mapping.md](../art/3d-sprite-mapping.md) §3.

### 7.4 Engine wiring (handoff → [LIV-134](/LIV/issues/LIV-134))

Ambient (`aiType:"wander"`) NPCs must **animate walking** (board answer 3): give
`npc.anim = createAnimState(npc.facing)` and call `setAnimState(npc,'walk')` on a
step / `'idle'` when stationary in `updateNpcs` — today they have no `anim` and
render `idle_down` while moving. Stationary givers need idle only; the walk frames
still ship for future schedule/bustle use. No per-NPC branch.

*Lenses cited (§7): readability & legibility (silhouette + palette identity under
reuse), theme coherence (one baked actor camera/light), Kano (a delighter that
upgrades the town's human face), balance levers (recolor palette + placement, not
new meshes), scope discipline (bake only the 13; portraits other 2D art untouched).
No dark patterns.*
