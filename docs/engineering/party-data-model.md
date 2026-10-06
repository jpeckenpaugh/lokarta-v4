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
