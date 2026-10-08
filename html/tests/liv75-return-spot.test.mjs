import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setReturnSpot,
  resolveReturnSpot,
  clearReturnSpot,
  RETURN_SPOT_KEY,
} from '../engine/return-spot.js';
import { captureActiveMember, createPartyPlayer } from '../engine/party.js';
import { GridMap } from '../engine/grid-map.js';
import {
  composeSceneById,
  isCodeWalkable,
} from '../services/scene-composer.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
import { floorControllerMethods } from '../app/floor-controller.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';
import { COMMAND_HANDLERS } from '../worker/game-worker.js';
import { read, STORES } from '../services/storage.js';
import { withFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import {
  DEFAULT_TOWER_ID,
  DEFAULT_TOWN_ID,
  getTownDefinition,
  listTowerDefinitionsByOrder,
  towerLevelCount,
} from '../data/index.js';

// LIV-75: after exiting the tower to town, a return spot near the town entrance
// re-enters the last-exited tower/floor. Covers the pure model, the catalog
// placement, the worker round-trip, the app wiring, and the renderer marker.

function fakeSceneApp(player) {
  return Object.assign({}, sceneControllerMethods, {
    player,
    npcs: [],
    monsters: [],
    scene: null,
    returnSpot: null,
    gridMap: new GridMap(),
    updateHUD: () => {},
    persistSave: () => Promise.resolve(),
    logCombat: () => {},
    addFloatingText: () => {},
  });
}

test('LIV-75 return-spot model', async (t) => {
  await t.test('records and resolves a valid tower/floor', () => {
    const player = {};
    const record = setReturnSpot(player, DEFAULT_TOWER_ID, 3);
    assert.deepEqual(record, { towerId: DEFAULT_TOWER_ID, floor: 3 });
    assert.equal(player[RETURN_SPOT_KEY], record);
    assert.deepEqual(resolveReturnSpot(player), { towerId: DEFAULT_TOWER_ID, floor: 3 });
  });

  await t.test('rejects an unknown tower and a non-finite floor', () => {
    const player = {};
    assert.equal(setReturnSpot(player, 'not_a_tower', 1), null);
    assert.equal(player[RETURN_SPOT_KEY], undefined, 'junk is never recorded');
    assert.equal(setReturnSpot(player, DEFAULT_TOWER_ID, NaN), null);
    assert.equal(player[RETURN_SPOT_KEY], undefined);
  });

  await t.test('clamps the floor onto the tower level count', () => {
    const player = {};
    setReturnSpot(player, DEFAULT_TOWER_ID, 999);
    const resolved = resolveReturnSpot(player);
    assert.equal(resolved.floor, towerLevelCount(DEFAULT_TOWER_ID));
  });

  await t.test('resolves null for missing or invalid records', () => {
    assert.equal(resolveReturnSpot(null), null);
    assert.equal(resolveReturnSpot({}), null);
    assert.equal(resolveReturnSpot({ lastTowerExit: null }), null);
    assert.equal(resolveReturnSpot({ lastTowerExit: { towerId: 'not_a_tower', floor: 1 } }), null);
    assert.equal(resolveReturnSpot({ lastTowerExit: { towerId: DEFAULT_TOWER_ID, floor: 'x' } }), null);
  });

  await t.test('clear removes the record', () => {
    const player = {};
    setReturnSpot(player, DEFAULT_TOWER_ID, 2);
    clearReturnSpot(player);
    assert.equal(resolveReturnSpot(player), null);
  });

  await t.test('lastTowerExit is envelope state, never captured onto a member', () => {
    const player = createPartyPlayer('magician');
    setReturnSpot(player, DEFAULT_TOWER_ID, 2);
    captureActiveMember(player);
    assert.equal('lastTowerExit' in player.party[0], false);
  });
});

test('LIV-75 towns.json authors a valid return spot', async (t) => {
  await t.test('placement is walkable and distinct from spawn/portals', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    const spot = town.returnSpot;
    assert.ok(spot, 'town authors a returnSpot');
    assert.ok(Number.isInteger(spot.x) && Number.isInteger(spot.y), 'integer coords');
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    assert.equal(isCodeWalkable(scene.tiles[spot.y][spot.x]), true, 'spot tile walks');
    assert.ok(spot.x !== town.spawn.x || spot.y !== town.spawn.y, 'not the arrival tile');
    for (const portal of town.portals) {
      assert.ok(portal.x !== spot.x || portal.y !== spot.y, 'not on a portal tile');
    }
    // Near the town entrance / south gate (bottom rows of the map).
    assert.ok(Math.abs(spot.y - (town.height - 1)) <= 2, 'near the south gate');
  });

  await t.test('the composer emits a copied placement', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    assert.deepEqual(scene.returnSpot, { ...town.returnSpot });
    assert.notEqual(scene.returnSpot, town.returnSpot, 'not aliased to the catalog');
  });
});

