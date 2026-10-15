import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../src/sync.js';
import { memoryStore } from '../src/storage.js';
import { newVault, importVaultKey } from '../src/crypto.js';
import { githubRemote } from '../src/remote.js';
import { createFakeGitHub } from './fake-github.mjs';
import { stableStringify } from '../src/crdt.js';
import { createFakeServer } from './fake-server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(n = 2) {
  const server = createFakeServer();
  const vault = newVault();
  const dek = await importVaultKey(vault.key);
  const keyring = { kid: vault.kid };
  const devices = [];
  for (let i = 0; i < n; i++) {
    const conn = server.connect();
    const store = memoryStore();
    const engine = new SyncEngine({ store, remote: conn.remote, dek, kid: keyring.kid, deviceId: 'dev' + i + 'xxxxxx' });
    await engine.load();
    engine.start();
    devices.push({ engine, store, conn });
  }
  return { server, devices, dek, kid: keyring.kid };
}

async function settle(engines, timeout = 5000) {
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < timeout) {
    await sleep(40);
    const busy = engines.some((e) => e.dirty.size || e.inflight.size);
    const states = engines.map((e) => stableStringify([...e.buckets.entries()].sort()));
    const same = states.every((s) => s === states[0]);
    if (!busy && same) {
      if (++stable >= 4) return;
    } else stable = 0;
  }
  throw new Error('did not settle');
}

const view = (e) => e.tasks().map(({ bucket, created, ...t }) => t).sort((a, b) => a.id.localeCompare(b.id));

test('a task added on the iPhone appears on the laptop', async () => {
  const { devices: [phone, laptop] } = await setup();
  const id = phone.engine.create({ title: 'قراءة كتاب', date: '2026-10-15', start: '20:00', end: '20:30' });
  await settle([phone.engine, laptop.engine]);
  const t = laptop.engine.get(id);
  assert.equal(t.title, 'قراءة كتاب');
  assert.equal(t.start, '20:00');
  assert.equal(t.end, '20:30');
});

test('moving and rescheduling keeps title and notes', async () => {
  const { devices: [phone, laptop] } = await setup();
  const id = phone.engine.create({ title: 'Call supplier', notes: 'ask about invoice', date: '2026-10-15', start: '10:00', end: '10:30' });
  await settle([phone.engine, laptop.engine]);
  laptop.engine.update(id, { when: { s: '14:00', e: '14:30' } });
  laptop.engine.update(id, { when: { date: '2026-10-16' } });
  await settle([phone.engine, laptop.engine]);
  const t = phone.engine.get(id);
  assert.deepEqual([t.title, t.notes, t.date, t.start, t.end], ['Call supplier', 'ask about invoice', '2026-10-16', '14:00', '14:30']);
});

test('the server only ever sees ciphertext', async () => {
  const { server, devices: [phone, laptop] } = await setup();
  phone.engine.create({ title: 'SECRET-TITLE-123', notes: 'SECRET-NOTE', date: '2026-10-15' });
  await settle([phone.engine, laptop.engine]);
  const dump = JSON.stringify([...server.docs.entries()]);
  assert.ok(server.docs.size > 0);
  assert.ok(!dump.includes('SECRET'));
  assert.ok(!dump.includes('2026-10-15'));
  for (const body of server.docs.values()) assert.deepEqual(Object.keys(body).sort(), ['ct', 'iv', 'k', 'v']);
});

test('the device cache is encrypted too', async () => {
  const { devices: [phone] } = await setup(1);
  phone.engine.create({ title: 'LOCAL-SECRET', date: '2026-10-15' });
  await phone.engine.whenPersisted();
  const rows = await phone.store.entries('buckets');
  assert.ok(rows.length > 0);
  assert.ok(!JSON.stringify(rows).includes('LOCAL-SECRET'));
});

test('reload keeps data, including changes not yet synced', async () => {
  const { server, devices: [phone, laptop], dek, kid } = await setup();
  phone.conn.setOnline(false);
  const id = phone.engine.create({ title: 'offline task', date: '2026-10-15' });
  await phone.engine.whenPersisted();
  phone.engine.stop(); // the tab is closed before it could sync
  await sleep(50);
  assert.equal(server.docs.size, 0);

  const conn = server.connect();
  const reopened = new SyncEngine({ store: phone.store, remote: conn.remote, dek, kid, deviceId: 'dev0xxxxxx' });
  await reopened.load();
  assert.equal(reopened.get(id).title, 'offline task');
  reopened.start();
  await settle([reopened, laptop.engine]);
  assert.equal(laptop.engine.get(id).title, 'offline task');
});

