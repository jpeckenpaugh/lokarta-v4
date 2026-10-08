/**
 * LIV-92 (I5): wire the Dawnreach overworld-kit handlers.
 *
 * The three new foes dispatch through the shared LIV-2 catalog tables; this
 * suite locks in the three generic engine handlers they need:
 *  - `bleed`  — a whole-HP damage-over-time status (same shape as burn/poison),
 *  - `root`   — a positional movement lock (distinct from a full stun),
 *  - `attacks[].knockbackTiles` — generic AoE displacement away from a blast.
 *
 * Everything is driven from `monsters.json` data only — no per-monster `if`.
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
    hp: 200,
    max_hp: 200,
    isAggroed: true,
    attackCooldown: 0,
    moveCooldown: 0,
    ...overrides,
  };
}

function playerAt(x, y) {
  const player = createPlayer('fighter');
  player.x = x;
  player.y = y;
  player.hp = 100;
  player.max_hp = 100;
  return player;
}

describe('LIV-92 overworld kits: catalog contracts', () => {
  it('authors the three I5 kids as pure catalog data', () => {
    const hound = MONSTERS_CATALOG.salt_hound;
    assert.equal(hound.attacks[0].onHit.status, 'bleed');
    assert.equal(hound.attacks[0].onHit.durationSec, 3);
    assert.equal(hound.attacks[0].onHit.dps, 2);

    const wrecker = MONSTERS_CATALOG.mudlark_wrecker;
    assert.equal(wrecker.attacks[0].kind, 'projectile');
    assert.equal(wrecker.attacks[0].onHit.status, 'root');
    assert.equal(wrecker.attacks[0].onHit.durationSec, 1.5);
    assert.equal(wrecker.attacks[1].kind, 'melee');
    assert.equal(wrecker.attacks[1].range, 1);

    const slam = MONSTERS_CATALOG.barnacle_brute.attacks.find((a) => a.key === 'tide_slam');
    assert.equal(slam.kind, 'aoe');
    assert.equal(slam.knockbackTiles, 2);
    assert.equal(slam.telegraphSec, 0.7);
  });

  it('registers generic dispatch entries for the new statuses', () => {
    assert.equal(typeof CombatSystem.STATUS_EFFECT_APPLIERS.bleed, 'function');
    assert.equal(typeof CombatSystem.STATUS_EFFECT_APPLIERS.root, 'function');
    assert.equal(CombatSystem.applyPlayerStatus(playerAt(0, 0), { status: 'bleed', durationSec: 3, dps: 2 }), true);
    assert.equal(CombatSystem.applyPlayerStatus(playerAt(0, 0), { status: 'root', durationSec: 1.5 }), true);
  });
});

describe('LIV-92 overworld kits: salt_hound bleed', () => {
  it('bites adjacent and lands a 3s / 2dps bleed from catalog data', () => {
    const grid = floorGrid();
    const player = playerAt(2, 2);
    const hound = mkMonster('salt_hound', 3, 2);
    const results = EntityAI.updateMonsters([hound], player, grid, 0.016);
    assert.equal(results.length, 1);
    assert.ok(results[0].damageToPlayer > 0);
    assert.equal(results[0].statusEffects[0].status, 'bleed');
    assert.equal(results[0].statusEffects[0].durationSec, 3);
    assert.equal(results[0].statusEffects[0].dps, 2);
  });

  it('ticks whole HP only and clears the accumulator at expiry', () => {
    const player = playerAt(2, 2);
    assert.equal(
      CombatSystem.applyPlayerStatus(player, { status: 'bleed', durationSec: 3, dps: 2 }),
      true
    );
    assert.equal(player.bleedTimer, 3);
    assert.equal(player.bleedDps, 2);

    // Sub-second fractions accumulate, whole HP never leaks.
    let tick = CombatSystem.tickPlayerStatusEffects(player, 0.25);
    assert.equal(tick.bleedDamage, 0);
    assert.equal(player.hp, 100);
    tick = CombatSystem.tickPlayerStatusEffects(player, 0.25);
    assert.equal(tick.bleedDamage, 1);
    assert.equal(player.hp, 99);
    assert.equal(tick.damage, 1, 'bleedDamage is included in result.damage');

    // Continue to the 3s total: 2 dps x 3s = 6 whole HP.
    CombatSystem.tickPlayerStatusEffects(player, 0.5); // 1.0s -> 1
    CombatSystem.tickPlayerStatusEffects(player, 1.0); // 2.0s -> 2
    tick = CombatSystem.tickPlayerStatusEffects(player, 1.0); // 3.0s -> 2
    assert.equal(tick.bleedDamage, 2);
    assert.equal(player.hp, 94);
    assert.equal(player.bleedTimer, 0);
    assert.equal(player.bleedDps, 0, 'dps cleared at expiry');
    assert.equal(player.bleedAccumulator, 0, 'accumulator cleared at expiry');
    assert.equal(tick.poisonDamage, 0, 'bleed does not touch poison');
  });
});

describe('LIV-92 overworld kits: mudlark_wrecker root', () => {
  it('throws a net that roots the target at range', () => {
    const grid = floorGrid();
    const player = playerAt(2, 2);
    const wrecker = mkMonster('mudlark_wrecker', 6, 2);
    const results = EntityAI.updateMonsters([wrecker], player, grid, 0.016);
    assert.equal(results[0].projectiles[0].type, 'mudlark_net');
    assert.ok(results[0].damageToPlayer > 0);
    assert.equal(results[0].statusEffects[0].status, 'root');
    assert.equal(results[0].statusEffects[0].durationSec, 1.5);
  });

  it('roots positionally and expires cleanly', () => {
    const player = playerAt(2, 2);
    assert.equal(
      CombatSystem.applyPlayerStatus(player, { status: 'root', durationSec: 1.5 }),
      true
    );
    let tick = CombatSystem.tickPlayerStatusEffects(player, 1.0);
    assert.equal(player.rootTimer, 0.5);
    assert.equal(tick.rooted, true);
    tick = CombatSystem.tickPlayerStatusEffects(player, 0.6);
    assert.equal(player.rootTimer, 0);
    assert.equal(tick.rooted, false);
    // Root is a positional lock, not a full stun.
    assert.equal(player.stunTimer || 0, 0);
  });

  it('falls back to the knife when adjacent', () => {
    const grid = floorGrid();
    const player = playerAt(2, 2);
    const wrecker = mkMonster('mudlark_wrecker', 3, 2);
    const results = EntityAI.updateMonsters([wrecker], player, grid, 0.016);
    assert.equal(results.length, 1);
    assert.ok(results[0].damageToPlayer > 0);
    assert.equal(results[0].statusEffects, undefined, 'adjacent blow is the plain knife');
    assert.equal(results[0].projectiles, undefined);
  });
});

describe('LIV-92 overworld kits: barnacle_brute tide_slam knockback', () => {
  it('telegraphs, erupts, and shoves the player up to two tiles', () => {
    const grid = floorGrid();
    const player = playerAt(4, 2);
    const brute = mkMonster('barnacle_brute', 2, 2);

    const windUp = EntityAI.updateMonsters([brute], player, grid, 0.016);
    assert.equal(windUp[0].projectiles[0].type, 'telegraph');

    // Step out of the ring before the wind-up resolves; the blast stays put.
    player.x = 4;
    player.y = 3;
    const blast = EntityAI.updateMonsters([brute], player, grid, 0.8);
    assert.equal(blast[0].projectiles[0].type, 'aoe_burst');
    assert.equal(blast[0].statusEffects[0].status, 'slow');
    assert.equal(blast[0].knockbackMoved, 2);
    assert.equal(player.x, 4);
    assert.equal(player.y, 5);
  });

  it('stops at a non-walkable tile', () => {
    const grid = floorGrid();
    const player = playerAt(4, 2);
    const brute = mkMonster('barnacle_brute', 2, 4);
    const atk = MONSTERS_CATALOG.barnacle_brute.attacks.find((a) => a.key === 'tide_slam');
    grid.tiles[3][4].type = TILE_TYPES.WALL;

    const moved = EntityAI.applyBlastKnockback(brute, player, grid, [brute], atk, 4, 1);
    assert.equal(moved, 0);
    assert.equal(player.x, 4);
    assert.equal(player.y, 2);
  });

  it('stops at a monster-occupied tile (partial push)', () => {
    const grid = floorGrid();
    const player = playerAt(4, 2);
    const brute = mkMonster('barnacle_brute', 2, 4);
    const blocker = mkMonster('giant_rat', 4, 4);
    const atk = MONSTERS_CATALOG.barnacle_brute.attacks.find((a) => a.key === 'tide_slam');

    const moved = EntityAI.applyBlastKnockback(brute, player, grid, [brute, blocker], atk, 4, 1);
    assert.equal(moved, 1);
    assert.equal(player.y, 3);
  });

  it('is a byte-identical no-op without knockbackTiles', () => {
    const grid = floorGrid();
    const player = playerAt(4, 2);
    const brute = mkMonster('barnacle_brute', 2, 4);
    const moved = EntityAI.applyBlastKnockback(brute, player, grid, [brute], {}, 4, 1);
    assert.equal(moved, 0);
    assert.equal(player.x, 4);
    assert.equal(player.y, 2);
  });
});
