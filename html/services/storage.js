/**
 * Lokarta: Come Into The Light - Storage Manager
 * IndexedDB database manager for persistent offline gameplay.
 */

import {
  planLegacyMigration,
  emptySlotRecord,
  SAVE_SLOT_COUNT,
  SAVE_FORMAT_VERSION,
  saveFormatVersion,
  normalizeSlotToTower,
  normalizeSlotPartyProgress,
  migratePlayerToTower,
} from './save-slots.js';
import { migratePlayerParty } from '../engine/party.js';
import { LOKARTA_DATABASE_NAMES } from './build-version.js';

/** Single source of truth is the flush guard's database-name list. */
export const DB_NAME = LOKARTA_DATABASE_NAMES[0];
export const DB_VERSION = 2;

export const STORES = {
  PROFILE: 'profile',
  CHARACTERS: 'characters',
  DUNGEON_FLOORS: 'dungeon_floors',
  GAME_SETTINGS: 'game_settings',
  SAVE_SLOTS: 'save_slots',
  SLOT_FLOORS: 'slot_floors',
};

export const MIGRATION_GUARD_KEY = 'migration_slot_v2';

/**
 * One-time guard for the 20 -> 5 tower migration. When absent, every persisted
 * character/slot is clamped onto the 5-level tower and all cached floors are
 * dropped so the generator rebuilds them with the current template.
 */
export const TOWER_MIGRATION_GUARD_KEY = 'migration_tower_v3';

/**
 * One-time guard for the party migration (LIV-9). When absent, every persisted
 * character is moved onto the party data model: a legacy single-character save
 * is wrapped into a one-member party and `towerProgress` is initialized with
 * only the first tower unlocked. Non-destructive: progression, inventory, keys,
 * and spring charges are preserved and floor caches are left alone.
 */
export const PARTY_MIGRATION_GUARD_KEY = 'migration_party_v4';

let dbInstance = null;

/**
 * Returns the current ISO 8601 UTC timestamp string.
 * @returns {string}
 */
export function now() {
  return new Date().toISOString();
}

/**
 * Opens and initializes the IndexedDB database.
 * Creates the required object stores on initial setup or upgrade.
 * @returns {Promise<IDBDatabase>}
 */
export function openStorage() {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  const idb = globalThis.indexedDB;
  if (!idb) {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'));
  }

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 1. Profile store: player preferences (soundEnabled, volume, updatedAt, etc.)
      if (!db.objectStoreNames.contains(STORES.PROFILE)) {
        db.createObjectStore(STORES.PROFILE, { keyPath: 'id' });
      }

      // 2. Characters store: character entities and progression
      if (!db.objectStoreNames.contains(STORES.CHARACTERS)) {
        db.createObjectStore(STORES.CHARACTERS, { keyPath: 'id' });
      }

      // 3. Dungeon floors store: cached and generated floor states
      if (!db.objectStoreNames.contains(STORES.DUNGEON_FLOORS)) {
        db.createObjectStore(STORES.DUNGEON_FLOORS, { keyPath: 'floor_number' });
      }

      // 4. Game settings store: arbitrary key-value settings
      if (!db.objectStoreNames.contains(STORES.GAME_SETTINGS)) {
        db.createObjectStore(STORES.GAME_SETTINGS, { keyPath: 'key' });
      }

      // 5. Save slots store: five fixed slot metadata records (v2)
      if (!db.objectStoreNames.contains(STORES.SAVE_SLOTS)) {
        db.createObjectStore(STORES.SAVE_SLOTS, { keyPath: 'id' });
      }

      // 6. Slot floors store: per-slot cached floor states, keyed [slotIndex, floor_number] (v2)
      if (!db.objectStoreNames.contains(STORES.SLOT_FLOORS)) {
        db.createObjectStore(STORES.SLOT_FLOORS, { keyPath: ['slotIndex', 'floor_number'] });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;

      dbInstance.onversionchange = () => {
        dbInstance.close();
        dbInstance = null;
      };

      resolve(dbInstance);
    };

    request.onerror = (event) => {
      reject(event.target.error || new Error('Failed to open IndexedDB storage.'));
    };
  });
}

