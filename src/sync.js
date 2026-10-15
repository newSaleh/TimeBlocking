// Local-first sync engine.
//
// Tasks live in "buckets" (one per creating device and month, at most
// BUCKET_LIMIT tasks; a task never changes bucket). Every change is written
// to the device store first, then pushed to the server as ciphertext. Remote
// buckets are merged field by field (see crdt.js); when a merge leaves this
// device with something the server copy lacks, the merged bucket is pushed
// again, so concurrent writers converge.

import {
  newTask,
  setField,
  mergeBucket,
  emptyBucket,
  maxStamp,
  stableStringify,
  deletionMarker,
  isDeleted,
  visibleConflicts,
  dismissConflicts,
  createClock,
} from './crdt.js';
import { encryptJSON, decryptJSON, randomId } from './crypto.js';
import { normalizeDigits } from './digits.js';

export const BUCKET_LIMIT = 40;
export const TITLE_MAX = 300;
export const NOTES_MAX = 2000;
const bucketAad = (id) => `pocket-time/v1/bucket/${id}`;

export function cleanTitle(s) {
  return normalizeDigits(String(s || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX);
}

export function cleanNotes(s) {
  return normalizeDigits(String(s || '')).slice(0, NOTES_MAX);
}

export class SyncEngine {
  constructor({ store, remote, dek, kid, deviceId, now = () => Date.now(), onKeyMismatch, flushDelay = 300 }) {
    this.store = store;
    this.remote = remote || null;
    this.dek = dek;
    this.kid = kid;
    this.deviceId = deviceId;
    this.now = now;
    this.onKeyMismatch = onKeyMismatch || (() => {});
    this.clock = createClock(deviceId, 0, now);
    this.buckets = new Map();
    this.index = new Map(); // task id -> bucket id
    this.dirty = new Set();
    this.inflight = new Set();
    this.remoteCanon = new Map();
    this.persistChains = new Map();
    this.listeners = new Set();
    this.failures = 0;
    this.lastSync = null;
    this.remoteQueue = Promise.resolve();
    this.flushTimer = null;
    this.unsubscribe = null;
    this.stopped = false;
    this.keyMismatch = false;
    this.lastError = null;
    this.flushDelay = flushDelay;
  }

  // --- lifecycle -------------------------------------------------------------

  async load() {
    const rows = await this.store.entries('buckets');
    for (const [id, row] of rows) {
      if (!row || !row.env || row.env.k !== this.kid) continue;
      try {
        const state = await decryptJSON(this.dek, row.env, bucketAad(id));
        this._setBucket(id, state);
        if (row.dirty) this.dirty.add(id);
      } catch (_) {
        // Unreadable local row: the server copy will replace it.
      }
    }
    this._emit();
  }

  start() {
    if (!this.remote || this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = this.remote.subscribe(
      (changes) => {
        this.remoteQueue = this.remoteQueue.then(() => this._applyRemote(changes)).catch(() => {});
      },
      (err, info) => this._onSubscribeError(err, info),
    );
    this.flush();
  }

  stop() {
    this.stopped = true;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    clearTimeout(this.flushTimer);
  }

  _onSubscribeError(err, info) {
    if (info && info.fatal === false) {
      this.lastError = err && err.code;
      this._emit();
      return;
    }
    this.unsubscribe = null;
    this.failures++;
    this._emit();
    const code = err && err.code;
    if (code === 'revoked' || code === 'not_granted' || this.stopped) return;
    setTimeout(() => this.start(), Math.min(30000, 2000 * this.failures));
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn();
  }

  // --- state helpers ---------------------------------------------------------

  _setBucket(id, state) {
    this.buckets.set(id, state);
    for (const tid of Object.keys(state.tasks)) this.index.set(tid, id);
    this.clock.observe(maxStamp(state));
  }

  _persist(id) {
    const prev = this.persistChains.get(id) || Promise.resolve();
    const next = prev
      .then(async () => {
        const state = this.buckets.get(id);
        if (!state) return;
        const env = await encryptJSON(this.dek, this.kid, state, bucketAad(id));
        await this.store.put('buckets', id, { env, dirty: this.dirty.has(id) });
      })
      .catch(() => {});
    this.persistChains.set(id, next);
    return next;
  }

  async whenPersisted() {
    await Promise.all([...this.persistChains.values()]);
  }

  _bucketForNew() {
    const d = new Date(this.now());
    const month = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `b-${month}-${this.deviceId.slice(0, 8)}-`;
    let n = 0;
    for (const id of this.buckets.keys()) {
      if (id.startsWith(prefix)) n = Math.max(n, Number(id.slice(prefix.length)) || 0);
    }
    const id = prefix + n;
    const b = this.buckets.get(id);
    if (b && Object.keys(b.tasks).length >= BUCKET_LIMIT) return prefix + (n + 1);
    return id;
  }

  _commit(bucketId, task) {
    const bucket = this.buckets.get(bucketId) || emptyBucket();
    this._setBucket(bucketId, { ...bucket, tasks: { ...bucket.tasks, [task.id]: task } });
    this.dirty.add(bucketId);
    this._persist(bucketId);
    this._emit();
    this.scheduleFlush();
  }

  _task(id) {
    const b = this.index.get(id);
    return b ? this.buckets.get(b).tasks[id] : null;
  }

  // --- public operations -----------------------------------------------------

  create({ title, notes = '', date, start = null, end = null, done = false }) {
    const id = randomId(12);
    const fields = { title: cleanTitle(title), when: { date, s: start || null, e: start ? end || null : null }, done };
    if (notes) fields.notes = cleanNotes(notes);
    const task = newTask(id, fields, this.clock);
    this._commit(this._bucketForNew(), task);
    return id;
  }

  update(id, patch) {
    let task = this._task(id);
    if (!task) return;
    if ('title' in patch) {
      const title = cleanTitle(patch.title);
      if (title) task = setField(task, 'title', title, this.clock);
    }
    if ('notes' in patch) task = setField(task, 'notes', cleanNotes(patch.notes), this.clock);
    if ('done' in patch) task = setField(task, 'done', Boolean(patch.done), this.clock);
    if ('when' in patch) {
      const cur = (task.r.when && task.r.when.v) || {};
      const w = { date: cur.date, s: cur.s || null, e: cur.e || null, ...patch.when };
      if (!w.s) w.e = null;
      task = setField(task, 'when', w, this.clock);
    }
    if (task !== this._task(id)) this._commit(this.index.get(id), task);
  }

  remove(id) {
    const task = this._task(id);
    if (!task) return;
    this._commit(this.index.get(id), setField(task, 'del', deletionMarker(task), this.clock));
  }

  restore(id) {
    const task = this._task(id);
    if (!task) return;
    this._commit(this.index.get(id), setField(task, 'del', { on: false }, this.clock));
  }

  resolveConflict(id, key, useIt) {
    let task = this._task(id);
    if (!task || !task.x[key]) return;
    const c = task.x[key];
    if (useIt) {
      task = setField(task, c.f, c.v, this.clock);
      const sameField = Object.keys(task.x).filter((k) => task.x[k].f === c.f);
      task = dismissConflicts(task, sameField);
    } else {
      task = dismissConflicts(task, [key]);
    }
    this._commit(this.index.get(id), task);
  }

  tasks() {
    const out = [];
    for (const [bucketId, bucket] of this.buckets) {
      for (const t of Object.values(bucket.tasks)) {
        if (isDeleted(t)) continue;
        const when = (t.r.when && t.r.when.v) || {};
        if (!when.date) continue;
        out.push({
          id: t.id,
          bucket: bucketId,
          title: normalizeDigits((t.r.title && t.r.title.v) || ''),
          notes: normalizeDigits((t.r.notes && t.r.notes.v) || ''),
          date: when.date,
          start: when.s || null,
          end: when.s ? when.e || null : null,
          done: Boolean(t.r.done && t.r.done.v),
          created: t.c,
          conflicts: visibleConflicts(t),
        });
      }
    }
    return out;
  }

  get(id) {
    return this.tasks().find((t) => t.id === id) || null;
  }

  // --- sync ------------------------------------------------------------------

  status() {
    if (this.keyMismatch) return { state: 'locked' };
    if (!this.remote) return { state: 'local' };
    if (this.dirty.size === 0 && this.failures === 0) return { state: 'synced', lastSync: this.lastSync };
    if (this.lastError === 'auth') return { state: 'auth', pending: this.dirty.size };
    if (this.failures > 0) return { state: 'offline', pending: this.dirty.size };
    return { state: 'syncing', pending: this.dirty.size };
  }

  refresh() {
    if (this.remote && this.remote.refresh) this.remote.refresh();
  }

  scheduleFlush(delay = this.flushDelay) {
    if (!this.remote) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    if (!this.remote || this.stopped || this.keyMismatch) return Promise.resolve();
    const jobs = [];
    for (const id of this.dirty) if (!this.inflight.has(id)) jobs.push(this._push(id));
    return Promise.all(jobs);
  }

  async _push(id) {
    this.inflight.add(id);
    const state = this.buckets.get(id);
    const canon = stableStringify(state);
    let ok = false;
    try {
      const env = await encryptJSON(this.dek, this.kid, state, bucketAad(id));
      await this.remote.write(id, env);
      ok = true;
      this.remoteCanon.set(id, canon);
      if (stableStringify(this.buckets.get(id)) === canon) this.dirty.delete(id);
      this.failures = 0;
      this.lastError = null;
      this.lastSync = this.now();
      this._persist(id);
    } catch (e) {
      if (e && e.code === 'conflict') {
        // Another device wrote first: merge its version, then push again.
        if (e.latest) await this._applyRemote([{ id, body: e.latest }]);
        this.inflight.delete(id);
        this.dirty.add(id);
        this.scheduleFlush(50);
        return;
      }
      this.lastError = (e && e.code) || 'unavailable';
      this.failures++;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.flush(), Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5)));
    } finally {
      this.inflight.delete(id);
      this._emit();
      if (ok && this.dirty.has(id)) this.scheduleFlush(50);
    }
  }

  async _applyRemote(changes) {
    let touched = false;
    for (const { id, body } of changes) {
      if (!body || !body.ct) continue;
      if (body.k !== this.kid) {
        this.keyMismatch = true;
        this.onKeyMismatch();
        continue;
      }
      let remoteState;
      try {
        remoteState = await decryptJSON(this.dek, body, bucketAad(id));
      } catch (_) {
        continue;
      }
      const remoteCanon = stableStringify(remoteState);
      this.remoteCanon.set(id, remoteCanon);
      const local = this.buckets.get(id);
      const merged = mergeBucket(local, remoteState);
      const mergedCanon = stableStringify(merged);
      const localChanged = !local || stableStringify(local) !== mergedCanon;
      this._setBucket(id, merged);
      if (mergedCanon !== remoteCanon) this.dirty.add(id);
      else if (!this.inflight.has(id)) this.dirty.delete(id);
      if (localChanged || !this.dirty.has(id)) this._persist(id);
      touched = true;
    }
    if (touched) {
      if (this.dirty.size === 0) this.failures = 0;
      if (this.lastError === 'auth') this.lastError = null;
      this.lastSync = this.now();
      this._emit();
      this.scheduleFlush();
    }
  }

  // Re-encrypts everything under a new key (used when a device-only vault
  // joins sync) and queues every bucket for upload.
  async adoptKey(dek, kid, remote) {
    this.dek = dek;
    this.kid = kid;
    if (remote) this.remote = remote;
    this.keyMismatch = false;
    for (const id of this.buckets.keys()) {
      this.dirty.add(id);
      this._persist(id);
    }
    await this.whenPersisted();
    this._emit();
  }

  exportPlain() {
    return this.tasks()
      .sort((a, b) => (a.date + (a.start || '~')).localeCompare(b.date + (b.start || '~')) || a.created - b.created)
      .map(({ title, notes, date, start, end, done }) => ({ title, notes, date, start, end, done }));
  }
}
