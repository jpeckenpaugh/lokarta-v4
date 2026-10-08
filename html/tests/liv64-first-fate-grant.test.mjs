/**
 * LIV-64 — Fate Grant on first quest accept (starter equipment)
 *
 * Board feedback: the player started with no weapon and no way to attack.
 * Accepting the first eligible quest (Q1 "Rats in the Gutter") must open the
 * Fate Grant draft so the player is armed. Covers:
 *   - the data-driven trigger (`quests.json` `onAccept`, no per-quest JS branch);
 *   - the engine surface (`acceptQuest` returns the accept effects exactly once);
 *   - the app dispatch (accept closes the dialogue and opens the Level-1 grant);
 *   - idempotency (re-accept / reload never duplicates the grant);
 *   - the tower-entry fallback no longer double-fires after the grant; and
 *   - Q1's turn-in rewards staying intact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  QUEST_STATUS,
  acceptQuest,
  getQuestStatus,
  recordEvent,
  turnInQuest,
} from '../engine/quest-system.js';
import { createPartyPlayer } from '../engine/party.js';
import { FateGrantSystem } from '../engine/fate-grant-system.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
import {
  QUESTS_CATALOG,
  VOCATIONS_CATALOG,
  ITEMS_CATALOG,
  getQuestDefinition,
} from '../data/index.js';

/** Minimal app stub mirroring the LIV-60 dialogue test seam. */
function fakeApp(player) {
  const calls = { logs: [], hud: 0, saves: 0, resumed: 0, grants: [] };
  return Object.assign({}, sceneControllerMethods, {
    calls,
    player,
    _sceneInteraction: false,
    townEl: null,
    logCombat: (msg) => calls.logs.push(msg),
    updateHUD: () => { calls.hud += 1; },
    persistSave: () => { calls.saves += 1; return Promise.resolve(); },
    showTown: () => { calls.resumed += 1; },
    showFateGrantModal: (level) => { calls.grants.push(level); },
    ModalManager: null,
  });
}

/** Item ids across every container (hotbar, backpack, paperdoll). */
function ownedItemIds(player) {
  return [...(player.action_bar || []), ...(player.backpack || []), ...Object.values(player.paperdoll || {})]
    .filter(Boolean)
    .map((it) => it.item_id);
}

