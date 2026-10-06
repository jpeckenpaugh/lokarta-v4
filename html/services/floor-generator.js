/**
 * Lokarta: Come Into The Light - Deterministic Tower Floor Generator
 *
 * Generates the 5-level tower defined by D2 (`docs/level-design.md`):
 * a 3x3 nine-room floor per level, a room-2 doorway on level 1, a deterministic
 * two-way stair shaft, and copper/silver/gold gated doors that can never
 * soft-lock the player.
 *
 * Layout is seed-independent; only seeded jitter/rolls vary. The output is
 * therefore deterministic for a fixed (level, seed) pair.
 */

import {
  MONSTERS_CATALOG,
  ITEMS_CATALOG,
  BIOMES_CATALOG,
  DUNGEONS_CATALOG,
  CHESTS_CATALOG,
  TILE_THEMES_CATALOG,
  DEFAULT_TOWER_ID,
  getTowerDefinition,
  listTowerDefinitions,
  towerLevelCount,
  towerLevelSpec,
} from '../data/index.js';
import { PROP_MANIFEST } from '../assets/sprites/index.js';

export const TILE_TYPES = {
  FLOOR: 0,
  WALL: 1,
  STAIRS: 2,
  DOOR: 3,
  GATED_DOOR: 4,
  SPRING: 5,
  TOWN_GATE: 6,
};

/**
 * Level count of the default tower. Kept as a convenience export for the many
 * legacy call sites that predate multi-tower selection; new code should use
 * `getTowerLevelCount(towerId)` so it tracks the selected tower.
 */
export const TOWER_LEVEL_COUNT = towerLevelCount(DEFAULT_TOWER_ID);

/** Highest playable level of the selected tower. */
export function getTowerLevelCount(towerId = DEFAULT_TOWER_ID) {
  return towerLevelCount(towerId);
}

/** The authored tower definitions (id/name/theme/levelCount/...), in order. */
export function listTowers() {
  return listTowerDefinitions();
}

const GATE_TIERS = ['copper', 'silver', 'gold'];

/**
 * Version of the current dungeon floor-generation template.
 * Bumped whenever the template/layout logic changes so cached floors from
 * older templates can be detected and regenerated (see game-worker.js).
 * v1 = legacy thick-walled layout; v2 = 1-tile-thick walls + 64px overhaul;
 * v3 = 5-level tower (gated rooms + two-way stair shaft).
 */
export const FLOOR_TEMPLATE_VERSION = DUNGEONS_CATALOG.standard_40x40?.templateVersion || 1;

function biomeEntry(id) {
  const b = BIOMES_CATALOG[id] || {};
  return {
    name: b.name,
    minLevel: b.minLevel,
    maxLevel: b.maxLevel,
    lightColor: b.lightColor,
  };
}

export const BIOMES = {
  CRYPT: biomeEntry('crypt'),
  CATACOMBS: biomeEntry('catacombs'),
  SHADOW_VAULTS: biomeEntry('shadow_vaults'),
  ABYSSAL_SANCTUM: biomeEntry('abyssal_sanctum'),
  CROWN_SPIRE: biomeEntry('crown_spire'),
};

/**
 * Creates a deterministic Mulberry32 PRNG from an integer seed.
 * @param {number|string} [seed] - Optional seed
 * @returns {Function & { random: Function, randomInt: Function, randomFloat: Function, choice: Function }}
 */
export function createPRNG(seed) {
  let s = 0;
  if (typeof seed === 'number') {
    s = seed >>> 0;
  } else if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    }
  } else {
    s = 1337;
  }

  function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const prng = function () {
    return next();
  };

  prng.random = function () {
    return next();
  };

  prng.randomInt = function (min, max) {
    return Math.floor(next() * (max - min + 1)) + min;
  };

  prng.randomFloat = function (min, max) {
    return next() * (max - min) + min;
  };

  prng.choice = function (array) {
    if (!array || array.length === 0) return null;
    const idx = Math.floor(next() * array.length);
    return array[idx];
  };

  return prng;
}

/**
 * Clamps an arbitrary floor number onto the 5-level tower.
 * @param {number} floorNumber
 * @returns {number} 1..5
 */
export function clampLevel(floorNumber, towerId = DEFAULT_TOWER_ID) {
  const n = Math.floor(Number(floorNumber));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(towerLevelCount(towerId), n));
}

/**
 * Returns tier info (display name + light color) for a tower level. The biome
 * is resolved from the level's authored `tierId` first (so two towers may reuse
 * the same biome palette at different depths); the min/max-level scan is only a
 * legacy fallback.
 * @param {number} floorNumber
 * @param {string} [towerId]
 * @returns {{ name: string, lightColor: string }}
 */
export function getBiomeForFloor(floorNumber, towerId = DEFAULT_TOWER_ID) {
  const level = clampLevel(floorNumber, towerId);
  const spec = getLevelSpec(level, towerId);
  const direct = spec && BIOMES_CATALOG[spec.tierId];
  const biome =
    direct ||
    Object.values(BIOMES_CATALOG).find(
      b => level >= b.minLevel && level <= b.maxLevel
    ) ||
    BIOMES_CATALOG.crown_spire;
  return { name: biome.name, lightColor: biome.lightColor };
}

/**
 * The per-level definition for a tower (from `tower_levels.json`).
 * @param {number} levelNumber
 * @param {string} [towerId]
 * @returns {object}
 */
export function getLevelSpec(levelNumber, towerId = DEFAULT_TOWER_ID) {
  return towerLevelSpec(levelNumber, towerId);
}

/**
 * Resolves the chest tier for a room from the D2 §7.2 rule: room tier 0 →
 * copper, tier 1/2 → silver, tier 3 → gold, with the gold-key room overridden
 * to gold. Pure catalog derivation — no hardcoded room tables.
 * @param {object} levelSpec - tower_levels level entry
 * @param {number} room - 1..9
 * @returns {'copper'|'silver'|'gold'}
 */
export function chestTierForRoom(levelSpec, room, tower = null) {
  const rule =
    (tower && tower.chestTierRule) ||
    getTowerDefinition(DEFAULT_TOWER_ID)?.chestTierRule ||
    {};
  const byRoomTier = rule.byRoomTier || {};
  const goldKeyRoom = levelSpec?.keyRooms?.gold;
  if (goldKeyRoom && Number(goldKeyRoom) === Number(room)) {
    return rule.goldKeyRoomOverride || 'gold';
  }
  const roomTier = levelSpec?.roomTiers?.[String(room)];
  return byRoomTier[String(roomTier)] || 'copper';
}

