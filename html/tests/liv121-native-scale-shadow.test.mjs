import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SpriteRenderer,
  atomicNative,
  groundShadowStyle,
  buildShadowMask,
  GROUND_SHADOW_DEFAULTS,
  drawSpriteFrameInto,
} from '../app/sprite-renderer.js';
import { SPRITE_CATALOG, BUILDING_CATALOG, PROP_CATALOG } from '../assets/sprites/index.js';
import { nativePerTile } from '../../tools/validate-sprite-def.mjs';

// LIV-121 (Phase 1 of LIV-116 rev 2): native-aware display scale (3D-sourced
// sprites render 1:1 at the default 64 px tile; hand-authored 32-native sprites
// keep their x2 path) and the per-frame silhouette ground shadow.

function makeFakeCtx() {
  const calls = [];
  const noop = (name) => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save: noop('save'),
    restore: noop('restore'),
    fillRect: noop('fillRect'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    arc: noop('arc'),
    ellipse: noop('ellipse'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    drawImage: noop('drawImage'),
  };
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  return ctx;
}

const SCOPE_TABLE = [
  ['archer', 'actor'],
  ['fishing_hut', 'building'],
  ['fishing_hut_back', 'building'],
  ['fishing_hut_large', 'building'],
  ['fishing_hut_left', 'building'],
  ['fishing_hut_right', 'building'],
  ['fishers_house', 'building'],
  ['fishers_house_large', 'building'],
  ['longhouse', 'building'],
  ['prop_fishers_net', 'prop'],
  ['prop_fishers_net_vertical', 'prop'],
];

test('LIV-121 native-aware scale', async (t) => {
  await t.test('1. scaleForSize honours the def native (N64 -> 1:1, N32 -> x2)', () => {
    assert.equal(SpriteRenderer.scaleForSize(64, 64), 1, 'N64 is 1:1 at the default tile');
    assert.equal(SpriteRenderer.scaleForSize(64, 32), 2, 'N32 keeps the x2 path');
    assert.equal(SpriteRenderer.scaleForSize(64), 2, 'default native is 32 (legacy callers unchanged)');
    assert.equal(SpriteRenderer.scaleForSize(96, 64), 1, 'never exceeds the tile');
    assert.equal(SpriteRenderer.scaleForSize(32, 64), 1, 'min 1 even below native');
    assert.equal(SpriteRenderer.scaleForSize(128, 64), 2, 'integer multiple');
  });

  await t.test('2. atomicNative reads the per-tile native of any def shape', () => {
    assert.equal(atomicNative(SPRITE_CATALOG.archer), 64, 'single-tile N64 actor');
    assert.equal(atomicNative(SPRITE_CATALOG.magician), 32, 'single-tile N32 actor');
    assert.equal(atomicNative(PROP_CATALOG.prop_fishers_net), 64, 'multi-tile N64 prop != canvas width');
    assert.equal(atomicNative(BUILDING_CATALOG.longhouse), 64, 'multi-tile N64 building');
    assert.equal(atomicNative(null), 32, 'safe default');
  });

  await t.test('3. drawActor renders an N64 sprite 1:1 and an N32 sprite x2 at the default tile', () => {
    const ctxA = makeFakeCtx();
    const geoA = SpriteRenderer.drawActor(ctxA, { spriteId: 'archer', anim: { state: 'idle', dir: 'down' } }, 0, 0, { size: 64 });
    assert.ok(geoA, 'archer draws');
    assert.equal(geoA.scale, 1, 'N64 archer is 1:1');
    assert.equal(geoA.w, 64, 'N64 archer canvas is exactly one 64 px tile');

    const ctxM = makeFakeCtx();
    const geoM = SpriteRenderer.drawActor(ctxM, { vocation: 'magician', anim: { state: 'idle', dir: 'down' } }, 0, 0, { size: 64 });
    assert.ok(geoM, 'magician draws');
    assert.equal(geoM.scale, 2, 'N32 magician keeps x2');
    assert.equal(geoM.w, 64, 'x2 of 32 native also fits one tile');
  });

  await t.test('4. every scope-table def is 3D-baked N64; hand-authored actors stay N32', () => {
    for (const [id, kind] of SCOPE_TABLE) {
      const def = kind === 'building' ? BUILDING_CATALOG[id] : kind === 'prop' ? PROP_CATALOG[id] : SPRITE_CATALOG[id];
      assert.ok(def, `${id} registered`);
      assert.equal(def.renderTier, 'baked', `${id} is Tier B`);
      assert.equal(atomicNative(def), 64, `${id} renders 1:1 (N64)`);
      if (def.tiles) assert.equal(nativePerTile(def), 64, `${id} native == tiles * 64`);
      else assert.deepEqual(def.native, { w: 64, h: 64 }, `${id} single-tile canvas is 64x64`);
    }
    for (const id of ['magician', 'paladin', 'fighter', 'giant_rat', 'shadow_cultist']) {
      assert.equal(atomicNative(SPRITE_CATALOG[id]), 32, `${id} stays N32 (no upscaling)`);
    }
  });
});

test('LIV-121 silhouette ground shadow', async (t) => {
  // Two tall columns (x=0 and x=8) spanning the full height. After squashing
  // about the bottom edge the mask must keep BOTH columns and stay bottom-anchored
  // — an ellipse/rect would fill the gap between them.
  const rows = Array.from({ length: 16 }, () => 'x.......x.......');
  const synthetic = {
    id: 'synth_shadow',
    native: { w: 16, h: 16 },
    palette: { '.': null, x: '#ffffff' },
    frames: { f: rows },
  };

  await t.test('5. the mask follows the silhouette and squashes onto the ground band', () => {
    const style = groundShadowStyle(null);
    const mask = buildShadowMask(synthetic, 'f');
    assert.ok(mask, 'mask built');
    const opaque = (x, y) => mask.data[(y * mask.w + x) * 4 + 3] > 0;
    const bbox = (() => {
      let minx = mask.w, maxx = -1, miny = mask.h, maxy = -1;
      for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) {
        if (mask.data[(y * mask.w + x) * 4 + 3] === 0) continue;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      return { minx, maxx, miny, maxy };
    })();
    // Both silhouette columns survive; the gap between them stays transparent, so
    // the mask is silhouette-shaped, not a filled ellipse/rect.
    assert.equal(opaque(0, mask.h - 1), true, 'left column shadow on the ground');
    assert.equal(opaque(8, mask.h - 1), true, 'right column shadow on the ground');
    assert.equal(opaque(4, mask.h - 1), false, 'gap between columns stays transparent (not an ellipse)');
    assert.equal(bbox.minx, 0, 'mask keeps the silhouette x');
    assert.equal(bbox.maxx, 8, 'mask keeps the silhouette width');
    assert.equal(bbox.maxy, mask.h - 1, 'mask sits on the ground edge');
    // Confined to the lower band: nothing above the squashed band start.
    const bandH = Math.max(1, Math.round(mask.h * style.squashY));
    assert.ok(bbox.miny >= mask.h - bandH, `mask confined to the ${bandH}px ground band (miny=${bbox.miny})`);
    assert.ok(bbox.miny > 0, 'no shadow at the top of the tile');
  });

  await t.test('6. the mask is tinted to the style colour (not black), per-frame, and opt-out-able', () => {
    const def = SPRITE_CATALOG.archer;
    const style = groundShadowStyle(def);
    const mask = buildShadowMask(def, 'idle_down', style);
    const [r, g, b] = [0, 1, 2].map((i) => parseInt(style.color.slice(1 + i * 2, 3 + i * 2), 16));
    let found = false;
    for (let i = 0; i < mask.w * mask.h; i++) {
      if (mask.data[i * 4 + 3] === 0) continue;
      assert.equal(mask.data[i * 4], r); assert.equal(mask.data[i * 4 + 1], g); assert.equal(mask.data[i * 4 + 2], b);
      found = true; break;
    }
    assert.ok(found, 'mask has opaque pixels');
    // A different pose (a collapsed death frame) yields a different mask, so the
    // shadow follows the per-frame silhouette rather than a fixed shape.
    const death = buildShadowMask(def, 'death_3', style);
    assert.notDeepEqual([...mask.data], [...death.data], 'shadow follows the per-frame silhouette');
    // The opt-out style is honoured by the renderer.
    assert.equal(groundShadowStyle({ groundShadow: { enabled: false } }).enabled, false);
  });

  await t.test('7. groundShadowStyle defaults are the art contract values and overrides merge', () => {
    const d = groundShadowStyle(null);
    assert.equal(d.enabled, true);
    assert.equal(d.shape, 'silhouette');
    assert.equal(d.color, GROUND_SHADOW_DEFAULTS.color);
    assert.equal(d.squashY, GROUND_SHADOW_DEFAULTS.squashY);
    assert.deepEqual(d.offset, GROUND_SHADOW_DEFAULTS.offset);
    const o = groundShadowStyle({ groundShadow: { alpha: 0.5, offset: { x: 0.1 } } });
    assert.equal(o.alpha, 0.5, 'override alpha');
    assert.equal(o.offset.x, 0.1, 'partial offset override');
    assert.equal(o.offset.y, GROUND_SHADOW_DEFAULTS.offset.y, 'missing offset field falls back');
    assert.equal(groundShadowStyle({ groundShadow: { enabled: false } }).enabled, false, 'opt-out');
  });

  await t.test('8. the procedural fallback draws a styled ellipse, never the old hard-coded one', () => {
    const ctx = makeFakeCtx();
    // An unknown vocation with no sprite takes the procedural path.
    SpriteRenderer.drawPlayer(ctx, { vocation: 'not_a_vocation' }, 0, 0, 64);
    const ellipses = ctx.calls.filter((c) => c.name === 'ellipse');
    assert.equal(ellipses.length, 1, 'exactly one shadow ellipse in the fallback');
    const shadows = ctx.calls.filter((c) => c.name === 'fill');
    assert.ok(shadows.length > 0, 'shadow filled');
    // The silhouette shadow in drawActor must not draw a bare ellipse.
    const ctx2 = makeFakeCtx();
    SpriteRenderer.drawActor(ctx2, { spriteId: 'archer', anim: { state: 'idle', dir: 'down' } }, 0, 0, { size: 64 });
    assert.equal(ctx2.calls.filter((c) => c.name === 'ellipse').length, 0, 'sprite actors use the silhouette shadow, not an ellipse');
  });

  await t.test('9. the building blit sizes N64 from the def into the footprint (scale 1)', () => {
    const ctx = makeFakeCtx();
    const def = BUILDING_CATALOG.longhouse; // 768x256 native, 12x4 tiles
    const ok = drawSpriteFrameInto(ctx, def, 'view_0', 0, 0, 768, 256);
    assert.equal(ok, true, 'N64 longhouse blits into its 12x4 footprint at scale 1');
  });
});
