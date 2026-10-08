import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneControllerMethods } from '../app/scene-controller.js';

import { GridMap } from '../engine/grid-map.js';

// LIV-59 P1: scene seam dispatch — portals, building doors, and the
// data-driven tower-entrance gate. These run on a fake app so the dispatch
// tables are exercised without a DOM/canvas.

function fakeApp(overrides = {}) {
  const calls = { enterScene: [], selectTower: [], logs: [], float: [], shop: 0, temple: 0, apply: [] };
  const spies = {
    calls,
    player: { slotIndex: 1, towerProgress: { completedTowerIds: [], unlockedTowerIds: ['spire_of_light'] }, x: 4, y: 5 },
    scene: { portals: [], interactables: [], lighting: 'ambient' },
    gridMap: new GridMap(8, 8),
    monsters: [],
    ambientLights: [],
    updateHUD: () => {},
    enterScene: (sceneId, spawn) => { calls.enterScene.push({ sceneId, spawn }); return Promise.resolve(true); },
    openSceneShop: () => { calls.shop += 1; },
    openSceneTemple: () => { calls.temple += 1; },
    logCombat: (msg) => { calls.logs.push(msg); },
    addFloatingText: (t) => { calls.float.push(t); },
    persistSave: () => Promise.resolve(),
    applyDungeonData: (floor) => { calls.apply.push(floor); },
    enterTower: () => { calls.entered = true; },
    gameClient: {
      selectTower: (slotIndex, towerId) => {
        calls.selectTower.push({ slotIndex, towerId });
        return Promise.resolve({ player: { slotIndex, towerId }, floor: { tower_id: towerId } });
      },
    },
  };
  // Spies win over the real methods so dispatch targets are observable.
  return Object.assign({}, sceneControllerMethods, spies, overrides);
}

test('LIV-59 scene transitions & interactions', async (t) => {
  await t.test('scenePortalAt / sceneBuildingAt find by coordinate', () => {
    const app = fakeApp({
      scene: {
        portals: [{ id: 'to_town', type: 'scene', x: 12, y: 23, target: { sceneId: 'island_dawnreach' } }],
        interactables: [{ kind: 'building', id: 'shop', x: 5, y: 7, interaction: { type: 'shop' } }],
      },
    });
    assert.equal(app.scenePortalAt(12, 23).id, 'to_town');
    assert.equal(app.scenePortalAt(1, 1), null);
    assert.equal(app.sceneBuildingAt(5, 7).id, 'shop');
    assert.equal(app.sceneBuildingAt(2, 2), null);
  });

  await t.test('scene portals transition through the dispatch table', () => {
    const app = fakeApp();
    const handled = app.handleScenePortal({
      type: 'scene',
      target: { sceneId: 'island_dawnreach', spawn: { x: 24, y: 28 } },
    });
    assert.equal(handled, true);
    assert.deepEqual(app.calls.enterScene, [{ sceneId: 'island_dawnreach', spawn: { x: 24, y: 28 } }]);
    assert.equal(app.handleScenePortal(null), false);
  });

  await t.test('shop and temple doorways reuse the existing panels', () => {
    const app = fakeApp();
    assert.equal(app.handleSceneBuilding({ interaction: { type: 'shop' } }), true);
    assert.equal(app.handleSceneBuilding({ interaction: { type: 'temple' } }), true);
    assert.equal(app.calls.shop, 1);
    assert.equal(app.calls.temple, 1);
    assert.equal(app.handleSceneBuilding({ interaction: { type: 'unknown' } }), false);
  });

  await t.test('an unlocked tower entrance enters the tower through selectTower', async () => {
    const app = fakeApp();
    await app.enterTowerFromScene({ type: 'tower', towerId: 'spire_of_light' });
    assert.equal(app.calls.selectTower.length, 1);
    assert.deepEqual(app.calls.selectTower[0], { slotIndex: 1, towerId: 'spire_of_light' });
    assert.equal(app.calls.apply.length, 1, 'tower floor applied');
    assert.equal(app.calls.entered, true, 'existing enterTower flow runs');
  });

  await t.test('a locked tower entrance names the gate and never soft-locks', async () => {
    const app = fakeApp();
    await app.enterTowerFromScene({ type: 'tower', towerId: 'sunken_catacombs' });
    assert.equal(app.calls.selectTower.length, 0, 'locked tower is not entered');
    assert.equal(app.calls.logs.length, 1, 'locked prompt shown');
    assert.deepEqual(app.calls.float, ['SEALED']);
    assert.equal(app.calls.entered, undefined);
  });
});