/**
 * Rolls a chest's contents from the CHESTS_CATALOG tier table. Entries are
 * weighted and drawn without replacement; `vocationGear` entries resolve to an
 * item from the opener's vocation pool filtered by `lootTier`, with neutral
 * items always eligible ("smart loot", D2 §7.3).
 *
 * @param {'copper'|'silver'|'gold'} tier
 * @param {object} [opts]
 * @param {string} [opts.vocation] - opener vocation for smart loot
 * @param {Function} [opts.rng] - createPRNG-compatible generator
 * @returns {object[]} rolled item stacks `{ item_id, name, type, quantity, ... }`
 */
export function rollChestLoot(tier, opts = {}) {
  const table = CHESTS_CATALOG?.chests?.[tier] || CHESTS_CATALOG?.chests?.copper;
  if (!table || !Array.isArray(table.entries) || table.entries.length === 0) return [];

  const rng = opts.rng || createPRNG(`${tier}_loot`);
  const vocation = opts.vocation || null;
  const rolls = Math.max(0, Math.min(table.entries.length, table.rolls || 1));

  // Copy the entries so "without replacement" never mutates the catalog.
  const pool = table.entries.slice();
  const loot = [];
  for (let i = 0; i < rolls; i++) {
    const total = pool.reduce((sum, e) => sum + (e.weight || 0), 0);
    let ticket = rng.random() * total;
    let idx = pool.length - 1;
    for (let p = 0; p < pool.length; p++) {
      ticket -= pool[p].weight || 0;
      if (ticket <= 0) {
        idx = p;
        break;
      }
    }
    const entry = pool.splice(idx, 1)[0];
    const stack = resolveChestEntry(entry, vocation, rng);
    if (stack) loot.push(stack);
  }
  return loot;
}

/** Resolves one loot-table entry into a concrete item stack. */
function resolveChestEntry(entry, vocation, rng) {
  const qty = rollQuantity(entry.quantity, rng);
  if (entry.vocationGear) {
    const def = pickVocationGear(entry.lootTier, vocation, rng);
    if (!def) return null;
    return { ...itemStackFromDef(def, 1), quantity: qty };
  }
  const def = ITEMS_CATALOG[entry.itemId] || {};
  const stack = itemStackFromDef(def, qty, entry.itemId);
  if (entry.displayName) stack.name = entry.displayName;
  return stack;
}

/** Rolls an inclusive [min,max] quantity, defaulting to 1. */
function rollQuantity(range, rng) {
  if (!Array.isArray(range) || range.length < 2) return 1;
  const min = Number(range[0]) || 0;
  const max = Number(range[1]) || min;
  return rng.randomInt(min, max);
}

/** Builds a serializable item stack from an items.json definition. */
function itemStackFromDef(def, quantity, fallbackId = null) {
  return {
    item_id: def.item_id || fallbackId,
    name: def.name || fallbackId || 'Unknown Item',
    type: def.type || 'item',
    quantity,
    ...(def.stat_bonus !== undefined ? { stat_bonus: def.stat_bonus } : {}),
    ...(def.icon ? { icon: def.icon } : {}),
    ...(def.svgCode ? { svgCode: def.svgCode } : {}),
    ...(def.slot ? { slot: def.slot } : {}),
    ...(def.vocationAffinity ? { vocationAffinity: def.vocationAffinity } : {}),
    ...(def.actionKey ? { actionKey: def.actionKey } : {}),
    // Functional ability fields: a chest-looted ability item must
    // carry the same combat/upgrade data as a drafted or shop-bought one, or
    // its active would silently no-op once equipped.
    ...copyFunctionalFields(def),
  };
}

/** Catalog keys that make an equipped item's granted ability functional. */
const FUNCTIONAL_ITEM_KEYS = [
  'cooldown', 'manaCost', 'range', 'damageMin', 'damageMax', 'upgradeSpec',
  'pushbackRange', 'stunSec', 'shieldAbsorb', 'shieldDuration',
  'dodgePct', 'critChance', 'critMult', 'mitigationPct',
  'hpBonus', 'manaBonus', 'healPowerPct', 'healMin', 'healMax', 'mpRestore',
  'arrowCapacity', 'arrowCount', 'ammoRegenSec', 'grantedAmmo',
  'poisonDps', 'poisonDurationSec', 'poisonArrows', 'poisonBuffSec',
  'siphonHp', 'siphonRadius', 'rangedDamageBonus',
  'markDurationSec', 'markRange', 'markDamageMult',
];

/** Copies only the authored functional keys present on `def`. */
function copyFunctionalFields(def) {
  const out = {};
  for (const key of FUNCTIONAL_ITEM_KEYS) {
    if (def[key] !== undefined) out[key] = def[key];
  }
  return out;
}

/**
 * Picks the best usable vocation gear for the opener: eligible items are those
 * with a `lootTier` inside the entry's range whose `vocationAffinity` matches
 * the opener or is `neutral`. Falls back to any tier-eligible item when the
 * vocation has no matching pool (never fizzles).
 */
function pickVocationGear(lootTierRange, vocation, rng) {
  const [minTier, maxTier] = Array.isArray(lootTierRange) ? lootTierRange : [1, 3];
  const eligible = Object.values(ITEMS_CATALOG).filter(def => {
    if (typeof def.lootTier !== 'number') return false;
    if (def.lootTier < minTier || def.lootTier > maxTier) return false;
    if (!vocation) return true;
    const affinity = def.vocationAffinity;
    if (!affinity || affinity === 'neutral') return true;
    return Array.isArray(affinity) ? affinity.includes(vocation) : affinity === vocation;
  });
  if (eligible.length === 0) return null;
  return rng.choice(eligible);
}

/**
 * Builds the room adjacency graph for a level. Locked gate edges are omitted,
 * so the graph reflects the rooms reachable with the given keys.
 * @param {object} levelSpec - tower_levels level entry
 * @param {{ copper?: boolean, silver?: boolean, gold?: boolean }} [unlocked]
 * @returns {Record<number, Set<number>>}
 */
export function buildRoomGraph(levelSpec, unlocked = {}) {
  const edges = DUNGEONS_CATALOG.standard_40x40.edges;
  const adjacency = {};
  for (let room = 1; room <= 9; room++) adjacency[room] = new Set();

  const connect = edgeId => {
    const edge = edges[edgeId];
    if (!edge) return;
    const [a, b] = edge.rooms;
    adjacency[a].add(b);
    adjacency[b].add(a);
  };

  // `openEdges` in the D2 catalogs includes the gated edges; a gate edge only
  // connects when its tier is unlocked, so exclude them from the free edges.
  const gateEdgeIds = new Set(GATE_TIERS.map(t => levelSpec.gates[t]).filter(Boolean));
  for (const edgeId of levelSpec.openEdges || []) {
    if (!gateEdgeIds.has(edgeId)) connect(edgeId);
  }
  for (const tier of GATE_TIERS) {
    if (unlocked[tier] && levelSpec.gates[tier]) connect(levelSpec.gates[tier]);
  }

  return adjacency;
}

