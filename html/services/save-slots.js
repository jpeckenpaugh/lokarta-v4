/**
 * Lokarta: Come Into The Light - Save Slot & Options Helpers
 *
 * Pure, browser-free helpers shared by the storage layer, the game worker,
 * and the native Node test suite. Nothing here touches IndexedDB, the DOM,
 * the Web Worker API, or timers.
 */

import {
  UI_CATALOG,
  DEFAULT_TOWER_ID,
  towerLevelCount,
} from '../data/index.js';
import { normalizeTowerProgress } from '../engine/party.js';

/** Number of independent save slots (from the ui.json presentation catalog). */
export const SAVE_SLOT_COUNT = (UI_CATALOG && UI_CATALOG.saveSlots && UI_CATALOG.saveSlots.count) || 5;

/**
 * Highest playable level of the default tower (from tower_levels.json). Kept
 * for legacy call sites; use `clampTowerFloor(n, towerId)` for a selected
 * tower. Saves that predate the 20 -> 5 floor cut may point past this and are
 * clamped by the caller.
 */
export const TOWER_LEVEL_COUNT = Math.max(1, towerLevelCount(DEFAULT_TOWER_ID));

/** Default persisted options (from the ui.json presentation catalog). */
export const OPTION_DEFAULTS = Object.freeze({
  ...(UI_CATALOG?.options?.defaults || {}),
});

/** Option value ranges/enums (from the ui.json presentation catalog). */
export const OPTION_RANGES = Object.freeze({
  ...(UI_CATALOG?.options?.ranges || {}),
});

const REDUCE_MOTION_VALUES = ['system', 'on', 'off'];

/**
 * Canonical slot id for a 1-based slot index.
 * @param {number} slotIndex
 * @returns {string}
 */
export function slotId(slotIndex) {
  return `slot_${slotIndex}`;
}

/**
 * Canonical composite key for a slot's cached floor record.
 * @param {number} slotIndex
 * @param {number} floorNumber
 * @returns {[number, number]}
 */
export function slotFloorKey(slotIndex, floorNumber) {
  return [slotIndex, floorNumber];
}

/**
 * A blank slot record for an unused slot.
 * @param {number} slotIndex
 * @returns {object}
 */
export function emptySlotRecord(slotIndex) {
  return {
    id: slotId(slotIndex),
    slotIndex,
    status: 'empty',
    saveVersion: SAVE_FORMAT_VERSION,
    characterId: null,
    name: null,
    vocation: null,
    level: null,
    currentFloor: null,
    biome: null,
    towerId: null,
    playtimeMs: 0,
    floorEntry: null,
    towerProgress: null,
    createdAt: null,
    updatedAt: null,
    lastPlayedAt: null,
  };
}

/**
 * A deep, serializable snapshot of the player state restored by Retry/Continue.
 * @param {object|null} player
 * @returns {object|null}
 */
export function snapshotFloorEntry(player) {
  if (!player) return null;
  return {
    hp: player.hp,
    max_hp: player.max_hp,
    mana: player.mana,
    max_mana: player.max_mana,
    x: player.x,
    y: player.y,
    current_floor: player.current_floor,
    towerId: player.towerId || null,
    level: player.level,
    xp: player.xp,
    action_bar: clone(player.action_bar),
    backpack: clone(player.backpack),
    paperdoll: clone(player.paperdoll),
    skillBoosts: clone(player.skillBoosts),
  };
}

/**
 * Applies a floor-entry snapshot onto a player object (mutates and returns it).
 * @param {object} player
 * @param {object|null} entry
 * @returns {object}
 */
export function restoreFloorEntry(player, entry) {
  if (!player || !entry) return player;
  for (const [key, value] of Object.entries(entry)) {
    player[key] = clone(value);
  }
  return player;
}

/**
 * Builds the persisted metadata record for an occupied slot from a player.
 * @param {object} player
 * @param {number} slotIndex
 * @param {string} [biome]
 * @returns {object}
 */
