# Dawnreach Isle Enrichment Report

**10 prioritized initiatives to deepen what is already built**

| | |
| :--- | :--- |
| **Issue** | [LIV-80](/LIV/issues/LIV-80) — *Game enrichment review: 10 initiatives to deepen Dawnreach Isle* |
| **Author** | Game Designer |
| **Date** | 2026-10-08 |
| **Status** | Design report for board review — **no code changes in this deliverable** |
| **Scope** | Enrich the **existing** Dawnreach Isle: gameplay depth, imagery/artwork, NPCs, ambience, UX/content |
| **Out of scope** | **Any new island.** Islands 2–4 are explicitly deferred and are not designed here. |

---

## 0. Guardrails, scope, and how to read this

The core mechanics, the four towers, the party campaign, the town, the quest
chain, and the Dawnreach layout are now stable. This report deliberately does
**not** re-open them. It proposes ~10 areas that make the *existing* isle feel
richer, more alive, and more human — spending budget where it changes the felt
experience (*Kano: must-have > performance > delighter*).

**Explicitly out of scope**

- **New islands.** Islands 2–4 (elf, dwarf, animal, fairy inhabitants) are a
  future priority but are **not** part of this report. No island-2 content,
  travel, or NPC races are designed here.
- Engine rewrites, new towers, new vocations, and re-balancing of the shipped
  four-tower campaign.
- Dark patterns. Nothing here adds streaks, energy, loss-framed copy, or
  forced engagement; the wellbeing rules in §10.5 of `game-design.md` stand.

**Human-specific vs. generalizes**

Dawnreach Isle is the **human-inhabited** isle. Each initiative is tagged:

- **[GEN]** — the *pattern* generalizes to future isles; only the data differs.
- **[HUM]** — the specific content is grounded in Dawnreach's human coastal
  culture (Tidewatch, beacon/lantern motif, fishing town), though its system
  usually also generalizes.

Everything authored here is **data-first**, per the project mandate: a new
enemy is a `monsters.json` entry resolved by the existing `aiType` / `attacks[]`
dispatch tables; a new NPC behavior is an `aiType` value, never a per-NPC `if`.
Where an initiative needs a genuinely new schema field, the **Tech Lead** owns
the handler and the field is specified below with its acceptance criteria.

**Lenses used** (cited inline so reasoning is traceable): core loop & fantasy,
game feel / juice, difficulty curve & flow, enemy role taxonomy, readability &
legibility, economy & reward pacing, Kano model, MDA, balance levers, theme
coherence, replayability.

---

## 1. Current state — what I reviewed

- **Isle** `island_dawnreach` 48×48 (`islands.json`): Havenreach marker south,
  Spire of Light north behind the Tide Gate, four roam zones, two quest-site
  landmarks (Wreck of the Lantern `(4,20)`, Drowned Shrine `(39,22)`).
- **Town** `town_havenreach` 24×24 (`towns.json`): 6 buildings, 5 decor props
  (`prop_brazier ×2`, `prop_barrel`, `prop_crate`, `prop_table`), one south gate.
- **NPCs** (`npcs.json`): 8 named NPCs. **All 8 reuse a player-vocation sprite**
  (`magician`/`archer`/`fighter`/`paladin`) with a flat `renderTheme` tint, plus
  an OpenMoji `portraitEmoji`. Budgeting: 3 of 8 use `fighter`, 2 use `paladin`,
  2 use `archer`, 1 uses `magician`.
- **Overworld bestiary**: only `drowned_crawler` (chaser) and `tide_thrall`
  (zoner) roam the wilds, plus two quest elites (`gutter_king`, `shrine_warden`).
- **Ambience**: static `lighting: "ambient"`; ambient island/town audio was
  **deferred** (§10.7 D10); no day/night, no weather, no non-combat life.
- **Dialogue** (`dialogues.json`): strong, characterful voice already exists for
  all 8 NPCs — good raw material for personality build-out.

The design foundation is excellent. The gap is **density and specificity**: the
isle is legible and functional but reads as a clean stage rather than a lived-in
human place. That is the thesis of this report.

---

## 2. The 10 initiatives (prioritized)

