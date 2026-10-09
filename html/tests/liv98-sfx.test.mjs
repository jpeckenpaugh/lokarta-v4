/**
 * LIV-98: quest-ready fanfare + softened town -> isle exit sound — T0 tests.
 *
 * Covers the new `questReady` cue (catalog + fallback shape, distinct from the
 * per-step and turn-in cues, subordinate to the turn-in), the `applyQuestChanges`
 * firing site (fires on the completing transition, not on later recordEvent
 * ticks), and the softened `enterIsle` cue.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { SOUNDS_CATALOG } from '../data/index.js';
import { AudioSystem, soundFX } from '../audio/index.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
import {
  createQuestState,
  acceptQuest,
  recordEvent,
} from '../engine/quest-system.js';
import { createPartyPlayer } from '../engine/party.js';

const VALID_TYPES = ['sweep', 'sequence', 'composite'];

function fakeApp(overrides = {}) {
  return Object.assign({}, sceneControllerMethods, {
    logCombat: () => {},
    updateHUD: () => {},
    refreshQuestMarkers: () => {},
    persistSave: () => {},
  }, overrides);
}

test('LIV-98 quest-ready fanfare + softened isle exit', async (t) => {
  await t.test('questReady is defined, one-shot, and well shaped', () => {
    const def = SOUNDS_CATALOG.questReady;
    assert.ok(def, 'Missing sound definition for questReady');
    assert.notEqual(def.kind, 'ambient', 'questReady must be a one-shot');
    assert.ok(VALID_TYPES.includes(def.type), `Invalid questReady type: ${def.type}`);
    assert.ok(Number.isFinite(def.gain) && def.gain > 0, 'questReady needs a positive gain');
    assert.ok(Array.isArray(def.notes) && def.notes.length > 0, 'questReady needs notes');
    for (const note of def.notes) {
      assert.ok(Number.isFinite(note.freq) && note.freq > 0, 'questReady note needs a freq');
      assert.ok(Number.isFinite(note.time) && note.time >= 0, 'questReady note needs a time');
      assert.ok(Number.isFinite(note.duration) && note.duration > 0, 'questReady note needs a duration');
    }
  });

  await t.test('questReady is distinct from the step cue and subordinate to turn-in', () => {
    const asKey = (def) => JSON.stringify(def);
    assert.notEqual(asKey(SOUNDS_CATALOG.questReady), asKey(SOUNDS_CATALOG.questObjective),
      'questReady must differ from the per-step cue');
    assert.notEqual(asKey(SOUNDS_CATALOG.questReady), asKey(SOUNDS_CATALOG.questComplete),
      'questReady must differ from the turn-in fanfare');
    // Subordinate: quieter and shorter overall than the turn-in celebration.
    assert.ok(SOUNDS_CATALOG.questReady.gain <= SOUNDS_CATALOG.questComplete.gain,
      'questReady must be no louder than questComplete');
    const span = (def) => Math.max(...def.notes.map((n) => n.time + n.duration));
    assert.ok(span(SOUNDS_CATALOG.questReady) < span(SOUNDS_CATALOG.questComplete),
      'questReady must end sooner than questComplete');
  });

  await t.test('applyQuestChanges plays questReady on the completing transition', () => {
    const app = fakeApp();
    const calls = [];
    const spy = mock.method(soundFX, 'play', (key) => { calls.push(key); });
    try {
      app.applyQuestChanges([{ questId: 'q1', questName: 'Q1', objectiveId: 'obj', count: 1, target: 2 }]);
      assert.deepEqual(calls, ['questObjective'], 'non-completing batch keeps the step cue');

      calls.length = 0;
      app.applyQuestChanges([{ questId: 'q1', questName: 'Q1', completed: true, status: 'complete' }]);
      assert.deepEqual(calls, ['questReady'], 'completing batch plays the requirements-met fanfare');
    } finally {
      spy.mock.restore();
    }
  });

  await t.test('a batch completing several quests fires questReady exactly once', () => {
    const app = fakeApp();
    const calls = [];
    const spy = mock.method(soundFX, 'play', (key) => { calls.push(key); });
    try {
      app.applyQuestChanges([
        { questId: 'q1', questName: 'Q1', completed: true, status: 'complete' },
        { questId: 'q2', questName: 'Q2', completed: true, status: 'complete' },
      ]);
      assert.deepEqual(calls, ['questReady'], 'one fanfare per transition');
    } finally {
      spy.mock.restore();
    }
  });

  await t.test('the quest engine emits completed:true only on the transition', () => {
    const state = createQuestState();
    const player = createPartyPlayer('magician');
    assert.equal(acceptQuest(state, player, 'rats_in_the_gutter').ok, true);
    for (let i = 0; i < 6; i++) recordEvent(state, { type: 'kill', monsterType: 'drowned_crawler' });

    const completing = recordEvent(state, { type: 'kill', monsterType: 'gutter_king' });
    assert.equal(completing.filter((c) => c.completed).length, 1, 'exactly one completing change');

    const replay = recordEvent(state, { type: 'kill', monsterType: 'gutter_king' });
    assert.equal(replay.filter((c) => c.completed).length, 0, 'no replayed completing change');
  });

  await t.test('softened enterIsle is a gentle rising sweep, not a low-end boom', () => {
    const def = SOUNDS_CATALOG.enterIsle;
    assert.ok(def, 'Missing sound definition for enterIsle');
    assert.equal(def.type, 'sweep', 'softened isle exit uses the sweep renderer');
    assert.ok(Number.isFinite(def.attack) && def.attack > 0, 'enterIsle needs a longer attack');
    assert.ok(def.startFreq >= 200, 'enterIsle must avoid the hard low-end (>= 200 Hz)');
    assert.ok(def.endFreq > def.startFreq, 'enterIsle should rise, not fall');
    assert.ok(def.gain <= 0.10, 'enterIsle gain must be lowered');
    assert.equal(def.filter?.type, 'lowpass', 'enterIsle should be filtered/soft');
    // Distinct from the cues the board suspected were compounding the exit.
    assert.notEqual(JSON.stringify(def), JSON.stringify(SOUNDS_CATALOG.teleport));
    assert.notEqual(JSON.stringify({ ...def, attack: undefined }), JSON.stringify(SOUNDS_CATALOG.enterVillage));
  });

  await t.test('fallback catalog mirrors questReady and the softened enterIsle', () => {
    const fallback = AudioSystem.getInstance()._getFallbackSounds();
    assert.deepEqual(fallback.questReady, SOUNDS_CATALOG.questReady);
    assert.deepEqual(fallback.enterIsle, SOUNDS_CATALOG.enterIsle);
  });
});
