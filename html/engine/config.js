/**
 * Lokarta: Come Into The Light - Engine Configuration & Constants
 */

import { VOCATIONS_CATALOG, MONSTERS_CATALOG, ABILITIES_CATALOG, UI_CATALOG, ECONOMY_CATALOG, KEYBINDINGS_CATALOG, DEFAULT_TOWER_ID } from '../data/index.js';
import { PARTY_FACTION } from './faction.js';

/**
 * Numeric tile codes. `0..6` are the original tower tiles; `7..15` are the
 * scene tiles appended for the island/town overworld (LIV-59 P0). Appending
 * (never renumbering) keeps every persisted floor matrix valid.
 */
export const TILE_TYPES = {
  FLOOR: 0,
  WALL: 1,
  STAIRS: 2,
  DOOR: 3,
  GATED_DOOR: 4,
  SPRING: 5,
  TOWN_GATE: 6,
  WATER: 7,
  GRASS: 8,
  SAND: 9,
  PATH: 10,
  TREE: 11,
  BRIDGE: 12,
  BUILDING_WALL: 13,
  DOORWAY: 14,
  TOWER_ENTRANCE: 15,
};

/**
 * Tile codes that always block movement regardless of any per-tile state.
 * Water is the overworld's impassable border; trees and building bodies are
 * solid scenery (LIV-55 D6). Doors/gates/springs resolve their own rules in
 * `GridMap.isWalkable`.
 */
export const IMPASSABLE_TILE_TYPES = new Set([
  TILE_TYPES.WALL,
  TILE_TYPES.WATER,
  TILE_TYPES.TREE,
  TILE_TYPES.BUILDING_WALL,
]);

const LOADOUT_KEYS = UI_CATALOG?.hud?.loadout || {};
const BACKPACK_LAYOUT = UI_CATALOG?.inventory?.backpack || {};

/** Catalog-driven inventory layout (no hardcoded slot counts). */
export const INVENTORY_CONFIG = {
  ACTIVE_SLOTS: Number(LOADOUT_KEYS.activeKeys?.length) || Number(UI_CATALOG?.inventory?.activeSlots) || 4,
  EQUIPMENT_SLOTS: Number(LOADOUT_KEYS.equipmentKeys?.length) || Number(UI_CATALOG?.inventory?.equipmentSlots) || 4,
  BACKPACK_SLOTS: Number(BACKPACK_LAYOUT.defaultSlots) || 36,
  BACKPACK_COLUMNS: Number(BACKPACK_LAYOUT.columns) || 6,
  BACKPACK_ROWS: Number(BACKPACK_LAYOUT.rows) || 6,
  STARTING_GOLD: Number(ECONOMY_CATALOG?.gold?.starting) || 0,
  GOLD_CAP: Number(ECONOMY_CATALOG?.gold?.cap) || 999999,
};

/** Ordered active-slot key labels (`["1","2","3","4"]`) from the catalog. */
export const ACTIVE_SLOT_KEYS = Array.isArray(LOADOUT_KEYS.activeKeys) && LOADOUT_KEYS.activeKeys.length
  ? LOADOUT_KEYS.activeKeys.map(String)
  : ['1', '2', '3', '4'];

/** `{ q: "main_hand", ... }` equipment-key map from `keybindings.json.keySlots`. */
export const EQUIPMENT_KEY_MAP = KEYBINDINGS_CATALOG?.keySlots?.equipment || {
  q: 'main_hand',
  w: 'off_hand',
  e: 'armor',
  r: 'relic',
};

/** Ordered equipment slots (`main_hand`/`off_hand`/`armor`/`relic`). */
export const EQUIPMENT_SLOT_KEYS = Object.values(EQUIPMENT_KEY_MAP);

/**
 * Party-member cycle bindings (`keybindings.json.party`), as keyboard-event
 * codes: `prev` steps to the previous living member, `next` to the following
 * one. Safe baseline mirrors the catalog (LIV-27 / FIX-12).
 */
export const PARTY_CYCLE_BINDINGS = KEYBINDINGS_CATALOG?.party || {
  prev: ['KeyA'],
  next: ['KeyS'],
};

