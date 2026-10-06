/**
 * LIV-29 FIX-14 — Options "Recruit Character" debug action.
 *
 * Board T2 feedback round 3, item 3: an Options-menu debug action that
 * auto-picks the next vocation not on the party, recruits it as the active
 * member at level 1, triggers its Level-1 Fate Grant, and repeats until the
 * party cap. Covers:
 *   - deterministic auto-selection (`nextRecruitVocation`) + cap handling;
 *   - the live-game guard (`canDebugRecruit`);
 *   - the Options modal rendering/hiding the action; and
 *   - the app wiring that recruits, assumes control, persists, and offers the
 *     Level-1 Fate Grant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createPartyPlayer,
  canRecruit,
  nextRecruitVocation,
  recruitMember,
} from '../engine/index.js';
import { VOCATIONS_CATALOG } from '../data/index.js';
import { ModalManager } from '../app/modal-manager.js';
import { LokartaApp } from '../app/app-controller.js';
import { normalizeOptions } from '../services/save-slots.js';

const VOCATIONS = Object.keys(VOCATIONS_CATALOG);

/** Minimal modal overlay stub: captures rendered HTML, ignores event binds. */
function makeOverlay() {
  return {
    _keyHandler: null,
    classList: { add() {}, remove() {}, contains() { return false; } },
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

describe('LIV-29 debug recruit: deterministic auto-selection', () => {
  it('picks the next catalog vocation not on the party, one per vocation', () => {
    const player = createPartyPlayer('magician');
    const expectedFirst = VOCATIONS.find((v) => v !== 'magician');
    assert.equal(nextRecruitVocation(player), expectedFirst, 'first missing vocation in catalog order');

    recruitMember(player, expectedFirst);
    const owned = new Set(player.party.map((m) => m.vocation));
    assert.ok(!owned.has(nextRecruitVocation(player)), 'never re-picks an owned vocation');
  });

  it('returns null and reports not-recruitable once the party is full', () => {
    const player = createPartyPlayer('magician');
    while (canRecruit(player)) {
      recruitMember(player, nextRecruitVocation(player));
    }
    assert.equal(player.party.length, VOCATIONS.length, 'one member per vocation');
    assert.equal(nextRecruitVocation(player), null, 'no vocation left to add');
    assert.equal(canRecruit(player), false);
  });
});

describe('LIV-29 debug recruit: live-game guard', () => {
  it('only offers the action in a live, non-full game', () => {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPartyPlayer('magician');

    app.isInGameplay = false;
    assert.equal(app.canDebugRecruit(), false, 'title screen (stale player) is excluded');

    app.isInGameplay = true;
    assert.equal(app.canDebugRecruit(), true, 'live game with a missing vocation qualifies');

    while (canRecruit(app.player)) recruitMember(app.player, nextRecruitVocation(app.player));
    assert.equal(app.canDebugRecruit(), false, 'full party is excluded');

    app.player = null;
    assert.equal(app.canDebugRecruit(), false, 'no player is excluded');
  });
});

describe('LIV-29 debug recruit: Options modal', () => {
  it('renders the action only when a recruit is possible, and as an action not a toggle', () => {
    const shown = makeOverlay();
    ModalManager.showOptionsModal(shown, normalizeOptions(null), {}, { canRecruitCharacter: true });
    assert.match(shown.innerHTML, /Recruit Character/, 'action label is rendered');
    assert.match(shown.innerHTML, /id="options-recruit-character"/, 'action button is rendered');
    assert.doesNotMatch(shown.innerHTML, /data-toggle="recruitCharacter"/, 'action is not a toggle');

    const hidden = makeOverlay();
    ModalManager.showOptionsModal(hidden, normalizeOptions(null), {}, { canRecruitCharacter: false });
    assert.doesNotMatch(hidden.innerHTML, /options-recruit-character/, 'hidden when no recruit remains');
  });
});

describe('LIV-29 debug recruit: app wiring', () => {
  function makeApp() {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPartyPlayer('magician');
    app.player.slotIndex = 2;
    app.isInGameplay = true;

    const calls = { recruit: [], grantLevels: [], saves: 0, logs: [] };
    app.gameClient = {
      recruitMember: async (slotIndex, vocation) => {
        calls.recruit.push({ slotIndex, vocation });
        const clone = JSON.parse(JSON.stringify(app.player));
        const member = recruitMember(clone, vocation);
        return { player: clone, member, recruitableVocations: [] };
      },
    };
    app.updateHUD = () => {};
    app.persistSave = async () => { calls.saves += 1; };
    app.logCombat = (message) => { calls.logs.push(message); };
    app.showFateGrantModal = (level) => { calls.grantLevels.push(level); };
    return { app, calls };
  }

  it('recruits the next vocation, assumes control, persists, and offers the Level-1 Fate Grant', async () => {
    const { app, calls } = makeApp();
    const expected = VOCATIONS.find((v) => v !== 'magician');

    await app.recruitCharacterDebug();

    assert.deepEqual(calls.recruit, [{ slotIndex: 2, vocation: expected }], 'recruited via the worker RPC');
    assert.ok(app.player.party.some((m) => m.vocation === expected), 'new member is on the party');
    assert.equal(app.player.activeMemberId, `member_${expected}`, 'assumed control of the recruit');
    assert.equal(app.player.level, 1, 'debug recruit starts at level 1');
    assert.deepEqual(calls.grantLevels, [1], 'Level-1 Fate Grant is offered');
    assert.equal(calls.saves, 1, 'the recruit is persisted');
    assert.ok(calls.logs.some((m) => /joins the party at Level 1/.test(m)), 'a join cue is logged');
  });

  it('is repeatable up to the cap, then a guarded no-op', async () => {
    const { app, calls } = makeApp();
    await app.recruitCharacterDebug();
    await app.recruitCharacterDebug();
    await app.recruitCharacterDebug();

    assert.equal(calls.recruit.length, 3, 'three more vocations added');
    assert.equal(app.player.party.length, VOCATIONS.length, 'four-member party');
    assert.deepEqual(calls.grantLevels, [1, 1, 1], 'each recruit gets the Level-1 grant');
    assert.equal(app.canDebugRecruit(), false, 'action is no longer offered');

    await app.recruitCharacterDebug();
    assert.equal(calls.recruit.length, 3, 'a full party is a no-op');
  });

  it('wires the action through the Options modal and the save controller', () => {
    const modal = readFileSync(resolve(process.cwd(), 'html', 'app', 'modal-manager.js'), 'utf8');
    assert.match(modal, /id="options-recruit-character"/, 'modal renders the action button');
    assert.match(modal, /callbacks\.onRecruitCharacter\?\.\(\)/, 'modal dispatches the callback');

    const save = readFileSync(resolve(process.cwd(), 'html', 'app', 'save-controller.js'), 'utf8');
    assert.match(save, /onRecruitCharacter: \(\) => this\.recruitCharacterDebug\(\)/, 'options wires the handler');
    assert.match(save, /canRecruitCharacter: this\.canDebugRecruit\(\)/, 'options passes the live guard');
    assert.match(save, /this\.showFateGrantModal\(1\)/, 'the recruit leads into the Level-1 Fate Grant');
  });
});
