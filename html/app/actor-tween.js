/**
 * Lokarta: Come Into The Light - actor render tween (LIV-139)
 *
 * Render-only smoothing for tile-to-tile movement. The logical tile position
 * (`actor.x` / `actor.y`) stays authoritative: collision, input, combat, loot
 * and AI timing all keep reading the integer tile. This module only produces a
 * fractional "where to draw" position so a sprite glides across a hop instead
 * of popping between tiles.
 *
 * Implementation notes (docs/engineering/agents.md §3 hot-path discipline):
 *   - State lives on the actor as a single reusable `_tween` object, created
 *     once per actor lifetime (never per frame).
 *   - `advanceActorTween` writes scalars only — no allocation per call.
 *   - `tweenTileX` / `tweenTileY` are allocation-free readers for the renderer.
 *
 * Every tile hop is drawn as `intermediateFrames` discrete sub-positions
 * distributed evenly between the source and destination tile, so the motion
 * reads as a 3-4 step tween rather than a single snap. The catalog drives the
 * count + duration (`movement.json` -> `CONFIG.MOVE_TWEEN_*`).
 */

import { CONFIG } from '../engine/config.js';

/** Intermediate sub-positions drawn per tile hop (catalog-driven). */
export const TWEEN_INTERMEDIATE_FRAMES = CONFIG.MOVE_TWEEN_INTERMEDIATE_FRAMES;

/** Duration (ms) of one full tile-hop tween (catalog-driven). */
export const TWEEN_DURATION_MS = CONFIG.MOVE_TWEEN_DURATION_MS;

const EPSILON = 1e-9;

/**
 * The ordered intermediate sub-positions between two tiles (exclusive of the
 * endpoints). With `intermediateFrames = 3` this returns the positions at 1/4,
 * 2/4 and 3/4 of the hop. Pure; used directly by tests and the proof renderer.
 * @returns {Array<{x:number,y:number}>}
 */
export function tweenIntermediatePositions(fromX, fromY, toX, toY, intermediateFrames = TWEEN_INTERMEDIATE_FRAMES) {
  const n = Math.max(1, Math.floor(intermediateFrames));
  const denom = n + 1;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / denom;
    out.push({ x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t });
  }
  return out;
}

/**
 * Quantizes a linear [0,1] progress onto the discrete sub-step ladder, so the
 * drawn position lands exactly on the intermediate frames (and the
 * destination) instead of drifting continuously. `intermediateFrames = 3`
 * yields the ladder {0, 1/4, 2/4, 3/4, 1}.
 */
export function tweenStepProgress(progress, intermediateFrames = TWEEN_INTERMEDIATE_FRAMES) {
  const n = Math.max(1, Math.floor(intermediateFrames));
  const denom = n + 1;
  const p = Math.min(1, Math.max(0, progress));
  return Math.max(0, Math.min(1, Math.ceil(p * denom - EPSILON) / denom));
}

/**
 * Advances one actor's render tween toward its current logical tile and writes
 * the fractional draw position onto `actor._tween`. Allocation-free.
 *
 * A tile change of more than one tile in either axis (floor transition, scene
 * warp, wave carry) snaps instead of sliding across intervening tiles.
 *
 * @param {object} actor  Entity with integer `x`/`y` tile coordinates.
 * @param {number} dtMs   Frame delta in milliseconds.
 * @param {{durationMs?:number, intermediateFrames?:number}} [opts]
 * @returns {object} the actor's tween state
 */
export function advanceActorTween(actor, dtMs, opts = {}) {
  const durationMs = Number(opts.durationMs) || TWEEN_DURATION_MS;
  const intermediateFrames = Number(opts.intermediateFrames) || TWEEN_INTERMEDIATE_FRAMES;
  const lx = actor.x;
  const ly = actor.y;

  let tw = actor._tween;
  if (!tw) {
    tw = actor._tween = {
      fromX: lx, fromY: ly, toX: lx, toY: ly,
      renderX: lx, renderY: ly, elapsedMs: durationMs, durationMs,
    };
  }

  if (lx !== tw.toX || ly !== tw.toY) {
    const jumped = Math.abs(lx - tw.toX) > 1 || Math.abs(ly - tw.toY) > 1;
    if (jumped) {
      tw.fromX = lx; tw.fromY = ly;
      tw.renderX = lx; tw.renderY = ly;
      tw.elapsedMs = durationMs;
    } else {
      // Start the new hop from wherever the sprite currently is drawn so an
      // interrupted tween stays continuous (never snaps backward).
      tw.fromX = tw.renderX;
      tw.fromY = tw.renderY;
      tw.elapsedMs = 0;
    }
    tw.toX = lx;
    tw.toY = ly;
  }

  if (tw.elapsedMs < durationMs) {
    tw.elapsedMs = Math.min(durationMs, tw.elapsedMs + (Number(dtMs) || 0));
  }
  const p = durationMs > 0 ? tw.elapsedMs / durationMs : 1;
  const q = tweenStepProgress(p, intermediateFrames);
  tw.renderX = tw.fromX + (tw.toX - tw.fromX) * q;
  tw.renderY = tw.fromY + (tw.toY - tw.fromY) * q;
  tw.durationMs = durationMs;
  return tw;
}

/** Fractional tile X to draw `actor` at (falls back to its logical tile). */
export function tweenTileX(actor) {
  return actor && actor._tween ? actor._tween.renderX : actor.x;
}

/** Fractional tile Y to draw `actor` at (falls back to its logical tile). */
export function tweenTileY(actor) {
  return actor && actor._tween ? actor._tween.renderY : actor.y;
}
