# 3D → Sprite Mapping Spec — Havenreach NPCs, Creatures & Props (LIV-133, Phase 0)

Design-side source of truth for the LIV-132 3D bake. **Docs only — no code, no
catalog edits.** The Tech Lead implements against this in
[LIV-134](/LIV/issues/LIV-134) (NPCs + props) and
[LIV-135](/LIV/issues/LIV-135) (creatures + overworld wiring). Every decision here
is locked; if implementation needs a deviation, it comes back to the Game Designer
as a comment on this issue rather than a silent catalog change.

| | |
| :--- | :--- |
| **Issue** | [LIV-133](/LIV/issues/LIV-133) — Phase 0 of [LIV-132](/LIV/issues/LIV-132) |
| **Author** | Game Designer |
| **Source assets** | `lokarta-private` `origin/main` @ `0412020` — 19 optimized GLBs (rigged humans + creatures + props) |
| **Runtime contract** | [art-direction.md](art-direction.md) §6 (N64 tier), §11 (≤256 palette), §12.1 (actor exception) |

**Design lenses cited inline:** enemy role taxonomy, readability & legibility,
theme coherence, core loop & fantasy, Kano model, MDA, balance levers, economy &
reward pacing. No dark patterns.

---

## 1. The actor bake contract (applies to every baked human + creature)

This is the shared contract folded into [art-direction.md](art-direction.md) §6.3
and §12.1–§13 by this issue. It is **not** restated per asset below.

| Rule | Value | Source |
| :--- | :--- | :--- |
| Native density | **N64 — 64 px per tile, 1:1** ($1\times1$ actor = $64\times64$ canvas) | art-direction §6.1–§6.2 |
| Camera pitch | **Actor exception — shallower than 60° from the horizon** (`rise < 60`), **not** the 60° building/prop baseline | art-direction §12.1 |
| Projection / azimuths | Orthographic; axis-aligned cardinals `0/90/180/270`; **no yaw** (yaw is for static scene objects only) | art-direction §12.1, §12.3 |
| Outline | **None** (`outline:false`, LIV-115) — colours end at the silhouette | art-direction §2, §11.5 |
| Ground contact | **Silhouette ground shadow** (§7), data-driven `groundShadow`, distinct from an outline | art-direction §7 |
| Palette | **`renderTier:"baked"`, `baked3d:true`** — `≤256` entries (≤255 opaque + `.` transparent), direct quantizer | art-direction §11 |
| Contrast | Every palette keeps a **≥3:1** rim entry vs the ≤0.02 floor | art-direction §3 |
| Facing / frames | 3-direction (`down`/`up`/`side`, `left` = mirrored `side`) | art-direction §2 |
| Frame sets | Actors that move author **idle (×1) + walk (×2, step-driven)** per direction; static actors author **idle only** (the renderer falls back to `idle.down[0]` for any missing state) | art-direction §2; `sprite-renderer.js:1139-1150` |

**Why the actor exception is mandatory here (readability + game feel).** NPCs and
creatures are the highest-screen-time, closest-viewed assets. At the full 60°
building pitch the runtime's 3-direction model loses the side-profile read and the
walk-cycle stride; a shallower actor camera preserves facing and gait legibility
within a beat. Buildings/props keep 60° for the oblique 3/4 read. This is the same
exception [art-direction.md](art-direction.md) §12.1 already grants the player
vocations — this issue extends it to all baked NPC/creature actors.

---

## 2. NPC mapping table — all 13 `html/data/npcs.json` cast

Board direction (2026-10-10): **reuse + recolor the closest mesh per role.** Six
rigged human meshes ship (`villager_m`, `villager_f`, `young_fisher`,
`first_fisher`, `deckhand`, `child_white_hair`); six cast members map 1:1, the
other seven reuse the nearest mesh with a **distinct recolor palette**. All six
meshes are **rigged walk models** (per the `lokarta-private` optimization guide), so
every NPC can carry the full directional **idle + walk** contract.

