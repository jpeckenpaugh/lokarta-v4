/**
 * LIV-76 — Party stays together when entering the tower from town.
 *
 * Board T2 feedback: teleporting town -> tower could strand a party member in a
 * different room, because re-entering a floor the run had already visited left
 * `floorChanged` false (`tower#floor` was unchanged) so the whole party was not
 * re-clustered around the active member's arrival tile.
 *
 * The engine now accepts an explicit `transportAll` flag on `applyDungeonData`
 * for genuine teleports (town return spot, tower select, portal entry, floor
 * transition), and `findPartySpot` floods through walkable ground so the group
 * hugs the active member inside one connected room.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GridMap } from '../engine/grid-map.js';
import { createPartyMember, createPartyPlayer } from '../engine/party.js';
import { generateFloor } from '../services/floor-generator.js';
import { LokartaApp } from '../app/app-controller.js';
import { floorControllerMethods } from '../app/floor-controller.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
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

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** First non-wall tile on `floor` at least `minDist` (manhattan) from (cx, cy). */
function farWalkableTile(floor, cx, cy, minDist = 6) {
  for (let y = 0; y < floor.tiles.length; y++) {
    for (let x = 0; x < floor.tiles[y].length; x++) {
      if (Math.abs(x - cx) + Math.abs(y - cy) < minDist) continue;
      if (floor.tiles[y][x] !== 1) return { x, y };
    }
  }
  return null;
}

/** True when `b` is reachable from `a` over walkable tiles (same connected room). */
function sameWalkableComponent(grid, a, b) {
  if (!grid.isWalkable(a.x, a.y) || !grid.isWalkable(b.x, b.y)) return false;
  const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const seen = new Set([`${a.x},${a.y}`]);
  const queue = [[a.x, a.y]];
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head];
    if (x === b.x && y === b.y) return true;
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (grid.isWalkable(nx, ny)) queue.push([nx, ny]);
    }
  }
  return false;
}

/** Every member is adjacent (Chebyshev <= 1) to the active member or to another. */
function assertPartyCluster(rounds, active) {
  const placed = [];
  for (const member of rounds) {
    const near = [active, ...placed].some((other) => chebyshev(other, member) <= 1);
    assert.ok(
      near,
      `member at (${member.x},${member.y}) must hug the party, not scatter`
    );
    placed.push(member);
  }
}

test('LIV-76: re-entering a visited floor from town clusters the whole party', () => {
  const towerId = firstTowerId();
  const player = createPartyPlayer('magician');
  player.towerId = towerId;
  player.current_floor = 2;

  const allies = [createPartyMember('archer'), createPartyMember('paladin')];
  player.party.push(...allies);

  const floor = generateFloor(2, null, towerId, 3);
  player.x = floor.spawn_coords.x;
  player.y = floor.spawn_coords.y;

  const app = makeApp(player);
  // First load records the floor identity and lays the party out together.
  app.applyDungeonData(floor);

  // Simulate leaving to town and coming back: the worker restores the active
  // member to the floor entrance, while the allies carry stale coordinates that
  // happen to be walkable on this same floor.
  const stale = allies.map(() => farWalkableTile(floor, player.x, player.y, 8));
  assert.ok(stale.every(Boolean), 'the seed floor has far walkable tiles for the test');
  allies.forEach((member, i) => {
    member.x = stale[i].x;
    member.y = stale[i].y;
  });

  // Town -> tower return spot re-entry: same `tower#floor`, so the caller must
  // force the cluster explicitly.
  app.applyDungeonData(floor, { transportAll: true });

  for (const member of allies) {
    assert.equal(app.gridMap.isWalkable(member.x, member.y), true, 'ally lands on a walkable tile');
    assert.ok(chebyshev(member, player) <= 2, 'ally is transported beside the active member');
    assert.ok(
      sameWalkableComponent(app.gridMap, player, member),
      'ally shares the active member\'s room'
    );
  }
  assertPartyCluster(allies, player);
});

test('LIV-76: a plain same-floor reload does not shuffle a valid party', () => {
  const towerId = firstTowerId();
  const player = createPartyPlayer('magician');
  player.towerId = towerId;
  player.current_floor = 1;

  const allies = [createPartyMember('archer'), createPartyMember('paladin')];
  player.party.push(...allies);

  const floor = generateFloor(1, null, towerId, 3);
  player.x = floor.spawn_coords.x;
  player.y = floor.spawn_coords.y;

  const app = makeApp(player);
  app.applyDungeonData(floor);

  // A far-but-walkable coordinate stands in for a load/reload where the party
  // is already placed; without the teleport flag it must be preserved.
  const stale = farWalkableTile(floor, player.x, player.y, 8);
  assert.ok(stale, 'the seed floor has a far walkable tile for the test');
  allies[0].x = stale.x;
  allies[0].y = stale.y;
  const kept = { x: allies[0].x, y: allies[0].y };

  app.applyDungeonData(floor);

  assert.deepEqual(
    { x: allies[0].x, y: allies[0].y },
    kept,
    'a same-floor reload keeps the ally exactly where it stood'
  );
});

