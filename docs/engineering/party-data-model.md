# Party Data Model, Save Migration & Campaign Schema (LIV-9 WS1)

Authoritative contract for the Dev Sprint 001 party campaign model. WS2–WS6
build on this; the shapes and helper names below are **locked by the Tech Lead**
and should not be changed without updating this doc and the T0 suite
(`html/tests/liv9-party-model.test.mjs`).

Catalog **content** (balance, copy, exact tower order) is owned by the Game
Designer (WS5). The schemas, loaders, defaults, and migration behavior are owned
by the Tech Lead.

---

## 1. Save shape

The top-level character object remains the **active member's live state** so
every existing input / render / combat path keeps working unchanged. Three new
top-level fields extend the save:

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `player.party` | `PartyMember[]` | Every member, active included. At least one entry. |
| `player.activeMemberId` | `string` | `memberId` of the member mirrored onto the top level. |
| `player.towerProgress` | `{ completedTowerIds: string[], unlockedTowerIds: string[] }` | Per-save campaign completion/unlocks. |

A `PartyMember` is a `createPlayer(vocation)`-shaped object (full stats,
inventory, cooldowns, gear) plus:

```jsonc
{
  "memberId": "member_magician", // stable; one member per vocation
  "vocation": "magician",
  "aiMode": "auto",              // "auto" | "manual"
  "faction": "party",            // "party" | (monsters use "monsters")
  "x": 12, "y": 7,               // member's own grid position
  "anim": { }                    // optional animation state
}
```

Shared run state (`current_floor`, `towerId`, `location`, `townVisits`) and the
save envelope (`slotId`, `slotIndex`, `saveVersion`, `playtimeMs`, timestamps,
`floorEntry`) live on the top level, **not** on members.

Two resources are **party-shared** and live only on the top level: `backpack`
(the shared party backpack, LIV-22) and `levelKeys` (the shared party key ring,
LIV-33). Both are in `MEMBER_EXCLUDED_KEYS`, so `captureActiveMember` /
`applyActiveMember` never copy them in or out of a member; cycling the active
member cannot hide loot or an earned key.

### Sync contract (`html/engine/party.js`)

- The **top level is authoritative** for the active member while playing.
- `captureActiveMember(player)` copies top-level state into the active member
  entry. Call it before every persist (the worker does this automatically).
- `setActiveMember(player, memberId)` captures the outgoing member, then applies
  the target member to the top level. Used by the recruit/switch flow (WS2).
- `migratePlayerParty(player)` is idempotent and returns the same reference when
  no field needs changing.

Full helper surface: `createPartyMember`, `createPartyPlayer`,
`getActiveMember`, `activeMemberIndex`, `partyVocationIds`, `MAX_PARTY_SIZE`,
`PARTY_FACTION`, `MONSTER_FACTION`.

---

## 2. Migration

`migratePartySave()` in `html/services/storage.js` runs at bootstrap after the
tower migration, guarded by `game_settings/migration_party_v4`:

- Wraps a legacy single-character save into a one-member party.
- Initializes `towerProgress` with **only the first tower unlocked**.
- Preserves level, xp, gold, backpack, paperdoll, action bar, `levelKeys`, and
  `springCharges`; drops nothing and resets no floor caches.
- Folds any pre-LIV-33 per-member `levelKeys` copies into the shared top-level
  key ring (union per level/tier) and strips them, so keys earned before the
  upgrade survive and can never be hidden by a later active-member cycle.
- Backfills `towerProgress` onto slot metadata for the tower picker.
- Idempotent: a rerun is a no-op once the guard exists.

`migratePlayerParty` is also applied lazily on `loadSlot`, `selectTower`,
`restartFloor`, `respawnAfterDeath`, `advanceFloor`, `saveCharacter`, and
`newGame`, so a save is always party-shaped before it is persisted.

`resetProgress` clears all three migration guards.

---

## 3. Catalog schemas (locked)

### 3.1 `tower_levels.json`

Each tower gains a campaign position and its prerequisites:

```jsonc
{
  "id": "sunken_catacombs",
  "order": 2,
  "unlockRequires": ["spire_of_light"]
}
```

- `order` is a unique positive integer; catalog array order is the fallback when
  absent, so pre-order catalogs still resolve deterministically.
- `unlockRequires` is an array of authored tower ids; when absent the previous
  tower by `order` is assumed (first tower requires nothing).

