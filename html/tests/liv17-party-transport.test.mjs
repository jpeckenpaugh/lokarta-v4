/**
 * LIV-17 FIX-2 — Party transport on tower/level transitions.
 *
 * Board T2 feedback: on a tower/level change a recruit was left behind at its
 * old map position. `applyDungeonData` now force-transports every non-active
 * party member onto a free tile around the active member's arrival tile whenever
 * the floor identity changes, instead of trusting stale coordinates that happen
 * to still be walkable on the new floor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GridMap } from '../engine/grid-map.js';
import { createPartyMember, createPartyPlayer } from '../engine/party.js';
import { generateFloor } from '../services/floor-generator.js';
import { LokartaApp } from '../app/app-controller.js';
import { firstTowerId, listTowerDefinitionsByOrder } from '../data/index.js';

function makeApp(player) {
  const app = Object.create(LokartaApp.prototype);
  app.player = player;
  app.gridMap = new GridMap();
  app.chests = [];
  app.props = [];
  app.springs = [];
  app.monsters = [];
  app.ambientLights = [];
  app.stairHint = null;
  app.isPaused = false;
  app.isFloorCleared = false;
  return app;
}

/** First walkable tile on `floor` at least `minDist` (manhattan) from (cx, cy). */
function farWalkableTile(floor, cx, cy, minDist = 6) {
  for (let y = 0; y < floor.tiles.length; y++) {
    for (let x = 0; x < floor.tiles[y].length; x++) {
      if (Math.abs(x - cx) + Math.abs(y - cy) < minDist) continue;
      if (floor.tiles[y][x] !== 1) return { x, y };
    }
  }
  return null;
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

test('LIV-17: a level change transports every non-active party member', () => {
  const towerId = firstTowerId();
  const player = createPartyPlayer('magician');
  player.towerId = towerId;
  player.current_floor = 1;

  const recruit = createPartyMember('archer');
  player.party.push(recruit);

  const floor1 = generateFloor(1, null, towerId, 2);
  player.x = floor1.spawn_coords.x;
  player.y = floor1.spawn_coords.y;

  const app = makeApp(player);
  app.applyDungeonData(floor1);

  // The recruit survived the first layout and is next to the active member.
  assert.ok(chebyshev(recruit, player) <= 2, 'the recruit starts in formation');

  // Descend a level with a stale-but-walkable position from the old map.
  const floor2 = generateFloor(2, null, towerId, 2);
  const stale = farWalkableTile(floor2, floor2.spawn_coords.x, floor2.spawn_coords.y, 8);
  assert.ok(stale, 'the seed floor has a far walkable tile for the test');
  recruit.x = stale.x;
  recruit.y = stale.y;

  player.current_floor = 2;
  player.x = floor2.spawn_coords.x;
  player.y = floor2.spawn_coords.y;
  app.applyDungeonData(floor2);

  assert.ok(
    !(recruit.x === stale.x && recruit.y === stale.y),
    'the recruit must not be left at its old-map coordinates'
  );
  assert.ok(chebyshev(recruit, player) <= 4, 'the recruit is transported beside the active member');
  assert.equal(app.gridMap.isWalkable(recruit.x, recruit.y), true, 'the transported tile is walkable');
});

test('LIV-17: a tower change transports every non-active party member', () => {
  const towers = listTowerDefinitionsByOrder();
  assert.ok(towers.length >= 2, 'the campaign authors multiple towers');

  const player = createPartyPlayer('magician');
  player.towerId = towers[0].id;
  player.current_floor = 1;

  const recruit = createPartyMember('archer');
  player.party.push(recruit);

  const firstFloor = generateFloor(1, null, towers[0].id, 2);
  player.x = firstFloor.spawn_coords.x;
  player.y = firstFloor.spawn_coords.y;
  const app = makeApp(player);
  app.applyDungeonData(firstFloor);

  // Move to the next tower with armed stale coordinates in the old tower.
  const nextFloor = generateFloor(1, null, towers[1].id, 2);
  const stale = farWalkableTile(nextFloor, nextFloor.spawn_coords.x, nextFloor.spawn_coords.y, 8);
  recruit.x = stale.x;
  recruit.y = stale.y;

  player.towerId = towers[1].id;
  player.current_floor = 1;
  player.x = nextFloor.spawn_coords.x;
  player.y = nextFloor.spawn_coords.y;
  app.applyDungeonData(nextFloor);

  assert.ok(
    !(recruit.x === stale.x && recruit.y === stale.y),
    'the recruit must not be left in the previous tower'
  );
  assert.ok(chebyshev(recruit, player) <= 4, 'the recruit is transported beside the active member');
  assert.equal(app.gridMap.isWalkable(recruit.x, recruit.y), true, 'the transported tile is walkable');
});

test('LIV-17: re-applying the same floor keeps an already-valid formation', () => {
  const towerId = firstTowerId();
  const player = createPartyPlayer('magician');
  player.towerId = towerId;
  player.current_floor = 1;

  const recruit = createPartyMember('archer');
  player.party.push(recruit);

  const floor = generateFloor(1, null, towerId, 2);
  player.x = floor.spawn_coords.x;
  player.y = floor.spawn_coords.y;
  const app = makeApp(player);
  app.applyDungeonData(floor);

  const placed = { x: recruit.x, y: recruit.y };
  app.applyDungeonData(floor);
  assert.deepEqual(
    { x: recruit.x, y: recruit.y },
    placed,
    'a same-floor re-apply does not shuffle a valid ally'
  );
});

test('LIV-17: a fallen non-active member is revived and transported', () => {
  const towerId = firstTowerId();
  const player = createPartyPlayer('magician');
  player.towerId = towerId;
  player.current_floor = 1;

  const fallen = createPartyMember('paladin', { x: 0, y: 0, hp: 0, mana: 0 });
  player.party.push(fallen);

  const floor1 = generateFloor(1, null, towerId, 2);
  player.x = floor1.spawn_coords.x;
  player.y = floor1.spawn_coords.y;
  const app = makeApp(player);
  app.applyDungeonData(floor1);

  const floor2 = generateFloor(2, null, towerId, 2);
  player.current_floor = 2;
  player.x = floor2.spawn_coords.x;
  player.y = floor2.spawn_coords.y;
  app.applyDungeonData(floor2);

  assert.equal(fallen.hp, fallen.max_hp, 'the fallen ally revives between levels');
  assert.equal(fallen.mana, fallen.max_mana, 'the fallen ally refills mana');
  assert.ok(chebyshev(fallen, player) <= 4, 'the revived ally is transported beside the active member');
});
