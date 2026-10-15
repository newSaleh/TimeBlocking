// Conflict-free merge of task data between devices.
//
// A task is a map of registers. Each register holds a value plus a stamp
// (t: hybrid clock in ms, d: device id) and `h`, the stamps of earlier values
// it is known to descend from. Merging two registers:
//   - if one descends from the other, the newer one wins (no conflict);
//   - if they are concurrent, the higher stamp wins and, for text and
//     schedule fields, the losing value is kept in the task's conflict list
//     so nothing is lost silently.
// The merge is commutative, associative and idempotent, so every device
// converges to the same state whatever order updates arrive in.

export const FIELDS = ['title', 'notes', 'when', 'done', 'del', 'rep', 'of'];
const CONFLICT_FIELDS = new Set(['title', 'notes', 'when']);
const HISTORY = 12;

export const stampKey = (r) => `${r.t}.${r.d}`;

function cmpStamp(a, b) {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.d === b.d) return 0;
  return a.d < b.d ? -1 : 1;
}

function parseKey(k) {
  const i = k.indexOf('.');
  return { t: Number(k.slice(0, i)), d: k.slice(i + 1) };
}

// Union of stamp keys, keeping the HISTORY most recent in a fixed order.
function unionHistory(...lists) {
  const set = new Set();
  for (const l of lists) for (const k of l || []) set.add(k);
  return [...set]
    .map((k) => ({ k, ...parseKey(k) }))
    .sort((a, b) => -cmpStamp(a, b))
    .slice(0, HISTORY)
    .map((x) => x.k);
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const sameValue = (a, b) => stableStringify(a) === stableStringify(b);

// Returns { reg, lost } where `lost` is the losing register of a concurrent
// edit with a different value, if any.
export function mergeRegister(a, b) {
  if (!a) return { reg: b, lost: null };
  if (!b) return { reg: a, lost: null };
  const ka = stampKey(a);
  const kb = stampKey(b);
  if (ka === kb) return { reg: { ...a, h: unionHistory(a.h, b.h) }, lost: null };

  const bFromA = (b.h || []).includes(ka);
  const aFromB = (a.h || []).includes(kb);
  let winner;
  let loser;
  let concurrent = false;
  if (bFromA && !aFromB) [winner, loser] = [b, a];
  else if (aFromB && !bFromA) [winner, loser] = [a, b];
  else {
    concurrent = true;
    [winner, loser] = cmpStamp(a, b) >= 0 ? [a, b] : [b, a];
  }
  const reg = { ...winner, h: unionHistory(winner.h, loser.h, [stampKey(loser)]) };
  const lost = concurrent && !sameValue(a.v, b.v) ? loser : null;
  return { reg, lost };
}

export function makeRegister(value, stamp, previous) {
  return {
    v: value,
    t: stamp.t,
    d: stamp.d,
    h: previous ? unionHistory(previous.h, [stampKey(previous)]) : [],
  };
}

// --- Clock -------------------------------------------------------------------

export function createClock(deviceId, initial = 0, now = () => Date.now()) {
  let last = initial;
  return {
    deviceId,
    next() {
      last = Math.max(now(), last + 1);
      return { t: last, d: deviceId };
    },
    observe(t) {
      if (typeof t === 'number' && t > last) last = t;
    },
    get last() {
      return last;
    },
  };
}

// --- Tasks -------------------------------------------------------------------

/**
 * Stored task: { id, c: created ms, r: {field: register}, x: {key: conflict},
 *                xd: {key: 1} dismissed conflicts }
 * conflict: { f: field, v: value, t, d }
 */
export function newTask(id, fields, clock) {
  const stamp = clock.next();
  const r = {};
  for (const f of FIELDS) {
    if (fields[f] !== undefined) r[f] = makeRegister(fields[f], stamp, null);
  }
  return { id, c: stamp.t, r, x: {}, xd: {} };
}

export function setField(task, field, value, clock) {
  const prev = task.r[field];
  if (prev && sameValue(prev.v, value)) return task;
  const reg = makeRegister(value, clock.next(), prev);
  return { ...task, r: { ...task.r, [field]: reg } };
}

const conflictKey = (f, reg) => `${f}:${stampKey(reg)}`;

export function mergeTask(a, b) {
  if (!a) return b;
  if (!b) return a;
  const r = {};
  const x = { ...(a.x || {}), ...(b.x || {}) };
  for (const f of FIELDS) {
    const { reg, lost } = mergeRegister(a.r[f], b.r[f]);
    if (reg) r[f] = reg;
    if (lost && CONFLICT_FIELDS.has(f)) {
      x[conflictKey(f, lost)] = { f, v: lost.v, t: lost.t, d: lost.d };
    }
  }
  const xd = { ...(a.xd || {}), ...(b.xd || {}) };
  return { id: a.id, c: Math.min(a.c, b.c), r, x, xd };
}

export function dismissConflicts(task, keys) {
  const xd = { ...task.xd };
  for (const k of keys) xd[k] = 1;
  return { ...task, xd };
}

// Deletion remembers which version of each field it saw. If another device
// edits the task afterwards (or concurrently), the task comes back instead of
// that edit being lost.
export function deletionMarker(task) {
  const k = {};
  for (const f of ['title', 'notes', 'when', 'done', 'rep']) {
    if (task.r[f]) k[f] = stampKey(task.r[f]);
  }
  return { on: true, k };
}

export function isDeleted(task) {
  const del = task.r.del && task.r.del.v;
  if (!del || !del.on) return false;
  for (const f of ['title', 'notes', 'when', 'done', 'rep']) {
    const reg = task.r[f];
    if (!reg) continue;
    if (del.k[f] !== stampKey(reg)) return false;
  }
  return true;
}

export function visibleConflicts(task) {
  const out = [];
  for (const [key, c] of Object.entries(task.x || {})) {
    if (task.xd && task.xd[key]) continue;
    const current = task.r[c.f];
    if (current && sameValue(current.v, c.v)) continue;
    out.push({ key, ...c });
  }
  return out.sort((p, q) => q.t - p.t);
}

// --- Buckets -----------------------------------------------------------------

export function emptyBucket() {
  return { v: 1, tasks: {} };
}

export function mergeBucket(a, b) {
  if (!a) return b;
  if (!b) return a;
  const tasks = {};
  const ids = new Set([...Object.keys(a.tasks), ...Object.keys(b.tasks)]);
  for (const id of [...ids].sort()) tasks[id] = mergeTask(a.tasks[id], b.tasks[id]);
  return { v: 1, tasks };
}

export function maxStamp(bucket) {
  let max = 0;
  for (const t of Object.values(bucket.tasks)) {
    for (const reg of Object.values(t.r)) if (reg.t > max) max = reg.t;
  }
  return max;
}
