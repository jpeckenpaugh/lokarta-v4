/**
 * Lokarta: Come Into The Light - Neutral NPC System (browser-free)
 *
 * Runtime entities for the town/overworld NPCs authored in `html/data/npcs.json`
 * (LIV-58). NPCs are neutral (no combat faction, never targeted by attacks).
 * Their behaviour is a two-entry dispatch table keyed by the catalog `aiType`:
 *   - `stationary` — holds its tile, turns in place periodically (LIV-149), and
 *     turns to face the player when adjacent.
 *   - `wander`     — ambles one tile at a time within `wanderRadius` of home.
 *
 * The module is pure: no DOM, no canvas, no storage. The renderer draws each NPC
 * through the existing `drawActor` pipeline using its own 3D-baked `npcSpriteId`
 * art. LIV-144: town NPCs are never recoloured — the runtime `renderTheme`
 * passthrough is retained only as inert catalog data; `drawActor` ignores it for
 * any actor carrying `npcId`.
 */

import { listNpcDefinitions } from '../data/index.js';
import { UI_CATALOG } from '../data/index.js';
import { rotateDir8, facingToward } from './facing.js';

/** Orthogonal step table (right/left/down/up) — reused, never allocated per step. */
const STEP_DX = Int8Array.from([1, -1, 0, 0]);
const STEP_DY = Int8Array.from([0, 0, 1, -1]);

/** Interaction reach in tiles, resolved from the scene copy (`>= 1`). */
export const NPC_INTERACT_RADIUS = Math.max(1, Number(UI_CATALOG?.island?.interactRadius) || 1);

/** Random wander cooldown window in seconds, resolved from copy (`>= 0.2`). */
const WANDER_COOLDOWN_MIN = Math.max(0.2, Number(UI_CATALOG?.island?.npcWanderCooldownSec) || 1.4);
const WANDER_SKIP_CHANCE = Math.min(0.95, Math.max(0, Number(UI_CATALOG?.island?.npcWanderSkipChance) || 0.45));

/** Chance an idle wanderer turns in place instead of stepping (LIV-147). */
const NPC_IDLE_TURN_CHANCE = Math.min(0.95, Math.max(0, Number(UI_CATALOG?.island?.npcIdleTurnChance) || 0.35));

/**
 * Mean seconds between in-place turns for a `stationary` NPC (LIV-149), resolved
 * from copy (`>= 0.5`). Stationary quest givers never step, but idle-turn so the
 * town reads as alive.
 */
const NPC_STATIONARY_TURN_COOLDOWN_MIN = Math.max(0.5, Number(UI_CATALOG?.island?.npcStationaryTurnCooldownSec) || 3);

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
    // LIV-81: forward the NPC's own sprite id + portrait expression map so the
    // renderer and dialogue UI read them off the runtime entity. Generic
    // passthrough only — no per-NPC branch or lookup.
    npcSpriteId: def.npcSpriteId || null,
    portraits: def.portraits ? { ...def.portraits } : null,
    vocation: def.vocation || null,
    renderTheme: def.renderTheme ? { ...def.renderTheme } : null,
    // LIV-145: per-actor render-scale multiplier (authored per NPC). Generic
    // passthrough — the renderer normalizes a scalar or `{ w, h }` spec and
    // defaults to 1:1, so no per-NPC branch is needed here.
    renderScale: def.renderScale ?? null,
    aiType: def.aiType || 'stationary',
    wanderRadius: Math.max(0, Number(def.wanderRadius) || 0),
    blocks: def.blocks !== false,
    interact: def.interact ? { ...def.interact } : null,
    defaultDialogueId: def.defaultDialogueId || def.interact?.dialogueId || null,
    portraitEmoji: def.portraitEmoji || null,
    svgCode: def.svgCode || null,
    _wanderCooldownSec: 0,
    // LIV-149: stagger the first in-place glance so a row of stationary NPCs
    // does not turn in lockstep on scene load. The handler reschedules each tick.
    _idleTurnCooldownSec: Math.random() * NPC_STATIONARY_TURN_COOLDOWN_MIN,
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
  // LIV-149: a stationary NPC never changes tile, but periodically turns in
  // place so the three quest givers glance around. Structural rule: turn only;
  // `npc.x`/`npc.y` are untouched. The adjacent "face the player" behaviour is
  // applied on interaction lookup in `findInteractableNpc`.
  stationary: (npc, gridMap, deltaSec) => {
    npc._idleTurnCooldownSec = (npc._idleTurnCooldownSec || 0) - (Number(deltaSec) || 0);
    if (npc._idleTurnCooldownSec > 0) return false;
    // Reschedule a jittered window so turns never synchronize across NPCs.
    npc._idleTurnCooldownSec = NPC_STATIONARY_TURN_COOLDOWN_MIN * (0.5 + Math.random());
    if (Math.random() < NPC_IDLE_TURN_CHANCE) {
      // A 45/90-degree arc (never a 180-degree flip) so `advanceTurn` eases the
      // change through the intermediate 8-angle frame rather than snapping.
      const arc = (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.5 ? 1 : 2);
      npc.facing = rotateDir8(npc.facing, arc);
    }
    return false;
  },
  wander: (npc, gridMap, deltaSec, occupied, width) => {
    npc._wanderCooldownSec = (npc._wanderCooldownSec || 0) - deltaSec;
    if (npc._wanderCooldownSec > 0) return false;
    npc._wanderCooldownSec = WANDER_COOLDOWN_MIN + Math.random() * WANDER_COOLDOWN_MIN;

    // LIV-147: an idle wanderer occasionally glances left/right. Rotating the
    // facing by a 45/90-degree arc (never a 180-degree flip) and letting
    // `advanceTurn` ease one bucket at a time makes the change read as a turn
    // through the intermediate angle frame rather than a snap.
    if (Math.random() < NPC_IDLE_TURN_CHANCE) {
      const arc = (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.5 ? 1 : 2);
      npc.facing = rotateDir8(npc.facing, arc);
      return false;
    }
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
  if (npc) npc.facing = facingToward(npc.x, npc.y, px, py);
  return npc;
}

/**
 * The blocking NPC the player bumps by attempting to step from `(fromX,fromY)`
 * onto `(toX,toY)` — the NPC occupying the destination tile. `from` and `to`
 * must be orthogonally adjacent (a single grid step), so teleports and diagonal
 * moves never register as a bump. Data-driven: reads the runtime NPC `blocks`
 * flag through `npcAt`, never a per-NPC branch. Allocation-free.
 * @param {object[]} npcs
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @returns {object|null}
 */
export function findBumpedNpc(npcs, fromX, fromY, toX, toY) {
  if (!Array.isArray(npcs)) return null;
  if (Math.abs(toX - fromX) + Math.abs(toY - fromY) !== 1) return null;
  return npcAt(npcs, toX, toY);
}
