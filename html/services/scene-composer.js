/**
 * Lokarta: Come Into The Light - Scene Composer
 *
 * Pure, browser-free composition of catalog-authored compact tilemaps
 * (character rows + legend) into the numeric tile matrix the engine's
 * `GridMap`/`applyDungeonData` path already consumes (LIV-55 §5 / LIV-57 §2.2).
 *
 * This module owns no gameplay: it only turns data into a scene descriptor.
 * Islands and towns both resolve through the same composer with a `scene_kind`,
 * so there are no per-island branches in JS (LIV-59 P0).
 */

import { TILE_TYPES, IMPASSABLE_TILE_TYPES } from '../engine/config.js';
import {
  getSceneDefinition,
  listNpcDefinitions,
  listQuestDefinitions,
} from '../data/index.js';

/** Tile-type names resolvable from a `legend` value. */
const TILE_BY_NAME = Object.freeze(
  Object.fromEntries(Object.entries(TILE_TYPES).map(([name, code]) => [name, code]))
);

/**
 * Scene solids are impassable everywhere. `GridMap.isWalkable` reads the same
 * set at runtime; this mirror exists so the composer stays dependency-free of
 * the grid instance when validating reachability.
 */
const SCENE_SOLID_CODES = new Set([
  TILE_TYPES.WALL,
  TILE_TYPES.WATER,
  TILE_TYPES.TREE,
  TILE_TYPES.BUILDING_WALL,
]);

/**
 * Codes the access BFS may pass. Doors/gates/springs are treated as passable so
 * "can the spawn reach the tower entrance in principle" is answered
 * independent of any runtime lock (the Tide Gate opens on the quest).
 */
function isAccessPassable(code) {
  return !SCENE_SOLID_CODES.has(code);
}

/** Runtime walkability for a raw tile code (no tile state available). */
export function isCodeWalkable(code) {
  if (IMPASSABLE_TILE_TYPES.has(code)) return false;
  if (code === TILE_TYPES.SPRING) return false;
  return true;
}

/** Resolves a legend value (tile-type name) to its numeric code, or null. */
export function tileCodeForName(name) {
  const code = TILE_BY_NAME[name];
  return Number.isInteger(code) ? code : null;
}

/**
 * Builds a `char -> numeric tile code` map from a legend.
 * Unknown legend values resolve to FLOOR with a warning-level record so a
 * partial catalog degrades instead of crashing the composer.
 *
 * @param {Record<string, string>} legend
 * @param {{ warn?: (msg: string) => void }} [opts]
 * @returns {Record<string, number>}
 */
export function resolveLegend(legend, opts = {}) {
  const out = {};
  for (const [char, name] of Object.entries(legend || {})) {
    const code = tileCodeForName(name);
    if (code === null) {
      if (opts.warn) opts.warn(`unknown tile type "${name}" for legend char "${char}"`);
      out[char] = TILE_TYPES.FLOOR;
    } else {
      out[char] = code;
    }
  }
  return out;
}

/**
 * Parses character map rows into the numeric tile matrix the engine consumes.
 * Rows are padded/truncated to a rectangle; unknown chars become FLOOR.
 *
 * @param {string[]} rows
 * @param {Record<string, number>} charToCode
 * @returns {number[][]}
 */
export function parseTilemap(rows, charToCode) {
  const list = Array.isArray(rows) ? rows : [];
  const height = list.length;
  let width = 0;
  for (const row of list) width = Math.max(width, String(row).length);
  const matrix = [];
  for (let y = 0; y < height; y++) {
    const row = String(list[y]);
    const out = new Array(width);
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      const code = charToCode[ch];
      out[x] = Number.isInteger(code) ? code : TILE_TYPES.FLOOR;
    }
    matrix.push(out);
  }
  return matrix;
}