Ordered by recommended build sequence (impact ÷ effort, with dependencies). Each
carries **What / Why (lens) / Effort / Impact / Department / Tag / Catalog
touchpoints**.

### I1. Distinct NPC art & portrait identity pipeline [GEN]
*Department: Art (lead) + Design + Engineering (renderer hook). Effort: M. Impact: High.*

**What.** Retire the "NPC = tinted player vocation" fallback. Author a dedicated
NPC sprite family (32×32, 3-direction `idle/walk/attack/hit/death` frame sets per
`art-direction.md` §2) and a small portrait sheet, and give every NPC an identity
of its own. Full art/personality plan in **§3**.

**Why.** *Readability & legibility + theme coherence.* Right now `Mara the
Tinker` and `Old Sailor Doran` are the same `fighter` silhouette in different
tints — the player's most reliable identity cue (silhouette) is being reused for
people who are nothing alike. Distinct NPC art is the single highest-leverage
"make the isle feel human" change, and it is the **foundation** for I2, I9 and
the whole representation plan. *Kano: delighter that also fixes a readability
defect.*

**Catalog touchpoints.** `npcs.json` gains `npcSpriteId` (asset id) and
`portraits: {neutral, warm, urgent}`; `renderTheme` is retained as a **fallback**
so nothing breaks during migration. New assets under `html/assets/npc/`.
**Tech Lead acceptance:** renderer resolve order becomes `npcSpriteId > spriteId
> type`; `sprite-assets.test.mjs` gains an NPC-atlas drift check.

---

### I2. NPC personalities, daily schedules & town bustle [GEN/HUM]
*Department: Design (lead) + Engineering. Effort: M. Impact: High.*

**What.** Give the 8 named NPCs a **day**: a data-driven schedule (morning /
midday / evening / night positions + facing + a dialogue variant), and add a
small set of **town bustle** entities — nameless civilians, a cat, market
shoppers, gulls — as neutral entities so the square is never empty. Add
schedule-aware lines so the same NPC reads differently at dusk than at noon.

**Why.** *Core loop & fantasy + game feel / juice.* A town where everyone stands
frozen forever is a diorama. Schedules convert the hub from a menu of vending
machines into a place: the Dawnkeeper tends the temple by day and prays at the
shrine at night; Mara's stall is open at market hours; the tavern fills at dusk.
This is the cheapest large win in immersion and it *generalizes* — future isles
inherit the schedule system and only author their own data. *MDA: the aesthetics
of "inhabited world" emerge from cheap mechanical scheduling.*

**Catalog touchpoints.** `npcs.json` adds optional
`schedule: [{fromHour, toHour, x, y, facing, dialogueVariantId}]`; new
`time.json` (day length, phase names, default phase color hooks). Bustle
entities are `npcs.json` entries with `aiType: "ambient"` (new value) + a
`bustle` pool per scene. **Tech Lead acceptance:** unknown `aiType` still
resolves through the neutral-entity dispatch; schedule positions must stay
inside walkable tiles (validated by a test like `sceneAccessReport`).

---

### I3. Ambient audio beds & positional ambience [GEN]
*Department: Engineering (lead) + Design. Effort: M. Impact: High.*

**What.** Implement the deferred ambient layer: looping synthesized audio beds
per biome/scene (surf + wind for the isle; crowd + bell + forge for the town;
crickets/birds by time of day) plus **positional one-shots** (gulls, a hammer, a
shop bell, footsteps on sand vs. stone).

**Why.** *Game feel / juice + theme coherence.* Audio is the largest untapped
juice budget in the project: it makes the same pixels feel 2× more alive, sells
the coastal-human theme, and gives feedback the eye can't (a shop door opening
behind you). It also reinforces *readability* — distinct sounds for telegraphs
already exist; ambient beds fill the silence between them. *Kano: performance
attribute once noticed, delighter before.*

**Catalog touchpoints.** `sounds.json` gains ambient bed entries
(`kind: "ambient"`, `loop: true`, gain/filter) and one-shots; `biomes.json` gains
`ambience: { bedId, dayOneShots[], nightOneShots[], weatherVariants }`.
**Tech Lead acceptance:** WebAudio ambient buses are muteable via the existing
options; no new external assets (all synthesized, matching current approach).