test('offline edits on both devices merge without loss', async () => {
  const { devices: [phone, laptop] } = await setup();
  const id = phone.engine.create({ title: 'Plan trip', date: '2026-10-15' });
  await settle([phone.engine, laptop.engine]);

  phone.conn.setOnline(false);
  laptop.conn.setOnline(false);
  phone.engine.update(id, { notes: 'book hotel' });
  phone.engine.create({ title: 'phone-only task', date: '2026-10-15' });
  laptop.engine.update(id, { when: { s: '09:00', e: '10:00' } });
  laptop.engine.update(id, { done: true });
  laptop.engine.create({ title: 'laptop-only task', date: '2026-10-16' });
  await sleep(100);
  assert.notEqual(phone.engine.status().state, 'synced');

  phone.conn.setOnline(true);
  laptop.conn.setOnline(true);
  phone.engine.flush();
  laptop.engine.flush();
  await settle([phone.engine, laptop.engine]);

  const t = phone.engine.get(id);
  assert.equal(t.notes, 'book hotel');
  assert.equal(t.start, '09:00');
  assert.equal(t.done, true);
  const titles = phone.engine.tasks().map((x) => x.title).sort();
  assert.deepEqual(titles, ['Plan trip', 'laptop-only task', 'phone-only task']);
  assert.deepEqual(view(phone.engine), view(laptop.engine));
});

test('same field edited on two devices: newest wins, the other is kept', async () => {
  const { devices: [phone, laptop] } = await setup();
  const id = phone.engine.create({ title: 'Original', date: '2026-10-15' });
  await settle([phone.engine, laptop.engine]);
  phone.conn.setOnline(false);
  laptop.conn.setOnline(false);
  phone.engine.update(id, { title: 'Phone version' });
  await sleep(5);
  laptop.engine.update(id, { title: 'Laptop version' });
  phone.conn.setOnline(true);
  laptop.conn.setOnline(true);
  phone.engine.flush();
  laptop.engine.flush();
  await settle([phone.engine, laptop.engine]);
  const t = phone.engine.get(id);
  assert.equal(t.title, 'Laptop version');
  assert.deepEqual(t.conflicts.map((c) => c.v), ['Phone version']);
  assert.deepEqual(view(phone.engine), view(laptop.engine));

  // Choosing the other version resolves it everywhere.
  phone.engine.resolveConflict(id, t.conflicts[0].key, true);
  await settle([phone.engine, laptop.engine]);
  assert.equal(laptop.engine.get(id).title, 'Phone version');
  assert.deepEqual(laptop.engine.get(id).conflicts, []);
});

test('delete on one device while the other edits offline: the task survives', async () => {
  const { devices: [phone, laptop] } = await setup();
  const id = phone.engine.create({ title: 'Keep me', date: '2026-10-15' });
  await settle([phone.engine, laptop.engine]);
  laptop.conn.setOnline(false);
  laptop.engine.update(id, { notes: 'added offline' });
  phone.engine.remove(id);
  await settle([phone.engine]);
  assert.equal(phone.engine.get(id), null);
  laptop.conn.setOnline(true);
  laptop.engine.flush();
  await settle([phone.engine, laptop.engine]);
  assert.equal(phone.engine.get(id).notes, 'added offline');
});

test('delete and undo sync', async () => {
  const { devices: [phone, laptop] } = await setup();
  const id = phone.engine.create({ title: 'Temp', date: '2026-10-15' });
  await settle([phone.engine, laptop.engine]);
  phone.engine.remove(id);
  await settle([phone.engine, laptop.engine]);
  assert.equal(laptop.engine.get(id), null);
  phone.engine.restore(id);
  await settle([phone.engine, laptop.engine]);
  assert.equal(laptop.engine.get(id).title, 'Temp');
});

test('no duplicates: rapid toggles and repeated syncs keep one task', async () => {
  const { devices: [phone, laptop] } = await setup();
  const id = phone.engine.create({ title: 'Toggle me', date: '2026-10-15' });
  for (let i = 0; i < 9; i++) phone.engine.update(id, { done: i % 2 === 0 });
  await settle([phone.engine, laptop.engine]);
  assert.equal(laptop.engine.tasks().length, 1);
  assert.equal(laptop.engine.get(id).done, true);
});

test('buckets split at 40 tasks', async () => {
  const { devices: [phone] } = await setup(1);
  for (let i = 0; i < 45; i++) phone.engine.create({ title: 't' + i, date: '2026-10-15' });
  assert.equal(phone.engine.buckets.size, 2);
});

test('fuzz: three devices, random edits and outages, always converge', async () => {
  for (let round = 0; round < 6; round++) {
    const { devices } = await setup(3);
    const engines = devices.map((d) => d.engine);
    const ids = [devices[0].engine.create({ title: 'seed', date: '2026-10-15' })];
    await settle(engines);
    for (let step = 0; step < 60; step++) {
      const d = devices[Math.floor(Math.random() * 3)];
      const r = Math.random();
      if (r < 0.1) d.conn.setOnline(!d.conn.remote || Math.random() < 0.5);
      else if (r < 0.25) ids.push(d.engine.create({ title: 'n' + step, date: '2026-10-1' + (step % 9) }));
      else {
        const id = ids[Math.floor(Math.random() * ids.length)];
        if (!d.engine._task(id)) continue;
        const k = Math.random();
        if (k < 0.3) d.engine.update(id, { title: 'title ' + step });
        else if (k < 0.5) d.engine.update(id, { done: Math.random() < 0.5 });
        else if (k < 0.7) d.engine.update(id, { when: { s: '1' + (step % 10) + ':00' } });
        else if (k < 0.85) d.engine.update(id, { notes: 'note ' + step });
        else if (k < 0.93) d.engine.remove(id);
        else d.engine.restore(id);
      }
      await sleep(Math.random() * 5);
    }
    for (const d of devices) d.conn.setOnline(true);
    for (const e of engines) e.flush();
    await settle(engines, 10000);
    const v0 = stableStringify(view(engines[0]));
    for (const e of engines) assert.equal(stableStringify(view(e)), v0);
  }
});

