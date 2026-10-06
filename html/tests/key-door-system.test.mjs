/**
 * Lokarta: "Ascend the Tower" - E3 Key & Gated-Door runtime tests
 *
 * Covers the runtime half of the key-holder contract: a key holder drops the
 * catalog key for its tier, holding that key unlocks the matching GATED_DOOR,
 * and closed gates physically block movement — so progression only advances
 * after the correct holder is defeated. Uses the real generated floors so the
 * tile-level oracle matches the authored room-graph progression.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GridMap, DoorSystem, TILE_TYPES, createPlayer } from '../engine/index.js';
import { generateFloor } from '../services/floor-generator.js';
import { DOORS_CATALOG } from '../data/index.js';

const LEVELS = [1, 2, 3, 4, 5];

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

describe('E3: key holders, key grants, and gated doors', () => {
  it('resolves the catalog key for a key-holding monster by tier', () => {
    for (const [tier, door] of Object.entries(DOORS_CATALOG)) {
      const drop = DoorSystem.keyDropForMonster({ holdsKey: tier });
      assert.ok(drop, `${tier} holder must drop a key`);
      assert.equal(drop.item_id, door.keyItemId);
      assert.equal(drop.keyTier, tier);
      assert.equal(drop.type, 'key');
      assert.equal(drop.quantity, 1);
    }
  });

  it('returns no key drop for ordinary monsters or unknown tiers', () => {
    assert.equal(DoorSystem.keyDropForMonster({ holdsKey: null }), null);
    assert.equal(DoorSystem.keyDropForMonster({}), null);
    assert.equal(DoorSystem.keyDropForMonster(null), null);
    assert.equal(DoorSystem.keyDropForMonster({ holdsKey: 'mithril' }), null);
  });

  it('closed gated doors block movement; opening the tier makes them walkable', () => {
    const grid = new GridMap(4, 1);
    grid.loadFromMatrix([[TILE_TYPES.FLOOR, TILE_TYPES.GATED_DOOR, TILE_TYPES.DOOR, TILE_TYPES.FLOOR]]);
    const gate = grid.getTile(1, 0);
    gate.gateTier = 'copper';

    assert.equal(grid.isWalkable(1, 0), false, 'locked gate blocks');
    assert.equal(grid.isWalkable(2, 0), true, 'open cosmetic door still walkable');

    assert.equal(DoorSystem.openTierGates(grid, 'copper'), 1);
    assert.equal(gate.gateOpen, true);
    assert.equal(grid.isWalkable(1, 0), true, 'unlocked gate is walkable');
    // Idempotent: a second unlock opens nothing new.
    assert.equal(DoorSystem.openTierGates(grid, 'copper'), 0);
  });

  it('grants keys per level on the character, never into the inventory', () => {
    const player = createPlayer('fighter');
    const drop = DoorSystem.keyDropForMonster({ holdsKey: 'silver' });

    assert.equal(DoorSystem.hasKey(player, 'silver', 3), false);
    assert.equal(DoorSystem.grantKey(player, 3, 'silver'), true);
    assert.equal(DoorSystem.hasKey(player, 'silver', 3), true);
    assert.equal(DoorSystem.hasKey(player, 'copper', 3), false);
    assert.deepEqual(DoorSystem.unlockedTiers(player, 3), ['silver']);
    // Idempotent: re-granting reports no new key.
    assert.equal(DoorSystem.grantKey(player, 3, 'silver'), false);

    // Keys are per-level: level 4 does not inherit level 3's key.
    assert.equal(DoorSystem.hasKey(player, 'silver', 4), false);
    assert.deepEqual(DoorSystem.unlockedTiers(player, 4), []);

    // The grant is a character field, not an inventory stack.
    assert.ok(!player.action_bar.some(s => s && s.item_id === drop.item_id));
    assert.ok(!player.backpack.some(s => s && s.item_id === drop.item_id));
  });

  it('persists per-level keys across a floor round-trip (serialize/restore)', () => {
    const player = createPlayer('archer');
    DoorSystem.grantKey(player, 1, 'copper');
    DoorSystem.grantKey(player, 1, 'silver');
    DoorSystem.grantKey(player, 2, 'copper');

    // A save/load is a JSON round-trip of the player object.
    const restored = JSON.parse(JSON.stringify(player));
    assert.equal(DoorSystem.hasKey(restored, 'copper', 1), true);
    assert.equal(DoorSystem.hasKey(restored, 'silver', 1), true);
    assert.equal(DoorSystem.hasKey(restored, 'gold', 1), false);
    assert.equal(DoorSystem.hasKey(restored, 'copper', 2), true);
    assert.equal(DoorSystem.hasKey(restored, 'silver', 2), false);
  });

  it('syncPlayerGates reopens gates for keys already earned on that level (no soft-lock on re-entry)', () => {
    const player = createPlayer('magician');
    DoorSystem.grantKey(player, 2, 'gold');

    const grid = new GridMap(4, 1);
    grid.loadFromMatrix([[TILE_TYPES.FLOOR, TILE_TYPES.GATED_DOOR, TILE_TYPES.FLOOR, TILE_TYPES.FLOOR]]);
    grid.getTile(1, 0).gateTier = 'gold';

    // A key earned on another level does not open this level's gate.
    assert.equal(DoorSystem.syncPlayerGates(grid, player, 3), 0);
    assert.equal(grid.isWalkable(1, 0), false);

    assert.equal(DoorSystem.syncPlayerGates(grid, player, 2), 1);
    assert.equal(grid.isWalkable(1, 0), true);
  });

  it('each level only advances past a gate after defeating that tier key holder', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      const grid = loadFloorGrid(floor);
      const spawn = floor.spawn_coords;

      const holderTile = tier => {
        const monster = floor.monsters.find(m => m.holdsKey === tier);
        assert.ok(monster, `L${level} missing ${tier} key holder`);
        return `${monster.x},${monster.y}`;
      };
      const objective = floor.stairs.find(s => s.dir !== 'up') || floor.stairs[0];
      const objectiveKey = `${objective.x},${objective.y}`;

      // No keys: only the copper holder is reachable; silver/gold/stair gated.
      let reach = reachableTiles(grid, spawn);
      assert.ok(reach.has(holderTile('copper')), `L${level} copper holder reachable with no keys`);
      assert.ok(!reach.has(holderTile('silver')), `L${level} silver holder gated`);
      assert.ok(!reach.has(holderTile('gold')), `L${level} gold holder gated`);
      assert.ok(!reach.has(objectiveKey), `L${level} objective stair gated`);

      // Defeat copper holder -> copper gate opens -> silver holder reachable.
      DoorSystem.openTierGates(grid, 'copper');
      reach = reachableTiles(grid, spawn);
      assert.ok(reach.has(holderTile('silver')), `L${level} silver holder reachable after copper`);
      assert.ok(!reach.has(holderTile('gold')), `L${level} gold still gated`);
      assert.ok(!reach.has(objectiveKey), `L${level} objective still gated`);

      // Defeat silver holder -> silver gate opens -> gold holder reachable.
      DoorSystem.openTierGates(grid, 'silver');
      reach = reachableTiles(grid, spawn);
      assert.ok(reach.has(holderTile('gold')), `L${level} gold holder reachable after silver`);
      assert.ok(!reach.has(objectiveKey), `L${level} objective still gated after silver`);

      // Defeat gold holder -> gold gate opens -> objective advanced.
      DoorSystem.openTierGates(grid, 'gold');
      reach = reachableTiles(grid, spawn);
      assert.ok(reach.has(objectiveKey), `L${level} objective reachable after gold`);
    }
  });
});
