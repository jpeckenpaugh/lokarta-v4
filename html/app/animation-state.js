/**
 * Lokarta: Presentation-only animation state
 *
 * `anim` is a pure presentation field. It is never persisted, never sent over
 * worker RPC, and the renderer tolerates its absence (falls back to `facing`
 * plus a static idle frame). Keeping it in its own module keeps the state
 * machine unit-testable without a canvas.
 *
 * The 8-direction vocabulary + geometry lives in `engine/facing.js` (shared
 * with the simulation's opponent facing) and is re-exported here so renderer and
 * tests keep a single import site.
 */

import {
  DIR8,
  DIR8_ANGLE,
  DIR8_BASIS,
  isMirroredDir,
  normalizeDir8,
  dir8FromAngle,
  dir8FromVector,
  basisForDir8,
  dir8Delta,
  rotateDir8,
  turnTowardDir8,
  dirFromFacing,
  flipFromFacing,
  facingToward,
} from '../engine/facing.js';

export {
  DIR8,
  DIR8_ANGLE,
  DIR8_BASIS,
  isMirroredDir,
  normalizeDir8,
  dir8FromAngle,
  dir8FromVector,
  basisForDir8,
  dir8Delta,
  rotateDir8,
  turnTowardDir8,
  dirFromFacing,
  flipFromFacing,
  facingToward,
};

export const ANIM_STATES = ['idle', 'walk', 'attack', 'hit', 'death'];

export const ANIM_DURATION_MS = {
  idle: 0,
  walk: 0,      // advanced on step, not on a timer
  attack: 270,  // 3 frames x 90 ms
  hit: 120,
  death: 480,
};

export const ANIM_FRAME_MS = {
  attack: 90,
  hit: 120,
  death: 120,
};

/** Ordered authored frame-dir candidates when a def lacks the ideal direction. */
const DIR8_FALLBACK = {
  down: ['down'],
  down_right: ['down_side', 'down', 'side'],
  right: ['side', 'down'],
  up_right: ['up_side', 'up', 'side'],
  up: ['up', 'down'],
  up_left: ['up_side', 'side', 'up'],
  left: ['side', 'down'],
  down_left: ['down_side', 'side', 'down'],
};

/**
 * Resolve the authored frame direction + mirror for a requested runtime
 * direction against one animation state's `dir -> frames` map. Falls back to an
 * ordered list of directions the def actually authors (so a 3-dir def renders
 * every 8-dir request), and finally to any authored direction. Pure; unit-tested
 * without a canvas.
 * @param {object} stateDirs
 * @param {string} requested
 * @returns {{dir: string, flip: boolean}}
 */
export function resolveFrameDir(stateDirs, requested) {
  const want = normalizeDir8(requested);
  if (!stateDirs) return { dir: DIR8_BASIS[want].dir, flip: DIR8_BASIS[want].flip };
  const basis = DIR8_BASIS[want];
  if (Array.isArray(stateDirs[basis.dir])) return { dir: basis.dir, flip: basis.flip };
  const chain = DIR8_FALLBACK[want] || [basis.dir];
  for (const cand of chain) {
    if (Array.isArray(stateDirs[cand])) {
      const flip = basis.flip && (cand === 'side' || cand === 'down_side' || cand === 'up_side');
      return { dir: cand, flip };
    }
  }
  const first = Object.keys(stateDirs).find((d) => Array.isArray(stateDirs[d]));
  return { dir: first || basis.dir, flip: false };
}

/** Fallback ms to rotate one 45-degree step when no catalog value is supplied. */
export const TURN_STEP_MS_FALLBACK = 50;

/**
 * Ease an actor's drawn facing (`anim.dir`) toward its logical `facing` in
 * discrete 45-degree steps, so a direction change reads as a turn through the
 * intermediate angles instead of a snap. Pure presentation: reads `actor.facing`
 * (never mutates it), writes only `anim` scalars — allocation-free for the
 * per-frame hot path.
 *
 * @param {object} actor  Entity with a logical `facing`.
 * @param {number} dtMs   Frame delta in milliseconds.
 * @param {number} [stepMs]  Milliseconds per 45-degree step (catalog-driven).
 * @returns {object} the actor's anim
 */
export function advanceTurn(actor, dtMs, stepMs = TURN_STEP_MS_FALLBACK) {
  const anim = ensureAnim(actor);
  const target = dirFromFacing(actor.facing || 'down');
  const delta = dir8Delta(anim.dir, target);
  if (delta === 0) {
    anim.turnAccumMs = 0;
    return anim;
  }
  const ms = Math.max(1, Number(stepMs) || TURN_STEP_MS_FALLBACK);
  anim.turnAccumMs = (anim.turnAccumMs || 0) + (Number(dtMs) || 0);
  let steps = Math.floor(anim.turnAccumMs / ms);
  if (steps <= 0) return anim;
  if (steps > Math.abs(delta)) steps = Math.abs(delta);
  anim.turnAccumMs -= steps * ms;
  anim.dir = rotateDir8(anim.dir, Math.sign(delta) * steps);
  anim.flipX = isMirroredDir(anim.dir);
  if (dir8Delta(anim.dir, target) === 0) anim.turnAccumMs = 0;
  return anim;
}