Loader helpers in `html/data/index.js`: `towerOrder`,
`listTowerDefinitionsByOrder`, `firstTowerId`, `isTowerId`,
`towerUnlockRequires`, `towersUnlockedBy`, `nextTowerIdAfter`.

### 3.2 `party_ai.json` (new catalog)

Baseline per-vocation auto-AI profiles. WS5 tunes the values; the shape is
locked. Register through `PARTY_AI_CATALOG`.

```jsonc
{
  "default":    { "preferredAbilities": [], "followDistance": 2, "engageRadius": 5, "retreatHpPct": 0.25, "castRange": 4, "retargetSec": 1.5, "healAlliesWhenHurt": false },
  "profiles": {
    "magician": { "preferredAbilities": ["magician_beam", "magician_spark"], "...": "..." },
    "archer":   { "...": "..." },
    "fighter":  { "...": "..." },
    "paladin":  { "...": "..." }
  }
}
```

- `profiles` must carry an entry for every vocation in `vocations.json`.
- `preferredAbilities` must reference real ids in `abilities.json`.
- `default` is the safe fallback for any vocation without a profile.

### 3.3 `abilities.json` — ally healing

Heal abilities declare an ally-aware radius and target flag:

```jsonc
"paladin_heal": { "type": "heal", "healRadius": 6, "targetsAllies": true }
```

- `healRadius` (tiles, > 0): most-injured ally within radius, else self.
- `targetsAllies` (bool): include party members as valid heal targets.

### 3.4 `ui.json` — campaign copy

The `campaign` block holds every Tower Complete / Recruit / locked-tower string
(WS5 owns the wording): `towerCompleteTitle`, `towerCompleteBody`,
`recruitTitle`, `recruitPrompt`, `recruitConfirmLabel`, `ultimateVictoryTitle`,
`ultimateVictoryBody`, `towerUnlockedLabel`, `towerLockedLabel`,
`towerLockedHint`, `towerContinueLabel`, `towerReturnToTownLabel`.

---

## 4. Persistence & RPC

- Party state rides on the existing `characters` object store; no IndexedDB
  schema/version change is required.
- Slot metadata (`save_slots`) mirrors `towerProgress` via `deriveSlotMeta` so
  the tower picker can gate without loading the full character.
- No new worker RPC commands are introduced by WS1; every existing
  character-writing handler now captures the active member and normalizes
  campaign progress.

## 5. Verification

`node --test html/tests/liv9-party-model.test.mjs` covers the catalog schema,
the pure model, tower progression, worker round-trips, and the idempotent
non-destructive migration. The full T0 suite (`node --test
html/tests/*.test.mjs`) must stay green.

---

## 6. WS2 campaign loop (LIV-10)

WS2 layers the non-terminal campaign loop on this model. The pure helpers live in
`html/engine/campaign.js`; the authoritative state remains the WS1 shape.

| Helper | Purpose |
| :--- | :--- |
| `partyLevel(player)` | Highest member level (active included); recruit alignment target. |
| `recruitableVocations(player)` | Catalog vocations not yet on the party. |
| `canRecruit(player)` | Party has room and a vocation is left. |
| `alignMemberToLevel(member, level)` | Catalog base + per-level growth, full HP/MP, refreshed boosts. |
| `recruitMember(player, vocation)` | Appends an aligned member, makes it active; rejects unknown/duplicate/full. |
| `completePlayerTower(player, towerId)` | Records completion, unlocks the next tower, reports `allComplete`/`nextTowerId`. |
| `towerUnlockInfo(progress, towerId)` | `{ unlocked, requires }` for the picker. |

New worker RPCs (wired through `GameClient`):

- `completeTower({ slotIndex, towerId })` → `{ player, progress, completedTowerId,
  allComplete, nextTowerId, recruitableVocations }`. Idempotent and
  non-destructive: keys/springs/party survive.
- `recruitMember({ slotIndex, vocation })` → `{ player, member,
  recruitableVocations }`. Rejects an unknown, duplicate, or over-cap recruit.

`selectTower` now enforces the campaign gate in the worker: a tower whose
`unlockRequires` are not satisfied is rejected even if a caller bypasses the
picker. Completed towers stay replayable.

UI flow (`floor-controller.js`): clearing a summit records the tower and then
shows **Tower Complete** → **Recruit** → enters the next unlocked tower as the
new recruit. **Ultimate Victory** fires only when every authored tower is
complete. Locked towers render disabled in the picker via `towerUnlockInfo`.
The HUD shows a compact party panel (`HUDManager.renderPartyPanel`).

