/**
 * Regression suite.
 *
 * Board bug: on level 3 / room 2, killing a boss-flagged enemy (Elite Cultist
 * key holder) as any vocation froze the game with:
 *
 *   combat-controller.js:418 Uncaught ReferenceError: TOWER_LEVEL_COUNT is not defined
 *
 * The Controller extraction moved `handleCombatResult` into
 * `html/app/combat-controller.js` but dropped the `TOWER_LEVEL_COUNT` import
 * that `app-controller.js` had. The final-floor guard only touches that binding
 * when a boss is defeated, so the break was invisible to import-only tests.
 *
 * These tests drive the real boss-defeat path so a missing import fails loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { combatControllerMethods } from '../app/combat-controller.js';
import { createPlayer } from '../engine/config.js';
import { TOWER_LEVEL_COUNT } from '../services/floor-generator.js';

/** Builds a minimal `this` for the combat-controller prototype mixin. */
function makeApp(overrides = {}) {
  const app = Object.create(combatControllerMethods);
  app.player = createPlayer('magician');
  app.player.current_floor = 3;
  app.player.x = 2;
  app.player.y = 2;
  app.monsters = [];
  app.isFinalFloor = false;
  app.deathEffects = [];
  app.projectiles = [];
  app.selectedMonsterId = null;
  app.floorClearCalls = 0;
  app.gridMap = {
    width: 10,
    isInBounds: () => true,
    isWalkable: () => true,
    getItems: () => [],
    addItem() {},
  };
  app.logCombat = () => {};
  app.addFloatingText = () => {};
  app.persistSave = () => {};
  app.showFateGrantModal = () => {};
  app.handleFloorClear = () => { app.floorClearCalls += 1; };
  return Object.assign(app, overrides);
}

/** A boss-flagged Elite Cultist key holder (level 3 / room 2). */
function eliteCultistBoss() {
  return {
    id: 'elite_cultist_keyholder',
    name: 'Elite Cultist',
    type: 'elite_cultist',
    x: 3,
    y: 2,
    hp: 0,
    max_hp: 250,
    isBoss: true,
    facing: 'down',
  };
}

test('Boss-defeat path resolves the final-floor guard', async (t) => {
  await t.test('level 3 boss kill runs to completion without a missing-import ReferenceError', () => {
    const app = makeApp();
    app.monsters = [eliteCultistBoss()];

    assert.doesNotThrow(() => {
      app.handleCombatResult(
        { success: true, defeatedMonsterId: 'elite_cultist_keyholder', damageDealt: 40, droppedLoot: [] },
        3,
        2
      );
    }, 'handleCombatResult must not throw when evaluating TOWER_LEVEL_COUNT');

    assert.equal(app.monsters.length, 0, 'the defeated boss is removed');
    assert.equal(app.deathEffects.length, 1, 'a death effect is spawned');
    assert.equal(app.floorClearCalls, 0, `level 3 is below TOWER_LEVEL_COUNT (${TOWER_LEVEL_COUNT}); no campaign ending`);
  });

  await t.test('final-floor boss kill schedules the campaign ending', () => {
    const app = makeApp({ isFinalFloor: true });
    app.monsters = [eliteCultistBoss()];

    const realSetTimeout = globalThis.setTimeout;
    let scheduled = null;
    globalThis.setTimeout = (fn, ms) => {
      scheduled = { fn, ms };
      return 0;
    };
    try {
      app.handleCombatResult(
        { success: true, defeatedMonsterId: 'elite_cultist_keyholder', damageDealt: 99, droppedLoot: [] },
        3,
        2
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.ok(scheduled, 'the summit handoff must be scheduled on the final floor');
    assert.equal(scheduled.ms, 600);
    scheduled.fn();
    assert.equal(app.floorClearCalls, 1, 'handleFloorClear runs the campaign ending');
  });
});
