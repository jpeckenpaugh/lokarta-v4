/**
 * LIV-16 FIX-1 — Recruit new member at level 1 + first Fate Grant (Level 1)
 *
 * Board T2 feedback item 1: a newly recruited party member must join at level 1
 * (never aligned up to the party level) and be offered the first Fate Grant so
 * they can take a basic primary weapon. Covers:
 *   - the pure campaign model (`recruitMember` starts the recruit at level 1);
 *   - the fresh-recruit state that makes the tower-entry first-grant check fire
 *     (level 1 + empty hotbar + no primary weapon);
 *   - the level-1 draft guarantee (a main_hand offer = basic primary weapon);
 *   - the worker persistence round-trip and next-tower hand-off; and
 *   - the app wiring that offers the level-1 Fate Grant on tower entry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  VOCATIONS_CATALOG,
  listTowerDefinitionsByOrder,
} from '../data/index.js';

import {
  createPartyPlayer,
  createPartyMember,
  makeMemberId,
  partyVocationIds,
} from '../engine/party.js';

import {
  recruitMember,
  alignMemberToLevel,
  RECRUIT_STARTING_LEVEL,
} from '../engine/campaign.js';

import { FateGrantSystem } from '../engine/fate-grant-system.js';

import { STORES, read } from '../services/storage.js';
import { COMMAND_HANDLERS } from '../worker/game-worker.js';

import { withFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const VOCATIONS = Object.keys(VOCATIONS_CATALOG);

/**
 * The tower-entry first-grant precondition is owned by
 * `FateGrantSystem.needsStarterGrant` (LIV-64): a level-1 actor with an empty
 * hotbar and no primary weapon equipped. Delegating keeps this test in sync
 * with the app gate.
 */
function isFirstGrantCase(actor, level = 1) {
  return FateGrantSystem.needsStarterGrant(actor, level);
}

test('LIV-16: recruits join at level 1 regardless of the party level', () => {
  const player = createPartyPlayer('magician');
  player.party.push(alignMemberToLevel(createPartyMember('fighter'), 12));

  const recruit = recruitMember(player, 'archer');
  assert.ok(recruit, 'the recruit joined');
  assert.equal(RECRUIT_STARTING_LEVEL, 1);
  assert.equal(recruit.level, 1, 'recruit starts at level 1, not the party level');

  const voc = VOCATIONS_CATALOG.archer;
  assert.equal(recruit.max_hp, voc.hp, 'level-1 catalog base HP');
  assert.equal(recruit.max_mana, voc.mana, 'level-1 catalog base mana');
  assert.equal(recruit.hp, recruit.max_hp, 'recruit arrives at full HP');
  assert.equal(recruit.mana, recruit.max_mana);

  assert.equal(player.activeMemberId, makeMemberId('archer'));
  assert.equal(player.vocation, 'archer', 'the recruit becomes the active member');
  assert.deepEqual(partyVocationIds(player), ['magician', 'fighter', 'archer']);
});

test('LIV-16: a fresh level-1 recruit satisfies the first Fate Grant preconditions', () => {
  const player = createPartyPlayer('magician');
  const recruit = recruitMember(player, 'paladin');

  assert.equal(isFirstGrantCase(recruit, 1), true,
    'a level-1 recruit with an empty hotbar is offered the first Fate Grant');
  assert.equal(recruit.paperdoll.main_hand, null, 'no weapon yet — the draft supplies one');
  assert.equal(recruit.paperdoll.off_hand, null);

  // Any hotbar item ends the first-grant case.
  recruit.action_bar[0] = { item_id: 'health_potion', name: 'Health Potion' };
  assert.equal(isFirstGrantCase(recruit, 1), false);

  // A veteran is not a first-grant case either.
  const veteran = alignMemberToLevel(createPartyMember('fighter'), 4);
  assert.equal(isFirstGrantCase(veteran, 1), false);
});

test('LIV-16: the level-1 Fate Grant offers every recruit a basic primary weapon', () => {
  for (const vocation of VOCATIONS) {
    const player = createPartyPlayer('magician');
    const recruit = recruitMember(player, vocation);
    if (!recruit) continue; // e.g. magician is already on the party

    const offer = FateGrantSystem.generateDraftOffer(recruit, RECRUIT_STARTING_LEVEL);
    const hasPrimary = offer.cards.some((c) => FateGrantSystem.resolveCardSlot(c) === 'main_hand');
    assert.ok(hasPrimary, `${vocation} level-1 Fate Grant must offer a main_hand (basic primary weapon)`);
    assert.equal(offer.requiredSelections.min, 2);
  }
});

test('LIV-16 worker: recruitMember persists a level-1 recruit eligible for the first grant', async () => {
  await withFakeIndexedDB(async () => {
    const ordered = listTowerDefinitionsByOrder();
    const created = await COMMAND_HANDLERS.createSlot({ slotIndex: 5, vocation: 'magician' });
    created.player.level = 9;
    await COMMAND_HANDLERS.saveCharacter({ player: created.player });

    await COMMAND_HANDLERS.completeTower({ slotIndex: 5, towerId: ordered[0].id });
    const recruited = await COMMAND_HANDLERS.recruitMember({ slotIndex: 5, vocation: 'fighter' });

    assert.equal(recruited.member.level, 1, 'worker recruit starts at level 1');
    assert.equal(recruited.player.activeMemberId, makeMemberId('fighter'));
    assert.equal(isFirstGrantCase(recruited.player, 1), true,
      'the persisted active recruit can be offered the first Fate Grant');

    const stored = await read(STORES.CHARACTERS, 'char_slot_5');
    const storedRecruit = stored.party.find((m) => m.vocation === 'fighter');
    assert.equal(storedRecruit.level, 1, 'level-1 recruit survives persistence');
    assert.ok(storedRecruit.action_bar.every((s) => s === null), 'recruit hotbar starts empty');

    // Moving into the next tower preserves the level-1 recruit as the active
    // member, so tower entry offers the first Fate Grant.
    const moved = await COMMAND_HANDLERS.selectTower({ slotIndex: 5, towerId: ordered[1].id });
    assert.equal(moved.player.vocation, 'fighter');
    assert.equal(moved.player.level, 1, 'the recruit is still level 1 entering the next tower');
    assert.equal(isFirstGrantCase(moved.player, 1), true,
      'tower entry sees a first-grant case for the recruit');
  });
});

test('LIV-16 app wiring: tower entry offers the Level-1 Fate Grant to a fresh actor', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'html', 'app', 'floor-controller.js'),
    'utf8'
  );
  const gate = source.match(/if \(FateGrantSystem\.needsStarterGrant\(this\.player, 1\)\) \{([\s\S]*?)\n    \}/);
  assert.ok(gate, 'floor-controller gates tower entry on FateGrantSystem.needsStarterGrant');
  assert.match(gate[1], /showFateGrantModal\(1\)/, 'the Level-1 Fate Grant modal is offered on tower entry');
});
