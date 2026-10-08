# Lokarta: Game Design Specification

A high-level design canon for *Lokarta: Come Into The Light*.

---

## 1. Core Game Loop

1. **Title & Save Slot Selection:** Choose from 5 persistent save slots stored in browser IndexedDB (`lokarta_browser_db`).
2. **Havenreach Town Hub:** Access the Merchant's Stall (Shop), Temple of the Dawn (Temple healing), or embark into the tower.
3. **Sequential Tower Campaign:** Climb one of four themed towers at a time, in unlock order, through its deterministic procedural levels on a $40 \times 40$ tile grid ($3 \times 3$ macro rooms). Only the Spire of Light is available at campaign start; each conquered tower unlocks the next (§8).
4. **Gated Progression & Keys:** Defeat tier key holders to obtain Copper, Silver, and Gold keys to unlock gates leading to the ascent stairs.
5. **Combat & Tactical Abilities:** 10 Hz real-time simulation tick (`TICK_INTERVAL_MS = 100`) using vocation-specific abilities, cooldowns, and range mechanics. Party members fight alongside the active hero in auto mode (§8.1).
6. **Fate Grants (Drafting System):** At Level 1 and upon every level-up (up to Level 20 cap), players are offered a 5-card draft and **must select exactly 2 cards** granting vocation skills, stat upgrades, or gear rank upgrades (Ranks 1–5).
7. **Recruit a Companion:** Clearing a tower's final floor is no longer a game-over. It shows the **Tower Complete** modal, then a **Recruit** choice that adds one not-yet-recruited vocation to the party (max 4, one per vocation). The new recruit becomes player-controlled for the next tower; prior members fight in auto mode.
8. **Ultimate Victory:** After all four towers are complete, "ULTIMATE VICTORY" fires once, as the campaign's terminal beat — not per-tower.

---

## 2. Playable Vocations & Archetypes

Class balance and distinct identity are enforced through **vocation-locked equipment** (`vocationAffinity` in `items.json`) and specific stat progression curves (`vocations.json`):

| Vocation | Role & Playstyle | Primary Weapons | Signature Mechanics & Item Sets |
| :--- | :--- | :--- | :--- |
| **Magician** | Radiant arcane spellcaster & vision control | Apprentice Wand & Astral Scepter | High mana pool, Light spell vision expand (+3/+2/+1 decay), ranged beam projectiles. |
| **Archer** | High mobility ranged marksman | Wooden Bow & Composite Longbow | Arrow ammo management, *Grey Stalker* quiver regen (1 arrow / 5s), poison tips, piercing power shots. |
| **Fighter** | Melee juggernaut & frontline control | Tempered Broadsword | *Vanguard* set: Shield bash push + stun, Berserker's Sigil whirlwind cleave, Battleplate fortify stance. |
| **Paladin** | Holy warrior & radiant support | Consecrated Warhammer | *Sanctuary* set: Aegis Shield, Sanctuary Plate, Dawnlight Reliquary; holy strikes, healing prayer, damage-absorption bubble. |

---

## 3. The Spire of Light (launch tower, 5 tiers)

The Spire is the first tower of the four-tower campaign (§7) and the template every
other tower follows. Its layout and monster pools are catalog-driven via
[`html/data/tower_levels.json`](../html/data/tower_levels.json):

* **Level 1 — The Gatehouse (`crypt`):** Warm amber glow (`#ff8800`). Enemies: Giant Rats, Crypt Skeletons.
* **Level 2 — The Hall of Banners (`catacombs`):** Cyan glow (`#00d4ff`). Enemies: Giant Rats, Crypt Skeletons, Shadow Cultists.
* **Level 3 — The Bell Keep (`shadow_vaults`):** Arcane purple glow (`#a855f7`). Enemies: Crypt Skeletons, Shadow Cultists (Elite Cultist gold keyholder).
* **Level 4 — The Solar Gallery (`abyssal_sanctum`):** Crimson glow (`#ef4444`). Enemies: Shadow Cultists, Elite Cultists.
* **Level 5 — The Crown Spire (`crown_spire`):** Golden amber glow (`#ffd700`). Final boss: **The Spire Warden** (`abyssal_overlord`, 600 HP) and 2 Spire Sentinels (`elite_cultist`).

---

## 4. Controls & Input Mapping

* **Keyboard Movement:** Arrow Keys $\uparrow, \leftarrow, \downarrow, \rightarrow$.
* **Party Cycling:** `A` / `S` cycle control to the previous / next living member (LIV-27), playing the control-swap feedback beat (LIV-49, §5).
* **Touch & Mobile Gestures:** Directional swipe for movement; tap for HUD buttons, loadout slots, and floor item pickup.
* **Active Consumable Slots:** Keys `1`, `2`, `3`, `4` activate potions, torches, and active consumables.
* **Equipment Hotkeys:** Keys `Q`, `W`, `E`, `R` map to `main_hand`, `off_hand`, `armor`, and `relic`.
* **Stairs & Gate Traversal:** Step directly onto stairs or unlocked gates to traverse tower rooms and floors.

---

## 5. Systems & Invariants

* **Inventory Layout (8 Keyed Slots + 36 Backpack):**
  * **4 Active Action Slots:** Hotkeys `1`–`4` (potions, torches, active items).
  * **4 Paperdoll Equipment Slots:** Hotkeys `Q`, `W`, `E`, `R` (`main_hand`, `off_hand`, `armor`, `relic`).
  * **36 Backpack Slots:** $6 \times 6$ storage grid for general inventory.
