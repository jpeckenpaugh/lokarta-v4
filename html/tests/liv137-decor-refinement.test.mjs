import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES } from '../engine/config.js';
import {
  DEFAULT_ISLAND_ID,
  DEFAULT_TOWN_ID,
  getIslandDefinition,
  getTownDefinition,
} from '../data/index.js';
import { composeSceneById, sceneAccessReport } from '../services/scene-composer.js';
import { PROP_CATALOG, PROP_MANIFEST } from '../assets/sprites/index.js';
import {
  validateSpriteDef,
  paletteCapFor,
  nativePerTile,
} from '../../tools/validate-sprite-def.mjs';
import { SpriteRenderer, sceneTheme } from '../app/sprite-renderer.js';

// LIV-137 (Phase 4 of LIV-132): the board's four decor refinements —
//   1. palms: keep 1x2 as the "small palm", add a larger 2x3, bake several angles;
//   2. rock pile -> zoom-to-fit 2x2, several angle variants;
//   3. dock -> 90deg-rotated 3x3 replacing the old 1-tall dock;
//   4. Dawnreach Isle's 2D TREE tiles -> 3D palm/rock props at varied sizes/angles
//      WITHOUT touching the tile walkability/collision contract.

// Palms author four non-edge-on azimuths (90/270 render edge-on as slivers);
// rocks keep the four cardinal views.
const PALM_VIEWS = ['view_0', 'view_45', 'view_135', 'view_225'];
const ROCK_VIEWS = ['view_0', 'view_90', 'view_180', 'view_270'];

/** Content bbox (non-transparent) of a frame. */
function bbox(rows) {
  let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  rows.forEach((r, y) => [...r].forEach((ch, x) => {
    if (ch === '.') return;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }));
  return { minx, maxx, miny, maxy };
}

function fakeCtx() {
  const styles = [];
  const calls = [];
  const ctx = {
    styles,
    calls,
    canvas: { width: 256, height: 256 },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save() {}, restore() {},
    fillRect(...a) { calls.push(a); },
    strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
    drawImage() { calls.push(['drawImage']); },
  };
  Object.defineProperty(ctx, 'fillStyle', { get() { return '#000'; }, set(v) { styles.push(v); } });
  return ctx;
}

