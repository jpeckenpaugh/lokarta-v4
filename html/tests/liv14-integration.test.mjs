/**
 * LIV-14 WS6 — Integration: end-to-end acceptance tests for Dev Sprint 001.
 *
 * Where WS1–WS5 each lock one layer in isolation, this suite drives the whole
 * party campaign across layer boundaries:
 *   - the campaign journey (complete → recruit → next tower → ultimate) on the
 *     pure party/campaign model and through the real worker command pipeline;
 *   - a live combat tick where auto allies fight, heal, and never friendly-fire
 *     while monsters target the nearest party member;
 *   - the app wiring that routes tower completion into the Recruit flow and
 *     reserves the terminal victory screen for the final tower;
 *   - legacy single-character save migration into the party model.
 *
 * Acceptance criteria 1–9 (LIV-8 plan §6) are exercised here; criterion 10 is
 * the T0 gate plus the T1 preview deploy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listTowerDefinitionsByOrder,
  firstTowerId,
  nextTowerIdAfter,
} from '../data/index.js';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { CombatSystem } from '../engine/combat-system.js';
import { EntityAI } from '../engine/entity-ai.js';
import { PartyAI } from '../engine/party-ai.js';
import {
  createPartyPlayer,
  createPartyMember,
  migratePlayerParty,
  partyVocationIds,
  makeMemberId,
  isTowerUnlocked,
  allTowersCompleted,
  PARTY_FACTION,
  MONSTER_FACTION,
} from '../engine/party.js';
import {
  recruitableVocations,
  canRecruit,
  completePlayerTower,
  recruitMember,
  towerUnlockInfo,
} from '../engine/campaign.js';

import { STORES, read } from '../services/storage.js';
import { COMMAND_HANDLERS } from '../worker/game-worker.js';

import { withFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { readControllerSources } from './helpers/app-source.mjs';

function floorGrid(width = 24, height = 24) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
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

test('LIV-14 integration: one-member party ascends every tower, recruiting one per clear', () => {
  const ordered = listTowerDefinitionsByOrder();
  assert.equal(ordered.length, 4, 'the campaign is four authored towers');

  const player = createPartyPlayer('magician');
  player.towerId = firstTowerId();

  // Only the first tower is available at campaign start.
  assert.deepEqual(player.towerProgress.completedTowerIds, []);
  assert.deepEqual(player.towerProgress.unlockedTowerIds, [firstTowerId()]);
  assert.equal(isTowerUnlocked(player.towerProgress, ordered[1].id), false);
  assert.deepEqual(towerUnlockInfo(player.towerProgress, ordered[1].id).requires, [ordered[0].id]);

  for (let i = 0; i < ordered.length; i++) {
    const tower = ordered[i];
    assert.equal(isTowerUnlocked(player.towerProgress, tower.id), true, `${tower.id} must be unlocked`);

    player.towerId = tower.id;
    const info = completePlayerTower(player, tower.id);
    player.towerProgress = info.progress;

    assert.ok(player.towerProgress.completedTowerIds.includes(tower.id));
    assert.equal(info.nextTowerId, nextTowerIdAfter(tower.id));
    // Ultimate victory is reserved for the final tower.
    assert.equal(info.allComplete, i === ordered.length - 1);

    if (i < ordered.length - 1) {
      assert.equal(isTowerUnlocked(player.towerProgress, ordered[i + 1].id), true, 'next tower unlocks');
      if (i + 2 < ordered.length) {
        assert.equal(isTowerUnlocked(player.towerProgress, ordered[i + 2].id), false, 'two ahead stays locked');
      }

      const remaining = recruitableVocations(player);
      assert.ok(remaining.length > 0, 'a companion is available after each clear');
      const before = partyVocationIds(player);
      const chosen = remaining[0];
      const member = recruitMember(player, chosen);

      assert.ok(member, 'the chosen vocation joined');
      assert.deepEqual(partyVocationIds(player), [...before, chosen]);
      assert.equal(player.activeMemberId, member.memberId, 'the recruit becomes active');
      assert.equal(player.vocation, chosen);
      assert.equal(recruitMember(player, chosen), null, 'a duplicate recruit is rejected');
      assert.equal(canRecruit(player) || i >= ordered.length - 2, true);
    }
  }

  assert.equal(allTowersCompleted(player.towerProgress), true);
  assert.equal(isTowerUnlocked(player.towerProgress, ordered[ordered.length - 1].id), true);
  assert.equal(player.party.length, 4, 'the full four-vocation party was built');
  assert.equal(recruitableVocations(player).length, 0);
  assert.equal(canRecruit(player), false, 'party is full');
});

test('LIV-14 integration: auto allies fight, heal, and never friendly-fire in one tick', () => {
  const grid = floorGrid();
  const player = createPartyPlayer('magician');
  player.x = 2;
  player.y = 2;

  const fighter = createPartyMember('fighter', { x: 5, y: 5 });
  const archerHurt = createPartyMember('archer', { x: 5, y: 6, hp: 30, max_hp: 90 });
  const paladin = createPartyMember('paladin', { x: 4, y: 5 });
  player.party.push(fighter, archerHurt, paladin);

  const rat = enemy(6, 5);
  const archerHpBefore = archerHurt.hp;

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [rat], deltaSec: 0.1 });
  assert.ok(events.length >= 3, 'every auto ally acted once');

  // Offense: an ally damaged the monster.
  assert.ok(rat.hp < 100, 'an auto ally hit the monster');

  // Support: the paladin healed the most-injured ally, not itself.
  assert.ok(archerHurt.hp > archerHpBefore, 'the hurt ally was healed');
  assert.equal(paladin.hp, paladin.max_hp, 'the healer did not waste the heal on itself');
  assert.ok(events.some((ev) => ev.type === 'ability'), 'abilities were cast');

  // Friendly fire: no party member lost HP to another party member.
  assert.equal(player.hp, player.max_hp);
  assert.equal(fighter.hp, fighter.max_hp);
  assert.equal(paladin.hp, paladin.max_hp);

  // Hostile targeting is party-wide: the monster picks the nearest member.
  const allies = PartyAI.livingAllies(player);
  assert.equal(EntityAI.selectTarget(rat, allies), fighter, 'the rat targets the nearest ally');
  const monsterEvents = EntityAI.updateMonsters([rat], player, grid, 0.1, allies);
  assert.equal(monsterEvents.length, 1);
  assert.equal(monsterEvents[0].target, fighter);
  assert.ok(fighter.hp < fighter.max_hp, 'the hit landed on the nearest ally');
  assert.equal(player.hp, player.max_hp, 'a distant active member was untouched');
});

test('LIV-14 integration: auto bow casts spend free ammo, manual casts obey the quiver', () => {
  const grid = floorGrid();
  const autoArcher = createPartyMember('archer', { x: 2, y: 2 });
  const autoTarget = enemy(5, 2);
  const auto = CombatSystem.executePowerShot(autoArcher, autoTarget, grid, null, { freeAmmo: true });
  assert.equal(auto.success, true, 'an auto ally fires without arrows');

  const manualArcher = createPartyMember('archer', { x: 2, y: 2 });
  const manualTarget = enemy(5, 2);
  const manual = CombatSystem.executePowerShot(manualArcher, manualTarget, grid, null);
  assert.equal(manual.success, false, 'the active member still needs arrows');
  assert.equal(manualTarget.hp, 100);
});

test('LIV-14 integration: the worker campaign pipeline persists party, unlocks and floor scaling', async () => {
  await withFakeIndexedDB(async () => {
    const ordered = listTowerDefinitionsByOrder();
    await COMMAND_HANDLERS.createSlot({ slotIndex: 1, vocation: 'magician' });

    let stored = await read(STORES.CHARACTERS, 'char_slot_1');
    assert.equal(stored.party.length, 1, 'every save is a party save');
    assert.deepEqual(stored.towerProgress.unlockedTowerIds, [firstTowerId()]);

    // Criterion 7: a later tower is rejected before its prerequisite clears.
    await assert.rejects(
      () => COMMAND_HANDLERS.selectTower({ slotIndex: 1, towerId: ordered[1].id }),
      /locked/i
    );

    // Criterion 1/2: clearing unlocks the next tower and offers a companion.
    const afterFirst = await COMMAND_HANDLERS.completeTower({ slotIndex: 1, towerId: ordered[0].id });
    assert.equal(afterFirst.allComplete, false);
    assert.equal(isTowerUnlocked(afterFirst.progress, ordered[1].id), true);
    assert.equal(afterFirst.recruitableVocations.length, 3);

    // Criterion 2/3: one level-1 recruit becomes the active member (LIV-16).
    const recruited = await COMMAND_HANDLERS.recruitMember({ slotIndex: 1, vocation: 'archer' });
    assert.equal(recruited.player.party.length, 2);
    assert.equal(recruited.player.activeMemberId, makeMemberId('archer'));
    assert.equal(recruited.player.vocation, 'archer');
    assert.equal(recruited.member.level, 1, 'recruit starts at level 1 (first Fate Grant eligible)');

    // Criterion 3: moving into the next tower preserves the party + active member,
    // and WS5 party scaling reaches floor generation.
    const moved = await COMMAND_HANDLERS.selectTower({ slotIndex: 1, towerId: ordered[1].id });
    assert.equal(moved.player.towerId, ordered[1].id);
    assert.equal(moved.player.party.length, 2, 'switching towers preserves the party');
    assert.equal(moved.player.activeMemberId, makeMemberId('archer'));
    assert.equal(moved.floor.party_size, 2, 'the floor scales to the live party size');

    // Criterion 8: ultimate only after every tower is complete.
    let last = null;
    for (let i = 1; i < ordered.length; i++) {
      if (i > 1) {
        await COMMAND_HANDLERS.selectTower({ slotIndex: 1, towerId: ordered[i].id });
      }
      last = await COMMAND_HANDLERS.completeTower({ slotIndex: 1, towerId: ordered[i].id });
      if (i < ordered.length - 1) {
        await COMMAND_HANDLERS.recruitMember({
          slotIndex: 1,
          vocation: last.recruitableVocations[0],
        });
      }
    }
    assert.equal(last.allComplete, true);
    assert.equal(last.nextTowerId, null);

    const final = await read(STORES.CHARACTERS, 'char_slot_1');
    assert.equal(final.party.length, 4);
    assert.equal(allTowersCompleted(final.towerProgress), true);
  });
});

test('LIV-14 integration: a legacy single-character save migrates to a one-member party', () => {
  const legacy = createPlayer('fighter', 'char_slot_9');
  legacy.level = 7;
  legacy.xp = 123;
  legacy.gold = 999;
  legacy.levelKeys = { 1: { copper: true } };
  legacy.towerProgress = undefined;
  assert.equal(legacy.party, undefined, 'pre-party save has no party');

  const migrated = migratePlayerParty(legacy);
  assert.equal(migrated.party.length, 1, 'criterion 9: legacy save becomes a one-member party');
  assert.equal(migrated.party[0].vocation, 'fighter');
  assert.equal(migrated.party[0].level, 7, 'level survives migration');
  assert.equal(migrated.party[0].gold, 999);
  assert.deepEqual(migrated.levelKeys, { 1: { copper: true } }, 'keys live on the shared party store');
  assert.equal(migrated.party[0].levelKeys, undefined, 'keys are party-shared, not per member');
  assert.equal(migrated.activeMemberId, migrated.party[0].memberId);
  assert.deepEqual(migrated.towerProgress.unlockedTowerIds, [firstTowerId()]);
  assert.equal(migratePlayerParty(migrated), migrated, 'migration is idempotent');
});

test('LIV-14 integration: app wiring routes completion into Recruit and gates victory', () => {
  const source = readControllerSources();

  // Completion goes through the worker campaign command and the recruit flow.
  assert.match(source, /gameClient\.completeTower\(/, 'completion is persisted via the worker');
  assert.match(source, /showTowerCompleteModal\(/, 'the non-terminal Tower Complete card is shown');
  assert.match(source, /showRecruitModal\(/, 'the Recruit picker is offered');
  assert.match(source, /gameClient\.recruitMember\(/, 'the chosen recruit is persisted');
  assert.match(source, /proceedToNextTower\(/, 'the campaign advances to the next tower');

  // The terminal victory screen is reserved for a fully cleared campaign.
  const floorController = readFileSync(
    resolve(process.cwd(), 'html', 'app', 'floor-controller.js'),
    'utf8'
  );
  const gate = floorController.match(/if \(data\.allComplete\) \{([\s\S]*?)\n    \}/);
  assert.ok(gate, 'floor-controller branches on the all-towers flag');
  assert.match(gate[1], /showVictoryModal\(/, 'the terminal victory screen is inside the allComplete branch');

  // Allies are driven by the party AI each frame.
  assert.match(source, /PartyAI\.updateAllies\(/, 'the loop drives the party AI');
});
