/**
 * Lokarta: Data Catalog Barrel & Loader
 */

import cardsData from './cards.json' with { type: 'json' };
import monstersData from './monsters.json' with { type: 'json' };
import itemsData from './items.json' with { type: 'json' };
import vocationsData from './vocations.json' with { type: 'json' };
import soundsData from './sounds.json' with { type: 'json' };
import abilitiesData from './abilities.json' with { type: 'json' };
import biomesData from './biomes.json' with { type: 'json' };
import encountersData from './encounters.json' with { type: 'json' };
import dungeonsData from './dungeons.json' with { type: 'json' };
import towerLevelsData from './tower_levels.json' with { type: 'json' };
import doorsData from './doors.json' with { type: 'json' };
import chestsData from './chests.json' with { type: 'json' };
import tileThemesData from './tile_themes.json' with { type: 'json' };
import keybindingsData from './keybindings.json' with { type: 'json' };
import uiData from './ui.json' with { type: 'json' };
import economyData from './economy.json' with { type: 'json' };

/**
 * Tower registry: `tower_levels.json` holds a set of full tower definitions.
 * All selection goes through these pure helpers so the rest of the engine reads
 * a selected tower by id instead of hardcoding the original five-level spire.
 */
const TOWER_CATALOG = towerLevelsData;
const TOWERS = Array.isArray(TOWER_CATALOG.towers) ? TOWER_CATALOG.towers : [];
export const DEFAULT_TOWER_ID =
  TOWER_CATALOG.defaultTowerId || (TOWERS[0] && TOWERS[0].id) || 'spire_of_light';
const TOWER_BY_ID = new Map(TOWERS.map((tower) => [tower.id, tower]));

/** Resolves a tower definition by id, falling back to the default tower. */
export function getTowerDefinition(towerId) {
  return TOWER_BY_ID.get(towerId) || TOWER_BY_ID.get(DEFAULT_TOWER_ID) || TOWERS[0] || null;
}

/** All authored tower definitions in catalog order. */
export function listTowerDefinitions() {
  return TOWERS.slice();
}

const DEFAULT_TOWER = getTowerDefinition(DEFAULT_TOWER_ID);

/** Highest playable level of a tower (>= 1). */
export function towerLevelCount(towerId) {
  const tower = getTowerDefinition(towerId);
  const n = Math.floor(Number(tower?.levelCount));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Clamps an arbitrary level number onto a tower's 1..levelCount range. */
export function clampToTowerLevel(levelNumber, towerId) {
  const n = Math.floor(Number(levelNumber));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(towerLevelCount(towerId), n));
}

/** The per-level definition for a tower (array of `levels`). */
export function towerLevelSpec(levelNumber, towerId) {
  const tower = getTowerDefinition(towerId);
  const specs = tower && tower.levels;
  if (!Array.isArray(specs) || specs.length === 0) return null;
  return specs[clampToTowerLevel(levelNumber, towerId) - 1] || null;
}

export const TOWER_CATALOG_ROOT = TOWER_CATALOG;
export const TOWERS_CATALOG = TOWERS;
export const DEFAULT_TOWER_DEFINITION = DEFAULT_TOWER;

/**
 * Backward-compatible resolved view of the default tower. Every legacy key
 * (`levelCount`, `levels`, `stairShaft`, ...) still resolves, while the full
 * multi-tower set is exposed through `towers` / the registry helpers above.
 */
export const TOWER_LEVELS_CATALOG = {
  ...(DEFAULT_TOWER || {}),
  defaultTowerId: DEFAULT_TOWER_ID,
  towers: TOWERS,
};

export const CARDS_CATALOG = cardsData;
export const MONSTERS_CATALOG = monstersData;
export const ITEMS_CATALOG = itemsData;
export const VOCATIONS_CATALOG = vocationsData;
export const SOUNDS_CATALOG = soundsData;
export const ABILITIES_CATALOG = abilitiesData;
export const BIOMES_CATALOG = biomesData;
export const ENCOUNTERS_CATALOG = encountersData;
export const DUNGEONS_CATALOG = dungeonsData;
export const DOORS_CATALOG = doorsData;
export const CHESTS_CATALOG = chestsData;
export const TILE_THEMES_CATALOG = tileThemesData;
export const KEYBINDINGS_CATALOG = keybindingsData;
export const UI_CATALOG = uiData;
export const ECONOMY_CATALOG = economyData;