export function deriveSlotMeta(player, slotIndex, biome = null) {
  const existing = player?.updatedAt || null;
  return {
    id: slotId(slotIndex),
    slotIndex,
    status: 'occupied',
    saveVersion: SAVE_FORMAT_VERSION,
    characterId: player?.id || null,
    name: player?.name || null,
    vocation: player?.vocation || null,
    level: Number(player?.level) || 1,
    currentFloor: clampTowerFloor(player?.current_floor, player?.towerId),
    biome: biome || null,
    towerId: player?.towerId || null,
    playtimeMs: Number(player?.playtimeMs) || 0,
    floorEntry: snapshotFloorEntry(player),
    towerProgress: normalizeTowerProgress(player?.towerProgress),
    createdAt: player?.createdAt || existing,
    updatedAt: existing,
    lastPlayedAt: player?.lastPlayedAt || existing,
  };
}

/**
 * Fills a slot record's campaign progress for legacy records that predate the
 * party model. Returns the original reference when no field needs changing.
 * @param {object|null} slot
 * @returns {object|null}
 */
export function normalizeSlotPartyProgress(slot) {
  if (!slot || typeof slot !== 'object') return slot;
  if (slot.status !== 'occupied') return slot;
  const normalized = normalizeTowerProgress(slot.towerProgress);
  if (normalized === slot.towerProgress) return slot;
  return { ...slot, towerProgress: normalized };
}

/**
 * Clamps an arbitrary floor number onto the selected tower's 1..levelCount
 * range. Legacy saves from the retired 20-floor layout can point as high as 20;
 * clamping means they land on the tower without ever loading a floor beyond the
 * final level. Non-finite values default to level 1.
 * @param {number} floorNumber
 * @param {string} [towerId]
 * @returns {number}
 */
export function clampTowerFloor(floorNumber, towerId = DEFAULT_TOWER_ID) {
  const n = Math.floor(Number(floorNumber));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(towerLevelCount(towerId), n));
}

/**
 * Floor the player respawns on after death: one level lower, clamped so
 * the first level is the floor. `current_floor` is clamped onto the player's
 * tower first.
 * @param {object|null} player
 * @returns {number}
 */
export function descendOnDeath(player) {
  const current = clampTowerFloor(player?.current_floor, player?.towerId);
  return Math.max(1, current - 1);
}

/**
 * Restores full health and mana. Mutates and returns the
 * player. Safe on partial players; only touches hp/mana when the max is known.
 * @param {object|null} player
 * @returns {object|null}
 */
export function applyFullRestore(player) {
  if (!player || typeof player !== 'object') return player;
  if (Number.isFinite(Number(player.max_hp))) player.max_hp = Number(player.max_hp);
  if (Number.isFinite(Number(player.max_mana))) player.max_mana = Number(player.max_mana);
  player.hp = player.max_hp;
  player.mana = player.max_mana;
  return player;
}

/**
 * Migrates a persisted player character onto the 5-level tower. Returns a
 * shallow copy with `current_floor` clamped to `1..TOWER_LEVEL_COUNT` and the
 * `floorEntry` snapshot kept in sync. Returns the original reference when no
 * field needs changing so callers can cheaply detect a no-op. Never throws.
 * @param {object|null} player
 * @returns {object|null}
 */
export function migratePlayerToTower(player, towerId = null) {
  if (!player || typeof player !== 'object') return player;
  const effectiveTowerId = towerId || player.towerId || DEFAULT_TOWER_ID;
  let flatFloor = player.current_floor;
  if (flatFloor === undefined || flatFloor === null || !Number.isFinite(Number(flatFloor))) {
    flatFloor = 1;
  }
  const clamped = clampTowerFloor(flatFloor, effectiveTowerId);
  const entry = player.floorEntry;
  let entryClamped = null;
  if (entry && typeof entry === 'object') {
    let entryFloor = entry.current_floor;
    if (entryFloor === undefined || entryFloor === null || !Number.isFinite(Number(entryFloor))) {
      entryFloor = 1;
    }
    entryClamped = clampTowerFloor(entryFloor, effectiveTowerId);
  }
  const floorNeedsFix = Number(flatFloor) !== clamped;
  const entryNeedsFix = entryClamped !== null && Number(entry.current_floor) !== entryClamped;
  if (!floorNeedsFix && !entryNeedsFix) return player;

  const next = { ...player, current_floor: clamped };
  if (entryClamped !== null) {
    next.floorEntry = { ...entry, current_floor: entryClamped };
  }
  return next;
}

