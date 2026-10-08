import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES } from '../engine/config.js';
import {
  ISLANDS_CATALOG,
  TOWNS_CATALOG,
  QUESTS_CATALOG,
  DEFAULT_ISLAND_ID,
  DEFAULT_TOWN_ID,
  getIslandDefinition,
  getTownDefinition,
} from '../data/index.js';
import { composeSceneById, sceneAccessReport, tileCodeForName } from '../services/scene-composer.js';

// LIV-69: board Floor-1 + Havenreach content pass on top of the LIV-68 engine
// work. These lock the *content* contract:
//   #4 Dawnreach Isle re-authored 48x48 (LIV-77 halved the 96x96 pass), landmarks
//      re-placed, 1-tile features
//   #2 authored border is all water (no grass ring at the edge)
//   #3 fewer blocking TREE tiles
//   #5 town enter/exit is the SOUTH side in both directions
//   #6 Havenreach has a visible BUILDING_WALL perimeter with a south gate

const CODE = (name) => tileCodeForName(name);
const island = getIslandDefinition(DEFAULT_ISLAND_ID);
const town = getTownDefinition(DEFAULT_TOWN_ID);
const composedIsland = composeSceneById(DEFAULT_ISLAND_ID);
const composedTown = composeSceneById(DEFAULT_TOWN_ID);

test('LIV-69 Island 1 content pass', async (t) => {
  await t.test('#4 the island is halved to 48x48 and rectangular', () => {
    assert.equal(island.width, 48, 'Dawnreach Isle width');
    assert.equal(island.height, 48, 'Dawnreach Isle height');
    assert.equal(island.map.length, 48);
    for (const row of island.map) assert.equal(row.length, 48);
    // Half the 96x96 travel envelope (LIV-77 board feedback).
    assert.ok(island.width <= 54 && island.height <= 54, 'island roughly halved');
  });

  await t.test('#2 the authored border is all water (no grass/sand ring at the edge)', () => {
    const water = CODE('WATER');
    const h = island.height;
    const w = island.width;
    const at = (x, y) => composedIsland.tiles[y][x];
    for (let x = 0; x < w; x++) {
      assert.equal(at(x, 0), water, `top edge (${x},0) is water`);
      assert.equal(at(x, h - 1), water, `bottom edge (${x},${h - 1}) is water`);
    }
    for (let y = 0; y < h; y++) {
      assert.equal(at(0, y), water, `left edge (0,${y}) is water`);
      assert.equal(at(w - 1, y), water, `right edge (${w - 1},${y}) is water`);
    }
  });

  await t.test('#3 blocking trees are substantially reduced', () => {
    const tree = CODE('TREE');
    let count = 0;
    for (const row of composedIsland.tiles) for (const code of row) if (code === tree) count += 1;
    // The historic 48x48 map carried 91 trees; the current map (LIV-77) keeps a
    // light scattering only, and never enough to wall off the roads.
    assert.ok(count > 0, 'some trees remain for texture');
    assert.ok(count < 60, `tree count ${count} must be clearly reduced`);
  });

  await t.test('#4 named features stay 1 tile and landmarks remain coherent', () => {
    const flat = composedIsland.tiles.flat();
    const count = (code) => flat.filter((c) => c === code).length;
    assert.equal(count(CODE('TOWER_ENTRANCE')), 1, 'single tower-entrance tile');
    assert.equal(count(CODE('GATED_DOOR')), 3, 'three-tile Tide Gate');
    const ids = new Set(island.landmarks.map((l) => l.id));
    for (const id of ['spire_of_light', 'tide_gate', 'wreck_of_the_lantern', 'drowned_shrine', 'havenreach']) {
      assert.ok(ids.has(id), `landmark ${id} present`);
    }
    // Spire stays north of the strait; the town stays in the south.
    const spire = island.landmarks.find((l) => l.id === 'spire_of_light');
    const haven = island.landmarks.find((l) => l.id === 'havenreach');
    assert.ok(spire.y < island.height / 2, 'Spire in the north');
    assert.ok(haven.y > island.height / 2, 'Havenreach in the south');
  });

  await t.test('#5 the town is entered and exited from the SOUTH side both ways', () => {
    // Town scene: spawn and exit portal sit on/near the south edge.
    assert.equal(town.height, 24);
    const townExit = town.portals.find((p) => p.id === 'to_island');
    assert.equal(townExit.y, town.height - 1, 'town exit portal on the south row');
    assert.ok(town.spawn.y > town.height / 2, 'town spawn in the south half');
    // Island side: the to_town portal and the default spawn are SOUTH of the town.
    const islandTown = island.landmarks.find((l) => l.id === 'havenreach');
    const toTown = island.portals.find((p) => p.id === 'to_town');
    assert.ok(toTown.y > islandTown.y, 'island to_town portal south of the town');
    assert.ok(island.spawn.y > islandTown.y, 'island spawn south of the town');
    // Round trip is explicit and south-anchored.
    assert.equal(toTown.target.sceneId, DEFAULT_TOWN_ID);
    assert.equal(townExit.target.sceneId, DEFAULT_ISLAND_ID);
  });

  await t.test('#6 Havenreach has a visible perimeter wall with a south gate', () => {
    const wall = CODE('BUILDING_WALL');
    const door = CODE('DOORWAY');
    const h = town.height;
    const w = town.width;
    const at = (x, y) => composedTown.tiles[y][x];
    const border = [];
    for (let x = 0; x < w; x++) border.push([x, 0], [x, h - 1]);
    for (let y = 1; y < h - 1; y++) border.push([0, y], [w - 1, y]);
    let openings = 0;
    for (const [x, y] of border) {
      if (at(x, y) === door) {
        openings += 1;
        assert.equal(y, h - 1, 'the only perimeter opening is the south gate');
      } else {
        assert.equal(at(x, y), wall, `perimeter tile (${x},${y}) is a wall`);
      }
    }
    assert.equal(openings, 1, 'exactly one gate opening');
  });

  await t.test('no soft-locks: spawn reaches the town and tower (island) and the exit (town)', () => {
    const report = sceneAccessReport('island', island);
    assert.equal(report.spawnReachable, true);
    assert.equal(report.townReachable, true, 'spawn reaches the to_town portal');
    assert.equal(report.towerReachable, true, 'spawn reaches the Spire entrance');
    assert.equal(sceneAccessReport('town', town).spawnReachable, true);
  });

  await t.test('quest reach targets line up with their island features', () => {
    const wreck = QUESTS_CATALOG.quests
      .find((q) => q.id === 'the_lantern_wreck')
      .objectives.find((o) => o.id === 'reach_wreck');
    const lens = island.groundItems.find((g) => g.itemId === 'beacon_lens');
    assert.deepEqual([wreck.x, wreck.y], [lens.x, lens.y], 'Q2 reach == beacon lens');

    const shrine = QUESTS_CATALOG.quests
      .find((q) => q.id === 'rite_of_the_beacon')
      .objectives.find((o) => o.id === 'reach_shrine');
    const rite = island.interactables.find((i) => i.id === 'drowned_shrine_rite');
    assert.deepEqual([shrine.x, shrine.y], [rite.x, rite.y], 'Q3 reach == shrine rite');
  });
});
