import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openStorage,
  closeStorage,
  put,
  read,
  getAll,
  STORES,
  MIGRATION_GUARD_KEY,
  TOWER_MIGRATION_GUARD_KEY,
  migrateLegacySave,
  migrateTowerSave,
} from '../services/storage.js';

import {
  clampTowerFloor,
  migratePlayerToTower,
  normalizeSlotToTower,
  SAVE_FORMAT_VERSION,
  TOWER_LEVEL_COUNT as TOWER_FLOOR_COUNT,
} from '../services/save-slots.js';

/**
 * Minimal in-memory IndexedDB shim, just large enough to exercise
 * `html/services/storage.js`. It enforces the same in-line keyPath contract as
 * a browser: `put(value, explicitKey)` on an in-line-keyed store must reject
 * with a `DataError`. That is the exact defect this suite guards against.
 *
 * Registered on `globalThis.indexedDB` per test and torn down afterwards.
 */
function createFakeIndexedDB() {
  const queue = (fn) => queueMicrotask(fn);
  const keyId = (key) => JSON.stringify(key);
  const decodeInlineKey = (keyPath, value) =>
    Array.isArray(keyPath) ? keyPath.map((k) => value[k]) : value[keyPath];

  function dataError() {
    const err = new Error('The object store uses in-line keys and the key parameter was provided.');
    err.name = 'DataError';
    return err;
  }

  class FakeRequest {
    constructor() {
      this.onsuccess = null;
      this.onerror = null;
      this.result = undefined;
      this.error = null;
    }
    succeed(result) {
      queue(() => {
        this.result = result;
        this.onsuccess?.({ target: this });
      });
    }
    fail(error) {
      queue(() => {
        this.error = error;
        this.onerror?.({ target: this });
      });
    }
  }

  class FakeObjectStore {
    constructor(name, keyPath) {
      this.name = name;
      this.keyPath = keyPath ?? null;
      this.data = new Map();
    }
    get(key) {
      const req = new FakeRequest();
      req.succeed(this.data.has(keyId(key)) ? structuredClone(this.data.get(keyId(key))) : undefined);
      return req;
    }
    getAll() {
      const req = new FakeRequest();
      req.succeed([...this.data.values()].map((v) => structuredClone(v)));
      return req;
    }
    put(value, key) {
      const req = new FakeRequest();
      let effective;
      if (this.keyPath !== null) {
        if (key !== undefined) {
          req.fail(dataError());
          return req;
        }
        effective = decodeInlineKey(this.keyPath, value);
      } else {
        effective = key;
      }
      if (effective === undefined) {
        const err = new Error('DataError: no key could be derived.');
        err.name = 'DataError';
        req.fail(err);
        return req;
      }
      this.data.set(keyId(effective), structuredClone(value));
      req.succeed(effective);
      return req;
    }
    delete(key) {
      const req = new FakeRequest();
      this.data.delete(keyId(key));
      req.succeed(undefined);
      return req;
    }
    clear() {
      const req = new FakeRequest();
      this.data.clear();
      req.succeed(undefined);
      return req;
    }
  }

  class FakeTransaction {
    constructor(db, names) {
      this.db = db;
      this.names = names;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      queue(() => this.oncomplete?.({ target: this }));
    }
    objectStore(name) {
      if (!this.names.includes(name)) throw new Error(`Object store "${name}" is not in this transaction.`);
      return this.db._store(name);
    }
    abort() {
      queue(() => this.onabort?.({ target: this }));
    }
  }

  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.names = new Set();
      this.version = 0;
      this.onversionchange = null;
    }
    get objectStoreNames() {
      const names = this.names;
      return { contains: (name) => names.has(name) };
    }
    createObjectStore(name, { keyPath = null } = {}) {
      this.names.add(name);
      const store = new FakeObjectStore(name, keyPath);
      this.stores.set(name, store);
      return store;
    }
    _store(name) {
      const store = this.stores.get(name);
      if (!store) throw new Error(`Object store "${name}" does not exist.`);
      return store;
    }
    transaction(names, _mode) {
      return new FakeTransaction(this, Array.isArray(names) ? names : [names]);
    }
    close() {}
  }

  return {
    _dbs: new Map(),
    open(name, version) {
      const req = new FakeRequest();
      queue(() => {
        let db = this._dbs.get(name);
        const previousVersion = db ? db.version : 0;
        if (!db) {
          db = new FakeDB();
          this._dbs.set(name, db);
        }
        if (version > previousVersion) {
          db.version = version;
          req.result = db;
          req.onupgradeneeded?.({ target: req });
        }
        req.result = db;
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

const LEGACY_CHARACTER = {
  id: 'char_old',
  vocation: 'archer',
  level: 3,
  current_floor: 5,
  hp: 12,
  max_hp: 50,
  mana: 6,
  max_mana: 40,
  x: 2,
  y: 2,
  xp: 30,
  action_bar: [],
  backpack: [],
  paperdoll: {},
  skillBoosts: {},
  updatedAt: '2026-02-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('D3: legacy migration moves the v1 save into Slot 1 (E6 tower rules)', async (t) => {
  const originalIndexedDB = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  t.after(() => {
    closeStorage();
    globalThis.indexedDB = originalIndexedDB;
  });

  await openStorage();
  await put(STORES.CHARACTERS, { ...LEGACY_CHARACTER });
  await put(STORES.DUNGEON_FLOORS, { floor_number: 7, template_version: 2, tiles: [] });
  await put(STORES.DUNGEON_FLOORS, { floor_number: 8, template_version: 2, tiles: [] });

  await t.test('explicit key on the in-line slot_floors store is a DataError', async () => {
    await assert.rejects(
      put(STORES.SLOT_FLOORS, { floor_number: 91 }, [1, 91]),
      (err) => err && err.name === 'DataError',
      'put(value, [slotIndex, floor]) must reject on an in-line-key store'
    );
  });

  const result = await migrateLegacySave();
  assert.equal(result.migrated, true, 'legacy character should migrate');
  assert.equal(result.recovered, false);

  await t.test('the migrated character is clamped onto the 5-level tower', async () => {
    const character = await read(STORES.CHARACTERS, 'char_old');
    assert.ok(character, 'legacy character rewritten with slot assignment');
    assert.equal(character.slotIndex, 1);
    // E6: original current_floor was 5 (already in range); ensure it stays valid.
    assert.ok(character.current_floor >= 1 && character.current_floor <= 5);
  });

  await t.test('slot, guard, and legacy stores are all written/left intact', async () => {
    const slot = await read(STORES.SAVE_SLOTS, 'slot_1');
    assert.ok(slot, 'slot_1 metadata written');
    assert.equal(slot.characterId, 'char_old');
    assert.equal(slot.status, 'occupied');
    assert.ok(slot.currentFloor >= 1 && slot.currentFloor <= 5, 'slot metadata floor clamps to the tower');

    const guard = await read(STORES.GAME_SETTINGS, MIGRATION_GUARD_KEY);
    assert.ok(guard && guard.done, 'migration guard written');

    const legacyFloors = await getAll(STORES.DUNGEON_FLOORS);
    assert.equal(legacyFloors.length, 2, 'legacy dungeon_floors left untouched by the v1->v2 migration');
    const legacyCharacter = await read(STORES.CHARACTERS, 'char_old');
    assert.ok(legacyCharacter, 'legacy character left in place');
  });

  await t.test('a second run is a no-op (idempotent)', async () => {
    const rerun = await migrateLegacySave();
    assert.equal(rerun.migrated, false);
    const slot = await read(STORES.SAVE_SLOTS, 'slot_1');
    assert.equal(slot.characterId, 'char_old', 'slot metadata unchanged after rerun');
  });
});

test('E6: tower migration clamps old saves and drops stale floors', async (t) => {
  const originalIndexedDB = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  t.after(() => {
    closeStorage();
    globalThis.indexedDB = originalIndexedDB;
  });

  await openStorage();

  // A pre-tower save sitting on floor 17 with a floorEntry on floor 17, plus a
  // second slot on floor 9. Both must land on level 5 and keep their progress.
  await put(STORES.CHARACTERS, {
    id: 'char_tower_a', slotId: 'slot_1', slotIndex: 1, vocation: 'paladin',
    level: 6, current_floor: 17, xp: 120, hp: 77, max_hp: 100,
    floorEntry: { current_floor: 17, hp: 77, level: 6 },
    backpack: [{ item_id: 'torch', quantity: 2 }],
    updatedAt: '2026-03-01T00:00:00.000Z',
  });
  await put(STORES.SAVE_SLOTS, {
    id: 'slot_1', slotIndex: 1, status: 'occupied', characterId: 'char_tower_a',
    vocation: 'paladin', level: 6, currentFloor: 17,
    floorEntry: { current_floor: 17 },
  });
  await put(STORES.CHARACTERS, {
    id: 'char_tower_b', slotId: 'slot_2', slotIndex: 2, vocation: 'archer',
    level: 4, current_floor: 9,
    floorEntry: { current_floor: 9, hp: 40, level: 4 },
    updatedAt: '2026-03-02T00:00:00.000Z',
  });
  await put(STORES.SAVE_SLOTS, {
    id: 'slot_2', slotIndex: 2, status: 'occupied', characterId: 'char_tower_b',
    vocation: 'archer', level: 4, currentFloor: 9,
    floorEntry: { current_floor: 9 },
  });

  // Stale cached floors from the retired 20-floor layout.
  await put(STORES.DUNGEON_FLOORS, { floor_number: 1, template_version: 2, tiles: [] });
  await put(STORES.DUNGEON_FLOORS, { floor_number: 17, template_version: 2, tiles: [] });
  await put(STORES.DUNGEON_FLOORS, { floor_number: 20, template_version: 2, tiles: [] });
  await put(STORES.SLOT_FLOORS, { slotIndex: 1, floor_number: 17, template_version: 2, tiles: [] });
  await put(STORES.SLOT_FLOORS, { slotIndex: 2, floor_number: 9, template_version: 2, tiles: [] });

  const result = await migrateTowerSave();
  assert.equal(result.floorsReset, 5, 'every stale cached floor is dropped');
  assert.equal(result.recordsNormalized, 4, 'both characters and both slots normalized');

  await t.test('no stale cached floor template survives', async () => {
    assert.equal((await getAll(STORES.DUNGEON_FLOORS)).length, 0);
    assert.equal((await getAll(STORES.SLOT_FLOORS)).length, 0);
  });

  await t.test('characters land on a valid 1..5 floor with progress preserved', async () => {
    const a = await read(STORES.CHARACTERS, 'char_tower_a');
    assert.equal(a.current_floor, 5, 'floor 17 clamps to the final level');
    assert.equal(a.floorEntry.current_floor, 5, 'legacy floorEntry floor clamps too');
    assert.equal(a.level, 6, 'level progress preserved');
    assert.equal(a.xp, 120, 'xp preserved');
    assert.deepEqual(a.backpack, [{ item_id: 'torch', quantity: 2 }], 'inventory preserved');
    assert.equal(a.saveVersion, SAVE_FORMAT_VERSION, 'save format stamped');

    const b = await read(STORES.CHARACTERS, 'char_tower_b');
    assert.equal(b.current_floor, 5, 'floor 9 clamps to the final level');
    assert.equal(b.saveVersion, SAVE_FORMAT_VERSION);
  });

  await t.test('slot records clamp to the tower', async () => {
    const s1 = await read(STORES.SAVE_SLOTS, 'slot_1');
    assert.equal(s1.currentFloor, 5);
    assert.equal(s1.floorEntry.current_floor, 5);
    assert.equal(s1.saveVersion, SAVE_FORMAT_VERSION);
    const s2 = await read(STORES.SAVE_SLOTS, 'slot_2');
    assert.equal(s2.currentFloor, 5);
  });

  await t.test('a second run is an idempotent no-op', async () => {
    const rerun = await migrateTowerSave();
    assert.equal(rerun.floorsReset, 0);
    assert.equal(rerun.recordsNormalized, 0);
    const guard = await read(STORES.GAME_SETTINGS, TOWER_MIGRATION_GUARD_KEY);
    assert.ok(guard && guard.done, 'tower migration guard written');
  });

  await t.test('fresh in-range saves are untouched (no-op normalization)', async () => {
    await closeStorage();
    globalThis.indexedDB = createFakeIndexedDB();
    await openStorage();
    const fresh = { id: 'c', current_floor: 3, floorEntry: { current_floor: 3 } };
    await put(STORES.CHARACTERS, fresh);
    const before = await read(STORES.CHARACTERS, 'c');
    const res = await migrateTowerSave();
    assert.equal(res.floorsReset, 0);
    const after = await read(STORES.CHARACTERS, 'c');
    assert.equal(after.current_floor, before.current_floor);
  });
});

test('E7: pure tower clamp/migration helpers handle legacy edge cases', () => {
  assert.ok(Number.isInteger(TOWER_FLOOR_COUNT) && TOWER_FLOOR_COUNT === 5);

  assert.equal(clampTowerFloor(undefined), 1);
  assert.equal(clampTowerFloor(null), 1);
  assert.equal(clampTowerFloor('not-a-number'), 1);
  assert.equal(clampTowerFloor(NaN), 1);
  assert.equal(clampTowerFloor(-4), 1);
  assert.equal(clampTowerFloor(0), 1);
  assert.equal(clampTowerFloor(3.9), 3);
  assert.equal(clampTowerFloor(17), TOWER_FLOOR_COUNT);
  assert.equal(clampTowerFloor(99), TOWER_FLOOR_COUNT);

  assert.equal(migratePlayerToTower(null), null);

  const inRange = { current_floor: 3, floorEntry: { current_floor: 3 } };
  assert.equal(migratePlayerToTower(inRange), inRange, 'in-range save is a reference no-op');

  const legacy = { current_floor: 17, floorEntry: { current_floor: 17 }, level: 6, xp: 120 };
  const fixed = migratePlayerToTower(legacy);
  assert.notEqual(fixed, legacy, 'out-of-range save is copied');
  assert.equal(fixed.current_floor, TOWER_FLOOR_COUNT);
  assert.equal(fixed.floorEntry.current_floor, TOWER_FLOOR_COUNT);
  assert.equal(fixed.level, 6, 'progress preserved');
  assert.equal(fixed.xp, 120, 'progress preserved');
  assert.equal(legacy.current_floor, 17, 'input is not mutated');

  const weird = migratePlayerToTower({ current_floor: 'x', floorEntry: { current_floor: -9 } });
  assert.equal(weird.current_floor, 1);
  assert.equal(weird.floorEntry.current_floor, 1);

  assert.equal(normalizeSlotToTower(null), null);
  const slotInRange = { currentFloor: 2, floorEntry: { current_floor: 2 } };
  assert.equal(normalizeSlotToTower(slotInRange), slotInRange, 'in-range slot is a reference no-op');

  const slot = normalizeSlotToTower({ currentFloor: 12, floorEntry: { current_floor: 12 } });
  assert.equal(slot.currentFloor, TOWER_FLOOR_COUNT);
  assert.equal(slot.floorEntry.current_floor, TOWER_FLOOR_COUNT);
});

test('Load spawns at the level start; death descends a level and full-heals', async (t) => {
  const originalIndexedDB = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  t.after(() => {
    closeStorage();
    globalThis.indexedDB = originalIndexedDB;
  });

  const { COMMAND_HANDLERS } = await import('../worker/game-worker.js');
  await openStorage();

  // Create a real slot (level 1), then advance it to level 3 and move the player
  // to an arbitrary mid-room tile to prove load ignores the saved position.
  const created = await COMMAND_HANDLERS.createSlot({ slotIndex: 1, vocation: 'magician' });
  const slotIndex = 1;
  created.player.current_floor = 3;
  created.player.x = 7;
  created.player.y = 9;
  created.player.hp = 12;
  await put(STORES.CHARACTERS, created.player);
  // Keep the slot's floorEntry in sync with where it was saved.
  const slotRec = await read(STORES.SAVE_SLOTS, 'slot_1');
  slotRec.currentFloor = 3;
  await put(STORES.SAVE_SLOTS, slotRec);

  await t.test('loadSlot places the player at the level start position', async () => {
    const loaded = await COMMAND_HANDLERS.loadSlot({ slotIndex });
    assert.equal(loaded.player.current_floor, 3);
    const start = loaded.floor.spawn_coords;
    assert.deepEqual({ x: loaded.player.x, y: loaded.player.y }, { x: start.x, y: start.y },
      'continuing a save must start at the level start position, not the saved tile');
  });

  await t.test('respawnAfterDeath descends one level, spawns at start, and full-heals', async () => {
    const respawned = await COMMAND_HANDLERS.respawnAfterDeath({ slotIndex });
      assert.equal(respawned.player.current_floor, 2, 'descends from 3 to 2');
      assert.equal(respawned.player.hp, respawned.player.max_hp, 'full health on respawn');
    assert.equal(respawned.player.mana, respawned.player.max_mana, 'full mana on respawn');
    const start = respawned.floor.spawn_coords;
    assert.deepEqual({ x: respawned.player.x, y: respawned.player.y }, { x: start.x, y: start.y });
  });

  await t.test('respawnAfterDeath never descends below level 1', async () => {
    const slot = await read(STORES.CHARACTERS, (await read(STORES.SAVE_SLOTS, 'slot_1')).characterId);
    slot.current_floor = 1;
    await put(STORES.CHARACTERS, slot);
    const respawned = await COMMAND_HANDLERS.respawnAfterDeath({ slotIndex });
    assert.equal(respawned.player.current_floor, 1);
    assert.equal(respawned.player.hp, respawned.player.max_hp);
  });
});