---

### I4. Day/night cycle & weather ambience [GEN]
*Department: Engineering (lead) + Art + Design. Effort: M–L. Impact: High.*

**What.** Extend the static `lighting: "ambient"` into a slow, data-driven
**time-of-day** pass (dawn → noon → dusk → night light colors and a gentle light
mask) plus a light **weather** layer (clear / sea-mist / rain), each with
per-biome weights. Weather and time nudge spawn density and a few enemy
behaviors (e.g. `tide_thrall` gains range in sea-mist).

**Why.** *Theme coherence + difficulty curve & flow + replayability.* A single
static noon makes every visit identical. A dusk walk back to town, lit braziers,
and night-danger is the emotional payoff of "carrying the last light" — the
island's own fantasy. Weather adds run-to-run texture without new content.
Balance stays honest because effects are **authored levers** (spawn %, range
delta), not hidden multipliers. *Lens: balance levers (smallest change: light
color + spawn weight, not new enemies).*

**Catalog touchpoints.** New `time.json` (phases, light colors, step seconds)
and `weather.json` (id, weight per biome, `lightColor`, `spawnDensityMult`,
`monsterModifiers[]`). `biomes.json` gains `ambientLight` entries.

---

### I5. Isle threat roster expansion [HUM]
*Department: Design (lead) + Engineering. Effort: M. Impact: High.*

**What.** The wilds currently offer only two roaming foes. Add **three** new
overworld opponents that each demand a *distinct player response*, and one
human antagonist faction to deepen theme. Proposed (values are pre-floor base,
inline `monsters.json` kits per the LIV-2 contract):

| Foe | Role | `aiType` | Kit | Why it earns its slot |
| :--- | :--- | :--- | :--- | :--- |
| **Salt Hound** (`salt_hound`) | Pack chaser | `charger` | melee; `onHit` bleed 3s | Adds *swarm discipline* to the chaser role — teaches spacing, not just kiting one crawler. 26 HP, 5–8, cd 1.0s. |
| **Mudlark Wrecker** (`mudlark_wrecker`) | Human zoner | `standoff` | thrown net (`projectile`, `onHit` root 1.5s) + knife melee fallback | A **human** antagonist grounds the isle's "wreckers prey on pilgrims" theme; root (not slow) is a new counterplay read. 44 HP, 6–10, cd 2.4s. |
| **Barnacle Brute** (`barnacle_brute`) | Elite | `charger` | melee + telegraphed `tide_slam` AoE (0.7s, r2, knockback) | First overworld *elite* worth reading; gives the east field a landmark fight between quest beats. 110 HP, 16–22 / 9–13. |

**Why.** *Enemy role taxonomy + difficulty curve.* The overworld should teach
each combat response *before* the towers assume it. Today only chaser + zoner
are taught outdoors. Adding pack-chaser, rooting zoner, and a telegraphed elite
closes the gap between the tutorial isle and the tower difficulty ramp.
`monsters.json` authoring stays data-only; two kits reuse `charger`/`standoff`
and one new `onHit.status` (`root`) — the Tech Lead adds the status handler.

**Catalog touchpoints.** `monsters.json` ×3; `economy.json.monsterGold` ×3;
`islands.json` spawn-zone `pool` updates; committed OpenMoji `svgCode` per foe.
**Tech Lead acceptance:** `root` is a `status-effect` handler with the same
shape as `slow`/`stun`; `data-catalogs` and `sprite-assets` stay green (shared
`spriteId`).

---

### I6. Landmark micro-scenes: Wreck interior & Shrine depths [HUM, pattern GEN]
*Department: Design (lead) + Engineering + Art. Effort: M–L. Impact: High.*

**What.** The Wreck of the Lantern and the Drowned Shrine are currently single
tiles. Turn each into a **small authored sub-scene** entered via a portal: a
one- or two-room interior with a curated encounter, a chest, and environmental
storytelling. Q2's `beacon_lens` sits at the *end* of the Wreck's flooded hold,
so the fetch becomes a place instead of a bump.

