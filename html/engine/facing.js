/**
 * Lokarta: 8-direction facing model (LIV-146 / LIV-147)
 *
 * Pure, dependency-free geometry shared by the core simulation (`entity-ai.js`
 * faces opponents toward their target) and the presentation layer
 * (`app/animation-state.js` re-exports it for the renderer and its tests). Keeping
 * it in the engine avoids a simulation -> UI import while preserving a single
 * source of truth for the DIR8 vocabulary.
 *
 * Actors were authored with three render directions (`down`/`up`/`side`, left
 * mirrored from `side`). LIV-146 extended the contract to the full **eight
 * 45-degree directions**; five are baked as unique yaw frames and the three
 * left-hand directions render as the horizontal mirror of their right-hand
 * counterpart:
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
 * LIV-147 adds the deterministic turning math: the shortest signed 45-degree
 * arc between two directions (`dir8Delta`), a bucket rotation (`rotateDir8`),
 * and a bounded step toward a target (`turnTowardDir8`) so callers can ease
 * facing through the intermediate angles instead of snapping.
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

/** Bucket index (0 = down, clockwise) for a direction; unknown input -> down. */
export function dir8Index(dir) {
  return DIR8.indexOf(normalizeDir8(dir));
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
 * Shortest signed 45-degree arc from `from` to `to`: range [-4, 4], positive
 * clockwise. The exact 180-degree tie always resolves clockwise (+4) so turning
 * is deterministic across platforms.
 */
export function dir8Delta(from, to) {
  const a = dir8Index(from);
  const b = dir8Index(to);
  let d = b - a;
  if (d > 4) d -= 8;
  if (d < -4) d += 8;
  return d === -4 ? 4 : d;
}

/** Rotate `dir` by `steps` 45-degree buckets (positive = clockwise); wraps. */
export function rotateDir8(dir, steps) {
  const n = DIR8.length;
  const idx = dir8Index(dir);
  let next = (idx + (Math.trunc(Number(steps)) || 0)) % n;
  if (next < 0) next += n;
  return DIR8[next];
}

/**
 * One bounded step of the shortest arc from `current` toward `target`: advance
 * at most `maxSteps` 45-degree buckets, returning a canonical 8-dir string.
 * This is the pure "turn-smoothing" primitive — callers pass the intermediate
 * result back in each tick so motion reads as a turn rather than a snap.
 */
export function turnTowardDir8(current, target, maxSteps = 1) {
  const cur = normalizeDir8(current);
  const d = dir8Delta(cur, target);
  if (d === 0) return cur;
  const cap = Math.max(1, Math.floor(Number(maxSteps) || 1));
  const move = Math.sign(d) * Math.min(cap, Math.abs(d));
  return rotateDir8(cur, move);
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