**Recolor palette columns** carry the NPC's garment, accent, and highlight hexes —
extending the [npc-identity-spec.md](../design/npc-identity-spec.md) §2.1 token set.
The **★** entry is the high-luminance rim that must clear ≥3:1 vs floor; the others
are the material ramp. Palettes are the identity carrier where two NPCs share a mesh.

### 2.1 Six direct meshes (mesh used as-authored)

| NPC (`id`) | Role | Mesh GLB | `aiType` | Recolor palette (garment / accent / ★rim-highlight) |
| :--- | :--- | :--- | :--- | :--- |
| Odon (`villager_m_odon`) | Ambient Shore folk | `villager_m_optimized.glb` | `wander` | `#6b4423` / `#2f6f73` / **`#d1b48c`** |
| Lena (`villager_f_lena`) | Ambient Shore folk | `villager_f_optimized.glb` | `wander` | `#9a5b2a` / `#b04a3a` / **`#f5e6cf`** |
| Ilo (`young_fisher_ilo`) | Ambient Shore folk | `young_fisher_optimized.glb` | `wander` | `#2f6f73` / `#b45309` / **`#cfe8e6`** |
| Brann (`deckhand_brann`) | Ambient Shore folk | `deckhand_walk_optimized.glb` | `wander` | `#47536e` / `#9a4a3a` / **`#cbd5e1`** |
| Kes (`child_kes`) | Ambient Shore folk | `child_white_hair_optimized.glb` | `wander` | `#b3763c` / `#5a4632` / **`#f0d0b8`** |
| Old Doran (`old_sailor_doran`) | Flavor (foreshadows Islands 2–4) | `first_fisher_optimized.glb` | `wander` | `#33415c` / `#9a4a3a` / **`#cbd5e1`** |

> **Mesh-assignment note.** Old Doran (retired deckhand, elder, stooped) takes the
> `first_fisher` mesh (an older, limping fisher body) rather than `deckhand`, so the
> two shore workmen (Brann, Doran) read as different generations instead of twins.
> The board enumerated the six direct meshes by name; this is the one role whose
> name→mesh binding is inferred, and it follows the "nearest body read" rule.

### 2.2 Seven reuse meshes (nearest mesh + distinct palette)

| NPC (`id`) | Role / body read | Reused mesh | `aiType` | Recolor palette (garment / accent / ★rim-highlight) |
| :--- | :--- | :--- | :--- | :--- |
| The Weigher (`elder_rowan_vane`) | Tall, stooped authority | `first_fisher` | `stationary` | `#3b4a6b` / `#d4af37` / **`#e2e8f0`** (lantern glass) |
| Captain Halden (`captain_halden`) | Broad, upright, mid-30s | `villager_m` | `stationary` | `#5b6470` / `#2f6f73` / **`#cbd5e1`** (plate shine) |
| Wick (`wick`) | Stocky workman, forward lean | `deckhand` | `stationary` | `#5a4632` / `#b45309` / **`#facc15`** (flame) |
| Tidekeeper Aurel (`high_dawnkeeper_aurel`) | Tall, mature, layered vestments | `villager_f` | `stationary` | `#e2e8f0` / `#d4af37` / **`#fbe6c8`** |
| Mara (`mara`) | Petite/wiry, asymmetric stance | `villager_f` | `stationary` | `#7c4a21` / `#b45309` / **`#d9a441`** (brass) |
| Innkeep Bessa (`innkeep_bessa`) | Broad, welcoming, 40s | `villager_m` | `stationary` | `#9a5b2a` / `#b04a3a` / **`#f5e6cf`** (cream) |
| Young Tam (`pilgrims_apprentice_tam`) | Lithe young teen | `young_fisher` | `stationary` | `#3f6a33` / `#6b4e2e` / **`#e8dcc0`** (parchment) |

### 2.3 Mesh-usage census & the relaxed silhouette rule