* **Knockout, Revive & Party Wipe (LIV-41):** A party member at 0 HP is **knocked out in place**, not removed — they collapse where they fell, grey out, project no light cone, cannot act, and monsters ignore the body. Control never lands on a downed member: if the active member falls while an ally still stands, control hands off to a living ally and play continues.
  * **Revive:** Once the room is safe (no living hostile in range and no damage dealt or taken for the idle window), an **adjacent living ally** channels a revive using a healing ability or a `canRevive` consumable. The member returns at **30% HP / 25% MP** with a 1s grace window. The channel is **interruptible** — reviver damage, reviver movement, or hostiles re-entering range breaks it.
  * **Auto-revive (LIV-51; LIV-41 plan rev 2):** The ally channel is the *fast, active* rescue; a **per-member auto-revive timer** is the *guaranteed fallback*, so recovery never depends on an ally physically reaching the body. A downed member carries a countdown that runs continuously, **including during combat**, and revives them in place when it elapses — **10s on the 1st down, 20s on the 2nd, 30s on the 3rd+** (cap 30s). The escalation counter is **per member**, persists across revives within a tower, and resets to 10s only on **exiting + re-entering a tower**. An auto-revive restores **>=25% HP / >=25% MP**, with no mana cost and no item — the escalating wait *is* the cost. A completed **ally revive cancels the pending auto-revive** for that member. A genuine floor transition revives every downed member at the same >=25% floor. A **simultaneous full-party down still wipes to the Temple** before any timer can fire (the timer only saves members while at least one stands). This rule **replaces the old 45s self-stabilize net**. The grace window (`graceSec`) applies after an auto-revive too.
  * **Countdown-ring presentation (LIV-51):** The auto-revive timer is drawn as a **countdown ring** on the downed body — a slate track (`#334155`) with a gold sweep (`#fde68a`, core `#fffbeb`) that starts at 12 o'clock and drains **clockwise from full to empty** as the timer elapses, with the empty frame coinciding with the revive. It updates **smoothly each frame** with a once-per-second `beatHz` alpha emphasis, and shows `ceil` seconds remaining below the body. The ring draws first (closest to the body) on its opaque track, so the **E1 call-for-help beacon** and the revive tether read *on top of* it. The party panel shows a **"down #N" pip** on the downed chip's name row (a 12px numeral badge: **gold `#fde68a` = 1st, amber `#fb923c` = 2nd, red `#ef4444` = 3rd+**) so a longer 2nd/3rd+ timer is legible. Tokens live in `ui.json.knockout.autoRevive`; the schedule lives in `party_ai.json.revive.autoRevive`. **Reduced motion** swaps the smooth drain + beat for a **static arc stepped once per second** plus the numeric seconds.
  * **Vocation Vigils (E3):** *Who* is standing changes the rescue, authored as a partial `revive` override per `party_ai.json` profile — no per-class code. **Paladin — Holy Prayer:** the standard channel restoring more HP (35%); the most reliable rescue. **Magician — Arcane Suture:** the fastest channel (1.4s) at the steepest mana price (40). **Archer — Field Salve:** quick (1.6s) but a low payoff (20% HP). **Fighter — Drag to Safety:** hauls the body 1 tile toward the reviver while channeling and takes 25% less damage (frontline rescue).
  * **Presentation (LIV-45 / LIV-49):** A downed body drops to a near-full **grayscale** version of its vocation sprite — each palette colour is mixed 92% toward its Rec.709 luminance, darkened 18%, and finished with a cool `#4b5563` wash — and is laid **90° "on their back"** about the tile centre, so the silhouette still reads as *this* vocation while a glance says "downed, not standing." It keeps its downed glyph + locator pip on the party panel, emits the **E1 "Call for Help" beacon** (a pulsing ring + a pip aimed at the nearest living ally), and projects **no light cone**. A live channel shows a tether + progress arc and an on-screen revive prompt; the beacon, tether, progress arc, and prompt draw *on top of* the rotated body and stay legible. Tokens live in `ui.json.knockout.visuals`; the beacon's on/off, color and pulse live in `party_ai.json.revive.callForHelp`.
  * **Swap feedback (LIV-49):** Control changes are never an instant cut. A KO handoff inserts a **200ms input-locked beat** with a distinct **KO/handoff sting** (`koHandoff`) before control transfers (the world keeps simulating; only the incoming actor's input is held), then the canvas **position and camera interpolate fluidly** (320ms position / 420ms camera, shared `cubic-bezier(0.4,0,0.2,1)`) to the destination member and the destination **flashes** — an additive `#fde68a` bloom easing out over 1000ms (`peakAlpha 0.7`) with a locator ring. Manual swaps (`cycleControlledMember`) play the lighter **control-swap cue** (`controlSwap`) and reuse the same position/camera/flash feedback. All values are tokens in `ui.json.knockout.swap`; **reduced motion** collapses the beat + animations to zero and dims the flash to a single frame.
  * **Party Wipe:** Only a **simultaneous full-party knockout** (every member down at once) ejects the party. The party revives at the **Temple of the Dawn**, and tower depth resets to that tower's **entry floor** on re-entry. **Keys, level, gear, backpack, and gold are kept.** A solo party (no living ally to revive) wipes **immediately** when its sole member falls.
* **Data-Driven Truth:** All balance stats, drop tables, room tiers, and costs are authored exclusively in `html/data/*.json`.

---

## 6. Enemy Role Taxonomy & Bestiary (LIV-4)

Opponents are authored as catalog data only. Every opponent below is a `html/data/monsters.json`
entry whose behavior is resolved entirely by the LIV-2 dispatch tables
(`entity-ai.js`: `aiType` → positioning, `attacks[].kind` → attack pattern,
`attacks[].onHit.status` → status effect). No opponent requires bespoke game-logic
branches; a new kit is a new catalog value plus an existing handler.

### 6.1 Role taxonomy and the response each role demands

| Role | Threat it poses | Player response it demands | Current roster |
| :--- | :--- | :--- | :--- |
| **Chaser** | Fast, relentless melee pressure. | Kite, body-block, or trade with a defensive cooldown. | `giant_rat`, `crypt_skeleton`, `mire_hound` |
| **Zoner / standoff** | Holds a ring and punishes straight-line approaches with ranged pressure. | Break line of sight, use cover, or commit to a gap-closer. | `shadow_cultist`, `rime_acolyte`, `brine_witch` |
| **Artillery** | Outranges the player and threatens a large telegraphed area. | Read the telegraph and leave the blast footprint; close the distance. | `sepulcher_mortar` |
| **Controller / debuffer** | Low damage, but applies stun/slow that enables other threats to land. | Prioritize the controller before the pack closes; dodge the telegraph. | `chime_wraith` |
| **Elite** | High HP/damage anchor with a multi-range kit. | Isolate, burst, or fight at the range where its second attack cannot gate on. | `elite_cultist`, `barrow_knight` |
| **Summoner** | Converts time into board pressure by adding bodies. | Race the summoner or clear adds at the spawn cap. | `bone_summoner`, `ossuary_priest` |
| **Boss** | Stat check plus a signature mechanic that reshapes the arena. | Learn the telegraph, manage adds, then commit to a damage window. | `abyssal_overlord`, `tidebound_king` |

The launch five (`giant_rat`, `crypt_skeleton`, `shadow_cultist`, `elite_cultist`,
`abyssal_overlord`) keep their frozen handlers and behaviour. The LIV-2 framework
demos (`cinder_acolyte`, `grave_charger`, `plague_bomber`, `bone_summoner`) and the
LIV-4 additions below all run through the catalog dispatch tables.

### 6.2 LIV-4 opponent specs

All values are base (pre-floor-scale) stats. `atk` = `damageMin`–`damageMax` of the
signature attack. Status is the `onHit` descriptor.

| Opponent (`key`) | Role | `aiType` | Attack (`kind`) | Status | HP | Atk | CD | Range | XP base/+floor |
| :--- | :--- | :--- | :--- | :--- | ---: | --- | ---: | --- | ---: |
| **Mire Hound** (`mire_hound`) | Chaser | `charger` | melee | slow 2.5s ×0.50 | 34 | 6–10 | 1.1s | 1 | 24 / +5 |
| **Rime Acolyte** (`rime_acolyte`) | Zoner | `ranged` | projectile | slow 3.0s ×0.45 | 42 | 7–11 | 2.2s | 6 | 52 / +11 |
| **Sepulcher Mortar** (`sepulcher_mortar`) | Artillery | `bomber` | aoe (1.1s telegraph, r2) | burn 3s @3 | 46 | 14–20 | 4.0s | 8 (min 3) | 66 / +13 |
| **Chime Wraith** (`chime_wraith`) | Controller | `bomber` | aoe (0.7s telegraph, r2) | stun 1.2s | 44 | 4–7 | 3.5s | 5 | 58 / +12 |
| **Barrow Knight** (`barrow_knight`) | Elite | `charger` | melee **+** aoe (0.6s, r2) | slow 2.0s ×0.50 | 92 | 15–22 / 8–12 | 1.8s / 5.0s | 1 / 2 | 78 / +14 |
| **Ossuary Priest** (`ossuary_priest`) | Summoner | `summoner` | summon **+** projectile | — | 52 | 6–10 | 6.0s / 2.4s | 7 / 6 | 60 / +12 |
| **Brine Witch** (`brine_witch`) | Zoner (attrition) | `ranged` | projectile | poison 6s @4 | 50 | 5–9 | 2.6s | 5 | 56 / +12 |
| **The Tidebound King** (`tidebound_king`) | Boss | `ranged` | aoe (0.7s, r2) **+** summon | slow 2.0s ×0.50 | 540 | 16–23 | 3.2s / 9.0s | 4 / 7 | 520 (boss) |

### 6.3 Balance rationale (per opponent)

* **Mire Hound — fast chaser, slow on hit.** Lowest HP of the expansion (34) so it dies
  fast, but `moveCadence 0.55` closes gaps other chasers cannot. The 50% slow for 2.5s
  is the point: it converts a positional mistake into a trapped archer/magician. Fighter
  and Paladin can simply trade; ranged vocations must pre-clear or use a defensive tool.
  *Lenses: enemy role taxonomy, balance levers (speed + a control status, not damage).*
* **Rime Acolyte — ranged zoner with slow.** Damage is deliberately modest (7–11); the
  threat is the 3s ×0.45 slow, which denies the "kite forever at range" answer. A slower
  bolt (`8` tiles/s vs the Cinder Acolyte's `9`) keeps the dodge window fair.
  *Lenses: readability (travelling projectile telegraphs itself), difficulty curve.*
* **Sepulcher Mortar — artillery.** Outranges player abilities at 8 tiles with `minRange 3`
  so it cannot point-blank, forcing repositioning. 1.1s telegraph + radius 2 is a
  one-tile-move dodge for an attentive player; the 14–20 damage + burn is the cost of
  standing still. Low HP (46) and a slow 4.0s cadence give a clear "rush it" counterplay.
  *Lenses: game feel (anticipation via telegraph), MDA (tension from the wind-up).*
* **Chime Wraith — controller.** Near-zero damage (4–7) on purpose: its value is the
  1.2s stun that lets a chaser or artillery land a free hit. The 0.7s telegraph rewards a
  fast read and prioritization. *Lenses: enemy role taxonomy, economy of threat.*
* **Barrow Knight — elite multi-attack.** Two attack entries in catalog order: `graveblade`
  gates at range 1, `earth_shudder` gates at range 2, so the knight melees when adjacent and
  slams a slowing shockwave when the player tries to kite at two tiles. 92 HP + 5 defence
  make it an anchor, not a swarm member. *Lenses: balance levers, mastery vs frustration
  (the slam is always telegraphed).*
* **Ossuary Priest — summoner with a fallback.** `raise_bones` (cap 2 `crypt_skeleton`) is
  listed first, so while it is off cooldown the priest summons; its 6s summon cooldown also
  suppresses `bone_shard`, so the projectile reads as an anti-stall fallback once the add
  cap is reached. This is intentional pacing, not a bug: capped adds → shard chip damage.
  *Lenses: MDA, threat-budget control via `maxActive`.*
* **Brine Witch — attrition zoner.** Low upfront damage (5–9) but a 6s poison at 4 dps =
  24 unmitigated total; the longest, strongest DoT in the roster. It taxes healing and
  rewards killing it first. Distinct from the Plague Bomber (instant AoE, 4s/3 dps).
  *Lenses: economy/reward pacing, distinct player response.*
* **The Tidebound King — second-tower boss.** 540 HP (below the Spire Warden's 600) with an
  AoE slow to deny permanent kiting and a capped `mire_hound` summon wave that ties it to
  its tower's bestiary. 0.7s telegraph on the slam keeps the fight readable.
  *Lenses: core loop/fantasy (climactic duel), replayability (add-wave management).*

### 6.4 Presentation

* **Sprites reuse existing actors** via `spriteId` (no bespoke pixel art required to ship;
  the renderer resolves `spriteId` before `type`). New opponents map to
  `giant_rat`, `crypt_skeleton`, `shadow_cultist`, `elite_cultist`, or `abyssal_overlord`.
* **Silhouette + color readability:** new caster/zoner opponents share the hooded cultist
  silhouette, so their color language carries the read — frost `#7dd3fc`, poison `#65a30d`,
  bell-purple `#a855f7`, mortar-orange `#fb923c`, tidal `#38bdf8`. Boss uses the 48×48
  `abyssal_overlord` rig. This preserves the ≥3:1 rim-contrast bar against the dark floors.
* **OpenMoji `svgCode`** is drawn only from assets already committed under
  `html/assets/openmoji/` (`1F407`, `1F52E`, `1F32A`, `1F539`, `2694`, `1F4D6`, `1F9E5`,
  `1F451`), so `packaging.test.mjs` needs no new assets. Bespoke OpenMoji/monster art is a
  follow-up for the Tech Lead / CEO, not a launch blocker.

### 6.5 Design decisions & open handoffs

* **Enemy kits are authored inline in `monsters.json.attacks[]`, not `abilities.json`.**
  `abilities.json` is the player-vocation catalog consumed by `config.js` (fixed keys,
  `vocation`-scoped), and enemy specs are the LIV-2 inline contract the engine already
  reads. Keeping a single source of truth for each opponent's kit avoids dead data. If the
  board wants a shared, referenceable enemy-ability library (`attacks[].abilityId`), that
  is a schema + resolver change and should be a Tech Lead task.
* **Floor damage scaling (resolved, LIV-6):** `floor-generator.js` stamps each
  generated monster with `damageScale` (the floor `statScale.atk`, times
  `keyHolderModifier.atk` for key holders), and the LIV-2 attack handlers multiply
  their rolled `attacks[].damageMin/Max` by it. Catalog damage stays floor-agnostic
  base data, mirroring `baseHp`/`statScale.hp`; floor 1 remains scale 1.0. Summons
  inherit their summoner's `damageScale`.
* **Tower roster wiring is LIV-5 (done).** `tower_levels.json` now assigns this
  bestiary per tower and per floor via `monsterGroups.pool` / `keyHolderType`
  (see §7); the launch five remain on the Spire of Light.
* **Boss wiring handoff (done).** `sunken_catacombs` now points `tower.boss.type`
  at `tidebound_king`; the two new towers carry their own bosses
  (`forgemaster_kol`, `frostbound_choirmaster`). Four distinct bosses total.

---

## 7. Themed Tower Lineup (LIV-5)

The single 5-level tower is now a set of themed towers. Every field a run needs
— levels, gates, key-holder tables, monster pools, boss, theme map, stat curve,
prop policy, and starter cache — resolves from
[`html/data/tower_levels.json`](../html/data/tower_levels.json) through
`listTowerDefinitions()` and `generateFloor(level, seed, towerId)`. There is no
per-tower `if` in game logic; a tower is catalog data plus existing handlers.

Four towers ship. **Count reconciliation:** the issue asked for "3 new themed
towers (4 total)" from the original single spire. [LIV-3] generalized the schema
and added one (the Sunken Catacombs) as the multi-tower proof; LIV-5 completes
the set by giving the Catacombs its own roster + boss and adding the Emberforge
and Rime Aerie — three new identities beyond the original spire, four total.

### 7.1 Tower identity matrix

| Tower (`id`) | Floors | Fantasy | Signature pressure → player response | Roster (role) | Boss | Palette family |
| :--- | ---: | :--- | :--- | :--- | :--- | :--- |
| **The Spire of Light** (`spire_of_light`) | 5 | Holy ascent; the baseline. | Balanced ramp; teaches keys, gates, kiting, and AoE reads. | Giant Rat, Bone Sentry (chaser); Shadow Cultist (zoner); Elite Cultist | **The Spire Warden** (`abyssal_overlord`) | Amber → gold (levels 1–5) |
| **The Sunken Catacombs** (`sunken_catacombs`) | 4 | Flooded vaults, a drowned court. | Attrition: poison/slow chip while summoned adds hold doors → kill the zoner/summoner first. | Mire Hound (fast chaser); Brine Witch (poison zoner); Ossuary Priest (summoner); Barrow Knight (elite) | **The Tidebound King** (`tidebound_king`) | Cool/amber remap (levels 3→1→4→2) |
| **The Emberforge** (`emberforge`) | 5 | A forgeshaft that never cooled. | Artillery tease: long telegraphs + burn warden off standing still → keep moving, rush the mortar. | Cinder Acolyte (fire zoner); Sepulcher Mortar (fire artillery); Grave Charger (charger); Barrow Knight (elite) | **The Forgemaster** (`forgemaster_kol`) | Ember brown → white-hot (`cinder_gate`…`anvil_crown`) |
| **The Rime Aerie** (`rime_aerie`) | 3 | A frozen, bell-haunted belfry. | Control: slow and stun punish kiting; highest intensity per floor → prioritize the controller, then burst. | Bone Sentry (chaser); Rime Acolyte (frost zoner); Chime Wraith (controller); Elite Cultist (elite) | **The Frostbound Choirmaster** (`frostbound_choirmaster`) | Slate → violet frost (`frost_threshold`…`choir_loft`) |

Each tower answers a different question at the door: Spire asks "can you learn
the rules?", Catacombs asks "can you out-sustain chip?", Emberforge asks "can
you keep your feet moving?", Rime Aerie asks "can you kill the enabler first?".

### 7.2 Difficulty curves (`monsterGroups.statScale`, hp/atk per floor)

| Tower | F1 | F2 | F3 | F4 | F5 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Spire of Light | 1.00 / 1.00 | 1.35 / 1.25 | 1.80 / 1.55 | 2.40 / 1.90 | 3.20 / 2.40 |
| Sunken Catacombs | 1.00 / 1.00 | 1.45 / 1.30 | 2.00 / 1.65 | 2.70 / 2.15 | — |
| Emberforge | 1.00 / 1.00 | 1.30 / 1.20 | 1.75 / 1.50 | 2.35 / 1.90 | 3.05 / 2.35 |
| Rime Aerie | 1.25 / 1.15 | 2.05 / 1.70 | 3.00 / 2.30 | — | — |

* **Rime starts hot on purpose.** A three-floor tower that eases in reads as a
  corridor. Its F1 scale (1.25) already exceeds every other tower's F2, so the
  short length is a *spike*, not a truncated ramp. *Lenses: difficulty curve &
  flow, mastery vs. frustration.*
* **Catacombs outpaces the Spire per floor** (2.70 vs. 2.40 hp at the same
  depth) to offset a low-burst attrition roster — without the extra padding the
  poison/slow kit would out-heal the player's clear speed. *Lenses: balance
  levers (one curve, not a roster rewrite), economy of threat.*
* **Emberforge sits just under the Spire's hp ceiling** because its artillery +
  burn already tax positioning; the threat budget is spent on arena control, not
  raw stats. *Lenses: MDA (tension from the wind-up), enemy role taxonomy.*
* Key holders carry `keyHolderModifier` (×1.5 hp, ×1.15 atk) in every tower, so
  a key fight is always a step above its floor even when the pools are light.

### 7.3 Bosses

| Boss | Tower | HP | Signature (telegraph) | Guards | Read |
| :--- | :--- | ---: | :--- | :--- | :--- |
| The Spire Warden (`abyssal_overlord`) | Spire | 600 | Chase bruiser | 2× Elite Cultist | Baseline stat check |
| The Tidebound King (`tidebound_king`) | Catacombs | 540 | `tidal_slam` AoE slow (0.7s) + `drown_the_ranks` Mire Hound summon (cap 2) | 2× Barrow Knight | Add-wave management; slow denies permanent kiting |
| The Forgemaster (`forgemaster_kol`) | Emberforge | 560 | `forge_hammer` AoE burn (0.75s) + `slag_lob` projectile | 2× Barrow Knight | Reposition out of the footprint, then a damage window |
| The Frostbound Choirmaster (`frostbound_choirmaster`) | Rime Aerie | 470 | `toll_of_frost` AoE slow (0.65s) + `rime_lance` projectile | 2× Elite Cultist | Lowest HP, hardest control; punish greedy re-approaches |

Every boss telegraph is ≥0.65s and pair-matched to its tower's signature debuff
(burn for Emberforge, slow for Rime/Catacombs), so the final duel reads as the
tower's thesis rather than a stat wall. Bosses reuse the 48×48
`abyssal_overlord` rig via `spriteId`; no bespoke pixel art is required to ship.
*Lenses: core loop & fantasy (climactic duel), readability & legibility,
replayability (add-wave / reposition management).*

### 7.4 Theming contract

* **Palettes (`tile_themes.json`).** Eight named tower palettes are authored —
  five Emberforge (`cinder_gate`…`anvil_crown`) and three Rime Aerie
  (`frost_threshold`…`choir_loft`) — each with a distinct `wall.fill`, full
  wall/floor/stairs/door/features blocks, and decor `props`. The run floor is
  selected by the tower's `theme.levelTheme` map, not by a floor-number
  heuristic. *Lenses: theme coherence, readability (contrast).*
* **Biomes (`biomes.json`).** Eight tower-specific tier IDs supply each level's
  name and light colour. They are resolved by `tierId`; the launch five keep
  their `minLevel`/`maxLevel` so the legacy floor scan is unchanged.
* **Contrast bar (`docs/art/art-direction.md`).** Every new floor fill keeps
  luminance ≤ 0.02 to hold the ≥ 3:1 actor rim ratio; palette ramps stay within
  the 16-bit SNES bar.
* **Props & actors.** New towers reuse the vetted prop set and the existing
  actor rigs (all new opponents declare `spriteId`), so no new atlas assets ship
  with this content. Boss emoji use committed OpenMoji codes (`1F528`, `2728`).

### 7.5 Reward pacing

* **Starter caches are tuned to tower pressure, not a single global table.**
  Emberforge hands extra arrows early (F1) because its fire casters punish
  melee closes; Rime hands two potions on its final floor to fund the compressed
  spike; Catacombs stays potion-forward across all four floors.
* **Bosses award a guaranteed greater-potion pair** (xFrostbound,
  xForgemaster, xTidebound, xSpire) so a failed boss attempt is never a net
  resource loss; `economy.json` `monsterGold` carries per-boss gold in the same
  band as the Spire Warden. *Lenses: economy & reward pacing, Kano model
  (must-have sustain vs. delighter variety).*

### 7.6 Lenses cited (traceability)

Core loop & fantasy (§7.1 rosters), enemy role taxonomy (§7.1, §7.3), game
feel / readable telegraphs (§7.3), difficulty curve & flow (§7.2), balance
levers (§7.2), economy & reward pacing (§7.5), theme coherence (§7.4),
replayability (§7.1 four distinct demands), MDA (§7.2). No dark patterns or
engagement mechanics are introduced.

### 7.7 Data contract & verification

* Every tower resolves through `listTowerDefinitions()` /
  `generateFloor(level, seed, towerId)`; no bespoke per-tower game logic.
* `html/tests/multi-tower.test.mjs` validates every authored tower generically
  (catalog-only load, soft-lock-free levels, deterministic floor + boss).
* Two content-count assertions were made expansion-aware alongside the new
  palettes/tiers (`data-catalogs.test.mjs` biomes, `sprite-assets.test.mjs`
  tile-theme levels) — see the Tech Lead handoff for review. **T0: 557/557 green.**

---

## 8. Party Campaign: Auto-AI, Tower Order & Balance (LIV-9 / WS5)

Content section for the four-member party campaign. The Game Designer owns the
catalog values below; the schemas are locked by the Tech Lead in
[`docs/engineering/party-data-model.md`](../engineering/party-data-model.md).
The active member is player-controlled exactly as today; every other member is
driven by the profile in `party_ai.json` and resolves through the existing
catalog dispatch tables. No vocation name is hardcoded in engine logic.

### 8.1 Party auto-AI profiles (`party_ai.json`, schema v2)

`PARTY_AI_CATALOG.profiles[vocation]` is read for every non-active member.
`default` is the safe fallback for any vocation without a profile (and for
hand-built units). Schema v2 (FIX-11 / LIV-26) adds the nested `movement`,
`support` and `potion` blocks per profile plus a party-wide top-level
`autoFateGrant` policy; every v2 key is optional and resolves over `default`, so
a v1 profile still runs unchanged.

Field semantics (the contract the engine implements against):

| Field | Meaning |
| :--- | :--- |
| `preferredAbilities` | Ordered combat ability ids; the first usable one (off cooldown, in range, resources available) wins. |
| `followDistance` | Tiles the member trails the active member while no target is acquired. |
| `engageRadius` | Distance (tiles, from the member) at which it acquires the nearest hostile and closes to fight. |
| `castRange` | Preferred combat distance; the member closes to / retreats to this while engaged. |
| `retreatHpPct` | HP fraction (0–1) below which the member disengages and returns to formation. |
| `retargetSec` | Minimum seconds the member commits to a target before switching. |
| `healAlliesWhenHurt` | Legacy v1 support flag, kept `true` on the Paladin for back-compat; `support.enabled` supersedes it. |

**v2 movement naturalness (FIX-8 / [LIV-23](/LIV/issues/LIV-23))**

| Field | Meaning |
| :--- | :--- |
| `movement.cadenceSec` | Minimum seconds between this member's move steps (lower = more responsive). |
| `movement.staggerSec` | Initial phase offset before its first step so allies do not step in lockstep. |
| `movement.jitterSec` | Random `0..jitterSec` added to each cadence interval for organic variance. |
| `movement.wanderChance` | Probability rolled once per `wanderCooldownSec` window that an idle, in-formation member takes a short wander step. |
| `movement.wanderRadius` | Max tiles a wander step may stray from the active member. |
| `movement.wanderCooldownSec` | Minimum seconds between wander steps. |

**v2 support casting (FIX-10 / [LIV-25](/LIV/issues/LIV-25))**

| Field | Meaning |
| :--- | :--- |
| `support.enabled` | Master switch; non-support vocations are `false`. |
| `support.healPct` | Cast a heal when the most-injured living ally is at/below this HP fraction. |
| `support.shieldPct` | Shield the most-injured living ally at/below this fraction (while mana allows). |
| `support.minManaFrac` | Never begin a support cast below this mana fraction. |
| `support.cooldownSec` | Minimum seconds between this member's support casts (anti-spam). |
| `support.order` | Support kinds evaluated in order (`["heal","shield"]`). |
| `support.abilities` | Allowed support ability ids for this vocation. |

**v2 auto-potion (FIX-9 / [LIV-24](/LIV/issues/LIV-24))**

| Field | Meaning |
| :--- | :--- |
| `potion.enabled` | Master switch. |
| `potion.hpPct` | Drink `itemId` from the shared party backpack at/below this HP fraction. Pinned to `0.50` to match the Board rule. |
| `potion.manaPct` | Else, drink `manaItemId` at/below this mana fraction (HP is checked first). |
| `potion.cooldownSec` | Minimum seconds between this member's auto-drinks. |
| `potion.itemId` | HP consumable catalog id (`health_potion`). |
| `potion.manaItemId` | Mana consumable catalog id (`mana_potion`). |

**v2 deterministic auto-Fate-Grant (FIX-5 / [LIV-20](/LIV/issues/LIV-20))** — read once at the catalog top level, not per profile:

| Field | Meaning |
| :--- | :--- |
| `autoFateGrant.picks` | Cards the auto ally drafts per level-up (2, matching the manual draft). |
| `autoFateGrant.priority` | Ordered rule tokens (highest first) used as tie-breakers: `upgrade`, `main_hand`, `off_hand`, `affinity`, `rarity`, `offer_order`. An unknown token is skipped; an empty list falls back to offer order. |

Authored profiles (v1 values unchanged):

| Vocation | Preferred abilities | Follow | Engage | Cast | Retreat | Retarget | Heals allies |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| **Magician** | `magician_beam` → `magician_spark` | 3 | 6 | 5 | 0.35 | 1.5s | no |
| **Archer** | `archer_power_shot` → `archer_bow_shot` | 3 | 7 | 6 | 0.30 | 1.2s | no |
| **Fighter** | `fighter_cleave` → `fighter_slash` | 1 | 3 | 1 | 0.20 | 1.0s | no |
| **Paladin** | `paladin_heal` → `paladin_holy_strike` | 1 | 3 | 1 | 0.25 | 1.2s | yes |

v2 tuning:

| Vocation | Move cadence / stagger / jitter | Wander % / radius / cd | Support (enabled, heal/shield %, min MP) | Potion (HP%/MP%/cd) | Auto Fate policy |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Magician** | 0.22 / 0.12 / 0.07 | 40% / 2 / 3.5s | no | 50/50/8s | `picks 2` |
| **Archer** | 0.15 / 0.08 / 0.06 | 35% / 2 / 3.0s | no | 50/50/8s | `picks 2` |
| **Fighter** | 0.16 / 0.00 / 0.05 | 15% / 1 / 4.0s | no | 50/50/8s | `picks 2` |
| **Paladin** | 0.20 / 0.04 / 0.06 | 15% / 1 / 4.0s | **yes**, 65/55, 20% | 50/50/8s | `picks 2` |
| **default** | 0.20 / 0.00 / 0.06 | 20% / 2 / 4.0s | no | 50/50/8s | — |

`autoFateGrant` (party-wide): `picks: 2`, `priority: upgrade → main_hand → off_hand → affinity → rarity → offer_order`.

* **Two postures, one line.** Fighter/Paladin (`followDistance 1`, `castRange 1`)
  hold the line; Archer/Magician (`followDistance 3`) fight from behind. A player
  reading the party on screen can tell each member's job from where it stands.
  *Lenses: readability & legibility, enemy role taxonomy (mirrored for allies).*
* **Retreat thresholds track fragility, not role.** Magician (60 HP) disengages
  at 35%, Archer (90 HP) at 30%, Paladin (120 HP) at 25%, Fighter (140 HP) at
  20%. The squishiest member leaves first so an artillery telegraph cannot
  one-shot it. *Lenses: balance levers (one lever per problem), game feel.*
* **Ability order encodes intent, not just power.** The Archer opens with the
  4s-cooldown Power Shot before the free Bow Shot so the auto-AI does not drain
  the party's arrow stock; the Magician opens with Beam (burst) and fills with
  Spark. *Lenses: economy & reward pacing, MDA.*
* **Paladin is the only support.** With `support.enabled: true` and
  `paladin_heal.healRadius: 6` / `targetsAllies: true`, it heals the most-injured
  ally at ≤65%, then bulwarks the lowest ally with the Aegis shield at ≤55% while
  mana stays above 20%, else fights with Holy Strike. This makes recruitment
  order matter: an early Paladin is a sustain delighter. *Lenses: Kano model,
  replayability.*
* **`preferredAbilities` only lists combat-castable abilities.** The Magician's
  `magician_light` vision buff is intentionally excluded: auto-casting a long
  buff needs buff-cast handling in WS4 and is not worth a one-off code path.
  *Lenses: reach for what exists first; no bespoke branch without a contract.*

#### 8.1.1 v2 movement: break the lockstep (FIX-8)

Round-1 allies moved on the same 10 Hz tick in a single file, which read as a
"conga line" rather than companions. Three small levers fix the feel without
touching the decision logic:

* **Per-member cadence + stagger.** `cadenceSec` (0.15–0.22) makes each member
  step at its own rate, and a deterministic `staggerSec` offsets the first step
  so no two members share a tick. Front to back, the order is Fighter → Paladin →
  Archer → Magician, which preserves the formation read.
  *Lenses: game feel / juice, readability.*
* **Jitter.** `jitterSec` (0.05–0.07) adds bounded variance to each interval so
  the party never re-syncs into a rhythm. *Lenses: game feel.*
* **Occasional wander.** Once per `wanderCooldownSec`, an idle, in-formation
  member rolls `wanderChance` to take a short step inside `wanderRadius` of the
  active member. The backline wanders more (Archer 35%, Magician 40%) because it
  repositions for line of sight; the frontline barely moves (15%, radius 1) so
  the line reads as a wall. *Lenses: MDA (liveliness), readability (front stays
  put), balance levers (one radius bounds every wander).*
* **Guard rails.** Cadence never slows a genuine engage/retreat step; the
  cadence gate only applies to routine follow/wander steps. `wanderRadius`
  bounds drift so the party never strands a member. *Lenses: mastery vs.
  frustration, readability.*

#### 8.1.2 v2 support: shields and heals, no spam (FIX-10)

Support is a **separate budgeted cast**, evaluated before combat casts:

1. If `support.enabled` and mana fraction ≥ `support.minManaFrac` and the
   member's support cooldown is ready: evaluate `support.order`.
2. `heal` — if the most-injured living ally is at/below `support.healPct` and a
   heal in `support.abilities` is ready, heal that ally.
3. `shield` — else if the most-injured living ally is at/below
   `support.shieldPct` and a shield in `support.abilities` is ready, shield that
   ally.
4. Otherwise fall through to the normal `preferredAbilities` combat cast.

Anti-spam is two-layer: the `support.cooldownSec` (4s) global gate plus each
ability's own cooldown (`paladin_heal` 6s). `minManaFrac` keeps the Paladin from
healing itself out of offensive mana. Only the Paladin profile is enabled, which
keeps the party's single point of support legible. *Lenses: balance levers
(cooldowns, not lower healing), game feel (readable support beats), Kano
(recruit-order value).*

#### 8.1.3 v2 auto-potion: shared-backpack sustain (FIX-9)

When an auto ally's HP fraction is at/below `potion.hpPct` (`0.50`) and its
`potion.cooldownSec` (`8s`) is ready, it consumes `potion.itemId`
(`health_potion`) from the **shared party backpack**; when no HP drink is due and
mana is at/below `potion.manaPct` (`0.50`), it drinks `potion.manaItemId`
(`mana_potion`) instead. HP is checked first so a low-HP caster does not burn a
mana drink on a losing trade. `hpPct` is pinned to `0.50` to match the Board rule
exactly; the 8s per-ally cooldown plus each member's own resource gate prevents a
four-member potion dump in one tick. Both potions carry `effect.scope: 'party'`
in `items.json`, so one drink restores every eligible member (the Board's
party-wide item 7). *Lenses: economy & reward pacing, balance levers, player
wellbeing (no forced resource bleed).*

#### 8.1.4 v2 deterministic auto-Fate-Grant (FIX-5)

An auto ally that levels up banks the party's shared XP and drafts **2 cards**
without pausing the run. The *policy* is deterministic — no player input, no
modal, and the same offer always yields the same picks:

1. **Offer.** `FateGrantSystem.generateDraftOffer(member, level)` produces the
   ally's 5-card offer from its vocation pool (unchanged draft roll). A future
   hardening step can seed this per `memberId + level` for cross-run
   reproducibility; it is not required for the Board item.
2. **Pick.** `FateGrantSystem.selectAutoDraft(offer, member, policy)` ranks the
   offer by `autoFateGrant.priority` tokens — `upgrade` → `main_hand` →
   `off_hand` → `affinity` → `rarity` → `offer_order` — and takes the top
   `autoFateGrant.picks` (2). `offer_order` (then offer index) is the stable
   final tie-break, so ties never fall back to randomness.

Rationale: allies silently gaining power should follow a *plan* — rank up gear,
then secure a main-hand weapon, then an off-hand, then vocation-fit rarity —
rather than a lucky roll. The manual active member's interactive draft is
unchanged. *Lenses: MDA (growing power is felt, not random), balance levers,
replayability (build diversity).*

#### 8.1.5 v2 copy (`ui.json` → `party`)

| Key | Copy | Shown |
| :--- | :--- | :--- |
| `allyLevelUpCue` | `{member} reached Level {level}` | Subtle, non-blocking auto-ally level-up |
| `allyAutoGrantCue` | `{member} drafted {cards}.` | Auto-Fate-Grant result |
| `allyPotionCue` | `{member} drinks a {item}.` | Auto-potion (optional, low priority) |
| `allySupportCue` | `{member} casts {ability}.` | Support cast (optional, low priority) |
| `recruitJoinCue` | `{member} joins the party at Level 1.` | Recruit confirmation |

`{member}`, `{item}`, `{ability}` substitute display names, never catalog ids. The
level-up cue is the only one the Board asked for; the rest are optional and must
stay subtle and non-blocking. *Lenses: readability, no dark patterns.*

#### 8.1.6 Tech Lead implementation contract (FIX-8/9/10/5)

The engine resolves each v2 block field-wise over `default` and the code-owned
baseline (`resolveMovement` / `resolveSupport` / `resolvePotion`), so a partial
catalog entry can never drop a baseline. Per-member transient state the engine
owns (never the catalog):

1. `_stepTimer` — armed to `movement.cadenceSec + rng()*movement.jitterSec` after
   every step, so routine follow/wander steps are paced and never lockstep.
2. `_followDelayTimer` — reaction delay sampled with `movement` jitter when the
   ally settles back into formation, so allies do not all bolt on one tick.
3. `_wanderCooldown` — gates wandering; reset to `movement.wanderCooldownSec`.
4. `_supportTimer` — gates support casts; reset to `support.cooldownSec`; a
   support cast additionally requires `support.enabled`, mana fraction above
   `support.minManaFrac`, and a valid target at/below the kind's threshold.
5. `_potionTimer` — gates auto-drinks; reset to `potion.cooldownSec`.

Dispatch seams (all existing handlers, no bespoke branches):

* **Shield support** uses the new `abilities.json` → `holy_shield` entry
  (`type: "shield"`, `actionKey: "force_shield"`, `executeForceShield`) routed
  through `CombatSystem.selectShieldTarget`; the Paladin's `support.abilities`
  lists `["paladin_heal", "holy_shield"]` and `support.order` renders the kind
  ranking. Heals reuse `CombatSystem.selectHealTarget` + `executeHealingPrayer`.
* **Auto-potion** routes through `InventorySystem.consumeItem` against the
  shared party backpack, then applies the `restore` effect to the drinking
  member (and, per the Board's party-wide rule, to every eligible member in
  range — see [LIV-24](/LIV/issues/LIV-24)).
* **Auto-Fate-Grant** reuses `FateGrantSystem.generateDraftOffer` +
  `FateGrantSystem.selectAutoDraft(offer, member, resolveAutoFateGrantPolicy())`
  + `FateGrantSystem.applyDraftedCards` (see `party-progression.js`).

Acceptance (T0, content-shaped):

* `profileForVocation` resolves `movement`/`support`/`potion` over `default` for
  every vocation; `support.enabled` is true **only** for Paladin;
  `potion.hpPct` is exactly `0.50`; Paladin `support.abilities` includes both
  `paladin_heal` and `holy_shield`.
* `resolveAutoFateGrantPolicy()` returns `picks: 2` and the authored
  `priority`; `selectAutoDraft` is stable for a fixed offer (no random tie-break).
* No v2 value changes the manual active member's behaviour.

#### 8.1.7 v3 looting & protector aggression (LIV-33)

Two small v3 blocks make the party feel like a party: allies help vacuum the
floor, and front-liners step in when a companion is hit.

**v3 ally ground-item search (`itemSearch`)**

| Field | Meaning |
| :--- | :--- |
| `itemSearch.enabled` | Out-of-combat looting master switch. |
| `itemSearch.radius` | Search leash in tiles (0 disables scanning). |

When an auto ally has no engaged target it scans a bounded `radius`-tile window
for the nearest walkable ground item with line of sight and paths it, feeding the
existing walk-over pickup into the shared party backpack. Combat, retreat and
support decisions always resolve first, so an ally never loots through a fight;
the tile window (not a whole-map scan) keeps the hot path bounded. Front-liners
scan tighter (Fighter/Paladin 4) than the backline (Archer 5, Magician 6) so the
front does not chase loot out of the line. *Lenses: game feel (party competence),
economy & reward pacing (loot actually reaches the stash), balance levers (one
radius bounds it).*

**v3 protector/retaliate targeting (`protect`)**

| Field | Meaning |
| :--- | :--- |
| `protect.enabled` | Engage the hostile attacking a party member before the nearest hostile. |
| `protect.radius` | Max tiles the member leaves formation to reach that attacker. |

Only **Fighter** and **Paladin** enable `protect`: when a hostile targets or
reaches a companion, they seek *that* attacker instead of hugging the mage,
bounded by `protect.radius` (8) and the normal `retargetSec`/leash rules so they
do not thrash. Archer/Magician keep `protect.enabled: false` and hold their
`followDistance`/`support` posture, so the two-posture line still reads from
where each member stands. *Lenses: readability (front line protects), MDA
(protection is felt), balance levers (radius + retarget, not new stats).*

Catalog summary (beyond the v2 columns): all four vocations loot
(`itemSearch.enabled: true`); only Fighter/Paladin protect.

### 8.2 Auto-mode balance: `campaign.partyScale` (`tower_levels.json`)

Allies add damage and bodies, so each tower's monster stats scale with the live
party size on top of the tower's own `monsterGroups.statScale`:

| Party size | `hp` | `atk` |
| ---: | ---: | ---: |
| 1 | 1.00 | 1.00 |
| 2 | 1.25 | 1.08 |
| 3 | 1.45 | 1.14 |
| 4 | 1.60 | 1.20 |

* **Sub-linear HP, gentle ATK.** Auto allies are less efficient than a skilled
  hand on the controls, so effective party power is nearer `1 + 0.35·(n−1)` than
  `n`. HP rises to match sustained damage (+25%/+20%/+15%); ATK rises only
  +20% at a full party so four bodies are not deleted by one AoE.
  *Lenses: balance levers, difficulty curve & flow.*
* **Applies to the whole floor, boss included.** `partyScale` multiplies the
  regular and key-holder stats, the boss (`hp`/`attack`) and its guards, so the
  climactic duel stays the tower's thesis rather than a speed bump for a full
  party. *Lenses: core loop & fantasy, MDA.*
* **Party size 1 is identity.** A solo legacy save sees exactly the pre-sprint
  numbers, so the migration path is balance-neutral. *Lenses: replayability,
  save compatibility.*

**Tech Lead implementation contract (floor-generator):**

1. Read `TOWER_CATALOG.campaign.partyScale` (clamp `partySize` to 1–4; unknown
   sizes fall back to the largest authored entry).
2. Multiply the resolved per-floor `statScale.hp` / `statScale.atk` by the
   party-size factor before `buildMonster`, the boss push, and the guard push
   (existing lines around `floor-generator.js:929`, `:1000`, `:1021`, `:1031`).
3. Thread the live party size in: extend `generateFloor(floorNumber, seed,
   towerId, partySize = 1)`; update the `game-worker` call sites
   (`:146`, `:256`, `:307`, `:530`, `:598`, `:632`) to pass the active party size.
4. Include party size in any floor cache identity so a freshly recruited member
   does not reuse a pre-recruit floor.
5. Acceptance: same seed + tower + floor + party size is byte-identical; party
   size 1 output is unchanged; party size 4 monsters have `hp`/`attack` scaled by
   exactly 1.60/1.20 on top of the tower curve.

### 8.3 Tower order & unlocks (`tower_levels.json`)

Linear campaign chain, keyed by `order` and gated by `unlockRequires`:

| Order | Tower | Unlocks when |
| ---: | :--- | :--- |
| 1 | The Spire of Light (`spire_of_light`) | Campaign start (always unlocked) |
| 2 | The Sunken Catacombs (`sunken_catacombs`) | `spire_of_light` complete |
| 3 | The Emberforge (`emberforge`) | `sunken_catacombs` complete |
| 4 | The Rime Aerie (`rime_aerie`) | `emberforge` complete |

* The order is the novice-to-expert teaching sequence: Spire teaches the rules,
  Catacombs tests sustain, Emberforge tests movement, Rime tests target
  prioritization (§7.1). *Lenses: difficulty curve & flow, theme coherence.*
* The chain is strictly linear by design (WS1's T0 test locks "each tower
  requires the previous"); branching unlocks are a deliberate non-goal for the
  campaign's first pass. *Lenses: clarity, scope discipline.*
* `firstTowerId()` is the always-unlocked entry; `towersUnlockedBy(id)` drives
  the unlock event on completion. Recruiting the new vocation and unlocking the
  next tower happen on the same completion (§8.4). *Lenses: core loop.*

### 8.4 Campaign copy (`ui.json` → `campaign`)

| Key | Copy | Shown |
| :--- | :--- | :--- |
| `towerCompleteTitle` | `Tower Complete` | Final-floor clear, before recruit |
| `towerCompleteBody` | `The {tower} has fallen. A new companion will join your party.` | Tower Complete modal |
| `recruitTitle` | `Recruit a Companion` | Recruit modal |
| `recruitPrompt` | `Choose the vocation that joins your party.` | Recruit modal |
| `recruitConfirmLabel` | `Recruit` | Recruit confirm button |
| `ultimateVictoryTitle` | `ULTIMATE VICTORY` | Only after all four towers |
| `ultimateVictoryBody` | `Every tower has fallen. Lokarta comes into the light.` | Terminal campaign beat |
| `towerUnlockedLabel` | `Unlocked` | Tower picker |
| `towerLockedLabel` | `Locked` | Tower picker |
| `towerLockedHint` | `Complete {required} to unlock.` | Locked tower tooltip |
| `towerContinueLabel` | `Continue` | Post-recruit flow |
| `towerReturnToTownLabel` | `Return to Havenreach` | Post-recruit flow |

* **Placeholders are display names, not ids.** `{tower}` and `{required}` are
  substituted with the tower's `name` (e.g. "The Spire of Light"), never its
  catalog id. *Lenses: readability.*
* **The ending is a thematic button.** "Lokarta comes into the light" pays off
  the game's title and the vision-control fantasy instead of a generic "you
  win". *Lenses: core loop & fantasy, Kano delighter.*
* **No dark patterns.** No streak/login/energy copy, no loss-framed prompts.

### 8.5 Handoffs & verification

* **Tech Lead (WS4 / LIV-13):** consume `PARTY_AI_CATALOG` with the §8.1
  semantics; gate heals on `healAlliesWhenHurt`; have an out-of-ammo archer fall
  back rather than stall. Acceptance: an auto party follows at
  `followDistance`, engages within `engageRadius`, retreats below
  `retreatHpPct`, and retargets no faster than `retargetSec`.
* **Tech Lead (floor-generator):** the §8.2 `partyScale` contract above.
* **Tech Lead (WS6 / LIV-14):** T0 assertions for the content — every vocation
  has a profile; `preferredAbilities` resolve; profiles are pairwise distinct;
  `partyScale` is monotonic, clamped 1–4, and identity at 1; tower order is a
  gapless 1..N chain; campaign copy covers every key. Verified locally against
  the current catalogs (`liv9-party-model`, `multi-tower`, `data-catalogs`,
  `tower-progression` suites green at authoring time).
* **No new monsters, abilities, towers, or bespoke code paths** are introduced by
  this section. It is content plus one catalog field (`partyScale`) with an
  existing-handler integration.

## 9. Equipment Rank Curve, ranks 6–20 (FIX-13 / FIX-15)

**Issue:** [LIV-30](/LIV/issues/LIV-30) · **Related:** [LIV-28](/LIV/issues/LIV-28) ·
**Owner:** Game Designer · **Date:** 2026-10-06

### 9.1 Why

Board T2 round 3 item 2: equipment capped at Rank 5 for the whole game. With a
4-vocation campaign, a player who keeps a golden set should be able to push it
further as the party grows — **1 vocation → 5, 2 → 10, 3 → 15, 4 → 20** — with
stats continuing the Rank 1–5 upgrade path. Item 2 of the same round asked the
AI to raise shields more often. This section pins both.

### 9.2 Rank cap scales with party size (`economy.json`)

`shop.maxRankByParty` is keyed by live member/vocation count; `shop.maxRank` is
the solo/legacy fallback.

| Party size | Max rank |
| ---: | ---: |
| 1 | 5 |
| 2 | 10 |
| 3 | 15 |
| 4 | 20 |

The engine resolves this via `EconomySystem.maxRankForParty(player)` and threads
it through `canUpgradeItem(item, player)`, `EconomySystem.canUpgrade(item,
player)`, and `applyItemRankUp(player, item)` (Tech Lead / [LIV-28](/LIV/issues/LIV-28)).
Sizes above 4 clamp to the largest authored entry; a malformed/absent party
falls back to `maxRank` (5), so legacy solo saves are balance-neutral.
*Lenses: balance levers, replayability, save compatibility.*

### 9.3 The rank curve principle: core power scales, utility plateaus

Every upgradeable item's `upgradeSpec` is an authored **per-rank delta**; ranks
6–20 apply the *same* delta as ranks 1–5, so the two halves of the curve read as
one continuous path (the Board's "following similar upgrade path"). Two classes
of field behave differently once the cap rises to 20:

* **Core power — keeps scaling linearly to Rank 20.** Weapon damage
  (`randomDamageInc` / `stepDamageInc`), `maxHpInc`, `maxMpInc`,
  `healPowerPctInc`, `poisonDpsInc`, `siphonHpInc`, `rangedDamageBonusInc`,
  `arrowCapacityInc`. This is the reward the player chases; a Rank 20 weapon
  should hit noticeably harder. *Lenses: economy & reward pacing, game feel.*
* **Utility / control / defensive — plateaus at an authored ceiling.** Range,
  mana cost, stun, dodge, crit, mitigation, shield absorb/duration, mark
  duration, cooldown reduction. Left linear to 20 they break the game (a
  `+1 range/rank` wand would reach **24** tiles; `+1s stun/rank` on the cape
  would stun-lock **24s**; `-1s CD/rank` on a 10s ability reaches the 1s floor
  and becomes infinite CC). Each is clamped by a new per-item catalog field,
  `rankCaps`, so the stat rises during the early ranks and then holds a
  deliberate ceiling while core power keeps growing.

### 9.4 `rankCaps` — the authored ceiling table

`items.json.<item>.rankCaps.<incKey>` = the **maximum total bonus** that
increment may contribute across all ranks. The engine applies
`min(incKey × (rank−1), rankCaps.incKey)`. Omitting a key means uncapped (core
power).

| Item | Capped field (`incKey`) | Delta/rank | Cap | Cap reached | Rank-20 result |
| :--- | :--- | ---: | ---: | ---: | :--- |
| Spark Wand (`apprentice_wand`) | `rangeInc` | 1 | 3 | 4 | Range 8 (was 5) |
| Beam Staff (`astral_scepter`) | `rangeInc` | 1 | 3 | 4 | Range 7 (was 4) |
| Beam Staff (`astral_scepter`) | `manaCostInc` | 5 | 20 | 5 | ~6 MP after promo discount |
| Composite Longbow (`composite_bow`) | `rangeInc` | 1 | 3 | 4 | Range 9 (was 6) |
| Grey Stalker Quiver | `ammoRegenSecReduction` | 0.5 | 2.5 | 6 | Regen floored at 2.5s |
| Vampiric Cloak (`hunter_leathers`) | `dodgePctInc` | 2 | 20 | 11 | +20% dodge |
| Ranger's Talisman | `critChanceInc` / `critMultInc` / `markDurationInc` | 1 / 0.05 / 1 | 25 / 0.5 / 6 | 26/11/7 | +19% crit, +0.5 mult, 12s mark |
| Vanguard Battleplate | `mitigationPctInc` / `cooldownReductionSec` | 1 / 1 | 15 / 8 | 16/9 | +15% mitig, Fortify ≥6s |
| Berserker's Sigil | `critChanceInc` / `critMultInc` / `cooldownReductionSec` | 1 / 0.05 / 0.25 | 25 / 0.5 / 1.5 | 26/11/7 | +19% crit, +0.5 mult, Cleave ≥1.5s |
| Vanguard Shield | `stunInc` / `cooldownReductionSec` | 0.5 / 1 | 1.5 / 5 | 4/6 | 2.5s stun, Bash ≥5s |
| Sanctuary Plate | `mitigationPctInc` / `shieldAbsorbInc` / `shieldDurationInc` | 1 / 5 / 4 | 15 / 40 / 12 | 16/9/4 | +15%, 55 absorb, 32s |
| Aegis Shield | `shieldAbsorbInc` / `shieldDurationInc` | 5 / 4 | 40 / 12 | 9/4 | 50 absorb, 42s |
| Holy Crown | `healPowerPctInc` | 3 | 30 | 11 | +45% heal |
| Dawnlight Reliquary | `healPowerPctInc` / `cooldownReductionSec` | 3 / 2 | 30 / 8 | 11/5 | +42% heal, Benediction ≥10s |
| Knight Plate Armor | `mitigationPctInc` | 1 | 15 | 16 | +15% mitig |
| Apprentice's Cape | `stunInc` / `cooldownReductionSec` | 1 / 1 | 1 / 5 | 2/6 | 6s stun, Shield ≥5s |
| Luminous Amulet | `cooldownReductionSec` | 2 | 10 | 6 | Prayer ≥10s (from 20s) |

*No `rankCaps` are authored for pure damage/HP/MP items (Tempered Broadsword,
Consecrated Warhammer, Iron Helm) — they are uncapped by design.*
*Lenses: readability & legibility (numbers stay bounded and legible), balance
levers (change the smallest field that fixes the break).*

### 9.5 Economy curve for the long ranks

The upgrade cost formula is unchanged and simply extends past Rank 5:
`cost(rank) = upgradeBaseCost + upgradeCostPerRank × (rank − 1)` =
`40 + 35 × (rank − 1)`.

| Rank → next | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 15 | 18 | 19→20 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Gold | 40 | 75 | 110 | 145 | 180 | 215 | 285 | 355 | 425 | 530 | 635 | 670 |

The **gold cost curve** for Ranks 1–5 is byte-identical to the shipped curve (the
Golden-set tests pin `40 + 35×3 = 145` at Rank 4), so the existing early game's
economy is untouched. Beyond Rank 5 the linear curve is already a rising sink — a
single item taken from Rank 1 to Rank 20 costs **7,410 gold**, and a four-item set
costs ≈30k — which tracks the campaign's monster/chest/boss gold without a new
curve type. If playtesting later shows upgrades too cheap or too expensive, the
one lever to turn is `shop.upgradeCostPerRank`; do not add a per-rank table.
*Lenses: economy & reward pacing, scope discipline.*

**Scope of "unchanged":** core power (damage, Max HP/MP, heal power, poison,
siphon, ranged bonus, ammo capacity) and every gold cost are unchanged at Ranks
1–5. A handful of *utility* caps in §9.4 bind before Rank 5 by design (e.g. the
`apprentice_cape` stun ceiling and the `aegis_shield`/`sanctuary_plate` duration
ceilings), so those specific utility values plateau at their §9.4 "Cap reached"
rank instead of growing one or two more steps. That is intentional: it removes
a shipped 9s shock-shield stun and near-permanent 46s shield from the high-rank
end, and it keeps ranges/CC from trivializing the small tower maps. It does not
touch damage, survivability, or the cost of any rank.
*Lenses: balance levers, readability (bounded numbers).*

### 9.6 AI shield frequency (FIX-15, board item 4)

Board: shields/force fields should trigger more often on AI mode. The AI's hard
gate is the **ability's own cooldown** (`actor.cooldowns[actionKey]`), not just
the shared support cadence, so both moved:

| Lever | Before | After | Why |
| :--- | ---: | ---: | :--- |
| `abilities.holy_shield.cooldownSec` | 12 | 6 | Hard recast gate; halves downtime so the bubble rotates across the party. |
| `abilities.holy_shield.manaCost` | 18 | 12 | Keeps the rotation sustainable on the Paladin's 90 mana. |
| `party_ai.paladin.support.shieldPct` | 0.55 | 0.90 | Shields proactively (the lowest un-warded ally at ≤90% HP) instead of only in emergencies. |
| `party_ai.paladin.support.cooldownSec` | 4.0 | 2.0 | Shared anti-spam cadence shortened to match. |
| `party_ai.paladin.support.minManaFrac` | 0.20 | 0.15 | Lets the shield fire a little deeper into the mana bar. |

`healPct` (0.65) and the ability cooldowns for `paladin_heal` are unchanged, so
the heal-over-shield priority and the heal cadence are untouched. Spam is still
structurally prevented by three existing rules: `selectShieldTarget` **never
re-wards an already-warded ally**, the 6s ability cooldown, and the 2s shared
cadence. Only the Paladin carries a shield ability, so no other vocation gains
support casting. *Lenses: game feel/juice, enemy-role-support readability,
Kano performance.*
The ability cooldown/mana are global (the player's Aegis shield shares them) —
a small deliberate buff, since the board's ask is about felt responsiveness.

### 9.7 Tech Lead contract — honor `rankCaps` (FIX-15b) — **delivered**

`rankCaps` is authored data; the rank projection clamps before the cap is
exposed, in the same integration as [LIV-28](/LIV/issues/LIV-28)'s
`maxRankByParty`. Delivered in [LIV-31](/LIV/issues/LIV-31) (`21da209`).

1. `item-stats.js` — for each capped key, effective total =
   `min(incKey × (rank − 1), rankCaps.incKey)`:
   `getEffectiveRange` (`rangeInc`), `getEffectiveManaCost` (`manaCostInc`),
   `getEffectiveCooldown` (`cooldownReductionSec`, before the 1s floor).
2. `item-progression.js` `applyItemRankUp` — when mutating instance fields, clamp
   the accumulated bonus to the item's `rankCaps` total (read from the catalog
   entry), for every capped key (range, manaCost, stun, dodge, crit, critMult,
   mitigation, healPower, shieldAbsorb, shieldDuration, arrowCapacity,
   ammoRegenSec, cooldownReductionSec). Uncapped keys keep accumulating.
3. Acceptance (T0): a Rank-20 Spark Wand has range **8**; a Rank-20 Astral
   Scepter range **7** and ≤ ~15 MP; a Rank-20 Vanguard Shield stun **2.5s**,
   bash cooldown **≥5s**; a Rank-20 Apprentice's Cape stun **6s**, cooldown
   **≥5s**; uncapped Tempered Broadsword damage still
   `16 + avg(4..6) × 19`; core power and all ranks' gold costs are unchanged at
   Ranks 1–5 (utility caps per §9.4 plateau at their authored rank); the full T0
   suite stays green (**710 pass / 0 fail** at `21da209`).

