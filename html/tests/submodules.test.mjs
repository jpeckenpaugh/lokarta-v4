import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { LightingSystem } from '../engine/lighting-system.js';
import { ProgressionSystem } from '../engine/progression-system.js';
import { CombatSystem } from '../engine/combat-system.js';
import { EntityAI } from '../engine/entity-ai.js';
import { InventorySystem } from '../engine/inventory-system.js';
import { EconomySystem } from '../engine/economy-system.js';
import { ChestSystem } from '../engine/chest-system.js';
import { FateGrantSystem } from '../engine/fate-grant-system.js';
import { GestureEngine } from '../engine/gesture-engine.js';
import { ECONOMY_CATALOG } from '../data/index.js';

test('Modular Engine Submodules', async (t) => {
  await t.test('verifies config.js exports', () => {
    assert.equal(CONFIG.MAP_WIDTH, 40);
    assert.equal(TILE_TYPES.WALL, 1);
    const p = createPlayer('magician');
    assert.equal(p.vocation, 'magician');
  });

  await t.test('verifies GridMap submodule', () => {
    const map = new GridMap();
    assert.equal(map.width, 40);
    assert.equal(map.isWalkable(0, 0), false);
  });

  await t.test('verifies LightingSystem submodule', () => {
    const p = createPlayer('magician');
    const radius = LightingSystem.computePlayerRadius(p);
    assert.equal(radius, CONFIG.BASE_LIGHT_RADIUS);
  });

  await t.test('verifies ProgressionSystem submodule', () => {
    assert.equal(ProgressionSystem.getXpForLevel(1), 100);
  });

  await t.test('verifies CombatSystem submodule', () => {
    assert.equal(CONFIG.NATIVE_CLASS_MULTIPLIER, undefined, 'NATIVE_CLASS_MULTIPLIER must be removed');
    const p = createPlayer('magician');
    p.x = 2;
    p.y = 2;
    const grid = new GridMap(10, 10);
    const target = { id: 'm1', name: 'Rat', type: 'giant_rat', x: 4, y: 2, hp: 100, max_hp: 100 };
    const res = CombatSystem.executeWandSpark(p, target, grid, { damage: 100, manaCost: 1 });
    assert.equal(res.success, true);
    assert.equal(res.damageDealt, 100); // Base 1.0x skillBoosts - no legacy class multiplier
  });

  await t.test('verifies EntityAI submodule', () => {
    const facing = EntityAI.getFacing(2, 2, 3, 2);
    assert.equal(facing, 'right');
  });

  await t.test('verifies InventorySystem submodule', () => {
    assert.equal(InventorySystem.getMaxStack('arrows'), 99);
  });

  await t.test('verifies ChestSystem submodule', () => {
    const chest = { id: 'c1', room: 1, x: 3, y: 3, tier: 'copper', opened: false };
    assert.equal(ChestSystem.findChestAt([chest], 3, 3), chest);
    assert.equal(ChestSystem.isChestOpenable(chest), true);
    const res = ChestSystem.openChest(chest, { vocation: 'fighter' });
    assert.equal(res.success, true);
    assert.equal(chest.opened, true);
    assert.equal(ChestSystem.isChestOpenable(chest), false);
  });

  await t.test('verifies FateGrantSystem submodule', () => {
    const offer = FateGrantSystem.generateDraftOffer('magician', 1);
    assert.equal(offer.cards.length, 5);
  });

  await t.test('verifies GestureEngine submodule', () => {
    assert.equal(GestureEngine.keyToSlotIndex('1'), 0);
    assert.equal(GestureEngine.keyToSlotIndex('4'), 3);
    assert.equal(GestureEngine.keyToSlotIndex('5'), null);
  });

  await t.test('consumes potions via catalog effect dispatch (items.json)', () => {
    const player = createPlayer('magician');
    player.hp = 50;
    player.max_hp = 100;

    let removals = 0;
    const res = InventorySystem.consumeItem(
      player,
      { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', stat_bonus: 30 },
      () => { removals++; }
    );
    assert.equal(res.success, true);
    assert.equal(player.hp, 80);
    assert.equal(removals, 1);

    // Greater-potion loot keeps its own amount via stat_bonus override.
    player.hp = 10;
    const greater = InventorySystem.consumeItem(
      player,
      { item_id: 'health_potion', name: 'Greater Health Potion', stat_bonus: 50 },
      () => {}
    );
    assert.equal(greater.success, true);
    assert.equal(player.hp, 60);

    // Mana route resolves through the same dispatch table.
    player.mana = 0;
    player.max_mana = 40;
    const mpRes = InventorySystem.consumeItem(
      player,
      { item_id: 'mana_potion', name: 'Mana Potion', stat_bonus: 40 },
      () => {}
    );
    assert.equal(mpRes.success, true);
    assert.equal(player.mana, 40);

    // Full resource is rejected and the remove callback never fires.
    player.hp = player.max_hp;
    const full = InventorySystem.consumeItem(
      player,
      { item_id: 'health_potion', name: 'Health Potion' },
      () => { throw new Error('must not remove a potion at full HP'); }
    );
    assert.equal(full.success, false);

    // Unknown consumable has no registered effect handler.
    assert.equal(
      InventorySystem.consumeItem(player, { item_id: 'mystery', name: 'Mystery' }, () => {}).success,
      false
    );
  });

  await t.test('shop tunables come from economy.json (no JS DEFAULTS copy)', () => {
    const shop = EconomySystem.shopConfig();
    assert.equal(shop.sellRatePct, ECONOMY_CATALOG.shop.sellRatePct);
    assert.equal(shop.upgradeBaseCost, ECONOMY_CATALOG.shop.upgradeBaseCost);
    assert.equal(shop.upgradeCostPerRank, ECONOMY_CATALOG.shop.upgradeCostPerRank);
    assert.equal(shop.maxRank, ECONOMY_CATALOG.shop.maxRank);
  });

  await t.test('dispatches unknown aggroed monsters through the chase fallback', () => {
    const grid = new GridMap(10, 10);
    const player = createPlayer('magician');
    player.x = 2;
    player.y = 2;
    const monster = {
      id: 'x1',
      type: 'not_in_catalog',
      name: 'Mystery',
      x: 3,
      y: 2,
      hp: 10,
      max_hp: 10,
      isAggroed: true,
      attackCooldown: 0,
      moveCooldown: 0,
    };
    const results = EntityAI.updateMonsters([monster], player, grid, 0.016);
    assert.equal(results.length, 1, 'adjacent aggroed monster attacks via the chase handler');
  });
});