/**
 * Normalizes a persisted slot metadata record onto the 5-level tower. A slot is
 * never "unavailable" merely because it points past level 5 — it is clamped to
 * the final level so an old save stays loadable. Also keeps `floorEntry` in
 * sync. Returns a new object when a field changed, else the original reference.
 * @param {object|null} slot
 * @returns {object|null}
 */
export function normalizeSlotToTower(slot) {
  if (!slot || typeof slot !== 'object') return slot;
  const towerId = slot.towerId || DEFAULT_TOWER_ID;
  let rawFloor = slot.currentFloor;
  if (rawFloor === undefined || rawFloor === null || !Number.isFinite(Number(rawFloor))) {
    rawFloor = 1;
  }
  const clamped = clampTowerFloor(rawFloor, towerId);
  const entry = slot.floorEntry;
  let entryClamped = null;
  if (entry && typeof entry === 'object') {
    let entryFloor = entry.current_floor;
    if (entryFloor === undefined || entryFloor === null || !Number.isFinite(Number(entryFloor))) {
      entryFloor = 1;
    }
    entryClamped = clampTowerFloor(entryFloor, towerId);
  }
  const floorNeedsFix = Number(rawFloor) !== clamped;
  const entryNeedsFix = entryClamped !== null && Number(entry.current_floor) !== entryClamped;
  if (!floorNeedsFix && !entryNeedsFix) return slot;

  const next = { ...slot, currentFloor: clamped };
  if (entryClamped !== null) {
    next.floorEntry = { ...entry, current_floor: entryClamped };
  }
  return next;
}

/**
 * Version of the persisted slot/character shape. v1 = 20-floor cave layout;
 * v2 = 5-level tower (floors clamped to `1..TOWER_LEVEL_COUNT`); v3 = party
 * knockout lifecycle (per-member `lifeState`/`downed*`/`reviveGraceSec`, LIV-44);
 * v4 = Island 1 world state (per-character `questState`/`worldFlags`/`scene` and
 * the data-driven Spire access gate, LIV-55 P4); v5 = shared party gold (one
 * top-level wallet; per-member `gold` folds into the sum, clamped to cap,
 * LIV-72). The storage layer stamps the current version and resets pre-v2 floor
 * caches (see `migrateLegacySave`); the v3/v4/v5 fields are backfilled
 * idempotently by `migratePlayerParty` and `migrateWorldSave` on load/upgrade.
 */
export const SAVE_FORMAT_VERSION = 5;

/**
 * Reads the save-format version stamped on a stored slot/character. Missing or
 * malformed versions are treated as v1 (pre-tower) so they get normalized.
 * @param {object|null} record
 * @returns {number}
 */