**Why.** *Core loop & fantasy + reward pacing.* Landmarks that are a single
tile fail to deliver the promise their name makes. A 1–2 room interior is the
cheapest way to add *exploration* to a fetch quest and to make the isle's
geography memorable. The pattern (portal → authored micro-scene → chest) is the
same primitive future isles and towers use, so the engineering is reusable.
*Economy: a guaranteed chest at the end turns travel into payout.*

**Catalog touchpoints.** New `interiors.json` (or reuse the `dungeons.json`
shape); `islands.json` landmark gains `portal → interiorId`; `chests.json`
supplies the loot table; a committed interior tile theme (root-level, like the
scene themes, to keep the tower contrast scan unchanged).

---

### I7. Optional discovery layer: secrets, lore stones & buried caches [GEN]
*Department: Design + Engineering. Effort: S–M. Impact: Medium–High.*

**What.** Sprinkle optional, skippable discoverables across the isle: buried
caches (a dig/`interact` that rolls a copper chest), **tidepool lore stones**
that grant a one-line fragment of Dawnreach history, a **notice board** near the
town gate carrying rotating NPC-written notices, and 1–2 hidden-in-plain-sight
spots for observant players.

**Why.** *Replayability + economy & reward pacing.* Optional discovery rewards
the player who *explores* rather than beelines the quest arrow, adds run-to-run
variance with pure data, and gives the economy a risk-free trickle. It also
deepens theme at near-zero cost — lore stones are just `dialogues.json` entries.
*Kano: delighter; must stay optional so it never gates progression.*

**Catalog touchpoints.** `islands.json` gains `secretSpots[]` /
`interactables[]` with `lootTableId` (→ `chests.json`) and `loreDialogueId`
(→ `dialogues.json`); the notice board is a `dialogues.json` world prompt with
a stage list.

---

### I8. Cozy non-combat activity: fishing & beachcombing [HUM, system GEN]
*Department: Design + Engineering + Art. Effort: M. Impact: Medium.*

**What.** Add fishing spots at the shoreline (a data-driven timing mini-loop
that yields `items.json` catches and gold) tended by a new **fisherman NPC**,
plus low-stakes beachcombing pickups (driftglass, shells) that feed a small
turn-in. Fully optional and interruption-free.

**Why.** *Player wellbeing + Kano delighter + economy.* A calm, non-violent
thing to do on a human coastal isle rounds out the emotional range of the game,
gives the shore a reason to exist, and creates a gentle item/gold sink-and-source
that isn't combat. *Design for wellbeing:* no timers, no streaks, no FOMO — it's
a place to stand and enjoy the light you relit. The mechanic generalizes; only
the catches and spot locations are Dawnreach data.

**Catalog touchpoints.** New `activities.json` (fishing spot shape, difficulty,
loot table); `islands.json` gains `fishingSpots[]`; `items.json` gains catches;
`npcs.json` gains the fisherman; `sounds.json` gains a cast/reel one-shot.

---

### I9. Side-quest & relationship depth for the 8 named NPCs [HUM, pattern GEN]
*Department: Design (lead) + Engineering (content only). Effort: S–M (mostly content). Impact: Medium–High.*

**What.** Give the existing named cast optional side-quests and small
relationship beats that flesh out their personalities: Doran's lost charts,
Bessa's missing tavern cat, Tam's apprenticeship errand, a Tidewatch patrol
escort for Halden, a tinker-material fetch for Mara. Each is a short
`quests.json` chain + `dialogues.json` tree, and each reveals one piece of
Dawnreach's human story.

**Why.** *Core loop & fantasy + theme coherence.* The main chain is a tight
tutorial; the *people* are what make an isle human. Side-quests are pure content
lever: no new systems, big felt payoff, and they turn 8 quest-dispensers into
characters. *Kano: performance/delighter; cheap because `quests.json` is already
a complete dispatch surface.*

**Catalog touchpoints.** `quests.json` (3–5 optional quests, `prerequisites`
only, never gating the main chain); `dialogues.json` stages; possibly one new
`objective.type` (`visit`/`escort`) if we need it — otherwise reuse
`talk|kill|fetch|reach|interact`.