test('LIV-75 return spot activation in town', async (t) => {
  await t.test('appears only when a last-exited tower exists', () => {
    const scene = composeSceneById(DEFAULT_TOWN_ID);

    const noExit = fakeSceneApp(createPartyPlayer('magician'));
    noExit.applySceneData(scene);
    assert.equal(noExit.returnSpot, null, 'no exit record -> no spot');
    assert.equal(noExit.scene.interactables.some((i) => i.action === 'return_to_tower'), false);

    const player = createPartyPlayer('magician');
    setReturnSpot(player, DEFAULT_TOWER_ID, 2);
    const app = fakeSceneApp(player);
    app.applySceneData(composeSceneById(DEFAULT_TOWN_ID));
    assert.ok(app.returnSpot, 'spot active with an exit record');
    assert.equal(app.returnSpot.towerId, DEFAULT_TOWER_ID);
    assert.equal(app.returnSpot.floor, 2);
    assert.equal(app.returnSpot.x, scene.returnSpot.x);
    assert.equal(app.returnSpot.y, scene.returnSpot.y);
    const runtime = app.scene.interactables.find((i) => i.action === 'return_to_tower');
    assert.ok(runtime, 'runtime interactable present');
    assert.equal(runtime.promptText, 'Return to the Tower');
  });

  await t.test('prompt and interact dispatch to returnToTower', () => {
    const player = createPartyPlayer('magician');
    setReturnSpot(player, DEFAULT_TOWER_ID, 2);
    const app = fakeSceneApp(player);
    app.applySceneData(composeSceneById(DEFAULT_TOWN_ID));
    app.isInGameplay = true;
    app.isPaused = false;
    app.isGameOver = false;
    app.isFloorCleared = false;

    // Stand adjacent to the spot.
    player.x = app.returnSpot.x;
    player.y = app.returnSpot.y - 1;
    app.updateInteractPrompt();
    assert.ok(app.interactPromptTarget, 'prompt target set');
    assert.equal(app.interactPromptTarget.text, 'Return to the Tower');

    let called = 0;
    app.returnToTower = () => { called += 1; return true; };
    assert.equal(app.interact(), true);
    assert.equal(called, 1, 'interact routes through the action table');
  });
});

test('LIV-75 leaving the tower records the exit', () => {
  const player = createPartyPlayer('magician');
  player.current_floor = 4;
  const app = Object.assign({}, floorControllerMethods, {
    player,
    towerId: DEFAULT_TOWER_ID,
    isInGameplay: true,
    persistSave: () => Promise.resolve(),
    transition: { run: (_name, fn) => fn() },
    enterScene: () => {},
  });
  app.leaveTower();
  assert.equal(player.location, 'town');
  assert.deepEqual(resolveReturnSpot(player), { towerId: DEFAULT_TOWER_ID, floor: 4 });
});

