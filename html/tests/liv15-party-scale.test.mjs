/**
 * LIV-15: campaign.partyScale engine wiring in the floor generator.
 *
 * The campaign block of `tower_levels.json` authors hp/atk multipliers keyed by
 * live party size (1..4). `generateFloor(floor, seed, towerId, partySize)`
 * stacks those multipliers on top of each tower's `monsterGroups.statScale`
 * and stamps the resolved size onto the floor so the worker's floor cache can
 * invalidate a pre-recruit floor. These tests lock the contract:
 *  - `partySize = 1` resolves to exactly 1.0 and leaves the floor unchanged,
 *  - `partySize = 4` scales regular + key-holder + boss + guard hp by 1.60 and
 *    atk (attack + damageScale) by 1.20,
 *  - the same (tower, floor, seed, partySize) is byte-identical,
 *  - sizes outside the authored range clamp / fall back to the largest entry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MONSTERS_CATALOG,
  TOWER_LEVELS_CATALOG,
  TOWER_CATALOG_ROOT,
  DEFAULT_TOWER_ID,
} from '../data/index.js';
import {
  generateFloor,
  resolvePartySize,
  resolvePartyScale,
} from '../services/floor-generator.js';
import { isStaleFloor } from '../worker/game-worker.js';
import { partySize } from '../engine/index.js';

const STAT_SCALE = TOWER_LEVELS_CATALOG.monsterGroups.statScale;
const KEY_MOD = TOWER_LEVELS_CATALOG.monsterGroups.keyHolderModifier;
const PARTY_SCALE = TOWER_CATALOG_ROOT.campaign.partyScale;

const HP4 = PARTY_SCALE.hp['4'];
const ATK4 = PARTY_SCALE.atk['4'];

function regulars(floor) {
  return floor.monsters.filter((m) => !m.isBoss && !m.isGuard && !m.holdsKey);
}

describe('LIV-15 resolvePartySize / resolvePartyScale', () => {
  it('clamps live sizes to the authored 1..4 range', () => {
    assert.equal(resolvePartySize(0), 1);
    assert.equal(resolvePartySize(-3), 1);
    assert.equal(resolvePartySize(1), 1);
    assert.equal(resolvePartySize(3), 3);
    assert.equal(resolvePartySize(4), 4);
    assert.equal(resolvePartySize(5), 4);
    assert.equal(resolvePartySize(99), 4);
  });

  it('falls back to the largest authored entry for a non-numeric size', () => {
    assert.equal(resolvePartySize(NaN), 4);
    assert.equal(resolvePartySize(undefined), 1, 'default party size is 1');
    assert.equal(resolvePartySize('not-a-number'), 4);
  });

  it('resolves the authored multipliers, with partySize 1 a 1.0 no-op', () => {
    assert.deepEqual(resolvePartyScale(1), { size: 1, hp: 1, atk: 1 });
    assert.deepEqual(resolvePartyScale(4), { size: 4, hp: 1.6, atk: 1.2 });
    assert.deepEqual(resolvePartyScale(99), { size: 4, hp: 1.6, atk: 1.2 });
  });
});

describe('LIV-15 partyScale in generateFloor', () => {
  it('leaves every floor byte-identical at partySize = 1', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const legacy = generateFloor(level, 4242);
      const explicit = generateFloor(level, 4242, DEFAULT_TOWER_ID, 1);
      assert.deepEqual(legacy, explicit, `floor ${level} partySize=1 must be unchanged`);
      assert.equal('party_size' in legacy, false, `floor ${level} omits party_size at size 1`);
    }
  });

  it('scales regular and key-holder hp/attack/damageScale by exactly 1.60/1.20', () => {
    for (const level of [1, 3, 5]) {
      const calm = generateFloor(level, 7);
      const full = generateFloor(level, 7, DEFAULT_TOWER_ID, 4);
      const stat = STAT_SCALE[String(level)];

      const calmRegular = regulars(calm);
      const fullRegular = regulars(full);
      assert.ok(fullRegular.length > 0, `floor ${level} must have regular monsters`);
      for (let i = 0; i < fullRegular.length; i++) {
        const base = MONSTERS_CATALOG[fullRegular[i].type];
        assert.equal(
          fullRegular[i].hp,
          Math.round(base.baseHp * stat.hp * HP4),
          `${fullRegular[i].type} floor ${level} hp`
        );
        assert.equal(
          fullRegular[i].attack,
          Math.round(base.baseAttack * stat.atk * ATK4),
          `${fullRegular[i].type} floor ${level} attack`
        );
        assert.equal(fullRegular[i].damageScale, stat.atk * ATK4, `${fullRegular[i].type} damageScale`);
        assert.ok(fullRegular[i].hp > calmRegular[i].hp, 'scaled hp must exceed the calm floor');
      }

      const calmHolders = calm.monsters.filter((m) => m.holdsKey);
      const fullHolders = full.monsters.filter((m) => m.holdsKey);
      assert.equal(fullHolders.length, calmHolders.length, `floor ${level} holder count`);
      for (let i = 0; i < fullHolders.length; i++) {
        const base = MONSTERS_CATALOG[fullHolders[i].type];
        assert.equal(
          fullHolders[i].hp,
          Math.round(base.baseHp * stat.hp * KEY_MOD.hp * HP4),
          `${fullHolders[i].type} key-holder hp`
        );
        assert.equal(
          fullHolders[i].attack,
          Math.round(base.baseAttack * stat.atk * KEY_MOD.atk * ATK4),
          `${fullHolders[i].type} key-holder attack`
        );
      }
    }
  });

  it('scales the final boss and its guards hp/attack by exactly 1.60/1.20', () => {
    const calm = generateFloor(5, 11);
    const full = generateFloor(5, 11, DEFAULT_TOWER_ID, 4);
    const bossSpec = TOWER_LEVELS_CATALOG.boss;
    const stat = STAT_SCALE['5'];

    const calmBoss = calm.monsters.find((m) => m.isBoss);
    const fullBoss = full.monsters.find((m) => m.isBoss);
    assert.ok(calmBoss && fullBoss, 'level 5 must have a boss');
    assert.equal(fullBoss.hp, Math.round(bossSpec.hp * HP4), 'boss hp');
    assert.equal(fullBoss.max_hp, Math.round(bossSpec.max_hp * HP4), 'boss max_hp');
    assert.equal(fullBoss.attack, Math.round(bossSpec.attack * ATK4), 'boss attack');
    assert.equal(fullBoss.damageScale, stat.atk * ATK4, 'boss damageScale');

    const fullGuards = full.monsters.filter((m) => m.isGuard);
    assert.ok(fullGuards.length > 0, 'level 5 must have boss guards');
    for (const guard of fullGuards) {
      const base = MONSTERS_CATALOG[guard.type];
      assert.equal(guard.hp, Math.round(base.baseHp * stat.hp * HP4), `${guard.type} guard hp`);
      assert.equal(guard.attack, Math.round(base.baseAttack * stat.atk * ATK4), `${guard.type} guard attack`);
      assert.equal(guard.damageScale, stat.atk * ATK4, `${guard.type} guard damageScale`);
    }
  });

  it('is deterministic / byte-identical for a fixed (tower, floor, seed, partySize)', () => {
    for (const size of [1, 2, 3, 4]) {
      const a = generateFloor(4, 90210, DEFAULT_TOWER_ID, size);
      const b = generateFloor(4, 90210, DEFAULT_TOWER_ID, size);
      assert.equal(JSON.stringify(a), JSON.stringify(b), `partySize ${size} must be deterministic`);
      if (size > 1) assert.equal(a.party_size, size, 'floor stamps the resolved party size');
    }
  });
});

describe('LIV-15 party-size floor cache identity', () => {
  it('partySize helper reads the party length with a legacy fallback', () => {
    assert.equal(partySize({}), 1);
    assert.equal(partySize({ party: [] }), 1);
    assert.equal(partySize({ party: [{}, {}] }), 2);
  });

  it('treats a floor scaled for another party size as stale', () => {
    const size1 = generateFloor(2, 5);
    const size3 = generateFloor(2, 5, DEFAULT_TOWER_ID, 3);
    assert.equal(isStaleFloor(size1, DEFAULT_TOWER_ID, 1), false);
    assert.equal(isStaleFloor(size1, DEFAULT_TOWER_ID, 3), true, 'recruit must not replay a 1-member floor');
    assert.equal(isStaleFloor(size3, DEFAULT_TOWER_ID, 3), false);
    assert.equal(isStaleFloor(size3, DEFAULT_TOWER_ID, 1), true, 'shrinking the party invalidates too');
    assert.equal(isStaleFloor(size1, DEFAULT_TOWER_ID), false, 'omitting size keeps legacy behavior');
  });
});
