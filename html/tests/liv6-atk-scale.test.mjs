/**
 * LIV-6: Per-floor attack scaling for catalog opponents.
 *
 * `floor-generator.js` resolves the floor's `monsterGroups.statScale.atk` onto
 * each generated monster as `damageScale`; every catalog attack handler applied
 * by `EntityAI` multiplies its rolled `attacks[].damageMin/Max` by that scale.
 * These tests lock the contract:
 *  - floor 1 stays at 1.0 (launch behaviour unchanged),
 *  - deeper floors scale melee/projectile/aoe/dash damage from the same
 *    `statScale.atk` that already scales `monster.attack`,
 *  - key holders additionally carry `keyHolderModifier.atk`,
 *  - summons inherit their summoner's floor scale,
 *  - a missing scale is a 1.0 no-op for hand-built/legacy monsters.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { EntityAI } from '../engine/entity-ai.js';
import { MONSTERS_CATALOG, TOWER_LEVELS_CATALOG } from '../data/index.js';
import { generateFloor } from '../services/floor-generator.js';

/** Tower statScale for the default tower (mirrors floor-generator's lookup). */
const STAT_SCALE = TOWER_LEVELS_CATALOG.monsterGroups.statScale;
const KEY_MOD = TOWER_LEVELS_CATALOG.monsterGroups.keyHolderModifier;

function floorGrid(width = 20, height = 20) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
}

function playerAt(x, y) {
  const player = createPlayer('fighter');
  player.x = x;
  player.y = y;
  return player;
}

function probe(type, x, y, overrides = {}) {
  return {
    id: `probe_${type}_${x}_${y}`,
    type,
    name: 'Probe',
    x,
    y,
    hp: 100,
    max_hp: 100,
    isAggroed: true,
    attackCooldown: 0,
    moveCooldown: 0,
    ...overrides,
  };
}

/** Registers a temporary catalog probe with fixed (deterministic) damage. */
function defineProbe(key, spec) {
  MONSTERS_CATALOG[key] = {
    type: key,
    name: 'Probe',
    baseHp: 10,
    baseAttack: 1,
    baseDefense: 0,
    moveCadence: 1,
    attackCadence: 1,
    damageMin: 10,
    damageMax: 10,
    aiType: 'chase',
    lootTable: [],
    ...spec,
  };
}

describe('LIV-6 scaleDamage helper', () => {
  it('is a 1.0 no-op for hand-built monsters and applies + rounds a scale', () => {
    assert.equal(EntityAI.scaleDamage({}, 10), 10, 'missing damageScale -> unchanged');
    assert.equal(EntityAI.scaleDamage({ damageScale: 1 }, 10), 10, 'scale 1 -> unchanged');
    assert.equal(EntityAI.scaleDamage({ damageScale: 1.55 }, 10), 16, '10 * 1.55 -> 16');
    assert.equal(EntityAI.scaleDamage(null, 7), 7, 'null monster -> unchanged');
  });
});

describe('LIV-6 floor generator stamps damageScale', () => {
  it('leaves floor-1 regular monsters at scale 1.0', () => {
    const floor = generateFloor(1);
    const regular = floor.monsters.filter((m) => !m.isBoss && !m.isGuard && !m.holdsKey);
    assert.ok(regular.length > 0);
    for (const m of regular) {
      assert.equal(m.damageScale, 1, `${m.type} on floor 1 must not scale attack damage`);
    }
    // Key holders keep their designed per-tier attack bonus on floor 1 too.
    for (const m of floor.monsters.filter((h) => h.holdsKey)) {
      assert.equal(m.damageScale, KEY_MOD.atk, `${m.type} floor-1 key holder damageScale`);
    }
  });

  it('scales regular monsters on deeper floors from statScale.atk', () => {
    for (const level of [2, 3, 4, 5]) {
      const expected = STAT_SCALE[String(level)].atk;
      const floor = generateFloor(level);
      const regular = floor.monsters.filter((m) => !m.isBoss && !m.isGuard && !m.holdsKey);
      assert.ok(regular.length > 0, `floor ${level} must have regular monsters`);
      for (const m of regular) {
        assert.equal(m.damageScale, expected, `${m.type} floor ${level} damageScale`);
      }
    }
  });

  it('multiplies the key-holder attack bonus into damageScale', () => {
    const floor = generateFloor(3);
    const expected = STAT_SCALE['3'].atk * KEY_MOD.atk;
    const holders = floor.monsters.filter((m) => m.holdsKey);
    assert.equal(holders.length, 3, 'one holder per gate tier');
    for (const m of holders) {
      assert.equal(m.damageScale, expected, `${m.type} key-holder damageScale`);
    }
  });

  it('keeps the existing monster.attack contract intact', () => {
    const floor = generateFloor(4);
    const expected = STAT_SCALE['4'].atk;
    for (const m of floor.monsters) {
      if (m.isBoss || m.isGuard) continue;
      const base = MONSTERS_CATALOG[m.type];
      const mod = m.holdsKey ? KEY_MOD.atk : 1;
      assert.equal(m.attack, Math.round(base.baseAttack * expected * mod));
    }
  });
});

