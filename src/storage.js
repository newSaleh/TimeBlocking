// Device storage. IndexedDB holds the encrypted task cache, the pending
// (unsynced) flags and the non-extractable data key. A memory store stands
// in when IndexedDB is unavailable (and in tests).

export function memoryStore() {
  const stores = { kv: new Map(), buckets: new Map() };
  return {
    kind: 'memory',
    async get(store, key) {
      return stores[store].get(key);
    },
    async put(store, key, value) {
      stores[store].set(key, value);
    },
    async del(store, key) {
      stores[store].delete(key);
    },
    async entries(store) {
      return [...stores[store].entries()];
    },
    async clear() {
      stores.kv.clear();
      stores.buckets.clear();
    },
  };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function openIdbStore(name = 'pocket-time') {
  if (typeof indexedDB === 'undefined') throw new Error('no-indexeddb');
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    if (!db.objectStoreNames.contains('buckets')) db.createObjectStore('buckets');
  };
  const db = await req(open);
  const tx = (store, mode, fn) =>
    new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let result;
      Promise.resolve(fn(t.objectStore(store))).then((r) => (result = r), reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  return {
    kind: 'idb',
    get: (store, key) => tx(store, 'readonly', (s) => req(s.get(key))),
    put: (store, key, value) => tx(store, 'readwrite', (s) => req(s.put(value, key))),
    del: (store, key) => tx(store, 'readwrite', (s) => req(s.delete(key))),
    entries: (store) =>
      tx(store, 'readonly', async (s) => {
        const [keys, values] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
        return keys.map((k, i) => [k, values[i]]);
      }),
    clear: () =>
      new Promise((resolve, reject) => {
        const t = db.transaction(['kv', 'buckets'], 'readwrite');
        t.objectStore('kv').clear();
        t.objectStore('buckets').clear();
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }),
  };
}
