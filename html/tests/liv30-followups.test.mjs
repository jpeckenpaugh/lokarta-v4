/**
 * Lokarta: "T2 follow-ups" regression coverage.
 *
 * Pins the four board fixes from the T2 rejection:
 *   1. Ground-dropped keys render at half size (UI icons unchanged).
 *   2. Dropped items never cover pre-existing ground items; they sort into the
 *      nearest empty walkable tile (adjacent, then expanding ring) and only
 *      stack when no free tile exists.
 *   3. Temple at full HP/MP shows "not in need" copy and disables its button.
 *   4. Health/mana potions stack onto an existing stack on acquire — including
 *      the Fate Grant potion-stash cards — and open a new cell only when every
 *      existing stack is already full (99).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GridMap,
  InventorySystem,
  FateGrantSystem,
  createPlayer,
} from '../engine/index.js';
import { ITEMS_CATALOG, UI_CATALOG } from '../data/index.js';
import { PROP_CATALOG } from '../assets/sprites/index.js';
import { SpriteRenderer } from '../app/sprite-renderer.js';
import { ModalManager } from '../app/modal-manager.js';
import { LokartaApp } from '../app/app-controller.js';

const FLAT_MATRIX = (w, h) => Array.from({ length: h }, () => Array.from({ length: w }, () => 0));

function makeFakeCtx() {
  const calls = [];
  const noop = name => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    canvas: { width: 256, height: 256 },
    drawImage: noop('drawImage'),
    fillRect: noop('fillRect'),
    fillText: noop('fillText'),
    save: noop('save'),
    restore: noop('restore'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    set fillStyle(v) {},
    get fillStyle() { return '#000'; },
    set imageSmoothingEnabled(v) {},
    get imageSmoothingEnabled() { return true; },
    set font(v) {},
    textAlign: 'left',
  };
}

function fillRectBounds(ctx) {
  const rects = ctx.calls.filter(c => c.name === 'fillRect').map(c => c.args);
  return {
    minX: Math.min(...rects.map(r => r[0])),
    maxRight: Math.max(...rects.map(r => r[0] + r[2])),
    minY: Math.min(...rects.map(r => r[1])),
    maxBottom: Math.max(...rects.map(r => r[1] + r[3])),
  };
}

function makeFakeTownEl() {
  return { innerHTML: '', hidden: false, onkeydown: null, querySelector: () => null };
}

function stackOf(list, itemId) {
  return list.filter(s => s && s.item_id === itemId);
}

describe('Ground keys render at half size', () => {
  it('declares groundScale 0.5 on every authored key prop', () => {
    for (const id of ['key_copper', 'key_silver', 'key_gold']) {
      assert.equal(PROP_CATALOG[id]?.groundScale, 0.5, `${id} must opt into half-size ground rendering`);
      assert.equal(PROP_CATALOG[id]?.native?.w, 32, `${id} keeps its 32px native icon`);
    }
  });

  it('draws a ground key within the top-left half of its 64px tile', () => {
    const keyCtx = makeFakeCtx();
    SpriteRenderer.drawItem(keyCtx, { type: 'key', item_id: 'key_copper', keyTier: 'copper', quantity: 1 }, 0, 0, 64);
    const key = fillRectBounds(keyCtx);
    assert.ok(key.maxRight <= 48, `key must not cross the tile midpoint (got ${key.maxRight})`);
    assert.ok(key.maxBottom <= 48, `key stays in the upper half (got ${key.maxBottom})`);
    assert.ok((key.maxRight - key.minX) <= 32, 'key pixel band is at most its 32px native width');

    const chestCtx = makeFakeCtx();
    SpriteRenderer.drawItem(chestCtx, { type: 'chest', item_id: 'chest_copper', chestTier: 'copper', quantity: 1 }, 0, 0, 64);
    const chest = fillRectBounds(chestCtx);
    assert.ok(chest.maxRight > key.maxRight, 'keys read smaller than full-tile ground props');
  });
});

describe('Drops never cover existing ground items', () => {
  it('reads its ring radius from the ui catalog', () => {
    assert.ok(UI_CATALOG.lootPlacement, 'lootPlacement presentation block required');
    assert.ok(UI_CATALOG.lootPlacement.dropRingRadius > 0);
    assert.equal(InventorySystem.dropRingRadius(), UI_CATALOG.lootPlacement.dropRingRadius);
  });

  it('finds the nearest empty walkable tile, preferring direct neighbours', () => {
    const grid = new GridMap();
    grid.loadFromMatrix(FLAT_MATRIX(8, 8));
    grid.addItem(3, 3, { item_id: 'gold', quantity: 5 });

    const first = InventorySystem.findFreeGroundTile(grid, 3, 3, new Set());
    assert.ok(first, 'a free tile exists');
    assert.equal(Math.abs(first.x - 3) + Math.abs(first.y - 3), 1, 'first free tile is adjacent, not diagonal');

    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      grid.addItem(3 + dx, 3 + dy, { item_id: 'gold', quantity: 1 });
    }
    const next = InventorySystem.findFreeGroundTile(grid, 3, 3, new Set());
    assert.ok(next, 'a free tile remains');
    assert.equal(Math.max(Math.abs(next.x - 3), Math.abs(next.y - 3)), 1, 'diagonal neighbouring tile used next');
  });

  it('never selects a tile that already holds an item, and respects reservations', () => {
    const grid = new GridMap();
    grid.loadFromMatrix(FLAT_MATRIX(3, 3));
    // Occupy the whole 3x3 block.
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) grid.addItem(x, y, { item_id: 'gold', quantity: 1 });
    }
    assert.equal(InventorySystem.findFreeGroundTile(grid, 1, 1, new Set()), null, 'fully occupied block returns null');

    // Clearing tiles plus a reservation must skip the reserved tile.
    const grid2 = new GridMap();
    grid2.loadFromMatrix(FLAT_MATRIX(3, 3));
    const reserved = new Set([1 * grid2.width + 0]); // (0,1)
    const free = InventorySystem.findFreeGroundTile(grid2, 0, 0, reserved);
    assert.ok(free);
    assert.notEqual(free.key, 1 * grid2.width + 0, 'reserved tiles are skipped');
  });

  it('moves a player drop off an occupied tile, leaving the existing item visible', () => {
    const grid = new GridMap();
    grid.loadFromMatrix(FLAT_MATRIX(8, 8));
    grid.addItem(3, 3, { item_id: 'gold', name: 'Gold', type: 'currency', pickupType: 'currency', quantity: 7 });

    const player = createPlayer('fighter');
    player.x = 3;
    player.y = 3;
    player.action_bar[0] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 1 };

    const res = InventorySystem.dropItem(player, 'action_bar', 0, grid);
    assert.equal(res.success, true);
    assert.equal(res.x !== 3 || res.y !== 3, true, 'drop lands off the occupied tile');
    assert.equal(grid.getItems(3, 3).length, 1, 'pre-existing item is untouched');
    assert.equal(grid.getItems(3, 3)[0].item_id, 'gold');
    assert.equal(grid.getItems(res.x, res.y).length, 1, 'new item occupies its own tile');
  });

  it('stacks in place only when no free tile exists in range', () => {
    const grid = new GridMap();
    grid.width = 1;
    grid.height = 1;
    grid.tiles = [[{ x: 0, y: 0, type: 0, items: [], isLit: true, lightIntensity: 0, gateTier: null, gateOpen: false, blocked: false }]];
    grid.addItem(0, 0, { item_id: 'gold', quantity: 1 });

    const player = createPlayer('fighter');
    player.x = 0;
    player.y = 0;
    player.action_bar[0] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 1 };

    const res = InventorySystem.dropItem(player, 'action_bar', 0, grid);
    assert.equal(res.success, true);
    assert.equal(res.x, 0);
    assert.equal(res.y, 0);
    assert.equal(grid.getItems(0, 0).length, 2, 'fallback stacks on the occupied tile');
  });

  it('scatters a monster drop around pre-existing loot without hiding it', () => {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPlayer('fighter');
    app.player.current_floor = 2;
    app.gridMap = new GridMap();
    app.gridMap.loadFromMatrix(FLAT_MATRIX(16, 16));
    // Pre-existing loot directly on and beside the death tile (10,10).
    app.gridMap.addItem(10, 10, { item_id: 'gold', name: 'Old Gold', quantity: 99 });
    app.gridMap.addItem(10, 9, { item_id: 'mana_potion', name: 'Old Mana', type: 'consumable', quantity: 1 });

    app.logCombat = () => {};
    app.addFloatingText = () => {};
    app.updateHUD = () => {};
    app.spawnDeathEffect = () => {};
    app.showFateGrantModal = () => {};
    app.persistSave = () => {};
    app.isFinalFloor = false;
    app.isFloorCleared = false;
    app.selectedMonsterId = null;
    app.projectiles = [];
    app.particles = [];
    app.monsters = [{
      id: 'rat_1', name: 'Giant Rat', type: 'giant_rat',
      x: 10, y: 10, hp: 1, max_hp: 18, isBoss: false, holdsKey: 'copper',
    }];

    app.handleCombatResult({ success: true, defeatedMonsterId: 'rat_1', damageDealt: 100 }, 10, 10);

    assert.equal(app.gridMap.getItems(10, 10).length, 1, 'death tile keeps only its pre-existing item');
    assert.equal(app.gridMap.getItems(10, 10)[0].item_id, 'gold');
    assert.equal(app.gridMap.getItems(10, 9).length, 1, 'pre-existing neighbour keeps only its item');
    assert.equal(app.gridMap.getItems(10, 9)[0].item_id, 'mana_potion');

    // Fresh drops must have landed on free tiles (the grid has plenty of room).
    let freshDrops = 0;
    for (let y = 8; y <= 12; y++) {
      for (let x = 8; x <= 12; x++) {
        if (x === 10 && y === 10) continue;
        for (const item of app.gridMap.getItems(x, y)) {
          if (item.item_id === 'gold' && item.quantity !== 99) freshDrops++;
          if (item.pickupType === 'key') freshDrops++;
        }
      }
    }
    assert.ok(freshDrops >= 2, 'gold and key landed on separate free tiles');
  });
});

describe('Temple full HP/MP message + disabled button', () => {
  const townConfig = { templeName: 'Temple of the Dawn' };

  it('detects a full-health/full-mana player', () => {
    const full = { hp: 50, max_hp: 50, mana: 20, max_mana: 20 };
    assert.equal(ModalManager.templeAtFull(full), true);
    assert.equal(ModalManager.templeAtFull({ ...full, hp: 49 }), false, 'missing HP is not full');
    assert.equal(ModalManager.templeAtFull({ ...full, mana: 19 }), false, 'missing MP is not full');
  });

  it('shows the not-in-need copy and a disabled button when full', () => {
    const el = makeFakeTownEl();
    ModalManager.renderTownTemple(el, {
      player: { hp: 50, max_hp: 50, mana: 20, max_mana: 20, gold: 100 },
      templeCost: 0,
      townConfig,
    });
    assert.match(el.innerHTML, /You are not in need of our services at this time\./);
    assert.doesNotMatch(el.innerHTML, /offers its blessing freely/);
    assert.match(el.innerHTML, /id="temple-heal"[^>]*disabled/);
  });

  it('restores the blessing copy and re-enables the button once HP/MP is missing', () => {
    const el = makeFakeTownEl();
    ModalManager.renderTownTemple(el, {
      player: { hp: 40, max_hp: 50, mana: 20, max_mana: 20, gold: 100 },
      templeCost: 0,
      townConfig,
    });
    assert.match(el.innerHTML, /The temple offers its blessing freely\./);
    assert.doesNotMatch(el.innerHTML, /id="temple-heal"[^>]*disabled/);
  });

  it('keeps a paid temple disabled when gold is short', () => {
    const el = makeFakeTownEl();
    ModalManager.renderTownTemple(el, {
      player: { hp: 40, max_hp: 50, mana: 20, max_mana: 20, gold: 1 },
      templeCost: 25,
      townConfig,
    });
    assert.match(el.innerHTML, /id="temple-heal"[^>]*disabled/);
  });
});

describe('Potions stack onto existing stacks on acquire', () => {
  it('tops up an existing health-potion stack from a Fate Grant stash card', () => {
    const player = createPlayer('magician');
    InventorySystem.addItem(player, { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 10 });
    const card = {
      id: 'card_health_potion_x3',
      name: 'Health Potion Stash',
      item: { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 3, stat_bonus: 30 },
    };

    FateGrantSystem.applyDraftedCards(player, [card], new GridMap());

    const stacks = [...stackOf(player.action_bar, 'health_potion'), ...stackOf(player.backpack, 'health_potion')];
    assert.equal(stacks.length, 1, 'the stash joins the existing stack instead of opening a new cell');
    assert.equal(stacks[0].quantity, 13);
  });

  it('stacks a mana-potion stash card onto the existing mana stack', () => {
    const player = createPlayer('magician');
    InventorySystem.addItem(player, { item_id: 'mana_potion', name: 'Mana Potion', type: 'consumable', quantity: 4 });
    const card = {
      id: 'card_mana_potion_x3',
      name: 'Mana Potion Stash',
      item: { item_id: 'mana_potion', name: 'Mana Potion', type: 'consumable', quantity: 3, stat_bonus: 40 },
    };

    FateGrantSystem.applyDraftedCards(player, [card], new GridMap());

    const stacks = [...stackOf(player.action_bar, 'mana_potion'), ...stackOf(player.backpack, 'mana_potion')];
    assert.equal(stacks.length, 1);
    assert.equal(stacks[0].quantity, 7);
  });

  it('opens a new cell only when every existing stack is full at 99', () => {
    const player = createPlayer('magician');
    InventorySystem.addItem(player, { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 99 });
    const card = {
      id: 'card_health_potion_x3',
      name: 'Health Potion Stash',
      item: { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 3, stat_bonus: 30 },
    };

    FateGrantSystem.applyDraftedCards(player, [card], new GridMap());

    const stacks = [...stackOf(player.action_bar, 'health_potion'), ...stackOf(player.backpack, 'health_potion')];
    assert.equal(stacks.length, 2, 'full stack forces a second cell');
    assert.deepEqual(stacks.map(s => s.quantity).sort((a, b) => a - b), [3, 99]);
    assert.equal(ITEMS_CATALOG.health_potion.maxStack, 99);
  });

  it('pick-up acquisition tops up a backpack stack before using an empty loadout slot', () => {
    const player = createPlayer('magician');
    player.backpack[3] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 98 };
    const grid = new GridMap();
    grid.loadFromMatrix(FLAT_MATRIX(6, 6));
    grid.addItem(2, 2, { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 1 });
    player.x = 2;
    player.y = 2;

    const res = InventorySystem.pickUpItem(player, grid);
    assert.equal(res.success, true);
    assert.equal(player.backpack[3].quantity, 99, 'existing stack was topped up');
    assert.equal(player.action_bar.filter(Boolean).length, 0, 'no new loadout stack was opened');
  });

  it('pick-up starts a second stack only after the existing stacks hit 99', () => {
    const player = createPlayer('magician');
    player.backpack[3] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 99 };
    const grid = new GridMap();
    grid.loadFromMatrix(FLAT_MATRIX(6, 6));
    grid.addItem(2, 2, { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 1 });
    player.x = 2;
    player.y = 2;

    const res = InventorySystem.pickUpItem(player, grid);
    assert.equal(res.success, true);
    const stacks = [...stackOf(player.action_bar, 'health_potion'), ...stackOf(player.backpack, 'health_potion')];
    assert.equal(stacks.length, 2);
    assert.equal(player.backpack[3].quantity, 99, 'full stack is untouched');
  });
});