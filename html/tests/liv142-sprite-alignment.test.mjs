import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES } from '../engine/config.js';
import {
  SpriteRenderer,
  propBlitOrigin,
  actorRenderBox,
  HUMANOID_RENDER_BOX,
  sceneTheme,
} from '../app/sprite-renderer.js';
import { PROP_CATALOG, SPRITE_CATALOG } from '../assets/sprites/index.js';

// LIV-142 (source: LIV-141): alignment/rendering rules for 2D sprites rendered
// from 3D models —
//   1. multi-tile items (palms, stones) are bottom-centre aligned on their
//      placement square;
//   2. no bespoke green "grass" is drawn under a prop; it stands on the shared
//      gradient grass of the surrounding tiles;
//   3. 3D-baked humanoids/NPCs/opponents render at 72x96, centre-bottom on
//      their tile;
//   4. actors draw in painter's order by camera distance (front occludes back).

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
    strokeRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
    translate() {}, rotate() {}, scale() {}, clip() {}, rect() {},
    fillText() {}, measureText() { return { width: 0 }; }, setLineDash() {},
    drawImage() { calls.push(['drawImage']); },
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  Object.defineProperty(ctx, 'fillStyle', { get() { return '#000'; }, set(v) { styles.push(v); } });
  return ctx;
}

test('LIV-142 sprite alignment', async (t) => {
  await t.test('1. palms and stone piles declare bottom-center placement', () => {
    for (const id of ['prop_palm_tree', 'prop_palm_tree_large', 'prop_rock_pile']) {
      const def = PROP_CATALOG[id];
      assert.ok(def, `${id} catalogued`);
      assert.equal(def.placement.align, 'bottom-center', `${id} aligns bottom-center`);
    }
    // Wide/floor pieces keep the legacy footprint top-left.
    assert.notEqual(PROP_CATALOG.prop_wooden_dock.placement.align, 'bottom-center', 'dock is unchanged');
    assert.notEqual(PROP_CATALOG.prop_fishers_net.placement.align, 'bottom-center', 'net is unchanged');
  });

  await t.test('2. propBlitOrigin puts multi-tile items bottom-centre on the tile', () => {
    // 64x128 palm: centred horizontally, bottom flush with the placement tile.
    assert.deepEqual(propBlitOrigin(PROP_CATALOG.prop_palm_tree, 100, 200, 64), { dx: 100, dy: 136 });
    // 2x2 rock pile: centred on the tile, bottom flush.
    assert.deepEqual(propBlitOrigin(PROP_CATALOG.prop_rock_pile, 100, 200, 64), { dx: 68, dy: 136 });
    // 2x3 large palm.
    assert.deepEqual(propBlitOrigin(PROP_CATALOG.prop_palm_tree_large, 100, 200, 64), { dx: 68, dy: 72 });
    // Un-aligned pieces keep the tile origin.
    assert.deepEqual(propBlitOrigin(PROP_CATALOG.prop_wooden_dock, 100, 200, 64), { dx: 100, dy: 200 });
    assert.deepEqual(propBlitOrigin(PROP_CATALOG.prop_fishers_net, 100, 200, 64), { dx: 100, dy: 200 });
    // Safe fallback for a def without placement metadata.
    assert.deepEqual(propBlitOrigin(null, 100, 200, 64), { dx: 100, dy: 200 });
  });

  await t.test('3. drawProp blits the aligned prop above its tile', () => {
    const def = PROP_CATALOG.prop_palm_tree;
    const rows = def.frames.view_0;
    const contentTop = rows.findIndex((r) => [...r].some((ch) => ch !== '.'));
    assert.ok(contentTop >= 0, 'palm frame has content');
    const ctx = fakeCtx();
    assert.equal(SpriteRenderer.drawProp(ctx, { propId: 'prop_palm_tree', frame: 'view_0' }, 0, 0, 64), true);
    const ys = ctx.calls.filter((c) => c.length === 4).map((c) => c[1]);
    assert.equal(Math.min(...ys), -64 + contentTop, 'first painted row sits at the aligned origin');
  });

  await t.test('4. the TREE tile draws the shared GRASS ground, never a bespoke fill', () => {
    const theme = sceneTheme('island_dawnreach');
    const grassCtx = fakeCtx();
    SpriteRenderer.drawTile(grassCtx, TILE_TYPES.GRASS, 0, 0, 64, { theme, x: 5, y: 6 });
    const treeCtx = fakeCtx();
    SpriteRenderer.drawTile(treeCtx, TILE_TYPES.TREE, 0, 0, 64, { theme, x: 5, y: 6 });
    assert.deepEqual(treeCtx.styles, grassCtx.styles, 'TREE ground is the GRASS tile art');
    assert.ok(!treeCtx.styles.includes(theme.outside.grassBlade), 'no custom outside grass under props');
  });

  await t.test('5. 3D-baked humanoids render in the 72x96 centre-bottom box', () => {
    assert.deepEqual(HUMANOID_RENDER_BOX, { w: 72, h: 96 });
    // Baked actors (vocation/NPC/opponent) opt in.
    assert.deepEqual(actorRenderBox(SPRITE_CATALOG.archer, 64), { w: 72, h: 96 });
    assert.deepEqual(actorRenderBox(SPRITE_CATALOG.river_rat, 64), { w: 72, h: 96 });
    // Hand-authored (non-3D) actors and multi-tile defs stay on the tile scale.
    assert.equal(actorRenderBox(SPRITE_CATALOG.magician, 64), null);
    assert.equal(actorRenderBox(PROP_CATALOG.prop_palm_tree, 64), null);
    assert.equal(actorRenderBox(null, 64), null);

    const ctx = fakeCtx();
    const geo = SpriteRenderer.drawActor(ctx, { spriteId: 'archer', anim: { state: 'idle', dir: 'down' } }, 300, 400, { size: 64 });
    assert.ok(geo, 'baked actor draws');
    assert.deepEqual({ w: geo.w, h: geo.h }, { w: 72, h: 96 });
    assert.equal(geo.dy, 400 + 64 - 96, 'centre-bottom aligned (bottom flush, extends above)');
    assert.equal(geo.dx, 300 + Math.round((64 - 72) / 2), 'horizontally centred');
  });

  await t.test('6. actors draw in painter order by camera distance (front occludes back)', async () => {
    const { CanvasRenderer } = await import('../app/canvas-renderer.js');
    const { GridMap, createPlayer } = await import('../engine/index.js');
    const { createAnimState } = await import('../app/animation-state.js');

    const gridMap = new GridMap();
    gridMap.loadFromMatrix(Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => 0)));

    const player = createPlayer('magician');
    player.x = 3; player.y = 3; player.facing = 'down';
    player.anim = createAnimState('down');

    const back = {
      type: 'giant_rat', id: 'back', x: 3, y: 1, hp: 10, max_hp: 10,
      visible: true, facing: 'down', anim: createAnimState('down'),
    };
    const front = {
      type: 'giant_rat', id: 'front', x: 3, y: 5, hp: 10, max_hp: 10,
      visible: true, facing: 'down', anim: createAnimState('down'),
    };

    const renderer = new CanvasRenderer(null);
    renderer.canvas = { width: 256, height: 256 };
    renderer.ctx = fakeCtx();
    renderer.render(gridMap, player, [back, front], [], [], [], null, [], []);

    // The list is retained after render in sorted draw order: the further actor
    // (smaller y) draws first, the nearer one (larger y) draws last.
    assert.deepEqual(renderer._actorDrawList, [back, player, front]);
  });
});
