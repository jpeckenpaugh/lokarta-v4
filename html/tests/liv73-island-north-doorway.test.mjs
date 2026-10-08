import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ISLAND_ID,
  getIslandDefinition,
} from '../data/index.js';
import { composeSceneById, sceneAccessReport, tileCodeForName } from '../services/scene-composer.js';

// LIV-73: board feedback on the Dawnreach Isle view — the compact Havenreach
// overmap marker (x43-52, y76-85) carried two DOORWAY tiles, one in the north
// wall and one in the south wall. The true entrance is the SOUTH gate (the
// to_town portal at (48,85)); the north doorway was false and is removed so the
// north wall is solid. The south entrance and the round trip are unchanged.

const CODE = (name) => tileCodeForName(name);
const island = getIslandDefinition(DEFAULT_ISLAND_ID);
const composedIsland = composeSceneById(DEFAULT_ISLAND_ID);

const WALL = CODE('BUILDING_WALL');
const DOOR = CODE('DOORWAY');

test('LIV-73 Havenreach overmap marker has a single south doorway', async (t) => {
  await t.test('the false north doorway is gone (solid north wall)', () => {
    assert.equal(composedIsland.tiles[76][48], WALL, 'north wall (48,76) is solid');
    assert.notEqual(composedIsland.tiles[76][48], DOOR, 'no doorway in the north wall');
  });

  await t.test('the true south entrance is intact', () => {
    assert.equal(composedIsland.tiles[85][48], DOOR, 'south gate (48,85) is a doorway');
  });

  await t.test('the marker carries exactly one doorway', () => {
    const doors = [];
    for (let y = 76; y <= 85; y++) {
      for (let x = 43; x <= 52; x++) {
        if (composedIsland.tiles[y][x] === DOOR) doors.push([x, y]);
      }
    }
    assert.deepEqual(doors, [[48, 85]], 'only the south gate remains');
  });

  await t.test('the to_town portal stays coherent and there is no soft-lock', () => {
    const toTown = island.portals.find((p) => p.id === 'to_town');
    assert.equal(toTown.x, 48);
    assert.equal(toTown.y, 85, 'portal sits on the south doorway');
    const report = sceneAccessReport('island', island);
    assert.equal(report.spawnReachable, true);
    assert.equal(report.townReachable, true, 'spawn still reaches the to_town portal');
    assert.equal(report.towerReachable, true, 'spawn still reaches the Spire entrance');
  });
});
