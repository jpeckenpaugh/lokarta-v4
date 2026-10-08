/**
 * LIV-9 WS1 — Party data model, save migration & towerProgress
 *
 * Covers the critical-path contract every other Dev Sprint 001 workstream
 * builds on:
 *   - the catalog schema for campaign order/unlocks, party_ai, ally healing,
 *     and campaign copy;
 *   - the pure party model (members, active member, capture/apply swap);
 *   - towerProgress derivation and completion;
 *   - worker persistence round-trips and the idempotent, non-destructive
 *     legacy-save migration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOCATIONS_CATALOG,
  ABILITIES_CATALOG,
  UI_CATALOG,
  PARTY_AI_CATALOG,
  TOWER_LEVELS_CATALOG,
  listTowerDefinitions,
  listTowerDefinitionsByOrder,
  getTowerDefinition,
  firstTowerId,
  towerOrder,
  towerUnlockRequires,
  towersUnlockedBy,
  nextTowerIdAfter,
  isTowerId,
} from '../data/index.js';

import {
  PARTY_FACTION,
  MAX_PARTY_SIZE,
  makeMemberId,
  createPartyMember,
  createPartyPlayer,
  migratePlayerParty,
  captureActiveMember,
  applyActiveMember,
  setActiveMember,
  getActiveMember,
  activeMemberIndex,
  partyVocationIds,
  createTowerProgress,
  normalizeTowerProgress,
  isTowerUnlocked,
  allTowersCompleted,
  completeTower,
} from '../engine/party.js';

import {
  deriveSlotMeta,
  normalizeSlotPartyProgress,
} from '../services/save-slots.js';

import {
  STORES,
  openStorage,
  closeStorage,
  put,
  read,
  getAll,
  migratePartySave,
  PARTY_MIGRATION_GUARD_KEY,
} from '../services/storage.js';

import { COMMAND_HANDLERS } from '../worker/game-worker.js';

/** Minimal in-memory IndexedDB shim (same contract as the storage suite). */
function createFakeIndexedDB() {
  const queue = (fn) => queueMicrotask(fn);
  const keyId = (key) => JSON.stringify(key);
  const decodeInlineKey = (keyPath, value) =>
    (Array.isArray(keyPath) ? keyPath.map((k) => value[k]) : value[keyPath]);
  const makeRequest = () => ({ onsuccess: null, onerror: null, result: undefined, error: null });
  const succeed = (req, result) => queue(() => { req.result = result; req.onsuccess?.({ target: req }); });
  const fail = (req, error) => queue(() => { req.error = error; req.onerror?.({ target: req }); });

  class Store {
    constructor(name, keyPath) { this.name = name; this.keyPath = keyPath ?? null; this.data = new Map(); }
    get(key) { const r = makeRequest(); succeed(r, this.data.has(keyId(key)) ? structuredClone(this.data.get(keyId(key))) : undefined); return r; }
    getAll() { const r = makeRequest(); succeed(r, [...this.data.values()].map((v) => structuredClone(v))); return r; }
    put(value, key) {
      const r = makeRequest();
      let effective;
      if (this.keyPath !== null) {
        if (key !== undefined) { const e = new Error('in-line keys'); e.name = 'DataError'; fail(r, e); return r; }
        effective = decodeInlineKey(this.keyPath, value);
      } else {
        effective = key;
      }
      if (effective === undefined) { const e = new Error('no key'); e.name = 'DataError'; fail(r, e); return r; }
      this.data.set(keyId(effective), structuredClone(value));
      succeed(r, effective);
      return r;
    }
    delete(key) { const r = makeRequest(); this.data.delete(keyId(key)); succeed(r, undefined); return r; }
    clear() { const r = makeRequest(); this.data.clear(); succeed(r, undefined); return r; }
  }
  class Tx {
    constructor(db, names) { this.db = db; this.names = names; this.oncomplete = null; this.onerror = null; this.onabort = null; queue(() => this.oncomplete?.({ target: this })); }
    objectStore(name) { if (!this.names.includes(name)) throw new Error(`store ${name} not in tx`); return this.db._store(name); }
    abort() { queue(() => this.onabort?.({ target: this })); }
  }
  class DB {
    constructor() { this.stores = new Map(); this.names = new Set(); this.version = 0; this.onversionchange = null; }
    get objectStoreNames() { const n = this.names; return { contains: (x) => n.has(x) }; }
    createObjectStore(name, { keyPath = null } = {}) { this.names.add(name); const s = new Store(name, keyPath); this.stores.set(name, s); return s; }
    _store(name) { const s = this.stores.get(name); if (!s) throw new Error(`missing store ${name}`); return s; }
    transaction(names) { return new Tx(this, Array.isArray(names) ? names : [names]); }
    close() {}
  }
  return {
    _dbs: new Map(),
    open(name, version) {
      const r = makeRequest();
      queue(() => {
        let db = this._dbs.get(name);
        const prev = db ? db.version : 0;
        if (!db) { db = new DB(); this._dbs.set(name, db); }
        if (version > prev) { db.version = version; r.result = db; r.onupgradeneeded?.({ target: r }); }
        r.result = db;
        r.onsuccess?.({ target: r });
      });
      return r;
    },
  };
}