---

### I10. UX, accessibility & onboarding pass (+ in-game bestiary codex) [GEN]
*Department: Design + Engineering + Art. Effort: M. Impact: High.*

**What.** A focused quality pass on how the existing isle communicates:
(1) an **in-game Bestiary/Codex** that records discovered foes with their
silhouette, role, and telegraph, built from `monsters.json`; (2) onboarding
prompts for the first ~5 minutes; (3) **accessibility** coverage — color-blind
telegraph palettes, reduced-motion parity for the new ambience, larger dialogue
text, and confirming the remappable keys in `keybindings.json` are complete.

**Why.** *Readability & legibility + inclusion.* The roster is mechanically deep
but the player is never told what a role *means*; a codex converts depth into
understanding. Accessibility is an inclusion duty, not a nice-to-have, and it is
also just good onboarding. *Kano: must-have for accessibility; performance for
the codex.* New ambience from I3/I4 **must** ship with reduced-motion and
color-blind variants or it decreases legibility for some players.

**Catalog touchpoints.** New `codex.json` derived from `monsters.json`
(no duplicate stats — reference by `id`); `ui.json` gains the codex + prompt
blocks; `ui.json`/tile themes gain color-blind telegraph variants.

### Stretch (not counted in the 10)

- **S1. Town standing / reputation** — track standing with the Tidewatch, Temple,
  and Stall; changes prices, dialogue, and NPC costume accents. [HUM] *Design +
  Engineering.*
- **S2. Player cosmetic customization** — expose the §4 representation palette
  to the player character. [GEN] *Art + Design + Engineering.* Builds directly
  on I1's asset and token work.

---

## 3. NPC art & personality build-out

**Problem.** All 8 NPCs are a recolored player vocation. Two NPCs can share the
same silhouette (Mara and Doran are both `fighter`; Aurel and Bessa are both
`paladin`), and the only differentiator is a flat tint. For the human isle, the
people *are* the content — this is the place to spend art budget.

### 3.1 Distinct sprite identities

Author each named NPC as its own 32×32 sprite with a unique silhouette and
**one signature prop** that reads at a glance:

| NPC | Silhouette signature | Suggested read |
| :--- | :--- | :--- |
| Elder Rowan Vane | Long robe + tall staff + lantern | authority, age |
| Captain Halden | Breastplate + tricorn + sword | military, upright |
| Wick the Lamplighter | Apron + goggles + hand-lantern | artisan, soot |
| High Dawnkeeper Aurel | Layered vestments + censer | temple, serene |
| Mara the Tinker | Toolbelt + satchel + rolled sleeves | merchant, busy |
| Innkeep Bessa | Apron + towel + rolled sleeves | hearth, warmth |
| Old Sailor Doran | Peacoat + knit cap + cane | weathered, retired |
| Pilgrim's Apprentice Tam | Oversized pack + short cloak | young, eager |

**Rules.** Silhouette first (props change the outline, not just the palette);
≤16-color indexed palette with the existing `#0b0d12` outline; keep the ≥3:1 rim
contrast bar against all scene floors. **[GEN]** the pipeline; **[HUM]** the
specific props/roles.

### 3.2 Portraits & expression

Replace the single `portraitEmoji` with a committed portrait sheet: a **48×48
bust** per named NPC (scales up crisply, matches the SNES bar) with **three
expressions — `neutral`, `warm`, `urgent`** selected by dialogue stage
(`when`/`actions` in `dialogues.json`). Expression is a readability lever: a
quest-giver's urgency should show on their face, not only in the text.
Keep `svgCode`/`portraitEmoji` as fallback during migration.

### 3.3 Personality through data

The dialogue writing is already strong (Doran's "I'll die a happy liar," Aurel's
"A body should not be a toll"). Build personalities by **widening the surfaces
that carry voice**, all data-only:

- **Schedule-varied lines** (I2): a `night` variant per NPC, one line only.
- **Idle barks / ambient quips**: short scheduled lines that fire when the
  player walks near — pure flavor, no action.
