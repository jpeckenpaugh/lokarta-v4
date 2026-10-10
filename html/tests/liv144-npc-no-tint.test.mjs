import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SpriteRenderer,
  resolveSpriteId,
  resolveActorTint,
} from '../app/sprite-renderer.js';
import { SPRITE_CATALOG } from '../assets/sprites/index.js';

// LIV-144 (source: LIV-141 board direction): town NPCs must NOT be diversified
// by colour tinting — only their original 3D-baked `npcSpriteId` art renders.
// A missing/unknown `npcSpriteId` must not fall back to a tinted variant of the
// shared `spriteId`. These assertions lock the renderer guarantee, independent
// of whether the Ambient roster still carries inert `renderTheme` catalog data.

const NPC_THEME = { hex: '#3b4a6b', amount: 0.4 };

/** Recording 2D-context stub: node has no canvas, so drawActor paints pixels. */
function fakeCtx() {
  const styles = [];
  const ctx = {
    styles,
    canvas: { width: 256, height: 256 },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save() {}, restore() {},
    fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, fill() {}, stroke() {},
    translate() {}, rotate() {}, scale() {}, clip() {}, rect() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  Object.defineProperty(ctx, 'fillStyle', { get() { return '#000'; }, set(v) { styles.push(v); } });
  return ctx;
}

function drawStyles(actor, opts = {}) {
  const ctx = fakeCtx();
  const geo = SpriteRenderer.drawActor(ctx, actor, 0, 0, { size: 64, ...opts });
  assert.ok(geo, 'actor draws through the sprite pipeline');
  return ctx.styles;
}

test('LIV-144 town NPCs render with no tint/recolour', async (t) => {
  await t.test('resolveActorTint suppresses every tint for a runtime NPC', () => {
    const npc = {
      npcId: 'captain_halden',
      npcSpriteId: 'npc_captain_halden',
      spriteId: 'fighter',
      renderTheme: NPC_THEME,
    };
    // Caller status tint, legacy renderTheme tint, and hit flash all yield null.
    assert.equal(resolveActorTint(npc, { tint: NPC_THEME }, { hex: '#ff4d4d', amount: 0.35 }), null);
    assert.equal(resolveActorTint(npc, { tint: NPC_THEME }), null);
    assert.equal(resolveActorTint(npc), null);
  });

  await t.test('resolveActorTint keeps the caller status tint for non-NPC actors', () => {
    const monster = { type: 'giant_rat' };
    assert.deepEqual(resolveActorTint(monster, { tint: { hex: '#ff0000', amount: 0.5 } }), { hex: '#ff0000', amount: 0.5 });
    assert.deepEqual(resolveActorTint(monster, {}, { hex: '#ff4d4d', amount: 0.35 }), { hex: '#ff4d4d', amount: 0.35 });
    assert.equal(resolveActorTint(monster), null);
  });

  await t.test('an authored NPC sprite draws identically with or without renderTheme', () => {
    const anim = { state: 'idle', dir: 'down', frame: 0 };
    const npc = { npcId: 'captain_halden', npcSpriteId: 'npc_captain_halden', spriteId: 'fighter', anim };
    const plain = drawStyles({ ...npc });
    const tinted = drawStyles({ ...npc }, { tint: NPC_THEME });
    assert.deepEqual(tinted, plain, 'renderTheme must not recolour an NPC sprite');
    assert.deepEqual(plain, drawStyles({ ...npc }, { tint: NPC_THEME }), 'stable — no tint baked');
  });

  await t.test('a missing/unknown npcSpriteId never falls back to a tinted variant', () => {
    const anim = { state: 'idle', dir: 'down', frame: 0 };
    const npc = { npcId: 'ghost', npcSpriteId: 'npc_not_authored', spriteId: 'fighter', renderTheme: NPC_THEME, anim };
    // Migration safety: resolution still falls through to the shared sprite...
    assert.equal(resolveSpriteId(npc), 'fighter');
    assert.ok(SPRITE_CATALOG.fighter, 'fallback sprite exists');
    // ...but the NPC marker means the fallback art renders unmodified, too.
    const plain = drawStyles({ ...npc });
    const tinted = drawStyles({ ...npc }, { tint: NPC_THEME });
    assert.deepEqual(tinted, plain, 'fallback sprite must not be tinted for an NPC');
  });

  await t.test('control: a non-NPC actor still honours an explicit tint (harness sanity)', () => {
    const anim = { state: 'idle', dir: 'down', frame: 0 };
    const monster = { type: 'giant_rat', anim };
    const plain = drawStyles({ ...monster });
    const tinted = drawStyles({ ...monster }, { tint: { hex: '#ff0000', amount: 0.5 } });
    assert.notDeepEqual(tinted, plain, 'the recording harness detects a real tint');
  });
});