const LEGACY_PLAYER = {
  id: 'char_legacy',
  vocation: 'archer',
  level: 4,
  xp: 210,
  current_floor: 3,
  towerId: 'spire_of_light',
  hp: 41,
  max_hp: 90,
  mana: 12,
  max_mana: 80,
  x: 6,
  y: 7,
  gold: 512,
  levelKeys: { 1: { copper: true }, 2: { silver: true } },
  springCharges: { 1: 1700000000000 },
  backpack: [{ item_id: 'torch', quantity: 2 }],
  paperdoll: { main_hand: 'composite_bow' },
  action_bar: ['health_potion', null, null, null],
  skillBoosts: { damageMultiplier: 1.1, bonusRange: 0, bonusRegen: 0 },
  updatedAt: '2026-04-01T00:00:00.000Z',
  createdAt: '2026-03-01T00:00:00.000Z',
};

test('LIV-9 catalog schema: tower campaign order & unlock requirements', () => {
  const ordered = listTowerDefinitionsByOrder();
  assert.deepEqual(ordered.map((t) => t.id).length, listTowerDefinitions().length);

  const orders = ordered.map((t) => towerOrder(t.id));
  assert.deepEqual(orders, orders.slice().sort((a, b) => a - b), 'order is monotonic');
  assert.equal(new Set(orders).size, orders.length, 'order is unique');

  assert.equal(firstTowerId(), ordered[0].id);
  assert.deepEqual(towerUnlockRequires(ordered[0].id), [], 'first tower requires nothing');
  for (let i = 1; i < ordered.length; i += 1) {
    assert.deepEqual(towerUnlockRequires(ordered[i].id), [ordered[i - 1].id], `${ordered[i].id} requires the previous tower`);
  }
  assert.deepEqual(towersUnlockedBy(ordered[0].id), [ordered[1].id]);
  assert.equal(nextTowerIdAfter(ordered[0].id), ordered[1].id);
  assert.equal(nextTowerIdAfter(ordered[ordered.length - 1].id), null);
  assert.equal(isTowerId(ordered[0].id), true);
  assert.equal(isTowerId('not_a_tower'), false);

  // Every authored tower carries the schema fields.
  for (const tower of listTowerDefinitions()) {
    assert.ok(Number.isInteger(tower.order) && tower.order >= 1, `${tower.id} order`);
    assert.ok(Array.isArray(tower.unlockRequires), `${tower.id} unlockRequires`);
  }
  assert.equal(TOWER_LEVELS_CATALOG.defaultTowerId, ordered[0].id);
  assert.ok(getTowerDefinition(firstTowerId()));
});

test('LIV-9 catalog schema: party_ai, ally healing, and campaign copy', () => {
  assert.ok(PARTY_AI_CATALOG.default, 'party_ai needs a default profile');
  const profileFields = ['preferredAbilities', 'followDistance', 'engageRadius', 'retreatHpPct', 'castRange', 'retargetSec'];
  for (const field of profileFields) {
    assert.ok(field in PARTY_AI_CATALOG.default, `default profile needs ${field}`);
  }
  for (const vocation of Object.keys(VOCATIONS_CATALOG)) {
    const profile = PARTY_AI_CATALOG.profiles[vocation];
    assert.ok(profile, `party_ai needs a ${vocation} profile`);
    for (const field of profileFields) {
      assert.ok(field in profile, `${vocation} profile needs ${field}`);
    }
    for (const abilityId of profile.preferredAbilities) {
      assert.ok(ABILITIES_CATALOG[abilityId], `${vocation} references unknown ability ${abilityId}`);
    }
  }

  assert.equal(ABILITIES_CATALOG.paladin_heal.targetsAllies, true);
  assert.ok(Number(ABILITIES_CATALOG.paladin_heal.healRadius) > 0);

  const campaign = UI_CATALOG.campaign;
  assert.ok(campaign, 'ui.json needs a campaign block');
  for (const key of ['towerCompleteTitle', 'recruitTitle', 'recruitPrompt', 'ultimateVictoryTitle', 'towerLockedLabel', 'towerLockedHint']) {
    assert.equal(typeof campaign[key], 'string', `campaign.${key} must be a string`);
    assert.ok(campaign[key].length > 0, `campaign.${key} must not be empty`);
  }
});

