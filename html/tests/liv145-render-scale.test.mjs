import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SpriteRenderer,
  resolveRenderScale,
  actorRenderBox,
  UNIT_RENDER_SCALE,
  HUMANOID_RENDER_BOX,
} from '../app/sprite-renderer.js';
import { SPRITE_CATALOG } from '../assets/sprites/index.js';
import { NPCS_CATALOG, getNpcDefinition } from '../data/index.js';
import { makeNpcRuntime } from '../engine/npc-system.js';

// LIV-145 (source: LIV-141 board direction): a data-driven per-actor render scale
// (height AND width multiplier). Board values:
//   pilgrims_apprentice_tam (Young Tam)  -25%  -> 0.75
//   child_kes (Kes)                      -50%  -> 0.5
//   captain_halden (Captain Halden)      +50%  -> 1.5
//   elder_rowan_vane (The Weigher)       +50%  -> 1.5
// The multiplier scales the LIV-142 humanoid render box on each axis while the
// render stays centre-bottom anchored (feet on the tile) so the ground shadow and
// HP/quest-marker anchors track the scaled box. Scale is per-NPC catalog data,
// never a per-name branch in draw code.

const EXPECTED = {
  pilgrims_apprentice_tam: 0.75,
  child_kes: 0.5,
  captain_halden: 1.5,
  elder_rowan_vane: 1.5,
};

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

test('LIV-145 per-actor render scale', async (t) => {
  await t.test('resolveRenderScale defaults to the frozen 1:1 singleton', () => {
    assert.deepEqual(resolveRenderScale(null), { w: 1, h: 1 });
    assert.deepEqual(resolveRenderScale({}), { w: 1, h: 1 });
    assert.equal(resolveRenderScale({}), UNIT_RENDER_SCALE, 'default path is allocation-free');
    // A single multiplier applies to both axes.
    assert.deepEqual(resolveRenderScale({ renderScale: 0.5 }), { w: 0.5, h: 0.5 });
    assert.deepEqual(resolveRenderScale({ renderScale: '1.5' }), { w: 1.5, h: 1.5 });
    // An explicit pair is honoured independently per axis.
    assert.deepEqual(resolveRenderScale({ renderScale: { w: 1.25, h: 0.75 } }), { w: 1.25, h: 0.75 });
    // Invalid values fall back to 1 (never throw, never a zero-size actor).
    assert.deepEqual(resolveRenderScale({ renderScale: 0 }), { w: 1, h: 1 });
    assert.deepEqual(resolveRenderScale({ renderScale: -2 }), { w: 1, h: 1 });
    assert.deepEqual(resolveRenderScale({ renderScale: 'x' }), { w: 1, h: 1 });
    assert.deepEqual(resolveRenderScale({ renderScale: { w: 'nope' } }), { w: 1, h: 1 });
  });

  await t.test('actorRenderBox scales the humanoid box per axis', () => {
    const def = SPRITE_CATALOG.npc_captain_halden;
    assert.deepEqual(HUMANOID_RENDER_BOX, { w: 72, h: 96 });
    assert.deepEqual(actorRenderBox(def, 64), { w: 72, h: 96 }, 'unscaled keeps the LIV-142 box');
    assert.deepEqual(actorRenderBox(def, 64, { w: 1.5, h: 1.5 }), { w: 108, h: 144 });
    assert.deepEqual(actorRenderBox(def, 64, { w: 0.5, h: 0.5 }), { w: 36, h: 48 });
    assert.deepEqual(actorRenderBox(def, 64, 0.75), { w: 54, h: 72 }, 'raw scalar spec');
    // An explicit per-axis pair is independent (tall-only / wide-only both work).
    assert.deepEqual(actorRenderBox(def, 64, { w: 1, h: 2 }), { w: 72, h: 192 });
    // Non-baked actors never get a box (the scale has nothing to act on).
    assert.equal(actorRenderBox(SPRITE_CATALOG.magician, 64, { w: 2, h: 2 }), null);
    assert.equal(actorRenderBox(null, 64, { w: 2, h: 2 }), null);
  });

  await t.test('drawActor stays centre-bottom anchored at any scale', () => {
    const size = 64;
    const cases = [
      ['captain_halden', 'npc_captain_halden', 1.5, { w: 108, h: 144 }],
      ['child_kes', 'npc_child_kes', 0.5, { w: 36, h: 48 }],
      ['pilgrims_apprentice_tam', 'npc_pilgrims_apprentice_tam', 0.75, { w: 54, h: 72 }],
      ['elder_rowan_vane', 'npc_elder_rowan_vane', 1.5, { w: 108, h: 144 }],
    ];
    for (const [npcId, npcSpriteId, mult, expected] of cases) {
      const actor = {
        npcId,
        npcSpriteId,
        renderScale: { w: mult, h: mult },
        anim: { state: 'idle', dir: 'down', frame: 0 },
      };
      const geo = SpriteRenderer.drawActor(fakeCtx(), actor, 300, 400, { size });
      assert.ok(geo, `${npcId} draws through the sprite pipeline`);
      assert.deepEqual({ w: geo.w, h: geo.h }, expected, `${npcId} scaled box`);
      assert.equal(geo.dx, 300 + Math.round((size - expected.w) / 2), `${npcId} horizontally centred`);
      assert.equal(geo.dy, 400 + size - expected.h, `${npcId} bottom flush (feet on the tile)`);
    }
  });

  await t.test('the npcs.json catalog authors the board scale values', () => {
    for (const [id, mult] of Object.entries(EXPECTED)) {
      const npc = getNpcDefinition(id);
      assert.ok(npc, `${id} catalogued`);
      assert.deepEqual(npc.renderScale, { w: mult, h: mult }, `${id} renderScale`);
    }
    // Every other NPC stays at the implicit 100% (no renderScale authored).
    for (const npc of NPCS_CATALOG.npcs) {
      if (EXPECTED[npc.id]) continue;
      assert.equal(npc.renderScale, undefined, `${npc.id} stays at 100%`);
    }
  });

  await t.test('makeNpcRuntime forwards renderScale onto the runtime entity', () => {
    const runtime = makeNpcRuntime(getNpcDefinition('captain_halden'));
    assert.deepEqual(runtime.renderScale, { w: 1.5, h: 1.5 });
    assert.deepEqual(resolveRenderScale(runtime), { w: 1.5, h: 1.5 });
    // An NPC without a scale forwards null and resolves to the 1:1 singleton.
    const plain = makeNpcRuntime({ id: 'plain', name: 'Plain', x: 0, y: 0 });
    assert.equal(plain.renderScale, null);
    assert.equal(resolveRenderScale(plain), UNIT_RENDER_SCALE);
  });
});
