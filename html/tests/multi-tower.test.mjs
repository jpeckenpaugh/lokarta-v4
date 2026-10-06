/**
 * Lokarta: multi-tower system (LIV-3)
 *
 * Verifies the generalized `tower_levels.json` schema: several towers load as
 * pure catalog data, each with its own levels, monster pools, key-holder
 * tables, boss, and theme mapping; each is soft-lock-free and deterministic;
 * and the original five-level tower is unchanged when no tower is selected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOWER_LEVELS_CATALOG,
  DEFAULT_TOWER_ID,
  getTowerDefinition,
  listTowerDefinitions,
  towerLevelCount,
  clampToTowerLevel,
} from '../data/index.js';

import {
  generateFloor,
  getLevelSpec,
  getBiomeForFloor,
  getTowerLevelCount,
  validateFloorSoftlock,
} from '../services/floor-generator.js';

import { clampTowerFloor, migratePlayerToTower } from '../services/save-slots.js';
import { isStaleFloor, COMMAND_HANDLERS } from '../worker/game-worker.js';
import { themeForFloor } from '../app/sprite-renderer.js';

describe('LIV-3 Multi-Tower System', () => {
  it('loads at least two towers purely from catalog data', () => {
    const towers = listTowerDefinitions();
    assert.ok(towers.length >= 2, `expected >= 2 towers, saw ${towers.length}`);
    assert.equal(getTowerDefinition(DEFAULT_TOWER_ID), towers[0]);
    assert.ok(TOWER_LEVELS_CATALOG.towers.length >= 2, 'resolved catalog exposes the tower set');
    assert.equal(TOWER_LEVELS_CATALOG.defaultTowerId, DEFAULT_TOWER_ID);

    for (const tower of towers) {
      assert.ok(tower.id, 'tower needs an id');
      assert.ok(tower.name, `${tower.id} needs a name`);
      assert.ok(Number.isInteger(tower.levelCount) && tower.levelCount >= 1, `${tower.id} levelCount`);
      assert.equal(tower.levels.length, tower.levelCount, `${tower.id} levels match levelCount`);
      assert.ok(tower.monsterGroups && tower.monsterGroups.pool, `${tower.id} needs monster pools`);
      assert.ok(tower.boss && tower.boss.type, `${tower.id} needs a boss`);
      assert.ok(tower.theme && tower.theme.levelTheme, `${tower.id} needs a theme map`);
      // Every level maps to a real tile_themes entry.
      for (let level = 1; level <= tower.levelCount; level++) {
        assert.ok(tower.theme.levelTheme[String(level)], `${tower.id} L${level} theme mapping`);
      }
    }

    const ids = towers.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'tower ids must be unique');
    assert.ok(ids.includes(DEFAULT_TOWER_ID));
  });

  it('keeps the default five-level tower backward compatible', () => {
    assert.equal(TOWER_LEVELS_CATALOG.levelCount, 5);
    assert.equal(TOWER_LEVELS_CATALOG.levels.length, 5);
    assert.deepEqual(TOWER_LEVELS_CATALOG.stairShaft, { 1: 9, 2: 6, 3: 3, 4: 8, 5: 5 });
    assert.deepEqual(TOWER_LEVELS_CATALOG.entry, {
      level: 1,
      room: 2,
      doorTile: [19, 1],
      spawnTile: [19, 2],
    });
    assert.ok(TOWER_LEVELS_CATALOG.chestTierRule);
    assert.ok(TOWER_LEVELS_CATALOG.monsterGroups);
    assert.equal(getTowerLevelCount(DEFAULT_TOWER_ID), 5);

    // A tower-less generateFloor call is byte-identical to the default tower.
    for (const level of [1, 2, 3, 4, 5]) {
      assert.equal(
        JSON.stringify(generateFloor(level, 4242)),
        JSON.stringify(generateFloor(level, 4242, DEFAULT_TOWER_ID)),
        `L${level} default-tower output must not change`
      );
    }
  });

  it('gives each tower its own pools, key-holders, boss, and theme', () => {
    const [a, b] = listTowerDefinitions();
    assert.notDeepEqual(a.monsterGroups.pool, b.monsterGroups.pool, 'pools must differ');
    assert.notDeepEqual(a.monsterGroups.keyHolderType, b.monsterGroups.keyHolderType, 'key-holders must differ');
    assert.notEqual(a.boss.name, b.boss.name, 'bosses must differ');
    assert.notDeepEqual(a.theme.levelTheme, b.theme.levelTheme, 'theme mappings must differ');
    assert.notEqual(a.levelCount, b.levelCount, 'the two towers should differ in depth');
  });

  it('authors a soft-lock-free graph on every level of every tower', () => {
    for (const tower of listTowerDefinitions()) {
      for (const spec of tower.levels) {
        const result = validateFloorSoftlock(spec);
        assert.equal(
          result.ok,
          true,
          `${tower.id} L${spec.level} soft-lock: ${result.failures.join('; ')}`
        );
      }
    }
  });

  it('generates deterministic floors for a selected tower with its own boss', () => {
    const towers = listTowerDefinitions();
    for (const tower of towers) {
      const last = tower.levelCount;
      const floor = generateFloor(last, 7, tower.id);
      assert.equal(floor.tower_id, tower.id);
      assert.equal(floor.tower_name, tower.name);
      assert.equal(floor.level_count, tower.levelCount);
      assert.equal(floor.biome_id, getLevelSpec(last, tower.id).tierId);
      assert.equal(floor.biome_name, getBiomeForFloor(last, tower.id).name);

      const boss = floor.monsters.find((m) => m.isBoss);
      assert.ok(boss, `${tower.id} final floor must spawn a boss`);
      assert.equal(boss.type, tower.boss.type);
      assert.equal(boss.name, tower.boss.name);

      // A summit stair closes the final level.
      assert.ok(floor.stairs.some((s) => s.dir === 'summit'), `${tower.id} needs a summit stair`);

      assert.equal(
        JSON.stringify(generateFloor(last, 7, tower.id)),
        JSON.stringify(generateFloor(last, 7, tower.id)),
        `${tower.id} generation must be deterministic`
      );
    }
  });

  it('clamps levels and floors per selected tower', () => {
    const short = listTowerDefinitions().find((t) => t.levelCount < 5);
    assert.ok(short, 'expected a shorter tower to exercise per-tower clamping');

    assert.equal(clampToTowerLevel(short.levelCount + 5, short.id), short.levelCount);
    assert.equal(clampToTowerLevel(0, short.id), 1);
    assert.equal(clampToTowerLevel(2, short.id), 2);
    assert.equal(getLevelSpec(short.levelCount + 3, short.id).level, short.levelCount);

    assert.equal(clampTowerFloor(99, short.id), short.levelCount);
    const migrated = migratePlayerToTower(
      { current_floor: 99, towerId: short.id, floorEntry: { current_floor: 99 } },
      short.id
    );
    assert.equal(migrated.current_floor, short.levelCount);
    assert.equal(migrated.floorEntry.current_floor, short.levelCount);
  });

  it('exposes the worker selectTower command', () => {
    assert.equal(typeof COMMAND_HANDLERS.selectTower, 'function');
    assert.equal(typeof COMMAND_HANDLERS.createSlot, 'function');
    assert.equal(typeof COMMAND_HANDLERS.loadSlot, 'function');
  });

  it('treats a cached floor from another tower as stale', () => {
    const [a, b] = listTowerDefinitions();
    const floorA = generateFloor(1, null, a.id);
    assert.equal(isStaleFloor(floorA, a.id), false);
    assert.equal(isStaleFloor(floorA, b.id), true, 'another tower must invalidate the cache');
    assert.equal(isStaleFloor(floorA), false, 'no tower id keeps legacy behavior');
    assert.equal(isStaleFloor(null, a.id), true);

    // A legacy record with no tower_id counts as the default tower.
    const legacy = { ...generateFloor(1, null, a.id) };
    delete legacy.tower_id;
    assert.equal(isStaleFloor(legacy, a.id), false, 'legacy default floor is not stale for default');
    assert.equal(isStaleFloor(legacy, b.id), true, 'legacy default floor is stale for another tower');
  });

  it('resolves a tower-specific tile theme without hardcoded floor bounds', () => {
    const [a, b] = listTowerDefinitions();
    // Default tower: level 1 uses tile_themes level 1.
    assert.equal(themeForFloor(1, a.id).wall.fill, themeForFloor(1).wall.fill);
    // Second tower maps its level 1 to a different authored palette.
    const mappedKey = b.theme.levelTheme['1'];
    assert.notEqual(mappedKey, '1', 'second tower should remap level 1');
    assert.equal(themeForFloor(1, b.id).wall.fill, themeForFloor(Number(mappedKey)).wall.fill);
  });
});
