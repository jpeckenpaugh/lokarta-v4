/**
 * Test helper: a minimal in-memory IndexedDB shim for the storage/service layer.
 *
 * Mirrors the contract the storage suite relies on (keyed + in-line key puts,
 * transactional object stores, versioned open). Kept here so integration tests
 * can exercise the real worker command handlers without a browser.
 */

/** @returns {object} fake `globalThis.indexedDB` */
export function createFakeIndexedDB() {
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

/**
 * Runs `fn` with the fake IndexedDB installed and storage opened, restoring the
 * previous global and closing storage afterward.
 * @param {() => Promise<void>} fn
 */
export async function withFakeIndexedDB(fn) {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  const { openStorage, closeStorage } = await import('../../services/storage.js');
  await openStorage();
  try {
    await fn();
  } finally {
    closeStorage();
    globalThis.indexedDB = original;
  }
}
