// Day grid: pure layout for the hour-by-hour page (day/). Minutes are counted
// from midnight of the shown day; nothing here touches the DOM.

import { toMinutes, durationMinutes } from './dates.js';

export const DAY_MIN = 24 * 60;
export const HOUR_PX = 64;
export const SLEEP_PX = 40;

// Sleep hours fold into a thin band. from/to are "HH:MM"; the range may wrap
// past midnight (23:00 → 06:00). Returns the visible and folded stretches of
// the day in order, each { from, to, sleep }.
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

// Pixel offset of each segment and the total height.
export function scale(segs) {
  let y = 0;
  const placed = segs.map((s) => {
    const h = s.sleep ? SLEEP_PX : ((s.to - s.from) / 60) * HOUR_PX;
    const p = { ...s, y, h };
    y += h;
    return p;
  });
  return { segs: placed, height: y };
}

// Minute of the day → y. Inside a folded stretch everything sits on the band.
export function yOf(sc, min) {
  for (const s of sc.segs) {
    if (min < s.to || s === sc.segs[sc.segs.length - 1]) {
      if (s.sleep) return s.y + (min <= s.from ? 0 : s.h);
      return s.y + ((Math.max(min, s.from) - s.from) / 60) * HOUR_PX;
    }
  }
  return sc.height;
}

// y → minute of the day (visible stretches only), rounded down to `step`.
export function minuteAt(sc, y, step = 30) {
  for (const s of sc.segs) {
    if (y < s.y + s.h) {
      if (s.sleep) return null;
      const m = s.from + ((y - s.y) / HOUR_PX) * 60;
      return Math.min(s.to - step, Math.floor(m / step) * step);
    }
  }
  return null;
}

export function span(task) {
  const s = toMinutes(task.start);
  const len = task.end ? durationMinutes(task.start, task.end) : 0;
  return [s, Math.min(DAY_MIN, s + Math.max(len, 15))];
}

// Side-by-side columns for overlapping tasks: each task gets { col, cols }
// within its cluster of mutually reaching tasks.
export function layoutColumns(tasks) {
  const items = tasks
    .map((task) => ({ task, span: span(task) }))
    .sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  const out = [];
  let cluster = [];
  let cols = [];
  let reach = -1;
  const close = () => {
    for (const it of cluster) out.push({ task: it.task, start: it.span[0], end: it.span[1], col: it.col, cols: cols.length, overlap: cluster.length > 1 });
    cluster = [];
    cols = [];
  };
  for (const it of items) {
    if (it.span[0] >= reach) close();
    let c = cols.findIndex((end) => end <= it.span[0]);
    if (c < 0) c = cols.push(0) - 1;
    cols[c] = it.span[1];
    it.col = c;
    cluster.push(it);
    reach = Math.max(reach, it.span[1]);
  }
  close();
  return out;
}

// Free stretches of at least `min` minutes between tasks, visible hours only.
export function gaps(placed, segs, min = 30) {
  const busy = placed.map((p) => [p.start, p.end]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const s of segs) {
    if (s.sleep) continue;
    let at = s.from;
    for (const [a, b] of busy) {
      if (b <= at || a >= s.to) continue;
      if (a - at >= min) out.push([at, a]);
      at = Math.max(at, b);
    }
    if (s.to - at >= min) out.push([at, s.to]);
  }
  return out;
}
