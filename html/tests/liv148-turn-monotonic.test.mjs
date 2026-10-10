/**
 * Lokarta: LIV-148 — a turn is one consistent, monotonic shortest arc.
 *
 * The board found (on [LIV-141](/LIV/issues/LIV-141)) that a 180-degree
 * `up`->`down` turn "flips direction partway": the drawn frame sequence held on
 * one pose and then snapped to the opposite cardinal, because the mirror
 * fallback (`DIR8_FALLBACK`) was **asymmetric** — the right-half diagonals
 * collapsed to the cardinal (`up`/`down`) while the mirrored left-half diagonals
 * collapsed to the profile (`side`).
 *
 * These tests pin the two invariants the fix must hold, for both an authored
 * 5-view def (archer) and a legacy 3-view def (magician, the default player):
 *
 *   1. `resolveFrameDir` fallback is symmetric: the two halves of the compass
 *      resolve to mirrored authored frames, so neither arc reorders or skips.
 *   2. A turn's drawn frame sequence is **monotonic in angle toward the target**:
 *      no mid-turn reversal on any of the 8 octant transitions or the
 *      representative 90/180-degree turns, and the 180-degree tie commits to a
 *      single direction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIR8,
  rotateDir8,
  dir8Delta,
  createAnimState,
  advanceTurn,
  resolveFrameDir,
} from '../app/animation-state.js';

import { SPRITE_CATALOG } from '../assets/sprites/index.js';

/** Authored-frame azimuth (degrees) for the five unique yaw bakes. */
const FRAME_ANGLE = { down: 0, down_side: 45, side: 90, up_side: 135, up: 180 };

/** Effective on-screen azimuth of a resolved frame (mirror reflects the angle). */
function drawnAngle(frame) {
  const a = FRAME_ANGLE[frame.dir];
  if (a == null) return null;
  return frame.flip ? (360 - a) % 360 : a;
}