| Mesh | Used by | Count |
| :--- | :--- | :--- |
| `villager_m` | Odon, Halden, Bessa | 3 |
| `villager_f` | Lena, Aurel, Mara | 3 |
| `young_fisher` | Ilo, Tam | 2 |
| `first_fisher` | Doran, Weigher | 2 |
| `deckhand` | Brann, Wick | 2 |
| `child_white_hair` | Kes | 1 |

**Reconciliation with [npc-identity-spec.md](../design/npc-identity-spec.md) §2.**
That spec required *no two NPCs share an `idle_down` alpha mask* — achievable when
each NPC was hand-drawn. The board's **reuse + recolor** direction makes that rule
unachievable: 13 cast, 6 meshes, so 7 roles necessarily share a silhouette with a
recolored twin. This spec **supersedes the mask-uniqueness rule for the 3D-baked
set** and replaces it with the softer identity carriers below. *Balance lever: the
smallest lever that keeps identity is the recolour palette + spatial separation, not
new meshes (which do not exist).*

* **Distinct palette per NPC** (the table above) — hue-separated garment + accent +
  rim, so the same silhouette never wears the same colours twice.
* **Spatial separation** — no two same-mesh twins stand on the same screen edge
  (verified against the fixed town tiles in §3 and the ambient wander radii).
* **Name/title/dialogue** carry the rest. The §2.1 **signature-prop overlays**
  (Vane's staff+lantern, Halden's tricorn+sword, etc.) stay as *optional* recolour
  overlays the Tech Lead may composite over the baked base if a twin pair still
  reads ambiguously at 1:1 — they are no longer required to change the outline.

### 2.4 Animation & engine contract (handoff to [LIV-134](/LIV/issues/LIV-134))

* **Ambient NPCs (`aiType:"wander"`, the 5 Shore folk + Doran):** board answer (3)
  requires **full directional walk + idle**. Today `updateNpcs`
  (`html/engine/npc-system.js:119-147`) moves `npc.x/y/facing` but never touches
  `npc.anim`, so every wanderer renders `idle_down` while sliding. The bake must
  ship `walk_down/up/side` (×2) + `idle_down/up/side` (×1); the Tech Lead wires
  `npc.anim = createAnimState(npc.facing)` and calls `setAnimState(npc,'walk')` on a
  step / `'idle'` when stationary — no per-NPC branch.
* **Stationary NPCs (the 7 quest/shop figures):** `aiType:"stationary"` — idle only
  is sufficient; the walk frames still ship so a future schedule/bustle pass
  (LIV-85) can animate them for free.
* **Sprite resolve order is unchanged** (`npcSpriteId > spriteId > …`,
  `sprite-renderer.js:1134`); `npcSpriteId` keeps resolving to the bespoke def, so
  `renderTheme` remains the fallback tint only (`sprite-renderer.js:1477-1481`).
* **Asset location:** one baked def per `npcSpriteId` under
  `html/assets/sprites/npc/` (kind `npc`), registered in `manifest.json` +
  `assets/sprites/index.js`. Full 5-state × 3-dir shape is legal; only idle+walk are
  authored now.

---

## 3. Quest-giver placement convention

Board answer (2): **quest givers stand in the top-row doorways**, facing `down`.

### 3.1 The rule

> **Doorway tile = the tile immediately south of a building's footprint, on the
> footprint's horizontal centre column:** `(cx, y1+1)` where
> `cx = round((x0 + x1) / 2)`, using `towns.json`'s inclusive
> `footprint:[x0,y0,x1,y1]` form. If the centre tile is not walkable, step south
> along the same column to the first walkable tile. The giver is placed on that
> tile with `facing:"down"`.

This is the historical Havenreach door rule (the tile below the footprint) made
explicit and footprint-relative, so it survives the LIV-101 harbour re-skin that
changed the top-row footprints.

