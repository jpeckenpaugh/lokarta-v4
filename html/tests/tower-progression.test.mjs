/**
 * Lokarta: "Ascend the Tower" - E7 comprehensive progression tests
 *
 * Integration coverage that ties the E1-E6 pieces together against the D2
 * level-design contract:
 *   - the five-level stair shaft is a true two-way vertical sequence;
 *   - a level only opens after each tier key holder is defeated, at the tile
 *     level, on every seed;
 *   - the §10 soft-lock oracle actually rejects broken progression (it is not
 *     vacuously green);
 *   - monster groups follow the authored pool rotation, carry exactly one
 *     buffed key holder per key room, and scale from the catalog;
 *   - the entry-room group never ambushes the player.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateFloor,
  getLevelSpec,
  validateFloorSoftlock,
  assertNoSoftlock,
  TILE_TYPES,
  TOWER_LEVEL_COUNT,
} from '../services/floor-generator.js';

import { GridMap, DoorSystem } from '../engine/index.js';
import { MONSTERS_CATALOG, TOWER_LEVELS_CATALOG } from '../data/index.js';

const LEVELS = [1, 2, 3, 4, 5];
const SEEDS = [1, 7, 42, 1337, 90210, 555001, 808080, 31337, 4, 999999];
const TIERS = ['copper', 'silver', 'gold'];

/** Loads a generated floor into a GridMap and tags its gate tiles (as App does). */
function loadFloorGrid(floor) {
  const grid = new GridMap();
  grid.loadFromMatrix(floor.tiles);
  for (const [tier, gate] of Object.entries(floor.gates || {})) {
    for (const t of gate.tiles || []) {
      const tile = grid.getTile(t.x, t.y);
      if (tile) {
        tile.gateTier = tier;
        tile.gateOpen = false;
      }
    }
  }
  return grid;
}