/** BFS room reachability from a start room. */
export function reachableRooms(adjacency, startRoom) {
  const seen = new Set([startRoom]);
  const queue = [startRoom];
  while (queue.length > 0) {
    const room = queue.shift();
    for (const next of adjacency[room] || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * D2 §10 soft-lock oracle. Verifies the strict key order on a level:
 * entry -> copper -> [copper gate] -> silver -> [silver gate] -> gold ->
 * [gold gate] -> stair room, and that no later target is reachable early.
 *
 * @param {number|object} level - level number or a tower_levels level entry
 * @returns {{ ok: boolean, level: number, failures: string[], stages: object }}
 */
export function validateFloorSoftlock(level) {
  const levelSpec = typeof level === 'object' && level !== null ? level : getLevelSpec(level);
  const levelNumber = levelSpec.level;
  const { entryRoom, stairRoom, keyRooms } = levelSpec;
  const failures = [];
  const stage = name => {
    const graph = buildRoomGraph(levelSpec, {
      copper: name !== 'entry',
      silver: name === 'silver' || name === 'gold',
      gold: name === 'gold',
    });
    return reachableRooms(graph, entryRoom);
  };

  const r0 = stage('entry');
  if (!r0.has(keyRooms.copper)) failures.push('copper holder unreachable from entry');
  if (r0.has(keyRooms.silver)) failures.push('silver holder reachable before copper gate');
  if (r0.has(keyRooms.gold)) failures.push('gold holder reachable before copper gate');
  if (r0.has(stairRoom)) failures.push('stair room reachable before gold gate');

  const r1 = stage('copper');
  if (!r1.has(keyRooms.silver)) failures.push('silver holder unreachable after copper gate');
  if (r1.has(keyRooms.gold)) failures.push('gold holder reachable before silver gate');
  if (r1.has(stairRoom)) failures.push('stair room reachable before gold gate');

  const r2 = stage('silver');
  if (!r2.has(keyRooms.gold)) failures.push('gold holder unreachable after silver gate');
  if (r2.has(stairRoom)) failures.push('stair room reachable before gold gate');

  const r3 = stage('gold');
  if (!r3.has(stairRoom)) failures.push('stair room unreachable after gold gate');

  return {
    ok: failures.length === 0,
    level: levelNumber,
    failures,
    stages: {
      entry: [...r0].sort((a, b) => a - b),
      copper: [...r1].sort((a, b) => a - b),
      silver: [...r2].sort((a, b) => a - b),
      gold: [...r3].sort((a, b) => a - b),
    },
  };
}

/**
 * Throws when a level can soft-lock. Mirrors the D2 §10 reference oracle.
 * @param {number|object} level
 * @returns {true}
 */
export function assertNoSoftlock(level) {
  const result = validateFloorSoftlock(level);
  if (!result.ok) {
    throw new Error(`Level ${result.level} soft-lock: ${result.failures.join('; ')}`);
  }
  return true;
}

function neighbors(x, y) {
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ];
}

/** True when a tile can be walked on in the structural BFS (walls + blockers). */
function isPassableForBfs(matrix, x, y, blockedSet) {
  if (!matrix[y] || matrix[y][x] === undefined) return false;
  if (matrix[y][x] === TILE_TYPES.WALL) return false;
  return !blockedSet.has(`${x},${y}`);
}

/**
 * Structural BFS from `start` over non-WALL tiles that are not in `blockedSet`.
 * No heap allocation in the loop beyond the worklist (called outside the tick).
 */
function reachableFrom(matrix, width, height, start, blockedSet) {
  const visited = new Set();
  if (!start || !isPassableForBfs(matrix, start.x, start.y, blockedSet)) return visited;
  visited.add(`${start.x},${start.y}`);
  const queue = [{ x: start.x, y: start.y }];
  let head = 0;
  while (head < queue.length) {
    const { x, y } = queue[head++];
    for (const n of neighbors(x, y)) {
      const key = `${n.x},${n.y}`;
      if (visited.has(key)) continue;
      if (n.x < 0 || n.x >= width || n.y < 0 || n.y >= height) continue;
      if (!isPassableForBfs(matrix, n.x, n.y, blockedSet)) continue;
      visited.add(key);
      queue.push(n);
    }
  }
  return visited;
}

/** Blocking tiles for the structural walkability graph: springs + furniture props. */
function structuralBlockedTiles(floor) {
  const blocked = new Set();
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      if (floor.tiles[y][x] === TILE_TYPES.SPRING) blocked.add(`${x},${y}`);
    }
  }
  for (const spring of floor.springs || []) blocked.add(`${spring.x},${spring.y}`);
  for (const prop of floor.props || []) {
    if (prop && prop.layer === 'prop') blocked.add(`${prop.x},${prop.y}`);
  }
  return blocked;
}

/**
 * Tile-level BFS from the spawn tile over every structurally walkable tile:
 * walls, healing-spring fountains and placed furniture props
 * all block. Gated doors count as passable here — the
 * structural no-soft-lock guarantee comes from `validateFloorSoftlock`; this
 * proves the carved floor stays connected under the blocking decor.
 * @param {object} floor
 * @returns {{ ok: boolean, reached: number, unreachableStairs: object[] }}
 */
export function validateFloorConnectivity(floor) {
  const { width, height } = floor;
  const blockedSet = structuralBlockedTiles(floor);
  const visited = reachableFrom(floor.tiles, width, height, floor.spawn_coords, blockedSet);

  const unreachableStairs = (floor.stairs || []).filter(
    s => !visited.has(`${s.x},${s.y}`)
  );

  return { ok: unreachableStairs.length === 0, reached: visited.size, unreachableStairs };
}

/** Ordered free tiles in a room, rotated so `anchor` is scanned first. */
function orderedCandidates(room, blocked, anchor) {
  const [x1, y1, x2, y2] = room;
  const tiles = [];
  for (let y = y1 + 1; y <= y2 - 1; y++) {
    for (let x = x1 + 1; x <= x2 - 1; x++) {
      if (blocked.has(`${x},${y}`)) continue;
      tiles.push({ x, y });
    }
  }
  if (!anchor) return tiles;
  const idx = tiles.findIndex(t => t.x === anchor.x && t.y === anchor.y);
  if (idx > 0) return tiles.slice(idx).concat(tiles.slice(0, idx));
  return tiles;
}

