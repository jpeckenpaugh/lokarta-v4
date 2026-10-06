/**
 * LIV-10 WS2 — Tower unlock + non-terminal completion + recruit flow
 *
 * Covers the campaign loop layered on the LIV-9 party model:
 *   - pure recruit helpers (recruitable vocations, level alignment, gating);
 *   - `completePlayerTower` recording + sequential unlock + ultimate victory;
 *   - picker lock state via `towerUnlockInfo`;
 *   - worker persistence round-trips for `completeTower` and `recruitMember`,
 *     including non-destructive progression (keys/springs survive).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOCATIONS_CATALOG,
  firstTowerId,
  listTowerDefinitionsByOrder,
  nextTowerIdAfter,
  isTowerId,
} from '../data/index.js';

import {
  makeMemberId,
  createPartyPlayer,
  createPartyMember,
  partyVocationIds,
  getActiveMember,
  allTowersCompleted,
  isTowerUnlocked,
  normalizeTowerProgress,
} from '../engine/party.js';

import {
  partyLevel,
  recruitableVocations,
  canRecruit,
  alignMemberToLevel,
  recruitMember,
  completePlayerTower,
  towerUnlockInfo,
} from '../engine/campaign.js';

import {
  STORES,
  openStorage,
  closeStorage,
  read,
  put,
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

function withFakeIndexedDB(t, fn) {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  return (async () => {
    try {
      await openStorage();
      await fn();
    } finally {
      closeStorage();
      globalThis.indexedDB = original;
    }
  })();
}

test('LIV-10 recruit helpers: missing vocations, gating, and level alignment', () => {
  const ordered = listTowerDefinitionsByOrder();
  const player = createPartyPlayer('magician');
  assert.equal(partyLevel(player), 1);
  assert.deepEqual(recruitableVocations(player), ['archer', 'fighter', 'paladin'].filter((v) => VOCATIONS_CATALOG[v]));
  assert.equal(canRecruit(player), true);

  // Level alignment from catalog base + per-level growth.
  const fighter = alignMemberToLevel(createPartyMember('fighter'), 5);
  const voc = VOCATIONS_CATALOG.fighter;
  assert.equal(fighter.level, 5);
  assert.equal(fighter.max_hp, voc.hp + 4 * voc.hpPerLevel);
  assert.equal(fighter.max_mana, voc.mana + 4 * voc.manaPerLevel);
  assert.equal(fighter.hp, fighter.max_hp, 'recruit arrives at full HP');
  assert.equal(fighter.mana, fighter.max_mana);
  assert.ok(fighter.skillBoosts.damageMultiplier > 1);

  // Party already has a magician; recruiting one again is rejected.
  assert.equal(recruitMember(player, 'magician'), null);
  assert.equal(recruitMember(player, 'not_a_class'), null);

  // Recruits start at level 1 regardless of the existing party level (LIV-16)
  // and become active, so they can take the first Fate Grant.
  player.party.push(alignMemberToLevel(createPartyMember('fighter'), 8));
  const archer = recruitMember(player, 'archer');
  assert.ok(archer);
  assert.equal(archer.level, 1, 'new recruit starts at level 1');
  assert.equal(player.activeMemberId, makeMemberId('archer'));
  assert.equal(player.vocation, 'archer', 'top level mirrors the new active member');
  assert.deepEqual(partyVocationIds(player), ['magician', 'fighter', 'archer']);
  assert.equal(getActiveMember(player), archer);

  // Fill to the cap, then recruiting is gated off.
  recruitMember(player, 'paladin');
  assert.equal(player.party.length, 4);
  assert.equal(canRecruit(player), false);
  assert.equal(recruitableVocations(player).length, 0);

  // `ordered` proves catalog order is available to callers of this module.
  assert.equal(ordered[0].id, firstTowerId());
});

test('LIV-10 campaign completion: records, unlocks in order, ultimate only at the end', () => {
  const ordered = listTowerDefinitionsByOrder();
  const player = createPartyPlayer('magician');

  const first = completePlayerTower(player, ordered[0].id);
  assert.deepEqual(first.completedTowerId, ordered[0].id);
  assert.deepEqual(first.progress.completedTowerIds, [ordered[0].id]);
  assert.equal(isTowerUnlocked(first.progress, ordered[1].id), true, 'next tower unlocks');
  assert.equal(isTowerUnlocked(first.progress, ordered[2].id), false, 'two ahead stays locked');
  assert.equal(first.allComplete, false);
  assert.equal(first.nextTowerId, ordered[1].id);

  // Idempotent completion.
  const repeat = completePlayerTower({ ...player, towerProgress: first.progress }, ordered[0].id);
  assert.deepEqual(repeat.progress.completedTowerIds, [ordered[0].id]);

  // Complete every tower -> ultimate victory + all unlocked.
  let progress = first.progress;
  for (const tower of ordered.slice(1)) {
    progress = completePlayerTower({ ...player, towerProgress: progress }, tower.id).progress;
  }
  assert.equal(allTowersCompleted(progress), true);
  for (const tower of ordered) assert.equal(isTowerUnlocked(progress, tower.id), true);

  // Unknown tower id cannot unlock anything.
  const bogus = completePlayerTower(player, 'not_a_tower');
  assert.equal(bogus.completedTowerId, null);
  assert.equal(bogus.allComplete, false);
  assert.deepEqual(bogus.progress.completedTowerIds, []);
  assert.equal(isTowerId('not_a_tower'), false);
});

test('LIV-10 picker lock state is progress-driven', () => {
  const ordered = listTowerDefinitionsByOrder();
  const progress = { completedTowerIds: [], unlockedTowerIds: [ordered[0].id] };
  assert.deepEqual(towerUnlockInfo(progress, ordered[0].id), { unlocked: true, requires: [] });
  const locked = towerUnlockInfo(progress, ordered[1].id);
  assert.equal(locked.unlocked, false);
  assert.deepEqual(locked.requires, [ordered[0].id]);

  const afterFirst = normalizeTowerProgress({ completedTowerIds: [ordered[0].id], unlockedTowerIds: [] });
  assert.equal(towerUnlockInfo(afterFirst, ordered[1].id).unlocked, true);
});

test('LIV-10 persistence: completeTower + recruitMember round-trip the campaign', async (t) => {
  await withFakeIndexedDB(t, async () => {
    const ordered = listTowerDefinitionsByOrder();
    const created = await COMMAND_HANDLERS.createSlot({ slotIndex: 2, vocation: 'magician' });
    // A bit of run progression to prove completion is non-destructive.
    created.player.level = 6;
    created.player.levelKeys = { 1: { copper: true } };
    created.player.springCharges = { 1: 1700000000000 };
    created.player.towerProgress = normalizeTowerProgress({ completedTowerIds: [], unlockedTowerIds: [ordered[0].id] });
    await COMMAND_HANDLERS.saveCharacter({ player: created.player });

    const completion = await COMMAND_HANDLERS.completeTower({ slotIndex: 2, towerId: ordered[0].id });
    assert.equal(completion.allComplete, false);
    assert.equal(completion.nextTowerId, ordered[1].id);
    assert.deepEqual(completion.progress.completedTowerIds, [ordered[0].id]);
    assert.ok(completion.recruitableVocations.includes('archer'));

    const afterComplete = await read(STORES.CHARACTERS, 'char_slot_2');
    assert.deepEqual(afterComplete.levelKeys, { 1: { copper: true } }, 'keys survive tower completion');
    assert.deepEqual(afterComplete.springCharges, { 1: 1700000000000 }, 'spring charges survive');
    assert.equal(isTowerUnlocked(afterComplete.towerProgress, ordered[1].id), true);

    const recruited = await COMMAND_HANDLERS.recruitMember({ slotIndex: 2, vocation: 'archer' });
    assert.equal(recruited.player.party.length, 2);
    assert.equal(recruited.member.vocation, 'archer');
    assert.equal(recruited.member.level, 1, 'recruit starts at level 1');
    assert.equal(recruited.player.activeMemberId, makeMemberId('archer'));
    assert.equal(recruited.player.vocation, 'archer');
    assert.ok(!recruited.recruitableVocations.includes('archer'));

    // Duplicate + unknown recruits are rejected and persist nothing new.
    await assert.rejects(() => COMMAND_HANDLERS.recruitMember({ slotIndex: 2, vocation: 'archer' }));
    await assert.rejects(() => COMMAND_HANDLERS.recruitMember({ slotIndex: 2, vocation: 'necromancer' }));

    const stored = await read(STORES.CHARACTERS, 'char_slot_2');
    assert.equal(stored.party.length, 2, 'rejected recruits do not grow the party');

    const loaded = await COMMAND_HANDLERS.loadSlot({ slotIndex: 2 });
    assert.equal(loaded.player.activeMemberId, makeMemberId('archer'));
    assert.deepEqual(loaded.player.party.map((m) => m.vocation), ['magician', 'archer']);

    // Campaign gate: a tower two ahead is still locked and cannot be entered.
    await assert.rejects(
      () => COMMAND_HANDLERS.selectTower({ slotIndex: 2, towerId: ordered[2].id }),
      /locked/i
    );

    // The just-unlocked next tower is enterable and keeps the party + active member.
    const moved = await COMMAND_HANDLERS.selectTower({ slotIndex: 2, towerId: ordered[1].id });
    assert.equal(moved.player.towerId, ordered[1].id);
    assert.equal(moved.player.current_floor, 1);
    assert.equal(moved.player.party.length, 2, 'switching towers preserves the party');
    assert.equal(moved.player.activeMemberId, makeMemberId('archer'));
  });
});

test('LIV-10 persistence: clearing every tower resolves to ultimate victory', async (t) => {
  await withFakeIndexedDB(t, async () => {
    const ordered = listTowerDefinitionsByOrder();
    await COMMAND_HANDLERS.createSlot({ slotIndex: 3, vocation: 'fighter' });
    const stored = await read(STORES.CHARACTERS, 'char_slot_3');
    await put(STORES.CHARACTERS, {
      ...stored,
      towerProgress: { completedTowerIds: [], unlockedTowerIds: ordered.map((tw) => tw.id) },
    });

    let last;
    for (const tower of ordered) {
      last = await COMMAND_HANDLERS.completeTower({ slotIndex: 3, towerId: tower.id });
    }
    assert.equal(last.allComplete, true);
    assert.equal(last.nextTowerId, null);
  });
});
