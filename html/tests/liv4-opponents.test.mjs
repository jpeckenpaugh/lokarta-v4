/**
 * LIV-4: New opponents & distinct attack/ability kits.
 *
 * Locks in the expansion bestiary authored as pure catalog data on top of the
 * LIV-2 dispatch contract:
 *  - the role taxonomy is covered (chaser, zoner, artillery, controller,
 *    elite, summoner, boss),
 *  - every addition is expressible as `monsters.json` data and actually runs
 *    through `EntityAI` (no bespoke JS behaviour),
 *  - no two additions share the same attack signature,
 *  - presentation resolves to committed sprites / OpenMoji assets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { EntityAI } from '../engine/entity-ai.js';
import { MONSTERS_CATALOG } from '../data/index.js';
import { SPRITE_CATALOG } from '../assets/sprites/index.js';
import { resolveSpriteId } from '../app/sprite-renderer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENMOJI_DIR = path.resolve(HERE, '..', 'assets', 'openmoji');

/** The eight opponents authored by LIV-4 (the LIV-2 demos are separate). */
const LIV4_OPPONENTS = [
  'mire_hound',
  'rime_acolyte',
  'sepulcher_mortar',
  'chime_wraith',
  'barrow_knight',
  'ossuary_priest',
  'brine_witch',
  'tidebound_king',
];

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
  return player;
}

describe('LIV-4 bestiary: role taxonomy coverage', () => {
  it('covers every role with at least one dedicated opponent', () => {
    const has = (type) => Boolean(MONSTERS_CATALOG[type]);
    // Pre-existing launch/demo anchors.
    assert.ok(has('giant_rat'), 'chaser anchor');
    assert.ok(has('shadow_cultist'), 'zoner anchor');
    assert.ok(has('elite_cultist'), 'elite anchor');
    assert.ok(has('bone_summoner'), 'summoner anchor');
    assert.ok(has('abyssal_overlord'), 'boss anchor');
    // LIV-4 role coverage.
    assert.equal(MONSTERS_CATALOG.mire_hound.aiType, 'charger', 'chaser/rusher');
    assert.equal(MONSTERS_CATALOG.rime_acolyte.aiType, 'ranged', 'zoner');
    assert.equal(MONSTERS_CATALOG.sepulcher_mortar.aiType, 'bomber', 'artillery');
    assert.equal(MONSTERS_CATALOG.chime_wraith.aiType, 'bomber', 'controller');
    assert.equal(MONSTERS_CATALOG.barrow_knight.aiType, 'charger', 'elite');
    assert.equal(MONSTERS_CATALOG.ossuary_priest.aiType, 'summoner', 'summoner');
    assert.equal(MONSTERS_CATALOG.tidebound_king.isBoss, true, 'boss');
  });

  it('gives each addition at least one catalog attack and a shared sprite', () => {
    for (const key of LIV4_OPPONENTS) {
      const m = MONSTERS_CATALOG[key];
      assert.ok(m, `missing LIV-4 opponent ${key}`);
      assert.ok(Array.isArray(m.attacks) && m.attacks.length > 0, `${key} must declare attacks`);
      assert.ok(m.spriteId, `${key} must declare a shared spriteId`);
    }
  });
});

describe('LIV-4 bestiary: distinct, non-overlapping kits', () => {
  it('no two LIV-4 opponents share an attack signature', () => {
    const signatures = new Map();
    for (const key of LIV4_OPPONENTS) {
      const sig = MONSTERS_CATALOG[key].attacks
        .map((a) => `${a.kind}:${a.onHit?.status || '-'}`)
        .sort()
        .join('|');
      assert.equal(signatures.get(sig), undefined, `${key} duplicates signature ${sig}`);
      signatures.set(sig, key);
    }
    assert.equal(signatures.size, LIV4_OPPONENTS.length);
  });

  it('covers the status toolbox (burn, poison, slow, stun) across the roster', () => {
    const statuses = new Set(
      Object.values(MONSTERS_CATALOG).flatMap((m) =>
        (m.attacks || []).map((a) => a.onHit?.status).filter(Boolean)
      )
    );
    for (const status of ['burn', 'poison', 'slow', 'stun']) {
      assert.ok(statuses.has(status), `roster must exercise the ${status} status`);
    }
  });
});

