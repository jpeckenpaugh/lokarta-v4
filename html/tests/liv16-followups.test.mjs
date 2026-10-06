/**
 * Lokarta: Follow-up regression coverage.
 *
 * Pins the second round of user-testing fixes:
 *   1. Descending also lands in a monster-free room (the stair room you step
 *      down into, in addition to the entry room you enter).
 *   2. Death descends one level (never below 1) and restores full HP/mana.
 *   3. Continuing a save starts at the level's start position.
 *   4. Room doorways are a single tile wide.
 *   5. Picked-up/just-granted gear auto-equips into an empty paperdoll slot.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GridMap,
  TILE_TYPES,
  InventorySystem,
  createPlayer,
} from '../engine/index.js';
import {
  generateFloor,
  getLevelSpec,
  TOWER_LEVEL_COUNT,
} from '../services/floor-generator.js';
import {
  descendOnDeath,
  applyFullRestore,
  clampTowerFloor,
} from '../services/save-slots.js';
import { DUNGEONS_CATALOG, ITEMS_CATALOG, TOWER_LEVELS_CATALOG } from '../data/index.js';

const LEVELS = [1, 2, 3, 4, 5];

describe('Descending lands in a monster-free room', () => {
  it('the stair room (arrival from above) holds no monsters on every level', () => {
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const floor = generateFloor(level);
      const inStairRoom = floor.monsters.filter(
        m => m.room === spec.stairRoom && !m.isBoss && !m.isGuard
      );
      assert.equal(inStairRoom.length, 0, `L${level} stair room ${spec.stairRoom} must be empty`);
      assert.ok(
        !floor.monsters.some(m => m.room === spec.stairRoom && m.holdsKey),
        `L${level} stair room must not hold a key`
      );
    }
  });

  it('both arrival rooms are distinct and never key rooms', () => {
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      const keyRooms = Object.values(spec.keyRooms);
      for (const room of [spec.entryRoom, spec.stairRoom]) {
        assert.ok(!keyRooms.includes(room), `L${level} arrival room ${room} must not be a key room`);
      }
    }
  });
});

describe('Death descends one level and full-restores', () => {
  it('descendOnDeath drops exactly one level and never below 1', () => {
    assert.equal(descendOnDeath({ current_floor: 5 }), 4);
    assert.equal(descendOnDeath({ current_floor: 3 }), 2);
    assert.equal(descendOnDeath({ current_floor: 2 }), 1);
    assert.equal(descendOnDeath({ current_floor: 1 }), 1, 'cannot go below the first level');
    // Out-of-range/missing floors clamp onto the tower first.
    assert.equal(descendOnDeath({ current_floor: 99 }), 4);
    assert.equal(descendOnDeath({}), 1);
    assert.equal(descendOnDeath(null), 1);
  });

  it('applyFullRestore sets hp/mana to their maxima', () => {
    const player = { hp: 0, max_hp: 140, mana: 2, max_mana: 30 };
    applyFullRestore(player);
    assert.equal(player.hp, 140);
    assert.equal(player.mana, 30);
    // Idempotent and safe on partial players.
    applyFullRestore(player);
    assert.equal(player.hp, 140);
    assert.doesNotThrow(() => applyFullRestore(null));
  });

  it('clampTowerFloor keeps the descent within the tower', () => {
    assert.equal(clampTowerFloor(0), 1);
    assert.equal(clampTowerFloor(6), TOWER_LEVEL_COUNT);
  });
});

describe('Doorways are a single tile wide', () => {
  it('every room-graph edge exposes exactly one doorway tile', () => {
    const spec = DUNGEONS_CATALOG.standard_40x40;
    for (const [edgeId, edge] of Object.entries(spec.edges)) {
      assert.equal(edge.tiles.length, 1, `${edgeId} must be a 1-tile doorway`);
    }
  });

  it('each generated level carves single-tile door/gate thresholds', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      const spec = getLevelSpec(level);
      // Non-gate open edges are DOOR, gate edges are GATED_DOOR: each is one tile.
      for (const edgeId of spec.openEdges) {
        const tile = DUNGEONS_CATALOG.standard_40x40.edges[edgeId].tiles[0];
        const [x, y] = tile;
        assert.ok([TILE_TYPES.DOOR, TILE_TYPES.GATED_DOOR].includes(floor.tiles[y][x]), `L${level} ${edgeId} threshold`);
      }
    }
  });
});

describe('Pickup banking (equipment banks into the backpack)', () => {
  function floorWithItemAt(itemId, qty = 1) {
    const grid = new GridMap(5, 5);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
    const def = ITEMS_CATALOG[itemId];
    grid.addItem(2, 2, { ...def, item_id: itemId, quantity: qty, x: 2, y: 2 });
    return grid;
  }

  it('picked-up equipment banks into the backpack, never the paperdoll', () => {
    const player = createPlayer('magician');
    player.x = 2; player.y = 2;
    const grid = floorWithItemAt('astral_scepter');

    const res = InventorySystem.pickUpItem(player, grid);
    assert.equal(res.success, true);
    assert.equal(player.paperdoll.main_hand, null, 'pickup does not auto-equip');
    assert.ok(player.backpack.some(s => s && s.item_id === 'astral_scepter'), 'banked into the backpack');
    assert.equal(grid.getItems(2, 2).length, 0, 'item removed from the ground');
  });

  it('picked-up consumables auto-fill an empty active slot (1-4)', () => {
    const player = createPlayer('magician');
    player.x = 2; player.y = 2;
    const grid = floorWithItemAt('health_potion', 2);

    InventorySystem.pickUpItem(player, grid);
    assert.equal(player.action_bar[0].item_id, 'health_potion', 'consumable fills active slot 1');
    assert.equal(player.action_bar[0].quantity, 2);
  });

  it('wrong-vocation equipment also banks into the backpack (manual equip later)', () => {
    const player = createPlayer('magician');
    player.x = 2; player.y = 2;
    const grid = floorWithItemAt('composite_bow');

    InventorySystem.pickUpItem(player, grid);
    assert.equal(player.paperdoll.main_hand, null, 'wrong-vocation item must not auto-equip');
    assert.ok(player.backpack.some(s => s && s.item_id === 'composite_bow'), 'stored for manual equip');
  });

  it('addItem (chest loot / rewards) still auto-equips gear into an empty slot', () => {
    const player = createPlayer('archer');
    const res = InventorySystem.addItem(player, { ...ITEMS_CATALOG.hunter_leathers, item_id: 'hunter_leathers' });
    assert.equal(res.success, true);
    assert.equal(player.paperdoll.armor?.item_id, 'hunter_leathers');
  });

  it('a mouse swap banks a backpack item into any keyed slot', () => {
    const player = createPlayer('magician');
    player.backpack[0] = { ...ITEMS_CATALOG.astral_scepter, item_id: 'astral_scepter', quantity: 1 };
    InventorySystem.swapKeyedItem(player, 'backpack:0', 'KeyQ');
    assert.equal(player.paperdoll.main_hand?.item_id, 'astral_scepter', 'q slot now holds the banked staff');

    // Swap it back out to the backpack via the keyed-slot source.
    InventorySystem.swapKeyedItem(player, 'KeyQ', 'backpack:0');
    assert.equal(player.paperdoll.main_hand, null);
    assert.ok(player.backpack.some(s => s && s.item_id === 'astral_scepter'));
  });

  it('consumables and keys are never auto-equipped', () => {
    const player = createPlayer('fighter');
    InventorySystem.addItem(player, { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 1 });
    InventorySystem.addItem(player, { item_id: 'key_copper', name: 'Copper Key', type: 'key', quantity: 1 });
    assert.ok(!player.paperdoll.main_hand && !player.paperdoll.off_hand && !player.paperdoll.armor && !player.paperdoll.relic);
  });
});
