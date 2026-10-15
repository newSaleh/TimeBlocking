// The only part of the app that talks to a server: the claude.ai artifact
// database (`db` capability). Everything sent here is already encrypted,
// except the keyring's KDF parameters (salt, iteration count).
//
// Layout, under the viewer's private subtree (unreadable by anyone else):
//   data/users/<uid>/keyring          wrapped data key
//   data/users/<uid>/vault/b/<bucket> encrypted task buckets

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function claudeRemote(db, uid) {
  const base = `data/users/${uid}`;
  const keyringRef = db.doc(`${base}/keyring`);
  const buckets = db.doc(`${base}/vault`).collection('b');

  async function readKeyring() {
    const snap = await keyringRef.get();
    const data = snap.exists ? snap.data() : null;
    return data && data.kid ? data : null;
  }

  return {
    kind: 'claude',

    getKeyring: readKeyring,

    // First device wins: take a short lease, then write only if no keyring
    // exists yet. Returns whichever keyring is now in force.
    async createKeyring(keyring) {
      let leased = true;
      try {
        const lease = await keyringRef.acquire({ holder: keyring.kid, ttlMs: 15000 });
        leased = lease.acquired;
      } catch (_) {
        leased = true; // No lease support: fall back to read-then-write.
      }
      if (!leased) {
        await sleep(2000);
        const existing = await readKeyring();
        if (existing) return existing;
        throw Object.assign(new Error('busy'), { code: 'busy' });
      }
      const existing = await readKeyring();
      if (existing) return existing;
      await keyringRef.set(keyring);
      return keyring;
    },

    saveKeyring(keyring) {
      return keyringRef.set(keyring);
    },

    subscribe(onChanges, onError) {
      return buckets.onSnapshot((snap) => {
        const changes = snap
          .docChanges()
          .filter((c) => c.type !== 'removed')
          .map((c) => ({ id: c.doc.id, body: c.doc.data() }));
        if (changes.length) onChanges(changes);
      }, onError);
    },

    write(id, body) {
      return buckets.doc(id).set(body);
    },

    // Permanently removes the encrypted vault (used only when starting over
    // after losing both the passphrase and the recovery code).
    async wipe() {
      const snap = await buckets.get();
      for (const d of snap.docs) await buckets.doc(d.id).delete();
      await keyringRef.delete();
    },
  };
}
