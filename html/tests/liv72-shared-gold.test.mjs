/**
 * LIV-72 — Shared party gold (one wallet for all members)
 *
 * Board feedback: gold must be a single party-level (shared) resource, not a
 * per-member stat. These tests lock the contract:
 *   - earning/spending gold on any member moves one shared balance;
 *   - capturing/applying/cycling members never copies, forks, or resets it;
 *   - recruiting a member does not fork or reset it;
 *   - pre-LIV-72 per-member gold folds into the shared pool (sum, clamped to the
 *     catalog cap) idempotently, so a migrated save and a fresh save behave
 *     identically.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EconomySystem,
  INVENTORY_CONFIG,
  createPartyPlayer,
  createPartyMember,
  migratePlayerParty,
  recruitMember,
  setActiveMember,
  cycleActiveMember,
  getActiveMember,
  captureActiveMember,
  applyActiveMember,
} from '../engine/index.js';

test('LIV-72 shared wallet: earning and spending move one pool across members', () => {
  const player = createPartyPlayer('magician');
  const fighter = recruitMember(player, 'fighter');
  assert.ok(fighter, 'fighter recruited');
  assert.equal(player.activeMemberId, fighter.memberId, 'recruit becomes active');

  assert.equal(Number(player.gold), EconomySystem.startingGold, 'fresh party starts at the catalog starting gold');

  // Earn as the active fighter.
  EconomySystem.addGold(player, 100);
  assert.equal(player.gold, 100);

  // Swap to the magician: the shared wallet must not reset or fork.
  setActiveMember(player, 'member_magician');
  assert.equal(player.gold, 100, 'the shared wallet survives the swap');
  assert.equal(getActiveMember(player).memberId, 'member_magician');

  // Spend as the magician; the fighter sees the same remaining pool.
  assert.equal(EconomySystem.spendGold(player, 30), true);
  assert.equal(player.gold, 70);

  setActiveMember(player, 'member_fighter');
  assert.equal(player.gold, 70, 'spending on one member debits the shared pool');

  // Capturing must not write a per-member wallet.
  captureActiveMember(player);
  assert.equal(player.party.every((m) => m.gold === undefined), true, 'no member carries its own gold');
});

test('LIV-72 shared wallet: applying a member never overwrites the shared pool', () => {
  const player = createPartyPlayer('magician');
  const fighter = createPartyMember('fighter');
  player.party.push(fighter);
  player.gold = 500;

  // A freshly created member carries no wallet of its own.
  assert.equal(fighter.gold, undefined);
  applyActiveMember(player, fighter);
  assert.equal(player.gold, 500, 'switching to a fresh member keeps the shared wallet');
});

test('LIV-72 shared wallet: recruiting a member neither resets nor forks gold', () => {
  const player = createPartyPlayer('magician');
  EconomySystem.addGold(player, 250);
  const before = player.gold;

  const archer = recruitMember(player, 'archer');
  assert.ok(archer);
  assert.equal(player.gold, before, 'recruit does not touch the shared wallet');
  assert.equal(archer.gold, undefined, 'a recruit carries no wallet');

  cycleActiveMember(player, 1);
  assert.equal(player.gold, before, 'cycling control keeps the shared wallet');
});

test('LIV-72 migration: per-member gold folds into the shared pool (sum) idempotently', () => {
  const player = createPartyPlayer('magician');
  // Simulate a pre-LIV-72 save: the active member's gold mirrors the top level,
  // and every other member carries its own.
  player.gold = 40;
  player.party[0].gold = 40;
  const fighter = createPartyMember('fighter');
  fighter.gold = 30;
  const archer = createPartyMember('archer');
  archer.gold = 20;
  player.party.push(fighter, archer);

  const migrated = migratePlayerParty(player);
  assert.equal(migrated.gold, 90, 'shared pool is the sum of members gold');
  assert.equal(migrated.party.every((m) => m.gold === undefined), true, 'per-member wallets are stripped');
  assert.equal(migratePlayerParty(migrated), migrated, 'migration is idempotent (reference no-op)');
});

test('LIV-72 migration: the consolidated pool is clamped to the catalog cap', () => {
  const player = createPartyPlayer('magician');
  player.gold = INVENTORY_CONFIG.GOLD_CAP;
  player.party[0].gold = INVENTORY_CONFIG.GOLD_CAP;
  const fighter = createPartyMember('fighter');
  fighter.gold = 50;
  player.party.push(fighter);

  const migrated = migratePlayerParty(player);
  assert.equal(migrated.gold, INVENTORY_CONFIG.GOLD_CAP, 'sum clamps to economy.gold.cap');
});

test('LIV-72 migration: a migrated save and a fresh save behave identically', () => {
  // A pre-LIV-72 single-character save carrying 100 gold.
  const legacy = createPartyPlayer('fighter');
  legacy.gold = 100;
  legacy.party = undefined;
  legacy.activeMemberId = undefined;
  const migrated = migratePlayerParty(legacy);
  assert.equal(migrated.gold, 100);
  assert.equal(migrated.party[0].gold, undefined, 'gold lives on the shared wallet after migration');

  // A fresh save with the same 100 gold.
  const fresh = createPartyPlayer('fighter');
  EconomySystem.addGold(fresh, 100);

  for (const player of [migrated, fresh]) {
    assert.equal(EconomySystem.spendGold(player, 40), true);
    assert.equal(player.gold, 60, 'migrated and fresh saves spend identically');
    EconomySystem.addGold(player, 15);
    assert.equal(player.gold, 75, 'migrated and fresh saves earn identically');
  }
});