- **Relationship beats** (I9): each NPC gets one optional personal side story.
- **Cross-references**: NPCs already reference each other (Halden → Wick). Add
  1–2 more so the town reads as a community, not eight monologues.

### 3.4 Effort & department

**Art-led, Design-partnered, Engineering hook.** The renderer change
(`npcSpriteId` resolve order, `portraits` map, `ambient` aiType) is a bounded
Tech Lead task. Art ships incrementally: it is acceptable for the first batch to
cover the four quest-critical NPCs (Halden, Wick, Aurel, Vane) with the rest on
the fallback, per the existing non-blocking art posture.

---

## 4. Inclusion & representation plan

**Principle.** Do not default to a white-centric fantasy world. Dawnreach is a
human coastal isle; its people should reflect a broad, deliberate range of skin
tones, hair, body types, and ages **by default across every role**, including
positions of authority. Representation is authored as **palette tokens and body
variants in data**, the same way everything else is — not as one-off art.

### 4.1 Skin tones (concrete)

Add a shared `skinTones` token set (used by every human actor: vocations, NPCs,
recruits). Author **~10 named ramps**, each a 2–3 shade ramp (base/shadow/light)
so the 16-color budget holds and shading stays consistent:

`porcelain, fair, honey, olive, tan, bronze, umber, chestnut, espresso, deep`
— spanning the full human range, deliberately **not** clustered around the
light end. Each ramp must be validated against every scene floor at the ≥3:1
rim contrast bar, including under night/dark light masks. **The four player
vocations must not all share one tone**; each ships with a distinct default and
all ramps are selectable (S2).

### 4.2 Hair

Offer authored `hairStyles` that are readable at 32×32: `coils, afro, locs,
braids, twists, bun, waves, straight-long, straight-short, buzzed, undercut,
wrapped/head-covering`. Hair is an *everyday* option, never a costume. Palette:
`black, dark-brown, brown, auburn, blonde, red, gray, silver, white` plus a
restrained set of fantasy hues. Ensure at least a few styles are authored with
diverse texture (not just "straight hair recolored").

### 4.3 Body types, age & ability

Representation is not only skin tone. Add silhouette `bodyTypes` — `broad,
lithe, stocky, tall, petite, mature/stooped` — that change proportions, not just
color, and distribute them across NPCs and recruits. Include:

- **Elders** with mobility aids (Vane and Doran already read as old — make the
  cane/stoop part of the art, not just the dialogue).
- **Disability representation** as ordinary life: a carpenter with a prosthetic
  forearm, a fisher with a crutch, a seated musician, a character with vitiligo.
  Draw these as competence, not pity or plot device.
- **Age diversity** in the working cast: young apprentice (Tam) through
  wrinkled retiree (Doran), with several middle-aged NPCs.

### 4.4 Avoiding appropriation and stereotype

Concrete guardrails for the art team:

- **Invent Dawnreach's own material culture** from its own motifs — driftwood,
  salt-glass, lantern/beacon, rope, oilskin, tidewrack. Do **not** import
  real-world sacred or ceremonial regalia (feather headdresses, specific
  religious garments, face/body paint, war bonnets, tribal patterning).
- **Head-coverings and hair wraps are everyday wear**, offered across all
  characters, not tied to one ancestry or depicted as exotic.
- **Never map personality, morality, or role to skin tone.** The wise elder,
  the villain, the hero, and the comic relief must all appear across the range.
  In particular, do not make the only dark-skinned character the antagonist, the
  mystic, or the servant.
- **No accent-coding or "broken speech"** in dialogue to signal background; keep
  the established literate, warm voice for everyone.
- **Authority is intersectionally diverse**: the Elder, Captain, and Dawnkeeper
  should collectively span ages, body types, and skin tones.

### 4.5 Player-facing & systemic

- Expose tone/hair/body to the player at character creation (S2) so players can
  see themselves in the hero.
- Extend `sprite-assets.test.mjs` (or a new `representation.test.mjs`) to assert
  the authored NPC/recruit default set is **not** monochrome and that every
  skin ramp passes contrast — turning inclusion into a **regression gate**, not a
  one-time promise.
- Same treatment generalizes: every future isle's inhabitants get authored
  diversity; `[GEN]`.

