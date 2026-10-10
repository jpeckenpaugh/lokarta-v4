/**
 * LIV-140: procedural defeat "squish" for opponents without authored death
 * frames (the 3D-baked creature class). The board asked for a runtime-only
 * flattening of the existing artwork rather than re-rendered squash frames.
 *
 * These tests pin:
 *   1. eligibility — a def with no `animations.death` spawns a `procedural`
 *      death effect; a tower opponent with authored death frames does not.
 *   2. the pure squish transform (0 -> identity, 1 -> flat + wider, monotonic).
 *   3. drawActor actually applies the transform only when `opts.squish` is set.
 *   4. timing stays consistent with the existing death effect (`totalMs`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { combatControllerMethods } from '../app/combat-controller.js';
import { squishScaleFor } from '../app/animation-state.js';
import { SpriteRenderer } from '../app/sprite-renderer.js';
import { SPRITE_CATALOG } from '../assets/sprites/index.js';
import { PROCEDURAL_SQUISH } from '../data/index.js';

/** Minimal `this` for the combat-controller prototype mixin. */
function makeApp() {
  const app = Object.create(combatControllerMethods);
  app.deathEffects = [];
  return app;
}

function mkMonster(type, overrides = {}) {
  return {
    id: `test_${type}`,
    type,
    name: type,
    x: 4,
    y: 5,
    hp: 0,
    max_hp: 100,
    facing: 'down',
    ...overrides,
  };
}

/** A canvas-free ctx that records transform calls; forces the pixel fallback. */
function recordingCtx() {
  const calls = { translate: [], scale: [], fillRect: 0, save: 0, restore: 0 };
  return {
    globalAlpha: 1,
    fillStyle: '',
    save() { calls.save += 1; },
    restore() { calls.restore += 1; },
    translate(x, y) { calls.translate.push([x, y]); },
    scale(x, y) { calls.scale.push([x, y]); },
    rotate() {},
    fillRect() { calls.fillRect += 1; },
    _calls: calls,
  };
}

test('LIV-140 procedural defeat squish', async (t) => {
  await t.test('1. eligibility follows the sprite def, not the monster type', () => {
    const app = makeApp();
    // A 3D-baked creature has no authored death frames.
    assert.equal(SPRITE_CATALOG.river_rat.animations.death, undefined, 'river_rat has no death anim');
    app.spawnDeathEffect(mkMonster('river_rat'));
    assert.equal(app.deathEffects.length, 1, 'a death effect is spawned');
    assert.equal(app.deathEffects[0].procedural, true, 'river_rat plays the procedural squish');

    // A tower opponent carries authored death frames and must stay untouched.
    assert.ok(SPRITE_CATALOG.giant_rat.animations.death.down.length > 0, 'giant_rat has authored death');
    app.spawnDeathEffect(mkMonster('giant_rat'));
    assert.equal(app.deathEffects[1].procedural, false, 'giant_rat keeps its authored death animation');
  });

  await t.test('2. totalMs matches the existing death-effect timing', () => {
    const app = makeApp();
    app.spawnDeathEffect(mkMonster('river_rat'));
    // 3D creature has no authored frames, so it uses the non-boss fallback (4).
    assert.equal(app.deathEffects[0].totalMs, 4 * 120 + 200, 'procedural totalMs');
    app.spawnDeathEffect(mkMonster('giant_rat'));
    assert.equal(app.deathEffects[1].totalMs, 4 * 120 + 200, 'authored totalMs (4 frames)');
    app.spawnDeathEffect(mkMonster('abyssal_overlord', { isBoss: true }));
    assert.equal(app.deathEffects[2].totalMs, 6 * 120 + 200, 'boss authored totalMs (6 frames)');
  });

  await t.test('3. squishScaleFor is pure, bounded, and monotonic', () => {
    const start = squishScaleFor(0, PROCEDURAL_SQUISH);
    assert.deepEqual(start, { scaleX: 1, scaleY: 1 }, 'no squash at progress 0');

    const flat = squishScaleFor(1, PROCEDURAL_SQUISH);
    assert.ok(Math.abs(flat.scaleY - (1 - PROCEDURAL_SQUISH.squashY)) < 1e-9, 'flattens by squashY');
    assert.ok(flat.scaleX > 1, 'widens slightly as it flattens');

    let prevY = 1;
    let prevX = 1;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const { scaleX, scaleY } = squishScaleFor(p, PROCEDURAL_SQUISH);
      assert.ok(scaleY <= prevY + 1e-9, `scaleY non-increasing at p=${p}`);
      assert.ok(scaleX >= prevX - 1e-9, `scaleX non-decreasing at p=${p}`);
      assert.ok(scaleY >= PROCEDURAL_SQUISH.minScaleY - 1e-9, 'never below the floor');
      prevY = scaleY;
      prevX = scaleX;
    }

    // Out-of-range progress clamps, and a partial style still yields a transform.
    assert.deepEqual(squishScaleFor(2, PROCEDURAL_SQUISH), squishScaleFor(1, PROCEDURAL_SQUISH));
    assert.deepEqual(squishScaleFor(-1, PROCEDURAL_SQUISH), squishScaleFor(0, PROCEDURAL_SQUISH));
    const fallback = squishScaleFor(1, {});
    assert.ok(fallback.scaleY > 0 && fallback.scaleY < 1 && fallback.scaleX >= 1, 'safe fallback style');
  });

  await t.test('4. drawActor applies the squish transform only when requested', () => {
    const actor = { spriteId: 'river_rat', facing: 'down', anim: { state: 'idle', dir: 'down', frame: 0 } };

    const plain = recordingCtx();
    SpriteRenderer.drawActor(plain, actor, 100, 200, { size: 64 });
    assert.equal(plain._calls.scale.length, 0, 'no squish -> no scale transform');

    const squished = recordingCtx();
    SpriteRenderer.drawActor(squished, actor, 100, 200, { size: 64, squish: 0.5 });
    assert.equal(squished._calls.scale.length, 1, 'squish -> one scale transform');
    const [sx, sy] = squished._calls.scale[0];
    const expected = squishScaleFor(0.5, PROCEDURAL_SQUISH);
    assert.ok(Math.abs(sx - expected.scaleX) < 1e-9, 'scaleX applied');
    assert.ok(Math.abs(sy - expected.scaleY) < 1e-9, 'scaleY applied');
    // Anchored to the sprite's ground point (bottom-centre), not the tile origin.
    assert.deepEqual(squished._calls.translate[0], [100 + 32, 200 + 64], 'ground-point pivot');
  });

  await t.test('5. player/other actors are unaffected', () => {
    const ctx = recordingCtx();
    // No `squish` opt -> identity, regardless of actor kind.
    SpriteRenderer.drawActor(ctx, { vocation: 'fighter', facing: 'down', anim: { state: 'walk', dir: 'down', frame: 0 } }, 0, 0, { size: 64 });
    assert.equal(ctx._calls.scale.length, 0, 'player draws with no squish');
  });
});
