import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ISLANDS_CATALOG,
  TOWNS_CATALOG,
  NPCS_CATALOG,
  QUESTS_CATALOG,
  DIALOGUES_CATALOG,
  MONSTERS_CATALOG,
  ITEMS_CATALOG,
  TILE_THEMES_CATALOG,
  isTowerId,
  getSceneDefinition,
  getNpcDefinition,
  getDialogueDefinition,
} from '../data/index.js';
import { COMMAND_HANDLERS } from '../worker/game-worker.js';

// LIV-59 P0: island/town/NPC/quest/dialogue catalogs are pure data with
// referential integrity, and the worker exposes the getScene RPC. No per-scene
// branches in JS — these tests are what freezes the catalog contract.

const OBJECTIVE_TYPES = new Set(['talk', 'kill', 'fetch', 'reach', 'interact']);
const REWARD_TYPES = new Set(['xp', 'gold', 'item', 'unlock_tower', 'set_flag']);
const INTERACTION_TYPES = new Set(['shop', 'temple', 'dialogue', 'quest_turnin', 'heal']);

test('LIV-59 scene & quest catalogs', async (t) => {
  await t.test('islands.json authors a valid, rectangular Dawnreach Isle', () => {
    const islands = ISLANDS_CATALOG.islands;
    assert.ok(Array.isArray(islands) && islands.length >= 1);
    for (const island of islands) {
      assert.ok(island.id, 'island id');
      assert.equal(island.map.length, island.height, `${island.id} map height`);
      for (const row of island.map) {
        assert.equal(row.length, island.width, `${island.id} row width`);
      }
      assert.ok(isTowerId(island.towerId), `${island.id} towerId must be a real tower`);
      assert.ok(getSceneDefinition(island.townId), `${island.id} townId must be a real town`);
      assert.ok(TILE_THEMES_CATALOG[island.theme], `${island.id} theme must resolve`);
      assert.equal(island.lighting, 'ambient');
      // Legend chars actually used by the map are all declared.
      const declared = new Set(Object.keys(island.legend));
      const used = new Set(island.map.join(''));
      for (const ch of used) assert.ok(declared.has(ch), `${island.id} uses undeclared legend char "${ch}"`);
      // Spawn inside bounds.
      assert.ok(island.spawn.x >= 0 && island.spawn.x < island.width);
      assert.ok(island.spawn.y >= 0 && island.spawn.y < island.height);
    }
  });

  await t.test('towns.json authors a valid Havenreach with dispatchable buildings', () => {
    const towns = TOWNS_CATALOG.towns;
    assert.ok(Array.isArray(towns) && towns.length >= 1);
    for (const town of towns) {
      assert.equal(town.map.length, town.height, `${town.id} map height`);
      for (const row of town.map) assert.equal(row.length, town.width, `${town.id} row width`);
      assert.ok(TILE_THEMES_CATALOG[town.theme], `${town.id} theme must resolve`);
      assert.equal(town.lighting, 'ambient');
      assert.ok(Array.isArray(town.buildings) && town.buildings.length >= 2, `${town.id} buildings`);
      for (const b of town.buildings) {
        assert.ok(b.id && b.name, `${town.id} building fields`);
        assert.ok(b.door && Number.isInteger(b.door.x) && Number.isInteger(b.door.y), `${b.id} door`);
        assert.ok(b.interaction && INTERACTION_TYPES.has(b.interaction.type), `${b.id} interaction type`);
      }
    }
  });

  await t.test('every portal resolves to a real scene or tower', () => {
    const scenes = [...ISLANDS_CATALOG.islands, ...TOWNS_CATALOG.towns];
    for (const scene of scenes) {
      assert.ok(Array.isArray(scene.portals), `${scene.id} portals`);
      for (const portal of scene.portals) {
        assert.ok(portal.id, `${scene.id} portal id`);
        assert.ok(Number.isInteger(portal.x) && Number.isInteger(portal.y), `${scene.id}/${portal.id} coords`);
        if (portal.towerId || portal.type === 'tower') {
          assert.ok(isTowerId(portal.towerId), `${scene.id}/${portal.id} towerId`);
        } else {
          assert.ok(portal.target && getSceneDefinition(portal.target.sceneId), `${scene.id}/${portal.id} target scene`);
        }
      }
    }
  });

  await t.test('npcs.json references real scenes, dialogues, and behaviors', () => {
    assert.ok(Array.isArray(NPCS_CATALOG.npcs));
    const aiTypes = new Set(['stationary', 'wander']);
    for (const npc of NPCS_CATALOG.npcs) {
      assert.ok(npc.id && npc.name, 'npc fields');
      assert.ok(getSceneDefinition(npc.sceneId), `${npc.id} sceneId`);
      assert.ok(aiTypes.has(npc.aiType), `${npc.id} aiType must be a neutral dispatch key`);
      assert.ok(typeof npc.spriteId === 'string' && npc.spriteId.length > 0, `${npc.id} spriteId`);
      assert.ok(Number.isInteger(npc.x) && Number.isInteger(npc.y), `${npc.id} coords`);
      if (npc.interact && npc.interact.dialogueId) {
        assert.ok(getDialogueDefinition(npc.interact.dialogueId), `${npc.id} interact dialogue`);
      }
      if (npc.defaultDialogueId) {
        assert.ok(getDialogueDefinition(npc.defaultDialogueId), `${npc.id} default dialogue`);
      }
      if (Array.isArray(npc.interact?.questIds)) {
        for (const questId of npc.interact.questIds) {
          assert.ok(QUESTS_CATALOG.quests.some((q) => q.id === questId), `${npc.id} quest ${questId}`);
        }
      }
    }
  });

  await t.test('quests.json uses typed objectives/rewards with referential integrity', () => {
    assert.ok(Array.isArray(QUESTS_CATALOG.quests) && QUESTS_CATALOG.quests.length === 3);
    const questIds = new Set(QUESTS_CATALOG.quests.map((q) => q.id));
    for (const quest of QUESTS_CATALOG.quests) {
      assert.ok(quest.giverNpcId && getNpcDefinition(quest.giverNpcId), `${quest.id} giver`);
      assert.ok(quest.turnInNpcId && getNpcDefinition(quest.turnInNpcId), `${quest.id} turn-in`);
      for (const prereq of quest.prerequisites || []) {
        assert.ok(questIds.has(prereq), `${quest.id} prerequisite ${prereq}`);
      }
      for (const obj of quest.objectives || []) {
        assert.ok(OBJECTIVE_TYPES.has(obj.type), `${quest.id}/${obj.id} objective type`);
        if (obj.type === 'kill') {
          assert.ok(MONSTERS_CATALOG[obj.targetMonsterType], `${quest.id}/${obj.id} monster`);
        }
        if (obj.type === 'fetch') {
          assert.ok(ITEMS_CATALOG[obj.itemId], `${quest.id}/${obj.id} item`);
        }
        if (obj.type === 'reach') {
          assert.ok(getSceneDefinition(obj.sceneId), `${quest.id}/${obj.id} scene`);
        }
      }
      for (const reward of quest.rewards || []) {
        assert.ok(REWARD_TYPES.has(reward.type), `${quest.id} reward type`);
        if (reward.type === 'item') {
          assert.ok(ITEMS_CATALOG[reward.itemId], `${quest.id} reward item ${reward.itemId}`);
          for (const itemId of Object.values(reward.vocationItems || {})) {
            assert.ok(ITEMS_CATALOG[itemId], `${quest.id} vocation item ${itemId}`);
          }
        }
        if (reward.type === 'unlock_tower') {
          assert.ok(isTowerId(reward.towerId), `${quest.id} unlock tower`);
        }
        if (reward.type === 'set_flag') {
          assert.ok(typeof reward.flag === 'string' && reward.flag.length > 0, `${quest.id} set_flag`);
        }
      }
    }
    // The chain terminates in a Spire unlock (LIV-55 D7).
    const terminal = QUESTS_CATALOG.quests.find((q) => (q.rewards || []).some((r) => r.type === 'unlock_tower'));
    assert.equal(terminal.rewards.find((r) => r.type === 'unlock_tower').towerId, 'spire_of_light');
  });

  await t.test('island ground items, quest spawns, and interactables reference real data', () => {
    for (const island of ISLANDS_CATALOG.islands) {
      for (const item of island.groundItems || []) {
        assert.ok(ITEMS_CATALOG[item.itemId], `${island.id} ground item ${item.itemId}`);
      }
      for (const spawn of island.questSpawns || []) {
        assert.ok(MONSTERS_CATALOG[spawn.monsterType], `${island.id} quest spawn ${spawn.monsterType}`);
      }
      for (const inter of island.interactables || []) {
        if (inter.requiresItem) assert.ok(ITEMS_CATALOG[inter.requiresItem], `${island.id} requiresItem ${inter.requiresItem}`);
      }
    }
  });

  await t.test('dialogues.json exposes the prompt keys scenes and NPCs reference', () => {
    for (const key of ['tide_gate_locked', 'tide_gate_open', 'drowned_shrine_rite']) {
      assert.ok(DIALOGUES_CATALOG.dialogues[key], `dialogue "${key}" must exist`);
    }
  });

  await t.test('the worker exposes the getScene RPC and keeps getFloor unchanged', () => {
    assert.equal(typeof COMMAND_HANDLERS.getScene, 'function');
    assert.equal(typeof COMMAND_HANDLERS.getFloor, 'function');
    assert.equal(typeof COMMAND_HANDLERS.selectTower, 'function');
    assert.equal(typeof COMMAND_HANDLERS.advanceFloor, 'function');
  });
});