---

## 7. WS3 combat actor contract (LIV-11)

WS3 generalizes combat from "the one player" to any party actor and makes
friendly fire impossible. The contract is locked for WS4 (party auto-AI) and WS5.

### 7.1 Faction (`html/engine/faction.js`)

| Symbol | Meaning |
| :--- | :--- |
| `PARTY_FACTION` (`"party"`) | Every player-controlled member. |
| `MONSTER_FACTION` (`"monsters"`) | Every hostile monster (declared per entry in `monsters.json`). |
| `NEUTRAL_FACTION` (`"neutral"`) | Reserved for inert objects. |
| `factionOf(entity)` | Normalized tag or `null` when undeclared. |
| `isFriendly(a, b)` | True **only** when both declare the same non-empty faction. |
| `isHostile(a, b)` | `!isFriendly`; an undeclared faction is hostile (damage applies). |
| `sameActor(a, b)` | Identity match, including `memberId`/`activeMemberId` mirroring. |

`party.js` re-exports the constants and helpers, so existing imports keep
working. `createPlayer`/`createPartyMember` stamp `faction: "party"`.

### 7.2 Actor contract

Every `CombatSystem.executeX` method takes the **acting member** as its first
argument — the manual active member or an auto ally. An actor is any
`createPlayer`-shaped object plus `{ faction, memberId? }`, and owns its
`cooldowns`, `hp/max_hp`, `mana/max_mana`, gear and position. No combat method
reads a global player. `CombatSystem.tickActorTimers(actor, dt)` /
`decrementCooldowns` advance timers per member.

### 7.3 Friendly fire

- `applyIncomingDamage(target, damage, attacker)` returns a zeroed,
  `friendlyFire: true` result when `attacker` and `target` are friendly — the
  single guaranteed seam for melee, projectile, AoE, dash and status damage.
- Target selection filters by `CombatSystem.isHostile(actor, candidate)` in
  `findMonsterInMeleeArea`, `executeSlash`/`executeHolyStrike`,
  `executeCleave`, `executeShieldBash`, `executeLifeSiphon`, `executeHuntersMark`.
- `projectile-collision.js` `firstMonsterOnSegment` / `monstersCaughtByBeam`
  accept an optional `isHostile` predicate; `game-loop.js` passes
  `(m) => CombatSystem.isHostile(this.player, m)`.
- `applyPlayerStatus(target, effect, attacker)` refuses same-faction statuses.

### 7.4 Ally healing

- `CombatSystem.selectHealTarget(actor, allies, radius)` returns the
  most-injured friendly actor within `radius` of `actor`, always considering
  self and de-duplicating the active mirror via `sameActor`. Out-of-range or
  enemy actors are ignored.
- `executeHealingPrayer(actor, allies)` uses catalog
  `paladin_heal.healRadius` / `targetsAllies`; `executeBenediction(actor, item,
  allies)` uses the item's `healRadius` / `targetsAllies` for the HP restore,
  always restoring MP to the caster.
- Both fall back to self and, when nobody is hurt, refuse to cast, so
  one-member calls are unchanged. The app passes `player.party`.

T0 coverage: `html/tests/liv11-combat-actors.test.mjs`.

---

## 8. WS4 party auto-AI, loop & render integration (LIV-13)

WS4 drives every non-active member from a pure engine module and wires it into
the fixed tick and the renderer. No app-side vocation/ability names are used.

### 8.1 `html/engine/party-ai.js` (new)

Pure, browser-free: it imports only `data/index.js`, `combat-system.js`,
`entity-ai.js`, `lighting-system.js` and `faction.js`.

| Symbol | Purpose |
| :--- | :--- |
| `profileForVocation(vocation)` | Resolved `party_ai.json` profile (`profiles[voc]` over `default` over `DEFAULT_AI_PROFILE`). |
| `PartyAI.inactiveMembers(player)` | Living, non-active, `aiMode !== 'manual'` members — the auto allies. |
| `PartyAI.livingAllies(player)` | Top-level active player + living non-active members (the heal/target set). |
| `PartyAI.partyMemberAt(player, x, y)` | Living non-active member on a tile (ally collision), or null. |
| `PartyAI.updateAllies(player, { gridMap, monsters, deltaSec })` | Drives each ally once; mutates positions/timers and returns one intent event per member. |

Per-member decision order each tick (all catalog-driven):

