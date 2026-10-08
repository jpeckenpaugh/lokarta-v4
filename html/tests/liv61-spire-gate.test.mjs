/**
 * LIV-61 P4 — Spire accessibility gate, save migration & scene gates
 *
 * Locks the Island 1 completion contract (LIV-55 §5, decisions D7/D8):
 *   - `spire_of_light` carries a data-driven `accessGate` (quest → flag/item);
 *   - `towerProgress.unlockedTowerIds` stays the source of truth, written by the
 *     `unlock_tower` reward and the legacy backfill;
 *   - the gate is enforced identically at the island Tide Gate and the worker
 *     `handleSelectTower`, so a locked tower can never be entered by bypassing
 *     the picker (no soft-lock: the prompt names the missing rite);
 *   - DB v2→v3 + save format v3→v4 migration is idempotent and existing saves
 *     stay unlocked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getTowerDefinition,
  firstTowerId,
  TOWER_LEVELS_CATALOG,
} from '../data/index.js';

import {
  createPartyPlayer,
  createTowerProgress,
  isTowerUnlocked,
} from '../engine/party.js';

import {
  evaluateTowerAccess,
  isTowerAccessible,
  evaluateSceneGate,
} from '../engine/access-gate.js';

import {
  DB_VERSION,
  STORES,
  WORLD_MIGRATION_GUARD_KEY,
  openStorage,
  put,
  read,
  clearStore,
  migrateWorldSave,
} from '../services/storage.js';

import { SAVE_FORMAT_VERSION } from '../services/save-slots.js';
import { COMMAND_HANDLERS } from '../worker/game-worker.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
import { GridMap } from '../engine/grid-map.js';
import { TILE_TYPES } from '../engine/config.js';
import { withFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const SPIRE = 'spire_of_light';
const RITE = 'rite_of_the_beacon';

/** A bare player shaped only as far as the access gate reads it. */
function gatePlayer(overrides = {}) {
  return {
    level: 1,
    towerProgress: createTowerProgress(),
    questState: { version: 1, quests: {} },
    worldFlags: {},
    action_bar: [],
    backpack: [],
    paperdoll: { main_hand: null, off_hand: null, armor: null, relic: null },
    ...overrides,
  };
}

const turnedIn = { version: 1, quests: { [RITE]: { status: 'turned_in', objectives: {} } } };

test('LIV-61 catalog: the Spire carries a data-driven accessGate', () => {
  const spire = getTowerDefinition(SPIRE);
  assert.ok(spire, 'spire_of_light exists');
  assert.ok(spire.accessGate, 'the Spire declares an accessGate');
  assert.equal(spire.accessGate.kind, 'quest');
  assert.equal(spire.accessGate.questId, RITE);
  assert.equal(spire.accessGate.state, 'turned_in');
  assert.equal(spire.accessGate.flag, 'beaconLit');
  assert.equal(spire.accessGate.requiredItem, 'tidegate_signet');
  assert.equal(typeof spire.accessGate.deniedHintKey, 'string');
  assert.equal(TOWER_LEVELS_CATALOG.defaultTowerId, SPIRE);
});

test('LIV-61 tower gate: new saves are locked; source of truth + gate clauses unlock', () => {
  // Fresh save: nothing unlocked, gate clauses unsatisfied → locked.
  const fresh = gatePlayer();
  assert.deepEqual(fresh.towerProgress.unlockedTowerIds, []);
  assert.equal(isTowerUnlocked(fresh.towerProgress, SPIRE), false);
  const locked = evaluateTowerAccess(fresh, SPIRE);
  assert.equal(locked.unlocked, false);
  assert.equal(locked.reason, 'access_gate');
  assert.equal(locked.hintKey, getTowerDefinition(SPIRE).accessGate.deniedHintKey);

  // Source of truth: an explicit unlock opens the gate.
  assert.equal(
    isTowerAccessible(gatePlayer({ towerProgress: { completedTowerIds: [], unlockedTowerIds: [SPIRE] } }), SPIRE),
    true
  );

  // Quest turned in + level guard + signet satisfies the authored clause.
  assert.equal(
    isTowerAccessible(gatePlayer({ level: 3, questState: turnedIn, action_bar: [{ item_id: 'tidegate_signet', quantity: 1 }] }), SPIRE),
    true
  );
  // Missing the signet keeps the quest clause closed.
  assert.equal(isTowerAccessible(gatePlayer({ level: 3, questState: turnedIn }), SPIRE), false);
  // Level guard still blocks below L3.
  assert.equal(
    isTowerAccessible(gatePlayer({ level: 2, questState: turnedIn, action_bar: [{ item_id: 'tidegate_signet', quantity: 1 }] }), SPIRE),
    false
  );

  // Anti-soft-lock flag clause: the world flag alone keeps the gate open.
  assert.equal(isTowerAccessible(gatePlayer({ worldFlags: { beaconLit: true } }), SPIRE), true);

  // Unknown towers are rejected, never silently allowed.
  const unknown = evaluateTowerAccess(fresh, 'not_a_tower');
  assert.equal(unknown.unlocked, false);
  assert.equal(unknown.reason, 'unknown_tower');

  // A fresh party player is also locked (D7).
  assert.equal(isTowerAccessible(createPartyPlayer('magician'), SPIRE), false);
});