describe('LIV-4 bestiary: runs purely from catalog data', () => {
  it('Mire Hound bites and applies slow', () => {
    const grid = floorGrid();
    const player = playerAt(2, 2);
    const hound = mkMonster('mire_hound', 3, 2);
    const results = EntityAI.updateMonsters([hound], player, grid, 0.016);
    assert.equal(results.length, 1);
    assert.ok(results[0].damageToPlayer > 0);
    assert.equal(results[0].statusEffects[0].status, 'slow');
    assert.equal(results[0].statusEffects[0].factor, 0.5);
  });

  it('Rime Acolyte bolts frost and slows at range', () => {
    const grid = floorGrid();
    const player = playerAt(6, 2);
    const acolyte = mkMonster('rime_acolyte', 2, 2);
    const results = EntityAI.updateMonsters([acolyte], player, grid, 0.016);
    assert.equal(results[0].projectiles[0].type, 'frost_shard');
    assert.equal(results[0].statusEffects[0].status, 'slow');
  });

  it('Sepulcher Mortar telegraphs then erupts a fire AoE', () => {
    const grid = floorGrid();
    const player = playerAt(6, 2);
    const mortar = mkMonster('sepulcher_mortar', 2, 2);
    const windUp = EntityAI.updateMonsters([mortar], player, grid, 0.016);
    assert.equal(windUp[0].projectiles[0].type, 'telegraph');
    const blast = EntityAI.updateMonsters([mortar], player, grid, 1.2);
    assert.equal(blast[0].projectiles[0].type, 'aoe_burst');
    assert.equal(blast[0].statusEffects[0].status, 'burn');
  });

  it('Chime Wraith tolls a stunning AoE', () => {
    const grid = floorGrid();
    const player = playerAt(4, 2);
    const wraith = mkMonster('chime_wraith', 2, 2);
    const windUp = EntityAI.updateMonsters([wraith], player, grid, 0.016);
    assert.equal(windUp[0].projectiles[0].type, 'telegraph');
    const toll = EntityAI.updateMonsters([wraith], player, grid, 0.8);
    assert.equal(toll[0].statusEffects[0].status, 'stun');
  });

  it('Barrow Knight melees adjacent and slams at range 2', () => {
    const grid = floorGrid();
    const meleeKnight = mkMonster('barrow_knight', 3, 2);
    const melee = EntityAI.updateMonsters([meleeKnight], playerAt(2, 2), grid, 0.016);
    assert.equal(melee[0].statusEffects, undefined, 'adjacent blow is a plain graveblade');
    assert.ok(melee[0].damageToPlayer > 0);

    const slamKnight = mkMonster('barrow_knight', 4, 2);
    const slam = EntityAI.updateMonsters([slamKnight], playerAt(2, 2), grid, 0.016);
    assert.equal(slam[0].projectiles[0].type, 'telegraph', 'range-2 answer is the shudder');
  });

  it('Ossuary Priest summons catalog minions at its cap', () => {
    const grid = floorGrid();
    const player = playerAt(7, 2);
    const priest = mkMonster('ossuary_priest', 2, 2);
    const results = EntityAI.updateMonsters([priest], player, grid, 0.016);
    assert.equal(results[0].spawns.length, 1);
    assert.equal(results[0].spawns[0].type, 'crypt_skeleton');
  });

  it('Brine Witch hexes a long poison', () => {
    const grid = floorGrid();
    const player = playerAt(6, 2);
    const witch = mkMonster('brine_witch', 2, 2);
    const results = EntityAI.updateMonsters([witch], player, grid, 0.016);
    assert.equal(results[0].projectiles[0].type, 'brine_hex');
    assert.equal(results[0].statusEffects[0].status, 'poison');
    assert.equal(results[0].statusEffects[0].durationSec, 6);
  });

  it('The Tidebound King slams at range and summons tide hounds beyond it', () => {
    const grid = floorGrid();
    // In slam range (4): the AoE telegraph gates first.
    const slamKing = mkMonster('tidebound_king', 2, 2);
    const windUp = EntityAI.updateMonsters([slamKing], playerAt(5, 2), grid, 0.016);
    assert.equal(windUp[0].projectiles[0].type, 'telegraph', 'tidal slam telegraphs first');

    // Beyond slam but inside summon range (7): the wave summons.
    const summonKing = mkMonster('tidebound_king', 2, 8);
    const wave = EntityAI.updateMonsters([summonKing], playerAt(8, 8), grid, 0.016);
    assert.equal(wave[0].spawns[0].type, 'mire_hound');
  });
});

describe('LIV-4 bestiary: presentation resolves', () => {
  it('every addition resolves a committed sprite and OpenMoji asset', () => {
    for (const key of LIV4_OPPONENTS) {
      const m = MONSTERS_CATALOG[key];
      const spriteId = resolveSpriteId(m);
      assert.ok(spriteId, `${key} spriteId must resolve`);
      assert.ok(SPRITE_CATALOG[spriteId], `${key} -> ${spriteId} missing from sprite catalog`);
      assert.ok(
        fs.existsSync(path.join(OPENMOJI_DIR, `${m.svgCode}.svg`)),
        `${key} svgCode ${m.svgCode}.svg must be a committed asset`
      );
    }
  });
});

describe('LIV-4 bestiary: reward metadata', () => {
  it('every addition authors XP and a positive gold range', async () => {
    const { ECONOMY_CATALOG } = await import('../data/index.js');
    for (const key of LIV4_OPPONENTS) {
      const m = MONSTERS_CATALOG[key];
      assert.ok(m.baseXp > 0, `${key} must declare baseXp`);
      assert.ok(typeof m.xpFloorScale === 'number', `${key} must declare xpFloorScale`);
      const gold = ECONOMY_CATALOG.monsterGold[key];
      assert.ok(gold && gold.max >= gold.min, `${key} must author a monsterGold range`);
    }
  });
});
