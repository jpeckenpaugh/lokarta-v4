import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AudioSystem } from '../audio/index.js';

test('AudioSystem & JSON Sound Catalog', async (t) => {
  await t.test('loads all 23 required sound definitions from sounds.json', () => {
    const soundsPath = resolve(process.cwd(), 'html/data/sounds.json');
    const soundsJson = JSON.parse(readFileSync(soundsPath, 'utf8'));

    const expectedKeys = [
      'footstep', 'wandSpark', 'lightSpell', 'energyBeam', 'bowShot', 'powerShot',
      'hit', 'monsterAttack', 'monsterDeath', 'playerHurt', 'itemPickup',
      'potionDrink', 'equip', 'unequip', 'stairs', 'levelUp', 'victory', 'defeat', 'click',
      'uiMove', 'uiBack', 'keyJangle', 'coins'
    ];

    assert.equal(Object.keys(soundsJson).length, 23);

    for (const key of expectedKeys) {
      assert.ok(soundsJson[key], `Missing sound definition for ${key}`);
      assert.ok(['sweep', 'sequence', 'composite'].includes(soundsJson[key].type), `Invalid sound type for ${key}: ${soundsJson[key].type}`);
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
});
