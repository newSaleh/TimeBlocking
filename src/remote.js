// Sync servers. Everything they receive is already encrypted. Two options
// share one small interface:
//
//   ensureVault(kid) -> 'ok' | 'created' | 'mismatch'
//   subscribe(onChanges, onError) -> unsubscribe
//   write(id, envelope)            (throws {code:'conflict', latest} on a race)
//   refresh()                      (check for changes now)
//
// 1. GitHub: a private repository the user owns, reached with a fine-grained
//    token the user creates (Contents: read & write on that one repository).
//    Files: pt/meta.json (vault id) and pt/b/<bucket>.json (ciphertext).
// 2. claude.ai artifact database, when the page runs inside claude.ai:
//    data/users/<uid>/meta and data/users/<uid>/vault/b/<bucket>.

export const GITHUB_API = 'https://api.github.com';

const b64json = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
const unb64json = (s) => JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/\s/g, '')))));

function httpError(res) {
  const s = res.status;
  const code = s === 401 || s === 403 ? 'auth' : s === 404 ? 'not_found' : s === 409 || s === 422 ? 'conflict' : 'unavailable';
  return Object.assign(new Error(code), { code, status: s });
}

export function githubRemote({ repo, token, fetchImpl, api = GITHUB_API, pollMs = 10000 }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const base = `${api}/repos/${repo}/contents/pt`;
  const shas = new Map();
  let etag = null;
  let timer = null;
  let listener = null;
  let onError = null;
  let polling = Promise.resolve();

  const request = (url, opts = {}) =>
    doFetch(url, {
      ...opts,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {}),
      },
    });

  async function getFile(path) {
    const res = await request(`${base}/${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res);
    const j = await res.json();
    return { sha: j.sha, body: unb64json(j.content) };
  }

  async function putFile(path, body, sha) {
    return request(`${base}/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Pocket Time sync', content: b64json(body), ...(sha ? { sha } : {}) }),
    });
  }

  async function poll() {
    const res = await request(`${base}/b`, { headers: etag ? { 'If-None-Match': etag } : {} });
    if (res.status === 304 || res.status === 404) return;
    if (!res.ok) throw httpError(res);
    etag = res.headers.get('ETag');
    const list = await res.json();
    const changes = [];
    for (const f of Array.isArray(list) ? list : []) {
      if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
      const id = f.name.slice(0, -5);
      if (shas.get(id) === f.sha) continue;
      const file = await getFile(`b/${f.name}`);
      if (!file) continue;
      shas.set(id, file.sha);
      changes.push({ id, body: file.body });
    }
    if (changes.length && listener) await listener(changes);
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (!listener) return;
    timer = setTimeout(() => remote.refresh(), ms);
  }

  const remote = {
    kind: 'github',
    repo,

    async ensureVault(kid) {
      const info = await request(`${api}/repos/${repo}`);
      if (!info.ok) throw httpError(info);
      const meta = await info.json();
      if (meta && meta.private === false) throw Object.assign(new Error('public'), { code: 'public_repo' });
      const existing = await getFile('meta.json');
      if (existing) return existing.body.kid === kid ? 'ok' : 'mismatch';
      const res = await putFile('meta.json', { v: 1, kid });
      if (res.status === 409 || res.status === 422) {
        const now = await getFile('meta.json');
        return now && now.body.kid === kid ? 'ok' : 'mismatch';
      }
      if (!res.ok) throw httpError(res);
      return 'created';
    },

    subscribe(onChanges, errorCb) {
      listener = onChanges;
      onError = errorCb;
      remote.refresh();
      return () => {
        listener = null;
        clearTimeout(timer);
      };
    },

    refresh() {
      if (!listener) return polling;
      polling = polling
        .then(() => poll())
        .then(
          () => schedule(pollMs),
          (e) => {
            schedule(Math.min(pollMs * 3, 60000));
            if (onError && e && e.code === 'auth') onError(e, { fatal: false });
          },
        );
      return polling;
    },

    async write(id, body) {
      const path = `b/${id}.json`;
      const res = await putFile(path, body, shas.get(id));
      if (res.status === 409 || res.status === 422) {
        // Someone wrote this bucket first: hand back their version to merge.
        const latest = await getFile(path);
        if (latest) shas.set(id, latest.sha);
        throw Object.assign(new Error('conflict'), { code: 'conflict', latest: latest && latest.body });
      }
      if (!res.ok) throw httpError(res);
      const j = await res.json();
      shas.set(id, j.content.sha);
    },
  };
  return remote;
}

export function claudeRemote(db, uid) {
  const base = `data/users/${uid}`;
  const metaRef = db.doc(`${base}/meta`);
  const buckets = db.doc(`${base}/vault`).collection('b');
  return {
    kind: 'claude',

    async ensureVault(kid) {
      const snap = await metaRef.get();
      const data = snap.exists ? snap.data() : null;
      if (data && data.kid) return data.kid === kid ? 'ok' : 'mismatch';
      await metaRef.set({ v: 1, kid });
      return 'created';
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

    refresh() {},

    write(id, body) {
      return buckets.doc(id).set(body);
    },
  };
}
