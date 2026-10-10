import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { EntityAI } from '../engine/entity-ai.js';
import { MONSTERS_CATALOG, ECONOMY_CATALOG, QUESTS_CATALOG } from '../data/index.js';
import { SPRITE_CATALOG, SPRITE_MANIFEST } from '../assets/sprites/index.js';
import { composeSceneById, isCodeWalkable } from '../services/scene-composer.js';
import { planSceneMonsters } from '../services/scene-spawner.js';
import { resolveSpriteId } from '../app/sprite-renderer.js';
import {
  buildCreatureDef,
  listCreatureArtifacts,
  STATIC_ANIMATIONS,
  WALK_ANIMATIONS,
} from '../../tools/integrate-creature-bake.mjs';
import {
  validateSpriteDef,
  validateCameraBaseline,
  paletteCapFor,
  nativePerTile,
  isActorDef,
  isBaked3d,
} from '../../tools/validate-sprite-def.mjs';

/** The three LIV-135 overworld creatures + their mapped movement class. */
const CREATURES = [
  { id: 'river_piranha', movement: 'static', aiType: 'stationary' },
  { id: 'river_eel', movement: 'static', aiType: 'stationary' },
  { id: 'river_rat', movement: 'walking', aiType: 'chase' },
];

function floorGrid(width = 20, height = 20) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  return grid;
}

function mkMonster(type, x, y, overrides = {}) {
  const def = MONSTERS_CATALOG[type] || {};
  return {
    id: `test_${type}_${x}_${y}`,
    type,
    name: def.name || type,
    x,
    y,
    hp: 100,
    max_hp: 100,
    isAggroed: true,
    attackCooldown: 0,
    moveCooldown: 0,
    ...overrides,
  };
}