// --- GitHub remote ------------------------------------------------------------

async function setupGitHub(n = 2) {
  const gh = createFakeGitHub();
  const vault = newVault();
  const dek = await importVaultKey(vault.key);
  const devices = [];
  for (let i = 0; i < n; i++) {
    const client = { offline: false };
    const remote = githubRemote({ repo: gh.repo, token: gh.token, fetchImpl: gh.fetchFor(client), pollMs: 30 });
    const store = memoryStore();
    const engine = new SyncEngine({ store, remote, dek, kid: vault.kid, deviceId: 'gh' + i + 'xxxxxxx', flushDelay: 20 });
    await engine.load();
    devices.push({ engine, client, remote, store });
  }
  return { gh, vault, devices };
}

test('github: first device creates the vault, others join, strangers are refused', async () => {
  const { gh, vault, devices: [a, b] } = await setupGitHub();
  assert.equal(await a.remote.ensureVault(vault.kid), 'created');
  assert.equal(await b.remote.ensureVault(vault.kid), 'ok');
  assert.equal(await b.remote.ensureVault('someone-else'), 'mismatch');
  const bad = githubRemote({ repo: gh.repo, token: 'wrong', fetchImpl: gh.fetchFor() });
  await assert.rejects(bad.ensureVault(vault.kid), (e) => e.code === 'auth');
  const pub = createFakeGitHub({ isPrivate: false });
  await assert.rejects(githubRemote({ repo: pub.repo, token: pub.token, fetchImpl: pub.fetchFor() }).ensureVault('x'), (e) => e.code === 'public_repo');
});

test('github: tasks sync both ways and the repository holds ciphertext only', async () => {
  const { gh, vault, devices: [a, b] } = await setupGitHub();
  await a.remote.ensureVault(vault.kid);
  a.engine.start();
  b.engine.start();
  const id = a.engine.create({ title: 'GH-SECRET', notes: 'note', date: '2026-10-15', start: '10:00' });
  await settle([a.engine, b.engine]);
  assert.equal(b.engine.get(id).title, 'GH-SECRET');
  b.engine.update(id, { when: { s: '14:00' } });
  await settle([a.engine, b.engine]);
  assert.equal(a.engine.get(id).start, '14:00');
  const dump = JSON.stringify([...gh.files.values()].map((f) => Buffer.from(f.content, 'base64').toString()));
  assert.ok(!dump.includes('GH-SECRET') && !dump.includes('14:00'));
  a.engine.stop();
  b.engine.stop();
});

test('github: simultaneous writes to one bucket merge through sha conflicts', async () => {
  const { vault, devices: [a, b] } = await setupGitHub();
  await a.remote.ensureVault(vault.kid);
  a.engine.start();
  b.engine.start();
  const id = a.engine.create({ title: 'shared', date: '2026-10-15' });
  await settle([a.engine, b.engine]);
  a.client.offline = true;
  b.client.offline = true;
  a.engine.update(id, { notes: 'from A' });
  b.engine.update(id, { done: true });
  b.engine.update(id, { when: { s: '09:00', e: '09:30' } });
  await sleep(80);
  a.client.offline = false;
  b.client.offline = false;
  a.engine.flush();
  b.engine.flush();
  await settle([a.engine, b.engine], 10000);
  const t = a.engine.get(id);
  assert.deepEqual([t.notes, t.done, t.start], ['from A', true, '09:00']);
  assert.deepEqual(view(a.engine), view(b.engine));
  a.engine.stop();
  b.engine.stop();
});

test('github: a bad token is reported, not retried forever as "offline"', async () => {
  const { gh, vault, devices: [a] } = await setupGitHub(1);
  await a.remote.ensureVault(vault.kid);
  const bad = githubRemote({ repo: gh.repo, token: 'expired', fetchImpl: gh.fetchFor(), pollMs: 30 });
  const engine = new SyncEngine({ store: memoryStore(), remote: bad, dek: a.engine.dek, kid: vault.kid, deviceId: 'badxxxxxxx', flushDelay: 10 });
  engine.start();
  engine.create({ title: 'x', date: '2026-10-15' });
  await sleep(150);
  assert.equal(engine.status().state, 'auth');
  engine.stop();
});