/** Integer-keyed BFS over raw tile codes. Returns the reachable `x,y` set. */
export function reachableFrom(tiles, start, isPassable = isAccessPassable) {
  const reachable = new Set();
  if (!tiles.length || !start) return reachable;
  const height = tiles.length;
  const width = tiles[0].length;
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return reachable;
  const queue = [sy * width + sx];
  reachable.add(`${sx},${sy}`);
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const x = cell % width;
    const y = (cell - x) / width;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const key = `${nx},${ny}`;
      if (reachable.has(key)) continue;
      if (!isPassable(tiles[ny][nx])) continue;
      reachable.add(key);
      queue.push(ny * width + nx);
    }
  }
  return reachable;
}

function copyPortal(portal) {
  return { ...portal, target: portal.target ? { ...portal.target } : null };
}

/**
 * Deterministic integer hash for a scattered prop. Integer-exact across runs
 * (mirrors `sprite-renderer.js` `tileHash`); never `Math.random()`, so the same
 * tile always yields the same variant + angle.
 */
function scatterHash(x, y, salt) {
  const s = String(salt || '').length ? salt.length * 2654435761 : 0;
  return (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ s) >>> 0));
}

/**
 * Expands a scene's authored `props[]` plus any declarative `propScatter[]`
 * rules into the flat prop list the renderer draws (LIV-137).
 *
 * A scatter rule names a blocking tile type (`tile`, e.g. `"TREE"`) and a
 * weighted `variants` list of 3D-baked props. Every map cell of that tile emits
 * one prop chosen deterministically by tile coordinate, so the Dawnreach Isle's
 * scattered trees become pale-coloured 3D palms/rocks at varied sizes + angles
 * WITHOUT touching the tile collision contract (the tile stays solid; the prop
 * is drawn in the non-blocking `decor` layer). Data-driven: adding a variant is
 * a catalog entry, never a JS branch.
 */
export function expandSceneProps(def, tiles, width, height) {
  const props = (def.props || []).map((prop) => ({ ...prop }));
  for (const rule of def.propScatter || []) {
    const code = tileCodeForName(rule.tile);
    const variants = (rule.variants || []).filter((v) => v && v.propId);
    if (code === null || variants.length === 0) continue;
    const weights = variants.map((v) => (Number(v.weight) > 0 ? Number(v.weight) : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (tiles[y][x] !== code) continue;
        const h = scatterHash(x, y, rule.tile);
        let pick = h % total;
        let vi = 0;
        for (; vi < variants.length - 1; vi++) {
          if (pick < weights[vi]) break;
          pick -= weights[vi];
        }
        const variant = variants[vi];
        const frames = Array.isArray(variant.frames) && variant.frames.length ? variant.frames : ['idle'];
        const frame = frames[Math.floor(h / 31) % frames.length];
        props.push({
          propId: variant.propId,
          x,
          y,
          layer: rule.layer || 'decor',
          frame,
          scatter: rule.tile,
        });
      }
    }
  }
  return props;
}

function interactablesFor(kind, def) {
  const out = [];
  for (const entry of def.interactables || []) {
    out.push({ kind: 'object', ...entry });
  }
  if (kind === 'town') {
    for (const building of def.buildings || []) {
      if (!building.door) continue;
      out.push({
        kind: 'building',
        id: building.id,
        name: building.name,
        x: building.door.x,
        y: building.door.y,
        interaction: building.interaction ? { ...building.interaction } : null,
        npcId: building.npcId || null,
      });
    }
  }
  return out;
}

/**
 * Composes a catalog island or town definition into a scene descriptor.
 * Deterministic and side-effect free.
 *
 * @param {'island'|'town'} kind
 * @param {object} def - island/town catalog entry
 * @returns {object} scene descriptor
 */