test('LIV-76: a genuine floor-key change still transports the party', () => {
  const towerId = firstTowerId();
  const player = createPartyPlayer('magician');
  player.towerId = towerId;
  player.current_floor = 1;

  const ally = createPartyMember('archer');
  player.party.push(ally);

  const floor1 = generateFloor(1, null, towerId, 2);
  player.x = floor1.spawn_coords.x;
  player.y = floor1.spawn_coords.y;
  const app = makeApp(player);
  app.applyDungeonData(floor1);

  const floor2 = generateFloor(2, null, towerId, 2);
  const stale = farWalkableTile(floor2, floor2.spawn_coords.x, floor2.spawn_coords.y, 8);
  assert.ok(stale, 'the seed floor has a far walkable tile for the test');
  ally.x = stale.x;
  ally.y = stale.y;

  player.current_floor = 2;
  player.x = floor2.spawn_coords.x;
  player.y = floor2.spawn_coords.y;
  app.applyDungeonData(floor2, { reviveDowned: true, transportAll: true });

  assert.ok(!(ally.x === stale.x && ally.y === stale.y), 'the ally is not left on the old map');
  assert.ok(sameWalkableComponent(app.gridMap, player, ally), 'the ally shares the active member\'s room');
});

test('LIV-76: findPartySpot yields contiguous spots inside one room', () => {
  const matrix = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  const grid = new GridMap();
  grid.loadFromMatrix(matrix);
  const app = { gridMap: grid };

  const active = { x: 3, y: 2 };
  const occupied = new Set(['3,2']);
  const placed = [];
  for (let i = 0; i < 4; i++) {
    const spot = floorControllerMethods.findPartySpot.call(app, active.x, active.y, occupied);
    assert.ok(spot, 'a free tile exists for every member');
    assert.equal(grid.isWalkable(spot.x, spot.y), true, 'spot is walkable');
    assert.equal(occupied.has(`${spot.x},${spot.y}`), false, 'spot is unclaimed');
    assert.ok(
      [active, ...placed].some((other) => chebyshev(other, spot) <= 1),
      'each spot hugs the growing group'
    );
    occupied.add(`${spot.x},${spot.y}`);
    placed.push(spot);
  }

  // The flood never crosses a wall: every spot is in the active tile's room.
  const walled = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 1, 0, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  const wallGrid = new GridMap();
  wallGrid.loadFromMatrix(walled);
  const wallApp = { gridMap: wallGrid };
  const wallActive = { x: 1, y: 1 };
  const wallSpot = floorControllerMethods.findPartySpot.call(
    wallApp,
    wallActive.x,
    wallActive.y,
    new Set(['1,1'])
  );
  assert.ok(wallSpot, 'a reachable tile exists in the active room');
  assert.equal(
    sameWalkableComponent(wallGrid, wallActive, wallSpot),
    true,
    'the spot is in the active member\'s room, never across a wall'
  );
});

test('LIV-76: returnToTower forces the party teleport on re-entry', async () => {
  const player = createPartyPlayer('magician');
  player.slotIndex = 1;
  const seen = {};
  const app = Object.assign({}, floorControllerMethods, {
    player,
    returnSpot: { towerId: firstTowerId(), floor: 3, x: 3, y: 4 },
    isInGameplay: true,
    scene: {},
    npcs: [],
    gridMap: new GridMap(),
    ambientLights: [],
    monsters: [],
    updateHUD: () => {},
    persistSave: () => Promise.resolve(),
    enterTower: () => {},
    applyDungeonData: (floor, opts) => { seen.opts = opts; },
    gameClient: {
      enterTowerFloor: async () => ({
        player: { ...player, current_floor: 3, towerId: firstTowerId() },
        floor: { floor_number: 3, tower_id: firstTowerId(), tiles: [[0]] },
      }),
    },
  });

  assert.equal(await app.returnToTower(), true);
  assert.equal(seen.opts.transportAll, true, 'town -> tower re-entry forces the cluster');
});

test('LIV-76: the tower portal selects and enters with the cluster forced', async () => {
  const towers = listTowerDefinitionsByOrder();
  const player = createPartyPlayer('magician');
  player.slotIndex = 1;
  player.towerProgress = { completedTowerIds: [], unlockedTowerIds: [towers[0].id] };
  const seen = {};
  const app = Object.assign({}, sceneControllerMethods, {
    player,
    scene: {},
    npcs: [],
    gridMap: new GridMap(),
    ambientLights: [],
    monsters: [],
    updateHUD: () => {},
    persistSave: () => Promise.resolve(),
    enterTower: () => {},
    applyDungeonData: (floor, opts) => { seen.opts = opts; },
    gameClient: {
      selectTower: async () => ({
        player,
        floor: { floor_number: 1, tower_id: towers[0].id, tiles: [[0]] },
      }),
    },
  });

  await app.enterTowerFromScene({ towerId: towers[0].id });
  assert.equal(seen.opts.transportAll, true, 'portal tower entry forces the cluster');
});