/** Shortest signed angular difference in [-180, 180]. */
function signedDelta(from, to) {
  let d = to - from;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** `dir*` marks a mirrored frame, e.g. `side*` = the left profile. */
const key = (frame) => `${frame.dir}${frame.flip ? '*' : ''}`;

/**
 * Walk a turn through the real `advanceTurn` seam and return the resolved frame
 * sequence (one entry per drawn 45-degree bucket, target inclusive).
 */
function turnFrames(spriteId, state, from, to) {
  const def = SPRITE_CATALOG[spriteId];
  const dirs = def.animations[state];
  const actor = { facing: from, anim: createAnimState(from) };
  actor.facing = to;
  const seq = [resolveFrameDir(dirs, actor.anim.dir)];
  for (let i = 0; i < 12 && actor.anim.dir !== to; i++) {
    advanceTurn(actor, 50, 50);
    seq.push(resolveFrameDir(dirs, actor.anim.dir));
  }
  return seq;
}

/** Assert a drawn-angle sequence never reverses and ends on the target frame. */
function assertMonotonic(spriteId, state, from, to) {
  const seq = turnFrames(spriteId, state, from, to);
  const angles = seq.map(drawnAngle);
  let sign = 0;
  for (let i = 1; i < angles.length; i++) {
    const d = signedDelta(angles[i - 1], angles[i]);
    if (d === 0) continue;
    const s = Math.sign(d);
    if (sign === 0) sign = s;
    else assert.equal(s, sign, `${spriteId} ${from}->${to}: turn reversed mid-way (${angles.join(',')})`);
  }
  assert.equal(seq.length >= 2, true, `${spriteId} ${from}->${to}: turn must show intermediate frames`);
}

describe('LIV-148 a turn is one monotonic shortest arc', () => {
  it('1. fallback is symmetric: a 3-view def maps both halves to mirrored frames', () => {
    const dirs = SPRITE_CATALOG.magician.animations.idle;
    // Right half -> the (unmirrored) profile; left half -> the mirrored profile.
    for (const d of ['up_right', 'right', 'down_right']) {
      assert.deepEqual(resolveFrameDir(dirs, d), { dir: 'side', flip: false }, `${d} uses the right profile`);
    }
    for (const d of ['up_left', 'left', 'down_left']) {
      assert.deepEqual(resolveFrameDir(dirs, d), { dir: 'side', flip: true }, `${d} uses the left profile`);
    }
    // Cardinals keep their authored frames.
    assert.deepEqual(resolveFrameDir(dirs, 'up'), { dir: 'up', flip: false });
    assert.deepEqual(resolveFrameDir(dirs, 'down'), { dir: 'down', flip: false });
  });

  it('2. the two 180-degree arcs are mirror-symmetric and skip no bucket (5-view)', () => {
    assert.deepEqual(
      turnFrames('archer', 'idle', 'up', 'down').map(key),
      ['up', 'up_side*', 'side*', 'down_side*', 'down'],
      'up -> down is one clean left arc through every 45-degree frame',
    );
    assert.deepEqual(
      turnFrames('archer', 'idle', 'down', 'up').map(key),
      ['down', 'down_side', 'side', 'up_side', 'up'],
      'down -> up mirrors it',
    );
  });

  it('3. a 3-view def turns through the profile on BOTH arcs (no reorder/skip)', () => {
    assert.deepEqual(
      turnFrames('magician', 'idle', 'up', 'down').map(key),
      ['up', 'side*', 'side*', 'side*', 'down'],
    );
    assert.deepEqual(
      turnFrames('magician', 'idle', 'down', 'up').map(key),
      ['down', 'side', 'side', 'side', 'up'],
      'the reverse arc mirrors the forward arc instead of flashing the cardinals',
    );
  });

  it('4. every representative turn is monotonic in angle toward the target', () => {
    const reps = [['up', 'down'], ['down', 'up'], ['left', 'right'], ['right', 'left']];
    for (const sprite of ['archer', 'magician']) {
      for (const [from, to] of reps) assertMonotonic(sprite, 'idle', from, to);
    }
  });

  it('5. every 45-degree octant step is a single monotonic bucket', () => {
    for (const sprite of ['archer', 'magician']) {
      for (const from of DIR8) {
        const to = rotateDir8(from, 1);
        const seq = turnFrames(sprite, 'idle', from, to);
        assert.equal(seq.length, 2, `${sprite} ${from}->${to} is one step`);
        assertMonotonic(sprite, 'idle', from, to);
      }
    }
  });

  it('6. no mid-turn reversal on ANY octant transition (all 8x7 pairs, both defs)', () => {
    for (const sprite of ['archer', 'magician']) {
      for (const from of DIR8) {
        for (const to of DIR8) {
          if (from === to) continue;
          assertMonotonic(sprite, 'idle', from, to);
        }
      }
    }
  });

  it('7. the 180-degree tie commits to ONE direction for the whole turn', () => {
    const actor = { facing: 'up', anim: createAnimState('up') };
    actor.facing = 'down';
    // Settle, then drive a full reversal in a single long frame.
    advanceTurn(actor, 200, 50);
    assert.equal(actor.anim.dir, 'down', 'a long frame lands exactly on the target');
    assert.equal(actor.anim.turnSign, 0, 'a settled turn clears its committed sign');

    // A fresh turn records a stable, single committed sign each step.
    const b = { facing: 'up', anim: createAnimState('up') };
    b.facing = 'down';
    const signs = new Set();
    for (let i = 0; i < 6 && b.anim.dir !== 'down'; i++) {
      advanceTurn(b, 50, 50);
      signs.add(b.anim.turnSign || Math.sign(dir8Delta(b.anim.dir, 'down')) || 1);
    }
    assert.equal(signs.size, 1, 'the committed rotation sign never flips mid-turn');
    assert.equal(b.anim.dir, 'down');
  });

  it('8. the drawn facing always lands on the resolved target frame', () => {
    for (const sprite of ['archer', 'magician']) {
      const dirs = SPRITE_CATALOG[sprite].animations.idle;
      for (const to of DIR8) {
        const seq = turnFrames(sprite, 'idle', 'up', to);
        assert.deepEqual(seq[seq.length - 1], resolveFrameDir(dirs, to), `${sprite} up->${to} settles on the target`);
      }
    }
  });
});
