import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneControllerMethods } from '../app/scene-controller.js';
import { createPartyPlayer } from '../engine/party.js';
import { acceptQuest, recordEvent } from '../engine/quest-system.js';
import {
  getDialogueDefinition,
  listDialogueDefinitions,
  NPCS_CATALOG,
} from '../data/index.js';

// LIV-60 P2/P3: dialogue referential integrity + the accept/turn-in action
// wiring on a fake app (no DOM, no canvas).

function fakeApp(player) {
  const calls = { logs: [], hud: 0, saves: 0, resumed: 0 };
  return Object.assign({}, sceneControllerMethods, {
    calls,
    player,
    _sceneInteraction: false,
    townEl: null,
    logCombat: (msg) => calls.logs.push(msg),
    updateHUD: () => { calls.hud += 1; },
    persistSave: () => { calls.saves += 1; return Promise.resolve(); },
    showTown: () => { calls.resumed += 1; },
    ModalManager: null,
  });
}

test('LIV-60 dialogue & quest actions', async (t) => {
  await t.test('every dialogue tree has a resolvable fallback stage', () => {
    const dialogues = listDialogueDefinitions();
    assert.ok(Object.keys(dialogues).length >= 8);
    for (const [id, def] of Object.entries(dialogues)) {
      assert.ok(Array.isArray(def.stages) && def.stages.length > 0, `${id} has stages`);
      if (def.fallback) {
        assert.ok(def.stages.some((s) => s.id === def.fallback), `${id} fallback resolves`);
      }
    }
  });

  await t.test('every NPC dialogue id referenced by the catalog resolves', () => {
    for (const npc of NPCS_CATALOG.npcs) {
      const id = npc.defaultDialogueId || npc.interact?.dialogueId;
      assert.ok(getDialogueDefinition(id), `${npc.id} -> ${id}`);
    }
  });

  await t.test('acceptQuestFromDialogue activates Q1 and resumes the scene', () => {
    const player = createPartyPlayer('magician');
    const app = fakeApp(player);
    app.acceptQuestFromDialogue('rats_in_the_gutter', {});
    assert.equal(player.questState.quests.rats_in_the_gutter.status, 'active');
    assert.ok(app.calls.logs.length >= 1, 'new-quest cue logged');
    assert.equal(app.calls.resumed, 1, 'scene resumed after action');
  });

  await t.test('turnInQuestFromDialogue grants rewards and resumes the scene', () => {
    const player = createPartyPlayer('fighter');
    const state = player.questState;
    acceptQuest(state, player, 'rats_in_the_gutter');
    for (let i = 0; i < 6; i++) recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });
    recordEvent(state, { type: 'kill', monsterType: 'gutter_king' });

    const app = fakeApp(player);
    app.turnInQuestFromDialogue('rats_in_the_gutter', {});
    assert.equal(state.quests.rats_in_the_gutter.status, 'turned_in');
    assert.equal(player.level, 2, 'quest XP applied through the reward dispatch table');
    assert.equal(app.calls.resumed, 1);
    assert.ok(app.calls.logs.some((m) => /complete/i.test(m)), 'turn-in cue logged');
  });

  await t.test('unknown dialogue actions close without stranding', () => {
    const player = createPartyPlayer('magician');
    const app = fakeApp(player);
    app.handleDialogueAction({ type: 'does_not_exist' }, {});
    assert.equal(app.calls.resumed, 1);
  });

  await t.test('world interact requires the item and emits the interact event', () => {
    const player = createPartyPlayer('magician');
    const app = fakeApp(player);
    acceptQuest(player.questState, player, 'rats_in_the_gutter');
    // Missing the lantern -> warning path, still resumes.
    app.handleWorldInteract({ type: 'interact', requiresItem: 'dawn_lantern' }, { targetId: 'drowned_shrine_rite' });
    assert.equal(app.calls.resumed, 1);
    assert.ok(app.calls.logs.some((m) => /Dawn Lantern/i.test(m)));
  });
});