1. **Retreat** — below `retreatHpPct` while threatened, step away from the threat.
2. **Cast** — first ready ability in `preferredAbilities` (heals only when
   `healAlliesWhenHurt`); gates are per-actor cooldown, mana, range, LOS and (for
   the Beam line attack) rough cardinal alignment.
3. **Engage** — close to `castRange` with A* (`EntityAI.findNextStepAStar`).
   Target acquisition holds a committed target for `retargetSec`; a profile with
   `protect.enabled` first retaliates against the hostile attacking another
   party member before defaulting to `nearestHostile` (LIV-33).
4. **Search** — out of combat (`protect`/combat found no target) and
   `itemSearch.enabled`, step toward the nearest ground item within
   `itemSearch.radius`; the app's walk-over pipeline banks it in the shared
   backpack (LIV-33).
5. **Follow** — trail the active member at `followDistance`.

Movement never enters an occupied tile (monster, ally or active member) and
always uses `gridMap.isWalkable`; `blockersFor` passes integer-keyed occupancy
to the shared A*.

Ability dispatch is a table keyed by the catalog `actionKey`
(`wand_spark`, `energy_beam`, `bow_shot`, `power_shot`, `slash`, `cleave`,
`holy_strike`, `healing_prayer`). An unknown/unsupported `actionKey` is skipped,
never guessed. Auto bow casts pass `{ freeAmmo: true }` to
`executeBowShot`/`executePowerShot` so allies cast their kit without draining the
party's finite arrow stock; the manual active member never sets it.

Events are `{ member, type: 'ability' | 'move' | 'idle', abilityId?, actionKey?,
target?, result? }`. `game-loop.js` turns them into animation, sound, combat log,
floating text and loot by routing single-target results through the existing
`handleCombatResult`, so ally kills share the party's XP/loot.

### 8.2 Loop, render, HUD

- `game-loop.updatePartyAllies(deltaSec)` ticks each ally's cooldowns, shield,
  fortify, status DoTs and passive recovery before running `PartyAI.updateAllies`.
- Monster AI now targets the nearest living party member:
  `EntityAI.updateMonsters(monsters, player, gridMap, dt, targets)`;
  `EntityAI.selectTarget(monster, targets)` is faction-gated and each result
  carries `target`, so the loop applies damage/status/animation to the actor
  actually struck. A one-target call (legacy) behaves exactly as before.
- `canvas-renderer.render(..., party)` draws every non-active member with the
  shared `SpriteRenderer.drawPlayer` pipeline. Living members get HP/MP bars;
  downed bodies use the frozen `DOWNED_DRAW_OPTS` grayscale + 90° "on back"
  treatment (LIV-45/LIV-49) plus their call-for-help beacon, revive tether, and
  auto-revive countdown ring.
- **Knockout & revive (LIV-41/LIV-47/LIV-51).** A member at 0 HP stays on the
  board as `downed` (collapsed, greyscale, immobile, untargeted, no light cone);
  control hands off to a living ally. `html/engine/revive-system.js` owns the
  downed lifecycle: full-party-wipe evaluation, the adjacency/safety-gated
  interruptible ally channel (catalog `party_ai.json.revive`), and the
  per-member time-based auto-revive (`autoRevive.secs` = 10/20/30, `capSec` 30)
  that runs during combat and is cancelled by a completed ally revive. Only a
  simultaneous full-party down wipes to the Temple of the Dawn.
- Healing fountains (`game-loop.applySpringRegenToParty`) restore the **whole
  living party** while the active member is adjacent, gated by
  `economy.springs.healsParty` (default true); `healsParty: false` keeps the
  legacy single-actor rule. Each member is capped at its own max and downed
  members are skipped, so a fountain is not a revive.
- `hud-manager.renderPartyPanel` reads the active member's live HP/MP from the
  top-level player (no per-tick JSON capture).
- `floor-controller.layoutPartyOnFloor(transportAll, reviveDowned)` revives
  downed allies only on a genuine floor transition (`reviveDowned`, gated by
  `revive.reviveOnFloorTransition`); a same-floor reload leaves the body downed.
  It spreads any member sharing the active member's tile to a free adjacent
  square.

T0 coverage: `html/tests/liv13-party-ai.test.mjs`.

---

## 9. WS7 shared party backpack & ally walk-over pickup (LIV-22)

Board T2 round 2 item 4: allies pick up walk-over drops into a **shared party
backpack**; no member carries its own backpack.

### 9.1 Shared backpack contract (`html/engine/party.js`)