export const CONFIG = {
  GRID_SIZE: 64, // pixels per tile
  MAP_WIDTH: 40,
  MAP_HEIGHT: 40,
  TICK_INTERVAL_MS: 100, // 10 Hz fixed simulation tick

  // Inventory & Slots (catalog-driven; see INVENTORY_CONFIG / D1 §2.6)
  ACTIVE_SLOT_COUNT: INVENTORY_CONFIG.ACTIVE_SLOTS,
  EQUIPMENT_SLOT_COUNT: INVENTORY_CONFIG.EQUIPMENT_SLOTS,
  BACKPACK_SLOTS: INVENTORY_CONFIG.BACKPACK_SLOTS,

  // Gesture Timings (ms)
  TAP_MAX_MS: 250,
  HOLD_MIN_MS: 250,
  HOLD_MAX_MS: 1200,
  DOUBLE_TAP_MAX_MS: 300,

  // Hold-to-autofire timings (ms) for the mobile ability bar,
  // resolved from `keybindings.json.autofire`.
  AUTOFIRE_HOLD_MS: Number(KEYBINDINGS_CATALOG?.autofire?.holdMs) || 2000,
  AUTOFIRE_REPEAT_MS: Number(KEYBINDINGS_CATALOG?.autofire?.repeatMs) || 200,
  AUTOFIRE_FEEDBACK_MS: Number(KEYBINDINGS_CATALOG?.autofire?.feedbackMs) || 1200,

  // Lighting
  BASE_LIGHT_RADIUS: 10,
  LIGHT_SPELL_RADIUS: ABILITIES_CATALOG.magician_light.lightRadius || 13,
  LIGHT_SPELL_DURATION_SEC: ABILITIES_CATALOG.magician_light.durationSec || 30,
  AMBIENT_LIGHT_RADIUS: 4,

  // Abilities & Combat Base Values (Driven by ABILITIES_CATALOG)
  MAGICIAN_SPARK_DAMAGE_MIN: ABILITIES_CATALOG.magician_spark.damageMin,
  MAGICIAN_SPARK_DAMAGE_MAX: ABILITIES_CATALOG.magician_spark.damageMax,
  MAGICIAN_SPARK_RANGE: ABILITIES_CATALOG.magician_spark.range,
  MAGICIAN_SPARK_MANA_COST: ABILITIES_CATALOG.magician_spark.manaCost,
  MAGICIAN_SPARK_COOLDOWN_SEC: ABILITIES_CATALOG.magician_spark.cooldownSec,

  MAGICIAN_LIGHT_MANA_COST: ABILITIES_CATALOG.magician_light.manaCost,
  MAGICIAN_LIGHT_COOLDOWN_SEC: ABILITIES_CATALOG.magician_light.cooldownSec,

  MAGICIAN_BEAM_MANA_COST: ABILITIES_CATALOG.magician_beam.manaCost,
  MAGICIAN_BEAM_DAMAGE_MIN: ABILITIES_CATALOG.magician_beam.damageMin,
  MAGICIAN_BEAM_DAMAGE_MAX: ABILITIES_CATALOG.magician_beam.damageMax,
  MAGICIAN_BEAM_RANGE: ABILITIES_CATALOG.magician_beam.range,
  MAGICIAN_BEAM_COOLDOWN_SEC: ABILITIES_CATALOG.magician_beam.cooldownSec,

  ARCHER_BOW_DAMAGE_MIN: ABILITIES_CATALOG.archer_bow_shot.damageMin,
  ARCHER_BOW_DAMAGE_MAX: ABILITIES_CATALOG.archer_bow_shot.damageMax,
  ARCHER_BOW_RANGE: ABILITIES_CATALOG.archer_bow_shot.range,
  ARCHER_BOW_COOLDOWN_SEC: ABILITIES_CATALOG.archer_bow_shot.cooldownSec,

  ARCHER_POWER_SHOT_DAMAGE_MIN: ABILITIES_CATALOG.archer_power_shot.damageMin,
  ARCHER_POWER_SHOT_DAMAGE_MAX: ABILITIES_CATALOG.archer_power_shot.damageMax,
  ARCHER_POWER_SHOT_RANGE: ABILITIES_CATALOG.archer_power_shot.range,
  ARCHER_POWER_SHOT_COOLDOWN_SEC: ABILITIES_CATALOG.archer_power_shot.cooldownSec,

  FIGHTER_SLASH_DAMAGE_MIN: ABILITIES_CATALOG.fighter_slash.damageMin,
  FIGHTER_SLASH_DAMAGE_MAX: ABILITIES_CATALOG.fighter_slash.damageMax,
  FIGHTER_SLASH_COOLDOWN_SEC: ABILITIES_CATALOG.fighter_slash.cooldownSec,

  FIGHTER_CLEAVE_MANA_COST: ABILITIES_CATALOG.fighter_cleave.manaCost,
  FIGHTER_CLEAVE_DAMAGE_MIN: ABILITIES_CATALOG.fighter_cleave.damageMin,
  FIGHTER_CLEAVE_DAMAGE_MAX: ABILITIES_CATALOG.fighter_cleave.damageMax,
  FIGHTER_CLEAVE_COOLDOWN_SEC: ABILITIES_CATALOG.fighter_cleave.cooldownSec,

  PALADIN_HOLY_STRIKE_MANA_COST: ABILITIES_CATALOG.paladin_holy_strike.manaCost,
  PALADIN_HOLY_STRIKE_DAMAGE_MIN: ABILITIES_CATALOG.paladin_holy_strike.damageMin,
  PALADIN_HOLY_STRIKE_DAMAGE_MAX: ABILITIES_CATALOG.paladin_holy_strike.damageMax,
  PALADIN_HOLY_STRIKE_COOLDOWN_SEC: ABILITIES_CATALOG.paladin_holy_strike.cooldownSec,

  PALADIN_HEAL_MANA_COST: ABILITIES_CATALOG.paladin_heal.manaCost,
  PALADIN_HEAL_MIN: ABILITIES_CATALOG.paladin_heal.healMin,
  PALADIN_HEAL_MAX: ABILITIES_CATALOG.paladin_heal.healMax,
  PALADIN_HEAL_COOLDOWN_SEC: ABILITIES_CATALOG.paladin_heal.cooldownSec,

  // Monster standoff range (catalog-derived). All other monster stats
  // (hp/attack/defense/damage/cadence/aiType) are read live from
  // MONSTERS_CATALOG in entity-ai.js and floor-generator.js.
  CULTIST_STANDOFF_MIN: MONSTERS_CATALOG.shadow_cultist.standoffMin,
  CULTIST_STANDOFF_MAX: MONSTERS_CATALOG.shadow_cultist.standoffMax,
};