---

## 5. Terminology note: "race" = ancestry, not human ethnicity

**Convention to adopt in `game-design.md` and `art-direction.md`:**

- **"Ancestry" / "species"** means **Human / Elf / Dwarf / Fairy / (etc.)** —
  the fantasy peoples of Lokarta. Dawnreach is the **Human** isle; later isles
  host other ancestries. When the docs or code say `race`, they mean this.
- **"Skin tone" / "heritage" / "ethnicity"** describes diversity **within** the
  human population (and within every ancestry). It is **never** a gameplay
  faction, stat, or alignment axis.
- **There is no "human race" default assumption.** Humans are one ancestry among
  many, and the human population itself is diverse.

**Action:** add a one-paragraph terminology note to the top of the relevant
design/art docs and prefer `ancestry` in new schema keys (e.g.
`ancestryId: "human"`), so future isle content never overloads `race` with
human ethnicity.

---

## 6. Prioritization summary

| # | Initiative | Dept | Effort | Impact | Tag | Depends on |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| I1 | Distinct NPC art & portrait pipeline | Art + Design + Eng | M | High | GEN | — |
| I3 | Ambient audio beds & positional SFX | Eng + Design | M | High | GEN | — |
| I2 | NPC schedules, personalities & bustle | Design + Eng | M | High | GEN/HUM | I1 (art reused) |
| I5 | Isle threat roster expansion | Design + Eng | M | High | HUM | new `root` status (Eng) |
| I10 | UX, accessibility & bestiary codex | Design + Eng + Art | M | High | GEN | I3/I4 (a11y variants) |
| I6 | Landmark micro-scenes (Wreck/Shrine) | Design + Eng + Art | M–L | High | HUM/GEN | interior portal support |
| I4 | Day/night cycle & weather ambience | Eng + Art + Design | M–L | High | GEN | I3 (audio variants) |
| I9 | Side-quests & relationship depth | Design + Eng | S–M | Med–High | HUM/GEN | — |
| I7 | Optional discovery layer (secrets/lore) | Design + Eng | S–M | Med–High | GEN | — |
| I8 | Fishing & beachcombing (cozy activity) | Design + Eng + Art | M | Medium | HUM/GEN | — |
| S1 | Town standing / reputation | Design + Eng | M | Med | HUM | I2 |
| S2 | Player cosmetic customization | Art + Design + Eng | M | Med | GEN | I1, §4 tokens |

**Recommended first wave:** I1, I3, I5, I10 — each is high-impact, self-contained,
and immediately visible, and together they raise *identity* (NPC art), *juice*
(audio), *combat depth* (roster), and *clarity* (UX/a11y). I2/I4/I6 follow as
the "make it a living place" wave; I7/I8/I9 are content-depth windfalls that can
run in parallel once the first wave lands.

---

## 7. Handoff & next steps

- This report is the deliverable. **No code changes** are included or required.
- **Tech Lead** owns the schema/handler hooks named above (renderer
  `npcSpriteId`/`portraits`/`ambient` resolve order, `root` status handler,
  interior portals, `time.json`/`weather.json`/`activities.json` loaders,
  `codex.json`). Each spec above includes its acceptance criteria.
- **Art** owns the NPC/portrait/representation assets (§3, §4); **Design** owns
  all `dialogues.json`/`quests.json`/`monsters.json`/`economy.json` content.
- **CEO** owns naming and any outward-facing copy (new foe/NPC names, notice-board
  copy).
- On board approval, these initiatives can be broken into assigned child issues
  (design content + Tech Lead implementation) with the specs above as their
  descriptions.

*Lenses cited throughout: core loop & fantasy (I2/I6/I9), game feel / juice
(I2/I3), difficulty curve & flow (I4/I5), enemy role taxonomy (I5), readability
& legibility (I1/I10), economy & reward pacing (I6/I7/I8), Kano model (§0/I1/I3/
I7/I8/I10), MDA (I2/I4), balance levers (I4/I5), theme coherence (§3/§4/I4/I6),
replayability (I4/I7). No dark patterns or manipulative engagement mechanics are
introduced.*