test('LIV-61 scene gate: the Tide Gate opens only after the rite', () => {
  const gate = {
    id: 'tide_gate',
    requireQuestId: RITE,
    lockedPromptKey: 'tide_gate_locked',
    openPromptKey: 'tide_gate_open',
    tiles: [[23, 10], [24, 10], [25, 10]],
  };
  assert.deepEqual(evaluateSceneGate(gatePlayer(), gate), { open: false, promptKey: 'tide_gate_locked' });
  assert.deepEqual(evaluateSceneGate(gatePlayer({ questState: turnedIn }), gate), { open: true, promptKey: 'tide_gate_open' });
  // An ungated gate is always passable.
  assert.equal(evaluateSceneGate(gatePlayer(), { id: 'open_gate' }).open, true);
  assert.equal(evaluateSceneGate(gatePlayer(), null).open, false);
});

test('LIV-61 scene gate opener: locked blocks with a prompt, open walks through', () => {
  const scene = {
    sceneId: 'island_dawnreach',
    gates: [{ id: 'tide_gate', requireQuestId: RITE, lockedPromptKey: 'tide_gate_locked', openPromptKey: 'tide_gate_open', tiles: [[2, 2]] }],
  };
  const gridMap = new GridMap(6, 6);
  const row = new Array(6).fill(TILE_TYPES.GRASS);
  row[2] = TILE_TYPES.GATED_DOOR;
  gridMap.loadFromMatrix([[...row], [...row], [...row], [...row], [...row], [...row]]);

  const calls = { logs: [], float: [] };
  const app = Object.assign({}, sceneControllerMethods, {
    scene,
    player: gatePlayer({ towerProgress: { completedTowerIds: [], unlockedTowerIds: [SPIRE] } }),
    gridMap,
    logCombat: (m) => calls.logs.push(m),
    addFloatingText: (t) => calls.float.push(t),
  });

  // Locked: no walk-through, a clear prompt is shown, tile stays shut.
  assert.equal(app.openSceneGateAt(2, 2), false);
  assert.equal(gridMap.getTile(2, 2).gateOpen, false);
  assert.equal(calls.logs.length, 1);
  assert.equal(calls.float[0], 'SEALED');

  // Turned in: the gate opens and the tile becomes walkable.
  app.player.questState = turnedIn;
  assert.equal(app.openSceneGateAt(2, 2), true);
  assert.equal(gridMap.getTile(2, 2).gateOpen, true);
  assert.equal(gridMap.isWalkable(2, 2), true);
});

test('LIV-61 quest markers: available/turn-in flags derive from quest data', () => {
  const app = Object.assign({}, sceneControllerMethods, {
    player: gatePlayer({ questState: { version: 1, quests: { [RITE]: { status: 'complete', objectives: {} } } } }),
    npcs: [
      { npcId: 'captain_halden' },   // Q1 giver, not yet accepted -> available
      { npcId: 'elder_rowan_vane' }, // Q3 turn-in, complete -> turn-in
      { npcId: 'innkeep_bessa' },    // no quest role -> none
    ],
  });
  app.refreshQuestMarkers();
  assert.equal(app.npcs[0].questMarker, 'available');
  assert.equal(app.npcs[1].questMarker, 'turnin');
  assert.equal(app.npcs[2].questMarker, null);
});

test('LIV-61 persistence: DB v3, save format v4, slot_scenes store', () => {
  assert.equal(DB_VERSION, 3);
  assert.equal(SAVE_FORMAT_VERSION, 4, 'save format bumped v3 -> v4 (LIV-55 P4)');
  assert.equal(STORES.SLOT_SCENES, 'slot_scenes');
  assert.equal(WORLD_MIGRATION_GUARD_KEY, 'migration_world_v5');
});

