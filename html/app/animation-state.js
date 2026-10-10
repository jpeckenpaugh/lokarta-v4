/**
 * Lokarta: Presentation-only animation state
 *
 * `anim` is a pure presentation field. It is never persisted, never sent over
 * worker RPC, and the renderer tolerates its absence (falls back to `facing`
 * plus a static idle frame). Keeping it in its own module keeps the state
 * machine unit-testable without a canvas.
 */

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

/** Map an engine facing value to one of the three authored directions. */
export function dirFromFacing(facing) {
  if (facing === 'up') return 'up';
  if (facing === 'left' || facing === 'right') return 'side';
  return 'down';
}

export function flipFromFacing(facing) {
  return facing === 'left';
}

/** Create a default idle `anim` object for an actor. */
export function createAnimState(facing = 'down') {
  return {
    state: 'idle',
    dir: dirFromFacing(facing),
    frame: 0,
    elapsedMs: 0,
    flipX: flipFromFacing(facing),
    lockedUntilMs: 0,
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
 * take priority and lock until their duration elapses.
 */
export function setAnimState(actor, state, nowMs = 0) {
  const anim = ensureAnim(actor);
  anim.dir = dirFromFacing(actor.facing || 'down');
  anim.flipX = flipFromFacing(actor.facing || 'down');
  if (state === 'walk') {
    if (anim.state === 'attack' || anim.state === 'hit' || anim.state === 'death') return anim;
    // A walk request is also the step event: advance the frame once per tile.
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
