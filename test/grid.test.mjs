import test from 'node:test';
import assert from 'node:assert/strict';
import { segments, sheetRows, isPriority, priorityTitle } from '../src/grid.js';

test('sleep hours that wrap midnight fold at both ends of the day', () => {
  const s = segments({ from: '23:00', to: '06:00' });
  assert.deepEqual(s.map((x) => [x.from, x.to, x.sleep]), [[0, 360, true], [360, 1380, false], [1380, 1440, true]]);
  const rows = sheetRows([], { from: '23:00', to: '06:00' });
  assert.equal(rows.length, 1 + 17 + 1);
  assert.equal(rows[1].hour, 6);
});

test('no sleep setting shows all 24 hours', () => {
  assert.equal(sheetRows([], null).length, 24);
});

test('a task fills every half hour it covers; its title sits in the first', () => {
  const t = (id, start, end) => ({ id, title: id, start, end });
  const rows = sheetRows([t('a', '09:00', '10:30'), t('b', '09:40', '10:00'), t('late', '23:30', null)], { from: '23:00', to: '06:00' });
  const nine = rows.find((r) => r.hour === 9);
  const ten = rows.find((r) => r.hour === 10);
  assert.deepEqual(nine.cells[0].items.map((x) => [x.task.id, x.first]), [['a', true]]);
  assert.deepEqual(nine.cells[1].items.map((x) => [x.task.id, x.first]), [['a', false], ['b', true]]);
  assert.deepEqual(ten.cells[0].items.map((x) => x.task.id), ['a']);
  assert.equal(ten.cells[1].items.length, 0);
  assert.equal(rows[rows.length - 1].count, 1);
});

test('priorities are marked with a star in the title', () => {
  assert.equal(isPriority({ title: '★ Report' }), true);
  assert.equal(priorityTitle({ title: '★ Report' }), 'Report');
  assert.equal(isPriority({ title: 'Report' }), false);
});