test('LIV-61 worker: a locked Spire is rejected; the quest unlock enters unchanged', async (t) => {
  await withFakeIndexedDB(async () => {
    const created = await COMMAND_HANDLERS.createSlot({ slotIndex: 1, vocation: 'magician' });
    assert.deepEqual(created.player.towerProgress.unlockedTowerIds, [], 'new save starts locked');

    // The picker cannot enter a quest-locked tower.
    await assert.rejects(
      () => COMMAND_HANDLERS.selectTower({ slotIndex: 1, towerId: SPIRE }),
      /locked/i
    );

    // Simulate the Q3 turn-in: quest turned in, level guard, signet held.
    const stored = await read(STORES.CHARACTERS, 'char_slot_1');
    stored.level = 3;
    stored.party[0].level = 3;
    stored.questState = turnedIn;
    stored.worldFlags = { beaconLit: true };
    stored.action_bar = [{ item_id: 'tidegate_signet', quantity: 1 }];
    await put(STORES.CHARACTERS, stored);

    const moved = await COMMAND_HANDLERS.selectTower({ slotIndex: 1, towerId: SPIRE });
    assert.equal(moved.player.towerId, SPIRE);
    assert.equal(moved.floor.tower_id, SPIRE, 'the existing tower flow runs unchanged');
    assert.equal(moved.player.current_floor, 1);
  });
});

test('LIV-61 migration: legacy saves stay Spire-unlocked, idempotently (D8)', async (t) => {
  await withFakeIndexedDB(async () => {
    await openStorage();
    // A veteran pre-gate character + slot with no saved version and no unlocks.
    await put(STORES.CHARACTERS, {
      id: 'char_legacy',
      vocation: 'archer',
      level: 5,
      current_floor: 2,
      hp: 20, max_hp: 40, mana: 5, max_mana: 20,
      x: 2, y: 2, xp: 10,
      action_bar: [], backpack: [], paperdoll: {}, skillBoosts: {},
      towerProgress: { completedTowerIds: [], unlockedTowerIds: [] },
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await put(STORES.SAVE_SLOTS, {
      id: 'slot_2', slotIndex: 2, status: 'occupied', characterId: 'char_legacy',
      vocation: 'archer', level: 5, currentFloor: 2, floorEntry: { current_floor: 2 },
    });

    const result = await migrateWorldSave();
    assert.ok(result.towersBackfilled >= 1, 'legacy character is backfilled');

    const character = await read(STORES.CHARACTERS, 'char_legacy');
    assert.equal(character.saveVersion, 4, 'stamped at the current format');
    assert.ok(character.towerProgress.unlockedTowerIds.includes(firstTowerId()), 'veteran keeps the Spire');
    assert.ok(character.questState, 'quest envelope added');
    assert.ok(character.worldFlags, 'world-flag envelope added');

    const slot = await read(STORES.SAVE_SLOTS, 'slot_2');
    assert.ok(slot.towerProgress.unlockedTowerIds.includes(firstTowerId()), 'slot mirror keeps the Spire');

    const guard = await read(STORES.GAME_SETTINGS, WORLD_MIGRATION_GUARD_KEY);
    assert.ok(guard && guard.done, 'migration guard written');

    const rerun = await migrateWorldSave();
    assert.equal(rerun.recordsMigrated, 0, 'rerun is an idempotent no-op');
    assert.equal(rerun.towersBackfilled, 0);

    // A brand-new save created at the current format is never backfilled: it
    // starts locked and stays locked.
    const fresh = await COMMAND_HANDLERS.createSlot({ slotIndex: 3, vocation: 'fighter' });
    assert.deepEqual(fresh.player.towerProgress.unlockedTowerIds, []);
    assert.equal(isTowerUnlocked(fresh.player.towerProgress, SPIRE), false);
  });
});

test('LIV-61 migration: occupied slots gain a slot_scenes pointer', async (t) => {
  await withFakeIndexedDB(async () => {
    await openStorage();
    await put(STORES.SAVE_SLOTS, {
      id: 'slot_4', slotIndex: 4, status: 'occupied', characterId: 'char_x',
      vocation: 'paladin', level: 2, currentFloor: 1, floorEntry: { current_floor: 1 },
    });
    await put(STORES.CHARACTERS, {
      id: 'char_x', vocation: 'paladin', level: 2, current_floor: 1,
      hp: 10, max_hp: 10, mana: 0, max_mana: 0, x: 1, y: 1, xp: 0,
      action_bar: [], backpack: [], paperdoll: {}, skillBoosts: {},
      scene: { sceneId: 'island_dawnreach', spawn: { x: 24, y: 28 } },
      updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    });

    await migrateWorldSave();
    const scene = await read(STORES.SLOT_SCENES, 4);
    assert.ok(scene, 'slot_scenes record written');
    assert.equal(scene.sceneId, 'island_dawnreach');
    assert.deepEqual(scene.spawn, { x: 24, y: 28 });

    // resetProgress clears the store and the guard (verified via clear + read).
    await clearStore(STORES.SLOT_SCENES);
    assert.equal(await read(STORES.SLOT_SCENES, 4), null);
  });
});