/** BFS over walkable tiles from a start point; returns a Set of "x,y" keys. */
function reachableTiles(grid, start) {
  const seen = new Set([`${start.x},${start.y}`]);
  const queue = [{ x: start.x, y: start.y }];
  while (queue.length > 0) {
    const { x, y } = queue.shift();
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (!grid.isWalkable(nx, ny)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/** Numeric suffix of a generated id (`f3_m_12` -> 12) for insertion order. */
function monsterIdNum(monster) {
  return Number(String(monster.id).split('_').pop());
}

describe('E7 Tower Progression — full ascent integration', () => {
  it('authors exactly five levels on a closed stair-shaft sequence', () => {
    assert.equal(TOWER_LEVEL_COUNT, 5);
    assert.equal(TOWER_LEVELS_CATALOG.levelCount, 5);
    assert.equal(TOWER_LEVELS_CATALOG.levels.length, 5);

    const shaft = TOWER_LEVELS_CATALOG.stairShaft;
    assert.deepEqual(LEVELS.map(l => shaft[String(l)]), [9, 6, 3, 8, 5]);
    assert.deepEqual(TOWER_LEVELS_CATALOG.entry, {
      level: 1,
      room: 2,
      doorTile: [19, 1],
      spawnTile: [19, 2],
    });

    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      assert.equal(spec.level, level);
      assert.equal(spec.stairRoom, shaft[String(level)], `L${level} stair room`);
      const expectedEntry = level === 1 ? 2 : shaft[String(level - 1)];
      assert.equal(spec.entryRoom, expectedEntry, `L${level} entry room`);
      const keyRooms = Object.values(spec.keyRooms);
      assert.equal(keyRooms.length, 3);
      assert.equal(new Set(keyRooms).size, 3, `L${level} key rooms must be distinct`);
      for (const room of keyRooms) assert.ok(room >= 1 && room <= 9, `L${level} key room ${room}`);
    }

    assert.equal(getLevelSpec(5).isFinal, true);
    for (const level of [1, 2, 3, 4]) assert.ok(!getLevelSpec(level).isFinal);
  });

  it('is a true two-way shaft: level N down-stair lands on level N+1 up-stair and back', () => {
    const shaft = TOWER_LEVELS_CATALOG.stairShaft;
    const stairTiles = TOWER_LEVELS_CATALOG.stairTiles;

    for (const level of [1, 2, 3, 4]) {
      const here = generateFloor(level);
      const next = generateFloor(level + 1);
      assert.deepEqual(
        here.stair_down_coords,
        next.stair_up_coords,
        `L${level} down-stair must land on L${level + 1} up-stair`
      );

      const downRoom = shaft[String(level)];
      assert.deepEqual(
        [here.stair_down_coords.x, here.stair_down_coords.y],
        stairTiles[String(downRoom)],
        `L${level} down-stair sits on the authored shaft tile`
      );
      assert.equal(here.stairs.find(s => s.dir === 'down').targetLevel, level + 1);
      assert.equal(next.stairs.find(s => s.dir === 'up').targetLevel, level);

      assert.equal(here.tiles[here.stair_down_coords.y][here.stair_down_coords.x], TILE_TYPES.STAIRS);
      assert.equal(next.tiles[next.stair_up_coords.y][next.stair_up_coords.x], TILE_TYPES.STAIRS);
    }

    const l5 = generateFloor(5);
    const summit = l5.stairs.find(s => s.dir === 'summit');
    assert.ok(summit, 'level 5 must expose a summit tile');
    assert.equal(summit.targetLevel, null);
    assert.equal(l5.stairs.filter(s => s.dir === 'down').length, 0);
  });

  it('opens a level only after each tier key holder is defeated (tile level, all seeds)', () => {
    for (const level of LEVELS) {
      for (const seed of SEEDS) {
        const floor = generateFloor(level, seed);
        const grid = loadFloorGrid(floor);
        const spawn = floor.spawn_coords;
        const holderTile = tier => {
          const holder = floor.monsters.find(m => m.holdsKey === tier);
          assert.ok(holder, `L${level}/${seed} missing ${tier} holder`);
          return `${holder.x},${holder.y}`;
        };
        const objective = floor.stairs.find(s => s.dir !== 'up');
        assert.ok(objective, `L${level} missing objective stair`);
        const objectiveKey = `${objective.x},${objective.y}`;

        for (const tier of TIERS) {
          for (const t of floor.gates[tier].tiles) {
            assert.equal(
              grid.isWalkable(t.x, t.y),
              false,
              `L${level}/${seed} ${tier} gate must block before its key`
            );
          }
        }

        let reach = reachableTiles(grid, spawn);
        assert.ok(reach.has(holderTile('copper')), `L${level}/${seed} copper holder reachable`);
        assert.ok(!reach.has(holderTile('silver')), `L${level}/${seed} silver gated`);
        assert.ok(!reach.has(holderTile('gold')), `L${level}/${seed} gold gated`);
        assert.ok(!reach.has(objectiveKey), `L${level}/${seed} objective gated`);

        DoorSystem.openTierGates(grid, 'copper');
        for (const t of floor.gates.copper.tiles) assert.equal(grid.isWalkable(t.x, t.y), true);
        reach = reachableTiles(grid, spawn);
        assert.ok(reach.has(holderTile('silver')), `L${level}/${seed} silver after copper`);
        assert.ok(!reach.has(holderTile('gold')), `L${level}/${seed} gold still gated`);
        assert.ok(!reach.has(objectiveKey), `L${level}/${seed} objective still gated`);

        DoorSystem.openTierGates(grid, 'silver');
        for (const t of floor.gates.silver.tiles) assert.equal(grid.isWalkable(t.x, t.y), true);
        reach = reachableTiles(grid, spawn);
        assert.ok(reach.has(holderTile('gold')), `L${level}/${seed} gold after silver`);
        assert.ok(!reach.has(objectiveKey), `L${level}/${seed} objective still gated`);

        DoorSystem.openTierGates(grid, 'gold');
        for (const t of floor.gates.gold.tiles) assert.equal(grid.isWalkable(t.x, t.y), true);
        reach = reachableTiles(grid, spawn);
        assert.ok(reach.has(objectiveKey), `L${level}/${seed} objective after gold`);
      }
    }
  });

  it('soft-lock oracle rejects injected progression breaks (not vacuously green)', () => {
    for (const level of LEVELS) {
      const result = validateFloorSoftlock(getLevelSpec(level));
      assert.equal(result.ok, true, `L${level}: ${result.failures.join('; ')}`);
    }

    const stairInEntry = structuredClone(getLevelSpec(1));
    stairInEntry.stairRoom = stairInEntry.entryRoom;
    const a = validateFloorSoftlock(stairInEntry);
    assert.equal(a.ok, false);
    assert.ok(a.failures.some(f => f.includes('stair room reachable before gold gate')));
    assert.throws(() => assertNoSoftlock(stairInEntry), /soft-lock/);

    const earlySilver = structuredClone(getLevelSpec(1));
    earlySilver.keyRooms.silver = 3; // tier-0 room, reachable with no keys
    const b = validateFloorSoftlock(earlySilver);
    assert.equal(b.ok, false);
    assert.ok(b.failures.some(f => f.includes('silver holder reachable before copper gate')));

    const noCopperGate = structuredClone(getLevelSpec(1));
    noCopperGate.gates.copper = null;
    assert.equal(validateFloorSoftlock(noCopperGate).ok, false);

    const swapped = structuredClone(getLevelSpec(1));
    [swapped.keyRooms.silver, swapped.keyRooms.gold] = [swapped.keyRooms.gold, swapped.keyRooms.silver];
    assert.equal(validateFloorSoftlock(swapped).ok, false);
  });

  it('spawns the authored pool rotation plus exactly one key holder per key room', () => {
    const groups = TOWER_LEVELS_CATALOG.monsterGroups;
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const groupSize = groups.groupSize[String(level)];
      const pool = groups.pool[String(level)];
      const holderTypes = groups.keyHolderType[String(level)];

      for (const seed of [1, 1337, 999999]) {
        const floor = generateFloor(level, seed);
        for (let room = 1; room <= 9; room++) {
          const isArrival = room === spec.entryRoom || room === spec.stairRoom;
          const holderTier = TIERS.find(t => spec.keyRooms[t] === room) || null;
          const members = floor.monsters
            .filter(m => m.room === room && !m.isBoss && !m.isGuard && !m.holdsKey)
            .sort((a, b) => monsterIdNum(a) - monsterIdNum(b));
          const regular = isArrival ? 0 : (holderTier ? groupSize - 1 : groupSize);
          assert.equal(members.length, regular, `L${level}/${seed} room ${room} member count`);

          const expected = [];
          for (let s = 0; s < regular; s++) expected.push(pool[(room - 1 + s) % pool.length]);
          assert.deepEqual(
            members.map(m => m.type),
            expected,
            `L${level}/${seed} room ${room} pool rotation`
          );

          if (holderTier) {
            const holders = floor.monsters.filter(m => m.holdsKey === holderTier);
            assert.equal(holders.length, 1, `L${level} exactly one ${holderTier} holder`);
            assert.equal(holders[0].room, room, `L${level} ${holderTier} holder room`);
            assert.equal(holders[0].type, holderTypes[holderTier], `L${level} ${holderTier} holder type`);
          }

          const inRoom = floor.monsters.filter(
            m => m.room === room && !m.isBoss && !m.isGuard
          );
          assert.equal(inRoom.length, isArrival ? 0 : groupSize, `L${level} room ${room} group size`);
        }
      }
    }
  });

  it('scales regular and key-holder stats from the catalog', () => {
    const groups = TOWER_LEVELS_CATALOG.monsterGroups;
    for (const level of LEVELS) {
      const scale = groups.statScale[String(level)];
      const mod = groups.keyHolderModifier;
      const floor = generateFloor(level);
      for (const monster of floor.monsters) {
        if (monster.isBoss || monster.isGuard) continue;
        const base = MONSTERS_CATALOG[monster.type];
        assert.ok(base, `missing base stats for ${monster.type}`);
        if (monster.holdsKey) {
          assert.equal(monster.max_hp, Math.round(base.baseHp * scale.hp * mod.hp));
          assert.equal(monster.hp, monster.max_hp);
          assert.equal(monster.attack, Math.round(base.baseAttack * scale.atk * mod.atk));
        } else {
          assert.equal(monster.hp, Math.round(base.baseHp * scale.hp));
          assert.equal(monster.attack, Math.round(base.baseAttack * scale.atk));
        }
        assert.equal(monster.defense, base.baseDefense, 'defense is unscaled');
      }
    }
  });

  it('never ambushes the player: both arrival rooms hold no monsters at all', () => {
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const floor = generateFloor(level);
      // Entry room (arrival from below) AND stair room (arrival from above / the
      // room descended into) are both empty by rule, so neither entering
      // nor descending drops the player into a chase. No key holder sits there.
      for (const room of [spec.entryRoom, spec.stairRoom]) {
        const inRoom = floor.monsters.filter(m => m.room === room && !m.isBoss && !m.isGuard);
        assert.equal(inRoom.length, 0, `L${level} arrival room ${room} must be empty`);
        assert.ok(!floor.monsters.some(m => m.room === room && m.holdsKey), `L${level} arrival room ${room} must not gate progression`);
      }

      const spawnRoom = floor.monsters.filter(m => m.x === floor.spawn_coords.x && m.y === floor.spawn_coords.y);
      assert.equal(spawnRoom.length, 0, `L${level} nothing may spawn on the entry tile`);
    }
  });
});
