import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ISLAND_ID,
  DEFAULT_TOWN_ID,
  getIslandDefinition,
  getTownDefinition,
} from '../data/index.js';
import { composeSceneById, sceneAccessReport, tileCodeForName } from '../services/scene-composer.js';

// LIV-70: board feedback on the Dawnreach Isle view — the Havenreach enclosure
// read as near full-size and took too many steps to walk around. The island
// representation is now a compact ~10x10 walled overmap marker fed by the
// straight Pilgrim's Road; the interior town (towns.json) is unchanged.

const CODE = (name) => tileCodeForName(name);
const island = getIslandDefinition(DEFAULT_ISLAND_ID);
const town = getTownDefinition(DEFAULT_TOWN_ID);
const composedIsland = composeSceneById(DEFAULT_ISLAND_ID);

const WALL = CODE('BUILDING_WALL');
const PATH = CODE('PATH');

function southWallTiles() {
  const out = [];
  for (let y = 70; y < composedIsland.height; y++) {
    for (let x = 0; x < composedIsland.width; x++) {
      if (composedIsland.tiles[y][x] === WALL) out.push([x, y]);
    }
  }
  return out;
}

test('LIV-70 compact Havenreach overmap marker', async (t) => {
  await t.test('the south town wall footprint is a compact ~10x10 cluster', () => {
    const tiles = southWallTiles();
    assert.ok(tiles.length > 0, 'town marker walls present in the south');
    const xs = tiles.map(([x]) => x);
    const ys = tiles.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs) + 1;
    const height = Math.max(...ys) - Math.min(...ys) + 1;
    assert.ok(width <= 10, `marker width ${width} must be <= 10 (was ~28)`);
    assert.ok(height <= 10, `marker height ${height} must be <= 10 (was ~29)`);
  });

  await t.test('the oversized road loop around the old enclosure is gone', () => {
    // The pre-LIV-70 layout wrapped the town with PATH arms at x30 / x66 from
    // y52 to y87. Those loop arms must no longer be paved streets.
    for (let y = 52; y <= 87; y++) {
      assert.notEqual(composedIsland.tiles[y][30], PATH, `(30,${y}) is not a loop arm`);
      assert.notEqual(composedIsland.tiles[y][66], PATH, `(66,${y}) is not a loop arm`);
    }
  });

  await t.test('the to_town portal is the marker south gate and the round trip is coherent', () => {
    const toTown = island.portals.find((p) => p.id === 'to_town');
    const maxY = Math.max(...southWallTiles().map(([, y]) => y));
    assert.equal(toTown.y, maxY, 'portal sits on the marker south edge');
    assert.equal(toTown.target.sceneId, DEFAULT_TOWN_ID);
    const townExit = town.portals.find((p) => p.id === 'to_island');
    assert.equal(townExit.target.sceneId, DEFAULT_ISLAND_ID);
    assert.deepEqual(
      townExit.target.spawn,
      { x: island.spawn.x, y: island.spawn.y },
      'town exit returns the player to the island spawn'
    );
  });

  await t.test('no soft-locks after the shrink', () => {
    const report = sceneAccessReport('island', island);
    assert.equal(report.spawnReachable, true);
    assert.equal(report.townReachable, true, 'spawn reaches the to_town portal');
    assert.equal(report.towerReachable, true, 'spawn reaches the Spire entrance');
  });

  await t.test('the interior Havenreach town scene is unchanged', () => {
    assert.equal(town.width, 24);
    assert.equal(town.height, 24);
    assert.equal(town.portals.find((p) => p.id === 'to_island').y, 23, 'town keeps its south gate');
  });
});
