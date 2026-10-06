/**
 * Lokarta: "Ascend the Tower" - E8 stair traversal tests
 *
 * Covers the D2 §3/§9.3 contract that the runtime stair resolver never ignored:
 *   - a stair's authored `dir`/`targetLevel` selects the destination, both ways;
 *   - the arrival tile stays disarmed until the player steps off it;
 *   - the level-5 summit resolves to victory, and only after the guardian dies;
 *   - the app wires the authored stair metadata into `applyDungeonData`.
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findStairAt,
  resolveStairTarget,
  StairSystem,
} from '../engine/stair-system.js';
import { GridMap, createPlayer } from '../engine/index.js';
import { firstTowerId, nextTowerIdAfter } from '../data/index.js';
import { generateFloor, TOWER_LEVEL_COUNT } from '../services/floor-generator.js';
import { LokartaApp } from '../app/app-controller.js';

const LEVELS = [1, 2, 3, 4, 5];

describe('StairSystem resolver', () => {
  it('finds a stair by tile and returns null off-stair', () => {
    const stairs = [{ x: 3, y: 4, dir: 'down', targetLevel: 2 }];
    assert.equal(findStairAt(stairs, 3, 4).dir, 'down');
    assert.equal(findStairAt(stairs, 4, 4), null);
    assert.equal(findStairAt(null, 3, 4), null);
  });

  it('honors authored dir/targetLevel for up, down, and summit', () => {
    assert.deepEqual(
      resolveStairTarget({ dir: 'up', targetLevel: 1 }, 2),
      { kind: 'transition', dir: 'up', targetLevel: 1 }
    );
    assert.deepEqual(
      resolveStairTarget({ dir: 'down', targetLevel: 3 }, 2),
      { kind: 'transition', dir: 'down', targetLevel: 3 }
    );
    assert.deepEqual(
      resolveStairTarget({ dir: 'summit', targetLevel: null }, 5),
      { kind: 'summit', dir: 'summit', targetLevel: null }
    );
  });

  it('falls back to shaft arithmetic when targetLevel is absent', () => {
    assert.equal(resolveStairTarget({ dir: 'up' }, 3).targetLevel, 2);
    assert.equal(resolveStairTarget({ dir: 'down' }, 3).targetLevel, 4);
    // No level above the tower: safe no-op, never a negative level.
    assert.equal(resolveStairTarget({ dir: 'up' }, 1).kind, 'noop');
  });

  it('treats a missing/unknown direction as a no-op', () => {
    assert.equal(resolveStairTarget({ x: 1, y: 1 }, 2).kind, 'noop');
    assert.equal(resolveStairTarget({ dir: 'sideways', targetLevel: 2 }, 2).kind, 'noop');
    assert.equal(resolveStairTarget(null, 2), null);
  });

  it('resolves only armed stairs under the player', () => {
    const sys = new StairSystem([{ x: 5, y: 5, dir: 'down', targetLevel: 2 }], 1);
    assert.equal(sys.resolve(5, 5).targetLevel, 2);
    assert.equal(sys.resolve(5, 6), null);
  });

  it('keeps the arrival tile disarmed until the player steps off (§9.3)', () => {
    const stairs = [{ x: 33, y: 33, dir: 'up', targetLevel: 1 }];
    const sys = new StairSystem(stairs, 2, { x: 33, y: 33 });

    sys.syncArmed(33, 33);
    assert.equal(sys.isDisarmed(33, 33), true);
    assert.equal(sys.resolve(33, 33), null, 'arrival stair must not retrigger');

    sys.syncArmed(32, 33);
    assert.equal(sys.isDisarmed(33, 33), false, 'stepping off re-arms the stair');

    sys.syncArmed(33, 33);
    const res = sys.resolve(33, 33);
    assert.equal(res.kind, 'transition');
    assert.equal(res.targetLevel, 1);
  });

  it('setStairs replaces the active floor and clears the arrival disarm', () => {
    const sys = new StairSystem([{ x: 1, y: 1, dir: 'down', targetLevel: 2 }], 1, { x: 1, y: 1 });
    assert.equal(sys.isDisarmed(1, 1), true);
    sys.setStairs([{ x: 2, y: 2, dir: 'summit', targetLevel: null }], 5);
    assert.equal(sys.isDisarmed(1, 1), false);
    assert.equal(sys.resolve(2, 2).kind, 'summit');
    assert.equal(sys.resolve(1, 1), null);
  });
});

describe('E8 stair traversal on generated tower floors', () => {
  it('authors a two-way shaft resolved by targetLevel, with no summit down-stair', () => {
    const floors = new Map(LEVELS.map(level => [level, generateFloor(level)]));

    const hop = (level, dir) => {
      const floor = floors.get(level);
      const stair = floor.stairs.find(s => s.dir === dir);
      if (!stair) return null;
      const sys = new StairSystem(floor.stairs, level);
      const res = sys.resolve(stair.x, stair.y);
      return res ? { kind: res.kind, targetLevel: res.targetLevel } : null;
    };

    // Descend the full shaft 1 -> 2 -> 3 -> 4 -> 5.
    let level = 1;
    for (const expected of [2, 3, 4, 5]) {
      const res = hop(level, 'down');
      assert.equal(res.kind, 'transition', `L${level} down must transition`);
      assert.equal(res.targetLevel, expected, `L${level} down targetLevel`);
      level = res.targetLevel;
    }

    // Level 5 has no down-stair; its summit resolves to victory.
    assert.equal(hop(5, 'down'), null);
    assert.equal(hop(5, 'summit').kind, 'summit');

    // Ascend back 5 -> 4 -> 3 -> 2 -> 1 using the up-stairs.
    for (const expected of [4, 3, 2, 1]) {
      const res = hop(level, 'up');
      assert.equal(res.kind, 'transition', `L${level} up must transition`);
      assert.equal(res.targetLevel, expected, `L${level} up targetLevel`);
      level = res.targetLevel;
    }

    assert.equal(level, 1);
    assert.equal(hop(1, 'up'), null);
  });

  it('arrival arming stops a loop when respawning onto the up-stair', () => {
    // Simulates a spawn placed directly on the arrival stair (defensive): the
    // player must step off and back on before the stair fires again.
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      const up = floor.stairs.find(s => s.dir === 'up');
      if (!up) continue;
      const sys = new StairSystem(floor.stairs, level, { x: up.x, y: up.y });

      for (let tick = 0; tick < 5; tick++) {
        sys.syncArmed(up.x, up.y);
        assert.equal(sys.resolve(up.x, up.y), null, `L${level} arrival loop on tick ${tick}`);
      }

      sys.syncArmed(up.x - 1, up.y);
      sys.syncArmed(up.x, up.y);
      const res = sys.resolve(up.x, up.y);
      assert.equal(res.targetLevel, level - 1, `L${level} up-stair returns to the previous level`);
    }
  });
});

test('E8 app wires authored stairs/is_final into applyDungeonData', () => {
  const app = Object.create(LokartaApp.prototype);
  app.player = createPlayer('magician');
  app.player.current_floor = 5;
  app.player.x = 20;
  app.player.y = 33;
  app.gridMap = new GridMap();
  app.chests = [];
  app.monsters = [];
  app.ambientLights = [];
  app.stairHint = null;

  const floor = generateFloor(5);
  app.applyDungeonData(floor);

  assert.equal(app.isFinalFloor, true);
  assert.equal(app.stairs.length, floor.stairs.length);
  assert.ok(app.stairSystem instanceof StairSystem);
  assert.equal(app.stairSystem.currentLevel, 5);
  const summit = floor.stairs.find(s => s.dir === 'summit');
  assert.equal(app.stairSystem.resolve(summit.x, summit.y).kind, 'summit');
});

test('E8 final-floor detection is catalog-driven, not the retired 20-floor constant', () => {
  assert.equal(TOWER_LEVEL_COUNT, 5);

  const app = Object.create(LokartaApp.prototype);
  app.player = createPlayer('magician');
  app.player.current_floor = 5;
  app.player.x = 5;
  app.player.y = 5;
  app.gridMap = new GridMap();
  app.chests = [];
  app.monsters = [];
  app.ambientLights = [];
  app.stairHint = null;

  // A floor payload without is_final still detects the final level from
  // TOWER_LEVEL_COUNT (worker level 6 would clamp to 5).
  const floor = generateFloor(5);
  delete floor.is_final;
  app.applyDungeonData(floor);
  assert.equal(app.isFinalFloor, true);
});

test('E8 handleFloorClear keeps the summit sealed while the guardian lives', async () => {
  const app = Object.create(LokartaApp.prototype);
  app.player = { x: 20, y: 20, current_floor: 5, facing: 'down', slotIndex: 1 };
  app.isFloorCleared = false;
  app.isPaused = false;
  app.isFinalFloor = true;
  app.towerId = firstTowerId();
  app.towerProgress = { completedTowerIds: [], unlockedTowerIds: [firstTowerId()] };
  app.monsters = [{ id: 'boss', isBoss: true, hp: 100 }];
  app.stairHint = null;

  let victoryShown = false;
  let towerCompleteShown = false;
  let logs = 0;
  app.persistSave = async () => {};
  app.updateHUD = () => {};
  app.showVictoryModal = () => { victoryShown = true; };
  app.showTowerCompleteModal = () => { towerCompleteShown = true; };
  app.gameClient = {
    completeTower: async () => ({
      player: { ...app.player, towerProgress: { completedTowerIds: [firstTowerId()], unlockedTowerIds: [firstTowerId(), nextTowerIdAfter(firstTowerId())] } },
      allComplete: false,
      nextTowerId: nextTowerIdAfter(firstTowerId()),
      recruitableVocations: ['archer', 'fighter', 'paladin'],
    }),
  };
  app.logCombat = () => { logs += 1; };
  app.addFloatingText = () => {};

  assert.equal(app.isGuardianAlive(), true);

  await app.handleFloorClear({ kind: 'summit', dir: 'summit', targetLevel: null });
  assert.equal(towerCompleteShown, false);
  assert.equal(app.isFloorCleared, false);
  assert.equal(logs, 1, 'sealed feedback logs once, not every tick');

  // Repeated ticks must not spam the log.
  await app.handleFloorClear({ kind: 'summit', dir: 'summit', targetLevel: null });
  assert.equal(logs, 1);

  // Once the guardian dies the summit resolves to a non-terminal Tower Complete.
  app.monsters = [];
  await app.handleFloorClear({ kind: 'summit', dir: 'summit', targetLevel: null });
  assert.equal(towerCompleteShown, true);
  assert.equal(victoryShown, false, 'one tower is not Ultimate Victory');
  assert.equal(app.isFloorCleared, true);
});

test('E8 handleFloorClear honors targetLevel instead of current+1', async () => {
  const app = Object.create(LokartaApp.prototype);
  app.player = createPlayer('magician');
  app.player.current_floor = 2;
  app.player.x = 33;
  app.player.y = 19;
  app.isFloorCleared = false;
  app.isPaused = false;
  app.isFinalFloor = false;
  app.monsters = [];
  app.gridMap = new GridMap();
  app.ambientLights = [];
  app.stairHint = null;
  app.modalOverlayEl = { classList: { contains: () => true } };

  const advancedTo = [];
  app.gameClient = {
    advanceFloor: async (player, next) => {
      advancedTo.push(next);
      return {
        player: { ...player, current_floor: next, x: 1, y: 1, action_bar: [], backpack: [] },
        floor: generateFloor(next),
      };
    },
  };
  app.transition = { run: async (_name, fn) => { await fn(); } };
  app.persistSave = async () => {};
  app.updateHUD = () => {};
  app.showFateGrantModal = () => {};
  app.logCombat = () => {};
  app.addFloatingText = () => {};

  // Up from level 2 -> level 1 (the old buggy path advanced to 3).
  await app.handleFloorClear({ kind: 'transition', dir: 'up', targetLevel: 1 });
  assert.deepEqual(advancedTo, [1]);
  assert.equal(app.player.current_floor, 1);
  assert.equal(app.isFloorCleared, false);

  // Down from level 1 -> level 2.
  app.player.current_floor = 1;
  await app.handleFloorClear({ kind: 'transition', dir: 'down', targetLevel: 2 });
  assert.deepEqual(advancedTo, [1, 2]);
  assert.equal(app.player.current_floor, 2);
});

test('E8 handleFloorClear no-ops on an unauthored stair direction', async () => {
  const app = Object.create(LokartaApp.prototype);
  app.player = { x: 3, y: 3, current_floor: 2, facing: 'down' };
  app.isFloorCleared = false;
  app.isPaused = false;
  app.isFinalFloor = false;
  app.monsters = [];
  app.stairHint = null;

  let logs = 0;
  app.persistSave = async () => {};
  app.showVictoryModal = () => { throw new Error('must not win'); };
  app.logCombat = () => { logs += 1; };

  await app.handleFloorClear({ kind: 'noop', dir: null, targetLevel: null });
  assert.equal(app.isFloorCleared, false);
  assert.equal(logs, 1);
});
