/**
 * LIV-82: Ambient audio beds & positional ambience — T0 tests.
 *
 * These cover the browser-free director logic (bed resolution, phase/weather
 * variants, positional + rate-limited one-shots, footstep materials) and the
 * referential integrity of the `biomes.json` `ambience` blocks against the
 * `sounds.json` catalog. The WebAudio graph itself is exercised only for
 * headless safety (see audio.test.mjs); it needs a real AudioContext.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AmbientDirector,
  normalizeAmbience,
  resolveAmbience,
} from '../audio/ambient-director.js';
import { ambientDirector } from '../audio/index.js';
import { BIOMES_CATALOG, SOUNDS_CATALOG } from '../data/index.js';

/** Minimal AudioSystem-shaped spy (records calls, no WebAudio). */
function makeFakeAudio() {
  const beds = [];
  const played = [];
  return {
    beds,
    played,
    setAmbientBed: (id) => beds.push(id),
    playAt: (id, x, y, px, py) => played.push({ id, x, y, px, py }),
    play: (id) => played.push({ id }),
  };
}

/** Deterministic director: fixed RNG (returns 0) and clock. */
function makeDirector(audio, overrides = {}) {
  return new AmbientDirector(audio, {
    random: () => 0,
    clock: () => 0,
    ...overrides,
  });
}

