import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AudioSystem } from '../audio/index.js';

test('AudioSystem & JSON Sound Catalog', async (t) => {
  const SFX_KEYS = [
    'footstep', 'wandSpark', 'lightSpell', 'energyBeam', 'bowShot', 'powerShot',
    'hit', 'monsterAttack', 'monsterDeath', 'playerHurt', 'itemPickup',
    'potionDrink', 'equip', 'unequip', 'stairs', 'levelUp', 'victory', 'defeat', 'click',
    'uiMove', 'uiBack', 'keyJangle', 'coins', 'koHandoff', 'controlSwap',
    // LIV-82 positional ambience one-shots.
    'gullCry', 'birdSong', 'crowdMurmur', 'forgeHammer', 'shopBell', 'cricketChirp',
    'footstep_sand', 'footstep_stone'
  ];
  const AMBIENT_KEYS = [
    'amb_island_surf', 'amb_island_night', 'amb_town_day', 'amb_town_night',
    'amb_dungeon', 'amb_rain', 'amb_mist'
  ];

  await t.test('loads every required sound definition from sounds.json', () => {
    const soundsPath = resolve(process.cwd(), 'html/data/sounds.json');
    const soundsJson = JSON.parse(readFileSync(soundsPath, 'utf8'));

    const expectedKeys = [...SFX_KEYS, ...AMBIENT_KEYS];
    assert.equal(Object.keys(soundsJson).length, expectedKeys.length);

    for (const key of SFX_KEYS) {
      assert.ok(soundsJson[key], `Missing sound definition for ${key}`);
      assert.notEqual(soundsJson[key].kind, 'ambient', `${key} is a one-shot, not an ambient bed`);
      assert.ok(['sweep', 'sequence', 'composite'].includes(soundsJson[key].type), `Invalid sound type for ${key}: ${soundsJson[key].type}`);
    }

    for (const key of AMBIENT_KEYS) {
      const bed = soundsJson[key];
      assert.ok(bed, `Missing ambient bed ${key}`);
      assert.equal(bed.kind, 'ambient', `${key} must be kind:"ambient"`);
      assert.equal(bed.loop, true, `${key} must loop`);
      assert.ok(Number.isFinite(bed.gain), `${key} must declare a gain`);
      assert.ok(Array.isArray(bed.layers) && bed.layers.length > 0, `${key} must declare layers`);
    }
  });

  await t.test('initializes AudioSystem singleton and handles play calls gracefully', () => {
    const audio = AudioSystem.getInstance();
    assert.ok(audio instanceof AudioSystem);
    assert.equal(audio.enabled, true);

    // Uninitialized / headless environment play calls shouldn't crash
    audio.play('click');
    audio.play('hit');
    audio.play('non_existent_key');

    assert.equal(audio.getMuted(), false);
    audio.toggleMute();
    assert.equal(audio.getMuted(), true);
    audio.toggleMute();
    assert.equal(audio.getMuted(), false);
  });

  await t.test('computes spatial distance volume attenuation scale correctly', () => {
    const audio = AudioSystem.getInstance();

    // Distance <= 5 tiles -> 100% (1.0)
    assert.equal(audio.computeDistanceScale(2, 2, 2, 2), 1.0);
    assert.equal(audio.computeDistanceScale(2, 2, 7, 2), 1.0); // 5 tiles away

    // Distance > 5 tiles -> loses 10% per tile
    assert.equal(audio.computeDistanceScale(2, 2, 8, 2), 0.9); // 6 tiles away -> 90%
    assert.equal(audio.computeDistanceScale(2, 2, 12, 2), 0.5); // 10 tiles away -> 50%

    // Distance floor -> minimum 10% (0.10)
    assert.equal(audio.computeDistanceScale(2, 2, 25, 2), 0.1); // 23 tiles away -> floors at 10%
  });

  await t.test('ambient bed requests are headless-safe and never throw', () => {
    const audio = AudioSystem.getInstance();
    // Without a running AudioContext the request is remembered but not started.
    assert.doesNotThrow(() => audio.setAmbientBed('amb_island_surf'));
    assert.equal(audio.getAmbientBedId(), null);
    assert.doesNotThrow(() => audio.setAmbientBed(null));
    assert.doesNotThrow(() => audio.stopAmbient());
    assert.doesNotThrow(() => audio.playAt('gullCry', 4, 4, 1, 1));
  });
});
