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
import movementData from './movement.json' with { type: 'json' };
import deathEffectsData from './death_effects.json' with { type: 'json' };
import partyAiData from './party_ai.json' with { type: 'json' };
import islandsData from './islands.json' with { type: 'json' };
import townsData from './towns.json' with { type: 'json' };
import npcsData from './npcs.json' with { type: 'json' };
import questsData from './quests.json' with { type: 'json' };
import dialoguesData from './dialogues.json' with { type: 'json' };
import codexData from './codex.json' with { type: 'json' };

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

/**
 * Campaign order of a tower. Uses the authored `order` field when present and
 * otherwise falls back to catalog array position, so a catalog authored before
 * `order` existed still resolves a deterministic sequence.
 */
export function towerOrder(towerId) {
  const tower = getTowerDefinition(towerId);
  if (!tower) return 1;
  const explicit = Math.floor(Number(tower.order));
  if (Number.isFinite(explicit) && explicit >= 1) return explicit;
  const idx = TOWERS.findIndex((t) => t && t.id === tower.id);
  return idx >= 0 ? idx + 1 : 1;
}

/** All authored towers sorted by campaign order. */
export function listTowerDefinitionsByOrder() {
  return TOWERS.slice().sort((a, b) => towerOrder(a.id) - towerOrder(b.id));
}

/** Id of the first tower in campaign order (always unlocked at campaign start). */
export function firstTowerId() {
  const ordered = listTowerDefinitionsByOrder();
  return (ordered[0] && ordered[0].id) || DEFAULT_TOWER_ID;
}

/** True when `towerId` identifies an authored tower. */
export function isTowerId(towerId) {
  return TOWER_BY_ID.has(towerId);
}

/**
 * Tower ids that must be completed before `towerId` unlocks. Reads the authored
 * `unlockRequires` array when present; otherwise derives "the previous tower by
 * order", with the first tower requiring nothing.
 */
export function towerUnlockRequires(towerId) {
  const tower = getTowerDefinition(towerId);
  if (!tower) return [];
  if (Array.isArray(tower.unlockRequires)) {
    return tower.unlockRequires.filter((id) => TOWER_BY_ID.has(id) && id !== tower.id);
  }
  const ordered = listTowerDefinitionsByOrder();
  const idx = ordered.findIndex((t) => t.id === tower.id);
  return idx > 0 ? [ordered[idx - 1].id] : [];
}

/** Tower ids whose unlock requirement is satisfied by completing `completedTowerId`. */
export function towersUnlockedBy(completedTowerId) {
  return TOWERS.filter((t) => towerUnlockRequires(t.id).includes(completedTowerId)).map((t) => t.id);
}

/** The next tower after `towerId` in campaign order, or null at the end. */
export function nextTowerIdAfter(towerId) {
  const ordered = listTowerDefinitionsByOrder();
  const idx = ordered.findIndex((t) => t.id === towerId);
  return idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1].id : null;
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

/**
 * Reverse index of catalog-declared `aliases` (e.g. `abyssal_overlord` carries
 * `["boss_overlord"]`). Lets legacy persisted monster types resolve to their
 * current definition without any `type === 'boss_overlord'` branch in JS.
 * Built once at module load.
 */
const MONSTER_ALIASES = new Map();
for (const [key, def] of Object.entries(monstersData)) {
  if (def && Array.isArray(def.aliases)) {
    for (const alias of def.aliases) MONSTER_ALIASES.set(alias, key);
  }
}

/**
 * Resolves a monster definition by catalog key, following any declared alias.
 * Unknown keys return undefined so callers keep their existing fallbacks.
 */
export function resolveMonsterDefinition(monsterType) {
  if (!monsterType) return undefined;
  return monstersData[monsterType]
    || monstersData[MONSTER_ALIASES.get(monsterType)]
    || undefined;
}

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
export const MOVEMENT_CATALOG = movementData;
export const PARTY_AI_CATALOG = partyAiData;
export const DEATH_EFFECTS_CATALOG = deathEffectsData;

/**
 * Resolved procedural-squish style (LIV-140). Opponents without authored death
 * frames flatten toward their ground point over the death effect's `totalMs`;
 * this is a draw-time transform of the existing artwork, never a re-bake. Every
 * field falls back so a partial/absent catalog can never break a defeat.
 */
export const PROCEDURAL_SQUISH = (() => {
  const s = deathEffectsData?.proceduralSquish || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: s.enabled !== false,
    squashY: num(s.squashY, 0.92),
    widenX: num(s.widenX, 0.12),
    minScaleY: num(s.minScaleY, 0.08),
  };
})();

