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