test('LIV-135 3D-baked Dawnreach creatures', async (t) => {
  await t.test('1. all 3 creatures ship a 3D-baked N64 runtime def (baked artifact linked)', () => {
    const artifacts = listCreatureArtifacts();
    for (const { id } of CREATURES) {
      assert.ok(artifacts.includes(id), `missing baked artifact for ${id}`);
      const def = SPRITE_CATALOG[id];
      assert.ok(def, `catalog missing ${id}`);
      assert.equal(def.kind, 'monster', `${id} kind`);
      assert.equal(def.baked3d, true, `${id} is 3D-baked`);
      assert.equal(def.renderTier, 'baked', `${id} renderTier`);
      assert.equal(def.outline, false, `${id} drops the outline`);
      assert.deepEqual(def.native, { w: 64, h: 64 }, `${id} N64 native`);
      assert.equal(nativePerTile(def), 64, `${id} is 64 px/tile`);
      assert.ok(Object.keys(def.palette).length <= paletteCapFor(def), `${id} palette cap`);
      assert.ok(isActorDef(def), `${id} is an actor-class def (actor-exception camera)`);
      assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], id);
      assert.deepEqual(validateCameraBaseline(def, { label: id }).errors, [], `${id} camera baseline`);
    }
  });

  await t.test('2. movement class matches the authored states (static idle-only, walker idle+walk)', () => {
    for (const { id, movement } of CREATURES) {
      const def = SPRITE_CATALOG[id];
      const expected = movement === 'walking' ? WALK_ANIMATIONS : STATIC_ANIMATIONS;
      assert.deepEqual(Object.keys(def.animations).sort(), Object.keys(expected).sort(), `${id} states`);
      for (const dir of ['down', 'up', 'side']) {
        assert.deepEqual(def.animations.idle[dir], expected.idle[dir], `${id} idle ${dir}`);
        for (const fid of def.animations.idle[dir]) assert.ok(def.frames[fid], `${id} missing frame ${fid}`);
        if (expected.walk) {
          assert.deepEqual(def.animations.walk[dir], expected.walk[dir], `${id} walk ${dir}`);
          for (const fid of def.animations.walk[dir]) assert.ok(def.frames[fid], `${id} missing frame ${fid}`);
        }
      }
      if (movement === 'walking') assert.equal(def.animations.walk.advanceOn, 'step', `${id} walk step-driven`);
    }
  });

  await t.test('3. the runtime defs match the GLB-free integrator (no drift)', () => {
    for (const id of listCreatureArtifacts()) {
      assert.deepEqual(SPRITE_CATALOG[id], buildCreatureDef(id), `${id} drifted from the bake artifact`);
    }
    for (const { id } of CREATURES) {
      const meta = SPRITE_MANIFEST.actors[id];
      assert.equal(meta.kind, 'monster', `${id} manifest kind`);
      assert.deepEqual(meta.native, { w: 64, h: 64 }, `${id} manifest native`);
      assert.deepEqual(meta.anchor, { x: 32, y: 62 }, `${id} manifest anchor`);
    }
  });

  await t.test('4. the monsters.json types are authored, balance/economy wired, sprites resolve', () => {
    for (const { id, aiType } of CREATURES) {
      const monster = MONSTERS_CATALOG[id];
      assert.ok(monster, `monsters.json missing ${id}`);
      assert.equal(monster.type, id, `${id} type`);
      assert.equal(monster.aiType, aiType, `${id} aiType`);
      assert.ok(monster.baseHp > 0 && monster.baseAttack > 0, `${id} stats`);
      assert.ok(Array.isArray(monster.lootTable), `${id} lootTable`);
      assert.ok(ECONOMY_CATALOG.monsterGold[id], `${id} gold reward`);
      assert.ok(isBaked3d(SPRITE_CATALOG[id]), `${id} uses its baked sprite`);
      assert.equal(resolveSpriteId(monster) || id, id, `${id} resolves to its own sprite`);
    }
    // The two sessile ambushers fire a catalog attack; the walker is a plain chaser.
    assert.ok(MONSTERS_CATALOG.river_piranha.attacks.some((a) => a.kind === 'melee'), 'piranha lunge');
    const grab = MONSTERS_CATALOG.river_eel.attacks.find((a) => a.key === 'eel_grab');
    assert.ok(grab && grab.range === 2, 'eel has a reach-2 grab');
    assert.equal(grab.onHit.status, 'root', 'eel grab roots');
  });

  await t.test('5. the stationary AI handler never moves, faces, and fires in range', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 2;
    player.y = 2;
    // A nearby but out-of-range piranha must not step toward the player.
    const fish = mkMonster('river_piranha', 2, 5);
    for (let i = 0; i < 10; i++) EntityAI.updateMonsters([fish], player, grid, 0.1);
    assert.deepEqual([fish.x, fish.y], [2, 5], 'stationary monster holds its tile');

    // In range it lunges for damage.
    const close = mkMonster('river_piranha', 3, 2);
    const results = EntityAI.updateMonsters([close], player, grid, 0.016);
    assert.equal(results.length, 1, 'lunge fires');
    assert.ok(results[0].damageToPlayer > 0, 'lunge damages');

    // Even unaggroed it never idles away (deterministic: force the wander roll).
    const orig = Math.random;
    Math.random = () => 0;
    try {
      const idleFish = mkMonster('river_piranha', 8, 8, { isAggroed: false });
      for (let i = 0; i < 30; i++) EntityAI.updateMonsters([idleFish], player, grid, 0.1);
      assert.deepEqual([idleFish.x, idleFish.y], [8, 8], 'unprovoked ambusher never wanders');
    } finally {
      Math.random = orig;
    }
  });

  await t.test('6. the eel reach-2 grab applies the catalog root status', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 5;
    player.y = 2;
    const eel = mkMonster('river_eel', 7, 2); // dist 2 -> within the reach-2 grab
    const results = EntityAI.updateMonsters([eel], player, grid, 0.016);
    assert.equal(results.length, 1, 'grab fires at range 2');
    assert.ok(results[0].damageToPlayer > 0, 'grab damages');
    assert.equal(results[0].statusEffects[0].status, 'root', 'grab roots the target');
  });

  await t.test('7. the overworld spawn wiring places the 3 creatures (sessile ones on water)', () => {
    const scene = composeSceneById('island_dawnreach');
    const zones = scene.spawnZones;
    const zoneById = Object.fromEntries(zones.map((z) => [z.id, z]));
    assert.ok(zoneById.wreck_shallows?.pool.includes('river_piranha'), 'piranha zone');
    assert.ok(zoneById.south_tide_pools?.pool.includes('river_eel'), 'eel zone');
    assert.equal(zoneById.wreck_shallows.nearTile, 'WATER', 'piranha zone is water-gated');
    assert.equal(zoneById.south_tide_pools.nearTile, 'WATER', 'eel zone is water-gated');
    assert.ok(zoneById.west_wilds.pool.includes('river_rat'), 'rat in west grass pool');
    assert.ok(zoneById.approach_meadow.pool.includes('river_rat'), 'rat in approach pool');

    const plan = planSceneMonsters(scene, { version: 1, quests: {} }, {});
    const byType = (type) => plan.filter((s) => s.type === type);
    assert.ok(byType('river_piranha').length > 0, 'piranhas planned');
    assert.ok(byType('river_eel').length > 0, 'eels planned');
    for (const s of plan) {
      assert.ok(isCodeWalkable(scene.tiles[s.y][s.x]), `${s.type}@(${s.x},${s.y}) walkable`);
    }
    const WATER = TILE_TYPES.WATER;
    const isShore = (x, y) =>
      scene.tiles[y - 1]?.[x] === WATER || scene.tiles[y + 1]?.[x] === WATER ||
      scene.tiles[y]?.[x - 1] === WATER || scene.tiles[y]?.[x + 1] === WATER;
    for (const s of [...byType('river_piranha'), ...byType('river_eel')]) {
      assert.ok(isShore(s.x, s.y), `${s.type}@(${s.x},${s.y}) is water-adjacent`);
    }
  });

  await t.test('8. existing launch balance and quest wiring are intact', () => {
    assert.ok(EntityAI.AI_TYPES.includes('stationary'), 'stationary handler registered');
    // Untouched launch/isle monsters keep their exact frozen stats.
    assert.equal(MONSTERS_CATALOG.drowned_crawler.baseHp, 24);
    assert.equal(MONSTERS_CATALOG.giant_rat.baseHp, 30);
    assert.equal(MONSTERS_CATALOG.barnacle_brute.baseHp, 110);
    for (const q of ['rats_in_the_gutter', 'the_lantern_wreck', 'rite_of_the_beacon']) {
      assert.ok((QUESTS_CATALOG.quests || QUESTS_CATALOG).some((x) => x.id === q), `${q} intact`);
    }
  });
});
