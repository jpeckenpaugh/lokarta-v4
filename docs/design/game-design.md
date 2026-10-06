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