### 3.2 The three top-row doorways (current `html/data/towns.json`)

| Structure (`towns.json` id) | Footprint `[x0,y0,x1,y1]` | `cx` | **Doorway tile** | Tile under it | Giver (quest) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Fish Market** (`top_fishers_house_west`) | `[2,2,4,4]` | 3 | **`(3,5)`** | GRASS | **Capt. Halden** — Q1 (*Rats in the Gutter*) |
| **The Tidehall** (`top_fishers_house_east`) | `[19,1,21,4]` | 20 | **`(20,5)`** | GRASS | **Wick** — Q2 (*The Lantern Wreck*) |
| **The Longhouse** (`top_longhouse_center`) | `[6,1,17,6]` | 12 | **`(12,7)`** | PATH (central street) | **The Weigher** — Q3 (*Rite of the Beacon*) |

`(12,7)` is the intersection of the east-west main street (`y=7`, `x=3..20`) and
the central north-south street (`x=12`, `y=7..20`) — the Longhouse centre is
`x=11.5`, so the doorway snaps to the street column to keep the forecourt
symmetric.

**Relocations from the current `npcs.json` (Tech Lead applies in
[LIV-134](/LIV/issues/LIV-134)):**

| NPC | current tile | → doorway tile |
| :--- | :--- | :--- |
| `captain_halden` | `(6,11)` | **`(3,5)`** |
| `wick` | `(17,11)` | **`(20,5)`** |
| `elder_rowan_vane` (The Weigher) | `(19,8)` | **`(12,7)`** |

### 3.3 Marker & stage gating (preserved, data-driven)

* **`!` marker preserved.** `scene-controller.js:635-656` recomputes
  `npc.questMarker = 'available' | 'turnin' | null` from
  `quests.json` `giverNpcId`/`turnInNpcId` + `canAcceptQuest`/`canTurnIn`. Relocating
  the NPC does **not** touch the marker path; the ids are unchanged, so
  `quests.json` wiring (`captain_halden`, `wick`, `elder_rowan_vane`) keeps resolving.
* **Correct-stage gating** is already the `prerequisites` chain — no new gate:
  * **Halden (Q1)** — marker `!` from game start (no prerequisites).
  * **Wick (Q2)** — `!` only after Q1 `rats_in_the_gutter` is `turned_in`
    (`prerequisites:["rats_in_the_gutter"]`).
  * **Weigher (Q3)** — `!` only after Q2 `the_lantern_wreck` is `turned_in`
    (`prerequisites:["the_lantern_wreck"]`).
  A giver whose quest is neither acceptable nor turn-in-able shows **no marker** and
  its dialogue falls through to its flavor stage — unchanged behaviour.
* **No soft-lock.** Every doorway tile is walkable and reached from the town spawn
  `(12,21)` without crossing the giver: `(3,5)` and `(20,5)` sit in open grass;
  `(12,7)` blocks the street *crossing* but the parallel grass rows `y=6`/`y=8` keep
  the north court and the vertical street reachable. [LIV-134](/LIV/issues/LIV-134)
  must re-run `sceneAccessReport` after placement to confirm.

---

## 4. Creature → Dawnreach Isle overworld mapping

Board answer (4): **all 3 creatures baked and wired live.** The isle's overworld
roster lives in `monsters.json` + `islands.json` `spawnZones` (§6.6 of
[game-design.md](../design/game-design.md)). The three creature GLBs become **three
new overworld monster types**, split into two movement classes — **static**
(single-pose ambusher) and **walking** (roaming chaser) — per the deliverable.

### 4.1 Mapping table

