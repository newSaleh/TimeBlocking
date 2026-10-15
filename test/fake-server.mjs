// In-memory stand-in for the artifact database, with per-client
// connectivity and randomized delivery delays to provoke races.

const delay = (max = 6) => new Promise((r) => setTimeout(r, Math.random() * max));

export function createFakeServer() {
  const docs = new Map();
  let keyring = null;
  const clients = new Set();

  function broadcast(id) {
    for (const c of clients) c.deliver([{ id, body: structuredClone(docs.get(id)) }]);
  }

  function connect() {
    const client = {
      online: true,
      listeners: new Set(),
      deliver(changes) {
        if (!this.online) return;
        for (const l of this.listeners) {
          setTimeout(() => this.online && l(structuredClone(changes)), Math.random() * 8);
        }
      },
    };
    clients.add(client);
    const remote = {
      kind: 'fake',
      async getKeyring() {
        await delay();
        if (!client.online) throw { code: 'unavailable' };
        return keyring && structuredClone(keyring);
      },
      async createKeyring(kr) {
        await delay();
        if (!keyring) keyring = structuredClone(kr);
        return structuredClone(keyring);
      },
      async saveKeyring(kr) {
        keyring = structuredClone(kr);
      },
      subscribe(onChanges) {
        client.listeners.add(onChanges);
        const all = [...docs.keys()].map((id) => ({ id, body: structuredClone(docs.get(id)) }));
        if (all.length) client.deliver(all);
        return () => client.listeners.delete(onChanges);
      },
      async write(id, body) {
        await delay();
        if (!client.online) throw { code: 'unavailable' };
        docs.set(id, structuredClone(body));
        await delay(2);
        broadcast(id);
      },
      async wipe() {
        docs.clear();
        keyring = null;
      },
    };
    return {
      remote,
      setOnline(v) {
        client.online = v;
        if (v) {
          const all = [...docs.keys()].map((id) => ({ id, body: structuredClone(docs.get(id)) }));
          if (all.length) client.deliver(all);
        }
      },
    };
  }

  return { connect, docs, get keyring() { return keyring; } };
}