test('LIV-9 party model: members are catalog-shaped and one per vocation', () => {
  assert.equal(MAX_PARTY_SIZE, Object.keys(VOCATIONS_CATALOG).length);
  const base = VOCATIONS_CATALOG.magician;
  const member = createPartyMember('magician');
  assert.equal(member.memberId, makeMemberId('magician'));
  assert.equal(member.id, makeMemberId('magician'));
  assert.equal(member.vocation, 'magician');
  assert.equal(member.aiMode, 'auto');
  assert.equal(member.faction, PARTY_FACTION);
  assert.equal(member.max_hp, base.max_hp);
  assert.equal(member.max_mana, base.max_mana);

  const overridden = createPartyMember('fighter', { hp: 7, aiMode: 'manual' });
  assert.equal(overridden.vocation, 'fighter');
  assert.equal(overridden.hp, 7);
  assert.equal(overridden.aiMode, 'manual');
  assert.equal(overridden.faction, PARTY_FACTION);

  const player = createPartyPlayer('paladin');
  assert.equal(player.party.length, 1);
  assert.equal(player.activeMemberId, makeMemberId('paladin'));
  // LIV-55 D7: a new save starts with nothing unlocked (the Spire is gated).
  assert.deepEqual(player.towerProgress.unlockedTowerIds, []);
  assert.equal(isTowerUnlocked(player.towerProgress, firstTowerId()), false);
  assert.deepEqual(partyVocationIds(player), ['paladin']);
});

test('LIV-9 migration: legacy single-character save wraps without data loss', () => {
  assert.equal(migratePlayerParty(null), null);
  assert.equal(migratePlayerParty(undefined), undefined);

  const legacy = structuredClone(LEGACY_PLAYER);
  const migrated = migratePlayerParty(legacy);
  assert.notEqual(migrated, legacy, 'legacy save is copied');
  assert.equal(migrated.vocation, 'archer', 'top-level vocation preserved');
  assert.equal(migrated.party.length, 1);
  assert.equal(migrated.activeMemberId, makeMemberId('archer'));
  // The party wrap only normalizes progress; the legacy Spire-unlock backfill is
  // a separate world migration (`migrateWorldSave`, LIV-55 D8).
  assert.deepEqual(migrated.towerProgress, { completedTowerIds: [], unlockedTowerIds: [] });

  const member = migrated.party[0];
  assert.equal(member.faction, PARTY_FACTION);
  assert.equal(member.level, 4, 'level preserved');
  assert.equal(member.xp, 210, 'xp preserved');
  assert.equal(member.hp, 41, 'hp preserved');
  assert.equal(member.gold, 512, 'gold preserved');
  // LIV-33 changed the key contract: keys are a shared party store on the top
  // level and members never carry their own key ring.
  assert.deepEqual(migrated.levelKeys, LEGACY_PLAYER.levelKeys, 'level keys preserved on the shared party store');
  assert.equal(member.levelKeys, undefined, 'a member carries no key ring of its own');
  assert.deepEqual(member.springCharges, LEGACY_PLAYER.springCharges, 'spring charges preserved');
  assert.deepEqual(member.paperdoll, LEGACY_PLAYER.paperdoll, 'paperdoll preserved');
  // LIV-22 changed the backpack contract: the party shares one top-level
  // backpack and members never carry their own copies. The hotbar stays per
  // member. The shared grid is normalized to the catalog size on migration.
  assert.equal(member.backpack, undefined, 'no per-member backpack (shared party backpack)');
  assert.deepEqual(member.action_bar, LEGACY_PLAYER.action_bar, 'per-member action bar preserved');
  assert.equal(migrated.backpack.length, 36, 'shared backpack normalized to the catalog size');
  assert.deepEqual(migrated.backpack[0], LEGACY_PLAYER.backpack[0], 'shared backpack contents preserved on the top level');
  assert.equal(legacy.party, undefined, 'input is not mutated');

  assert.equal(migratePlayerParty(migrated), migrated, 'migration is idempotent (reference no-op)');
});