/**
 * Closes the cached database connection.
 */
export function closeStorage() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Executes a callback within an IndexedDB transaction.
 * Supports flexible signatures:
 *   transaction(db, mode, callback)
 *   transaction(storeNames, mode, callback)
 * 
 * @param {IDBDatabase|string|string[]} dbOrStores - Database instance or store name(s)
 * @param {IDBTransactionMode|Function} modeOrCallback - Transaction mode ('readonly'|'readwrite') or callback if db was passed
 * @param {Function} [callback] - Function receiving (storesMap, transaction) returning a promise or value
 * @returns {Promise<any>}
 */
export async function transaction(dbOrStores, modeOrCallback, callback) {
  let db;
  let storeNames;
  let mode;
  let cb;

  // Handle case where first param is an IDBDatabase
  if (dbOrStores && typeof dbOrStores.transaction === 'function') {
    db = dbOrStores;
    if (typeof modeOrCallback === 'function') {
      mode = 'readonly';
      cb = modeOrCallback;
      storeNames = Array.from(db.objectStoreNames);
    } else {
      mode = modeOrCallback || 'readonly';
      cb = callback;
      storeNames = Array.from(db.objectStoreNames);
    }
  } else {
    db = await openStorage();
    if (Array.isArray(dbOrStores)) {
      storeNames = dbOrStores;
    } else if (typeof dbOrStores === 'string') {
      storeNames = [dbOrStores];
    } else {
      storeNames = Object.values(STORES);
    }

    if (typeof modeOrCallback === 'function') {
      mode = 'readonly';
      cb = modeOrCallback;
    } else {
      mode = modeOrCallback || 'readonly';
      cb = callback;
    }
  }

  if (typeof cb !== 'function') {
    throw new TypeError('Transaction callback must be a function');
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const storeMap = {};
    for (const name of storeNames) {
      storeMap[name] = tx.objectStore(name);
    }

    let result;
    try {
      result = cb(storeNames.length === 1 ? storeMap[storeNames[0]] : storeMap, tx);
    } catch (err) {
      tx.abort();
      return reject(err);
    }

    tx.oncomplete = () => {
      resolve(result);
    };

    tx.onerror = (event) => {
      reject(event.target.error || new Error('Transaction failed'));
    };

    tx.onabort = (event) => {
      reject(event.target.error || new Error('Transaction was aborted'));
    };
  });
}

/**
 * Reads a single record by its key from the specified object store.
 * @param {string} storeName - Store name
 * @param {IDBValidKey} key - Key value
 * @returns {Promise<any>}
 */
