# Lokarta: Game Design Specification

A high-level design canon for *Lokarta: Come Into The Light*.

---

## 1. Core Game Loop

1. **Title & Save Slot Selection:** Choose from 5 persistent save slots stored in browser IndexedDB (`lokarta_browser_db`).
2. **Havenreach Town Hub:** Access the Merchant's Stall (Shop), Temple of the Dawn (Temple healing), or embark into the tower.
3. **5-Tier Tower Ascent:** Ascend through 5 deterministic procedural levels on a $40 \times 40$ tile grid ($3 \times 3$ macro rooms).
4. **Gated Progression & Keys:** Defeat tier key holders to obtain Copper, Silver, and Gold keys to unlock gates leading to the ascent stairs.
5. **Combat & Tactical Abilities:** 10 Hz real-time simulation tick (`TICK_INTERVAL_MS = 100`) using vocation-specific abilities, cooldowns, and range mechanics.
6. **Fate Grants (Drafting System):** At Level 1 and upon every level-up (up to Level 20 cap), players are offered a 5-card draft and **must select exactly 2 cards** granting vocation skills, stat upgrades, or gear rank upgrades (Ranks 1–5).
7. **The Spire Warden:** Defeat the final boss on Level 5 and its Spire Sentinels to achieve ultimate victory.

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

## 3. The 5-Tier Tower Structure

The tower layout and monster pools are catalog-driven via [`html/data/tower_levels.json`](../html/data/tower_levels.json):

* **Level 1 — The Gatehouse (`crypt`):** Warm amber glow (`#ff8800`). Enemies: Giant Rats, Crypt Skeletons.
* **Level 2 — The Hall of Banners (`catacombs`):** Cyan glow (`#00d4ff`). Enemies: Giant Rats, Crypt Skeletons, Shadow Cultists.
* **Level 3 — The Bell Keep (`shadow_vaults`):** Arcane purple glow (`#a855f7`). Enemies: Crypt Skeletons, Shadow Cultists (Elite Cultist gold keyholder).
* **Level 4 — The Solar Gallery (`abyssal_sanctum`):** Crimson glow (`#ef4444`). Enemies: Shadow Cultists, Elite Cultists.
* **Level 5 — The Crown Spire (`crown_spire`):** Golden amber glow (`#ffd700`). Final boss: **The Spire Warden** (`abyssal_overlord`, 600 HP) and 2 Spire Sentinels (`elite_cultist`).

---

## 4. Controls & Input Mapping

* **Keyboard Movement:** `W`, `A`, `S`, `D` or Arrow Keys $\uparrow, \leftarrow, \downarrow, \rightarrow$.
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
* **Death & Defeat:** Defeat in the tower revives the hero at full health/mana in the Havenreach Town Temple. Current floor progression is **preserved** (the player can re-enter and resume on their active floor).
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
* **Tower roster wiring is LIV-5.** `tower_levels.json` monster pools still list the launch
  five; this bestiary is the pool source for LIV-5 to assign per tower/floor.
* **Boss wiring handoff:** `tidebound_king` is authored and ready, but the
  `sunken_catacombs` tower boss still points at `abyssal_overlord`. Point
  `tower.boss.type` at `tidebound_king` when that tower's identity is finalized.
