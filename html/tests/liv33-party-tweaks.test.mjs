/**
 * LIV-33 — Sprint 001 close tweaks.
 *
 * Three engineering-owned tweaks layered on the LIV-9 party model:
 *   1. Party-shared keys: `levelKeys` is one top-level party store (like the
 *      LIV-22 shared backpack), so a key picked up by any member survives an
 *      active-member cycle and always opens its tier gate.
 *   2. Ally ground-item search: an out-of-combat ally paths to a nearby ground
 *      item and banks it in the shared backpack through the walk-over pipeline.
 *   3. Fighter/Paladin aggression: protector profiles retaliate against the
 *      hostile attacking a party member before falling back to the nearest
 *      hostile; backline profiles keep their support distance.
 *
 * All new tuning lives in `party_ai.json` (`itemSearch`, `protect`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { DoorSystem } from '../engine/index.js';
import {
  PartyAI,
  profileForVocation,
  DEFAULT_AI_ITEM_SEARCH,
  DEFAULT_AI_PROTECT,
} from '../engine/party-ai.js';
import {
  createPartyPlayer,
  createPartyMember,
  cycleActiveMember,
  migratePlayerParty,
  MONSTER_FACTION,
} from '../engine/party.js';
import { ITEMS_CATALOG, PARTY_AI_CATALOG } from '../data/index.js';

import { inventoryControllerMethods } from '../app/inventory-controller.js';
import { gameLoopMethods } from '../app/game-loop.js';

function floorGrid(width = 24, height = 24) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
}

/** Minimal app surface for the walk-over pickup pipeline (mirrors LIV-22). */
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

function enemy(x, y, overrides = {}) {
  return {
    id: `enemy_${x}_${y}`,
    type: 'giant_rat',
    name: 'Giant Rat',
    faction: MONSTER_FACTION,
    x,
    y,
    hp: 100,
    max_hp: 100,
    damageScale: 1,
    attackCooldown: 0,
    attackCadence: 1.5,
    moveCooldown: 0,
    isAggroed: true,
    visible: true,
    ...overrides,
  };
}

test('LIV-33 catalog: itemSearch and protect resolve per profile over the default', () => {
  assert.deepEqual(profileForVocation('not_a_vocation').itemSearch, { ...DEFAULT_AI_ITEM_SEARCH });
  assert.equal(DEFAULT_AI_PROTECT.enabled, false, 'the safe baseline does not protect');

  assert.equal(profileForVocation('fighter').itemSearch.radius, PARTY_AI_CATALOG.profiles.fighter.itemSearch.radius);
  assert.equal(profileForVocation('archer').protect.enabled, false, 'backline keeps its distance');
  assert.equal(profileForVocation('fighter').protect.enabled, true, 'fighter protects');
  assert.equal(profileForVocation('paladin').protect.enabled, true, 'paladin protects');
  assert.equal(profileForVocation('paladin').protect.radius, PARTY_AI_CATALOG.profiles.paladin.protect.radius);
});

test('LIV-33 shared keys: an ally pickup credits the party store and survives a cycle', async () => {
  const player = createPartyPlayer('magician');
  player.current_floor = 1;
  const fighter = createPartyMember('fighter', { x: 4, y: 4 });
  player.party.push(fighter);

  const grid = floorGrid();
  grid.addItem(4, 4, DoorSystem.keyDropForMonster({ holdsKey: 'copper' }));
  const app = fakeApp(player, grid);

  await app.handlePickUp(4, 4);
  assert.equal(DoorSystem.hasKey(player, 'copper', 1), true, 'the pickup credits the party key store');
  assert.equal(fighter.levelKeys, undefined, 'members carry no per-member key ring');

  // Cycling control must never hide or clone the earned key store.
  const store = player.levelKeys;
  cycleActiveMember(player, 1);
  assert.equal(player.vocation, 'fighter', 'control moved to the fighter');
  assert.equal(player.levelKeys, store, 'the shared key store is not swapped or copied');
  assert.equal(DoorSystem.hasKey(player, 'copper', 1), true, 'the key survives the cycle');

  // A tier gate opens from the party store regardless of who is active.
  const gates = new GridMap(3, 1);
  gates.loadFromMatrix([[TILE_TYPES.FLOOR, TILE_TYPES.GATED_DOOR, TILE_TYPES.FLOOR]]);
  gates.getTile(1, 0).gateTier = 'copper';
  assert.equal(gates.isWalkable(1, 0), false);
  assert.equal(DoorSystem.syncPlayerGates(gates, player, 1), 1, 'party key opens the gate for the active fighter');
  assert.equal(gates.isWalkable(1, 0), true);
});

