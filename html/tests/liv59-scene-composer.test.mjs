import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES, IMPASSABLE_TILE_TYPES } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import {
  resolveLegend,
  tileCodeForName,
  parseTilemap,
  composeScene,
  composeSceneById,
  isCodeWalkable,
  reachableFrom,
  sceneAccessReport,
} from '../services/scene-composer.js';
import {
  DEFAULT_ISLAND_ID,
  DEFAULT_TOWN_ID,
  getIslandDefinition,
  getTownDefinition,
} from '../data/index.js';

// LIV-59 P0: scene composer — catalog tilemaps (char rows + legend) become the
// numeric matrix the engine consumes. Pure; no gameplay.

test('LIV-59 scene composer', async (t) => {
  await t.test('appends the nine scene tile types without renumbering the originals', () => {
    assert.equal(TILE_TYPES.FLOOR, 0);
    assert.equal(TILE_TYPES.TOWN_GATE, 6);
    assert.equal(TILE_TYPES.WATER, 7);
    assert.equal(TILE_TYPES.GRASS, 8);
    assert.equal(TILE_TYPES.SAND, 9);
    assert.equal(TILE_TYPES.PATH, 10);
    assert.equal(TILE_TYPES.TREE, 11);
    assert.equal(TILE_TYPES.BRIDGE, 12);
    assert.equal(TILE_TYPES.BUILDING_WALL, 13);
    assert.equal(TILE_TYPES.DOORWAY, 14);
    assert.equal(TILE_TYPES.TOWER_ENTRANCE, 15);
    // Water is the board's explicit impassable border (LIV-55 D6).
    assert.ok(IMPASSABLE_TILE_TYPES.has(TILE_TYPES.WATER));
    assert.ok(!IMPASSABLE_TILE_TYPES.has(TILE_TYPES.BRIDGE));
    assert.ok(!IMPASSABLE_TILE_TYPES.has(TILE_TYPES.DOORWAY));
    assert.equal(tileCodeForName('WATER'), TILE_TYPES.WATER);
    assert.equal(tileCodeForName('NOPE'), null);
  });

  await t.test('resolves a legend to codes and defaults unknown values to FLOOR', () => {
    const resolved = resolveLegend({ '.': 'GRASS', '~': 'WATER', '?': 'MYSTERY' });
    assert.equal(resolved['.'], TILE_TYPES.GRASS);
    assert.equal(resolved['~'], TILE_TYPES.WATER);
    assert.equal(resolved['?'], TILE_TYPES.FLOOR);
  });

  await t.test('parseTilemap pads to a rectangle and is deterministic', () => {
    const charToCode = resolveLegend({ '.': 'GRASS', '~': 'WATER' });
    const a = parseTilemap(['...', '~~', ''], charToCode);
    const b = parseTilemap(['...', '~~', ''], charToCode);
    assert.deepEqual(a, b);
    assert.equal(a.length, 3);
    for (const row of a) assert.equal(row.length, 3);
    assert.equal(a[0][0], TILE_TYPES.GRASS);
    assert.equal(a[1][0], TILE_TYPES.WATER);
    // Short rows and empty rows pad with walkable FLOOR, never water.
    assert.equal(a[1][2], TILE_TYPES.FLOOR);
    assert.equal(a[2][0], TILE_TYPES.FLOOR);
  });

  await t.test('water is impassable through GridMap; grass/path/bridge/doorway walk', () => {
    const grid = new GridMap(3, 1);
    grid.loadFromMatrix([[
      TILE_TYPES.WATER,
      TILE_TYPES.GRASS,
      TILE_TYPES.BRIDGE,
    ]]);
    assert.equal(grid.isWalkable(0, 0), false, 'water blocks');
    assert.equal(grid.isWalkable(1, 0), true, 'grass walks');
    assert.equal(grid.isWalkable(2, 0), true, 'bridge walks over water');

    const grid2 = new GridMap(3, 1);
    grid2.loadFromMatrix([[
      TILE_TYPES.TREE,
      TILE_TYPES.BUILDING_WALL,
      TILE_TYPES.DOORWAY,
    ]]);
    assert.equal(grid2.isWalkable(0, 0), false, 'tree blocks');
    assert.equal(grid2.isWalkable(1, 0), false, 'building wall blocks');
    assert.equal(grid2.isWalkable(2, 0), true, 'doorway walks (interaction trigger)');
  });

  await t.test('composes the Dawnreach Isle descriptor from the catalog', () => {
    const def = getIslandDefinition(DEFAULT_ISLAND_ID);
    const scene = composeSceneById(DEFAULT_ISLAND_ID);
    assert.equal(scene.sceneKind, 'island');
    assert.equal(scene.sceneId, def.id);
    assert.equal(scene.width, def.width);
    assert.equal(scene.height, def.height);
    assert.equal(scene.lighting, 'ambient');
    assert.equal(scene.theme, def.theme);
    assert.equal(scene.towerId, 'spire_of_light');
    assert.equal(scene.townId, def.townId);
    // Every row is exactly `width` wide (the matrix the engine consumes).
    for (const row of scene.tiles) assert.equal(row.length, def.width);
    // Spawn is walkable in the runtime matrix.
    assert.equal(isCodeWalkable(scene.tiles[scene.spawn.y][scene.spawn.x]), true);
    // Portals are copied, not aliased.
    assert.ok(scene.portals.length >= 2);
    assert.notEqual(scene.portals[0], def.portals[0]);
    // Scene composition is deterministic.
    assert.deepEqual(composeSceneById(DEFAULT_ISLAND_ID).tiles, scene.tiles);
  });

  await t.test('composes the Havenreach town and emits building interactables', () => {
    const def = getTownDefinition(DEFAULT_TOWN_ID);
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    assert.equal(scene.sceneKind, 'town');
    assert.equal(scene.lighting, 'ambient');
    assert.equal(scene.npcs.length, def ? 8 : scene.npcs.length);
    const shop = scene.interactables.find((i) => i.interaction && i.interaction.type === 'shop');
    const temple = scene.interactables.find((i) => i.interaction && i.interaction.type === 'temple');
    assert.ok(shop, 'town exposes a shop building interaction');
    assert.ok(temple, 'town exposes a temple building interaction');
    // Building interactables sit on walkable doorway tiles.
    for (const b of scene.interactables.filter((i) => i.kind === 'building')) {
      assert.equal(isCodeWalkable(scene.tiles[b.y][b.x]), true, `door at ${b.x},${b.y} must be walkable`);
    }
  });

  await t.test('no rotation soft-lock: spawn reaches the town and tower entrance', () => {
    const island = getIslandDefinition(DEFAULT_ISLAND_ID);
    const report = sceneAccessReport('island', island);
    assert.equal(report.spawnReachable, true);
    assert.equal(report.townReachable, true, 'spawn can reach the town portal');
    // The tower entrance is reachable in principle; the Tide Gate is a runtime
    // lock, not a solid, so the access BFS passes it (LIV-55 no-soft-lock).
    assert.equal(report.towerReachable, true);

    const town = getTownDefinition(DEFAULT_TOWN_ID);
    const townReport = sceneAccessReport('town', town);
    assert.equal(townReport.spawnReachable, true);
    assert.equal(townReport.townReachable, true, 'town spawn can reach the island portal');
  });

  await t.test('reachableFrom treats solids as walls and respects bounds', () => {
    const WATER = TILE_TYPES.WATER;
    const G = TILE_TYPES.GRASS;
    const tiles = [
      [G, G, WATER, G],
      [G, WATER, WATER, G],
      [G, G, WATER, G],
    ];
    const reach = reachableFrom(tiles, { x: 0, y: 0 });
    assert.ok(reach.has('0,0'));
    assert.ok(!reach.has('3,0'), 'right shore sealed by the full water column');
    assert.ok(!reach.has('3,2'), 'right shore sealed');
    assert.ok(reach.has('0,2'));
    assert.equal(reachableFrom(tiles, { x: 99, y: 99 }).size, 0);
  });

  await t.test('throws for an unknown scene id and composes only catalog data', () => {
    assert.equal(composeSceneById('does_not_exist'), null);
    assert.throws(() => composeScene('island', null), /missing island definition/);
  });
});
