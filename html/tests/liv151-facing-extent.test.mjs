import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SpriteRenderer,
  facingExtentFor,
  resolveFacingBox,
  actorRenderBox,
  HUMANOID_RENDER_BOX,
} from '../app/sprite-renderer.js';
import { DIR8 } from '../app/animation-state.js';
import { SPRITE_CATALOG } from '../assets/sprites/index.js';

// LIV-151 (source: LIV-141 board ask #3): some actors are "wide but not tall" —
// a rat is short but long (tail behind). A single square box squishes it
// nose-to-tail when it faces left/right, so those actors author a data-driven
// per-facing extent (`facingBox`) with the front/back and side extremes, the
// width interpolated by the facing angle and the render kept centre-bottom
// anchored (feet on the tile) so the sprite never jumps as it rotates.
//
//   1. `facingExtentFor` interpolates front/back -> side by angle (side ~2x).
//   2. `resolveFacingBox` scales the extent to the tile + per-actor renderScale.
//   3. `drawActor` is visibly wider side-on, centre-anchored across all 8 angles.
//   4. The rat-like catalog defs author it; humanoids keep the 72x96 box.

const RAT_LIKE = ['giant_rat', 'river_rat', 'river_piranha', 'river_eel'];
const DIAGONALS = ['down_right', 'up_right', 'up_left', 'down_left'];

/** Recording 2D-context stub: node has no canvas, so drawActor paints pixels. */
function fakeCtx() {
  const calls = [];
  const ctx = {
    calls,
    canvas: { width: 256, height: 256 },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save() {}, restore() {},
    fillRect(...a) { calls.push(a); },
    strokeRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
    translate() {}, rotate() {}, scale() {}, clip() {}, rect() {},
    fillText() {}, measureText() { return { width: 0 }; }, setLineDash() {},
    drawImage() { calls.push(['drawImage']); },
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  Object.defineProperty(ctx, 'fillStyle', { get() { return '#000'; }, set() {} });
  return ctx;
}

test('LIV-151 per-facing render sizing for wide-short actors', async (t) => {
  await t.test('1. facingExtentFor interpolates front/back <-> side by angle', () => {
    const def = SPRITE_CATALOG.river_rat;
    const front = facingExtentFor(def, 'down');
    const back = facingExtentFor(def, 'up');
    const sideR = facingExtentFor(def, 'right');
    const sideL = facingExtentFor(def, 'left');

    // Front and back are the same narrow extent; side is ~2x wide, same height.
    assert.deepEqual(front, back, 'front and back share the front extent');
    assert.deepEqual(sideR, sideL, 'left is the mirror of right');
    assert.equal(sideR.w, front.w * 2, 'side is roughly double the width');
    assert.equal(sideR.h, front.h, 'height (shortness) is unchanged');

    // The four 45-degree diagonals land strictly between the two extremes.
    for (const d of DIAGONALS) {
      const e = facingExtentFor(def, d);
      assert.ok(e.w > front.w && e.w < sideR.w, `${d} width is in between`);
      assert.ok(Math.abs(e.h - front.h) < 0.5, `${d} height stays at the front height`);
    }

    // No authored facingBox -> null (humanoid / tile-scale path untouched).
    assert.equal(facingExtentFor(SPRITE_CATALOG.magician, 'right'), null);
    assert.equal(facingExtentFor(SPRITE_CATALOG.archer, 'right'), null);
    assert.equal(facingExtentFor(null, 'right'), null);
  });

  await t.test('2. resolveFacingBox scales the extent to tile + renderScale', () => {
    const def = SPRITE_CATALOG.river_rat;
    assert.deepEqual(resolveFacingBox(def, 64, null, 'down'), { w: 64, h: 64 });
    assert.deepEqual(resolveFacingBox(def, 64, null, 'right'), { w: 128, h: 64 });
    // renderScale (LIV-145) multiplies each axis of the resolved per-facing box.
    assert.deepEqual(resolveFacingBox(def, 64, { w: 2, h: 2 }, 'right'), { w: 256, h: 128 });
    assert.deepEqual(resolveFacingBox(def, 64, 0.5, 'down'), { w: 32, h: 32 });
    // A 128 px display tile scales the ref-tile extent up.
    assert.deepEqual(resolveFacingBox(def, 128, null, 'right'), { w: 256, h: 128 });
    // A def without a facingBox resolves to null so the caller uses the humanoid box.
    assert.equal(resolveFacingBox(SPRITE_CATALOG.archer, 64, null, 'right'), null);
  });

  await t.test('3. drawActor is wider side-on and centre-bottom anchored at all 8 angles', () => {
    const size = 64;
    const screenX = 300;
    const screenY = 400;
    const geos = new Map();
    for (const dir of DIR8) {
      const actor = { spriteId: 'river_rat', facing: dir, anim: { state: 'idle', dir, frame: 0 } };
      const geo = SpriteRenderer.drawActor(fakeCtx(), actor, screenX, screenY, { size });
      assert.ok(geo, `${dir} draws through the sprite pipeline`);
      geos.set(dir, geo);

      // Centre-anchored: the sprite's horizontal centre stays on the tile centre
      // (within rounding) and its feet stay on the bottom of the tile for every
      // angle, so it never jumps as it rotates.
      const centerX = geo.dx + geo.w / 2;
      assert.ok(Math.abs(centerX - (screenX + size / 2)) <= 0.5, `${dir} horizontally centred`);
      assert.equal(geo.dy + geo.h, screenY + size, `${dir} feet flush with the tile`);
    }

    const front = geos.get('down');
    const back = geos.get('up');
    const side = geos.get('right');
    assert.equal(front.w, 64);
    assert.equal(back.w, 64);
    assert.ok(side.w >= front.w * 2 - 1, 'side-facing is ~2x wider than front/back');
    for (const d of DIAGONALS) {
      const w = geos.get(d).w;
      assert.ok(w > front.w && w < side.w, `${d} renders between front and side`);
    }
  });

  await t.test('4. the rat-like catalog defs author facingBox; humanoids keep 72x96', () => {
    for (const id of RAT_LIKE) {
      const def = SPRITE_CATALOG[id];
      assert.ok(def, `${id} catalogued`);
      assert.ok(def.facingBox && def.facingBox.front && def.facingBox.side, `${id} authors front/side extents`);
      assert.ok(def.facingBox.side.w > def.facingBox.front.w, `${id} side is wider than front`);
    }
    // Humanoid actors are untouched: no facingBox, and the LIV-142 box stands.
    assert.equal(SPRITE_CATALOG.archer.facingBox, undefined);
    assert.deepEqual(HUMANOID_RENDER_BOX, { w: 72, h: 96 });
    assert.deepEqual(actorRenderBox(SPRITE_CATALOG.archer, 64), { w: 72, h: 96 });
  });
});
