import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUEST_STATUS,
  createQuestState,
  createWorldFlags,
  normalizeQuestState,
  ensureQuestState,
  getQuestStatus,
  getObjectiveCount,
  canAcceptQuest,
  acceptQuest,
  canTurnIn,
  recordEvent,
  turnInQuest,
  applyRewards,
  dialogueSnapshot,
  selectDialogueStage,
  questLogEntries,
  OBJECTIVE_HANDLERS,
  REWARD_HANDLERS,
} from '../engine/quest-system.js';
import { createPartyPlayer, migratePlayerParty } from '../engine/party.js';
import { InventorySystem } from '../engine/inventory-system.js';
import { GridMap } from '../engine/grid-map.js';
import { QUESTS_CATALOG, getQuestDefinition } from '../data/index.js';

// LIV-60 P3: the browser-free quest state machine. Exercises every objective
// and reward kind in `quests.json`, prerequisite/level gating, idempotent
// turn-in, and the full Q1 -> Q2 -> Q3 chain (including the Spire unlock).

function freshPlayer(vocation = 'magician') {
  return createPartyPlayer(vocation);
}

test('LIV-60 quest system', async (t) => {
  await t.test('state creation + idempotent normalization', () => {
    const fresh = createQuestState();
    assert.deepEqual(fresh, { version: 1, quests: {} });
    assert.equal(normalizeQuestState(fresh), fresh, 'clean state returns the same ref');

    const dirty = {
      version: 1,
      quests: {
        rats_in_the_gutter: { status: 'active', objectives: { clear_crawlers: 99, slay_gutter_king: -4 } },
        not_a_real_quest: { status: 'active', objectives: {} },
        the_lantern_wreck: { status: 'bogus', objectives: {} },
      },
    };
    const normalized = normalizeQuestState(dirty);
    assert.equal(normalized.quests.not_a_real_quest, undefined, 'unknown quest dropped');
    assert.equal(normalized.quests.the_lantern_wreck, undefined, 'invalid status dropped');
    // Counters clamp to the catalog counts (crawlers 6, king 1; negatives -> 0).
    assert.equal(normalized.quests.rats_in_the_gutter.objectives.clear_crawlers, 6);
    assert.equal(normalized.quests.rats_in_the_gutter.objectives.slay_gutter_king, 0);
    assert.equal(normalizeQuestState(normalized), normalized, 'stable second pass');
  });

  await t.test('migratePlayerParty backfills questState + worldFlags', () => {
    const legacy = migratePlayerParty({});
    assert.deepEqual(legacy.questState, { version: 1, quests: {} });
    assert.deepEqual(legacy.worldFlags, {});
    assert.equal(migratePlayerParty(legacy), legacy, 'idempotent');
  });

  await t.test('prerequisite + level gating', () => {
    const player = freshPlayer();
    ensureQuestState(player);
    const state = player.questState;

    assert.equal(canAcceptQuest(state, player, 'rats_in_the_gutter').ok, true);
    assert.equal(canAcceptQuest(state, player, 'the_lantern_wreck').reason, 'prerequisites');
    assert.equal(canAcceptQuest(state, player, 'rite_of_the_beacon').reason, 'prerequisites');
    assert.equal(canAcceptQuest(state, player, 'nope').reason, 'unknown_quest');

    acceptQuest(state, player, 'rats_in_the_gutter');
    assert.equal(getQuestStatus(state, 'rats_in_the_gutter'), QUEST_STATUS.ACTIVE);
    assert.equal(canAcceptQuest(state, player, 'rats_in_the_gutter').reason, 'already_started');
    // Q2 still gated until Q1 is turned in (active is not enough).
    assert.equal(canAcceptQuest(state, player, 'the_lantern_wreck').reason, 'prerequisites');
  });

  await t.test('objective dispatch covers all five trigger kinds', () => {
    for (const kind of ['talk', 'kill', 'fetch', 'reach', 'interact']) {
      assert.equal(typeof OBJECTIVE_HANDLERS[kind], 'function', `${kind} handler`);
    }
    // kill
    assert.equal(OBJECTIVE_HANDLERS.kill({ targetMonsterType: 'drowned_crawler' }, { type: 'kill', monsterType: 'drowned_crawler' }), 1);
    assert.equal(OBJECTIVE_HANDLERS.kill({ targetMonsterType: 'drowned_crawler' }, { type: 'kill', monsterType: 'tide_thrall' }), 0);
    // talk
    assert.equal(OBJECTIVE_HANDLERS.talk({ targetNpcId: 'captain_halden' }, { type: 'talk', npcId: 'captain_halden' }), 1);
    // fetch
    assert.equal(OBJECTIVE_HANDLERS.fetch({ itemId: 'beacon_lens' }, { type: 'fetch', itemId: 'beacon_lens' }), 1);
    // reach (radius)
    assert.equal(OBJECTIVE_HANDLERS.reach({ sceneId: 'island_dawnreach', x: 9, y: 20, radius: 1 }, { type: 'reach', sceneId: 'island_dawnreach', x: 10, y: 21 }), 1);
    assert.equal(OBJECTIVE_HANDLERS.reach({ sceneId: 'island_dawnreach', x: 9, y: 20, radius: 1 }, { type: 'reach', sceneId: 'island_dawnreach', x: 12, y: 20 }), 0);
    assert.equal(OBJECTIVE_HANDLERS.reach({ sceneId: 'island_dawnreach', x: 9, y: 20, radius: 1 }, { type: 'reach', sceneId: 'town_havenreach', x: 9, y: 20 }), 0);
    // interact
    assert.equal(OBJECTIVE_HANDLERS.interact({ targetId: 'drowned_shrine_rite' }, { type: 'interact', targetId: 'drowned_shrine_rite' }), 1);
  });

  await t.test('Q1 kill objectives complete and turn in grants L2 + gear + gold', () => {
    const player = freshPlayer('magician');
    ensureQuestState(player);
    const state = player.questState;
    acceptQuest(state, player, 'rats_in_the_gutter');

    for (let i = 0; i < 6; i++) recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });
    assert.equal(getObjectiveCount(state, 'rats_in_the_gutter', 'clear_crawlers'), 6);
    assert.equal(getQuestStatus(state, 'rats_in_the_gutter'), QUEST_STATUS.ACTIVE, 'elite still outstanding');

    recordEvent(state, { type: 'kill', monsterType: 'gutter_king' });
    assert.equal(getQuestStatus(state, 'rats_in_the_gutter'), QUEST_STATUS.COMPLETE);
    assert.equal(canTurnIn(state, 'rats_in_the_gutter'), true);

    const res = turnInQuest(state, player, 'rats_in_the_gutter');
    assert.equal(res.ok, true);
    assert.equal(player.level, 2, '100 quest XP climbs 1 -> 2');
    assert.ok(player.gold >= 30, 'gold reward credited');
    const owned = [...(player.action_bar || []), ...(player.backpack || []), ...Object.values(player.paperdoll || {})]
      .filter(Boolean).map((it) => it.item_id);
    assert.ok(owned.includes('apprentice_wand'), 'magician vocation item granted');
  });

  await t.test('turn-in is idempotent (replay grants nothing)', () => {
    const player = freshPlayer();
    ensureQuestState(player);
    const state = player.questState;
    acceptQuest(state, player, 'rats_in_the_gutter');
    for (let i = 0; i < 6; i++) recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });
    recordEvent(state, { type: 'kill', monsterType: 'gutter_king' });

    const first = turnInQuest(state, player, 'rats_in_the_gutter');
    const goldAfterFirst = player.gold;
    const second = turnInQuest(state, player, 'rats_in_the_gutter');
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.alreadyTurnedIn, true);
    assert.equal(player.gold, goldAfterFirst, 'no double reward');
    assert.equal(getQuestStatus(state, 'rats_in_the_gutter'), QUEST_STATUS.TURNED_IN);
  });

  await t.test('reward dispatch covers all five kinds', () => {
    for (const kind of ['xp', 'gold', 'item', 'unlock_tower', 'set_flag']) {
      assert.equal(typeof REWARD_HANDLERS[kind], 'function', `${kind} reward handler`);
    }
    const player = freshPlayer();
    const effects = applyRewards(player, {
      rewards: [
        { type: 'set_flag', flag: 'beaconLit', value: true },
        { type: 'unlock_tower', towerId: 'spire_of_light' },
      ],
    });
    assert.equal(player.worldFlags.beaconLit, true);
    assert.ok(player.towerProgress.unlockedTowerIds.includes('spire_of_light'));
    assert.equal(effects.length, 2);
  });

  await t.test('full Q1 -> Q2 -> Q3 chain unlocks the Spire', () => {
    const player = freshPlayer('archer');
    ensureQuestState(player);
    const state = player.questState;

    // --- Q1 ---
    assert.equal(acceptQuest(state, player, 'rats_in_the_gutter').ok, true);
    for (let i = 0; i < 6; i++) recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });
    recordEvent(state, { type: 'kill', monsterType: 'gutter_king' });
    turnInQuest(state, player, 'rats_in_the_gutter');
    assert.equal(player.level, 2);
    const weapons = [...(player.action_bar || []), ...(player.backpack || []), ...Object.values(player.paperdoll || {})]
      .filter(Boolean).map((it) => it.item_id);
    assert.ok(weapons.includes('wooden_bow'), 'archer vocation item granted');

    // --- Q2 ---
    assert.equal(acceptQuest(state, player, 'the_lantern_wreck').ok, true);
    recordEvent(state, { type: 'reach', sceneId: 'island_dawnreach', x: 9, y: 20 });
    recordEvent(state, { type: 'kill', monsterType: 'tide_thrall' });
    recordEvent(state, { type: 'kill', monsterType: 'tide_thrall' });
    recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });
    recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });
    recordEvent(state, { type: 'fetch', itemId: 'beacon_lens' });
    assert.equal(getQuestStatus(state, 'the_lantern_wreck'), QUEST_STATUS.COMPLETE, 'Q2 complete');
    turnInQuest(state, player, 'the_lantern_wreck');
    assert.equal(player.level, 3, '200 quest XP climbs 2 -> 3');
    const all = [...(player.action_bar || []), ...(player.backpack || []), ...Object.values(player.paperdoll || {})]
      .filter(Boolean).map((it) => it.item_id);
    assert.ok(all.includes('dawn_lantern'), 'Dawn Lantern granted');

    // --- Q3 (levelGuard minLevel 3 now satisfied) ---
    const acceptQ3 = acceptQuest(state, player, 'rite_of_the_beacon');
    assert.equal(acceptQ3.ok, true);
    recordEvent(state, { type: 'reach', sceneId: 'island_dawnreach', x: 39, y: 22 });
    recordEvent(state, { type: 'interact', targetId: 'drowned_shrine_rite' });
    recordEvent(state, { type: 'kill', monsterType: 'shrine_warden' });
    assert.equal(getQuestStatus(state, 'rite_of_the_beacon'), QUEST_STATUS.COMPLETE, 'Q3 complete');

    const turned = turnInQuest(state, player, 'rite_of_the_beacon');
    assert.equal(turned.ok, true);
    assert.equal(player.level, 4, '300 quest XP climbs 3 -> 4');
    // Acceptance criterion 3: Q3 sets the Spire unlock in quest/world state.
    assert.ok(player.towerProgress.unlockedTowerIds.includes('spire_of_light'));
    assert.equal(player.worldFlags.beaconLit, true);
    const effectTypes = turned.rewards.map((r) => r.type);
    assert.ok(effectTypes.includes('unlock_tower'));
    assert.ok(effectTypes.includes('set_flag'));
  });

  await t.test('dialogue stage selection tracks quest status + flags', () => {
    const player = freshPlayer();
    ensureQuestState(player);
    const state = player.questState;
    const halden = { stages: [
      { id: 'turned_in', when: { questId: 'rats_in_the_gutter', status: 'turned_in' } },
      { id: 'complete', when: { questId: 'rats_in_the_gutter', status: 'complete' } },
      { id: 'active', when: { questId: 'rats_in_the_gutter', status: 'active' } },
      { id: 'offer', when: {} },
    ], fallback: 'offer' };

    assert.equal(selectDialogueStage(halden, dialogueSnapshot(state, player)).id, 'offer');
    acceptQuest(state, player, 'rats_in_the_gutter');
    assert.equal(selectDialogueStage(halden, dialogueSnapshot(state, player)).id, 'active');
    for (let i = 0; i < 6; i++) recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });
    recordEvent(state, { type: 'kill', monsterType: 'gutter_king' });
    assert.equal(selectDialogueStage(halden, dialogueSnapshot(state, player)).id, 'complete');
    turnInQuest(state, player, 'rats_in_the_gutter');
    assert.equal(selectDialogueStage(halden, dialogueSnapshot(state, player)).id, 'turned_in');

    // Flag + level conditions.
    assert.equal(selectDialogueStage({ stages: [{ id: 'lit', when: { flag: 'beaconLit' } }], fallback: 'lit' }, dialogueSnapshot(state, player)).id, 'lit');
    const levelGated = { stages: [{ id: 'veteran', when: { levelMin: 10 } }, { id: 'greet', when: {} }], fallback: 'greet' };
    assert.equal(selectDialogueStage(levelGated, dialogueSnapshot(state, player)).id, 'greet');
  });

  await t.test('quest log entries expose objective progress for the HUD', () => {
    const player = freshPlayer();
    ensureQuestState(player);
    acceptQuest(player.questState, player, 'rats_in_the_gutter');
    recordEvent(player.questState, { type: 'kill', monsterType: 'drowned_crawler' });
    const entries = questLogEntries(player.questState);
    const rats = entries.find((e) => e.questId === 'rats_in_the_gutter');
    assert.ok(rats);
    const crawlers = rats.objectives.find((o) => o.id === 'clear_crawlers');
    assert.equal(crawlers.count, 1);
    assert.equal(crawlers.target, 6);
    assert.equal(typeof crawlers.logKey, 'string');
  });

  await t.test('quest items are non-droppable', () => {
    const player = freshPlayer();
    const grid = new GridMap(8, 8);
    // Place a quest item (`items.json` droppable:false) directly in the backpack.
    player.backpack[0] = { item_id: 'beacon_lens', name: 'Beacon Lens', quantity: 1, droppable: false };
    const res = InventorySystem.dropItem(player, 'backpack', 0, grid);
    assert.equal(res.success, false);
    assert.match(res.message, /cannot be dropped/i);
    assert.ok(player.backpack[0], 'item stays in the inventory');
  });

  await t.test('catalog quests reference the five objective/reward dispatch types', () => {
    const objectiveTypes = new Set();
    const rewardTypes = new Set();
    for (const quest of Object.values(QUESTS_CATALOG)) {
      for (const obj of quest.objectives || []) objectiveTypes.add(obj.type);
      for (const reward of quest.rewards || []) rewardTypes.add(reward.type);
    }
    for (const type of objectiveTypes) assert.equal(typeof OBJECTIVE_HANDLERS[type], 'function', `handler for objective ${type}`);
    for (const type of rewardTypes) assert.equal(typeof REWARD_HANDLERS[type], 'function', `handler for reward ${type}`);
    assert.ok(getQuestDefinition('rite_of_the_beacon').rewards.some((r) => r.type === 'unlock_tower'));
  });

  await t.test('world flag helper exists for new saves', () => {
    assert.deepEqual(createWorldFlags(), {});
  });
});
