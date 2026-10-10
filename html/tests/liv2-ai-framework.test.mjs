/**
 * LIV-2: Data-driven attack-style / AI framework.
 *
 * Covers the catalog-driven dispatch contract:
 *  - existing launch monsters behave unchanged through their frozen handlers,
 *  - positioning (`aiType`) and attack (`attacks[].kind`) dispatch tables exist,
 *  - at least three new attack styles run purely from `monsters.json`,
 *  - unknown `aiType` and unknown attack `kind` both fall back safely,
 *  - catalog `onHit` status effects apply/tick through the engine dispatch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { EntityAI } from '../engine/entity-ai.js';
import { CombatSystem } from '../engine/combat-system.js';
import { MONSTERS_CATALOG } from '../data/index.js';

function floorGrid(width = 20, height = 20) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
}

function mkMonster(type, x, y, overrides = {}) {
  const def = MONSTERS_CATALOG[type] || {};
  return {
    id: `test_${type}_${x}_${y}`,
    type,
    name: def.name || type,
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

describe('LIV-2 AI framework: dispatch tables', () => {
  it('registers the positioning personalities and attack kinds', () => {
    for (const aiType of ['chase', 'standoff', 'ranged', 'charger', 'bomber', 'summoner', 'stationary']) {
      assert.ok(EntityAI.AI_TYPES.includes(aiType), `missing aiType handler ${aiType}`);
    }
    for (const kind of ['melee', 'projectile', 'aoe', 'dash', 'summon']) {
      assert.ok(EntityAI.ATTACK_KINDS.includes(kind), `missing attack handler ${kind}`);
    }
  });
});

describe('LIV-2 AI framework: launch-monster regression', () => {
  it('a chase monster still melees an adjacent player with the original message', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 2;
    player.y = 2;
    const rat = mkMonster('giant_rat', 3, 2);

    const results = EntityAI.updateMonsters([rat], player, grid, 0.016);
    assert.equal(results.length, 1);
    assert.match(results[0].message, /Giant Rat attacks you for \d+ physical damage!/);
    assert.ok(results[0].damageToPlayer > 0);
    assert.equal(results[0].projectiles, undefined);
  });

  it('a standoff cultist still hurls its Shadow Bolt projectile at range', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 2;
    player.y = 2;
    const cultist = mkMonster('shadow_cultist', 5, 2);

    const results = EntityAI.updateMonsters([cultist], player, grid, 0.016);
    assert.equal(results.length, 1);
    assert.match(results[0].message, /Shadow Bolt/);
    assert.equal(results[0].projectiles[0].type, 'shadow_bolt');
    assert.ok(results[0].damageToPlayer > 0);
  });

  it('an unknown aiType still falls back to chase', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 2;
    player.y = 2;
    const mystery = mkMonster('not_in_catalog', 3, 2, { name: 'Mystery' });

    const results = EntityAI.updateMonsters([mystery], player, grid, 0.016);
    assert.equal(results.length, 1, 'adjacent unknown monster attacks via the chase fallback');
  });
});

describe('LIV-2 AI framework: catalog-driven attack styles', () => {
  it('projectile style: the Cinder Acolyte bolts and applies burn from catalog data', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 7;
    player.y = 2;
    const acolyte = mkMonster('cinder_acolyte', 2, 2);

    const results = EntityAI.updateMonsters([acolyte], player, grid, 0.016);
    assert.equal(results.length, 1);
    assert.equal(results[0].projectiles[0].type, 'ember_bolt');
    assert.equal(results[0].projectiles[0].renderKey, 'ember_bolt');
    assert.ok(results[0].damageToPlayer > 0);
    assert.equal(results[0].statusEffects[0].status, 'burn');
    assert.equal(results[0].statusEffects[0].dps, 2);
  });

  it('aoe style: the Plague Bomber telegraphs, then erupts for poison damage', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 5;
    player.y = 2;
    const maxHp = player.max_hp;
    const bomber = mkMonster('plague_bomber', 2, 2);

    // Wind-up tick: a telegraph is emitted and no damage lands yet.
    const windUp = EntityAI.updateMonsters([bomber], player, grid, 0.016);
    assert.equal(windUp.length, 1);
    assert.equal(windUp[0].projectiles[0].type, 'telegraph');
    assert.ok(bomber.pendingAttack, 'telegraph stores the pending payload');
    assert.equal(player.hp, maxHp, 'no damage during the wind-up');

    // Resolution tick: the blast lands on the telegraphed tile.
    const blast = EntityAI.updateMonsters([bomber], player, grid, 0.9);
    assert.equal(blast.length, 1);
    assert.equal(blast[0].projectiles[0].type, 'aoe_burst');
    assert.ok(blast[0].damageToPlayer > 0);
    assert.equal(blast[0].statusEffects[0].status, 'poison');
    assert.equal(bomber.pendingAttack, null, 'pending payload is cleared after resolution');
  });

  it('dash style: the Grave Charger closes and stuns on impact', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 5;
    player.y = 2;
    const charger = mkMonster('grave_charger', 2, 2);

    // Telegraph wind-up.
    const windUp = EntityAI.updateMonsters([charger], player, grid, 0.016);
    assert.equal(windUp[0].projectiles[0].type, 'telegraph');

    // Resolve: dash 3 tiles to (4,2), adjacent to the player at (5,2).
    const impact = EntityAI.updateMonsters([charger], player, grid, 0.5);
    assert.equal(charger.x, 4, 'charger dashed along its lane');
    assert.ok(impact[0].damageToPlayer > 0, 'impact deals catalog damage');
    assert.equal(impact[0].statusEffects[0].status, 'stun');
    assert.ok(impact[0].dashMoved > 0);
  });

  it('summon style: the Bone Summoner spawns catalog minions (no JS monster build)', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 8;
    player.y = 2;
    const summoner = mkMonster('bone_summoner', 2, 2);

    const results = EntityAI.updateMonsters([summoner], player, grid, 0.016);
    assert.equal(results.length, 1);
    assert.equal(results[0].spawns.length, 1);
    const spawn = results[0].spawns[0];
    assert.equal(spawn.type, 'crypt_skeleton');
    assert.equal(spawn.isSummon, true);
    assert.equal(spawn.summonedBy, summoner.id);
    assert.ok(grid.isWalkable(spawn.x, spawn.y));
  });

  it('an unknown attack kind falls back to melee instead of crashing', () => {
    const grid = floorGrid();
    const player = createPlayer('fighter');
    player.x = 2;
    player.y = 2;

    MONSTERS_CATALOG.__liv2_unknown_kind = {
      type: '__liv2_unknown_kind',
      name: 'Test Blob',
      baseHp: 10,
      baseAttack: 5,
      baseDefense: 0,
      moveCadence: 1,
      attackCadence: 1.5,
      damageMin: 4,
      damageMax: 4,
      aiType: 'ranged',
      attacks: [{ key: 'glitch', kind: 'mystery_kind', range: 1, minRange: 1, requiresLOS: false }],
      lootTable: [],
    };
    try {
      const blob = mkMonster('__liv2_unknown_kind', 3, 2);
      const results = EntityAI.updateMonsters([blob], player, grid, 0.016);
      assert.equal(results.length, 1, 'unknown kind resolves through the melee fallback');
      assert.equal(results[0].damageToPlayer, 4);
      assert.equal(results[0].projectiles, undefined);
    } finally {
      delete MONSTERS_CATALOG.__liv2_unknown_kind;
    }
  });
});

describe('LIV-2 AI framework: catalog status effects', () => {
  it('applies and ticks burn as a whole-HP damage-over-time', () => {
    const player = createPlayer('fighter');
    const maxHp = player.max_hp;

    assert.equal(CombatSystem.applyPlayerStatus(player, { status: 'burn', durationSec: 2, dps: 3 }), true);
    assert.equal(player.burnTimer, 2);

    const first = CombatSystem.tickPlayerStatusEffects(player, 1);
    assert.equal(first.burnDamage, 3);
    assert.equal(player.hp, maxHp - 3);

    const second = CombatSystem.tickPlayerStatusEffects(player, 1);
    assert.equal(second.burnDamage, 3);
    assert.equal(player.burnTimer, 0);
    assert.equal(player.burnDps, 0, 'burn clears when its timer expires');
  });

  it('applies and ticks poison separately from burn', () => {
    const player = createPlayer('fighter');
    CombatSystem.applyPlayerStatus(player, { status: 'poison', durationSec: 2, dps: 5 });
    const tick = CombatSystem.tickPlayerStatusEffects(player, 1);
    assert.equal(tick.poisonDamage, 5);
    assert.equal(tick.burnDamage, 0);
  });

  it('tracks slow and stun control timers', () => {
    const player = createPlayer('fighter');
    CombatSystem.applyPlayerStatus(player, { status: 'slow', durationSec: 2, factor: 0.5 });
    assert.equal(player.slowFactor, 0.5);
    assert.equal(CombatSystem.tickPlayerStatusEffects(player, 1).slowed, true);

    CombatSystem.applyPlayerStatus(player, { status: 'stun', durationSec: 1 });
    assert.equal(CombatSystem.tickPlayerStatusEffects(player, 0.5).stunned, true);
  });

  it('treats an unknown status as a safe no-op', () => {
    const player = createPlayer('fighter');
    assert.equal(CombatSystem.applyPlayerStatus(player, { status: 'mystery', durationSec: 5 }), false);
    assert.equal(player.stunTimer, undefined);
    assert.equal(player.burnTimer, undefined);
  });
});