- `backpack` joins `MEMBER_EXCLUDED_KEYS`: it lives on the **top-level player**
  (the party stash) and is never copied into or out of a member. Switching the
  active member therefore never swaps the backpack.
- A `PartyMember` carries **no** `backpack`. `action_bar` (the per-character
  quick-use hotbar) and `paperdoll` (equipped gear) stay per member, so the
  LIV-16 level-1 Fate Grant gate (empty hotbar) is unaffected.
- `migratePlayerParty` folds any legacy per-member `backpack` into the shared
  top-level grid (stacking via catalog `maxStack`, never duplicating the active
  member's mirror) and strips the per-member copies. The shared grid is
  normalized to `UI_CATALOG.inventory.backpack.defaultSlots` on the first pass,
  and the migration stays idempotent (reference no-op on rerun).

### 9.2 Pickup pipeline

- `InventorySystem.pickUpItem(player, gridMap, atX?, atY?)` collects from an
  explicit tile (defaults to the actor's own), routing consumables to the
  active hotbar and everything else into the shared backpack.
- `inventory-controller.js` `handlePickUp(gridX, gridY)` takes the source tile
  so currency/keys credit the shared purse/level keys from any actor.
- `game-loop.js` `applyPartyEvent` calls `handleAllyWalkoverPickup(member)` on
  every auto-ally `move` event, which runs the same pipeline at the ally's tile.
  Empty tiles are a no-op.

T0 coverage: `html/tests/liv22-ally-pickup.test.mjs`.

---

## 10. WS8 shared keys, ally item search & protector targeting (LIV-33)

Sprint 001 close tweaks. All three are catalog-driven; values live in
`party_ai.json` and no vocation/ability name is hardcoded.

### 10.1 Shared party key ring (`html/engine/party.js`)

- `levelKeys` joins `MEMBER_EXCLUDED_KEYS`: it lives on the **top-level player**
  (the party key ring) and is never copied into or out of a member. A key picked
  up by the controlled member *or* an auto ally credits the one store.
- A `PartyMember` carries **no** `levelKeys`. `createPartyMember` strips it, and
  `captureActiveMember` / `applyActiveMember` skip it, so
  `setActiveMember`/`cycleActiveMember` can never hide or lose an earned key.
- Tier gates (`DoorSystem.hasKey`/`syncPlayerGates`, `floor-controller.js`,
  `game-loop.js`) read the top-level store, so a gate opens regardless of which
  member is active. Keys stay non-inventory, one-per-tier (`=== true`), and the
  grant/union is idempotent.
- `migratePlayerParty` folds legacy per-member `levelKeys` into the top-level
  store (union per level/tier) and strips the per-member copies; the fold is a
  reference no-op on rerun.

### 10.2 Ally ground-item search (`party_ai.json` → `itemSearch`)

| Field | Meaning |
| :--- | :--- |
| `itemSearch.enabled` | Master switch for out-of-combat looting. |
| `itemSearch.radius` | Search leash in tiles (0 disables scanning). |

When a member has no engaged target, `PartyAI` scans a bounded
`radius`-tile window for the nearest walkable ground item with LOS and steps
toward it with `EntityAI.findNextStepAStar` (paced by `movement.cadenceSec`).
The step is a normal `move` event, so the app's existing
`handleAllyWalkoverPickup` → `handlePickUp` pipeline banks the drop in the shared
party backpack. Combat, retreat and support decisions run first, so looting
never competes with survival. Engine baseline: `DEFAULT_AI_ITEM_SEARCH`.

### 10.3 Protector/retaliate targeting (`party_ai.json` → `protect`)

| Field | Meaning |
| :--- | :--- |
| `protect.enabled` | Prioritize the hostile attacking a party member over the nearest hostile. |
| `protect.radius` | Max tiles the member will leave formation to reach that attacker. |

`EntityAI.updateMonsters` records `monster.aggroTarget` when a hostile engages a
party member. On retarget, a protector profile locks the hostile attacking
another member (target-locked, or adjacent — the fallback for hand-built
monsters) when it is within `protect.radius`; otherwise it falls back to
`nearestHostile` under the usual `retargetSec`/leash rules. Only front-line
profiles (fighter/paladin) enable it; backline/support profiles keep their
`followDistance`/`support` posture. Engine baseline: `DEFAULT_AI_PROTECT`
(`enabled: false`).

T0 coverage: `html/tests/liv33-party-tweaks.test.mjs` (shared keys + cycle +
gate, key migration, item-search pathing/pickup, protector targeting).