function emptySlots(n) {
  return new Array(n).fill(null);
}

function buildArchetype(vocKey) {
  const data = VOCATIONS_CATALOG[vocKey] || VOCATIONS_CATALOG.magician;
  return {
    id: data.id,
    vocation: data.vocation,
    // Every player-shaped actor is on the party faction; the friendly-fire guard
    // in combat-system.js reads this. Monsters declare `monsters` in the catalog.
    faction: PARTY_FACTION,
    hp: data.hp,
    max_hp: data.hp,
    mana: data.mana,
    max_mana: data.mana,
    // LIV-44 knockout lifecycle (derived from hp; explicit so the save and the
    // active mirror never disagree). `combatState` is the approved-plan field;
    // `lifeState` is the tech-plan alias, written together.
    combatState: 'active',
    lifeState: 'alive',
    downedAtSec: 0,
    reviveGraceSec: 0,
    downCount: 0,
    autoReviveTotalSec: 0,
    autoReviveRemainingSec: 0,
    level: 1,
    xp: 0,
    xpToNextLevel: 100,
    current_floor: 1,
    towerId: DEFAULT_TOWER_ID,
    x: 2,
    y: 2,
    facing: 'right',
    lightSpellTimer: 0,
    cooldowns: {},
    skillBoosts: {
      damageMultiplier: 1.0,
      bonusRange: 0,
      bonusRegen: 0,
    },
    // Active-item hotbar: 1-4 (consumables/usables triggered by key).
    action_bar: emptySlots(INVENTORY_CONFIG.ACTIVE_SLOTS),
    paperdoll: {
      main_hand: null,
      off_hand: null,
      armor: null,
      relic: null,
    },
    // Single backpack grid: default 36 slots (6x6).
    backpack: emptySlots(INVENTORY_CONFIG.BACKPACK_SLOTS),
    // Gold economy.
    gold: INVENTORY_CONFIG.STARTING_GOLD,
    // Town / descent state: a run starts in the Town.
    location: 'town',
    townVisits: 0,
    // Healing spring charge tracking: per-floor id -> timestamp.
    springCharges: {},
    // Per-level earned keys: { "1": { copper: true, ... }, ... }. Keys are tracked
    // on the character (not inventory) and persist across floor transitions.
    levelKeys: {},
    // LOK-12 gear-stat tracking: applied hpBonus/manaBonus totals across the
    // paperdoll. Fresh characters start at 0 so the first equip applies the
    // full bonus; legacy saves without these keys are treated as already baked.
    _gearBonusMaxHp: 0,
    _gearBonusMaxMana: 0,
  };
}

export const DEFAULT_ARCHETYPES = {
  magician: buildArchetype('magician'),
  archer: buildArchetype('archer'),
  fighter: buildArchetype('fighter'),
  paladin: buildArchetype('paladin'),
};

/**
 * Creates a cloned player instance from archetype.
 * @param {'magician'|'archer'|'fighter'|'paladin'} [vocation='magician']
 * @param {string} [id]
 * @returns {object}
 */
export function createPlayer(vocation = 'magician', id = null) {
  const normVoc = (vocation || 'magician').toLowerCase();
  const archetype = DEFAULT_ARCHETYPES[normVoc] || DEFAULT_ARCHETYPES.magician;
  const clone = JSON.parse(JSON.stringify(archetype));
  if (id) {
    clone.id = id;
  }
  return clone;
}
