/**
 * Lokarta: Come Into The Light - Neutral NPC System (browser-free)
 *
 * Runtime entities for the town/overworld NPCs authored in `html/data/npcs.json`
 * (LIV-58). NPCs are neutral (no combat faction, never targeted by attacks).
 * Their behaviour is a two-entry dispatch table keyed by the catalog `aiType`:
 *   - `stationary` — stands still, turns to face the player when adjacent.
 *   - `wander`     — ambles one tile at a time within `wanderRadius` of home.
 *
 * The module is pure: no DOM, no canvas, no storage. The renderer draws each NPC
 * through the existing `drawActor` pipeline using its `spriteId` + `renderTheme`.
 */

import { listNpcDefinitions } from '../data/index.js';
import { UI_CATALOG } from '../data/index.js';

/** Orthogonal step table (right/left/down/up) — reused, never allocated per step. */
const STEP_DX = Int8Array.from([1, -1, 0, 0]);
const STEP_DY = Int8Array.from([0, 0, 1, -1]);

/** Interaction reach in tiles, resolved from the scene copy (`>= 1`). */
export const NPC_INTERACT_RADIUS = Math.max(1, Number(UI_CATALOG?.island?.interactRadius) || 1);

/** Random wander cooldown window in seconds, resolved from copy (`>= 0.2`). */
const WANDER_COOLDOWN_MIN = Math.max(0.2, Number(UI_CATALOG?.island?.npcWanderCooldownSec) || 1.4);
const WANDER_SKIP_CHANCE = Math.min(0.95, Math.max(0, Number(UI_CATALOG?.island?.npcWanderSkipChance) || 0.45));

/** Builds a runtime NPC entity from a catalog/npc descriptor. */
export function makeNpcRuntime(def) {
  const x = Number.isInteger(def.x) ? def.x : 0;
  const y = Number.isInteger(def.y) ? def.y : 0;
  return {
    id: `npc_${def.id}`,
    npcId: def.id,
    name: def.name || def.id,
    title: def.title || '',
    sceneId: def.sceneId || null,
    x,
    y,
    homeX: x,
    homeY: y,
    facing: def.facing || 'down',
    spriteId: def.spriteId || def.vocation || null,
    vocation: def.vocation || null,
    renderTheme: def.renderTheme ? { ...def.renderTheme } : null,
    aiType: def.aiType || 'stationary',
    wanderRadius: Math.max(0, Number(def.wanderRadius) || 0),
    blocks: def.blocks !== false,
    interact: def.interact ? { ...def.interact } : null,
    defaultDialogueId: def.defaultDialogueId || def.interact?.dialogueId || null,
    portraitEmoji: def.portraitEmoji || null,
    svgCode: def.svgCode || null,
    _wanderCooldownSec: 0,
  };
}

/**
 * Spawns runtime NPCs for a composed scene. Prefers the scene's own (already
 * filtered) `npcs` list and falls back to the catalog by scene id.
 * @param {object} scene
 * @returns {object[]}
 */
export function spawnNpcsForScene(scene) {
  const defs = Array.isArray(scene?.npcs) && scene.npcs.length
    ? scene.npcs
    : listNpcDefinitions(scene?.sceneId);
  return defs.map(makeNpcRuntime);
}

/** The blocking NPC occupying `(x, y)`, or null. */
export function npcAt(npcs, x, y) {
  if (!Array.isArray(npcs)) return null;
  for (let i = 0; i < npcs.length; i++) {
    const npc = npcs[i];
    if (npc && npc.blocks && npc.x === x && npc.y === y) return npc;
  }
  return null;
}

function facingTo(fromX, fromY, toX, toY) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/**
 * Advances every NPC by `deltaSec`. `occupied` is an integer-hash set of tiles
 * blocked by the player, monsters, and other NPCs; NPCs never step onto it.
 * Allocation-light: no arrays/objects per NPC per tick.
 * @param {object[]} npcs
 * @param {import('./grid-map.js').GridMap} gridMap
 * @param {number} deltaSec
 * @param {Set<number>} [occupied]
 * @returns {number} count of NPCs that changed tile
 */
export function updateNpcs(npcs, gridMap, deltaSec, occupied = null) {
  if (!Array.isArray(npcs) || !gridMap || npcs.length === 0) return 0;
  const width = gridMap.width;
  let moved = 0;
  for (let i = 0; i < npcs.length; i++) {
    const npc = npcs[i];
    if (!npc) continue;
    const handler = NEUTRAL_AI_HANDLERS[npc.aiType] || NEUTRAL_AI_HANDLERS.stationary;
    if (handler(npc, gridMap, deltaSec, occupied, width)) moved += 1;
  }
  return moved;
}

/**
 * Neutral-entity AI dispatch table, keyed by `npcs.json` `aiType`.
 * A handler returns true when the NPC changed tile.
 */
export const NEUTRAL_AI_HANDLERS = {
  stationary: () => false,
  wander: (npc, gridMap, deltaSec, occupied, width) => {
    npc._wanderCooldownSec = (npc._wanderCooldownSec || 0) - deltaSec;
    if (npc._wanderCooldownSec > 0) return false;
    npc._wanderCooldownSec = WANDER_COOLDOWN_MIN + Math.random() * WANDER_COOLDOWN_MIN;
    if (Math.random() < WANDER_SKIP_CHANCE) return false;

    const start = Math.floor(Math.random() * 4);
    for (let k = 0; k < 4; k++) {
      const dir = (start + k) & 3;
      const nx = npc.x + STEP_DX[dir];
      const ny = npc.y + STEP_DY[dir];
      const dx = nx - npc.homeX;
      const dy = ny - npc.homeY;
      if (Math.abs(dx) > npc.wanderRadius || Math.abs(dy) > npc.wanderRadius) continue;
      if (!gridMap.isWalkable(nx, ny)) continue;
      const hash = ny * width + nx;
      if (occupied && occupied.has(hash)) continue;
      // Reserve the destination so two NPCs cannot pick the same tile this tick.
      if (occupied) occupied.add(hash);
      npc.x = nx;
      npc.y = ny;
      npc.facing = ['right', 'left', 'down', 'up'][dir];
      return true;
    }
    return false;
  },
};

/**
 * The NPC the player can interact with right now: the tile the player faces
 * first, then the player's own tile, then any orthogonally adjacent NPC within
 * `NPC_INTERACT_RADIUS`. Returns the npc (with a `facing` update applied) or null.
 * @param {object[]} npcs
 * @param {{x:number,y:number,facing?:string}} player
 * @returns {object|null}
 */
export function findInteractableNpc(npcs, player) {
  if (!Array.isArray(npcs) || !player) return null;
  const px = player.x;
  const py = player.y;
  const dx = player.facing === 'left' ? -1 : player.facing === 'right' ? 1 : 0;
  const dy = player.facing === 'up' ? -1 : player.facing === 'down' ? 1 : 0;
  // No candidate array: explicit nearest-first checks keep this allocation-free
  // (it runs on the 10 Hz scene tick).
  const npc = npcAt(npcs, px + dx, py + dy)
    || npcAt(npcs, px, py)
    || npcAt(npcs, px + 1, py)
    || npcAt(npcs, px - 1, py)
    || npcAt(npcs, px, py + 1)
    || npcAt(npcs, px, py - 1);
  if (npc) npc.facing = facingTo(npc.x, npc.y, px, py);
  return npc;
}