test('LIV-137 decor refinement', async (t) => {
  await t.test('1. palms: 1x2 "small" + 2x3 "large", several baked angles', () => {
    const small = PROP_CATALOG.prop_palm_tree;
    const large = PROP_CATALOG.prop_palm_tree_large;
    assert.ok(small && large, 'both palm tiers are catalogued');
    for (const [id, tiles] of [['prop_palm_tree', { w: 1, h: 2 }], ['prop_palm_tree_large', { w: 2, h: 3 }]]) {
      const def = PROP_CATALOG[id];
      assert.equal(def.baked3d, true, `${id} is 3D-baked`);
      assert.equal(def.outline, false, `${id} drops the outline`);
      assert.deepEqual(def.tiles, tiles, `${id} tile size`);
      assert.equal(nativePerTile(def), 64, `${id} is 64 px/tile`);
      assert.deepEqual(def.native, { w: tiles.w * 64, h: tiles.h * 64 }, `${id} native == tiles*64`);
      assert.equal(def.camera.rise, 60, `${id} at the 60° prop baseline`);
      for (const v of PALM_VIEWS) assert.ok(def.frames[v], `${id} has ${v}`);
      assert.ok(def.frames.idle, `${id} aliases a default idle frame`);
      assert.ok(Object.keys(def.palette).length <= paletteCapFor(def), `${id} palette cap`);
      assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], id);
    }
    // The large palm is genuinely larger than the small one.
    assert.ok(large.native.h > small.native.h && large.native.w > small.native.w, 'large palm is bigger');
  });

  await t.test('2. rock pile: zoom-to-fit 2x2 with several angle variants', () => {
    const def = PROP_CATALOG.prop_rock_pile;
    assert.deepEqual(def.tiles, { w: 2, h: 2 }, 'rock pile is 2x2');
    assert.deepEqual(def.native, { w: 128, h: 128 }, 'native 128x128');
    assert.equal(nativePerTile(def), 64, 'N64');
    for (const v of ROCK_VIEWS) assert.ok(def.frames[v], `rock ${v}`);
    // "Zoom to fit": every frame's silhouette sits inside the canvas with a real
    // margin on all four edges (the whole pile fits, nothing is clipped).
    for (const v of ROCK_VIEWS) {
      const b = bbox(def.frames[v]);
      assert.ok(b.minx >= 2 && b.miny >= 2, `${v} top/left margin (${b.minx},${b.miny})`);
      assert.ok(b.maxx <= def.native.w - 3 && b.maxy <= def.native.h - 3, `${v} bottom/right margin`);
    }
    assert.deepEqual(validateSpriteDef(def, { label: 'prop_rock_pile' }).errors, []);
  });

  await t.test('3. dock: 90°-rotated 3x3 replaces the old 1-tall dock', () => {
    const def = PROP_CATALOG.prop_wooden_dock;
    assert.deepEqual(def.tiles, { w: 3, h: 3 }, 'dock is 3x3');
    assert.deepEqual(def.native, { w: 192, h: 192 }, 'native 192x192');
    assert.equal(def.camera.yaw, 90, 'bake rotated 90°');
    assert.deepEqual(def.camera.views, [90], 'single rotated view');
    assert.ok(def.frames.view_90, 'framed as view_90');
    assert.ok(def.frames.idle, 'idle aliases the rotated default');
    assert.equal(def.kind, 'decor', 'walk-over decor');
    assert.deepEqual(validateSpriteDef(def, { label: 'prop_wooden_dock' }).errors, []);
    // The manifest advertises the rotated frame, not the retired view_0.
    assert.deepEqual(PROP_MANIFEST.prop_wooden_dock.frames, ['idle', 'view_90']);
    // A 3x3 blit renders the whole 192px canvas at the engine SCALE (1:1 at 64).
    const ctx = fakeCtx();
    assert.equal(SpriteRenderer.drawProp(ctx, def, 0, 0, 64), true);
    assert.ok(ctx.calls.length > 0, 'dock frame blitted');
  });

  await t.test('4. Dawnreach Isle: 2D trees become scattered 3D palms/rocks, collision intact', () => {
    const def = getIslandDefinition(DEFAULT_ISLAND_ID);
    const scene = composeSceneById(DEFAULT_ISLAND_ID);

    // The scatter rule is catalog data keyed on the TREE tile type.
    assert.ok(Array.isArray(def.propScatter) && def.propScatter.length >= 1, 'propScatter authored');
    const rule = def.propScatter.find((r) => r.tile === 'TREE');
    assert.ok(rule, 'TREE scatter rule');
    assert.equal(rule.layer, 'decor', 'scattered props are non-blocking decor');

    // Every former 2D TREE tile now carries a 3D palm/rock prop.
    const tree = TILE_TYPES.TREE;
    let treeCount = 0;
    for (const row of scene.tiles) for (const code of row) if (code === tree) treeCount++;
    const scatter = scene.props.filter((p) => p.scatter === 'TREE');
    assert.equal(scatter.length, treeCount, 'one prop per TREE tile');
    assert.ok(treeCount > 0, 'trees remain (collision contract preserved)');

    // Varied sizes AND angles: more than one prop id and more than one frame.
    const ids = new Set(scatter.map((p) => p.propId));
    const frames = new Set(scatter.map((p) => p.frame));
    assert.ok(ids.size >= 3, `varied prop ids: ${[...ids].join(',')}`);
    assert.ok(ids.has('prop_palm_tree') && ids.has('prop_palm_tree_large') && ids.has('prop_rock_pile'), 'palms + rocks');
    assert.ok(frames.size >= 3, `varied angles: ${[...frames].join(',')}`);
    for (const p of scatter) assert.ok(PROP_CATALOG[p.propId].frames[p.frame], `${p.propId}/${p.frame} frame exists`);

    // Scatter is deterministic.
    const again = composeSceneById(DEFAULT_ISLAND_ID).props.filter((p) => p.scatter === 'TREE');
    assert.deepEqual(again.map((p) => `${p.propId}@${p.x},${p.y}:${p.frame}`), scatter.map((p) => `${p.propId}@${p.x},${p.y}:${p.frame}`));

    // Collision/travel contract untouched: spawn still reaches town + tower.
    const report = sceneAccessReport('island', def);
    assert.equal(report.spawnReachable, true);
    assert.equal(report.townReachable, true);
    assert.equal(report.towerReachable, true);
  });

  await t.test('5. the island TREE theme suppresses the legacy 2D canopy', () => {
    const theme = sceneTheme('island_dawnreach');
    assert.equal(theme.tiles.TREE.art, 'prop', 'TREE art is prop-backed');
    const ctx = fakeCtx();
    SpriteRenderer.drawTile(ctx, TILE_TYPES.TREE, 0, 0, 64, { theme, x: 3, y: 4 });
    // The grass base is drawn, but the 2D trunk/canopy colours are not.
    assert.ok(ctx.styles.length >= 1, 'grass base drawn');
    assert.ok(!ctx.styles.includes(theme.tiles.TREE.canopy), 'canopy suppressed');
    assert.ok(!ctx.styles.includes(theme.tiles.TREE.trunk), 'trunk suppressed');
  });

  await t.test('6. Havenreach places varied palms + rocks and the 3x3 dock', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    const palms = scene.props.filter((p) => p.propId === 'prop_palm_tree');
    const large = scene.props.filter((p) => p.propId === 'prop_palm_tree_large');
    const rocks = scene.props.filter((p) => p.propId === 'prop_rock_pile');
    assert.ok(palms.length >= 2, 'several small palms');
    assert.ok(large.length >= 1, 'a large palm');
    assert.ok(rocks.length >= 2, 'several rock piles');
    // Angle variety across the placed palms + rocks.
    const frames = new Set([...palms, ...large, ...rocks].map((p) => p.frame));
    assert.ok(frames.size >= 3, `varied placements: ${[...frames].join(',')}`);
    for (const p of [...palms, ...large, ...rocks]) {
      assert.ok(PROP_CATALOG[p.propId].frames[p.frame], `${p.propId}/${p.frame}`);
      assert.equal(p.layer, 'prop', 'trees/rocks block their tile');
    }
    const dock = scene.props.find((p) => p.propId === 'prop_wooden_dock');
    assert.ok(dock, 'dock placed');
    assert.equal(dock.layer, 'decor', 'dock is walk-over');
    assert.equal(dock.frame, 'view_90', 'rotated dock frame');
    assert.deepEqual([dock.x, dock.y], [11, 20], 'dock replaces the old quay placement');
    assert.equal(PROP_CATALOG.prop_wooden_dock.tiles.w, 3, 'dock footprint is 3 wide');
  });
});
