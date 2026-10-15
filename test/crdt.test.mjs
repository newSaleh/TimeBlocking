import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClock, newTask, setField, mergeTask, mergeBucket, stableStringify,
  visibleConflicts, deletionMarker, isDeleted,
} from '../src/crdt.js';

const clockAt = (d, start) => {
  let t = start;
  return createClock(d, 0, () => t++);
};

const base = () => newTask('t1', { title: 'Read', when: { date: '2026-10-15', s: '10:00', e: null }, done: false }, clockAt('A', 1000));

test('edits to different fields on two devices both survive', () => {
  const t0 = base();
  const a = setField(t0, 'title', 'Read a book', clockAt('A', 2000));
  const b = setField(t0, 'when', { date: '2026-10-15', s: '14:00', e: null }, clockAt('B', 2000));
  const m1 = mergeTask(a, b);
  const m2 = mergeTask(b, a);
  assert.equal(stableStringify(m1), stableStringify(m2));
  assert.equal(m1.r.title.v, 'Read a book');
  assert.equal(m1.r.when.v.s, '14:00');
  assert.deepEqual(visibleConflicts(m1), []);
});

test('sequential edits are not conflicts', () => {
  const t0 = base();
  const a = setField(t0, 'title', 'v2', clockAt('A', 2000));
  const b = setField(mergeTask(t0, a), 'title', 'v3', clockAt('B', 3000));
  const c = setField(b, 'title', 'v4', clockAt('B', 4000));
  const m = mergeTask(a, c);
  assert.equal(m.r.title.v, 'v4');
  assert.deepEqual(visibleConflicts(m), []);
});

test('causality beats a skewed clock', () => {
  const t0 = base();
  const a = setField(t0, 'title', 'from A', clockAt('A', 9000)); // A's clock runs fast
  const b = setField(mergeTask(t0, a), 'title', 'B saw A', clockAt('B', 2000));
  const m = mergeTask(a, b);
  assert.equal(m.r.title.v, 'B saw A');
  assert.deepEqual(visibleConflicts(m), []);
});

test('concurrent edits of the same field keep the losing value', () => {
  const t0 = base();
  const a = setField(t0, 'title', 'Title from iPhone', clockAt('A', 2000));
  const b = setField(t0, 'title', 'Title from laptop', clockAt('B', 2500));
  const m = mergeTask(a, b);
  assert.equal(stableStringify(m), stableStringify(mergeTask(b, a)));
  assert.equal(m.r.title.v, 'Title from laptop');
  const conflicts = visibleConflicts(m);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].v, 'Title from iPhone');
  // Merging again (idempotence) does not duplicate the conflict.
  const again = mergeTask(m, a);
  assert.equal(visibleConflicts(again).length, 1);
  assert.equal(stableStringify(mergeTask(m, m)), stableStringify(m));
});

test('done toggles never raise conflicts', () => {
  const t0 = base();
  const a = setField(t0, 'done', true, clockAt('A', 2000));
  const b = setField(t0, 'done', false === true ? true : true, clockAt('B', 2100));
  const m = mergeTask(a, b);
  assert.equal(m.r.done.v, true);
  assert.deepEqual(visibleConflicts(m), []);
});

test('delete hides a task; an edit unseen by the deleter brings it back', () => {
  const t0 = base();
  const deleted = setField(t0, 'del', deletionMarker(t0), clockAt('A', 2000));
  assert.equal(isDeleted(deleted), true);
  const edited = setField(t0, 'notes', 'important detail', clockAt('B', 1500));
  const m = mergeTask(deleted, edited);
  assert.equal(isDeleted(m), false);
  assert.equal(m.r.notes.v, 'important detail');
});

test('undo delete', () => {
  const t0 = base();
  const d = setField(t0, 'del', deletionMarker(t0), clockAt('A', 2000));
  const u = setField(d, 'del', { on: false }, clockAt('A', 3000));
  assert.equal(isDeleted(u), false);
});

test('bucket merge is commutative, associative and idempotent (fuzz)', () => {
  const devices = ['A', 'B', 'C'];
  const titles = ['x', 'y', 'z', 'w'];
  for (let round = 0; round < 200; round++) {
    const seed = base();
    const states = devices.map((d, i) => {
      const clock = clockAt(d, 2000 + Math.floor(Math.random() * 50));
      let t = seed;
      const n = Math.floor(Math.random() * 4);
      for (let k = 0; k < n; k++) {
        const f = ['title', 'notes', 'done', 'when'][Math.floor(Math.random() * 4)];
        const v = f === 'done' ? Math.random() < 0.5 : f === 'when' ? { date: '2026-10-1' + i, s: null, e: null } : titles[Math.floor(Math.random() * 4)];
        t = setField(t, f, v, clock);
      }
      return { v: 1, tasks: { t1: t } };
    });
    const [a, b, c] = states;
    const ab_c = mergeBucket(mergeBucket(a, b), c);
    const a_bc = mergeBucket(a, mergeBucket(b, c));
    const cba = mergeBucket(mergeBucket(c, b), a);
    const field = (s, f) => stableStringify(s.tasks.t1.r[f] && s.tasks.t1.r[f].v);
    for (const f of ['title', 'notes', 'done', 'when']) {
      assert.equal(field(ab_c, f), field(a_bc, f));
      assert.equal(field(ab_c, f), field(cba, f));
    }
    assert.equal(stableStringify(mergeBucket(ab_c, ab_c)), stableStringify(ab_c));
  }
});
