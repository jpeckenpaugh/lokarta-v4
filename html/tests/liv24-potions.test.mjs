/**
 * LIV-24 FIX-9 — Auto-potions for allies + party-wide potion effect.
 *
 * Board T2 round 2 (items 6 + 7):
 *   - secondary party members drink health / magic potions once a stat is at or
 *     below 50%;
 *   - any potion used applies to every eligible party member (those not already
 *     full in the restored resource).
 *
 * Contract:
 *   - potion thresholds / item ids come from `party_ai.json` (no hardcoded ids);
 *   - a drink's party-wide reach comes from `items.json` `effect.scope: 'party'`;
 *   - no party / legacy save falls back to the lone player (single-target).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { InventorySystem } from '../engine/inventory-system.js';
import { PartyAI, profileForVocation } from '../engine/party-ai.js';
import { createPartyMember, createPartyPlayer } from '../engine/party.js';
import { ITEMS_CATALOG, PARTY_AI_CATALOG } from '../data/index.js';

function floorGrid(width = 12, height = 12) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
}

function potion(itemId, quantity = 1) {
  return { ...JSON.parse(JSON.stringify(ITEMS_CATALOG[itemId])), quantity };
}

test('LIV-24 catalog: potions are authored party-scoped and thresholds are data-driven', () => {
  assert.equal(ITEMS_CATALOG.health_potion.effect.scope, 'party');
  assert.equal(ITEMS_CATALOG.mana_potion.effect.scope, 'party');

  const fighter = profileForVocation('fighter');
  assert.equal(fighter.potion.enabled, true);
  assert.equal(fighter.potion.hpPct, 0.5, 'auto-drink below 50% (board rule)');
  assert.equal(typeof fighter.potion.itemId, 'string');
  assert.equal(typeof fighter.potion.manaItemId, 'string');
  assert.ok(PARTY_AI_CATALOG.default.potion, 'catalog default declares the v2 potion block');
});

test('LIV-24 restore: one potion tops up every eligible party member', () => {
  const player = createPartyPlayer('magician');
  player.hp = 40;
  player.max_hp = 100;
  const fighter = createPartyMember('fighter', { hp: 20, max_hp: 140 });
  const archer = createPartyMember('archer', { hp: 80, max_hp: 90 });
  const paladin = createPartyMember('paladin', { hp: 120, max_hp: 120 });
  player.party.push(fighter, archer, paladin);

  let removals = 0;
  const res = InventorySystem.consumeItem(player, potion('health_potion'), () => { removals++; });

  assert.equal(res.success, true);
  assert.equal(removals, 1);
  assert.equal(player.hp, 70);
  assert.equal(fighter.hp, 50);
  assert.equal(archer.hp, 90, 'a nearly-full ally is capped at max, not overhealed');
  assert.equal(paladin.hp, 120, 'a full ally is not an eligible target');
  assert.equal(res.targets, 3);
  assert.equal(res.restored, 70);
});

test('LIV-24 restore: a party-less legacy player keeps single-target behavior', () => {
  const player = createPlayer('magician');
  player.hp = 50;
  player.max_hp = 100;
  const res = InventorySystem.consumeItem(player, potion('health_potion'), () => {});
  assert.equal(res.success, true);
  assert.equal(player.hp, 80);
  assert.equal(res.targets, 1);
});

test('LIV-24 auto-potion: a hurt ally drinks from the shared pool and heals the party', () => {
  const grid = floorGrid();
  const player = createPartyPlayer('magician');
  player.x = 0;
  player.y = 0;
  player.hp = player.max_hp;
  player.action_bar[0] = potion('health_potion', 3);

  const fighter = createPartyMember('fighter', { x: 1, y: 0, hp: 30, max_hp: 140 });
  player.party.push(fighter);

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: () => 0.99 });
  const drink = events.find((ev) => ev.type === 'potion');
  assert.ok(drink, 'the hurt ally drank a potion');
  assert.equal(drink.resource, 'hp');
  assert.equal(drink.itemId, 'health_potion');
  assert.equal(fighter.hp, 60, 'the drinker was healed');
  assert.equal(player.action_bar[0].quantity, 2, 'one potion left the shared stack');
});

test('LIV-24 auto-potion: no drink above the 50% threshold', () => {
  const grid = floorGrid();
  const player = createPartyPlayer('magician');
  player.x = 0;
  player.y = 0;
  player.hp = player.max_hp;
  player.action_bar[0] = potion('health_potion', 1);

  const fighter = createPartyMember('fighter', { x: 1, y: 0, hp: 100, max_hp: 140 });
  player.party.push(fighter);

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: () => 0.99 });
  assert.equal(events.find((ev) => ev.type === 'potion'), undefined);
  assert.equal(player.action_bar[0].quantity, 1, 'the potion stayed in the shared pool');
});

test('LIV-24 auto-potion: a dry caster drinks a mana potion', () => {
  const grid = floorGrid();
  const player = createPartyPlayer('magician');
  player.x = 0;
  player.y = 0;
  player.hp = player.max_hp;
  player.backpack[0] = potion('mana_potion', 2);

  const fighter = createPartyMember('fighter', { x: 1, y: 0, hp: 140, max_hp: 140, mana: 10, max_mana: 90 });
  player.party.push(fighter);

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: () => 0.99 });
  const drink = events.find((ev) => ev.type === 'potion');
  assert.ok(drink, 'the dry caster drank a potion');
  assert.equal(drink.resource, 'mp');
  assert.equal(drink.itemId, 'mana_potion');
  assert.equal(fighter.mana, 50, '+40 MP restored');
  assert.equal(player.backpack[0].quantity, 1);
});

test('LIV-24 auto-potion: per-member cooldown prevents chain-drinking', () => {
  const grid = floorGrid();
  const player = createPartyPlayer('magician');
  player.x = 0;
  player.y = 0;
  player.hp = player.max_hp;
  player.action_bar[0] = potion('health_potion', 5);

  const fighter = createPartyMember('fighter', { x: 1, y: 0, hp: 5, max_hp: 140 });
  player.party.push(fighter);

  const first = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: () => 0.99 });
  assert.ok(first.find((ev) => ev.type === 'potion'));
  const afterFirst = player.action_bar[0].quantity;

  const second = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: () => 0.99 });
  assert.equal(second.find((ev) => ev.type === 'potion'), undefined, 'still on cooldown');
  assert.equal(player.action_bar[0].quantity, afterFirst);

  const later = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 8.1, random: () => 0.99 });
  assert.ok(later.find((ev) => ev.type === 'potion'), 'cooldown elapsed and still hurt -> drinks again');
});

test('LIV-24 integration: the loop resolves potion events', async () => {
  const { readControllerSources } = await import('./helpers/app-source.mjs');
  const source = readControllerSources();
  assert.match(source, /resolvePartyPotionResult\(/, 'game-loop handles the potion event');
  assert.match(source, /soundFX\.play\('potionDrink'\)/, 'the drink plays the potion cue');
});
