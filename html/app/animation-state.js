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

/* ==================== 8-direction facing model (LIV-146) ====================
 *
 * Actors were authored with three render directions (`down`/`up`/`side`, left
 * mirrored from `side`). LIV-146 extends the actor contract to the full **eight
 * 45-degree directions**. The runtime vocabulary below is symmetric; five of the
 * directions are baked as unique yaw frames and the three left-hand directions
 * render as the horizontal mirror of their right-hand counterpart:
 *
 *   runtime dir   frame dir (authored)   mirror
 *   down          down                  -
 *   down_right    down_side             -
 *   right         side                  -
 *   up_right      up_side               -
 *   up            up                    -
 *   up_left       up_side               x
 *   left          side                  x
 *   down_left     down_side             x
 *
 * A def that authors fewer directions (e.g. the legacy 3-dir `down`/`up`/`side`
 * flat sprites) still renders every 8-dir request through an ordered fallback to
 * a direction it does carry, so the extension is fully backward compatible.
 */

/** The eight directions, clockwise from front (`down` = toward the camera). */
export const DIR8 = ['down', 'down_right', 'right', 'up_right', 'up', 'up_left', 'left', 'down_left'];

/** Facing azimuth (degrees) per 8-dir bucket: 0 = down, increasing toward screen-right. */
export const DIR8_ANGLE = {
  down: 0, down_right: 45, right: 90, up_right: 135,
  up: 180, up_left: 225, left: 270, down_left: 315,
};

/** Authored frame-dir names that alias a canonical runtime direction. */
const DIR8_ALIAS = { side: 'right', down_side: 'down_right', up_side: 'up_right' };

/** Authored frame direction + mirror flag for each canonical runtime direction. */
export const DIR8_BASIS = {
  down: { dir: 'down', flip: false },
  down_right: { dir: 'down_side', flip: false },
  right: { dir: 'side', flip: false },
  up_right: { dir: 'up_side', flip: false },
  up: { dir: 'up', flip: false },
  up_left: { dir: 'up_side', flip: true },
  left: { dir: 'side', flip: true },
  down_left: { dir: 'down_side', flip: true },
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

/** True for the mirrored (left-hand) half of the eight directions. */
export function isMirroredDir(dir) {
  const basis = DIR8_BASIS[dir];
  return !!(basis && basis.flip);
}

/** Fold a legacy/aliased direction onto its canonical 8-dir name (safe default). */
export function normalizeDir8(dir) {
  if (dir == null) return 'down';
  const key = DIR8_ALIAS[dir] || dir;
  return DIR8_BASIS[key] ? key : 'down';
}

/**
 * Nearest of the eight 45-degree buckets for a continuous heading angle in
 * radians. Angle 0 faces `down` (toward the camera); positive rotates clockwise
 * on screen (toward `right`). Wraps for any real input.
 */
export function dir8FromAngle(rad) {
  const a = Number(rad);
  if (!Number.isFinite(a)) return 'down';
  const q = Math.PI / 4;
  let idx = Math.round(a / q) % 8;
  if (idx < 0) idx += 8;
  return DIR8[idx];
}

/** Nearest 8-dir bucket for a screen-space heading (x right, y down). */
export function dir8FromVector(dx, dy) {
  const x = Number(dx) || 0;
  const y = Number(dy) || 0;
  if (x === 0 && y === 0) return 'down';
  return dir8FromAngle(Math.atan2(x, y));
}

/** Authored frame direction + mirror flag for a runtime direction (no def context). */
export function basisForDir8(dir) {
  return DIR8_BASIS[normalizeDir8(dir)];
}

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

/** Legacy engine facing strings -> canonical 8-dir (backward compatible). */
const LEGACY_FACING_DIR8 = {
  down: 'down', up: 'up', left: 'left', right: 'right', side: 'right',
  down_right: 'down_right', up_right: 'up_right',
  up_left: 'up_left', down_left: 'down_left',
  down_side: 'down_right', up_side: 'up_right',
};

/**
 * Map an engine facing value to one of the eight authored directions. Accepts a
 * legacy direction string, a continuous angle in radians, or a `{x, y}` (or
 * `{angle}`) heading. Unknown inputs fall back to `down`.
 */
export function dirFromFacing(facing) {
  if (typeof facing === 'number' && Number.isFinite(facing)) return dir8FromAngle(facing);
  if (facing && typeof facing === 'object') {
    if (typeof facing.angle === 'number' && Number.isFinite(facing.angle)) return dir8FromAngle(facing.angle);
    const dx = Number(facing.x);
    const dy = Number(facing.y);
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) return dir8FromVector(dx, dy);
  }
  const key = String(facing == null ? 'down' : facing).toLowerCase();
  return LEGACY_FACING_DIR8[key] || normalizeDir8(key);
}

export function flipFromFacing(facing) {
  return isMirroredDir(dirFromFacing(facing));
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