export function saveFormatVersion(record) {
  const n = Math.floor(Number(record?.saveVersion));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Slot record classification for the slot-select UI.
 * - `empty`: a valid unused slot (or one produced by `emptySlotRecord`).
 * - `occupied`: a structurally valid, loadable save.
 * - `unavailable`: a corrupt/unknown record that must not be loaded.
 */
export const SLOT_KIND = Object.freeze({
  EMPTY: 'empty',
  OCCUPIED: 'occupied',
  UNAVAILABLE: 'unavailable',
});

/**
 * True when an occupied slot record carries every field the UI and loader
 * need. Missing/blank fields or a non-numeric level/floor mean the save cannot
 * be safely loaded and must render as DATA UNAVAILABLE. A floor above the tower
 * max is valid: the loader clamps it to the final level (`normalizeSlotToTower`),
 * so an old 20-floor save stays loadable instead of vanishing.
 * @param {object|null} slot
 * @returns {boolean}
 */
export function isSlotRecordValid(slot) {
  if (!slot || typeof slot !== 'object') return false;
  if (!Number.isInteger(slot.slotIndex) || slot.slotIndex < 1) return false;
  if (typeof slot.characterId !== 'string' || slot.characterId.length === 0) return false;
  if (typeof slot.vocation !== 'string' || slot.vocation.length === 0) return false;
  if (!Number.isFinite(Number(slot.level)) || Number(slot.level) < 1) return false;
  if (!Number.isFinite(Number(slot.currentFloor)) || Number(slot.currentFloor) < 1) return false;
  if (!slot.floorEntry || typeof slot.floorEntry !== 'object') return false;
  return true;
}

/**
 * Classifies a slot metadata record into a `SLOT_KIND`. Unknown `status`
 * values and malformed occupied records classify as `unavailable` rather than
 * being silently rendered as an empty slot (spec §4.2).
 * @param {object|null} slot
 * @returns {'empty'|'occupied'|'unavailable'}
 */
export function classifySlot(slot) {
  if (!slot || typeof slot !== 'object') return SLOT_KIND.UNAVAILABLE;
  if (slot.status === 'empty') return SLOT_KIND.EMPTY;
  if (slot.status === 'occupied') {
    return isSlotRecordValid(slot) ? SLOT_KIND.OCCUPIED : SLOT_KIND.UNAVAILABLE;
  }
  return SLOT_KIND.UNAVAILABLE;
}

/**
 * The first slot a **New Game** can start in, in New Game mode.
 *
 * A New Game must never dead-end on the slot screen: the first *loadable*
 * empty slot wins, then — if every slot is occupied — the first occupied slot
 * so the player can still reach the one-step OVERWRITE path. Corrupt/unknown
 * records are never defaulted into because deleting one is the only valid
 * action for them.
 *
 * @param {object[]} slots - slot metadata in display order
 * @returns {number|null} 1-based slot index, or null when nothing is selectable
 */
export function firstNewGameSlotIndex(slots) {
  const list = Array.isArray(slots) ? slots : [];
  const empty = list.find(slot => classifySlot(slot) === SLOT_KIND.EMPTY);
  if (empty) return empty.slotIndex;
  const occupied = list.find(slot => classifySlot(slot) === SLOT_KIND.OCCUPIED);
  return occupied ? occupied.slotIndex : null;
}

/**
 * A short, player-facing label for the New Game prompt: `SLOT 3 — NEW GAME`.
 * @param {number|null} slotIndex
 * @returns {string}
 */
export function newGameActionLabel(slotIndex) {
  return Number.isInteger(slotIndex) && slotIndex >= 1
    ? `SLOT ${slotIndex} — NEW GAME`
    : 'NEW GAME';
}

/**
 * Renders a slot's display summary. Corrupt records get an explicit label so a
 * destructive confirm never claims a fabricated vocation/level.
 * @param {object} slot
 * @returns {string}
 */
export function slotSummary(slot) {
  return classifySlot(slot) === SLOT_KIND.UNAVAILABLE ? 'DATA UNAVAILABLE' : summarizeSlot(slot);
}

/**
 * Renders the destructive-confirm summary for an occupied slot.
 * @param {object} slot
 * @returns {string}
 */
export function summarizeSlot(slot) {
  const vocation = String(slot?.vocation || 'unknown').toUpperCase();
  const level = Number(slot?.level) || 1;
  const floor = Number(slot?.currentFloor) || 1;
  return `${vocation} — Level ${level}, Floor ${floor}`;
}

/**
 * Formats playtime for a slot card: "New" under a minute, else "Xh Ym".
 * @param {number} ms
 * @returns {string}
 */
export function formatPlaytime(ms) {
  const totalMs = Number(ms) || 0;
  if (totalMs < 60000) return 'New';
  const totalMinutes = Math.floor(totalMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Resolves the effective reduce-motion boolean from a setting + system pref.
 * @param {'system'|'on'|'off'} setting
 * @param {boolean} systemPrefersReduced
 * @returns {boolean}
 */
export function resolveReducedMotion(setting, systemPrefersReduced) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return Boolean(systemPrefersReduced);
}

/**
 * Merges raw persisted options over the catalog defaults. Unknown keys are
 * dropped, numeric ranges are clamped, invalid enums fall back to defaults,
 * and missing keys are filled. Never throws.
 * @param {object|null} raw
 * @returns {object}
 */
export function normalizeOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const [key, fallback] of Object.entries(OPTION_DEFAULTS)) {
    const value = source[key];
    if (value === undefined || value === null) {
      result[key] = fallback;
      continue;
    }

    if (typeof fallback === 'boolean') {
      result[key] = typeof value === 'boolean' ? value : Boolean(value);
      continue;
    }

    if (typeof fallback === 'number') {
      const range = OPTION_RANGES[key] || {};
      let num = Number(value);
      if (!Number.isFinite(num)) {
        result[key] = fallback;
        continue;
      }
      if (typeof range.min === 'number') num = Math.max(range.min, num);
      if (typeof range.max === 'number') num = Math.min(range.max, num);
      result[key] = num;
      continue;
    }

    if (key === 'reduceMotion') {
      result[key] = REDUCE_MOTION_VALUES.includes(value) ? value : fallback;
      continue;
    }

    const allowed = OPTION_RANGES[key];
    if (allowed && typeof allowed === 'object') {
      result[key] = Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback;
      continue;
    }

    result[key] = value;
  }
  return result;
}