export async function read(storeName, key) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => {
      resolve(request.result !== undefined ? request.result : null);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * Stores or updates a record in the specified object store.
 * @param {string} storeName - Store name
 * @param {any} value - Value object to store
 * @param {IDBValidKey} [key] - Optional key (if store has no inline keyPath)
 * @returns {Promise<IDBValidKey>}
 */
export async function put(storeName, value, key) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = key !== undefined ? store.put(value, key) : store.put(value);

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * Retrieves all records from the specified object store.
 * @param {string} storeName - Store name
 * @returns {Promise<any[]>}
 */
export async function getAll(storeName) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => {
      resolve(request.result || []);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * Deletes a record by key from the specified object store.
 * @param {string} storeName - Store name
 * @param {IDBValidKey} key - Key value
 * @returns {Promise<void>}
 */
export async function deleteRecord(storeName, key) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * Clears all records from the specified object store.
 * @param {string} storeName - Store name
 * @returns {Promise<void>}
 */
export async function clearStore(storeName) {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * Reads the current save-slot metadata records, normalized to exactly
 * `SAVE_SLOT_COUNT` entries ordered by slotIndex (empty slots filled in).
 * @returns {Promise<object[]>}
 */
export async function readSlots() {
  const records = await getAll(STORES.SAVE_SLOTS);
  const byIndex = new Map();
  for (const record of records || []) {
    if (record && typeof record.slotIndex === 'number' && record.slotIndex >= 1) {
      // Clamp any pre-tower save onto the 5-level tower so it renders and loads
      // without the caller having to special-case a floor beyond the max, and
      // fill campaign progress for records written before the party model.
      byIndex.set(record.slotIndex, normalizeSlotPartyProgress(normalizeSlotToTower(record)));
    }
  }
  const slots = [];
  for (let i = 1; i <= SAVE_SLOT_COUNT; i += 1) {
    slots.push(byIndex.get(i) || emptySlotRecord(i));
  }
  return slots;
}

/**
 * Non-destructively migrates the v1 single save into Slot 1 and stamps the
 * one-time `migration_slot_v2` guard. Legacy stores are always left intact.
 *
 * Idempotent: rerunning after the guard exists is a no-op; if the guard is
 * missing but `save_slots/slot_1` already exists, only the guard is written.
 *
 * @returns {Promise<{ migrated: boolean, recovered: boolean, fromCharacterId: string|null }>}
 */
export async function migrateLegacySave() {
  await openStorage();

  const guard = await read(STORES.GAME_SETTINGS, MIGRATION_GUARD_KEY);
  if (guard && guard.done) {
    return { migrated: false, recovered: false, fromCharacterId: guard.fromCharacterId || null };
  }

  // Idempotent recovery: a prior run may have written Slot 1 but not the guard.
  const existingSlot = await read(STORES.SAVE_SLOTS, 'slot_1');
  if (existingSlot) {
    await put(STORES.GAME_SETTINGS, {
      key: MIGRATION_GUARD_KEY,
      done: true,
      migratedAt: now(),
      fromCharacterId: existingSlot.characterId || null,
    });
    return { migrated: false, recovered: true, fromCharacterId: existingSlot.characterId || null };
  }

  const legacyCharacters = await getAll(STORES.CHARACTERS);
  const legacyFloors = await getAll(STORES.DUNGEON_FLOORS);
  const plan = planLegacyMigration(legacyCharacters, legacyFloors, guard);

  if (plan.character) {
    await put(STORES.CHARACTERS, plan.character);
  }
  if (plan.slot) {
    await put(STORES.SAVE_SLOTS, plan.slot);
  }
  for (const entry of plan.floors) {
    // `slot_floors` uses an in-line composite keyPath ['slotIndex','floor_number'].
    // Stamp the slot index onto the value and put without an explicit key, or
    // IndexedDB rejects the write with a DataError and the migration aborts.
    await put(STORES.SLOT_FLOORS, { ...entry.floor, slotIndex: entry.key[0] });
  }
  if (plan.guard) {
    await put(STORES.GAME_SETTINGS, { ...plan.guard, migratedAt: now() });
  }

  return {
    migrated: Boolean(plan.character),
    recovered: false,
    fromCharacterId: plan.guard ? plan.guard.fromCharacterId : null,
  };
}

/**
 * One-time migration from the retired 20-floor cave layout onto the 5-level
 * tower. Makes old saves loadable without error:
 *
 * - Drops every cached floor (`dungeon_floors` + `slot_floors`). Pre-tower
 *   caches are both structurally stale (old template) and can carry floor
 *   numbers above 5, so they must never be served. The generator rebuilds a
 *   valid floor on the next load.
 * - Clamps every persisted character and slot record to `1..5`, keeping
 *   progression (level, xp, inventory) and stamping the v2 save format.
 *
 * Idempotent via `TOWER_MIGRATION_GUARD_KEY`: reruns are no-ops. If an older
 * run dropped the caches but did not finish stamping records, recovery
 * re-normalizes records so no save is left pointing past level 5.
 *
 * @returns {Promise<{ floorsReset: number, recordsNormalized: number, recovered: boolean }>}
 */
export async function migrateTowerSave() {
  await openStorage();

  const guard = await read(STORES.GAME_SETTINGS, TOWER_MIGRATION_GUARD_KEY);
  if (guard && guard.done) {
    return { floorsReset: 0, recordsNormalized: 0, recovered: false };
  }

  let floorsReset = 0;
  const legacyFloors = await getAll(STORES.DUNGEON_FLOORS);
  if (legacyFloors.length > 0) {
    await clearStore(STORES.DUNGEON_FLOORS);
    floorsReset += legacyFloors.length;
  }
  const slotFloors = await getAll(STORES.SLOT_FLOORS);
  if (slotFloors.length > 0) {
    await clearStore(STORES.SLOT_FLOORS);
    floorsReset += slotFloors.length;
  }

  let recordsNormalized = 0;
  const characters = await getAll(STORES.CHARACTERS);
  for (const character of characters || []) {
    const migrated = migratePlayerToTower(character);
    const needsStamp = saveFormatVersion(character) !== SAVE_FORMAT_VERSION;
    if (migrated !== character || needsStamp) {
      await put(STORES.CHARACTERS, { ...migrated, saveVersion: SAVE_FORMAT_VERSION });
      recordsNormalized += 1;
    }
  }

  const slots = await getAll(STORES.SAVE_SLOTS);
  for (const slot of slots || []) {
    const normalized = normalizeSlotToTower(slot);
    const needsStamp = saveFormatVersion(slot) !== SAVE_FORMAT_VERSION;
    if (normalized !== slot || needsStamp) {
      await put(STORES.SAVE_SLOTS, { ...normalized, saveVersion: SAVE_FORMAT_VERSION });
      recordsNormalized += 1;
    }
  }

  await put(STORES.GAME_SETTINGS, {
    key: TOWER_MIGRATION_GUARD_KEY,
    done: true,
    doneAt: now(),
    floorsReset,
  });

  return { floorsReset, recordsNormalized, recovered: floorsReset > 0 };
}

/**
 * One-time migration onto the party data model (LIV-9 WS1). Wraps every legacy
 * single-character save into a one-member party, initializes `towerProgress`
 * with only the first tower unlocked, and fills party progress onto slot
 * metadata. Non-destructive: progression, inventory, level keys, and spring
 * charges are preserved and no floor cache is dropped.
 *
 * Idempotent via `PARTY_MIGRATION_GUARD_KEY`: reruns are no-ops. If an older run
 * wrote party records but not the guard, records are already normalized so the
 * migration re-runs as a no-op and only stamps the guard.
 *
 * @returns {Promise<{ recordsMigrated: number, recovered: boolean }>}
 */
export async function migratePartySave() {
  await openStorage();

  const guard = await read(STORES.GAME_SETTINGS, PARTY_MIGRATION_GUARD_KEY);
  if (guard && guard.done) {
    return { recordsMigrated: 0, recovered: false };
  }

  let recordsMigrated = 0;
  const progressByCharacterId = new Map();
  const characters = await getAll(STORES.CHARACTERS);
  for (const character of characters || []) {
    const migrated = migratePlayerParty(character);
    if (migrated !== character) {
      await put(STORES.CHARACTERS, migrated);
      recordsMigrated += 1;
    }
    if (migrated && migrated.id) {
      progressByCharacterId.set(migrated.id, migrated.towerProgress);
    }
  }

  const slots = await getAll(STORES.SAVE_SLOTS);
  for (const slot of slots || []) {
    if (!slot || typeof slot !== 'object') continue;
    let next = normalizeSlotPartyProgress(slot);
    const characterProgress = slot.characterId ? progressByCharacterId.get(slot.characterId) : null;
    if (characterProgress && next.towerProgress !== characterProgress) {
      next = { ...next, towerProgress: characterProgress };
    }
    if (next !== slot) {
      await put(STORES.SAVE_SLOTS, next);
      recordsMigrated += 1;
    }
  }

  await put(STORES.GAME_SETTINGS, {
    key: PARTY_MIGRATION_GUARD_KEY,
    done: true,
    doneAt: now(),
    recordsMigrated,
  });

  return { recordsMigrated, recovered: false };
}