test('LIV-75 returnToTower re-enters through the worker', async (t) => {
  await t.test('success loads the floor, clears the spot, and enters the tower', async () => {
    const player = createPartyPlayer('magician');
    player.slotIndex = 1;
    setReturnSpot(player, DEFAULT_TOWER_ID, 2);
    const seen = {};
    let enterTowerCalls = 0;
    const app = Object.assign({}, floorControllerMethods, {
      player,
      returnSpot: { towerId: DEFAULT_TOWER_ID, floor: 2, x: 3, y: 4 },
      isInGameplay: true,
      scene: {},
      npcs: [{ x: 1, y: 1 }],
      gridMap: new GridMap(),
      ambientLights: [],
      monsters: [],
      updateHUD: () => {},
      persistSave: () => Promise.resolve(),
      enterTower: () => { enterTowerCalls += 1; },
      applyDungeonData: (floor, opts) => { seen.floor = floor; seen.opts = opts; },
      gameClient: {
        enterTowerFloor: async (slotIndex, towerId, floorNumber) => {
          seen.slotIndex = slotIndex;
          seen.towerId = towerId;
          seen.floorNumber = floorNumber;
          return {
            player: { ...player, current_floor: floorNumber, towerId },
            floor: { floor_number: floorNumber, tower_id: towerId, tiles: [[0]] },
          };
        },
      },
    });

    const ok = await app.returnToTower();
    assert.equal(ok, true);
    assert.deepEqual(
      { slotIndex: seen.slotIndex, towerId: seen.towerId, floorNumber: seen.floorNumber },
      { slotIndex: 1, towerId: DEFAULT_TOWER_ID, floorNumber: 2 }
    );
    assert.equal(app.returnSpot, null, 'spot consumed');
    assert.equal(app.scene, null);
    assert.equal(enterTowerCalls, 1);
  });

  await t.test('a locked tower clears the spot and never soft-locks', async () => {
    const player = createPartyPlayer('magician');
    player.slotIndex = 1;
    setReturnSpot(player, DEFAULT_TOWER_ID, 2);
    const app = Object.assign({}, floorControllerMethods, {
      player,
      returnSpot: { towerId: DEFAULT_TOWER_ID, floor: 2, x: 3, y: 4 },
      isInGameplay: true,
      updateHUD: () => {},
      logCombat: () => {},
      persistSave: () => Promise.resolve(),
      gameClient: {
        enterTowerFloor: async () => { throw new Error(`Tower '${DEFAULT_TOWER_ID}' is locked`); },
      },
    });

    const ok = await app.returnToTower();
    assert.equal(ok, false);
    assert.equal(app.returnSpot, null, 'dead teleporter removed');
    assert.equal(resolveReturnSpot(player), null, 'remembered exit cleared');
  });

  await t.test('a second call while returning is ignored', async () => {
    const player = createPartyPlayer('magician');
    player.slotIndex = 1;
    const app = Object.assign({}, floorControllerMethods, {
      player,
      returnSpot: { towerId: DEFAULT_TOWER_ID, floor: 2, x: 3, y: 4 },
      isInGameplay: true,
      _returningToTower: true,
      gameClient: { enterTowerFloor: async () => { throw new Error('should not run'); } },
    });
    assert.equal(await app.returnToTower(), false);
  });
});

test('LIV-75 worker enterTowerFloor round-trips and rejects a locked tower', async (t) => {
  await t.test('re-enters the remembered floor and persists the record', async () => {
    await withFakeIndexedDB(async () => {
      const first = listTowerDefinitionsByOrder()[0].id;
      const created = await COMMAND_HANDLERS.createSlot({ slotIndex: 4, vocation: 'magician' });
      created.player.towerProgress = { completedTowerIds: [], unlockedTowerIds: [first] };
      created.player.lastTowerExit = { towerId: first, floor: 3 };
      await COMMAND_HANDLERS.saveCharacter({ player: created.player });

      const stored = await read(STORES.CHARACTERS, 'char_slot_4');
      assert.deepEqual(stored.lastTowerExit, { towerId: first, floor: 3 }, 'exit record survives the save envelope');

      const reentered = await COMMAND_HANDLERS.enterTowerFloor({ slotIndex: 4, towerId: first, floorNumber: 3 });
      assert.equal(reentered.player.towerId, first);
      assert.equal(reentered.player.current_floor, 3);
      assert.equal(reentered.floor.floor_number, 3);
      assert.equal(reentered.player.scene, null, 'overworld scene pointer cleared on tower entry');
    });
  });

  await t.test('a locked tower is rejected', async () => {
    await withFakeIndexedDB(async () => {
      const ordered = listTowerDefinitionsByOrder();
      await COMMAND_HANDLERS.createSlot({ slotIndex: 4, vocation: 'magician' });
      await assert.rejects(
        () => COMMAND_HANDLERS.enterTowerFloor({ slotIndex: 4, towerId: ordered[2].id, floorNumber: 1 }),
        /locked/
      );
    });
  });
});

test('LIV-75 return spot marker renders without throwing', () => {
  const renderer = Object.create(CanvasRenderer.prototype);
  renderer.cameraX = 0;
  renderer.cameraY = 0;
  renderer._now = () => 1000;
  const calls = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    save() { calls.push('save'); },
    restore() { calls.push('restore'); },
    beginPath() { calls.push('beginPath'); },
    ellipse() { calls.push('ellipse'); },
    arc() { calls.push('arc'); },
    fill() { calls.push('fill'); },
    stroke() { calls.push('stroke'); },
    fillRect() { calls.push('fillRect'); },
  };
  renderer.drawReturnSpot(ctx, { x: 2, y: 3 });
  assert.ok(calls.includes('save') && calls.includes('restore'), 'balanced save/restore');
  assert.ok(calls.includes('ellipse'), 'draws the ground ring');
  assert.ok(calls.includes('fillRect'), 'draws the light beam');
});