/** Takes the first free tile from an anchor-rotated candidate list. */
function takeCandidate(room, blocked, anchor, occupied) {
  for (const tile of orderedCandidates(room, blocked, anchor)) {
    if (occupied.has(`${tile.x},${tile.y}`)) continue;
    occupied.add(`${tile.x},${tile.y}`);
    return tile;
  }
  return null;
}

/**
 * Every FLOOR tile in a room's full carved bounds, excluding `blocked` tiles.
 * Unlike `orderedCandidates` (which insets by 1) this includes the perimeter
 * ring, so it is the candidate source for wall-first chest placement and for
 * prop placement (D4 §5/§7).
 */
function roomBoundsCandidates(room, blocked, matrix) {
  const [x1, y1, x2, y2] = room;
  const tiles = [];
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      if (matrix[y] && matrix[y][x] !== undefined && matrix[y][x] !== TILE_TYPES.FLOOR) continue;
      if (blocked.has(`${x},${y}`)) continue;
      tiles.push({ x, y });
    }
  }
  return tiles;
}

/** True when a tile has a WALL (pillar) or boundary 4-neighbour. */
function hasWallNeighbour(x, y, matrix) {
  for (const n of neighbors(x, y)) {
    if (!matrix[n.y] || matrix[n.y][n.x] === undefined) return true;
    if (matrix[n.y][n.x] === TILE_TYPES.WALL) return true;
  }
  return false;
}

/** In-place Fisher–Yates using the generator's seeded rng (deterministic). */
function seededShuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng.random() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

/** Resolves a theme prop id (no prefix) to its PROP_MANIFEST key, or null. */
function propManifestKey(id) {
  if (!id) return null;
  if (PROP_MANIFEST[id]) return id;
  if (PROP_MANIFEST[`prop_${id}`]) return `prop_${id}`;
  if (PROP_MANIFEST[`decor_${id}`]) return `decor_${id}`;
  return null;
}

/** `class` of a themed prop id: 'wall' | 'free' | 'decor' (default 'free'). */
function propClassOf(id) {
  const key = propManifestKey(id);
  return (key && PROP_MANIFEST[key].class) || 'free';
}

/**
 * Class-aware, de-duplicated prop pick. A wall-class prop is only returned for
 * a tile that has a WALL neighbour; `wantWall` biases the preference but never
 * violates the class constraint (D4 §5).
 */
function pickFromSet(set, tileCls, wantWall, rng, used) {
  const free = set.filter(id => propClassOf(id) === 'free');
  const wall = set.filter(id => propClassOf(id) === 'wall');
  let pool;
  if (tileCls === 'free') pool = free;
  else pool = wantWall ? wall.concat(free) : free.concat(wall);
  if (pool.length === 0) pool = set.slice();
  const fresh = pool.filter(id => !used.has(id));
  const choice = fresh.length ? fresh : pool;
  return choice.length ? rng.choice(choice) : null;
}

/**
 * Ordered chest candidates: full room bounds, north-wall-adjacent tiles first
 * (a bottom-anchored chest reads correctly backed against the top wall), then
 * any other wall-adjacent tile, then the remaining tiles. `anchor` rotates the
 * tie-break order inside each tier (D4 §7).
 */
function orderedCandidatesWallFirst(room, blocked, anchor, matrix) {
  const all = roomBoundsCandidates(room, blocked, matrix);
  const north = [];
  const side = [];
  const rest = [];
  for (const tile of all) {
    const above = matrix[tile.y - 1] && matrix[tile.y - 1][tile.x];
    if (above === TILE_TYPES.WALL) north.push(tile);
    else if (hasWallNeighbour(tile.x, tile.y, matrix)) side.push(tile);
    else rest.push(tile);
  }
  const rotate = list => {
    if (!anchor || list.length === 0) return list;
    const idx = list.findIndex(t => t.x === anchor.x && t.y === anchor.y);
    return idx > 0 ? list.slice(idx).concat(list.slice(0, idx)) : list;
  };
  return rotate(north).concat(rotate(side), rotate(rest));
}

/** Takes the first unoccupied tile from a wall-first candidate order. */
function takeWallFirstCandidate(room, blocked, anchor, occupied, matrix) {
  for (const tile of orderedCandidatesWallFirst(room, blocked, anchor, matrix)) {
    if (occupied.has(`${tile.x},${tile.y}`)) continue;
    occupied.add(`${tile.x},${tile.y}`);
    return tile;
  }
  return null;
}

/** Nearest eligible FLOOR tile to `start` for a prop of `propCls`, or null. */
function findNearestPropTile(start, room, propCls, blocked, matrix, hardExclude) {
  const [x1, y1, x2, y2] = room;
  const tiles = [];
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const key = `${x},${y}`;
      if (matrix[y][x] !== TILE_TYPES.FLOOR) continue;
      if (blocked.has(key) || (hardExclude && hardExclude.has(key))) continue;
      if (propCls === 'wall' && !hasWallNeighbour(x, y, matrix)) continue;
      tiles.push({ x, y, d: Math.abs(x - start.x) + Math.abs(y - start.y) });
    }
  }
  tiles.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return tiles[0] || null;
}

/**
 * Resolves a tower level to its `tile_themes.json` entry via the tower's
 * data-authored `theme.levelTheme` map. Unknown ids fall back to the raw level
 * number, then to the root theme, so no renderer code changes are needed to add
 * a tower with a distinct palette ordering.
 */
function themeLevelFor(levelId, tower) {
  const root = TILE_THEMES_CATALOG;
  const map = tower && tower.theme && tower.theme.levelTheme;
  const key = map ? (map[String(levelId)] ?? String(levelId)) : String(levelId);
  const level = root.levels && root.levels[key];
  return level ? { ...root, ...level } : root;
}

/** Resolved level theme's `props` block (data-driven; no per-level code). */
function themePropsForLevel(levelId, tower) {
  const theme = themeLevelFor(levelId, tower);
  return theme.props || null;
}

function round(n) {
  return Math.round(n);
}

/**
 * Generates a complete 40x40 tower floor for levels 1 to 5.
 *
 * @param {number} floorNumber - Level index (clamped to 1..5)
 * @param {number|string} [seed] - Optional custom PRNG seed
 * @returns {object} floor payload (tiles + structural metadata + entities)
 */
