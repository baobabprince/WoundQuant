// Result cache in IndexedDB: re-opening the same files does not repeat the
// analysis, and manual corrections survive a reload. Everything degrades to
// "no cache" when IndexedDB is unavailable (private windows, old browsers).

const DB_NAME = 'woundquant';
const STORE = 'results';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function tx(mode, fn, fallback) {
  return open().then((db) => {
    if (!db) return fallback;
    return new Promise((resolve) => {
      try {
        const t = db.transaction(STORE, mode);
        const out = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
        t.onerror = () => resolve(fallback);
        t.onabort = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    });
  });
}

/** Identity of a file on disk (name + size + modification time). */
export function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export const autoKey = (file, paramsKey) => `a|${fileKey(file)}|${paramsKey}`;
export const manualKey = (file) => `m|${fileKey(file)}`;

export function dbGet(key) {
  return tx('readonly', (s) => s.get(key), undefined);
}

/** @returns {Promise<Array>} values in the order of `keys` (undefined when missing) */
export function dbGetMany(keys) {
  return open().then((db) => {
    if (!db || !keys.length) return keys.map(() => undefined);
    return new Promise((resolve) => {
      try {
        const t = db.transaction(STORE, 'readonly');
        const store = t.objectStore(STORE);
        const out = new Array(keys.length);
        keys.forEach((k, i) => { store.get(k).onsuccess = (ev) => { out[i] = ev.target.result; }; });
        t.oncomplete = () => resolve(out);
        t.onerror = () => resolve(keys.map(() => undefined));
        t.onabort = () => resolve(keys.map(() => undefined));
      } catch {
        resolve(keys.map(() => undefined));
      }
    });
  });
}

export function dbPut(key, value) {
  return tx('readwrite', (s) => { s.put(value, key); }, undefined);
}

export function dbDelete(key) {
  return tx('readwrite', (s) => { s.delete(key); }, undefined);
}

export function dbClear() {
  return tx('readwrite', (s) => { s.clear(); }, undefined);
}

export function dbCount() {
  return tx('readonly', (s) => s.count(), 0);
}
