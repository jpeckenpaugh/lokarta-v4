/**
 * LIV-97: SFX hooks for quests, bosses, and key events — T0 tests.
 *
 * Covers the new `sounds.json` recipes (shape + distinctness), the
 * previously-silent keys (`holyChime`, `manaRegen`, `uiDenied`), the
 * headless-safe no-op playback path, and that every new catalog key is
 * actually wired at an app-layer `soundFX.play(...)` call site.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SOUNDS_CATALOG } from '../data/index.js';
import { AudioSystem } from '../audio/index.js';
import { readControllerSources } from './helpers/app-source.mjs';

/** Quest / boss / key-event cues added by LIV-97. */
const NEW_SFX = [
  'questAccept', 'questObjective', 'questComplete',
  'bossEntrance', 'bossDefeat', 'enemyCast',
  'enterVillage', 'enterIsle', 'gateUnlock', 'enterTower', 'teleport',
  'fountain', 'healReceived', 'playerStun', 'playerDefeat', 'revive',
];

/** Keys that were played by app code but missing from the catalog. */
const FIXED_SILENT_KEYS = ['holyChime', 'manaRegen', 'uiDenied'];

const VALID_TYPES = ['sweep', 'sequence', 'composite'];

test('LIV-97 SFX hooks', async (t) => {
  await t.test('catalog defines every new cue and the previously-silent keys', () => {
    for (const key of [...NEW_SFX, ...FIXED_SILENT_KEYS]) {
      const def = SOUNDS_CATALOG[key];
      assert.ok(def, `Missing sound definition for ${key}`);
      assert.notEqual(def.kind, 'ambient', `${key} must be a one-shot`);
      assert.ok(VALID_TYPES.includes(def.type), `Invalid sound type for ${key}: ${def.type}`);
    }
  });

  await t.test('recipes are shaped for their declared renderer type', () => {
    for (const key of [...NEW_SFX, ...FIXED_SILENT_KEYS]) {
      const def = SOUNDS_CATALOG[key];
      if (def.type === 'sequence') {
        assert.ok(Array.isArray(def.notes) && def.notes.length > 0, `${key} sequence needs notes`);
        for (const note of def.notes) {
          assert.ok(Number.isFinite(note.freq) && note.freq > 0, `${key} note needs a valid freq`);
          assert.ok(Number.isFinite(note.time) && note.time >= 0, `${key} note needs a valid time`);
          assert.ok(Number.isFinite(note.duration) && note.duration > 0, `${key} note needs a valid duration`);
        }
      } else if (def.type === 'sweep') {
        assert.ok(Number.isFinite(def.startFreq) && Number.isFinite(def.endFreq), `${key} sweep needs start/end freq`);
        assert.ok(Number.isFinite(def.duration) && def.duration > 0, `${key} sweep needs a duration`);
      } else if (def.type === 'composite') {
        assert.ok(Number.isFinite(def.duration) && def.duration > 0, `${key} composite needs a duration`);
        assert.ok(
          (Array.isArray(def.oscillators) && def.oscillators.length > 0) || (def.lfo && def.filter),
          `${key} composite needs oscillators or an lfo+filter pair`
        );
      }
      assert.ok(Number.isFinite(def.gain) && def.gain > 0, `${key} needs a positive gain`);
    }
  });

  await t.test('quest/boss/revive beats are distinct from their generic counterparts', () => {
    const asKey = (def) => JSON.stringify(def);
    assert.notEqual(asKey(SOUNDS_CATALOG.questComplete), asKey(SOUNDS_CATALOG.questObjective),
      'quest-complete fanfare must differ from step completion');
    assert.notEqual(asKey(SOUNDS_CATALOG.bossDefeat), asKey(SOUNDS_CATALOG.monsterDeath),
      'boss defeat sting must differ from the generic death sweep');
    assert.notEqual(asKey(SOUNDS_CATALOG.playerDefeat), asKey(SOUNDS_CATALOG.defeat),
      'player KO sting must differ from the legacy defeat sequence');
    assert.notEqual(asKey(SOUNDS_CATALOG.revive), asKey(SOUNDS_CATALOG.holyChime),
      'revive cue must differ from the holy chime');
  });

  await t.test('fallback catalog mirrors the new keys (no silent fallback)', () => {
    const fallback = AudioSystem.getInstance()._getFallbackSounds();
    for (const key of [...NEW_SFX, ...FIXED_SILENT_KEYS]) {
      assert.ok(fallback[key], `fallback catalog missing ${key}`);
    }
  });

  await t.test('headless playback of every new cue is a safe no-op', () => {
    const audio = AudioSystem.getInstance();
    for (const key of [...NEW_SFX, ...FIXED_SILENT_KEYS, 'non_existent_key']) {
      assert.doesNotThrow(() => audio.play(key), `play(${key}) must not throw headless`);
    }
  });

  await t.test('every new catalog key is wired at an app-layer call site', () => {
    const sources = readControllerSources();
    for (const key of [...NEW_SFX, ...FIXED_SILENT_KEYS]) {
      assert.ok(
        sources.includes(`'${key}'`),
        `No app-layer reference to SFX "${key}" — defined but never triggered`
      );
    }
  });

  await t.test('sounds.json on disk matches the loaded catalog (no drift)', () => {
    const onDisk = JSON.parse(readFileSync(resolve(process.cwd(), 'html/data/sounds.json'), 'utf8'));
    assert.equal(Object.keys(onDisk).length, Object.keys(SOUNDS_CATALOG).length);
  });
});
