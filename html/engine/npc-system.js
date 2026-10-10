/**
 * Lokarta: Come Into The Light - Neutral NPC System (browser-free)
 *
 * Runtime entities for the town/overworld NPCs authored in `html/data/npcs.json`
 * (LIV-58). NPCs are neutral (no combat faction, never targeted by attacks).
 * Their behaviour is a dispatch table keyed by the catalog `aiType`:
 *   - `stationary` — holds its tile, turns in place periodically (LIV-149), and
 *     turns to face the player when adjacent.
 *   - `wander`     — ambles one tile at a time within `wanderRadius` of home.
 *   - `follow`     — trails the NPC named by `followTargetId` (LIV-150), holding
 *                    `followDistance` tiles of gap and pathing around walls/actors.
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
import { EntityAI } from './entity-ai.js';

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

/**
 * Default trailing gap in tiles for a `follow` NPC (LIV-150), resolved from the
 * scene copy (`>= 1`). A follower stops and watches its leader once this close so
 * it never stacks on top of them. Per-NPC `followDistance` overrides it.
 */
const FOLLOW_DISTANCE_DEFAULT = Math.max(1, Number(UI_CATALOG?.island?.npcFollowDistance) || 3);

/**
 * Seconds between follower steps (LIV-150), resolved from the scene copy
 * (`>= 0.1`). One tile per cadence keeps the follower's pace natural instead of
 * gliding at full render speed; deterministic (no RNG), unlike `wander`.
 */
const FOLLOW_STEP_SEC = Math.max(0.1, Number(UI_CATALOG?.island?.npcFollowStepSec) || 0.45);

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
    // LIV-150: a `follow` NPC trails the runtime entity whose catalog id matches
    // `followTargetId`; the gap is authored per NPC (falls back to the copy
    // default). Generic passthrough — the handler resolves the target by id at
    // runtime, so no per-name branch lives in the engine.
    followTargetId: def.followTargetId || null,
    followDistance: Math.max(1, Number(def.followDistance) || FOLLOW_DISTANCE_DEFAULT),
    blocks: def.blocks !== false,
    interact: def.interact ? { ...def.interact } : null,
    defaultDialogueId: def.defaultDialogueId || def.interact?.dialogueId || null,
    portraitEmoji: def.portraitEmoji || null,
    svgCode: def.svgCode || null,
    _wanderCooldownSec: 0,
    // LIV-149: stagger the first in-place glance so a row of stationary NPCs
    // does not turn in lockstep on scene load. The handler reschedules each tick.
    _idleTurnCooldownSec: Math.random() * NPC_STATIONARY_TURN_COOLDOWN_MIN,
    _followCooldownSec: 0,
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
 * Linear scan for the runtime NPC whose catalog id matches `id`. Allocation-free
 * and only hit on a follower's step cadence (never per-frame), so the O(n) scan
 * over the handful of town NPCs is cheaper than maintaining a per-tick id map.
 * @returns {object|null}
 */
function findNpcById(npcs, id) {
  if (!id || !Array.isArray(npcs)) return null;
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i];
    if (n && n.npcId === id) return n;
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
    if (handler(npc, gridMap, deltaSec, occupied, width, npcs)) moved += 1;
  }
  return moved;
}

/** True when `(x, y)` is a walkable tile not claimed by another actor. */
function followerTileFree(gridMap, occupied, width, x, y) {
  if (!gridMap.isWalkable(x, y)) return false;
  if (occupied && occupied.has(y * width + x)) return false;
  return true;
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
  // LIV-150: a `follow` NPC trails the entity named by `followTargetId`. It holds
  // `followDistance` tiles of gap (Manhattan), pathing one tile per cadence toward
  // the leader on the shared A* planner, then turning to face each step. It never
  // steps onto an occupied tile, so it cannot stack on the leader, the player,
  // monsters, or another NPC, and cannot clip a wall. Deterministic (no RNG), so
  // it is directly testable.
  follow: (npc, gridMap, deltaSec, occupied, width, npcs) => {
    const target = findNpcById(npcs, npc.followTargetId);
    if (!target) return false;

    const gap = Math.abs(target.x - npc.x) + Math.abs(target.y - npc.y);
    if (gap <= npc.followDistance) {
      // Close enough: hold the line and watch the leader, like a companion.
      npc.facing = facingToward(npc.x, npc.y, target.x, target.y);
      return false;
    }

    npc._followCooldownSec = (npc._followCooldownSec || 0) - (Number(deltaSec) || 0);
    if (npc._followCooldownSec > 0) return false;
    npc._followCooldownSec = FOLLOW_STEP_SEC;

    const fromX = npc.x;
    const fromY = npc.y;
    let nextX = -1;
    let nextY = -1;

    // Preferred path: one A* step on the shared binary-MinHeap planner. NPCs are
    // soft blockers (the leader included as the goal), `excludeId` keeps the
    // follower off its own tile.
    const step = EntityAI.findNextStepAStar(
      { x: fromX, y: fromY },
      { x: target.x, y: target.y },
      gridMap,
      npcs,
      npc.id,
    );
    // A* allows entering the goal tile, so reject the leader's own tile here to
    // guarantee the follower never stacks; also reject tiles claimed by other
    // actors (player/monsters/allies) that A* does not know about.
    if (step
      && !(step.x === target.x && step.y === target.y)
      && followerTileFree(gridMap, occupied, width, step.x, step.y)) {
      nextX = step.x;
      nextY = step.y;
    } else {
      // Fallback: greedy dominant-axis step (still walkability + occupancy gated).
      const adx = Math.abs(target.x - fromX);
      const ady = Math.abs(target.y - fromY);
      const ax = Math.sign(target.x - fromX);
      const ay = Math.sign(target.y - fromY);
      const tryXFirst = adx >= ady;
      const c1x = tryXFirst ? ax : 0;
      const c1y = tryXFirst ? 0 : ay;
      const c2x = tryXFirst ? 0 : ax;
      const c2y = tryXFirst ? ay : 0;
      if ((c1x || c1y) && followerTileFree(gridMap, occupied, width, fromX + c1x, fromY + c1y)) {
        nextX = fromX + c1x;
        nextY = fromY + c1y;
      } else if ((c2x || c2y) && followerTileFree(gridMap, occupied, width, fromX + c2x, fromY + c2y)) {
        nextX = fromX + c2x;
        nextY = fromY + c2y;
      }
    }

    if (nextX < 0) return false;
    npc.facing = facingToward(fromX, fromY, nextX, nextY);
    npc.x = nextX;
    npc.y = nextY;
    if (occupied) occupied.add(nextY * width + nextX);
    return true;
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