test('LIV-82 ambient director', async (t) => {
  await t.test('normalizeAmbience coerces and drops invalid fields', () => {
    assert.equal(normalizeAmbience(null), null);
    const norm = normalizeAmbience({
      bedId: 'bed_a',
      nightBedId: 'bed_n',
      dayOneShots: ['a', 42, 'b'],
      nightOneShots: 'nope',
      weatherVariants: { rain: 'bed_rain', bad: 5 },
      emitters: [{ soundId: 's1', x: 1, y: 2, rateLimitMs: 100 }, { x: 3 }, null],
      footsteps: { SAND: 'footstep_sand', X: 9 },
      oneShotChance: 2,
    });
    assert.equal(norm.bedId, 'bed_a');
    assert.equal(norm.nightBedId, 'bed_n');
    assert.deepEqual(norm.dayOneShots, ['a', 'b']);
    assert.deepEqual(norm.nightOneShots, []);
    assert.deepEqual(norm.weatherVariants, { rain: 'bed_rain' });
    assert.deepEqual(norm.footsteps, { SAND: 'footstep_sand' });
    assert.equal(norm.emitters.length, 1);
    assert.equal(norm.oneShotChance, 1);
    assert.equal(norm.defaultFootstep, 'footstep');
  });

  await t.test('every biome ambience references real ambient/sfx sound ids', () => {
    for (const [biomeId, biome] of Object.entries(BIOMES_CATALOG)) {
      const amb = biome && biome.ambience;
      if (!amb || typeof amb !== 'object') continue;
      const beds = [
        amb.bedId,
        amb.nightBedId,
        ...Object.values(amb.weatherVariants || {}),
      ].filter((id) => typeof id === 'string' && id);
      for (const bedId of beds) {
        assert.ok(SOUNDS_CATALOG[bedId], `${biomeId}: unknown bed "${bedId}"`);
        assert.equal(SOUNDS_CATALOG[bedId].kind, 'ambient', `${bedId} must be an ambient bed`);
      }
      const oneShots = [
        ...(amb.dayOneShots || []),
        ...(amb.nightOneShots || []),
        ...(amb.emitters || []).map((e) => e.soundId),
      ];
      for (const soundId of oneShots) {
        assert.ok(SOUNDS_CATALOG[soundId], `${biomeId}: unknown one-shot "${soundId}"`);
        assert.notEqual(SOUNDS_CATALOG[soundId].kind, 'ambient', `${soundId} must be a one-shot`);
      }
      for (const [tileName, soundId] of Object.entries(amb.footsteps || {})) {
        assert.ok(SOUNDS_CATALOG[soundId], `${biomeId}: unknown footstep "${soundId}" for ${tileName}`);
      }
    }
  });

  await t.test('resolveAmbience reads isle/town/tower blocks', () => {
    const isle = resolveAmbience('dawnreach_isle');
    assert.equal(isle.bedId, 'amb_island_surf');
    assert.equal(isle.nightBedId, 'amb_island_night');
    assert.ok(isle.dayOneShots.includes('gullCry'));
    assert.equal(isle.weatherVariants.rain, 'amb_rain');
    assert.equal(isle.footsteps.SAND, 'footstep_sand');

    const town = resolveAmbience('havenreach_town');
    assert.equal(town.bedId, 'amb_town_day');
    assert.equal(town.emitters.length, 3);
    assert.equal(town.footsteps.PATH, 'footstep_stone');

    assert.equal(resolveAmbience('crypt').bedId, 'amb_dungeon');
    assert.equal(resolveAmbience('does_not_exist'), null);
    assert.equal(resolveAmbience(null), null);
  });

  await t.test('setBiome/phase/weather retarget the bed', () => {
    const audio = makeFakeAudio();
    const dir = makeDirector(audio);
    dir.setBiome('dawnreach_isle');
    assert.equal(audio.beds.at(-1), 'amb_island_surf');
    dir.setWeather('rain');
    assert.equal(audio.beds.at(-1), 'amb_rain');
    dir.setWeather('clear');
    dir.setPhase('night');
    assert.equal(audio.beds.at(-1), 'amb_island_night');
    dir.setPhase('day');
    assert.equal(audio.beds.at(-1), 'amb_island_surf');
    // Unknown biome has no bed: stop.
    dir.setBiome('nowhere');
    assert.equal(audio.beds.at(-1), null);
  });

  await t.test('playOneShot is positional and rate-limited', () => {
    const audio = makeFakeAudio();
    const dir = makeDirector(audio);
    dir.setBiome('dawnreach_isle');
    const player = { x: 10, y: 10 };

    assert.equal(dir.playOneShot('gullCry', 15, 12, player, 1000), true);
    assert.deepEqual(audio.played.at(-1), { id: 'gullCry', x: 15, y: 12, px: 10, py: 10 });

    // Within the rate-limit window -> suppressed.
    assert.equal(dir.playOneShot('gullCry', 15, 12, player, 1500), false);
    // After the window -> allowed again.
    assert.equal(dir.playOneShot('gullCry', 15, 12, player, 6000), true);
  });

  await t.test('tick fires fixed emitters and rate-limits them', () => {
    const audio = makeFakeAudio();
    const dir = makeDirector(audio);
    dir.setBiome('havenreach_town');
    const player = { x: 12, y: 12 };

    dir.tick(1000, { player });
    const emittersAt1000 = audio.played.filter((p) => p.id === 'forgeHammer' || p.id === 'shopBell');
    assert.equal(emittersAt1000.length, 3);
    for (const p of emittersAt1000) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'emitters must be positional');
    }

    // Same instant -> all rate-limited.
    audio.played.length = 0;
    dir.tick(1100, { player });
    assert.equal(audio.played.length, 0);

    // 4 s later the short-cooldown forge hammers may fire again, the bell may not.
    audio.played.length = 0;
    dir.tick(5200, { player });
    assert.ok(audio.played.some((p) => p.id === 'forgeHammer'));
    assert.ok(!audio.played.some((p) => p.id === 'shopBell'));
  });

  await t.test('tick fires roaming phase one-shots around the player', () => {
    const audio = makeFakeAudio();
    const dir = makeDirector(audio);
    dir.setBiome('dawnreach_isle');
    const player = { x: 24, y: 24 };

    dir.tick(1000, { player });
    const gull = audio.played.find((p) => p.id === 'gullCry');
    assert.ok(gull, 'expected a roaming gull one-shot');
    const dist = Math.hypot(gull.x - player.x, gull.y - player.y);
    assert.ok(dist > 0, 'roaming one-shot must be placed off the player tile');

    // Night swaps the pool to crickets.
    audio.played.length = 0;
    dir.setPhase('night');
    dir.tick(10000, { player });
    assert.ok(audio.played.some((p) => p.id === 'cricketChirp'));
  });

  await t.test('footstepSoundFor resolves sand vs stone materials', () => {
    const dir = makeDirector(makeFakeAudio());
    dir.setBiome('dawnreach_isle');
    assert.equal(dir.footstepSoundFor('SAND'), 'footstep_sand');
    assert.equal(dir.footstepSoundFor('GRASS'), 'footstep');
    assert.equal(dir.footstepSoundFor('WALL'), 'footstep');

    dir.setBiome('havenreach_town');
    assert.equal(dir.footstepSoundFor('PATH'), 'footstep_stone');
    assert.equal(dir.footstepSoundFor('UNKNOWN'), 'footstep_stone');

    dir.setBiome('nowhere');
    assert.equal(dir.footstepSoundFor('SAND'), 'footstep');
  });

  await t.test('barrel exports a shared ambient director singleton', () => {
    assert.ok(ambientDirector instanceof AmbientDirector);
  });
});
