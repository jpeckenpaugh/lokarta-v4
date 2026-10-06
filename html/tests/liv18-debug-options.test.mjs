/**
 * LIV-18 FIX-3 — Options: Walk Thru Walls + Tester's Strength debug toggles.
 *
 * Both options are catalog-authored in `ui.json`, default OFF, and drive live
 * behavior: Walk Thru Walls lets the active member step onto in-bounds
 * non-walkable tiles, and Tester's Strength scales incoming attack and
 * damage-over-time damage through `CombatSystem`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { GridMap, TILE_TYPES, CombatSystem, createPlayer } from '../engine/index.js';
import { normalizeOptions, OPTION_DEFAULTS } from '../services/save-slots.js';
import { UI_CATALOG } from '../data/index.js';
import { readControllerSources } from './helpers/app-source.mjs';

const NORMAL_MULTIPLIER = CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER;

describe("Tester's Strength (debug, off by default)", () => {
  before(() => CombatSystem.setDebugIncomingDamageReductionPct(0));
  after(() => {
    CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER = NORMAL_MULTIPLIER;
  });

  it('leaves incoming attack damage untouched while disabled', () => {
    const player = createPlayer('fighter');
    player.hp = 1000;
    player.max_hp = 1000;

    const hit = CombatSystem.applyIncomingDamage(player, 100, null);
    assert.equal(hit.damageToPlayer, 100);
    assert.equal(player.hp, 900);
  });

  it('reduces incoming attack damage by the catalog percentage when enabled', () => {
    const player = createPlayer('fighter');
    player.hp = 1000;
    player.max_hp = 1000;

    CombatSystem.setDebugIncomingDamageReductionPct(
      UI_CATALOG.options.debug.testerStrengthDamageReductionPct
    );
    const hit = CombatSystem.applyIncomingDamage(player, 100, null);

    assert.equal(hit.damageToPlayer, 10, '90% reduction leaves 10% of damage');
    assert.equal(player.hp, 990);
  });

  it('also scales damage-over-time ticks', () => {
    const player = createPlayer('fighter');
    player.hp = 1000;
    player.max_hp = 1000;
    player.burnTimer = 10;
    player.burnDps = 100;
    player.burnAccumulator = 0;

    CombatSystem.setDebugIncomingDamageReductionPct(90);
    const tick = CombatSystem.tickPlayerStatusEffects(player, 1);

    assert.equal(tick.burnDamage, 10, '100 burn damage scales to 10');
    assert.equal(tick.damage, 10);
    assert.equal(player.hp, 990);
  });

  it('maps a 0-100 percentage onto the internal multiplier and clamps input', () => {
    CombatSystem.setDebugIncomingDamageReductionPct(90);
    assert.ok(Math.abs(CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER - 0.1) < 1e-9);
    CombatSystem.setDebugIncomingDamageReductionPct(0);
    assert.equal(CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER, 1);
    CombatSystem.setDebugIncomingDamageReductionPct('not-a-number');
    assert.equal(CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER, 1);
    CombatSystem.setDebugIncomingDamageReductionPct(250);
    assert.equal(CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER, 0);
  });
});

describe('Walk Thru Walls (debug, off by default)', () => {
  function mapWithFloor() {
    const grid = new GridMap(4, 4);
    grid.tiles[1][1].type = TILE_TYPES.FLOOR;
    return grid;
  }

  it('keeps walls, shut gates, springs, and blocked props impassable by default', () => {
    const grid = mapWithFloor();
    assert.equal(grid.canStep(0, 0), false, 'wall blocks');
    assert.equal(grid.canStep(1, 1), true, 'floor is walkable');

    grid.tiles[2][2].type = TILE_TYPES.GATED_DOOR;
    grid.tiles[2][2].gateOpen = false;
    assert.equal(grid.canStep(2, 2), false, 'shut gate blocks');

    grid.tiles[3][1].type = TILE_TYPES.SPRING;
    assert.equal(grid.canStep(3, 1), false, 'spring blocks');

    grid.tiles[1][3].blocked = true;
    assert.equal(grid.canStep(1, 3), false, 'blocked prop blocks');
  });

  it('allows any in-bounds tile when the toggle is on, including open-gate parity', () => {
    const grid = mapWithFloor();
    grid.tiles[2][2].type = TILE_TYPES.GATED_DOOR;
    grid.tiles[2][2].gateOpen = false;

    assert.equal(grid.canStep(0, 0, true), true, 'wall becomes passable');
    assert.equal(grid.canStep(2, 2, true), true, 'shut gate becomes passable');

    grid.tiles[2][2].gateOpen = true;
    assert.equal(grid.canStep(2, 2, false), true, 'opening the gate restores normal passage');
  });

  it('never lets the toggle carry the player off the map', () => {
    const grid = mapWithFloor();
    assert.equal(grid.canStep(-1, 0, true), false);
    assert.equal(grid.canStep(0, -1, true), false);
    assert.equal(grid.canStep(grid.width, 0, true), false);
    assert.equal(grid.canStep(0, grid.height, true), false);
  });
});

describe('Debug options are catalog-authored and default off', () => {
  it('normalizes both toggles off from empty, and honors explicit values', () => {
    const defaults = normalizeOptions(null);
    assert.equal(defaults.walkThruWalls, false);
    assert.equal(defaults.testerStrength, false);

    const enabled = normalizeOptions({ walkThruWalls: true, testerStrength: true });
    assert.equal(enabled.walkThruWalls, true);
    assert.equal(enabled.testerStrength, true);

    const forcedOff = normalizeOptions({ walkThruWalls: false, testerStrength: false });
    assert.equal(forcedOff.walkThruWalls, false);
    assert.equal(forcedOff.testerStrength, false);
  });

  it('exposes the off-by-default defaults and 90% magnitude in ui.json', () => {
    assert.equal(OPTION_DEFAULTS.walkThruWalls, false);
    assert.equal(OPTION_DEFAULTS.testerStrength, false);
    assert.equal(UI_CATALOG.options.debug.testerStrengthDamageReductionPct, 90);
  });

  it('surfaces both toggles in the Options modal and wires them into play', () => {
    const source = readControllerSources();
    assert.match(source, /toggle\('walkThruWalls', 'Walk Thru Walls'\)/, 'Walk Thru Walls toggle rendered');
    assert.match(source, /toggle\('testerStrength', "Tester's Strength"\)/, "Tester's Strength toggle rendered");
    assert.match(
      source,
      /canStep\(targetX, targetY, this\.options\?\.walkThruWalls === true\)/,
      'movement consults the Walk Thru Walls option'
    );
    assert.match(
      source,
      /setDebugIncomingDamageReductionPct\(o\.testerStrength \? debugPct : 0\)/,
      "options live-apply Tester's Strength"
    );
  });
});