test('LIV-9 migration: already-party saves are normalized and repaired', () => {
  const player = createPartyPlayer('magician');
  player.party.push(createPartyMember('fighter'));
  player.activeMemberId = 'missing_member';
  const repaired = migratePlayerParty(player);
  assert.equal(repaired.party.length, 2);
  assert.ok(repaired.party.some((m) => m.memberId === repaired.activeMemberId));

  const malformed = {
    ...createPartyPlayer('archer'),
    party: [{ vocation: 'unknown_class' }, createPartyMember('paladin')],
    activeMemberId: null,
    towerProgress: undefined,
  };
  const cleaned = migratePlayerParty(malformed);
  assert.equal(cleaned.party.length, 1, 'malformed members are dropped');
  assert.equal(cleaned.party[0].vocation, 'paladin');
  assert.equal(cleaned.activeMemberId, makeMemberId('paladin'));
  assert.deepEqual(cleaned.towerProgress.unlockedTowerIds, []);
});

test('LIV-9 party model: capture/apply keeps the active member in sync', () => {
  const player = createPartyPlayer('magician');
  player.hp = 12;
  player.xp = 99;
  player.x = 8;
  player.y = 9;
  const member = captureActiveMember(player);
  assert.equal(member.hp, 12);
  assert.equal(member.xp, 99);
  assert.equal(member.x, 8);
  assert.equal(member.y, 9);

  player.party.push(createPartyMember('fighter'));
  assert.equal(activeMemberIndex(player), 0);
  setActiveMember(player, makeMemberId('fighter'));
  assert.equal(player.activeMemberId, makeMemberId('fighter'));
  assert.equal(player.vocation, 'fighter', 'top-level mirrors the new active member');
  assert.equal(player.hp, VOCATIONS_CATALOG.fighter.hp);
  assert.equal(player.party[0].hp, 12, 'the outgoing member is captured first');

  // applyActiveMember is the inverse of capture.
  const snapshot = { ...player, party: undefined };
  applyActiveMember(snapshot, player.party[0]);
  assert.equal(snapshot.vocation, 'magician');
  assert.equal(snapshot.hp, 12);
  assert.equal(getActiveMember({ party: [] }), null);
  assert.equal(activeMemberIndex({ party: [] }), -1);
});

test('LIV-9 towerProgress: new saves start locked; unlocks follow completion', () => {
  const ordered = listTowerDefinitionsByOrder();
  const progress = createTowerProgress();
  // LIV-55 D7: the Spire is quest-gated, so a fresh save has nothing unlocked.
  assert.deepEqual(progress.unlockedTowerIds, []);
  assert.equal(normalizeTowerProgress(progress), progress, 'clean progress is a reference no-op');
  assert.equal(isTowerUnlocked(progress, firstTowerId()), false);
  assert.equal(isTowerUnlocked(progress, ordered[1].id), false);
  assert.equal(allTowersCompleted(progress), false);

  const afterFirst = completeTower(progress, ordered[0].id);
  assert.deepEqual(afterFirst.completedTowerIds, [ordered[0].id]);
  assert.equal(isTowerUnlocked(afterFirst, ordered[1].id), true, 'the next tower unlocks');
  assert.equal(isTowerUnlocked(afterFirst, ordered[2].id), false, 'two ahead stays locked');
  assert.equal(allTowersCompleted(afterFirst), false);

  const duplicate = completeTower(afterFirst, ordered[0].id);
  assert.deepEqual(duplicate.completedTowerIds, [ordered[0].id], 'completion is idempotent');

  let complete = progress;
  for (const tower of ordered) complete = completeTower(complete, tower.id);
  assert.equal(allTowersCompleted(complete), true);
  for (const tower of ordered) assert.equal(isTowerUnlocked(complete, tower.id), true);

  const dirty = normalizeTowerProgress({ completedTowerIds: ['not_a_tower', ordered[0].id], unlockedTowerIds: [] });
  assert.deepEqual(dirty.completedTowerIds, [ordered[0].id]);
  assert.equal(isTowerUnlocked(dirty, ordered[1].id), true);
});

