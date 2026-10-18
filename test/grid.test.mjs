import test from 'node:test';
import assert from 'node:assert/strict';
import { segments, scale, yOf, minuteAt, layoutColumns, gaps, HOUR_PX, SLEEP_PX } from '../src/grid.js';

test('sleep hours that wrap midnight fold at both ends of the day', () => {
  const s = segments({ from: '23:00', to: '06:00' });
  assert.deepEqual(s.map((x) => [x.from, x.to, x.sleep]), [[0, 360, true], [360, 1380, false], [1380, 1440, true]]);
  const sc = scale(s);
  assert.equal(sc.height, 2 * SLEEP_PX + 17 * HOUR_PX);
  assert.equal(yOf(sc, 360), SLEEP_PX);
  assert.equal(minuteAt(sc, SLEEP_PX + HOUR_PX * 1.6), 420 + 30);
  assert.equal(minuteAt(sc, 5), null);
});

test('no sleep setting shows the whole day', () => {
  const sc = scale(segments(null));
  assert.equal(sc.height, 24 * HOUR_PX);
  assert.equal(yOf(sc, 90), 1.5 * HOUR_PX);
});

test('overlapping tasks sit side by side, separate ones take full width', () => {
  const t = (id, start, end) => ({ id, start, end });
  const out = layoutColumns([t('a', '09:00', '10:00'), t('b', '09:30', '11:00'), t('c', '10:00', '10:30'), t('d', '12:00', '13:00')]);
  const by = Object.fromEntries(out.map((p) => [p.task.id, p]));
  assert.equal(by.a.cols, 2);
  assert.notEqual(by.a.col, by.b.col);
  assert.equal(by.c.col, by.a.col);
  assert.equal(by.d.cols, 1);
  assert.equal(by.d.overlap, false);
  const free = gaps(out, segments({ from: '23:00', to: '06:00' }), 60);
  assert.deepEqual(free[0], [360, 540]);
  assert.deepEqual(free[free.length - 1], [780, 1380]);
});