export function composeScene(kind, def) {
  if (!def || typeof def !== 'object') {
    throw new Error(`composeScene: missing ${kind} definition`);
  }
  const charToCode = resolveLegend(def.legend);
  const tiles = parseTilemap(def.map, charToCode);
  const width = tiles[0] ? tiles[0].length : 0;
  const height = tiles.length;
  return {
    sceneId: def.id,
    sceneKind: kind,
    name: def.name || def.id,
    theme: def.theme || null,
    biome: def.biome || null,
    lighting: def.lighting || 'cave',
    width,
    height,
    tiles,
    spawn: def.spawn ? { x: def.spawn.x, y: def.spawn.y } : { x: 1, y: 1 },
    // Town return teleporter placement (LIV-75). Authored data only; the live
    // spot is activated per save by the app when a last-exited tower exists.
    returnSpot: def.returnSpot ? { ...def.returnSpot } : null,
    portals: (def.portals || []).map(copyPortal),
    interactables: interactablesFor(kind, def),
    gates: (def.gates || []).map((gate) => ({ ...gate, tiles: (gate.tiles || []).map((t) => [...t]) })),
    npcs: listNpcDefinitions(def.id).map((npc) => ({ ...npc })),
    groundItems: (def.groundItems || []).map((item) => ({ ...item })),
    questSpawns: (def.questSpawns || []).map((spawn) => ({ ...spawn })),
    landmarks: (def.landmarks || []).map((landmark) => ({ ...landmark })),
    safeZones: (def.safeZones || []).map((zone) => ({ ...zone })),
    spawnZones: (def.spawnZones || []).map((zone) => ({ ...zone })),
    // LIV-100: authored scene props are emitted so the renderer draws them.
    // Placement is pure catalog data (towns.json/islands.json `props[]`); the
    // `layer` field (prop | decor) decides blocking vs walk-over. LIV-137 adds
    // declarative `propScatter[]` (tile -> weighted 3D prop variants) so a
    // scattered overworld (Dawnreach Isle) becomes 3D palms/rocks without
    // hand-authoring one prop per tile.
    props: expandSceneProps(def, tiles, width, height),
    // LIV-100: town building footprints are emitted so a per-building silhouette
    // hook can key a renderer on the building's `silhouette` (or id) through a
    // dispatch table. Additive and empty for scenes that author no buildings.
    buildings: kind === 'town'
      ? (def.buildings || []).map((building) => ({
          id: building.id,
          name: building.name || building.id,
          footprint: Array.isArray(building.footprint) ? building.footprint.slice() : null,
          door: building.door ? { ...building.door } : null,
          silhouette: building.silhouette || null,
        }))
      : [],
    islandId: kind === 'island' ? def.id : (def.islandId || null),
    townId: kind === 'town' ? def.id : (def.townId || null),
    towerId: def.towerId || null,
  };
}

/** Composes a scene by id through the unified registry, or null. */
export function composeSceneById(sceneId) {
  const entry = getSceneDefinition(sceneId);
  if (!entry) return null;
  return composeScene(entry.kind, entry.def);
}

/**
 * Reachability report for a composed/definition scene: is each key tile
 * reachable from spawn with only solid scenery blocking (runtime gate/key
 * state ignored)? Used by the T0 soft-lock guard.
 *
 * @param {'island'|'town'} kind
 * @param {object} def
 * @returns {{ sceneId: string, spawnReachable: boolean, townReachable: boolean|null, towerReachable: boolean|null }}
 */
export function sceneAccessReport(kind, def) {
  const scene = composeScene(kind, def);
  const { tiles, spawn } = scene;
  const reachable = reachableFrom(tiles, spawn);
  const at = (x, y) => Number.isInteger(x) && Number.isInteger(y) && reachable.has(`${x},${y}`);

  let townReachable = null;
  let towerReachable = null;
  for (const portal of scene.portals) {
    if (portal.target && portal.target.sceneId) townReachable = at(portal.x, portal.y);
    if (portal.type === 'tower' || portal.towerId) towerReachable = at(portal.x, portal.y);
  }
  const spawnReachable = isCodeWalkable(tiles[spawn.y] ? tiles[spawn.y][spawn.x] : undefined);
  return { sceneId: scene.sceneId, spawnReachable, townReachable, towerReachable };
}

/** Quest ids referenced by NPC givers/turn-ins, for catalog referential checks. */
export function questIdsForScene(sceneId) {
  return listQuestDefinitions()
    .filter((quest) => quest.giverNpcId || quest.turnInNpcId)
    .filter((quest) => listNpcDefinitions(sceneId).some(
      (npc) => npc.id === quest.giverNpcId || npc.id === quest.turnInNpcId
    ))
    .map((quest) => quest.id);
}
