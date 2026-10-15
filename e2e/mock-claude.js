// Test double for the claude.ai artifact runtime (window.claude.use), backed
// by the local e2e server so two browser "devices" share one database.
(function () {
  let offline = false;
  const listeners = new Set();
  const segs = (p) => p.split('/').length;

  async function call(path, body) {
    if (offline) throw { code: 'unavailable', message: 'offline' };
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!res.ok) throw { code: 'unavailable', message: 'server' };
    return res.json();
  }

  function snapshotDoc(path, body) {
    const data = body ? JSON.parse(JSON.stringify(body)) : undefined;
    return { id: path.split('/').pop(), exists: !!body, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } };
  }

  function docRef(path) {
    return {
      id: path.split('/').pop(),
      path,
      async get() {
        const r = await call('/db/get', { path });
        return snapshotDoc(path, r.body);
      },
      async set(data) {
        await call('/db/set', { path, body: data });
      },
      async update(data) {
        await call('/db/update', { path, body: data });
      },
      async delete() {
        await call('/db/delete', { path });
      },
      async acquire() {
        return { acquired: true };
      },
      collection(sub) {
        return colRef(path + '/' + sub);
      },
    };
  }

  function colRef(path) {
    return {
      path,
      doc(id) {
        return docRef(path + '/' + id);
      },
      async get() {
        const r = await call('/db/list', { path });
        const docs = r.docs.map((d) => snapshotDoc(d.path, d.body));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} };
      },
      onSnapshot(next) {
        const seen = new Map();
        let alive = true;
        const poll = async () => {
          if (!alive) return;
          if (!offline) {
            try {
              const r = await call('/db/list', { path });
              const changes = [];
              for (const d of r.docs) {
                const json = JSON.stringify(d.body);
                if (seen.get(d.path) !== json) {
                  changes.push({ type: seen.has(d.path) ? 'modified' : 'added', doc: snapshotDoc(d.path, d.body), oldIndex: -1, newIndex: -1 });
                  seen.set(d.path, json);
                }
              }
              if (changes.length) next({ docs: [], size: 0, empty: false, docChanges: () => changes, metadata: {} });
            } catch (_) {}
          }
          setTimeout(poll, 250);
        };
        poll();
        listeners.add(poll);
        return () => {
          alive = false;
        };
      },
    };
  }

  const db = Object.freeze({ doc: docRef, collection: colRef });
  const user = Object.freeze({ id: async () => 'user-test-1', isOwner: async () => true });
  window.__downloads = [];
  const downloads = Object.freeze({
    save: async (req) => {
      window.__downloads.push(req);
      return { status: 'saved' };
    },
  });
  const caps = { db, user, downloads };
  window.claude = { use: (name) => new Promise((r) => setTimeout(() => r(caps[name] || null), 30)) };
  window.__mock = {
    setOffline(v) {
      offline = v;
    },
  };
})();
