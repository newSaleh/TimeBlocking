// Day sheet: pure layout for the hour-by-hour page (day/), drawn like a paper
// time box: one row per hour, a cell for :00 and one for :30. Minutes are
// counted from midnight of the shown day; nothing here touches the DOM.

import { toMinutes, durationMinutes } from './dates.js';

export const DAY_MIN = 24 * 60;
export const PRIORITY = '★';

// Sleep hours fold into one row. from/to are "HH:MM"; the range may wrap past
// midnight (23:00 → 06:00). Returns the visible and folded stretches of the
// day in order, each { from, to, sleep }.
export function segments(sleep) {
  if (!sleep || !sleep.from || !sleep.to || sleep.from === sleep.to) return [{ from: 0, to: DAY_MIN, sleep: false }];
  const a = toMinutes(sleep.from);
  const b = toMinutes(sleep.to);
  const hidden = a < b ? [[a, b]] : [[0, b], [a, DAY_MIN]].filter(([x, y]) => y > x);
  const out = [];
  let at = 0;
  for (const [x, y] of hidden) {
    if (x > at) out.push({ from: at, to: x, sleep: false });
    out.push({ from: x, to: y, sleep: true });
    at = y;
  }
  if (at < DAY_MIN) out.push({ from: at, to: DAY_MIN, sleep: false });
  return out;
}

export function span(task) {
  const s = toMinutes(task.start);
  const len = task.end ? durationMinutes(task.start, task.end) : 0;
  return [s, Math.min(DAY_MIN, s + Math.max(len, 1))];
}

// Rows of the sheet. A visible hour is { hour, cells: [cell, cell] } where a
// cell is { start, items: [{ task, first }] }: every task that covers that half
// hour, `first` where its title is written. A folded stretch is
// { sleep: true, from, to, count } with the number of tasks starting in it.
export function sheetRows(tasks, sleep) {
  const spans = tasks.map((task) => ({ task, span: span(task) }));
  const rows = [];
  for (const sg of segments(sleep)) {
    if (sg.sleep) {
      const count = spans.filter(({ span: [a] }) => a >= sg.from && a < sg.to).length;
      rows.push({ sleep: true, from: sg.from, to: sg.to, count });
      continue;
    }
    for (let m = Math.floor(sg.from / 60) * 60; m < sg.to; m += 60) {
      const cells = [m, m + 30].map((start) => {
        const end = start + 30;
        const items = spans
          .filter(({ span: [a, b] }) => a < end && b > start)
          .map(({ task, span: [a] }) => ({ task, first: a >= start || start === sg.from }));
        return { start, items };
      });
      rows.push({ hour: m / 60, cells });
    }
  }
  return rows;
}

export const isPriority = (task) => task.title.startsWith(PRIORITY);
export const priorityTitle = (task) => task.title.slice(PRIORITY.length).trim();
