/**
 * Lokarta: LIV-152 — end-to-end 180-degree turn regression (real archer def).
 *
 * The board kept seeing a `up`->`down` (backward->forward) turn draw the
 * **right**-facing diagonal at the mirrored (`down_left`) step: `4,5,6,1,0`
 * instead of `4,5,6,7,0`. LIV-148 fixed the pure helpers, but its tests only
 * exercised `advanceTurn` + `resolveFrameDir` in isolation with a hand-built
 * actor. This suite closes that gap: it drives a **real archer player** through
 * the actual game-loop seams (`processMovementInput` on the 10 Hz tick +
 * `updateAnimations` on the 60 FPS render frame) and reads the frame the
 * renderer actually draws (`resolveSpriteFrame`), then asserts the exact
 * `{dir, flip}` arc — plus the drawn pixels really mirror for the left half.
 *
 * Invariants pinned:
 *   1. `up -> down` draws `up, up_side*, side*, down_side*, down` (DIR8 4,5,6,7,0).
 *   2. `down -> up` draws `down, down_side, side, up_side, up` (DIR8 0,1,2,3,4).
 *   3. Every one of the 8x8 transitions resolves each bucket to the correct
 *      authored frame + mirror and is monotonic in drawn angle (never a mid-turn
 *      reversal or skip), driven through the live loop.
 *   4. The mirrored diagonals draw genuinely flipped pixels (the `down_left`
 *      step is the horizontal mirror of `down_right`, not the same frame).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../engine/config.js';
import { createPartyPlayer } from '../engine/party.js';
import { GridMap } from '../engine/grid-map.js';
import { gameLoopMethods } from '../app/game-loop.js';
import {
  DIR8,
  DIR8_BASIS,
  rotateDir8,
  normalizeDir8,
  createAnimState,
  advanceTurn,
} from '../app/animation-state.js';
import { resolveSpriteFrame, parseFrame, applyOutline, scalePixels } from '../app/sprite-renderer.js';
import { SPRITE_CATALOG } from '../assets/sprites/index.js';

const ARCHER = SPRITE_CATALOG.archer;

/** The exact key each 8-dir request maps to in the live movement catalog. */
const KEY_FOR_DIR = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};

/** Minimal no-DOM app that owns the real game-loop movement + turn drive. */
function makeApp(player) {
  const grid = new GridMap(40, 40);
  grid.loadFromMatrix(Array.from({ length: 40 }, () => Array(40).fill(0)));
  let now = 0;
  const app = Object.assign({}, gameLoopMethods, {
    player,
    gridMap: grid,
    monsters: [],
    npcs: [],
    chests: [],
    scene: null,
    projectiles: [],
    particles: [],
    floatingTexts: [],
    deathEffects: [],
    keysDown: new Set(),
    options: {},
    swapFeedback: null,
    fireQuestEvent: () => [],
    logCombat: () => {},
    updateHUD: () => {},
    persistSave: () => {},
    resolvePlayerTileEntry: () => false,
    nowMs: () => now,
  });
  return {
    app,
    /** Advance one 10 Hz logic tick + `frames` 60 FPS render frames. */
    advance(frames = 6) {
      now += CONFIG.TICK_INTERVAL_MS;
      app.processMovementInput(CONFIG.TICK_INTERVAL_MS / 1000);
      const drawn = [];
      for (let i = 0; i < frames; i++) {
        now += 1000 / 60;
        app.updateAnimations(1000 / 60);
        const f = resolveSpriteFrame(ARCHER, player.anim);
        drawn.push(`${f.dir}${f.flip ? '*' : ''}`);
      }
      return drawn;
    },
  };
}

/** Press `key`, letting the turn settle, then release it. */
function hold(app, key) {
  app.keysDown.add(key);
}

/**
 * Drive a real turn from `from` to `to` through the live loop and return the
 * deduped drawn-frame sequence (one entry per distinct drawn frame).
 *
 * The logical `facing` is set the same way every non-movement system sets it
 * (movement keys, attack `faceAttackerToward`, dialogue turn-to-face): a single
 * authoritative string, which `advanceTurn` then eases. Cardinal turns are also
 * exercised through the real movement keys so the whole input -> facing ->
 * `advanceTurn` -> draw chain is covered.
 */
function liveTurn(from, to, { viaKey = false } = {}) {
  const player = createPartyPlayer('archer');
  player.facing = from;
  player.anim = createAnimState(from);
  player.party = [];
  const { app, advance } = makeApp(player);

  if (viaKey) {
    hold(app, KEY_FOR_DIR[from]);
    for (let i = 0; i < 30; i++) advance();
    assert.equal(player.anim.dir, from, `settled on ${from}`);
    app.keysDown.clear();
    hold(app, KEY_FOR_DIR[to]);
  } else {
    for (let i = 0; i < 5; i++) advance();
    player.facing = to;
  }

  const drawn = [];
  for (let i = 0; i < 40; i++) drawn.push(...advance());
  app.keysDown.clear();

  const seq = [];
  for (const f of drawn) if (seq[seq.length - 1] !== f) seq.push(f);
  return seq;
}

/** Authored-frame azimuth for the five unique yaw bakes. */
const FRAME_ANGLE = { down: 0, down_side: 45, side: 90, up_side: 135, up: 180 };

/** Effective on-screen azimuth of a resolved frame (a mirror reflects it). */
function drawnAngle(frame) {
  const key = frame.replace('*', '');
  const a = FRAME_ANGLE[key];
  if (a == null) return null;
  return frame.endsWith('*') ? (360 - a) % 360 : a;
}