/**
 * Scene registries (LIV-59 P0). Islands and towns are catalog-authored compact
 * tilemaps (character rows + legend) that `services/scene-composer.js` composes
 * into the numeric tile matrix the engine consumes. Selection always goes
 * through these pure helpers — no per-island/per-town branches in JS.
 */
const ISLANDS = Array.isArray(islandsData.islands) ? islandsData.islands : [];
const ISLAND_BY_ID = new Map(ISLANDS.map((island) => [island.id, island]));
export const DEFAULT_ISLAND_ID =
  islandsData.defaultIslandId || (ISLANDS[0] && ISLANDS[0].id) || null;

/** Resolves an island definition by id, or null. */
export function getIslandDefinition(islandId) {
  return ISLAND_BY_ID.get(islandId) || null;
}

/** All authored island definitions in catalog order. */
export function listIslandDefinitions() {
  return ISLANDS.slice();
}

const TOWNS = Array.isArray(townsData.towns) ? townsData.towns : [];
const TOWN_BY_ID = new Map(TOWNS.map((town) => [town.id, town]));
export const DEFAULT_TOWN_ID =
  townsData.defaultTownId || (TOWNS[0] && TOWNS[0].id) || null;

/** Resolves a town definition by id, or null. */
export function getTownDefinition(townId) {
  return TOWN_BY_ID.get(townId) || null;
}

/** All authored town definitions in catalog order. */
export function listTownDefinitions() {
  return TOWNS.slice();
}

/** Unified scene registry entry: `{ id, kind: 'island'|'town', def }`, or null. */
export function getSceneDefinition(sceneId) {
  if (ISLAND_BY_ID.has(sceneId)) return { id: sceneId, kind: 'island', def: ISLAND_BY_ID.get(sceneId) };
  if (TOWN_BY_ID.has(sceneId)) return { id: sceneId, kind: 'town', def: TOWN_BY_ID.get(sceneId) };
  return null;
}

/** All authored scene entries (islands then towns) in catalog order. */
export function listSceneDefinitions() {
  return [
    ...ISLANDS.map((def) => ({ id: def.id, kind: 'island', def })),
    ...TOWNS.map((def) => ({ id: def.id, kind: 'town', def })),
  ];
}

/** The island whose `towerId` matches, or null (tower -> overworld lookup). */
export function islandForTower(towerId) {
  return ISLANDS.find((island) => island.towerId === towerId) || null;
}

/** The island a town belongs to (by `islandId`), or null. */
export function islandForTown(townId) {
  const town = TOWN_BY_ID.get(townId);
  return town && town.islandId ? ISLAND_BY_ID.get(town.islandId) || null : null;
}

const NPCS = Array.isArray(npcsData.npcs) ? npcsData.npcs : [];
const NPC_BY_ID = new Map(NPCS.map((npc) => [npc.id, npc]));

/** Resolves an NPC definition by id, or null. */
export function getNpcDefinition(npcId) {
  return NPC_BY_ID.get(npcId) || null;
}

/** NPC definitions, optionally filtered to one scene. */
export function listNpcDefinitions(sceneId = null) {
  return sceneId ? NPCS.filter((npc) => npc.sceneId === sceneId) : NPCS.slice();
}

const QUESTS = Array.isArray(questsData.quests) ? questsData.quests : [];
const QUEST_BY_ID = new Map(QUESTS.map((quest) => [quest.id, quest]));

/** Resolves a quest definition by id, or null. */
export function getQuestDefinition(questId) {
  return QUEST_BY_ID.get(questId) || null;
}

/** All authored quest definitions in catalog order. */
export function listQuestDefinitions() {
  return QUESTS.slice();
}

const DIALOGUES = dialoguesData.dialogues || {};

/** Resolves a dialogue tree by id, or null. */
export function getDialogueDefinition(dialogueId) {
  return DIALOGUES[dialogueId] || null;
}

/** All authored dialogue trees keyed by id. */
export function listDialogueDefinitions() {
  return DIALOGUES;
}

export const ISLANDS_CATALOG = islandsData;
export const TOWNS_CATALOG = townsData;
export const NPCS_CATALOG = npcsData;
export const QUESTS_CATALOG = questsData;
export const DIALOGUES_CATALOG = dialoguesData;

/**
 * Bestiary/Codex catalog (I10). References foes by `id` into `monsters.json`;
 * only reading aids (role/tier/silhouette/telegraph) are authored here. The
 * pure resolver + discovery model lives in `engine/codex-system.js`.
 */
export const CODEX_CATALOG = codexData;