test('LIV-33 migration: per-member key rings fold into one idempotent party store', () => {
  const player = createPartyPlayer('magician');
  player.levelKeys = { 1: { copper: true } };
  player.party[0].levelKeys = { 1: { copper: true }, 2: { silver: true } };
  const fighter = createPartyMember('fighter', { x: 1, y: 1 });
  fighter.levelKeys = { 2: { silver: true, gold: true } };
  player.party.push(fighter);

  const migrated = migratePlayerParty(player);
  assert.deepEqual(migrated.levelKeys, { 1: { copper: true }, 2: { silver: true, gold: true } });
  assert.equal(migrated.party.every((m) => m.levelKeys === undefined), true, 'per-member key rings are stripped');
  assert.equal(migratePlayerParty(migrated), migrated, 'migration is idempotent (reference no-op)');
});

test('LIV-33 item search: an idle ally paths to a ground item and banks it', async () => {
  const player = createPartyPlayer('magician');
  player.x = 0;
  player.y = 0;
  const fighter = createPartyMember('fighter', { x: 2, y: 2 });
  player.party.push(fighter);

  const grid = floorGrid();
  grid.addItem(2, 6, { ...ITEMS_CATALOG.astral_scepter, quantity: 1 });
  const app = fakeApp(player, grid);

  let collected = false;
  for (let i = 0; i < 60 && !collected; i++) {
    const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.2, random: () => 0.99 });
    for (const ev of events) app.applyPartyEvent(ev);
    await Promise.resolve();
    if (grid.getItems(2, 6).length === 0) collected = true;
  }

  assert.equal(collected, true, 'the ally reached and collected the ground item');
  assert.ok(player.backpack.some((s) => s && s.item_id === 'astral_scepter'), 'the drop landed in the shared backpack');
  assert.ok(app.persistCount >= 1, 'the pickup was persisted');
});

test('LIV-33 item search: an ally already engaged keeps fighting instead of looting', () => {
  const grid = floorGrid();
  const player = createPartyPlayer('fighter');
  const paladin = createPartyMember('paladin', { x: 5, y: 5 });
  player.party.push(paladin);

  grid.addItem(5, 6, { ...ITEMS_CATALOG.astral_scepter, quantity: 1 });
  const rat = enemy(6, 5);
  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [rat], deltaSec: 0.1 });

  const paladinEvent = events.find((ev) => ev.member === paladin);
  assert.notEqual(paladinEvent.type, 'move', 'combat decision order wins over item finding');
  assert.ok(paladin.aiTargetId === rat.id, 'the engaged ally keeps its combat target');
});

test('LIV-33 protect: fighter/paladin lock the attacker, backline keeps distance', () => {
  const grid = floorGrid();
  const player = createPartyPlayer('magician');
  player.x = 10;
  player.y = 2;

  const fighter = createPartyMember('fighter', { x: 1, y: 2 });
  const paladin = createPartyMember('paladin', { x: 3, y: 4 });
  const archer = createPartyMember('archer', { x: 2, y: 8 });
  player.party.push(fighter, paladin, archer);

  const rat = enemy(9, 2); // adjacent to the active member, far from the allies

  PartyAI.updateAllies(player, { gridMap: grid, monsters: [rat], deltaSec: 0.1 });

  assert.equal(fighter.aiTargetId, rat.id, 'fighter retaliates against the attacker');
  assert.equal(paladin.aiTargetId, rat.id, 'paladin retaliates against the attacker');
  assert.equal(archer.aiTargetId, null, 'the backline archer keeps its support distance');
});