/** Shortest signed angular difference in [-180, 180]. */
function signedDelta(from, to) {
  let d = to - from;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

test('LIV-152 end-to-end 180-degree turn (real archer def, live loop)', async (t) => {
  await t.test('1. up -> down draws 4,5,6,7,0 (left arc, mirrored diagonal last)', () => {
    assert.deepEqual(
      liveTurn('up', 'down', { viaKey: true }),
      ['up', 'up_side*', 'side*', 'down_side*', 'down'],
      'up -> down must ease through the mirrored left arc with no skip/flip',
    );
  });

  await t.test('2. down -> up draws 0,1,2,3,4 (right arc)', () => {
    assert.deepEqual(
      liveTurn('down', 'up', { viaKey: true }),
      ['down', 'down_side', 'side', 'up_side', 'up'],
      'down -> up must ease through the right arc',
    );
  });

  await t.test('3. every live 8x8 transition resolves correctly and monotonically', () => {
    for (const from of DIR8) {
      for (const to of DIR8) {
        if (from === to) continue;
        const seq = liveTurn(from, to);
        // Ends exactly on the target's authored basis.
        const basis = DIR8_BASIS[normalizeDir8(to)];
        const last = seq[seq.length - 1];
        assert.equal(
          last, `${basis.dir}${basis.flip ? '*' : ''}`,
          `${from}->${to} settles on the target frame`,
        );
        // Monotonic in drawn angle toward the target (never reverses).
        const angles = seq.map(drawnAngle);
        let sign = 0;
        for (let i = 1; i < angles.length; i++) {
          const d = signedDelta(angles[i - 1], angles[i]);
          if (d === 0) continue;
          const s = Math.sign(d);
          if (sign === 0) sign = s;
          else assert.equal(s, sign, `${from}->${to} reversed mid-turn (${seq.join(',')})`);
        }
      }
    }
  });

  await t.test('4. every 45-degree octant step is a single drawn bucket', () => {
    for (const from of DIR8) {
      const to = rotateDir8(from, 1);
      const seq = liveTurn(from, to);
      assert.equal(seq.length, 2, `${from}->${to} is one drawn step (${seq.join(',')})`);
    }
  });

  await t.test('5. the mirrored diagonal really draws flipped pixels (draw path)', () => {
    const stateDirs = ARCHER.animations.idle;
    const render = (dir) => {
      const { dir: fd, flip } = resolveSpriteFrame(ARCHER, { state: 'idle', dir, frame: 0 });
      const pix = applyOutline(parseFrame(ARCHER.frames[stateDirs[fd][0]], ARCHER.palette), ARCHER.palette['0'] || '#0b0d12');
      return scalePixels(pix, 1, flip);
    };
    const downRight = render('down_right');
    const downLeft = render('down_left');
    // Same authored frame, drawn mirrored: identical dimensions...
    assert.equal(downLeft.w, downRight.w);
    assert.equal(downLeft.h, downRight.h);
    // ...and every pixel is the horizontal mirror of its counterpart.
    let mismatches = 0;
    for (let y = 0; y < downRight.h; y++) {
      for (let x = 0; x < downRight.w; x++) {
        const a = (y * downRight.w + x) * 4;
        const b = (y * downRight.w + (downRight.w - 1 - x)) * 4;
        if (downRight.data[a] !== downLeft.data[b]
          || downRight.data[a + 1] !== downLeft.data[b + 1]
          || downRight.data[a + 2] !== downLeft.data[b + 2]
          || downRight.data[a + 3] !== downLeft.data[b + 3]) mismatches++;
      }
    }
    assert.equal(mismatches, 0, 'down_left must be the exact horizontal mirror of down_right');
  });

  await t.test('6. a mid-turn 180-degree target churn keeps the committed sign', () => {
    // Start an arc up -> right (sign -1), reaching up_right.
    const a = { facing: 'up', anim: createAnimState('up') };
    a.facing = 'right';
    advanceTurn(a, 50, 50);
    assert.equal(a.anim.dir, 'up_right');
    assert.equal(a.anim.turnSign, -1, 'the committed sign is counter-clockwise');
    // Churn the target to the drawn dir's exact opposite (the 180-degree tie).
    a.facing = 'down_left';
    advanceTurn(a, 50, 50);
    assert.equal(a.anim.turnSign, -1, 'the tie must keep the committed sign (no reversal)');
    assert.equal(a.anim.dir, 'right', 'the arc continues the same way, it does not flip back');
    // ...and it still reaches the target in four buckets (no stall).
    const trail = [a.anim.dir];
    for (let i = 0; i < 6 && a.anim.dir !== 'down_left'; i++) {
      advanceTurn(a, 50, 50);
      trail.push(a.anim.dir);
    }
    assert.deepEqual(trail, ['right', 'down_right', 'down', 'down_left']);
  });

  await t.test('7. the same arc holds while walking (walk state), not just idle', () => {
    const player = createPartyPlayer('archer');
    player.facing = 'up';
    player.anim = createAnimState('up');
    player.party = [];
    const { app, advance } = makeApp(player);
    hold(app, 'ArrowUp');
    for (let i = 0; i < 30; i++) advance();
    app.keysDown.clear();
    hold(app, 'ArrowDown');
    const drawn = [];
    for (let i = 0; i < 40; i++) drawn.push(...advance());
    const seq = [];
    for (const f of drawn) if (seq[seq.length - 1] !== f) seq.push(f);
    assert.deepEqual(
      seq,
      ['up', 'up_side*', 'side*', 'down_side*', 'down'],
      'the walking turn is the same mirrored left arc',
    );
    assert.equal(player.anim.state, 'walk', 'the player really was walking');
  });
});