/**
 * Pure planner for the v1 -> v2 single-save migration.
 *
 * Returns the exact writes the storage layer must perform. When the guard is
 * already present the migration is a no-op. When there is no legacy
 * character, only the guard is written.
 *
 * @param {object[]} legacyCharacters
 * @param {object[]} legacyFloors
 * @param {object|null} guard - existing `migration_slot_v2` record
 * @returns {{ alreadyDone: boolean, guard: object|null, slot: object|null, character: object|null, floors: object[] }}
 */
export function planLegacyMigration(legacyCharacters, legacyFloors, guard = null) {
  if (guard && guard.done) {
    return { alreadyDone: true, guard: null, slot: null, character: null, floors: [] };
  }

  const guardRecord = {
    key: 'migration_slot_v2',
    done: true,
    migratedAt: null,
    fromCharacterId: null,
  };

  const characters = Array.isArray(legacyCharacters) ? legacyCharacters.filter(Boolean) : [];
  if (characters.length === 0) {
    return { alreadyDone: false, guard: guardRecord, slot: null, character: null, floors: [] };
  }

  const newest = characters.slice().sort((a, b) => {
    const timeA = a.updatedAt || a.createdAt || '';
    const timeB = b.updatedAt || b.createdAt || '';
    return timeB.localeCompare(timeA);
  })[0];

  const character = migratePlayerToTower({
    ...newest,
    slotId: slotId(1),
    slotIndex: 1,
    towerId: newest.towerId || DEFAULT_TOWER_ID,
    playtimeMs: Number(newest.playtimeMs) || 0,
    saveVersion: SAVE_FORMAT_VERSION,
  });
  const slot = deriveSlotMeta(character, 1, newest.biome || null);
  guardRecord.fromCharacterId = character.id || null;

  // Legacy 20-floor caches are intentionally dropped: their template is stale
  // and their floor numbers can exceed the tower. The character keeps its
  // clamped current floor and the generator rebuilds valid floors on load.
  void legacyFloors;

  return { alreadyDone: false, guard: guardRecord, slot, character, floors: [] };
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
