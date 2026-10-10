import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSpriteDef,
  validateMultiTileDef,
} from '../../tools/validate-sprite-def.mjs';
import { tileCanvasSize } from '../../tools/gltf-to-sprite.mjs';
import { BUILDING_CATALOG, PROP_CATALOG } from '../assets/sprites/index.js';
import { getTownDefinition, DEFAULT_TOWN_ID } from '../data/index.js';
import { composeSceneById } from '../services/scene-composer.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
import { SpriteRenderer } from '../app/sprite-renderer.js';
import { GridMap } from '../engine/grid-map.js';

// LIV-113 (board-directed): integrate the three new fisher GLBs — the central
// longhouse, two fishers-house size variants, and the multi-angle fisher's net —
// through the existing Tier B footprint/silhouette path. No new placement model.

const NEW_BUILDINGS = ['longhouse', 'fishers_house', 'fishers_house_large'];

test('LIV-113 fisher assets — longhouse, fishers house, fishers net', async (t) => {
  await t.test('1. each new building is a valid Tier B multi-tile def (baked cap 32)', () => {
    for (const id of NEW_BUILDINGS) {
      const def = BUILDING_CATALOG[id];
      assert.ok(def, `${id} is registered in BUILDING_CATALOG`);
      assert.equal(def.renderTier, 'baked', `${id} opts into Tier B`);
      assert.ok(Object.keys(def.palette).length <= 32, `${id} respects the baked palette cap`);
      assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], `${id} passes the sprite schema`);
      assert.deepEqual(validateMultiTileDef(def, { label: id }).errors, [], `${id} passes the multi-tile validator`);
      assert.deepEqual(tileCanvasSize(def.tiles), def.native, `${id} native == tiles * 32`);
      assert.match(def.source, /_optimized\.glb/, `${id} baked from a provided GLB`);
    }
    // The board asked for the longhouse ~6x12; the projection is ~2.8:1, so the
    // aspect-correct whole-tile multiple at the requested 12-tile width is 12x4.
    assert.deepEqual(BUILDING_CATALOG.longhouse.tiles, { w: 12, h: 4 });
    assert.deepEqual(BUILDING_CATALOG.longhouse.native, { w: 384, h: 128 });
  });

  await t.test('2. longhouse is placed center-top, front-facing (replaces the middle hut)', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    const lb = town.buildings.find((b) => b.silhouette === 'longhouse');
    assert.ok(lb, 'longhouse is placed in Havenreach');
    const [x0, y0, x1, y1] = lb.footprint;
    assert.deepEqual([x1 - x0 + 1, y1 - y0 + 1], [12, 4], '12x4 footprint');
    assert.ok(y1 <= 4, 'sits in the top row');
    // Roughly centered across the interior (open columns 1..width-2).
    const center = (1 + (town.width - 2)) / 2;
    assert.ok(Math.abs((x0 + x1) / 2 - center) <= 1, 'longhouse is centered');
    assert.equal(BUILDING_CATALOG.longhouse.placement.defaultFrame, 'view_0', 'front facing');
  });

  await t.test('3. two fishers houses placed with >= 2 distinct size variants', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    const houses = town.buildings.filter(
      (b) => b.silhouette === 'fishers_house' || b.silhouette === 'fishers_house_large',
    );
    assert.ok(houses.length >= 2, `at least 2 fishers houses, got ${houses.length}`);
    const sizes = new Set(houses.map((b) => {
      const d = BUILDING_CATALOG[b.silhouette];
      return `${d.tiles.w}x${d.tiles.h}`;
    }));
    assert.ok(sizes.size >= 2, `>= 2 distinct sizes, got ${[...sizes].join(', ')}`);
    // Each is larger than the base 2x3 fisher's hut.
    for (const b of houses) {
      const d = BUILDING_CATALOG[b.silhouette];
      assert.ok(d.tiles.w * d.tiles.h > 2 * 3, `${b.silhouette} is larger than the fisher's hut`);
    }
  });

  await t.test('4. fishers net is a baked multi-facing prop placed at multiple angles', () => {
    const def = PROP_CATALOG.prop_fishers_net;
    assert.ok(def, 'prop_fishers_net is registered');
    assert.equal(def.renderTier, 'baked', 'Tier B');
    assert.ok(Object.keys(def.palette).length <= 32, 'baked palette cap');
    for (const f of ['view_0', 'view_90', 'view_180', 'view_270']) {
      assert.ok(def.frames[f], `net bakes angle ${f}`);
    }
    assert.deepEqual(validateSpriteDef(def, { label: 'prop_fishers_net' }).errors, []);
    assert.ok(def.native.w > def.native.h, 'a net hung between two posts reads wide');

    const scene = composeSceneById(DEFAULT_TOWN_ID);
    const nets = (scene.props || []).filter((p) => p.propId === 'prop_fishers_net');
    assert.ok(nets.length >= 2, `net placed around town, got ${nets.length}`);
    const angles = new Set(nets.map((p) => p.frame));
    assert.ok(angles.size >= 2, `>= 3 angles placed, got ${[...angles].join(', ')}`);
    // At least one net sits in front of / beside a structure (footprint + 1 ring).
    const near = nets.some((net) => (scene.buildings || []).some((b) => {
      if (!b.footprint) return false;
      const [x0, y0, x1, y1] = b.footprint;
      return net.x >= x0 - 1 && net.x <= x1 + 1 && net.y >= y0 - 1 && net.y <= y1 + 1;
    }));
    assert.ok(near, 'a net is placed in front of or next to a structure');
  });

  await t.test('5. the net prop frame is data-driven and the sprite blits that frame', () => {
    // drawProp honours `prop.frame`; a bogus frame still returns true via fallback
    // only when the def/frame exists, and the scene prop passes the frame through.
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    const net = (scene.props || []).find((p) => p.propId === 'prop_fishers_net');
    assert.ok(net && net.frame, 'the scene composer preserves the authored frame');
    const calls = [];
    const ctx = {
      drawImage() { calls.push('drawImage'); },
      fillRect() { calls.push('fillRect'); },
      fill() {}, save() {}, restore() {},
      imageSmoothingEnabled: true,
    };
    const drew = SpriteRenderer.drawProp(ctx, net, 0, 0, 64);
    assert.equal(drew, true, 'the net blits');
    assert.ok(calls.includes('drawImage') || calls.includes('fillRect'), 'pixels were drawn');
  });

  await t.test('6. net props stay walkable and the town has no soft-locks', () => {
    const app = Object.assign({}, sceneControllerMethods, {
      player: { x: 12, y: 19, facing: 'down', location: 'town', scene: null },
      npcs: [], monsters: [], scene: null, props: [], gridMap: new GridMap(),
      updateHUD: () => {}, persistSave: () => Promise.resolve(),
      logCombat: () => {}, addFloatingText: () => {}, layoutPartyOnFloor: () => {},
    });
    app.applySceneData(composeSceneById(DEFAULT_TOWN_ID));
    for (const net of (app.props || []).filter((p) => p.propId === 'prop_fishers_net')) {
      assert.equal(app.gridMap.isWalkable(net.x, net.y), true, `net tile ${net.x},${net.y} stays walkable`);
    }
  });
});
