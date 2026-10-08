import test from 'node:test';
import assert from 'node:assert/strict';

import { planSceneMonsters, makeSceneMonster, seedFromString } from '../services/scene-spawner.js';
import { composeSceneById, isCodeWalkable } from '../services/scene-composer.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
import { GridMap } from '../engine/grid-map.js';
import { EntityAI } from '../engine/entity-ai.js';
import { createPartyPlayer } from '../engine/party.js';
import { acceptQuest } from '../engine/quest-system.js';
import { MONSTERS_CATALOG } from '../data/index.js';

// LIV-60 P3: visible overworld roamers + quest elites from catalog spawn data.

function fakeApp() {
  const player = createPartyPlayer('magician');
  return Object.assign({}, sceneControllerMethods, {
    player,
    npcs: [],
    monsters: [],
    scene: null,
    gridMap: new GridMap(),
    updateHUD: () => {},
    persistSave: () => Promise.resolve(),
    logCombat: () => {},
    addFloatingText: () => {},
  });
}

test('LIV-60 scene spawner', async (t) => {
  await t.test('seed hashing is deterministic', () => {
    assert.equal(seedFromString('island_dawnreach'), seedFromString('island_dawnreach'));
    assert.notEqual(seedFromString('island_dawnreach'), seedFromString('town_havenreach'));
  });

  await t.test('island spawn zones fill to maxAlive on walkable tiles, deterministically', () => {
    const scene = composeSceneById('island_dawnreach');
    const state = { version: 1, quests: {} };
    const first = planSceneMonsters(scene, state, { idPrefix: 'sm' });
    const second = planSceneMonsters(scene, state, { idPrefix: 'sm' });
    assert.ok(first.length > 0, 'roamers planned');
    // Deterministic order + positions.
    assert.deepEqual(
      first.map((s) => [s.type, s.x, s.y]),
      second.map((s) => [s.type, s.x, s.y])
    );
    for (const spawn of first) {
      assert.ok(MONSTERS_CATALOG[spawn.type], `${spawn.type} is a catalog monster`);
      assert.ok(isCodeWalkable(scene.tiles[spawn.y][spawn.x]), `spawn tile walkable (${spawn.x},${spawn.y})`);
    }
    const totalMax = scene.spawnZones.reduce((n, z) => n + (Number(z.maxAlive) || 0), 0);
    assert.ok(first.length <= totalMax, 'never exceeds authored maxAlive');
  });

  await t.test('quest elites appear only while their quest is active', () => {
    const scene = composeSceneById('island_dawnreach');
    const inactive = planSceneMonsters(scene, { version: 1, quests: {} }, { idPrefix: 'sm' });
    assert.ok(!inactive.some((s) => s.questSpawnId === 'q1_gutter_king'), 'no elite before accept');

    const player = createPartyPlayer('magician');
    acceptQuest(player.questState, player, 'rats_in_the_gutter');
    const active = planSceneMonsters(scene, player.questState, { idPrefix: 'sm' });
    const king = active.find((s) => s.questSpawnId === 'q1_gutter_king');
    assert.ok(king, 'Q1 elite spawns while active');
    assert.equal(king.type, 'gutter_king');
    // Anchored near the authored west-field spot, on a walkable tile.
    assert.ok(Math.abs(king.x - 22) + Math.abs(king.y - 32) <= 6, `near anchor (${king.x},${king.y})`);
    assert.ok(isCodeWalkable(scene.tiles[king.y][king.x]), 'elite tile walkable');
  });

  await t.test('spawned monsters drive the existing AI without throwing', () => {
    const scene = composeSceneById('island_dawnreach');
    const player = createPartyPlayer('magician');
    const app = fakeApp();
    app.player = player;
    app.gridMap.loadFromMatrix(scene.tiles);
    acceptQuest(player.questState, player, 'rats_in_the_gutter');
    const plan = planSceneMonsters(scene, player.questState, { idPrefix: 'sm' });
    const monsters = plan.map((s) => app.buildSceneMonster(s));
    assert.ok(monsters.length > 0);
    for (const m of monsters) m.isAggroed = true;
    for (let i = 0; i < 10; i++) {
      const results = EntityAI.updateMonsters(monsters, player, app.gridMap, 0.1, null);
      assert.ok(Array.isArray(results));
    }
  });

  await t.test('applySceneData wires NPCs, roamers, and ground items', () => {
    const island = composeSceneById('island_dawnreach');
    const islandApp = fakeApp();
    islandApp.applySceneData(island);
    assert.ok(islandApp.monsters.length > 0, 'island roamers spawned');
    assert.equal(islandApp.npcs.length, 0, 'no NPCs on the island');

    const town = composeSceneById('town_havenreach');
    const townApp = fakeApp();
    townApp.applySceneData(town);
    assert.ok(townApp.npcs.length >= 7, 'town NPCs spawned');
    assert.equal(townApp.monsters.length, 0, 'no roamers in town');
    assert.deepEqual(townApp.player.questState, { version: 1, quests: {} });
  });

  await t.test('makeSceneMonster mirrors the catalog and is visible outdoors', () => {
    const monster = makeSceneMonster('drowned_crawler', 3, 4, 'sm_1');
    assert.equal(monster.type, 'drowned_crawler');
    assert.equal(monster.name, MONSTERS_CATALOG.drowned_crawler.name);
    assert.equal(monster.hp, MONSTERS_CATALOG.drowned_crawler.baseHp);
    assert.equal(monster.visible, true);
    assert.equal(monster.faction, MONSTERS_CATALOG.drowned_crawler.faction);
  });
});