export function generateFloor(floorNumber = 1, seed = null, towerId = DEFAULT_TOWER_ID) {
  const tower = getTowerDefinition(towerId);
  const resolvedTowerId = tower.id;
  const levelCount = towerLevelCount(resolvedTowerId);
  const levelId = clampLevel(floorNumber, resolvedTowerId);
  const levelSpec = getLevelSpec(levelId, resolvedTowerId);
  const dungeonSpec = DUNGEONS_CATALOG.standard_40x40;
  const rooms = dungeonSpec.rooms;
  const roomCenters = dungeonSpec.roomCenters;
  const edges = dungeonSpec.edges;
  const width = dungeonSpec.width || 40;
  const height = dungeonSpec.height || 40;

  const prngSeed = seed !== null && seed !== undefined ? seed : 1337 + levelId * 42;
  const rng = createPRNG(prngSeed);

  const { name: biomeName, lightColor } = getBiomeForFloor(levelId, resolvedTowerId);
  const levelName = `${biomeName}`;

  // 1. Initialize all walls.
  const matrix = Array.from({ length: height }, () => Array(width).fill(TILE_TYPES.WALL));

  // 2. Carve the nine rooms.
  for (const [x1, y1, x2, y2] of rooms) {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        matrix[y][x] = TILE_TYPES.FLOOR;
      }
    }
  }

  // 3. Decorative pillars in the center room on odd levels (D2 §2.2).
  const pillars = levelId % 2 === 1 ? dungeonSpec.pillars || [] : [];
  for (const [px, py] of pillars) {
    if (matrix[py] && matrix[py][px] !== undefined) matrix[py][px] = TILE_TYPES.WALL;
  }

  // 4. Carve open edges (cosmetic DOOR) and gate edges (GATED_DOOR).
  const gates = {};
  for (const edgeId of levelSpec.openEdges || []) {
    for (const [tx, ty] of edges[edgeId].tiles) matrix[ty][tx] = TILE_TYPES.DOOR;
  }
  for (const tier of GATE_TIERS) {
    const edgeId = levelSpec.gates[tier];
    if (!edgeId) continue;
    const tiles = edges[edgeId].tiles;
    for (const [tx, ty] of tiles) matrix[ty][tx] = TILE_TYPES.GATED_DOOR;
    gates[tier] = { edge: edgeId, tiles: tiles.map(([x, y]) => ({ x, y })) };
  }

  // 5. Entry (level 1) or arrival spawn (levels 2-5).
  const stairShaft = tower.stairShaft;
  const stairTiles = tower.stairTiles;
  const upRoom = levelId > 1 ? stairShaft[String(levelId - 1)] : null;
  const upTile = upRoom ? { x: stairTiles[String(upRoom)][0], y: stairTiles[String(upRoom)][1] } : null;
  const downRoom = levelSpec.stairRoom;
  const downTile = levelSpec.isFinal
    ? { x: stairTiles[String(downRoom)][0], y: stairTiles[String(downRoom)][1] }
    : { x: stairTiles[String(downRoom)][0], y: stairTiles[String(downRoom)][1] };

  let spawnCoords;
  let entryCoords;
  // Picks a walkable neighbour of a stair tile, preferring the one nearest the
  // room center. Used to land the player beside (never on) a connecting stair.
  const stairNeighbor = (stairTile, center) => {
    if (!stairTile) return null;
    const candidates = neighbors(stairTile.x, stairTile.y)
      .map(n => ({ ...n, d: Math.abs(n.x - center[0]) + Math.abs(n.y - center[1]) }))
      .sort((a, b) => a.d - b.d);
    const free = candidates.find(
      n => matrix[n.y] && matrix[n.y][n.x] !== TILE_TYPES.WALL
    );
    return free ? { x: free.x, y: free.y } : { x: stairTile.x, y: stairTile.y };
  };

  if (levelId === 1) {
    const entry = tower.entry;
    entryCoords = { x: entry.doorTile[0], y: entry.doorTile[1] };
    spawnCoords = { x: entry.spawnTile[0], y: entry.spawnTile[1] };
    matrix[entryCoords.y][entryCoords.x] = TILE_TYPES.DOOR;
  } else {
    entryCoords = { ...upTile };
    // Spawn one tile away from the arrival stair so it never auto-retriggers.
    spawnCoords = stairNeighbor(upTile, roomCenters[String(levelSpec.entryRoom)]);
  }

  // Runtime arrival landings: entering from a lower level lands beside this
  // level's up-stair; entering from an upper level lands beside this level's
  // down-stair (the "exit"), never back at the entrance (D2 §3).
  const arrivalFromLower = levelId > 1 ? { ...spawnCoords } : null;
  const arrivalFromUpper = levelId < levelCount
    ? stairNeighbor(downTile, roomCenters[String(downRoom)])
    : null;

  // 6. Stairs. Up-stair on levels 2-5; down-stair on levels 1-4; the level-5
  //    summit tile stands in for the final objective.
  const stairs = [];
  if (upTile) {
    matrix[upTile.y][upTile.x] = TILE_TYPES.STAIRS;
    stairs.push({ x: upTile.x, y: upTile.y, dir: 'up', targetLevel: levelId - 1 });
  }
  if (levelSpec.isFinal) {
    matrix[downTile.y][downTile.x] = TILE_TYPES.STAIRS;
    stairs.push({ x: downTile.x, y: downTile.y, dir: 'summit', targetLevel: null });
  } else {
    matrix[downTile.y][downTile.x] = TILE_TYPES.STAIRS;
    stairs.push({ x: downTile.x, y: downTile.y, dir: 'down', targetLevel: levelId + 1 });
  }

  const stairUp = stairs.find(s => s.dir === 'up') || null;
  const stairDown = stairs.find(s => s.dir === 'down') || null;
  const summit = stairs.find(s => s.dir === 'summit') || null;
  const exitCoords = stairDown ? { x: stairDown.x, y: stairDown.y } : { x: summit.x, y: summit.y };

  // 7. Ambient lights at room centers plus the exit/summit.
  const ambientLights = (dungeonSpec.ambientLightNodes || []).map(node => ({
    x: node.x,
    y: node.y,
    radius: node.radius,
    color: lightColor,
  }));
  ambientLights.push({
    x: exitCoords.x,
    y: exitCoords.y,
    radius: 5,
    color: levelSpec.isFinal ? '#ffd700' : '#38bdf8',
  });

  // 8. Deterministic entity placement (D2 §9.2).
  const occupied = new Set();
  for (const [px, py] of pillars) occupied.add(`${px},${py}`);
  for (const s of stairs) occupied.add(`${s.x},${s.y}`);
  occupied.add(`${spawnCoords.x},${spawnCoords.y}`);
  if (levelId === 1) occupied.add(`${entryCoords.x},${entryCoords.y}`);
  if (arrivalFromLower) occupied.add(`${arrivalFromLower.x},${arrivalFromLower.y}`);
  if (arrivalFromUpper) occupied.add(`${arrivalFromUpper.x},${arrivalFromUpper.y}`);

  const blocked = new Set(occupied);
  const roles = tower.placement.roles;
  const absAnchor = (room, offset) => {
    const center = roomCenters[String(room)];
    return { x: center[0] + offset[0], y: center[1] + offset[1] };
  };

  // 8. Healing spring: one per floor, placed in the stair room
  //    beside the connecting exit stair, claiming its tile before monsters so
  //    nothing overlaps it. Catalog-driven heal/charge live in `economy.json`.
  const springs = [];
  const springRoom = levelSpec.stairRoom;
  if (springRoom) {
    const springTile = neighbors(exitCoords.x, exitCoords.y).find(n => {
      if (!matrix[n.y] || matrix[n.y][n.x] === undefined) return false;
      if (matrix[n.y][n.x] !== TILE_TYPES.FLOOR) return false;
      if (blocked.has(`${n.x},${n.y}`)) return false;
      return n.x !== spawnCoords.x || n.y !== spawnCoords.y;
    });
    if (springTile) {
      matrix[springTile.y][springTile.x] = TILE_TYPES.SPRING;
      blocked.add(`${springTile.x},${springTile.y}`);
      occupied.add(`${springTile.x},${springTile.y}`);
      springs.push({ id: `f${levelId}_spring`, room: springRoom, x: springTile.x, y: springTile.y });
    }
  }

  // 8.5 Tower Gate: a walk-on interactable in each floor's
  //     arrival room for bidirectional Town <-> Tower navigation. Placed beside
  //     the arrival spawn on a free floor tile, before monsters claim tiles.
  const townGates = [];
  const townGatePolicy = tower.townGatePolicy || {};
  const gateRoom = townGatePolicy.roomRole === 'stair' ? levelSpec.stairRoom : levelSpec.entryRoom;
  const gateAnchor = levelId === 1 ? entryCoords : spawnCoords;
  if (townGatePolicy.countPerLevel !== 0 && gateRoom && gateAnchor) {
    const gateTile = neighbors(gateAnchor.x, gateAnchor.y).find(n => {
      if (!matrix[n.y] || matrix[n.y][n.x] === undefined) return false;
      if (matrix[n.y][n.x] !== TILE_TYPES.FLOOR) return false;
      if (blocked.has(`${n.x},${n.y}`)) return false;
      return true;
    });
    if (gateTile) {
      matrix[gateTile.y][gateTile.x] = TILE_TYPES.TOWN_GATE;
      blocked.add(`${gateTile.x},${gateTile.y}`);
      occupied.add(`${gateTile.x},${gateTile.y}`);
      townGates.push({
        id: `f${levelId}_town_gate`,
        room: gateRoom,
        x: gateTile.x,
        y: gateTile.y,
        propId: townGatePolicy.propId || 'prop_town_gate',
      });
    }
  }

  const groupSize = tower.monsterGroups.groupSize[String(levelId)];
  const pool = tower.monsterGroups.pool[String(levelId)];
  const statScale = tower.monsterGroups.statScale[String(levelId)];
  const keyHolderType = tower.monsterGroups.keyHolderType[String(levelId)];
  const keyHolderMod = tower.monsterGroups.keyHolderModifier;
  const keyRoomTier = tier => {
    for (const t of GATE_TIERS) if (levelSpec.keyRooms[t] === tier) return t;
    return null;
  };

  // 8a. Chests: exactly one per room at its D2 §7.2 tier, placed deterministically
  //     against a room wall rather than floating mid-room.
  //     Full room bounds are scanned with north-wall tiles ordered first so the
  //     bottom-anchored chest reads as backed against the top wall; the scan keeps
  //     chests reachable (the player only steps onto the walkable tile). Chests
  //     claim their tile before monsters so the two never overlap (D2 §9.2 order).
  const chests = [];
  let chestId = 1;
  for (let room = 1; room <= 9; room++) {
    const bounds = rooms[room - 1];
    const anchor = absAnchor(room, roles.chest);
    const tile = takeWallFirstCandidate(bounds, blocked, anchor, occupied, matrix);
    if (!tile) continue;
    chests.push({
      id: `f${levelId}_chest_${chestId++}`,
      room,
      x: tile.x,
      y: tile.y,
      tier: chestTierForRoom(levelSpec, room, tower),
      opened: false,
    });
  }

  const monsters = [];
  let monsterId = 1;
  const slotOffsets = [
    roles.monsterSlot0,
    roles.monsterSlot1,
    roles.monsterSlot2,
    roles.monsterSlot3,
  ];

  const buildMonster = (type, room, tier, isKeyHolder) => {
    const base = MONSTERS_CATALOG[type] || MONSTERS_CATALOG.giant_rat;
    const hpScale = statScale.hp * (isKeyHolder ? keyHolderMod.hp : 1);
    const atkScale = statScale.atk * (isKeyHolder ? keyHolderMod.atk : 1);
    const hp = round(base.baseHp * hpScale);
    return {
      id: `f${levelId}_m_${monsterId++}`,
      type,
      name: base.name,
      room,
      hp,
      max_hp: hp,
      attack: round(base.baseAttack * atkScale),
      damageScale: atkScale,
      defense: base.baseDefense,
      facing: 'down',
      isAggroed: false,
      attackCooldown: 0,
      moveCooldown: 0,
      attackCadence: base.attackCadence,
      moveCadence: base.moveCadence,
      visible: false,
      holdsKey: isKeyHolder ? tier : null,
    };
  };

  for (let room = 1; room <= 9; room++) {
    const bounds = rooms[room - 1];
    const isKeyRoom = GATE_TIERS.some(t => levelSpec.keyRooms[t] === room);
    const holderTier = isKeyRoom ? keyRoomTier(room) : null;
    // The two arrival rooms stay empty so neither entering nor descending lands
    // the player next to a monster: the entry room (arrival from below, beside
    // the up-stair) and the stair room (arrival from above, beside the down-stair
    // = the room you descend into from the level above). No authored key room is
    // either, so progression is unaffected.
    const isArrivalRoom = room === levelSpec.entryRoom || room === levelSpec.stairRoom;
    if (isArrivalRoom) continue;

    // A key room replaces its last group slot with the tier's key holder, so it
    // still spawns exactly `groupSize` monsters.
    let regularSlots = groupSize;
    if (isKeyRoom) {
      const anchor = absAnchor(room, roles.keyHolder);
      const tile = takeCandidate(bounds, blocked, anchor, occupied);
      if (tile) {
        monsters.push(Object.assign(buildMonster(keyHolderType[holderTier], room, holderTier, true), tile));
        regularSlots -= 1;
      }
    }

    for (let slot = 0; slot < regularSlots; slot++) {
      const anchor = absAnchor(room, slotOffsets[slot % slotOffsets.length]);
      const tile = takeCandidate(bounds, blocked, anchor, occupied);
      if (!tile) continue;
      const memberType = pool[(room - 1 + slot) % pool.length];
      const monster = Object.assign(buildMonster(memberType, room, null, false), tile);
      monsters.push(monster);
    }
  }

  // Level-5 final boss + flanking guards.
  if (levelSpec.isFinal && tower.boss) {
    const bossSpec = tower.boss;
    monsters.push({
      id: `f${levelId}_boss_${bossSpec.type}`,
      type: bossSpec.type,
      name: bossSpec.name,
      room: bossSpec.room,
      x: bossSpec.tile[0],
      y: bossSpec.tile[1],
      hp: bossSpec.hp,
      max_hp: bossSpec.max_hp,
      attack: bossSpec.attack,
      damageScale: statScale.atk,
      defense: bossSpec.defense,
      facing: 'down',
      isAggroed: true,
      attackCooldown: 0,
      moveCooldown: 0,
      attackCadence: bossSpec.attackCadence,
      moveCadence: bossSpec.moveCadence,
      visible: true,
      isBoss: true,
      holdsKey: null,
    });

    const guardBase = MONSTERS_CATALOG[bossSpec.guardType] || MONSTERS_CATALOG.elite_cultist;
    const flank = [
      { x: bossSpec.tile[0] - 1, y: bossSpec.tile[1] },
      { x: bossSpec.tile[0] + 1, y: bossSpec.tile[1] },
    ];
    for (let g = 0; g < (bossSpec.guardCount || 0); g++) {
      const tile = flank[g] || flank[flank.length - 1];
      if (matrix[tile.y] && matrix[tile.y][tile.x] === TILE_TYPES.WALL) continue;
      const hp = round(guardBase.baseHp * statScale.hp);
      monsters.push({
        id: `f${levelId}_guard_${g + 1}`,
        type: bossSpec.guardType,
        name: bossSpec.guardName || guardBase.name,
        room: bossSpec.room,
        x: tile.x,
        y: tile.y,
        hp,
        max_hp: hp,
        attack: round(guardBase.baseAttack * statScale.atk),
        damageScale: statScale.atk,
        defense: guardBase.baseDefense,
        facing: 'down',
        isAggroed: true,
        attackCooldown: 0,
        moveCooldown: 0,
        attackCadence: guardBase.attackCadence,
        moveCadence: guardBase.moveCadence,
        visible: true,
        isGuard: true,
        holdsKey: null,
      });
    }
  }

  // 9. Starter cache near the entry/up-stair (D2 §7.5).
  const items = [];
  const cacheEntries = tower.starterCache[String(levelId)] || [];
  if (cacheEntries.length > 0) {
    const entryRoom = levelSpec.entryRoom;
    const anchor = absAnchor(entryRoom, roles.starterCache);
    const tile = takeCandidate(rooms[entryRoom - 1], blocked, anchor, occupied);
    if (tile) {
      for (const entry of cacheEntries) {
        const def = ITEMS_CATALOG[entry.item_id] || {};
        items.push({
          x: tile.x,
          y: tile.y,
          item_id: entry.item_id,
          name: def.name || entry.item_id,
          type: def.type || 'item',
          quantity: entry.quantity,
          stat_bonus: def.stat_bonus || 0,
        });
      }
    }
  }

  // Seeded jitter (±1 tile) on non-boss monsters; structure stays fixed.
  for (const monster of monsters) {
    if (monster.isBoss || monster.isGuard) continue;
    const jx = monster.x + rng.randomInt(-1, 1);
    const jy = monster.y + rng.randomInt(-1, 1);
    if (
      matrix[jy] &&
      matrix[jy][jx] !== TILE_TYPES.WALL &&
      !occupied.has(`${jx},${jy}`)
    ) {
      occupied.delete(`${monster.x},${monster.y}`);
      occupied.add(`${jx},${jy}`);
      monster.x = jx;
      monster.y = jy;
    }
  }

  // 10. Room props & floor decor (D4 / ). Cosmetic and non-blocking, and
  //     placed LAST from the generator's own rng (after monster jitter): the
  //     existing `occupied` set is the hard exclusion set, so a prop can never
  //     land on a chest, key holder, monster, stair, spawn, entry, arrival,
  //     pillar, or item tile. Tile/monster/item/stairs structure is unchanged,
  //     so the D2 §10 no-soft-lock proof is untouched (props are walk-over).
  const props = [];
  const propPolicy = tower.propPolicy || {};
  const themeProps = themePropsForLevel(levelId, tower);
  const levelTheme = themeLevelFor(levelId, tower);
  const flameColor = (levelTheme.features && levelTheme.features.flame) || lightColor;
  if (themeProps && Array.isArray(themeProps.set) && themeProps.set.length > 0) {
    const propBlocked = new Set(occupied);
    for (const m of monsters) propBlocked.add(`${m.x},${m.y}`);

    // Chest + neighbours spacing so the room's single reward object reads clearly.
    const chestExclude = new Set();
    const spacing = Number(propPolicy.minSpacingFromChest ?? 0);
    for (const c of chests) {
      chestExclude.add(`${c.x},${c.y}`);
      if (spacing >= 1) for (const n of neighbors(c.x, c.y)) chestExclude.add(`${n.x},${n.y}`);
    }
    const clearCenter = propPolicy.clearCenter !== false;
    const excludeForRoom = room => {
      const ex = new Set(chestExclude);
      if (clearCenter) {
        const c = roomCenters[String(room)];
        ex.add(`${c[0]},${c[1]}`);
      }
      return ex;
    };
    const pushProp = (room, tile, id, layer) => {
      propBlocked.add(`${tile.x},${tile.y}`);
      // Furniture props are blocking, so never let one wall off
      // the spawn from a stair. Decor rugs stay walk-over and need no guard.
      if (layer === 'prop') {
        const blocked = new Set();
        for (const s of springs) blocked.add(`${s.x},${s.y}`);
        for (const p of props) if (p.layer === 'prop') blocked.add(`${p.x},${p.y}`);
        blocked.add(`${tile.x},${tile.y}`);
        const reach = reachableFrom(matrix, width, height, spawnCoords, blocked);
        if (!stairs.every(s => reach.has(`${s.x},${s.y}`))) return;
      }
      props.push({
        id: `f${levelId}_prop_${props.length + 1}`,
        room,
        x: tile.x,
        y: tile.y,
        propId: layer === 'decor' ? `decor_${id}` : `prop_${id}`,
        class: layer === 'decor' ? 'decor' : propClassOf(id),
        layer,
      });
    };

    // Boss room (level 5, room 5): fixed throne flanked by two braziers, taking
    // the nearest eligible tile to each authored anchor (D4 §4/§5).
    const bossFixed = propPolicy.bossRoomFixed;
    for (let room = 1; room <= 9; room++) {
      const bounds = rooms[room - 1];
      if (levelSpec.isFinal && bossFixed && Number(bossFixed.room) === room && Array.isArray(bossFixed.props)) {
        const c = roomCenters[String(room)];
        const offsets = [[0, 1], [-2, 1], [2, 1]];
        bossFixed.props.forEach((pid, i) => {
          const off = offsets[i] || [0, 0];
          const start = { x: c[0] + off[0], y: c[1] + off[1] };
          const tile = findNearestPropTile(start, bounds, propClassOf(pid), propBlocked, matrix, excludeForRoom(room));
          if (tile) pushProp(room, tile, pid, 'prop');
        });
        continue;
      }

      const tier = levelSpec.roomTiers[String(room)];
      const cap = Math.min(
        Number(propPolicy.countByRoomTier?.[String(tier)] ?? 2),
        Number(themeProps.maxPerRoom ?? 4),
        Number(themeProps.density ?? 4)
      );
      let target = cap;
      if (room === levelSpec.entryRoom || room === levelSpec.stairRoom) {
        target = Math.min(target, Number(propPolicy.arrivalRoomMax ?? 1));
      }

      const excluded = excludeForRoom(room);
      const used = new Set();
      let placed = 0;

      // Focal guarantee: key rooms and the stair room spend one slot on the
      // theme's focal prop first, so an arrival stair room's single prop (cap 1)
      // is the focal rather than a random scatter.
      const isKeyRoom = GATE_TIERS.some(t => levelSpec.keyRooms[t] === room);
      const focal = themeProps.focal;
      if (focal && (isKeyRoom || room === levelSpec.stairRoom) && placed < target) {
        const c = roomCenters[String(room)];
        const tile = findNearestPropTile({ x: c[0], y: c[1] }, bounds, propClassOf(focal), propBlocked, matrix, excluded);
        if (tile) {
          used.add(focal);
          pushProp(room, tile, focal, 'prop');
          placed++;
        }
      }

      const candidates = seededShuffle(
        roomBoundsCandidates(bounds, propBlocked, matrix).filter(t => !excluded.has(`${t.x},${t.y}`)),
        rng
      );
      for (const tile of candidates) {
        if (placed >= target) break;
        if (propBlocked.has(`${tile.x},${tile.y}`)) continue;
        const cls = hasWallNeighbour(tile.x, tile.y, matrix) ? 'wall' : 'free';
        const wantWall = rng.random() < Number(themeProps.wallBias ?? 0.4);
        const pid = pickFromSet(themeProps.set, cls, wantWall, rng, used);
        if (!pid) continue;
        used.add(pid);
        pushProp(room, tile, pid, 'prop');
        placed++;
      }
    }

    // Decor pass: floor decals under items, one 50% roll per non-arrival room.
    if (Array.isArray(themeProps.decor) && themeProps.decor.length > 0) {
      const did = themeProps.decor[0];
      for (let room = 1; room <= 9; room++) {
        if (room === levelSpec.entryRoom || room === levelSpec.stairRoom) continue;
        if (props.some(p => p.room === room && p.layer === 'decor')) continue;
        if (rng.random() >= 0.5) continue;
        const c = roomCenters[String(room)];
        const tile = findNearestPropTile({ x: c[0], y: c[1] }, rooms[room - 1], 'decor', propBlocked, matrix, excludeForRoom(room));
        if (tile) pushProp(room, tile, did, 'decor');
      }
    }

    // Bounded brazier light: at most maxBrazierLights ambient nodes per floor.
    const maxBrazier = Number(propPolicy.maxBrazierLights ?? 0);
    let brazierLights = 0;
    for (const p of props) {
      if (p.propId !== 'prop_brazier' || brazierLights >= maxBrazier) continue;
      ambientLights.push({
        x: p.x,
        y: p.y,
        radius: Number(propPolicy.brazierLightRadius ?? 2.5),
        color: flameColor,
      });
      brazierLights++;
    }
  }

  const toCoords = tile => (tile ? { x: tile.x, y: tile.y } : null);

  return {
    floor_number: levelId,
    level: levelId,
    id: levelId,
    tower_id: resolvedTowerId,
    tower_name: tower.name || null,
    level_count: levelCount,
    template_version: FLOOR_TEMPLATE_VERSION,
    name: levelName,
    biome: biomeName,
    biome_id: levelSpec.tierId,
    biome_name: biomeName,
    width,
    height,
    tiles: matrix,
    tile_matrix: matrix,
    spawn_coords: spawnCoords,
    entrance: spawnCoords,
    entry: entryCoords,
    entry_room: levelSpec.entryRoom,
    stair_room: levelSpec.stairRoom,
    is_final: Boolean(levelSpec.isFinal),
    stairs,
    stair_up_coords: toCoords(stairUp),
    stair_down_coords: toCoords(stairDown),
    stairs_down_coords: exitCoords,
    exit: exitCoords,
    arrival_from_lower_coords: arrivalFromLower,
    arrival_from_upper_coords: arrivalFromUpper,
    open_edges: [...(levelSpec.openEdges || [])],
    sealed_edges: [...(levelSpec.sealedEdges || [])],
    gates,
    key_rooms: { ...levelSpec.keyRooms },
    room_tiers: { ...levelSpec.roomTiers },
    chests,
    chest_tiers: Object.fromEntries(chests.map(c => [String(c.room), c.tier])),
    springs,
    town_gates: townGates,
    props,
    monsters,
    spawns: monsters,
    items,
    initial_loot: items,
    ambient_lights: ambientLights,
  };
}

/**
 * Resolves where the player should land after traversing from `fromFloor` into
 * `floor`. Arriving from a lower level lands beside the target's up-stair;
 * arriving from a higher level lands beside the target's down-stair (the "exit"),
 * never back at the level entrance. Falls back to the spawn for same-level or
 * legacy floors that predate the arrival metadata.
 *
 * @param {object} floor - generated floor payload
 * @param {number} [fromFloor] - the floor the player came from
 * @returns {{ x: number, y: number }|null}
 */
export function resolveArrivalCoords(floor, fromFloor) {
  if (!floor) return null;
  const towerId = floor.tower_id || DEFAULT_TOWER_ID;
  const to = clampLevel(floor.floor_number ?? floor.level ?? floor.id ?? 1, towerId);
  const from = clampLevel(fromFloor ?? to, towerId);
  if (from < to) {
    return floor.arrival_from_lower_coords || floor.spawn_coords || floor.entrance || null;
  }
  if (from > to) {
    return floor.arrival_from_upper_coords || floor.spawn_coords || floor.entrance || null;
  }
  return floor.spawn_coords || floor.entrance || null;
}