test('LIV-64: first quest accept arms the player with a Fate Grant', async (t) => {
  await t.test('Q1 declares the accept-time grant as catalog data', () => {
    const q1 = getQuestDefinition('rats_in_the_gutter');
    assert.ok(Array.isArray(q1.onAccept), 'Q1 carries an onAccept effect list');
    const grant = q1.onAccept.find((e) => e.type === 'fate_grant');
    assert.ok(grant, 'Q1 arms the player on accept');
    assert.equal(grant.level, 1, 'the accept grant is the Level-1 draft');

    // No per-quest JS branch: only the first eligible quest declares the hook.
    assert.equal(getQuestDefinition('the_lantern_wreck').onAccept, undefined);
    assert.equal(getQuestDefinition('rite_of_the_beacon').onAccept, undefined);
    for (const quest of QUESTS_CATALOG.quests) {
      for (const effect of quest.onAccept || []) {
        assert.equal(effect.type, 'fate_grant', `${quest.id} onAccept effect is a known type`);
      }
    }
  });

  await t.test('acceptQuest surfaces onAccept once and never on re-accept', () => {
    const player = createPartyPlayer('magician');
    const state = player.questState;

    const first = acceptQuest(state, player, 'rats_in_the_gutter');
    assert.equal(first.ok, true);
    assert.deepEqual(first.onAccept, [{ type: 'fate_grant', level: 1 }]);

    const again = acceptQuest(state, player, 'rats_in_the_gutter');
    assert.equal(again.ok, false, 're-accept is a guarded no-op');
    assert.deepEqual(again.onAccept, [], 'no accept-time effects replay');
  });

  await t.test('accepting from dialogue opens the Level-1 grant and resumes the scene', () => {
    const player = createPartyPlayer('fighter');
    const app = fakeApp(player);
    app.acceptQuestFromDialogue('rats_in_the_gutter', {});

    assert.equal(getQuestStatus(player.questState, 'rats_in_the_gutter'), QUEST_STATUS.ACTIVE);
    assert.deepEqual(app.calls.grants, [1], 'the Level-1 Fate Grant opened exactly once');
    assert.equal(app.calls.resumed, 1, 'the dialogue closed and the scene resumed');
  });

  await t.test('re-accept is idempotent at the app layer (no duplicate grant)', () => {
    const player = createPartyPlayer('paladin');
    const app = fakeApp(player);
    app.acceptQuestFromDialogue('rats_in_the_gutter', {});
    app.acceptQuestFromDialogue('rats_in_the_gutter', {});
    assert.deepEqual(app.calls.grants, [1], 'a second accept never re-opens the grant');
  });

  await t.test('the grant equips a weapon that can attack, for every vocation', () => {
    for (const vocation of Object.keys(VOCATIONS_CATALOG)) {
      const player = createPartyPlayer(vocation);
      const offer = FateGrantSystem.generateDraftOffer(player, 1, { rankCapOwner: player });
      const main = offer.cards.find((c) => FateGrantSystem.resolveCardSlot(c) === 'main_hand');
      const off = offer.cards.find((c) => FateGrantSystem.resolveCardSlot(c) === 'off_hand');
      assert.ok(main, `${vocation} level-1 offer includes a main_hand`);
      assert.ok(off, `${vocation} level-1 offer includes an off_hand`);

      FateGrantSystem.applyDraftedCards(player, [main, off].slice(0, offer.requiredSelections.min), null, { rankCapOwner: player });

      const weapon = player.paperdoll.main_hand;
      assert.ok(weapon, `${vocation} is armed after the grant`);
      const actionKey = weapon.actionKey || ITEMS_CATALOG[weapon.item_id]?.actionKey;
      assert.ok(actionKey, `${vocation} starter weapon declares an actionKey (can attack)`);
    }
  });

  await t.test('tower-entry fallback does not double-fire after the grant', () => {
    const player = createPartyPlayer('archer');
    assert.equal(FateGrantSystem.needsStarterGrant(player, 1), true, 'a fresh no-weapon actor still needs the grant');

    const offer = FateGrantSystem.generateDraftOffer(player, 1, { rankCapOwner: player });
    const main = offer.cards.find((c) => FateGrantSystem.resolveCardSlot(c) === 'main_hand');
    FateGrantSystem.applyDraftedCards(player, [main], null, { rankCapOwner: player });

    assert.ok(player.paperdoll.main_hand, 'the grant equips the weapon to the paperdoll');
    assert.ok(player.action_bar.every((s) => s === null), 'the hotbar is left empty');
    assert.equal(FateGrantSystem.needsStarterGrant(player, 1), false,
      'the tower-entry fallback sees an armed actor and stays quiet');
  });

  await t.test('Q1 turn-in rewards (vocation starter weapon) remain intact', () => {
    const player = createPartyPlayer('paladin');
    const state = player.questState;
    acceptQuest(state, player, 'rats_in_the_gutter');
    for (let i = 0; i < 6; i++) recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });
    recordEvent(state, { type: 'kill', monsterType: 'gutter_king' });

    const res = turnInQuest(state, player, 'rats_in_the_gutter');
    assert.equal(res.ok, true);
    assert.ok(ownedItemIds(player).includes('consecrated_warhammer'),
      'the paladin turn-in starter weapon is still granted');
    assert.equal(getQuestStatus(state, 'rats_in_the_gutter'), QUEST_STATUS.TURNED_IN);
  });

  await t.test('the accept hook is dispatched by effect type, not a quest id branch', () => {
    const source = readFileSync(resolve(process.cwd(), 'html', 'app', 'scene-controller.js'), 'utf8');
    assert.match(source, /const QUEST_ON_ACCEPT_HANDLERS = \{/, 'accept effects use a dispatch table');
    assert.match(source, /fate_grant: \(app, effect\)/, 'the fate_grant effect has a handler');
    assert.doesNotMatch(source, /questId === 'rats_in_the_gutter'/, 'no hard-coded per-quest branch');
  });
});