| Creature GLB | Bake class | New `monsters.json` type | Role (taxonomy) | `aiType` | Frames authored | Placement |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `piranha_optimized.glb` | **static** (single pose) | `river_piranha` | **Sessile ambusher** | **`stationary`** (new handler) | `idle` only (3-dir) | Water-adjacent shore tiles near the harbour / Wreck |
| `river_eel_optimized.glb` | **static** (single pose) | `river_eel` | **Sessile ambusher** (long reach) | **`stationary`** (new handler) | `idle` only (3-dir) | Tide-pool / sand tiles adjacent to `WATER` |
| `river_rat_static_optimized.glb` + `river_rat_walking_optimized.glb` | **walking** (idle from static, walk from rigged) | `river_rat` | Shoreline **pack chaser** | `chase` | `idle` + `walk` (3-dir, ×2) | Added to the existing grass wild pools (`west_wilds`, `approach_meadow`) |

### 4.2 The one new engine contract: `aiType:"stationary"` (handoff → [LIV-135](/LIV/issues/LIV-135))

The runtime `AI_HANDLERS` table (`html/engine/entity-ai.js:69-87`) has **no static
handler** — every non-aggroed monster `idleWander`s and every aggroed monster runs a
movement AI. A sessile ambusher therefore needs **one data-driven handler**, exactly
mirroring the NPC `stationary` (which simply returns without moving):

```
AI_HANDLERS.stationary = (monster, player, gridMap, ...) => {
  // never moves; faces the player when within aggro range;
  // fires its catalog `attacks[]` on cadence when in range (reuses the ranged/
  // charger attack resolution — no bespoke attack math).
};
```

* Catalog-only, no per-monster `if`; unknown `aiType` still falls back to `chase`.
* The ambusher is a **new entry in the enemy role taxonomy** — position the player
  must respect, not chase. It demands a distinct response (don't stand in the
  shallows) and reads clearly because it never moves.
* `moveCadence` is ignored for `stationary` (set it to any value; document `0`).

### 4.3 Balance rationale (per creature)

* **River Piranha — the "don't step in the water" lesson.** A `stationary` melee
  lunge at range 1, high damage, low HP (a glass ambusher). Placed in the shallows
  beside the harbour and the Wreck, it makes the water edge *mean* something without
  a swim system. *Lenses: enemy role taxonomy (new sessile role), core loop
  (positioning), readability (a still silhouette is unambiguous).*
* **River Eel — the longer-reach ambusher.** A `stationary` reach-2 grab with a
  short `root` (reusing the LIV-60 `root` status already specced for the Mudlark
  Wrecker), so it punishes the greedy shoreline path the piranha alone would not.
  Same class, different range → a two-step shoreline read. *Lenses: enemy role
  taxonomy, difficulty curve (a second, subtler position check), MDA (the root
  converts over-extension into tension).*
* **River Rat — the roaming shoreline chaser.** Full rigged walk cycle; `chase`;
  joins the existing grass pools as a faster, lower-HP skirmisher. It is the only
  one of the three that roams, so it carries the "wildlife is alive" read.
  *Lenses: game feel (the only animated creature), enemy role taxonomy (pack
  chaser), balance levers (count + speed, not HP).*
* **Determinism & economy.** All three use the existing
  `respawn:"deterministic"` zone semantics and register `economy.json`
  `monsterGold` + `monsters.json` `lootTable` like every other isle foe; no new
  economy path. *Lenses: economy & reward pacing, scope discipline.*

### 4.4 Why static is a monster, not a prop

A piranha/eel dropped in water as a scene **prop** would be fixed and walk-over —
dead scenery, and the water tile under it stays impassable, so the player can never
interact. Making them **stationary monsters** on the walkable tile *adjacent* to
water gives a live, tactically legible threat with the same fixed position and no
swimming/pathing work. This is why the deliverable maps them to **monster types**
with a `static` bake, not to the prop table (§5).

---

## 5. Prop classification — `wooden_dock`, `wooden_barrel`, `palm_tree`, `rock_pile`

Scene props are authored per-cell in `towns.json`/`islands.json` `props[]`
(`{ propId, x, y, frame? }`). Two independent fields classify a prop:

