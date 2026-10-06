/**
 * Lokarta: "Ascend the Tower" - E2 Floor Generator tests
 *
 * Covers the D2 level-design contract: 5 levels, room-2 entry, the two-way
 * stair shaft, gated doors, deterministic output, and the §10 no-soft-lock
 * oracle across many seeds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateFloor,
  getBiomeForFloor,
  getLevelSpec,
  clampLevel,
  assertNoSoftlock,
  validateFloorSoftlock,
  validateFloorConnectivity,
  buildRoomGraph,
  reachableRooms,
  FLOOR_TEMPLATE_VERSION,
  TILE_TYPES,
  TOWER_LEVEL_COUNT,
} from '../services/floor-generator.js';

import { DUNGEONS_CATALOG, TOWER_LEVELS_CATALOG } from '../data/index.js';

const LEVELS = [1, 2, 3, 4, 5];
const SEEDS = [1, 7, 42, 1337, 90210, 555001, 808080, 31337, 4, 999999];

describe('E2 Floor Generator — 5-level tower', () => {
  it('exposes exactly 5 tower levels and clamps out-of-range input', () => {
    assert.equal(TOWER_LEVEL_COUNT, 5);
    assert.equal(clampLevel(0), 1);
    assert.equal(clampLevel(-9), 1);
    assert.equal(clampLevel(6), 5);
    assert.equal(clampLevel(99), 5);
    assert.equal(generateFloor(20).level, 5);
  });

  it('stamps every level with template version >= 3', () => {
    assert.ok(FLOOR_TEMPLATE_VERSION >= 3, 'tower rework must bump the template version');
    for (const level of LEVELS) {
      assert.equal(generateFloor(level).template_version, FLOOR_TEMPLATE_VERSION);
    }
  });

  it('assigns the canonical tier for every level', () => {
    const expected = [
      ['The Gatehouse', 1],
      ['The Hall of Banners', 2],
      ['The Bell Keep', 3],
      ['The Solar Gallery', 4],
      ['The Crown Spire', 5],
    ];
    for (const [name, level] of expected) {
      assert.equal(getBiomeForFloor(level).name, name);
      assert.equal(generateFloor(level).biome_name, name);
    }
  });

  it('enters level 1 through the room-2 top doorway at (19,1) and spawns at (19,2)', () => {
    const floor = generateFloor(1);
    assert.deepEqual(floor.entry, { x: 19, y: 1 });
    assert.deepEqual(floor.spawn_coords, { x: 19, y: 2 });
    assert.equal(floor.tiles[1][19], TILE_TYPES.DOOR);
    assert.notEqual(floor.tiles[2][19], TILE_TYPES.WALL);
    assert.equal(floor.entry_room, 2);
  });

  it('spawns levels 2-5 one tile from the arrival up-stair (never on it)', () => {
    for (const level of [2, 3, 4, 5]) {
      const floor = generateFloor(level);
      const up = floor.stair_up_coords;
      assert.ok(up, `level ${level} must expose an up-stair`);
      const manhattan = Math.abs(floor.spawn_coords.x - up.x) + Math.abs(floor.spawn_coords.y - up.y);
      assert.equal(manhattan, 1, `level ${level} spawn must be one tile from the up-stair`);
      assert.notDeepEqual(floor.spawn_coords, up);
      assert.equal(floor.tiles[floor.spawn_coords.y][floor.spawn_coords.x], TILE_TYPES.FLOOR);
    }
  });

  it('aligns the two-way stair shaft: level N down-stair == level N+1 up-stair', () => {
    for (const level of [1, 2, 3, 4]) {
      const here = generateFloor(level);
      const next = generateFloor(level + 1);
      assert.deepEqual(
        here.stair_down_coords,
        next.stair_up_coords,
        `level ${level} down-stair must land on level ${level + 1} up-stair`
      );
    }
  });

  it('level 1 has only a down-stair; level 5 has an up-stair and a summit, no down', () => {
    const l1 = generateFloor(1);
    assert.equal(l1.stair_up_coords, null);
    assert.equal(l1.stair_down_coords.dir, undefined); // coords object, not the stair record
    assert.ok(l1.stairs.some(s => s.dir === 'down' && s.targetLevel === 2));

    const l5 = generateFloor(5);
    assert.ok(l5.is_final);
    assert.ok(l5.stairs.some(s => s.dir === 'up' && s.targetLevel === 4));
    assert.ok(l5.stairs.some(s => s.dir === 'summit' && s.targetLevel === null));
    assert.ok(!l5.stairs.some(s => s.dir === 'down'));
  });

  it('carves open edges as DOOR, gate edges as GATED_DOOR, sealed edges as WALL', () => {
    const edges = DUNGEONS_CATALOG.standard_40x40.edges;
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const floor = generateFloor(level);
      const gateEdges = new Set(Object.values(spec.gates));

      for (const edgeId of spec.openEdges) {
        if (gateEdges.has(edgeId)) continue; // carved as a gate below
        for (const [x, y] of edges[edgeId].tiles) {
          assert.equal(floor.tiles[y][x], TILE_TYPES.DOOR, `L${level} ${edgeId} open tile`);
        }
      }
      for (const tier of ['copper', 'silver', 'gold']) {
        const edgeId = spec.gates[tier];
        assert.ok(floor.gates[tier], `L${level} missing ${tier} gate metadata`);
        assert.equal(floor.gates[tier].edge, edgeId);
        for (const [x, y] of edges[edgeId].tiles) {
          assert.equal(floor.tiles[y][x], TILE_TYPES.GATED_DOOR, `L${level} ${tier} gate tile`);
        }
      }
      for (const edgeId of spec.sealedEdges) {
        for (const [x, y] of edges[edgeId].tiles) {
          assert.equal(floor.tiles[y][x], TILE_TYPES.WALL, `L${level} ${edgeId} sealed tile`);
        }
      }
    }
  });

  it('every level is a spanning tree: 5 free + 3 gate + 4 sealed edges (all 12)', () => {
    const all = Object.keys(DUNGEONS_CATALOG.standard_40x40.edges);
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const gateEdges = new Set(Object.values(spec.gates));
      const freeOpen = spec.openEdges.filter(e => !gateEdges.has(e));
      const union = new Set([...spec.openEdges, ...spec.sealedEdges, ...gateEdges]);
      assert.equal(spec.openEdges.length, 8, 'openEdges includes the gated edges');
      assert.equal(freeOpen.length, 5, `L${level} needs 5 free edges for a spanning tree`);
      assert.equal(gateEdges.size, 3);
      assert.equal(spec.sealedEdges.length, 4);
      assert.equal(union.size, 12, `L${level} must account for every edge once`);
      for (const edgeId of all) assert.ok(union.has(edgeId));
    }
  });

  it('is deterministic for a fixed seed (tiles, monsters, items byte-identical)', () => {
    for (const level of LEVELS) {
      for (const seed of [4242, 1337]) {
        const a = generateFloor(level, seed);
        const b = generateFloor(level, seed);
        assert.deepEqual(a.tiles, b.tiles);
        assert.deepEqual(a.monsters, b.monsters);
        assert.deepEqual(a.items, b.items);
        assert.deepEqual(a.stairs, b.stairs);
      }
    }
  });

  it('passes the D2 §10 no-soft-lock oracle on every level', () => {
    for (const level of LEVELS) {
      assert.equal(assertNoSoftlock(level), true);
      const result = validateFloorSoftlock(level);
      assert.equal(result.ok, true, `level ${level}: ${result.failures.join('; ')}`);
    }
  });

  it('passes the soft-lock oracle across many seeds (structure is seed-independent)', () => {
    for (const level of LEVELS) {
      for (const seed of SEEDS) {
        const floor = generateFloor(level, seed);
        assert.equal(validateFloorSoftlock(getLevelSpec(floor.level)).ok, true);
      }
    }
  });

  it('enforces strict key order: copper -> silver -> gold -> stair room', () => {
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const r = validateFloorSoftlock(spec);
      assert.ok(r.stages.entry.includes(spec.keyRooms.copper));
      assert.ok(!r.stages.entry.includes(spec.keyRooms.silver));
      assert.ok(!r.stages.entry.includes(spec.keyRooms.gold));
      assert.ok(!r.stages.entry.includes(spec.stairRoom));
      assert.ok(r.stages.copper.includes(spec.keyRooms.silver));
      assert.ok(!r.stages.copper.includes(spec.keyRooms.gold));
      assert.ok(r.stages.silver.includes(spec.keyRooms.gold));
      assert.ok(!r.stages.silver.includes(spec.stairRoom));
      assert.ok(r.stages.gold.includes(spec.stairRoom));
    }
  });

  it('carved floor is connected from spawn to every stair tile', () => {
    for (const level of LEVELS) {
      for (const seed of SEEDS) {
        const floor = generateFloor(level, seed);
        const result = validateFloorConnectivity(floor);
        assert.equal(result.ok, true, `level ${level}: unreachable stairs`);
      }
    }
  });

  it('gate-locked graphs match the authored room tiers', () => {
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const graph = buildRoomGraph(spec, { copper: false, silver: false, gold: false });
      const tier0 = [...reachableRooms(graph, spec.entryRoom)].sort((a, b) => a - b);
      const authoredTier0 = Object.entries(spec.roomTiers)
        .filter(([, t]) => t === 0)
        .map(([room]) => Number(room))
        .sort((a, b) => a - b);
      assert.deepEqual(tier0, authoredTier0, `L${level} tier-0 rooms`);
    }
  });

  it('spawns a group per room with a key holder in each key room, but none in either arrival room', () => {
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const floor = generateFloor(level);
      const groupSize = TOWER_LEVELS_CATALOG.monsterGroups.groupSize[String(level)];
      // No authored key room is an arrival room, so the empty-arrival-room rule
      // never removes a key holder.
      const arrivalRooms = [spec.entryRoom, spec.stairRoom];
      for (const room of arrivalRooms) {
        assert.ok(!Object.values(spec.keyRooms).includes(room), `L${level} key room must not be arrival room ${room}`);
      }

      for (let room = 1; room <= 9; room++) {
        const inRoom = floor.monsters.filter(m => m.room === room && !m.isBoss && !m.isGuard);
        const expected = arrivalRooms.includes(room) ? 0 : groupSize;
        assert.equal(inRoom.length, expected, `L${level} room ${room} group size`);
      }

      const holderTiers = floor.monsters.filter(m => m.holdsKey).map(m => m.holdsKey).sort();
      assert.deepEqual(holderTiers, ['copper', 'gold', 'silver']);
      for (const [tier, room] of Object.entries(spec.keyRooms)) {
        const holder = floor.monsters.find(m => m.holdsKey === tier);
        assert.equal(holder.room, room, `L${level} ${tier} holder room`);
        assert.ok(holder.hp > 0 && holder.attack > 0);
      }
    }
  });

  it('authors runtime arrival tiles: beside the up-stair from below, beside the down-stair from above', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      if (level > 1) {
        const up = floor.stair_up_coords;
        assert.ok(floor.arrival_from_lower_coords, `L${level} missing arrival from below`);
        const manhattan = Math.abs(floor.arrival_from_lower_coords.x - up.x) + Math.abs(floor.arrival_from_lower_coords.y - up.y);
        assert.equal(manhattan, 1, `L${level} arrival-from-below must be one tile off the up-stair`);
      } else {
        assert.equal(floor.arrival_from_lower_coords, null, 'L1 is entered through the doorway, not from below');
      }
      if (level < TOWER_LEVEL_COUNT) {
        const down = floor.stair_down_coords;
        assert.ok(floor.arrival_from_upper_coords, `L${level} missing arrival from above`);
        const manhattan = Math.abs(floor.arrival_from_upper_coords.x - down.x) + Math.abs(floor.arrival_from_upper_coords.y - down.y);
        assert.equal(manhattan, 1, `L${level} arrival-from-above must be one tile off the down-stair (the exit)`);
      } else {
        assert.equal(floor.arrival_from_upper_coords, null, 'L5 has no level above');
      }
    }
  });

  it('places the level-5 guardian and guards in the summit room', () => {
    const floor = generateFloor(5);
    const boss = floor.monsters.find(m => m.isBoss);
    assert.ok(boss);
    assert.equal(boss.type, 'abyssal_overlord');
    assert.equal(boss.name, 'The Spire Warden');
    assert.equal(boss.hp, 600);
    assert.equal(boss.max_hp, 600);
    assert.equal(boss.attack, 20);
    assert.equal(boss.defense, 6);
    assert.deepEqual({ x: boss.x, y: boss.y }, { x: 19, y: 19 });
    assert.equal(floor.monsters.filter(m => m.isGuard).length, 2);
  });

  it('grants the level-1 starter cache as arrows x22 near the entry', () => {
    const floor = generateFloor(1);
    const arrows = floor.items.find(i => i.item_id === 'arrows');
    assert.ok(arrows, 'level 1 must carry a starter cache');
    assert.equal(arrows.quantity, 22);
    assert.equal(arrows.type, 'ammo');
    const dist = Math.abs(arrows.x - floor.spawn_coords.x) + Math.abs(arrows.y - floor.spawn_coords.y);
    assert.ok(dist <= 10, `starter cache should be near the entry, was ${dist} tiles away`);
  });

  it('grants only the health potion as the levels 2-5 starter cache (torch removed)', () => {
    for (const level of [2, 3, 4, 5]) {
      const ids = generateFloor(level).items.map(i => i.item_id).sort();
      assert.deepEqual(ids, ['health_potion']);
    }
  });

  it('Level 1 topology: gold gate sits between rooms 8/9, and 7/8 is the doorway', () => {
    const spec = getLevelSpec(1);
    // Requested layout: gold gate moved from 6/9 to 8/9; the 5/8 doorway moved to 7/8.
    assert.equal(spec.gates.gold, 'h89', 'gold gate must be between rooms 8 and 9');
    assert.equal(spec.gates.copper, 'v14');
    assert.equal(spec.gates.silver, 'h45');
    assert.ok(spec.sealedEdges.includes('v69'), 'the old 6/9 gold gate must now be a wall');
    assert.ok(spec.sealedEdges.includes('v58'), 'the old 5/8 doorway must now be a wall');
    assert.ok(spec.openEdges.includes('h78'), 'the 7/8 doorway must be open');

    // Progression order is preserved, and the stair room is only reachable through
    // the gold gate between rooms 8 and 9.
    const r = validateFloorSoftlock(spec);
    assert.equal(r.ok, true, r.failures.join('; '));
    assert.deepEqual(r.stages.entry, [1, 2, 3]);
    assert.deepEqual(r.stages.copper, [1, 2, 3, 4, 7, 8]);
    assert.deepEqual(r.stages.silver, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(r.stages.gold, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(!r.stages.silver.includes(9), 'stair room 9 must not be reachable before the gold gate');
  });

  it('Level 2 topology: gold gate sits between rooms 3/6, and 5/6 is sealed', () => {
    const spec = getLevelSpec(2);
    // Requested layout: gold gate moved from 5/6 to 3/6; the vacated 5/6 edge
    // becomes a solid wall so the stair room stays gated behind the gold key.
    assert.equal(spec.gates.gold, 'v36', 'gold gate must be between rooms 3 and 6');
    assert.equal(spec.gates.copper, 'h78');
    assert.equal(spec.gates.silver, 'v47');
    assert.ok(spec.openEdges.includes('v36'), 'the new 3/6 gold gate must be carved');
    assert.ok(!spec.openEdges.includes('h56'), 'the old 5/6 gate must no longer be carved');
    assert.ok(spec.sealedEdges.includes('h56'), 'the old 5/6 gate must now be a wall');
    assert.ok(!spec.sealedEdges.includes('v36'), 'the new 3/6 gate must not be sealed');

    // Progression order is preserved, and the stair room is only reachable through
    // the gold gate between rooms 3 and 6.
    const r = validateFloorSoftlock(spec);
    assert.equal(r.ok, true, r.failures.join('; '));
    assert.deepEqual(r.stages.entry, [8, 9]);
    assert.deepEqual(r.stages.copper, [7, 8, 9]);
    assert.deepEqual(r.stages.silver, [1, 2, 3, 4, 5, 7, 8, 9]);
    assert.deepEqual(r.stages.gold, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(!r.stages.silver.includes(6), 'stair room 6 must not be reachable before the gold gate');
  });
});