/** Create a default idle `anim` object for an actor. */
export function createAnimState(facing = 'down') {
  const dir = dirFromFacing(facing);
  return {
    state: 'idle',
    dir,
    frame: 0,
    elapsedMs: 0,
    flipX: isMirroredDir(dir),
    lockedUntilMs: 0,
    turnAccumMs: 0,
  };
}

/** Ensure an actor has an `anim` object; returns it. */
export function ensureAnim(actor) {
  if (!actor.anim) actor.anim = createAnimState(actor.facing || 'down');
  return actor.anim;
}

/** True while a locked state (attack/hit/death) should not be interrupted. */
export function isLocked(actor, nowMs = 0) {
  const anim = actor.anim;
  return !!anim && anim.lockedUntilMs > nowMs;
}

/**
 * Request a state transition. Idle/walk are interruptible; attack/hit/death
 * take priority and lock until their duration elapses. The drawn facing
 * (`anim.dir`) is owned by `advanceTurn`, which eases it toward `actor.facing`.
 */
export function setAnimState(actor, state, nowMs = 0) {
  const anim = ensureAnim(actor);
  if (!anim.dir) anim.dir = dirFromFacing(actor.facing || 'down');
  if (state === 'walk') {
    if (anim.state === 'attack' || anim.state === 'hit' || anim.state === 'death') return anim;
    if (anim.state === 'walk') anim.frame = (anim.frame + 1) % 2;
    else { anim.state = 'walk'; anim.frame = 0; }
    anim.elapsedMs = 0;
    return anim;
  }
  if (state === 'idle') {
    if (anim.state === 'attack' || anim.state === 'hit' || anim.state === 'death') return anim;
    anim.state = 'idle';
    anim.frame = 0;
    anim.elapsedMs = 0;
    return anim;
  }
  // attack | hit | death
  if (isLocked(actor, nowMs) && state !== 'death') return anim;
  anim.state = state;
  anim.frame = 0;
  anim.elapsedMs = 0;
  anim.lockedUntilMs = nowMs + (ANIM_DURATION_MS[state] || 0);
  return anim;
}

/**
 * Advance timer-driven states. Walk/idle are untouched. Returns the actor's
 * anim after the update.
 */
export function advanceAnim(actor, dtMs) {
  if (!actor.anim) return ensureAnim(actor);
  const anim = actor.anim;
  if (anim.state !== 'attack' && anim.state !== 'hit' && anim.state !== 'death') return anim;
  anim.elapsedMs += dtMs;
  const frameMs = ANIM_FRAME_MS[anim.state] || 120;
  const prevFrame = anim.frame;
  anim.frame = Math.floor(anim.elapsedMs / frameMs);
  if (anim.state === 'death') {
    anim.frame = Math.min(anim.frame, 5);
    return anim;
  }
  const max = anim.state === 'attack' ? 2 : 0;
  if (anim.frame > max) {
    anim.state = 'idle';
    anim.frame = 0;
    anim.elapsedMs = 0;
    anim.lockedUntilMs = 0;
  }
  return anim;
}

/** Resolve the frame list index for a state/dir, clamped to the array length. */
export function resolveFrameIndex(anim, length) {
  if (!length) return 0;
  return ((anim.frame % length) + length) % length;
}

/**
 * Pure procedural-squish transform (LIV-140). Maps a defeat progress (0..1) to
 * the draw-time scale applied to an opponent that lacks authored death frames:
 * the height compresses toward the ground point while the width widens slightly,
 * so the sprite reads as flattening/squashing down. `style` is the resolved
 * `PROCEDURAL_SQUISH` catalog block; every field is guarded so a partial catalog
 * still yields a valid transform. Allocation-free and unit-testable with no
 * canvas: returns `{ scaleX, scaleY }`.
 */
export function squishScaleFor(progress, style = {}) {
  const p = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(1, Number(progress))) : 0;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const squashY = num(style.squashY, 0.92);
  const widenX = num(style.widenX, 0.12);
  const minScaleY = Math.min(1, Math.max(0.01, num(style.minScaleY, 0.08)));
  // Smoothstep so the squash eases in and settles flat rather than moving linear.
  const ease = p * p * (3 - 2 * p);
  return {
    scaleX: 1 + widenX * ease,
    scaleY: Math.max(minScaleY, 1 - squashY * ease),
  };
}