1. **`layer`** on the scene entry — `"decor"` = **walk-over** (drawn under actors);
   `"prop"` (or the furniture pass) = **blocks the tile** via
   `gridMap.blockTile` (`scene-controller.js:157-165`). Layer also picks the render
   pass (`canvas-renderer.js:570` decor vs `:599-601` furniture).
2. **`kind` / `class`** in the prop def JSON — `kind:"prop"`, `class:"free"|"wall"|"decor"`.

Board answer (5): add **dock / barrel / palm / rocks**; **replace the 2D barrel**;
leave the other 2D props for now.

| Prop GLB | `propId` | Tiles | `layer` | Blocking | Pass | Placement (Phase 1/2) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `wooden_dock_optimized.glb` | `prop_wooden_dock` | **3×1** (`native 192×64`) | **`decor`** | walk-over | decor | Harbour quay, over/at the water edge (town + isle shore) |
| `wooden_barrel_optimized.glb` | `prop_wooden_barrel` | **1×1** (`64×64`) | **`prop`** | blocks | furniture | Town: **replaces `prop_barrel`** at `(3,8)` (same tile) |
| `palm_tree_optimized.glb` | `prop_palm_tree` | **1×2** (`native 64×128`) | **`prop`** | blocks | furniture | Isle shore/beach scatter |
| `rock_pile_optimized.glb` | `prop_rock_pile` | **1×1** (`64×64`) | **`prop`** | blocks | furniture | Isle shore/beach scatter |

**Rules & notes.**

* **All four are 3D-baked (N64):** `renderTier:"baked"`, `baked3d:true`,
  `outline:false`, native = tiles × 64, `≤256` palette, ≥3:1 rim — the same contract
  as the buildings/nets in [art-direction.md](art-direction.md) §6.3 and §11.
* **These are scene objects → 60° camera baseline (`rise:60`)**, *not* the actor
  exception. Prop pitch follows the building/prop rule (art-direction §12.1).
* **`wooden_dock` is walk-over** so the quay stays traversable; a genuine walkable
  *surface* still comes from the existing `DOCK` tile (code 16,
  walkable) — the prop is the 3D-baked visual, never a new walkability path.
* **`wooden_barrel` replaces `prop_barrel`** at the identical tile(s) — a drop-in
  `propId` swap; `prop_barrel`'s 2D def is retired once the swap lands. All other
  2D props (`prop_fish_barrel`, `prop_net`, `prop_boat`, …) are **unchanged**, per
  board answer (5).
* **Blocking multi-tile caveat.** Only the single authored `(x,y)` cell blocks
  (`scene-controller.js:164`); `palm_tree`'s trunk base blocks one tile while its
  fronds overhang (fine). [LIV-134](/LIV/issues/LIV-134) must re-run the soft-lock
  guard after placement.
* **Island props are legal.** `composeScene` emits `def.props` for *any* scene
  (`scene-composer.js:207`); `islands.json` simply authors none today. Palm/rock
  scatter authors a new `islands.json` `props[]` list — no engine change.

---

## 6. Handoffs & acceptance

| Consumer | Applies |
| :--- | :--- |
| [LIV-134](/LIV/issues/LIV-134) (Tech Lead, Phase 1) | §2 NPC bake + recolor + walk wiring; §3 giver relocations + `sceneAccessReport`; §5 props |
| [LIV-135](/LIV/issues/LIV-135) (Tech Lead, Phase 2) | §4 creature bake + 3 monster entries + `stationary` handler + `spawnZones`; §5 isle props |

**Phase 0 acceptance (this issue).** All five docs committed to `main`; mapping
tables complete (13 NPCs + 3 creatures + 4 props). No code or catalog changes here.

*Lenses cited (§§1–5): readability & legibility, game feel / juice, enemy role
taxonomy, difficulty curve & flow, theme coherence, Kano, MDA, balance levers,
economy & reward pacing, scope discipline. No dark patterns or manipulative
engagement mechanics are introduced.*