test('LIV-9 persistence: createSlot/saveCharacter/loadSlot round-trip the party', async (t) => {
  const originalIndexedDB = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  t.after(() => {
    closeStorage();
    globalThis.indexedDB = originalIndexedDB;
  });

  await openStorage();
  const created = await COMMAND_HANDLERS.createSlot({ slotIndex: 1, vocation: 'magician' });
  assert.equal(created.player.party.length, 1);
  assert.equal(created.player.party[0].faction, PARTY_FACTION);
  assert.deepEqual(created.player.towerProgress.unlockedTowerIds, []);
  assert.equal(created.player.party[0].x, created.player.x, 'member mirrors the spawn tile');

  created.player.hp = 17;
  created.player.xp = 321;
  created.player.party.push(createPartyMember('archer'));
  await COMMAND_HANDLERS.saveCharacter({ player: created.player });

  const stored = await read(STORES.CHARACTERS, 'char_slot_1');
  assert.equal(stored.party.length, 2, 'the whole party persists');
  assert.equal(stored.party[0].hp, 17, 'capture mirrors the live active member');
  assert.equal(stored.party[0].xp, 321);
  assert.deepEqual(stored.towerProgress.unlockedTowerIds, []);

  const loaded = await COMMAND_HANDLERS.loadSlot({ slotIndex: 1 });
  assert.equal(loaded.player.party.length, 2);
  assert.equal(loaded.player.activeMemberId, makeMemberId('magician'));
  assert.deepEqual(loaded.player.towerProgress.unlockedTowerIds, []);

  const meta = deriveSlotMeta(loaded.player, 1, loaded.floor.biome_name);
  assert.deepEqual(meta.towerProgress.unlockedTowerIds, []);
});

test('LIV-9 migration: migratePartySave wraps legacy saves and is idempotent', async (t) => {
  const originalIndexedDB = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  t.after(() => {
    closeStorage();
    globalThis.indexedDB = originalIndexedDB;
  });

  await openStorage();
  await put(STORES.CHARACTERS, structuredClone(LEGACY_PLAYER));
  await put(STORES.SAVE_SLOTS, {
    id: 'slot_1', slotIndex: 1, status: 'occupied', characterId: 'char_legacy',
    vocation: 'archer', level: 4, currentFloor: 3,
    floorEntry: { current_floor: 3 },
  });

  const result = await migratePartySave();
  assert.equal(result.recordsMigrated, 2, 'character + slot migrated');

  const character = await read(STORES.CHARACTERS, 'char_legacy');
  assert.equal(character.party.length, 1);
  assert.equal(character.activeMemberId, makeMemberId('archer'));
  assert.deepEqual(character.towerProgress, { completedTowerIds: [], unlockedTowerIds: [] });
  assert.deepEqual(character.levelKeys, LEGACY_PLAYER.levelKeys, 'keys survive migration on the shared party store');
  assert.equal(character.party[0].levelKeys, undefined, 'members carry no key ring of their own');
  assert.deepEqual(character.party[0].springCharges, LEGACY_PLAYER.springCharges, 'spring charges survive migration');

  const slot = await read(STORES.SAVE_SLOTS, 'slot_1');
  assert.deepEqual(slot.towerProgress, character.towerProgress);

  const guard = await read(STORES.GAME_SETTINGS, PARTY_MIGRATION_GUARD_KEY);
  assert.ok(guard && guard.done);

  const rerun = await migratePartySave();
  assert.equal(rerun.recordsMigrated, 0, 'rerun is an idempotent no-op');
});

test('LIV-9 migration: legacy slot records gain towerProgress lazily', () => {
  const legacySlot = {
    id: 'slot_2', slotIndex: 2, status: 'occupied', characterId: 'char_x',
    vocation: 'fighter', level: 2, currentFloor: 1,
    floorEntry: { current_floor: 1 },
  };
  const normalized = normalizeSlotPartyProgress(legacySlot);
  assert.notEqual(normalized, legacySlot);
  assert.deepEqual(normalized.towerProgress.unlockedTowerIds, []);
  assert.equal(normalizeSlotPartyProgress(normalized), normalized, 'already-normalized slot is a reference no-op');

  const empty = { id: 'slot_3', slotIndex: 3, status: 'empty' };
  assert.equal(normalizeSlotPartyProgress(empty), empty);
});