describe('LIV-6 attack handlers apply the floor scale', () => {
  const keys = [];

  function withProbes(defs, fn) {
    for (const [key, spec] of Object.entries(defs)) {
      defineProbe(key, spec);
      keys.push(key);
    }
    try {
      return fn();
    } finally {
      for (const key of keys) delete MONSTERS_CATALOG[key];
      keys.length = 0;
    }
  }

  it('scales melee damage through the chase handler', () => {
    withProbes({ __liv6_melee: { aiType: 'chase' } }, () => {
      const grid = floorGrid();

      const base = probe('__liv6_melee', 3, 2);
      const baseHit = EntityAI.updateMonsters([base], playerAt(2, 2), grid, 0.016);
      assert.equal(baseHit[0].damageToPlayer, 10, 'unscaled roll');

      const scaled = probe('__liv6_melee', 3, 2, { damageScale: 2.5 });
      const scaledHit = EntityAI.updateMonsters([scaled], playerAt(2, 2), grid, 0.016);
      assert.equal(scaledHit[0].damageToPlayer, 25, '10 * 2.5');
    });
  });

  it('scales projectile damage through the ranged handler', () => {
    withProbes(
      {
        __liv6_bolt: {
          aiType: 'ranged',
          attacks: [{ key: 'bolt', kind: 'projectile', range: 5, minRange: 1, requiresLOS: false, damageMin: 10, damageMax: 10 }],
        },
      },
      () => {
        const grid = floorGrid();
        const bolt = probe('__liv6_bolt', 2, 2, { damageScale: 1.25 });
        const hit = EntityAI.updateMonsters([bolt], playerAt(6, 2), grid, 0.016);
        assert.equal(hit[0].projectiles[0].type, 'monster_bolt');
        assert.equal(hit[0].damageToPlayer, 13, '10 * 1.25 -> round 13');
      }
    );
  });

  it('scales aoe damage through the bomber handler', () => {
    withProbes(
      {
        __liv6_blast: {
          aiType: 'bomber',
          attacks: [{ key: 'blast', kind: 'aoe', range: 6, minRange: 1, requiresLOS: false, radius: 1, telegraphSec: 0, damageMin: 10, damageMax: 10 }],
        },
      },
      () => {
        const grid = floorGrid();
        const blast = probe('__liv6_blast', 2, 2, { damageScale: 1.5 });
        const hit = EntityAI.updateMonsters([blast], playerAt(4, 2), grid, 0.016);
        assert.equal(hit[0].projectiles[0].type, 'aoe_burst');
        assert.equal(hit[0].damageToPlayer, 15, '10 * 1.5');
      }
    );
  });

  it('scales dash damage through the charger handler', () => {
    withProbes(
      {
        __liv6_dash: {
          aiType: 'charger',
          attacks: [{ key: 'dash', kind: 'dash', range: 6, minRange: 1, requiresLOS: false, dashTiles: 2, telegraphSec: 0, damageMin: 10, damageMax: 10 }],
        },
      },
      () => {
        const grid = floorGrid();
        const dash = probe('__liv6_dash', 2, 2, { damageScale: 2 });
        const hit = EntityAI.updateMonsters([dash], playerAt(4, 2), grid, 0.016);
        assert.ok(hit[0].dashMoved > 0, 'charger dashed');
        assert.equal(hit[0].damageToPlayer, 20, '10 * 2');
      }
    );
  });
});

describe('LIV-6 summons inherit the summoner floor scale', () => {
  it('stamps the summoner damageScale onto spawned minions', () => {
    const grid = floorGrid();
    const player = playerAt(8, 2);
    const summoner = probe('bone_summoner', 2, 2, { damageScale: 2.5 });

    const results = EntityAI.updateMonsters([summoner], player, grid, 0.016);
    const spawn = results[0].spawns[0];
    assert.equal(spawn.damageScale, 2.5, 'summon carries the floor attack scale');
  });
});
