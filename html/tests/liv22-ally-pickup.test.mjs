/**
 * LIV-22 FIX-7 — Auto allies pick up walk-over items into the shared party
 * backpack.
 *
 * Board T2 feedback round 2 item 4: "Secondary party members should also pick
 * up items when walking over. Picked up items go to shared party backpack
 * (each party member does not get a separate unique backpack with their own
 * items in it)."
 *
 * Covers:
 *   - the shared-backpack model contract (`party.js`): switching the active
 *     member never swaps the backpack, and members carry no backpack of their
 *     own;
 *   - `InventorySystem.pickUpItem` collecting from an explicit tile so any
 *     actor can walk-over collect;
 *   - the non-destructive migration that folds legacy per-member backpacks
 *     into the shared grid;
 *   - the app loop routing an ally `move` event through the walk-over pickup
 *     pipeline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { InventorySystem } from '../engine/index.js';
import {
  createPartyPlayer,
  createPartyMember,
  makeMemberId,
  setActiveMember,
  captureActiveMember,
  migratePlayerParty,
} from '../engine/party.js';
import { ITEMS_CATALOG } from '../data/index.js';

import { inventoryControllerMethods } from '../app/inventory-controller.js';
import { gameLoopMethods } from '../app/game-loop.js';
import { readControllerSources } from './helpers/app-source.mjs';

function floorGrid(width = 12, height = 12) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
}

/** Minimal app surface for the walk-over pickup pipeline. */
function fakeApp(player, gridMap) {
  return {
    player,
    gridMap,
    logs: [],
    floats: [],
    persistCount: 0,
    logCombat(message) { this.logs.push(message); },
    addFloatingText() {},
    updateHUD() {},
    async persistSave() { this.persistCount += 1; },
    ...inventoryControllerMethods,
    ...gameLoopMethods,
  };
}

test('LIV-22 model: the party shares one backpack and members carry none', () => {
  const player = createPartyPlayer('magician');
  player.backpack[0] = { item_id: 'astral_scepter', name: 'Astral Scepter', quantity: 1 };

  const fighter = createPartyMember('fighter');
  assert.equal(fighter.backpack, undefined, 'a member has no backpack of its own');
  player.party.push(fighter);

  // Switch the active member: the shared backpack must survive untouched.
  captureActiveMember(player);
  setActiveMember(player, makeMemberId('fighter'));
  assert.equal(player.vocation, 'fighter', 'the fighter is now active');
  assert.equal(player.backpack[0]?.item_id, 'astral_scepter', 'shared backpack survives a member switch');

  // The captured member never banked its own copy.
  const magician = player.party.find((m) => m.vocation === 'magician');
  assert.equal(magician.backpack, undefined, 'the outgoing member stores no backpack');
});

test('LIV-22 pickup: an item is collected from an explicit tile into the shared backpack', () => {
  const player = createPlayer('magician');
  player.x = 0;
  player.y = 0;
  const grid = floorGrid();
  grid.addItem(5, 5, { ...ITEMS_CATALOG.astral_scepter, quantity: 1 });

  const res = InventorySystem.pickUpItem(player, grid, 5, 5);
  assert.equal(res.success, true);
  assert.equal(grid.getItems(5, 5).length, 0, 'the ground tile is cleared');
  assert.ok(player.backpack.some((s) => s && s.item_id === 'astral_scepter'), 'equipment banks into the shared backpack');

  // The actor's own tile is empty, so nothing is collected there.
  const empty = InventorySystem.pickUpItem(player, grid, 0, 0);
  assert.equal(empty.success, false);
});

test('LIV-22 migration: legacy per-member backpacks fold into the shared grid without loss', () => {
  const player = createPartyPlayer('magician');
  // Simulate a pre-LIV-22 save: the active member mirrored its backpack on the
  // member too, and a second member carried its own.
  player.backpack = [{ item_id: 'torch', name: 'Torch', quantity: 2 }, null];
  player.party[0].backpack = [{ item_id: 'torch', name: 'Torch', quantity: 2 }];
  const fighter = createPartyMember('fighter');
  fighter.backpack = [{ item_id: 'health_potion', name: 'Health Potion', quantity: 1 }];
  player.party.push(fighter);

  const migrated = migratePlayerParty(player);
  assert.equal(migrated.backpack.length, 36, 'shared backpack normalized to the catalog size');
  const torches = migrated.backpack.filter((s) => s && s.item_id === 'torch');
  assert.equal(torches.length, 1, 'the active member backpack is not duplicated');
  assert.equal(torches[0].quantity, 2);
  assert.ok(migrated.backpack.some((s) => s && s.item_id === 'health_potion'), 'the other member backpack is preserved');
  assert.equal(migrated.party.every((m) => m.backpack === undefined), true, 'per-member backpacks are stripped');

  assert.equal(migratePlayerParty(migrated), migrated, 'migration is idempotent (reference no-op)');
});

test('LIV-22 loop: an ally move event collects its walk-over drop into the shared backpack', async () => {
  const player = createPartyPlayer('magician');
  player.x = 0;
  player.y = 0;
  const fighter = createPartyMember('fighter', { x: 4, y: 4 });
  player.party.push(fighter);

  const grid = floorGrid();
  grid.addItem(4, 4, { ...ITEMS_CATALOG.astral_scepter, quantity: 1 });

  const app = fakeApp(player, grid);
  app.applyPartyEvent({ member: fighter, type: 'move', from: { x: 5, y: 4 }, to: { x: 4, y: 4 } });
  await Promise.resolve();

  assert.equal(grid.getItems(4, 4).length, 0, 'the ally consumed the drop');
  assert.ok(player.backpack.some((s) => s && s.item_id === 'astral_scepter'), 'the drop landed in the shared backpack');
  assert.ok(app.persistCount >= 1, 'the pickup was persisted');
});

test('LIV-22 loop: an ally move event with no ground item is a no-op', () => {
  const player = createPartyPlayer('magician');
  const fighter = createPartyMember('fighter', { x: 4, y: 4 });
  player.party.push(fighter);
  const grid = floorGrid();
  const app = fakeApp(player, grid);

  app.applyPartyEvent({ member: fighter, type: 'move', from: { x: 5, y: 4 }, to: { x: 4, y: 4 } });
  assert.equal(app.persistCount, 0);
  assert.equal(player.backpack.every((s) => s === null), true);
});

test('LIV-22 wiring: the game loop routes ally moves through the walk-over pickup', () => {
  const source = readControllerSources();
  assert.match(source, /handleAllyWalkoverPickup\s*\(/, 'an ally walk-over pickup helper exists');
  assert.match(source, /this\.handlePickUp\(member\.x, member\.y\)/, 'the helper collects at the ally tile');
  const inventory = source.match(/async handlePickUp\(gridX[\s\S]*?\)\s*\{/);
  assert.ok(inventory, 'handlePickUp accepts an explicit source tile');
});
