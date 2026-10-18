// Pocket Time: interface and start-up.

import { normalizeDigits, bindDigitNormalization } from './digits.js';
import {
  todayKey,
  addDays,
  diffDays,
  keyToDate,
  formatDateNumeric,
  formatDateShort,
  weekdayName,
  firstDayOfWeek,
  weekDays,
  toMinutes,
  fromMinutes,
  addMinutes,
  durationMinutes,
  formatDuration,
  nowTime,
  nextQuarter,
  dayKey,
} from './dates.js';
import { parseQuickAdd, parseImportLines } from './parse.js';
import { translator } from './i18n.js';
import { SyncEngine, occursOn, occurrenceId, parseOccurrenceId } from './sync.js';
import { openIdbStore, memoryStore } from './storage.js';
import { claudeRemote, githubRemote } from './remote.js';
import { sheetRows, isPriority, priorityTitle, PRIORITY, DAY_MIN } from './grid.js';
import { newVault, importVaultKey, encodePairing, decodePairing, randomId } from './crypto.js';

// ---------------------------------------------------------------------------
// State

const prefs = {
  get(k) {
    try {
      return localStorage.getItem('pt.' + k);
    } catch (_) {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null || v === '') localStorage.removeItem('pt.' + k);
      else localStorage.setItem('pt.' + k, v);
    } catch (_) {}
  },
};

const ui = {
  lang: prefs.get('lang') === 'en' ? 'en' : 'ar',
  theme: ['light', 'dark'].includes(prefs.get('theme')) ? prefs.get('theme') : 'auto',
  day: todayKey(),
  lastToday: todayKey(),
  sheet: null,
  picker: null,
  ignoreParse: false,
  lastAdded: null,
  slot: null,
  sleep: parseSleep(prefs.get('sleep')),
  scrollToNow: true,
};
let t = translator(ui.lang);
let engine = null;
let store = null;
let storageWarning = false;
const vault = { data: null, remote: null, mismatch: false, downloads: null };

const $ = (id) => document.getElementById(id);
// The same app, laid out hour by hour, at day/.
const DAY_VIEW = document.getElementById('app').dataset.view === 'day';

function parseSleep(v) {
  const m = /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(v || '');
  return m ? { from: m[1], to: m[2] } : null;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(paths, cls = 'icon') {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    el.append(p);
  }
  return el;
}
const checkMark = () => svg(['M5 12.5l4.2 4.2L19 7'], '');
const chevron = (next) => svg([next ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'], 'icon flip');

const timeEl = (value, cls = '') => h('bdi', { class: `time ${cls}`.trim() }, value);

// ---------------------------------------------------------------------------
// Formatting

function relativeLabel(key) {
  const d = diffDays(todayKey(), key);
  if (d === 0) return t('today');
  if (d === 1) return t('tomorrow');
  if (d === -1) return t('yesterday');
  return null;
}

function shortDay(key) {
  return relativeLabel(key) || `${weekdayName(key, ui.lang)} ${formatDateShort(key)}`;
}

function rangeText(start, end) {
  if (!start) return '';
  return end ? `${start}–${end}` : start;
}

// ---------------------------------------------------------------------------
// Header and week strip

function renderHeader() {
  const rel = relativeLabel(ui.day);
  const weekday = weekdayName(ui.day, ui.lang);
  $('dayMain').textContent = rel || weekday;
  // The year is left out when it is the current one, so the line fits next to the "Today" button.
  const thisYear = ui.day.slice(0, 4) === todayKey().slice(0, 4);
  const dateText = thisYear && ui.day !== todayKey() ? formatDateShort(ui.day) : formatDateNumeric(ui.day);
  $('daySub').textContent = rel ? `${weekday} ${dateText}` : dateText;
  $('dayTitle').setAttribute('aria-label', `${rel ? rel + '، ' : ''}${weekday} ${formatDateNumeric(ui.day)}. ${t('pickDate')}`);
  const isToday = ui.day === todayKey();
  $('todayBtn').hidden = isToday;
  $('todayBtn').textContent = t('today');

  const all = engine ? engine.tasks() : [];
  const busy = new Set(all.filter((x) => !x.done).map((x) => x.date));
  const days = weekDays(ui.day, firstDayOfWeek(ui.lang, navigator.language));
  const today = todayKey();
  const cells = days.map((key) =>
    h(
      'button',
      {
        type: 'button',
        class: `week-day${key === today ? ' is-today' : ''}${busy.has(key) ? ' has-tasks' : ''}`,
        'aria-current': key === ui.day ? 'date' : null,
        'aria-label': `${weekdayName(key, ui.lang)} ${formatDateNumeric(key)}`,
        onclick: () => goTo(key),
      },
      h('span', { class: 'week-name', 'aria-hidden': 'true' }, weekdayName(key, ui.lang, 'narrow')),
      h('span', { class: 'week-num', 'aria-hidden': 'true' }, String(keyToDate(key).getDate())),
    ),
  );
  $('weekDays').replaceChildren(...cells);
}

function goTo(key) {
  if (key === ui.day) return;
  ui.day = key;
  ui.slot = null;
  ui.scrollToNow = DAY_VIEW;
  render();
  if (!DAY_VIEW) $('main').scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Day list

function overlapsFor(scheduled) {
  const span = (x) => {
    const s = toMinutes(x.start);
    const d = x.end ? durationMinutes(x.start, x.end) : 1;
    return [s, s + d];
  };
  const map = new Map();
  for (let i = 0; i < scheduled.length; i++) {
    for (let j = i + 1; j < scheduled.length; j++) {
      const [a1, a2] = span(scheduled[i]);
      const [b1, b2] = span(scheduled[j]);
      if (a1 < b2 && b1 < a2) {
        for (const [p, q] of [
          [scheduled[i], scheduled[j]],
          [scheduled[j], scheduled[i]],
        ]) {
          if (!map.has(p.id)) map.set(p.id, []);
          map.get(p.id).push(q.title);
        }
      }
    }
  }
  return map;
}

// --- Repeating tasks: occurrences appear on matching days without being stored.

function virtualOccurrence(s, date) {
  return { id: occurrenceId(s.id, date), virtual: true, of: s.id, title: s.title, notes: s.notes, date, start: s.start, end: s.end, done: false, created: s.created, conflicts: [] };
}

function seriesOf(task) {
  return task && task.of && engine ? engine.series().find((x) => x.id === task.of) || null : null;
}

function findTask(id) {
  if (!engine) return null;
  if (engine.exists(id)) return engine.get(id);
  const occ = parseOccurrenceId(id);
  if (!occ) return null;
  const s = engine.series().find((x) => x.id === occ.series);
  return s && occursOn(s, occ.date) ? virtualOccurrence(s, occ.date) : null;
}

// Stores an occurrence the first time it is changed.
function realId(id) {
  if (!engine.exists(id)) {
    const occ = parseOccurrenceId(id);
    if (occ) engine.materialize(occ.series, occ.date);
  }
  return id;
}

function updateTask(id, patch) {
  engine.update(realId(id), patch);
}

function dayTasks(key) {
  const list = engine ? engine.tasks().filter((x) => x.date === key) : [];
  if (engine) {
    for (const s of engine.series()) {
      if (occursOn(s, key) && !engine.exists(occurrenceId(s.id, key))) list.push(virtualOccurrence(s, key));
    }
  }
  const scheduled = list.filter((x) => x.start).sort((a, b) => a.start.localeCompare(b.start) || a.created - b.created);
  const anytime = list.filter((x) => !x.start).sort((a, b) => a.created - b.created);
  return { scheduled, anytime };
}

function carryTasks() {
  if (!engine) return [];
  const today = todayKey();
  return engine
    .tasks()
    .filter((x) => !x.done && !x.of && x.date < today && diffDays(x.date, today) <= 14)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''));
}

function taskRow(task, info = {}) {
  const meta = [];
  if (task.of) meta.push(h('span', { class: 'rep-mark', title: t('repeats'), 'aria-label': t('repeats') }, '↻'));
  if (info.overlap) meta.push(h('span', { class: 'tag' }, t('overlaps')));
  if (task.conflicts.length) meta.push(h('span', { class: 'tag' }, t('twoVersions')));
  if (task.notes) meta.push(h('span', { class: 'note-preview', dir: 'auto' }, task.notes.split('\n')[0]));
  return h(
    'li',
    { class: `task${task.done ? ' done' : ''}${info.current ? ' current' : ''}`, 'data-id': task.id },
    h(
      'button',
      {
        type: 'button',
        class: 'check',
        'aria-pressed': String(task.done),
        'aria-label': t(task.done ? 'markUndone' : 'markDone', { t: task.title }),
        onclick: () => updateTask(task.id, { done: !task.done }),
      },
      h('span', { class: 'check-ring' }, checkMark()),
    ),
    h(
      'button',
      { type: 'button', class: 'task-body', onclick: () => openSheet('task', { id: task.id }) },
      h(
        'span',
        { class: 'task-text' },
        h('span', { class: 'task-title', dir: 'auto' }, task.title),
        meta.length ? h('span', { class: 'task-meta' }, meta) : null,
      ),
      task.start
        ? h('span', { class: 'task-time' }, timeEl(task.start, 'start'), task.end ? timeEl(task.end, 'end') : null)
        : null,
    ),
  );
}

function renderList() {
  const { scheduled, anytime } = dayTasks(ui.day);
  const today = todayKey();
  const isToday = ui.day === today;
  const out = [];

  if (isToday) {
    const carry = carryTasks();
    if (carry.length) {
      out.push(
        h(
          'button',
          { type: 'button', class: 'carry', onclick: () => openSheet('carry') },
          h('span', null, t('carryRow', { n: carry.length })),
          chevron(true),
        ),
      );
    }
  }

  if (!scheduled.length && !anytime.length) {
    out.push(h('div', { class: 'empty' }, h('strong', null, t('emptyDay')), h('p', { dir: 'auto' }, t('emptyHint'))));
    $('list').replaceChildren(...out);
    return;
  }

  if (scheduled.length) {
    const overlaps = overlapsFor(scheduled);
    const now = toMinutes(nowTime());
    const items = [];
    let nowPlaced = !isToday;
    for (const task of scheduled) {
      const s = toMinutes(task.start);
      const e = task.end ? s + durationMinutes(task.start, task.end) : s;
      const current = isToday && s <= now && now < e;
      if (!nowPlaced && s > now) {
        items.push(nowLine());
        nowPlaced = true;
      }
      items.push(taskRow(task, { overlap: overlaps.has(task.id), current }));
    }
    if (!nowPlaced) items.push(nowLine());
    out.push(h('ul', { class: 'tasks', 'aria-label': t('timeLabel') }, items));
  }

  if (anytime.length) {
    if (scheduled.length) out.push(h('h2', { class: 'section-label' }, t('noTime')));
    out.push(h('ul', { class: 'tasks', 'aria-label': t('noTime') }, anytime.map((x) => taskRow(x))));
  }
  $('list').replaceChildren(...out);

  if (ui.lastAdded) {
    const row = $('list').querySelector(`[data-id="${ui.lastAdded}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    ui.lastAdded = null;
  }
}

function nowLine() {
  const time = nowTime();
  return h('li', { class: 'now-line', 'aria-label': `${t('now')} ${time}` }, h('span', null, t('now'), ' ', timeEl(time)));
}

// ---------------------------------------------------------------------------
// Hour grid (day/ only): the same tasks laid out on the 24 hours of the day.

const boxIcon = () => svg(['M3 3h18v18H3z', 'M3 3l18 18M21 3L3 21'], 'brand-icon');

function renderGrid() {
  const { scheduled, anytime } = dayTasks(ui.day);
  const isToday = ui.day === todayKey();
  const now = toMinutes(nowTime());
  const prios = anytime.filter(isPriority).slice(0, 3);
  const dump = anytime.filter((x) => !prios.includes(x));
  const openTask = (task) => openSheet('task', { id: task.id });
  const startSlot = (slot) => {
    ui.slot = slot;
    render();
    input().focus();
  };

  const prioBoxes = [0, 1, 2].map((i) => {
    const task = prios[i];
    return h(
      'button',
      {
        type: 'button',
        class: `prio-box${task && task.done ? ' done' : ''}`,
        dir: 'auto',
        'data-id': task ? task.id : null,
        onclick: () => (task ? openTask(task) : startSlot({ prio: true })),
      },
      task ? priorityTitle(task) : '',
    );
  });

  const dumpBox = h(
    'div',
    { class: 'dump', onclick: (e) => !e.target.closest('button') && startSlot(null) },
    dump.map((x) =>
      h(
        'button',
        { type: 'button', class: `dump-item${x.done ? ' done' : ''}`, dir: 'auto', 'data-id': x.id, onclick: () => openTask(x) },
        x.of ? '↻ ' : '',
        x.title,
      ),
    ),
  );

  const rows = sheetRows(scheduled, ui.sleep).map((r) => {
    if (r.sleep) {
      return h(
        'tr',
        { class: 'tb-sleep' },
        h(
          'td',
          { colspan: '3' },
          h(
            'button',
            { type: 'button', 'data-k': 'sleepRow', onclick: () => openSheet('sleep') },
            '☾ ',
            t('sleepBand'),
            ' ',
            timeEl(rangeText(fromMinutes(r.from), fromMinutes(r.to % DAY_MIN))),
            r.count ? h('span', { class: 'tag' }, String(r.count)) : null,
          ),
        ),
      );
    }
    const cells = r.cells.map((c) => {
      const titled = c.items.filter((x) => x.first);
      const current = isToday && now >= c.start && now < c.start + 30;
      const cls = ['tb-cell'];
      if (c.items.length) cls.push('filled');
      if (c.items.length > 1) cls.push('overlap');
      if (c.items.length && c.items.every((x) => x.task.done)) cls.push('done');
      if (current) cls.push('now');
      if (ui.slot && ui.slot.start === fromMinutes(c.start)) cls.push('slot');
      return h(
        'td',
        { class: cls.join(' ') },
        h(
          'button',
          {
            type: 'button',
            'data-start': fromMinutes(c.start),
            'aria-label': `${fromMinutes(c.start)} ${c.items.map((x) => x.task.title).join('، ')}`,
            onclick: () => {
              if (c.items.length) openTask((titled[0] || c.items[0]).task);
              else startSlot({ start: fromMinutes(c.start), end: fromMinutes(c.start + 30) });
            },
          },
          titled.map((x) => h('span', { class: 'tb-task', dir: 'auto', 'data-id': x.task.id }, x.task.of ? '↻ ' : '', x.task.title)),
        ),
      );
    });
    return h('tr', { 'data-hour': String(r.hour) }, h('th', { scope: 'row', class: 'tb-hour' }, String(r.hour)), cells);
  });

  const date = `${weekdayName(ui.day, ui.lang)} ${formatDateNumeric(ui.day)}`;
  const paper = h(
    'div',
    // 297mm page − 26mm margins − 10mm date line − 7mm column heads − room to spare.
    { class: 'paper', id: 'paper', style: `--rowh:${(250 / rows.length).toFixed(2)}mm` },
    h(
      'div',
      { class: 'paper-side' },
      h('div', { class: 'brand', dir: 'ltr' }, boxIcon(), h('span', null, 'The', h('br'), 'Time', h('br'), 'Box.')),
      h('h3', { class: 'paper-label' }, t('topPriorities')),
      h('div', { class: 'prio' }, prioBoxes),
      h('h3', { class: 'paper-label' }, t('brainDump')),
      dumpBox,
    ),
    h(
      'div',
      { class: 'paper-main' },
      h('div', { class: 'paper-date' }, h('span', null, t('sheetDate')), h('span', { class: 'paper-line tnum' }, date)),
      h(
        'table',
        { class: 'tb' },
        h('thead', null, h('tr', null, h('th'), h('th', { class: 'tnum' }, ':00'), h('th', { class: 'tnum' }, ':30'))),
        h('tbody', null, rows),
      ),
    ),
  );
  $('list').replaceChildren(paper);
  applyZoom();

  if (ui.scrollToNow) {
    ui.scrollToNow = false;
    if (!zoomed()) return;
    const hour = isToday ? Math.floor(now / 60) : scheduled[0] ? Number(scheduled[0].start.slice(0, 2)) : 8;
    const row = $('list').querySelector(`tr[data-hour="${hour}"]`);
    const main = $('main');
    if (row) main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - 96;
  }
  if (ui.lastAdded) {
    const el = $('list').querySelector(`[data-id="${ui.lastAdded}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
    ui.lastAdded = null;
  }
}

// --- Zoom: the page opens fitted to the width; pinch (or ctrl + wheel) to
// zoom in and out around the fingers, as in a PDF reader.

const zoom = { z: 0, fit: 1 };
const PAPER_PX = (210 / 25.4) * 96;
const zoomed = () => zoom.z > zoom.fit * 1.05;

function applyZoom() {
  const paper = $('paper');
  if (!paper) return;
  const main = $('main');
  zoom.fit = Math.min(1.5, (main.clientWidth - 16) / PAPER_PX);
  if (!zoom.z || zoom.z < zoom.fit) zoom.z = zoom.fit;
  paper.style.zoom = String(zoom.z);
}

function zoomTo(z, cx, cy) {
  const main = $('main');
  const r = main.getBoundingClientRect();
  const x = cx - r.left;
  const y = cy - r.top;
  const old = zoom.z;
  zoom.z = Math.min(zoom.fit * 5, Math.max(zoom.fit, z));
  $('paper').style.zoom = String(zoom.z);
  const k = zoom.z / old;
  main.scrollLeft = (main.scrollLeft + x) * k - x;
  main.scrollTop = (main.scrollTop + y) * k - y;
}

function setupZoom() {
  const main = $('main');
  let pinch = null;
  const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const mid = (e) => [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2];
  main.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = { d: dist(e), z: zoom.z };
  }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    zoomTo(pinch.z * (dist(e) / pinch.d), ...mid(e));
  }, { passive: false });
  main.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null;
  });
  // Safari's own page zoom would scale the whole app: keep it on the page.
  for (const type of ['gesturestart', 'gesturechange']) main.addEventListener(type, (e) => e.preventDefault());
  main.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomTo(zoom.z * Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
  }, { passive: false });
  window.addEventListener('resize', () => {
    const wasFit = !zoomed();
    applyZoom();
    if (wasFit) zoomTo(zoom.fit, 0, 0);
  });
}

function setupGridEvents() {
  setupZoom();
  runTimer();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runTimer();
  });
  // Keep the "until" choices ahead of the clock.
  setInterval(() => {
    if (!timer.end && !(document.activeElement && document.activeElement.tagName === 'SELECT')) renderTimer();
  }, 60000);
  $('printBtn').addEventListener('click', () => window.print());
}

// --- Timer: counts down on the page; the screen stays on while it runs.
// Safari does not ring a web timer on a locked phone, so it is only shown
// while the page is open.

const timer = { end: Number(prefs.get('timerEnd')) || 0, iv: null, lock: null, audio: null };

function startTimer(ms) {
  timer.end = Date.now() + ms;
  prefs.set('timerEnd', String(timer.end));
  // Unlock audio inside the tap so the bell can play later.
  try {
    timer.audio = timer.audio || new (window.AudioContext || window.webkitAudioContext)();
    timer.audio.resume();
  } catch (_) {}
  runTimer();
}

function stopTimer() {
  timer.end = 0;
  prefs.set('timerEnd', '');
  runTimer();
}

async function keepAwake(on) {
  try {
    if (on && !timer.lock && navigator.wakeLock && document.visibilityState === 'visible') {
      timer.lock = await navigator.wakeLock.request('screen');
      timer.lock.addEventListener('release', () => (timer.lock = null));
    } else if (!on && timer.lock) {
      await timer.lock.release();
      timer.lock = null;
    }
  } catch (_) {}
}

function bell() {
  const ac = timer.audio;
  if (!ac) return;
  try {
    for (let i = 0; i < 3; i++) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      const at = ac.currentTime + i * 0.6;
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      o.connect(g).connect(ac.destination);
      o.start(at);
      o.stop(at + 0.5);
    }
  } catch (_) {}
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function countdownText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const hr = Math.floor(s / 3600);
  return `${hr ? hr + ':' : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function runTimer() {
  clearInterval(timer.iv);
  timer.iv = null;
  const left = timer.end - Date.now();
  if (timer.end && left > 0) {
    timer.iv = setInterval(() => {
      const ms = timer.end - Date.now();
      const el = $('timerLeft');
      if (ms <= 0) {
        bell();
        toast(t('timerDone'));
        stopTimer();
      } else if (el) el.textContent = countdownText(ms);
    }, 1000);
    keepAwake(true);
  } else {
    if (timer.end) {
      timer.end = 0;
      prefs.set('timerEnd', '');
    }
    keepAwake(false);
  }
  renderTimer();
}

// Choices for "until": every half hour for the next twelve hours.
function untilChoices() {
  const now = toMinutes(nowTime());
  const first = Math.floor(now / 30) * 30 + 30;
  return Array.from({ length: 24 }, (_, i) => fromMinutes(first + i * 30));
}

function untilMs(time) {
  const d = new Date();
  const [hr, mn] = time.split(':').map(Number);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hr, mn, 0, 0);
  if (at <= d) at.setDate(at.getDate() + 1);
  return at - d;
}

// The Clock app's own timer rings on a locked iPhone; a shortcut starts it.
const TIMER_SHORTCUT = 'Pocket Time Timer';
const TIMER_SHORTCUT_URL = 'https://newsaleh.github.io/TimeBlocking/shortcut/Pocket%20Time%20Timer.shortcut';

function phoneTimer() {
  if (!prefs.get('timerShortcut')) return openSheet('phoneTimer');
  const left = timer.end - Date.now();
  const minutes = left > 0 ? Math.max(1, Math.round(left / 60000)) : 30;
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(TIMER_SHORTCUT)}&input=text&text=${minutes}`;
}

function phoneTimerSheet() {
  return [
    sheetHead(t('phoneTimer')),
    h('p', { class: 'sheet-hint' }, t('phoneTimerHint')),
    h('a', { class: 'btn', href: TIMER_SHORTCUT_URL, target: '_blank', rel: 'noopener', 'data-k': 'getTimer' }, t('shortcutGet')),
    h(
      'button',
      {
        type: 'button',
        class: 'text-btn',
        'data-k': 'haveTimer',
        onclick: () => {
          prefs.set('timerShortcut', '1');
          closeSheet();
          phoneTimer();
        },
      },
      t('phoneTimerHave'),
    ),
  ];
}

function renderTimer() {
  const box = $('timer');
  if (!box) return;
  const running = timer.end > Date.now();
  if (running) {
    box.replaceChildren(
      h('span', { class: 'timer-left tnum', id: 'timerLeft', role: 'timer' }, countdownText(timer.end - Date.now())),
      h('span', { class: 'timer-until' }, t('timerUntil'), ' ', timeEl(nowTime(new Date(timer.end)))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('phoneTimer'), onclick: phoneTimer }, '📱'),
      h('button', { type: 'button', class: 'text-btn quiet', onclick: stopTimer }, t('timerStop')),
    );
    return;
  }
  const sel = h(
    'select',
    {
      class: 'timer-select tnum',
      'aria-label': t('timerUntilPick'),
      onchange: (e) => e.target.value && startTimer(untilMs(e.target.value)),
    },
    h('option', { value: '' }, t('timerUntilPick')),
    untilChoices().map((x) => h('option', { value: x }, x)),
  );
  box.replaceChildren(
    h('button', { type: 'button', class: 'pill timer-go', onclick: () => startTimer(30 * 60 * 1000) }, t('timer30')),
    sel,
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('phoneTimer'), onclick: phoneTimer }, '📱'),
  );
}

function sleepSheet() {
  const cur = ui.sleep || { from: '23:00', to: '06:00' };
  const pad = (n) => String(n).padStart(2, '0');
  const set = (v) => {
    ui.sleep = v;
    prefs.set('sleep', v ? `${v.from}-${v.to}` : '');
    ui.scrollToNow = true;
    render();
  };
  const hours = (which) =>
    h(
      'div',
      { class: 'grid', dir: 'ltr' },
      Array.from({ length: 24 }, (_, hr) =>
        h(
          'button',
          {
            type: 'button',
            class: 'tnum',
            'data-k': `sleep-${which}-${hr}`,
            'aria-pressed': String(!!ui.sleep && cur[which] === `${pad(hr)}:00`),
            onclick: () => set({ ...cur, [which]: `${pad(hr)}:00` }),
          },
          pad(hr),
        ),
      ),
    );
  return [
    sheetHead(t('sleepTitle')),
    h('p', { class: 'sheet-hint' }, t('sleepHint')),
    h('h3', { class: 'field-label' }, t('sleepFrom')),
    h('div', { class: 'picker' }, hours('from')),
    h('h3', { class: 'field-label' }, t('sleepTo')),
    h('div', { class: 'picker' }, hours('to')),
    h('button', { type: 'button', class: 'text-btn', 'data-k': 'sleep-off', 'aria-pressed': String(!ui.sleep), onclick: () => set(null) }, t('sleepOff')),
  ];
}

// ---------------------------------------------------------------------------
// Status line: quiet unless something needs saying.

let pendingSince = null;
function statusText() {
  if (storageWarning) return t('statusNoStorage');
  if (vault.mismatch) return t('statusMismatch');
  if (!engine) return '';
  const s = engine.status();
  if (s.state === 'syncing') pendingSince = pendingSince || Date.now();
  else pendingSince = null;
  if (s.state === 'locked') return t('statusMismatch');
  if (s.state === 'auth') return t('statusAuth');
  if (s.state === 'offline') return t('statusOffline');
  if (s.state === 'syncing' && (!navigator.onLine || Date.now() - pendingSince > 4000)) {
    return navigator.onLine ? t('statusSyncing') : t('statusOffline');
  }
  return '';
}

function renderStatus() {
  const text = statusText();
  const el = $('status');
  if (el.textContent !== text) el.textContent = text;
  el.hidden = !text;
}

// ---------------------------------------------------------------------------
// Rendering loop

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderHeader();
    if (DAY_VIEW) renderGrid();
    else renderList();
    renderStatus();
    renderComposer();
    if (ui.sheet) renderSheet(false);
  });
}

function applyLang() {
  const root = document.documentElement;
  root.lang = ui.lang;
  root.dir = ui.lang === 'ar' ? 'rtl' : 'ltr';
  t = translator(ui.lang);
  $('prevBtn').setAttribute('aria-label', t('prevDay'));
  $('nextBtn').setAttribute('aria-label', t('nextDay'));
  $('settingsBtn').setAttribute('aria-label', t('settings'));
  $('todayBtn').setAttribute('aria-label', t('goToday'));
  $('addBtn').setAttribute('aria-label', t('add'));
  $('newTask').setAttribute('aria-label', t('addPlaceholder'));
  $('week').setAttribute('aria-label', t('dateLabel'));
  $('parseIgnore').textContent = t('ignoreParse');
  $('viewLink').setAttribute('aria-label', t(DAY_VIEW ? 'listView' : 'dayView'));
  if (DAY_VIEW) $('printBtn').setAttribute('aria-label', t('print'));
}

// ---------------------------------------------------------------------------
// Composer

const input = () => $('newTask');

function renderComposer() {
  const el = input();
  const ph = ui.slot
    ? ui.slot.prio
      ? t('addPriority')
      : t('addAt', { time: ui.slot.start })
    : ui.day === todayKey()
      ? t('addPlaceholder')
      : t('addPlaceholderDay', { day: shortDay(ui.day) });
  if (el.placeholder !== ph) el.placeholder = ph;
  const text = el.value.trim();
  $('addBtn').disabled = !text || !engine;
  const p = text && !ui.ignoreParse ? parseQuickAdd(text, todayKey()) : null;
  const box = $('parse');
  if (p && p.found) {
    const parts = [];
    if (p.date) parts.push(shortDay(p.date));
    if (p.start) parts.push(rangeText(p.start, p.end));
    $('parseChip').textContent = parts.join(' · ');
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

function submitNew() {
  if (!engine) return;
  const el = input();
  const text = normalizeDigits(el.value).replace(/\s+/g, ' ').trim();
  if (!text) return;
  const p = ui.ignoreParse ? null : parseQuickAdd(text, todayKey());
  const use = p && p.found;
  const date = use && p.date ? p.date : ui.day;
  const slot = !(use && p.start) && ui.slot && ui.slot.start ? ui.slot : null;
  const id = engine.create({
    title: (ui.slot && ui.slot.prio ? `${PRIORITY} ` : '') + (use ? p.title : text),
    date,
    start: use && p.start ? p.start : slot ? slot.start : null,
    end: use && p.start ? p.end : slot ? slot.end : null,
  });
  ui.slot = null;
  el.value = '';
  ui.ignoreParse = false;
  prefs.set('draft', '');
  if (date !== ui.day) {
    toast(t('addedTo', { day: shortDay(date) }), { label: shortDay(date), run: () => goTo(date) });
  } else {
    ui.lastAdded = id;
  }
  render();
}

function setupComposer() {
  const el = input();
  bindDigitNormalization(el);
  el.value = prefs.get('draft') || '';
  el.addEventListener('input', () => {
    if (!el.value.trim()) ui.ignoreParse = false;
    prefs.set('draft', el.value);
    renderComposer();
  });
  el.addEventListener('blur', () => {
    if (ui.slot && !el.value.trim()) {
      ui.slot = null;
      render();
    }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    submitNew();
    el.focus();
  });
  $('parseIgnore').addEventListener('click', () => {
    ui.ignoreParse = true;
    renderComposer();
    el.focus();
  });
}

// ---------------------------------------------------------------------------
// Toast

let toastTimer = null;
function toast(text, action, ms = 5000) {
  const el = $('toast');
  clearTimeout(toastTimer);
  const kids = [h('span', null, text)];
  if (action) {
    kids.push(
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            el.hidden = true;
            action.run();
          },
        },
        action.label,
      ),
    );
  }
  el.replaceChildren(...kids);
  el.hidden = false;
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Sheets

let sheetReturnFocus = null;

function openSheet(kind, data = {}) {
  sheetReturnFocus = document.activeElement;
  ui.sheet = { kind, ...data };
  ui.picker = null;
  $('sheetLayer').hidden = false;
  renderSheet(true);
  const focusTarget = $('sheet').querySelector('[data-autofocus]') || $('sheet').querySelector('button');
  if (focusTarget) focusTarget.focus({ preventScroll: true });
}

function closeSheet() {
  if (!ui.sheet) return;
  flushTitle();
  ui.sheet = null;
  ui.picker = null;
  $('sheetLayer').hidden = true;
  $('sheet').replaceChildren();
  if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus({ preventScroll: true });
  render();
}

function renderSheet(first) {
  const s = ui.sheet;
  if (!s) return;
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
  if (s.kind === 'task') renderTaskSheet(first);
  else if (s.kind === 'import') renderImportSheet(first);
  else if (first || !s.static) {
    const builders = { sleep: sleepSheet, phoneTimer: phoneTimerSheet, settings: settingsSheet, carry: carrySheet, calendar: calendarSheet, confirmDelete: confirmDeleteSheet };
    $('sheet').replaceChildren(...builders[s.kind]());
  }
  if (focusKey && !first) {
    const again = $('sheet').querySelector(`[data-k="${focusKey}"]`);
    if (again && document.activeElement !== again) again.focus({ preventScroll: true });
  }
}

function sheetHead(title, extra) {
  return h(
    'div',
    { class: 'sheet-head' },
    h('h2', null, title),
    h('div', { class: 'chips' }, extra, h('button', { type: 'button', class: 'text-btn', 'data-k': 'close', onclick: closeSheet }, t('done'))),
  );
}

// --- Task sheet ---------------------------------------------------------------

let titleTimer = null;
let titleTarget = null;

function flushTitle() {
  clearTimeout(titleTimer);
  if (!titleTarget || !engine) return;
  const { id, el } = titleTarget;
  const value = normalizeDigits(el.value).trim();
  if (value) updateTask(id, { title: value });
  titleTarget = null;
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function renderTaskSheet(first) {
  const id = ui.sheet.id;
  const task = findTask(id);
  if (!task) {
    closeSheet();
    return;
  }
  const sheet = $('sheet');
  if (first) {
    const title = h('textarea', {
      id: 'taskTitle',
      class: 'title-input',
      rows: '1',
      maxlength: '300',
      dir: 'auto',
      'aria-label': t('titleLabel'),
      enterkeyhint: 'done',
    });
    title.value = task.title;
    bindDigitNormalization(title);
    title.addEventListener('input', () => {
      autosize(title);
      titleTarget = { id, el: title };
      clearTimeout(titleTimer);
      titleTimer = setTimeout(flushTitle, 500);
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        title.blur();
      }
    });
    title.addEventListener('blur', () => {
      flushTitle();
      const current = findTask(id);
      if (current && !title.value.trim()) title.value = current.title;
    });

    const notes = h('textarea', {
      id: 'taskNotes',
      class: 'notes-input',
      rows: '2',
      maxlength: '2000',
      dir: 'auto',
      placeholder: t('notesPlaceholder'),
      'aria-label': t('notesLabel'),
    });
    notes.value = task.notes;
    bindDigitNormalization(notes);
    let notesTimer = null;
    const saveNotes = () => {
      clearTimeout(notesTimer);
      updateTask(id, { notes: normalizeDigits(notes.value) });
    };
    notes.addEventListener('input', () => {
      autosize(notes);
      clearTimeout(notesTimer);
      notesTimer = setTimeout(saveNotes, 600);
    });
    notes.addEventListener('blur', saveNotes);

    sheet.replaceChildren(
      sheetHead(t('titleLabel')),
      h('div', { class: 'field' }, title),
      h('div', { id: 'taskDynamic' }),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('notesLabel')), notes),
      h('div', { id: 'taskFoot', class: 'sheet-foot' }),
    );
    requestAnimationFrame(() => {
      autosize(title);
      autosize(notes);
    });
  } else {
    const title = $('taskTitle');
    const notes = $('taskNotes');
    if (title && document.activeElement !== title && !titleTarget && title.value !== task.title) {
      title.value = task.title;
      autosize(title);
    }
    if (notes && document.activeElement !== notes && notes.value !== task.notes) {
      notes.value = task.notes;
      autosize(notes);
    }
  }

  $('taskDynamic').replaceChildren(dateField(task), timeField(task), repeatField(task), copyField(task), ...conflictBlocks(task));
  if (ui.sheet.confirmDelete) {
    $('taskFoot').replaceChildren(deleteChoices(task));
    return;
  }
  $('taskFoot').replaceChildren(
    h(
      'button',
      {
        type: 'button',
        class: 'text-btn danger',
        'data-k': 'delete',
        onclick: () => {
          if (task.of) {
            ui.sheet.confirmDelete = true;
            renderSheet(false);
            return;
          }
          engine.remove(id);
          closeSheet();
          toast(t('deleted'), { label: t('undo'), run: () => engine.restore(id) });
        },
      },
      t('delete'),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        'data-k': 'toggleDone',
        'aria-pressed': String(task.done),
        onclick: () => updateTask(id, { done: !task.done }),
      },
      t(task.done ? 'markIncomplete' : 'markComplete'),
    ),
  );
}

function deleteOne(task) {
  const id = task.id;
  engine.remove(realId(id));
  closeSheet();
  toast(t('deleted'), { label: t('undo'), run: () => engine.restore(id) });
}

function deleteFollowing(task) {
  const s = seriesOf(task);
  engine.remove(realId(task.id));
  if (s) endSeries(s, addDays(task.date, -1));
  closeSheet();
  toast(t('deletedSeries'));
}

function deleteButtons(task) {
  if (!task.of) {
    return [h('button', { type: 'button', class: 'btn danger-btn', 'data-k': 'deleteOne', onclick: () => deleteOne(task) }, t('delete'))];
  }
  return [
    h('button', { type: 'button', class: 'btn danger-btn', 'data-k': 'deleteThis', onclick: () => deleteOne(task) }, t('deleteThis')),
    h('button', { type: 'button', class: 'btn danger-btn', 'data-k': 'deleteFollowing', onclick: () => deleteFollowing(task) }, t('deleteFollowing')),
  ];
}

// Shown after a long press on a task in the day list.
function confirmDeleteSheet() {
  const task = findTask(ui.sheet.id);
  if (!task) {
    setTimeout(closeSheet);
    return [];
  }
  return [
    h(
      'div',
      { class: 'delete-choices confirm-delete' },
      h('h2', null, t('deleteAsk')),
      h('p', { class: 'prose', dir: 'auto' }, task.title),
      deleteButtons(task),
      h('button', { type: 'button', class: 'btn', 'data-k': 'deleteCancel', onclick: closeSheet }, t('cancel')),
    ),
  ];
}

function deleteChoices(task) {
  return h(
    'div',
    { class: 'delete-choices' },
    deleteButtons(task),
    h(
      'button',
      {
        type: 'button',
        class: 'text-btn quiet',
        'data-k': 'deleteCancel',
        onclick: () => {
          ui.sheet.confirmDelete = false;
          renderSheet(false);
        },
      },
      t('cancel'),
    ),
  );
}

// Ends a series on `lastDay` (removing it if that is before it began) and
// clears stored occurrences after that day that were not done yet.
function endSeries(s, lastDay) {
  if (lastDay < s.from) engine.remove(s.id);
  else engine.update(s.id, { rep: { ...s.rule, until: lastDay } });
  for (const x of engine.tasks()) if (x.of === s.id && x.date > lastDay && !x.done) engine.remove(x.id);
}

function setRepeat(task, rule) {
  const s = seriesOf(task);
  if (s) {
    engine.update(s.id, { rep: { ...rule, until: null } });
    return;
  }
  // A one-off task becomes the first occurrence of a new series.
  const sid = engine.createSeries({ title: task.title, notes: task.notes, start: task.start, end: task.end, from: task.date, rule });
  const occ = engine.materialize(sid, task.date);
  if (task.done) engine.update(occ, { done: true });
  if (!task.virtual) engine.remove(task.id);
  ui.sheet.id = occ;
}

function repeatField(task) {
  const s = seriesOf(task);
  let rule = s ? s.rule : null;
  if (rule && rule.until && rule.until <= task.date) rule = null;
  const dow = keyToDate(task.date).getDay();
  const mode = !rule ? 'none' : rule.freq === 'daily' ? 'daily' : rule.days.length === 1 && rule.days[0] === dow && !ui.sheet.pickDays ? 'weekly' : 'days';
  const choose = (m) => {
    if (m === 'none') {
      ui.sheet.pickDays = false;
      if (s) {
        realId(task.id);
        endSeries(s, task.date);
      }
      return;
    }
    if (m === 'daily') setRepeat(task, { freq: 'daily' });
    if (m === 'weekly') setRepeat(task, { freq: 'days', days: [dow] });
    if (m === 'days') setRepeat(task, { freq: 'days', days: rule && rule.freq === 'days' ? rule.days : [dow] });
    ui.sheet.pickDays = m === 'days';
    renderSheet(false);
  };
  const kids = [
    h('span', { class: 'field-label' }, t('repeatLabel')),
    h(
      'div',
      { class: 'chips' },
      [
        ['none', t('repeatNone')],
        ['daily', t('repeatDaily')],
        ['weekly', t('repeatWeekly')],
        ['days', t('repeatDays')],
      ].map(([m, label]) => h('button', { type: 'button', class: 'chip', 'data-k': 'rep-' + m, 'aria-pressed': String(mode === m), onclick: () => choose(m) }, label)),
    ),
  ];
  if (mode === 'days') {
    const days = weekDays(task.date, firstDayOfWeek(ui.lang, navigator.language));
    kids.push(
      h(
        'div',
        { class: 'chips weekday-chips' },
        days.map((key) => {
          const d = keyToDate(key).getDay();
          const on = rule.days.includes(d);
          return h(
            'button',
            {
              type: 'button',
              class: 'chip',
              'data-k': 'repday-' + d,
              'aria-pressed': String(on),
              'aria-label': weekdayName(key, ui.lang),
              onclick: () => {
                const next = on ? rule.days.filter((x) => x !== d) : [...rule.days, d].sort();
                if (next.length) engine.update(s.id, { rep: { ...rule, days: next, until: null } });
              },
            },
            weekdayName(key, ui.lang, 'short'),
          );
        }),
      ),
    );
  }
  if (s && rule && (task.title !== s.title || task.start !== s.start || task.end !== s.end)) {
    kids.push(
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          'data-k': 'applyAll',
          onclick: () => {
            const patch = { title: task.title, when: { s: task.start, e: task.end } };
            engine.update(s.id, patch);
            for (const x of engine.tasks()) if (x.of === s.id && x.date > task.date && !x.done) engine.update(x.id, patch);
            toast(t('appliedToAll'));
          },
        },
        t('applyToAll'),
      ),
    );
  }
  return h('div', { class: 'field' }, kids);
}

function copyTo(task, date) {
  engine.create({ title: task.title, notes: task.notes, date, start: task.start, end: task.end });
  toast(t('copiedTo', { day: shortDay(date) }), {
    label: t('show'),
    run: () => {
      closeSheet();
      goTo(date);
    },
  });
}

function copyField(task) {
  const kids = [
    h('span', { class: 'field-label' }, t('copyLabel')),
    h(
      'div',
      { class: 'chips' },
      h('button', { type: 'button', class: 'chip', 'data-k': 'copyNext', onclick: () => copyTo(task, addDays(task.date, 1)) }, t('copyNextDay')),
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          'data-k': 'copyOther',
          'aria-expanded': String(ui.picker === 'copy'),
          onclick: () => {
            ui.picker = ui.picker === 'copy' ? null : 'copy';
            ui.pickerMonth = task.date.slice(0, 7);
            renderSheet(false);
          },
        },
        t('copyOther'),
      ),
    ),
  ];
  if (ui.picker === 'copy') {
    kids.push(
      monthView(task.date, ui.pickerMonth, (key) => {
        ui.picker = null;
        copyTo(task, key);
        renderSheet(false);
      }),
    );
  }
  return h('div', { class: 'field' }, kids);
}

function moveTask(task, date) {
  if (date === task.date) return;
  const from = task.date;
  updateTask(task.id, { when: { date } });
  if (from === ui.day || date !== ui.day) {
    toast(t('movedTo', { day: shortDay(date) }), { label: t('undo'), run: () => updateTask(task.id, { when: { date: from } }) });
  }
}

function dateField(task) {
  const today = todayKey();
  const quick = [
    [today, t('today')],
    [addDays(today, 1), t('tomorrow')],
    [addDays(today, 2), t('afterTomorrow')],
  ];
  const isQuick = quick.some(([k]) => k === task.date);
  const chips = quick.map(([key, label]) =>
    h(
      'button',
      { type: 'button', class: 'chip', 'data-k': 'date-' + label, 'aria-pressed': String(task.date === key), onclick: () => moveTask(task, key) },
      label,
    ),
  );
  chips.push(
    h(
      'button',
      {
        type: 'button',
        class: 'chip tnum',
        'data-k': 'date-other',
        'aria-pressed': String(!isQuick),
        'aria-expanded': String(ui.picker === 'date'),
        onclick: () => {
          ui.picker = ui.picker === 'date' ? null : 'date';
          ui.pickerMonth = task.date.slice(0, 7);
          renderSheet(false);
        },
      },
      isQuick ? t('otherDate') : `${weekdayName(task.date, ui.lang)} ${formatDateNumeric(task.date)}`,
    ),
  );
  const kids = [h('span', { class: 'field-label' }, t('dateLabel')), h('div', { class: 'chips' }, chips)];
  if (ui.picker === 'date') {
    kids.push(
      monthView(task.date, ui.pickerMonth, (key) => {
        ui.picker = null;
        moveTask(task, key);
        renderSheet(false);
      }),
    );
  }
  return h('div', { class: 'field' }, kids);
}

function setTime(task, which, value) {
  if (which === 'start') {
    const dur = task.start && task.end ? durationMinutes(task.start, task.end) : null;
    updateTask(task.id, { when: { s: value, e: dur ? addMinutes(value, dur) : task.end } });
  } else {
    updateTask(task.id, { when: { e: value } });
  }
}

function timeField(task) {
  const kids = [h('span', { class: 'field-label' }, t('timeLabel'))];
  if (!task.start) {
    kids.push(
      h(
        'div',
        { class: 'chips' },
        h(
          'button',
          {
            type: 'button',
            class: 'chip',
            'data-k': 'addTime',
            onclick: () => {
              const s = task.date === todayKey() ? nextQuarter() : '09:00';
              updateTask(task.id, { when: { s, e: null } });
              ui.picker = 'start';
            },
          },
          t('addTime'),
        ),
      ),
    );
    return h('div', { class: 'field' }, kids);
  }

  const timeBtn = (which, value) =>
    h(
      'button',
      {
        type: 'button',
        class: 'time-btn tnum',
        'data-k': 'time-' + which,
        'aria-expanded': String(ui.picker === which),
        'aria-label': `${t(which)} ${value || ''}`,
        onclick: () => {
          ui.picker = ui.picker === which ? null : which;
          renderSheet(false);
        },
      },
      h('small', null, t(which)),
      value ? timeEl(value) : h('span', { class: 'dash' }, '+'),
    );

  kids.push(
    h(
      'div',
      { class: 'time-row' },
      timeBtn('start', task.start),
      h('span', { class: 'dash', 'aria-hidden': 'true' }, '–'),
      timeBtn('end', task.end),
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          'data-k': 'noTime',
          onclick: () => {
            ui.picker = null;
            updateTask(task.id, { when: { s: null, e: null } });
          },
        },
        t('removeTime'),
      ),
    ),
  );

  if (ui.picker === 'start' || ui.picker === 'end') kids.push(timePicker(task, ui.picker));

  const dur = task.end ? durationMinutes(task.start, task.end) : null;
  kids.push(
    h('span', { class: 'picker-label' }, t('duration'), dur ? ' · ' : '', dur ? h('bdi', { class: 'tnum' }, formatDuration(dur, ui.lang)) : null),
    h(
      'div',
      { class: 'chips' },
      [15, 30, 45, 60, 90, 120].map((m) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip tnum',
            'data-k': 'dur-' + m,
            'aria-pressed': String(dur === m),
            onclick: () => updateTask(task.id, { when: { e: addMinutes(task.start, m) } }),
          },
          h('bdi', null, formatDuration(m, ui.lang)),
        ),
      ),
    ),
    h('span', { class: 'picker-label' }, t('shift')),
    h(
      'div',
      { class: 'chips' },
      [-30, 30, 60].map((m) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip tnum',
            'data-k': 'shift-' + m,
            onclick: () =>
              updateTask(task.id, { when: { s: addMinutes(task.start, m), e: task.end ? addMinutes(task.end, m) : null } }),
          },
          t(m < 0 ? 'earlier' : 'later', { d: formatDuration(Math.abs(m), ui.lang) }),
        ),
      ),
    ),
  );

  const others = dayTasks(task.date).scheduled;
  const overlaps = overlapsFor(others).get(task.id);
  if (overlaps) kids.push(h('p', { class: 'note overlap-note', dir: 'auto' }, t('overlapsWith', { t: overlaps.join('، ') })));
  return h('div', { class: 'field' }, kids);
}

function timePicker(task, which) {
  const cur = which === 'start' ? task.start : task.end;
  const [ch, cm] = cur ? cur.split(':').map(Number) : [null, null];
  const pad = (n) => String(n).padStart(2, '0');
  const fallbackHour = which === 'end' && task.start ? (Number(task.start.slice(0, 2)) + 1) % 24 : 9;
  const hours = Array.from({ length: 24 }, (_, hr) =>
    h(
      'button',
      {
        type: 'button',
        class: 'tnum',
        'data-k': `${which}-h-${hr}`,
        'aria-pressed': String(ch === hr),
        'aria-label': `${pad(hr)}:${pad(cm || 0)}`,
        onclick: () => setTime(task, which, `${pad(hr)}:${pad(cm || 0)}`),
      },
      pad(hr),
    ),
  );
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5).map((mn) =>
    h(
      'button',
      {
        type: 'button',
        class: 'tnum',
        'data-k': `${which}-m-${mn}`,
        'aria-pressed': String(cm === mn),
        'aria-label': `${pad(ch == null ? fallbackHour : ch)}:${pad(mn)}`,
        onclick: () => {
          ui.picker = null;
          setTime(task, which, `${pad(ch == null ? fallbackHour : ch)}:${pad(mn)}`);
        },
      },
      ':' + pad(mn),
    ),
  );
  return h(
    'div',
    { class: 'picker', dir: 'ltr' },
    h('div', { class: 'grid' }, hours),
    h('div', { class: 'picker-divider', role: 'separator' }),
    h('div', { class: 'grid' }, minutes),
  );
}

function conflictBlocks(task) {
  return task.conflicts.map((c) => {
    let value;
    if (c.f === 'when') {
      const w = c.v || {};
      value = [w.date ? shortDay(w.date) : '', rangeText(w.s, w.e)].filter(Boolean).join(' · ');
    } else {
      value = normalizeDigits(c.v || '') || t('conflictEmpty');
    }
    return h(
      'div',
      { class: 'field' },
      h(
        'div',
        { class: 'conflict' },
        h('strong', null, t('conflictTitle')),
        h('span', null, t('conflictHint')),
        h('span', { class: 'conflict-value', dir: 'auto' }, value),
        h(
          'div',
          { class: 'chips' },
          h('button', { type: 'button', class: 'chip', onclick: () => applyConflict(task, c, true) }, t('useThis')),
          h('button', { type: 'button', class: 'chip', onclick: () => applyConflict(task, c, false) }, t('keepCurrent')),
        ),
      ),
    );
  });
}

function applyConflict(task, c, useIt) {
  engine.resolveConflict(task.id, c.key, useIt);
  if (useIt && c.f === 'title') {
    const el = $('taskTitle');
    if (el) el.value = c.v;
  }
  if (useIt && c.f === 'notes') {
    const el = $('taskNotes');
    if (el) el.value = c.v;
  }
}

// --- Month calendar -------------------------------------------------------------

function monthView(selected, month, onPick) {
  const [y, m] = month.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const fd = firstDayOfWeek(ui.lang, navigator.language);
  const start = weekDays(first, fd)[0];
  const today = todayKey();
  const loc = ui.lang === 'ar' ? 'ar-u-nu-latn-ca-gregory' : 'en-GB-u-nu-latn-ca-gregory';
  const title = new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' }).format(keyToDate(first));
  const shiftMonth = (n) => {
    const d = new Date(y, m - 1 + n, 1, 12);
    ui.pickerMonth = dayKey(d).slice(0, 7);
    renderSheet(false);
  };
  const dows = weekDays(start, fd).map((k) => h('span', { class: 'dow', 'aria-hidden': 'true' }, weekdayName(k, ui.lang, 'narrow')));
  const cells = Array.from({ length: 42 }, (_, i) => {
    const key = addDays(start, i);
    return h(
      'button',
      {
        type: 'button',
        class: `tnum${key.slice(0, 7) !== month ? ' other' : ''}${key === today ? ' is-today' : ''}`,
        'data-k': 'cal-' + key,
        'aria-pressed': String(key === selected),
        'aria-label': `${weekdayName(key, ui.lang)} ${formatDateNumeric(key)}`,
        onclick: () => onPick(key),
      },
      String(keyToDate(key).getDate()),
    );
  });
  return h(
    'div',
    { class: 'picker' },
    h(
      'div',
      { class: 'month-head' },
      h('button', { type: 'button', class: 'icon-btn', 'data-k': 'cal-prev', 'aria-label': t('prevMonth'), onclick: () => shiftMonth(-1) }, chevron(false)),
      h('strong', { class: 'tnum' }, title),
      h('button', { type: 'button', class: 'icon-btn', 'data-k': 'cal-next', 'aria-label': t('nextMonth'), onclick: () => shiftMonth(1) }, chevron(true)),
    ),
    h('div', { class: 'month' }, dows, cells),
  );
}

function calendarSheet() {
  if (!ui.pickerMonth) ui.pickerMonth = ui.day.slice(0, 7);
  return [
    sheetHead(t('pickDate')),
    h(
      'div',
      { class: 'field' },
      h(
        'div',
        { class: 'chips' },
        h('button', { type: 'button', class: 'chip', 'data-k': 'jump-today', onclick: () => (goTo(todayKey()), closeSheet()) }, t('today')),
        h('button', { type: 'button', class: 'chip', 'data-k': 'jump-tomorrow', onclick: () => (goTo(addDays(todayKey(), 1)), closeSheet()) }, t('tomorrow')),
      ),
      monthView(ui.day, ui.pickerMonth, (key) => {
        goTo(key);
        closeSheet();
      }),
    ),
  ];
}

// --- Carry-over sheet -----------------------------------------------------------

function carrySheet() {
  const list = carryTasks();
  if (!list.length) {
    setTimeout(closeSheet);
    return [];
  }
  const today = todayKey();
  const moveAll = () => {
    const moved = list.map((x) => [x.id, x.date]);
    for (const [id] of moved) updateTask(id, { when: { date: today } });
    closeSheet();
    toast(t('movedMany'), { label: t('undo'), run: () => moved.forEach(([id, d]) => updateTask(id, { when: { date: d } })) });
  };
  return [
    sheetHead(t('carryTitle')),
    h('p', { class: 'prose' }, t('carryHint')),
    h(
      'div',
      null,
      list.map((x) =>
        h(
          'div',
          { class: 'carry-item' },
          h(
            'span',
            { class: 'task-text' },
            h('span', { class: 'task-title', dir: 'auto' }, x.title),
            h('span', { class: 'task-meta tnum' }, shortDay(x.date), x.start ? ' · ' : '', x.start ? timeEl(rangeText(x.start, x.end)) : null),
          ),
          h(
            'button',
            { type: 'button', class: 'chip', 'data-k': 'carry-' + x.id, onclick: () => updateTask(x.id, { when: { date: today } }) },
            t('toToday'),
          ),
        ),
      ),
    ),
    h('div', { class: 'sheet-foot' }, h('button', { type: 'button', class: 'btn primary block', 'data-k': 'carry-all', onclick: moveAll }, t('allToToday'))),
  ];
}

// --- Settings sheet -------------------------------------------------------------

const APP_URL = 'https://newsaleh.github.io/TimeBlocking/';
const NEW_REPO_URL = 'https://github.com/new';
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

function recoveryLink() {
  const onOwnSite = !window.claude && /^https?:$/.test(location.protocol);
  const base = onOwnSite ? location.origin + location.pathname : APP_URL;
  return `${base}#pair=${encodePairing(vault.data)}`;
}

async function markRecoverySent() {
  if (vault.data.recoverySent) return;
  vault.data.recoverySent = true;
  await saveVault();
}

function sendButtons() {
  const link = recoveryLink();
  const mark = () => markRecoverySent();
  const mail = `mailto:?subject=${encodeURIComponent(t('recoverySubject'))}&body=${encodeURIComponent(t('recoveryMessage', { link }))}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(t('recoveryTelegram'))}`;
  const copy = h('button', { type: 'button', class: 'btn', 'data-k': 'copyLink' }, t('copyLink'));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      copy.textContent = t('copied');
      mark();
    } catch (_) {
      toast(link, null, 15000);
    }
  });
  const buttons = [
    h('a', { class: 'btn', href: mail, 'data-k': 'sendEmail', onclick: mark }, t('sendEmail')),
    h('a', { class: 'btn', href: tg, target: '_blank', rel: 'noopener noreferrer', 'data-k': 'sendTelegram', onclick: mark }, t('sendTelegram')),
  ];
  if (navigator.share && !window.claude) {
    buttons.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-k': 'share',
          onclick: async () => {
            try {
              await navigator.share({ title: 'Pocket Time', text: t('recoveryTelegram'), url: link });
              mark();
            } catch (_) {}
          },
        },
        t('shareOther'),
      ),
    );
  }
  buttons.push(copy);
  return h('div', { class: 'send-row' }, buttons);
}

function settingsSheet() {
  const s = ui.sheet;
  if (s.sub) return settingsSub(s.sub);
  const status = engine ? engine.status() : { state: 'local' };
  const rows = [];

  const segmented = (label, options, current, pick, prefix) =>
    h(
      'div',
      { class: 'settings-row' },
      h('span', null, label),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': label },
        options.map(([code, text, lang]) =>
          h('button', { type: 'button', lang: lang || null, 'data-k': prefix + code, 'aria-pressed': String(current === code), onclick: () => pick(code) }, text),
        ),
      ),
    );
  rows.push(
    h(
      'div',
      { class: 'field' },
      segmented(t('language'), [['ar', 'العربية', 'ar'], ['en', 'English', 'en']], ui.lang, setLang, 'lang-'),
      segmented(t('appearance'), [['auto', t('themeAuto')], ['light', t('themeLight')], ['dark', t('themeDark')]], ui.theme, setTheme, 'theme-'),
    ),
  );

  rows.push(
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, t('importTitle')),
      h('p', { class: 'prose' }, t('importIntro')),
      h('button', { type: 'button', class: 'btn', 'data-k': 'openImport', onclick: () => openImport('') }, t('importOpen')),
    ),
  );

  const sync = [h('span', { class: 'field-label' }, t('sync'))];
  const remote = vault.remote;
  if (remote && remote.kind === 'github') sync.push(h('p', { class: 'prose', dir: 'auto' }, t('syncGithub', { repo: remote.repo })));
  else if (remote && remote.kind === 'claude') sync.push(h('p', { class: 'prose' }, t('syncClaude')));
  else sync.push(h('p', { class: 'prose' }, t('syncLocal')));
  if (remote && engine && engine.lastSync) {
    const d = new Date(engine.lastSync);
    sync.push(h('p', { class: 'prose tnum' }, t('lastSync', { time: `${nowTime(d)} ${formatDateShort(dayKey(d))}` })));
  }
  const line = statusText();
  if (line) sync.push(h('p', { class: 'prose' }, line));
  if (vault.mismatch || status.state === 'locked') {
    sync.push(h('button', { type: 'button', class: 'btn primary', 'data-k': 'sub-pair', onclick: () => setSub('pair') }, t('haveLink')));
  }
  if (!remote && !vault.mismatch) {
    sync.push(h('button', { type: 'button', class: 'btn primary', 'data-k': 'sub-github', onclick: () => setSub('github') }, t('syncEnable')));
  }
  if (remote && remote.kind === 'github') {
    sync.push(
      h(
        'div',
        { class: 'chips' },
        h('button', { type: 'button', class: 'chip', 'data-k': 'changeToken', onclick: () => setSub('github') }, t('changeToken')),
        h('button', { type: 'button', class: 'chip', 'data-k': 'stopSync', onclick: stopSync }, t('stopSync')),
      ),
    );
  }
  rows.push(h('div', { class: 'field' }, sync));

  rows.push(
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, t('recovery')),
      h('p', { class: 'prose' }, t('recoveryHint')),
      vault.data.recoverySent ? null : h('p', { class: 'note overlap-note' }, t('recoveryNotSent')),
      sendButtons(),
      h('button', { type: 'button', class: 'settings-row link', 'data-k': 'sub-pair2', onclick: () => setSub('pair') }, t('haveLink'), chevron(true)),
    ),
  );

  if (engine) {
    rows.push(
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, t('export')),
        h('p', { class: 'prose' }, t('exportHint')),
        h('button', { type: 'button', class: 'btn', 'data-k': 'export', onclick: exportData }, t('export')),
        h('button', { type: 'button', class: 'settings-row link', 'data-k': 'sub-forget', onclick: () => setSub('forget') }, t('forgetDevice'), chevron(true)),
      ),
    );
  }

  rows.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('privacy')), h('p', { class: 'prose' }, t('privacyText'))));
  return [sheetHead(t('settings')), ...rows];
}

function setSub(sub) {
  ui.sheet.sub = sub;
  ui.sheet.static = true;
  $('sheet').replaceChildren(...settingsSheet());
  $('sheet').scrollTop = 0;
}

function backToSettings() {
  ui.sheet.sub = null;
  ui.sheet.static = false;
  renderSheet(true);
}

function textInput(id, label, opts = {}) {
  const el = h('input', { id, class: 'text-input', type: opts.type || 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', dir: 'ltr', placeholder: opts.placeholder || null });
  if (opts.value) el.value = opts.value;
  bindDigitNormalization(el);
  return h('label', null, label, el);
}

function busyButton(btn, fn) {
  return async (e) => {
    if (e) e.preventDefault();
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('working');
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

function normalizeRepo(input) {
  const s = normalizeDigits(String(input || '')).trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function pairForm(onDone) {
  const err = errorLine();
  const area = h('textarea', { id: 'pairInput', class: 'text-input pair-input', rows: '3', dir: 'ltr', spellcheck: 'false', autocapitalize: 'off', placeholder: 'https://…#pair=…' });
  const btn = h('button', { type: 'submit', class: 'btn primary block' }, t('pairButton'));
  const form = h('form', { class: 'gate-inner' }, h('label', null, t('pairLabel'), area), err, btn);
  form.addEventListener(
    'submit',
    busyButton(btn, async () => {
      const p = decodePairing(area.value);
      if (!p) {
        err.textContent = t('pairBad');
        err.hidden = false;
        return;
      }
      await applyPairing(p);
      toast(t('paired'));
      onDone();
    }),
  );
  return form;
}

function settingsSub(sub) {
  const back = h('button', { type: 'button', class: 'text-btn quiet', onclick: backToSettings }, t('back'));
  const err = errorLine();
  const fail = (msg) => {
    err.textContent = msg;
    err.hidden = false;
  };

  if (sub === 'github') {
    const current = vault.data.sync && vault.data.sync.type === 'github' ? vault.data.sync : null;
    const btn = h('button', { type: 'submit', class: 'btn primary block' }, t('connect'));
    const form = h(
      'form',
      { class: 'gate-inner' },
      h(
        'ol',
        { class: 'steps prose' },
        h('li', null, t('githubStep1'), ' ', h('a', { href: NEW_REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, t('githubStep1Link'))),
        h('li', null, t('githubStep2'), ' ', h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, t('githubStep2Link'))),
        h('li', null, t('githubStep3')),
      ),
      textInput('ghRepo', t('repoLabel'), { placeholder: 'newSaleh/pocket-time-data', value: current ? current.repo : '' }),
      textInput('ghToken', t('tokenLabel'), { type: 'password', placeholder: 'github_pat_…' }),
      err,
      btn,
    );
    form.addEventListener(
      'submit',
      busyButton(btn, async () => {
        const repo = normalizeRepo($('ghRepo').value);
        const token = $('ghToken').value.trim() || (current && current.repo === repo ? current.token : '');
        if (!repo) return fail(t('errRepo'));
        if (!token) return fail(t('errToken'));
        try {
          const remote = githubRemote({ repo, token });
          const result = await remote.ensureVault(vault.data.kid);
          if (result === 'mismatch') {
            fail(t('repoHasVault'));
            err.after(h('button', { type: 'button', class: 'btn block', onclick: () => setSub('pair') }, t('haveLink')));
            return;
          }
          vault.data.sync = { type: 'github', repo, token };
          await saveVault();
          attachRemote(remote, true);
          setSub('syncReady');
        } catch (e) {
          const code = e && e.code;
          fail(code === 'auth' ? t('errToken') : code === 'not_found' ? t('errRepo') : code === 'public_repo' ? t('errPublic') : t('errNetwork'));
        }
      }),
    );
    return [sheetHead(t('githubTitle'), back), form];
  }

  if (sub === 'syncReady') {
    return [
      sheetHead(t('syncReadyTitle')),
      h('div', { class: 'gate-inner' }, h('p', { class: 'prose' }, t('syncReadyBody')), sendButtons()),
    ];
  }

  if (sub === 'pair') {
    return [sheetHead(t('pairTitle'), back), h('p', { class: 'prose' }, t('pairHint')), pairForm(closeSheet)];
  }

  // forget this device
  const btn = h('button', { type: 'button', class: 'btn primary block' }, t('forgetConfirm'));
  btn.addEventListener(
    'click',
    busyButton(btn, async () => {
      if (engine) {
        await engine.flush();
        if (engine.remote && engine.dirty.size) return fail(t('lockPending'));
        engine.stop();
      }
      await store.clear();
      prefs.set('draft', '');
      input().value = '';
      engine = null;
      vault.remote = null;
      vault.data = null;
      closeSheet();
      boot();
    }),
  );
  return [sheetHead(t('forgetDevice'), back), h('div', { class: 'gate-inner' }, h('p', { class: 'prose' }, t('forgetHint')), err, btn)];
}

async function exportData() {
  if (!engine) return;
  const data = JSON.stringify({ app: 'Pocket Time', exported: new Date().toISOString(), tasks: engine.exportPlain() }, null, 2);
  const filename = `pocket-time-${todayKey()}.json`;
  if (vault.downloads) {
    try {
      const res = await vault.downloads.save({ filename, data });
      if (res && res.status === 'saved') toast(t('exportDone'));
    } catch (_) {}
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(t('exportDone'));
}

function applyTheme() {
  const root = document.documentElement;
  if (ui.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = ui.theme;
}

function setTheme(code) {
  ui.theme = code;
  prefs.set('theme', code === 'auto' ? '' : code);
  applyTheme();
  renderSheet(true);
}

// --- Import from Reminders ------------------------------------------------------

const SHORTCUT_URL = 'https://newsaleh.github.io/TimeBlocking/shortcut/Pocket%20Time.shortcut';

function openImport(text) {
  if (ui.sheet) closeSheet();
  const hour = new Date().getHours();
  const sheet = { text, target: addDays(todayKey(), hour >= 15 ? 1 : 0), picks: {} };
  followPastedDate(sheet);
  openSheet('import', sheet);
}

// Text from the Shortcut carries dates. If it has tasks for only one of
// today and tomorrow, switch to that day.
function followPastedDate(s) {
  const today = todayKey();
  const tomorrow = addDays(today, 1);
  const dates = new Set(parseImportLines(s.text, today).map((it) => it.date).filter(Boolean));
  const near = [today, tomorrow].filter((d) => dates.has(d));
  if (near.length === 1) s.target = near[0];
}

// Tasks imported before are remembered on this device, so importing the
// same day again never brings them back, even after they were deleted here.
const importKey = (date, title) => `${date}|${normalizeDigits(title).replace(/\s+/g, ' ').trim().toLowerCase()}`;

function importedBefore() {
  try {
    return new Set(JSON.parse(prefs.get('imported') || '[]'));
  } catch (_) {
    return new Set();
  }
}

function rememberImported(keys) {
  const all = [...importedBefore(), ...keys];
  prefs.set('imported', JSON.stringify(all.slice(-2000)));
}

// Returns the lines worth importing plus how many were left out because the
// task is already in Pocket Time (repeating ones included) or was imported before.
function importItems() {
  const s = ui.sheet;
  const items = parseImportLines(s.text, todayKey());
  const before = importedBefore();
  const known = new Map();
  const isKnown = (date, title) => {
    if (!known.has(date)) {
      const { scheduled, anytime } = dayTasks(date);
      known.set(date, new Set([...scheduled, ...anytime].map((x) => importKey(date, x.title))));
    }
    const key = importKey(date, title);
    return known.get(date).has(key) || before.has(key);
  };
  // Text from the Shortcut has dates: then only the chosen day is shown.
  const dated = items.some((it) => it.date);
  const seen = new Set();
  const out = [];
  let skipped = 0;
  items.forEach((it, i) => {
    if (dated && it.date !== s.target) return;
    const date = it.date || s.target;
    const id = importKey(date, it.title);
    if (seen.has(id) || isKnown(date, it.title)) {
      skipped++;
      return;
    }
    seen.add(id);
    const key = `${i}|${it.title}`;
    out.push({ ...it, date, id, key, on: key in s.picks ? s.picks[key] : true });
  });
  out.sort((a, b) => (a.start || '99').localeCompare(b.start || '99'));
  out.skipped = skipped;
  return out;
}

function renderImportSheet(first) {
  const s = ui.sheet;
  if (first) {
    const area = h('textarea', { id: 'importText', class: 'text-input pair-input', rows: '6', dir: 'auto', spellcheck: 'false', placeholder: '2026-10-16 09:00 …', 'data-autofocus': s.text ? null : true });
    area.value = s.text;
    bindDigitNormalization(area);
    area.addEventListener('input', () => {
      s.text = area.value;
      s.picks = {};
      followPastedDate(s);
      refreshImport();
    });
    const tools = [];
    if (navigator.clipboard && navigator.clipboard.readText) {
      tools.push(
        h(
          'button',
          {
            type: 'button',
            class: 'chip',
            'data-k': 'importPaste',
            onclick: async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (text) {
                  area.value = text;
                  area.dispatchEvent(new Event('input'));
                }
              } catch (_) {
                area.focus();
              }
            },
          },
          t('importPaste'),
        ),
      );
    }
    $('sheet').replaceChildren(
      sheetHead(t('importTitle')),
      h('div', { class: 'field' }, h('p', { class: 'prose' }, t('importHint')), area, tools.length ? h('div', { class: 'chips' }, tools) : null),
      h('div', { id: 'importDynamic' }),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, t('shortcutTitle')),
        h('p', { class: 'prose' }, t('shortcutHint')),
        h('a', { class: 'btn', href: SHORTCUT_URL, 'data-k': 'getShortcut', target: '_blank', rel: 'noopener' }, t('shortcutGet')),
      ),
      h(
        'details',
        { class: 'field how' },
        h('summary', null, t('importHowTitle')),
        h('ol', { class: 'steps prose', dir: 'auto' }, t('importSteps').split('\n').map((x) => h('li', null, x))),
      ),
    );
  }
  refreshImport();
}

function refreshImport() {
  const s = ui.sheet;
  const box = $('importDynamic');
  if (!s || !box) return;
  const items = importItems();
  const today = todayKey();
  const chosen = items.filter((x) => x.on);
  const targetChips = [
    [today, t('today')],
    [addDays(today, 1), t('tomorrow')],
  ].map(([key, label]) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        'data-k': 'importFor-' + key,
        'aria-pressed': String(s.target === key),
        onclick: () => {
          s.target = key;
          s.picks = {};
          refreshImport();
        },
      },
      label,
    ),
  );
  const list = items.map((it) => {
    const box = h('input', { type: 'checkbox', 'data-k': 'pick-' + it.key });
    box.checked = it.on;
    box.addEventListener('change', () => {
      s.picks[it.key] = box.checked;
      refreshImport();
    });
    return h(
      'label',
      { class: 'carry-item import-item' },
      box,
      h(
        'span',
        { class: 'task-text' },
        h('span', { class: 'task-title', dir: 'auto' }, it.title),
        h(
          'span',
          { class: 'task-meta tnum' },
          shortDay(it.date),
          it.start ? ' · ' : '',
          it.start ? timeEl(rangeText(it.start, it.end)) : null,
        ),
      ),
    );
  });
  const add = h('button', { type: 'button', class: 'btn primary block', 'data-k': 'importAdd', disabled: !chosen.length }, t('importAdd', { n: chosen.length }));
  add.addEventListener('click', () => {
    if (!engine) return;
    for (const it of chosen) engine.create({ title: it.title, date: it.date, start: it.start, end: it.end });
    rememberImported(chosen.map((it) => it.id));
    const target = s.target;
    closeSheet();
    goTo(target);
    toast(t('imported', { n: chosen.length }));
  });
  box.replaceChildren(
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('importFor')), h('div', { class: 'chips' }, targetChips)),
    items.length ? h('div', { class: 'field' }, list) : null,
    items.skipped ? h('p', { class: 'note', 'data-k': 'importSkipped' }, t('importSkipped', { n: items.skipped })) : null,
    h('div', { class: 'sheet-foot' }, add),
  );
}

// "...#import=<lines>" from an iPhone Shortcut opens the import screen.
function importFromAddress() {
  const m = location.hash.match(/[#&]import=([^&]*)/);
  if (!m) return false;
  let text = '';
  try {
    text = decodeURIComponent(m[1]);
  } catch (_) {}
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch (_) {}
  openImport(text);
  return true;
}

function setLang(code) {
  ui.lang = code;
  prefs.set('lang', code);
  applyLang();
  render();
}

// ---------------------------------------------------------------------------
// Full-screen notice: only when this device meets synced tasks it cannot read.

function showGate(...kids) {
  const gate = $('gate');
  gate.replaceChildren(h('div', { class: 'gate-inner' }, h('span', { class: 'brand' }, t('appName')), ...kids));
  gate.hidden = false;
}

function hideGate() {
  $('gate').hidden = true;
  $('gate').replaceChildren();
}

function errorLine() {
  return h('p', { class: 'error', role: 'alert', hidden: true });
}

function gatePair() {
  showGate(
    h('h1', null, t('mismatchTitle')),
    h('p', { class: 'prose' }, t('mismatchBody')),
    pairForm(hideGate),
    h('button', { type: 'button', class: 'link', onclick: hideGate }, t('continueLocal')),
  );
}

// ---------------------------------------------------------------------------
// Vault lifecycle

async function getDeviceId() {
  let id = await store.get('kv', 'deviceId');
  if (!id) {
    id = randomId(10);
    await store.put('kv', 'deviceId', id);
  }
  return id;
}

async function saveVault() {
  await store.put('kv', 'vault', vault.data);
}

async function startEngine(dek, kid) {
  const deviceId = await getDeviceId();
  if (engine) engine.stop();
  engine = new SyncEngine({ store, remote: null, dek, kid, deviceId, onKeyMismatch: render });
  await engine.load();
  engine.onChange(render);
  render();
}

function attachRemote(remote, uploadAll = false) {
  vault.remote = remote;
  vault.mismatch = false;
  if (!engine) return;
  engine.stop();
  engine.remote = remote;
  engine.flushDelay = remote.kind === 'github' ? 1500 : 300;
  engine.failures = 0;
  engine.lastError = null;
  if (uploadAll) for (const id of engine.buckets.keys()) engine.dirty.add(id);
  engine.start();
  render();
}

function stopSync() {
  vault.data.sync = null;
  saveVault();
  if (engine) {
    engine.stop();
    engine.remote = null;
  }
  vault.remote = null;
  renderSheet(true);
  render();
}

// Joins the vault in a recovery link. Tasks already on this device are kept:
// they are re-encrypted with the joined vault's key and merged into it.
async function applyPairing(p) {
  const same = vault.data && vault.data.kid === p.kid;
  const sync = p.sync || (same ? vault.data.sync : null);
  if (!same && engine) await engine.adoptKey(await importVaultKey(p.key), p.kid, null);
  vault.data = { key: p.key, kid: p.kid, sync, recoverySent: true };
  await saveVault();
  if (!engine) await startEngine(await importVaultKey(p.key), p.kid);
  vault.mismatch = false;
  hideGate();
  await connectSync(true);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function connectClaude() {
  const c = window.claude;
  if (!c || typeof c.use !== 'function') return null;
  try {
    const [db, user, downloads] = await withTimeout(
      Promise.all([c.use('db'), c.use('user'), c.use('downloads').catch(() => null)]),
      12000,
    ).then((r) => r || [null, null, null]);
    vault.downloads = downloads || null;
    if (!db || !user) return null;
    const uid = await user.id();
    return uid ? { db, uid } : null;
  } catch (_) {
    return null;
  }
}

// Picks the sync server: the user's GitHub repository when set up, otherwise
// the claude.ai database when the page runs inside claude.ai.
async function connectSync(uploadAll = false) {
  const cfg = vault.data && vault.data.sync;
  let remote = null;
  if (cfg && cfg.type === 'github') remote = githubRemote({ repo: cfg.repo, token: cfg.token });
  else {
    const conn = await connectClaude();
    if (conn) remote = claudeRemote(conn.db, conn.uid);
  }
  if (!remote) return;
  let result = null;
  try {
    result = await remote.ensureVault(vault.data.kid);
  } catch (e) {
    // Offline or a server hiccup: the vault was checked when sync was set up.
    if (remote.kind === 'claude') return;
  }
  if (result === 'mismatch') {
    vault.mismatch = true;
    render();
    if (engine && engine.tasks().length === 0) gatePair();
    return;
  }
  attachRemote(remote, uploadAll || result === 'created');
}

async function boot() {
  hideGate();
  if (!store) {
    try {
      store = await openIdbStore();
    } catch (_) {
      store = memoryStore();
      storageWarning = true;
    }
  }
  let data = await store.get('kv', 'vault').catch(() => null);
  const legacy = data && !data.key && data.dek ? data : null;
  if (!data || !data.key) {
    data = { ...newVault(), sync: null, recoverySent: false };
    await store.put('kv', 'vault', data);
  }
  vault.data = data;

  if (legacy) {
    // Data from the earlier passphrase version: re-encrypt it with the new key.
    await startEngine(legacy.dek, legacy.kid);
    await engine.adoptKey(await importVaultKey(data.key), data.kid, null);
  } else {
    await startEngine(await importVaultKey(data.key), data.kid);
  }

  if (await pairFromAddress()) return;
  importFromAddress();
  await connectSync(false);
}

// A recovery link opened in this tab ("...#pair=..."): join that vault and
// take the secret out of the address bar right away.
async function pairFromAddress() {
  const pairing = /[#&]pair=/.test(location.hash) ? decodePairing(location.hash) : null;
  if (!pairing) return false;
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch (_) {}
  await applyPairing(pairing);
  toast(t('paired'));
  return true;
}

function registerServiceWorker() {
  if (window.claude || !('serviceWorker' in navigator)) return;
  if (!/^https:$/.test(location.protocol) && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register(DAY_VIEW ? '../sw.js' : 'sw.js').catch(() => {});
}

// ---------------------------------------------------------------------------
// Global interactions

function setupEvents() {
  $('prevBtn').addEventListener('click', () => goTo(addDays(ui.day, -1)));
  $('nextBtn').addEventListener('click', () => goTo(addDays(ui.day, 1)));
  $('todayBtn').addEventListener('click', () => goTo(todayKey()));
  $('settingsBtn').addEventListener('click', () => openSheet('settings'));
  $('dayTitle').addEventListener('click', () => {
    ui.pickerMonth = ui.day.slice(0, 7);
    openSheet('calendar');
  });
  $('backdrop').addEventListener('click', closeSheet);
  if (DAY_VIEW) setupGridEvents();
  // Long press (or right click) on a task: ask, then delete.
  const list = $('list');
  let pressTimer = null;
  let pressAt = null;
  let pressed = false;
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li.task');
    if (!li || e.button > 0) return;
    pressed = false;
    pressAt = { x: e.clientX, y: e.clientY };
    cancelPress();
    pressTimer = setTimeout(() => {
      pressed = true;
      openSheet('confirmDelete', { id: li.dataset.id });
    }, 550);
  });
  list.addEventListener('pointermove', (e) => {
    if (pressTimer && pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) cancelPress();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) list.addEventListener(type, cancelPress);
  list.addEventListener(
    'click',
    (e) => {
      if (!pressed) return;
      pressed = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  list.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li.task');
    if (!li) return;
    e.preventDefault();
    cancelPress();
    if (!ui.sheet) openSheet('confirmDelete', { id: li.dataset.id });
  });

  // A tap on empty space in the day goes straight to writing a new task.
  $('main').addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, textarea, label, li.task')) return;
    if (window.getSelection && String(window.getSelection())) return;
    input().focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ui.sheet) {
        e.preventDefault();
        closeSheet();
      } else if (document.activeElement === input()) input().blur();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey || ui.sheet || !$('gate').hidden) return;
    const rtl = ui.lang === 'ar';
    if (e.key === 'n' || e.key === '/') {
      e.preventDefault();
      input().focus();
    } else if (e.key === 'ArrowLeft') {
      goTo(addDays(ui.day, rtl ? 1 : -1));
    } else if (e.key === 'ArrowRight') {
      goTo(addDays(ui.day, rtl ? -1 : 1));
    } else if (e.key === 't') {
      goTo(todayKey());
    }
  });

  // Horizontal swipe on the day page changes day. Edges are left alone so the
  // browser's own back gesture keeps working.
  const main = $('main');
  let sx = null;
  let sy = null;
  main.addEventListener(
    'touchstart',
    (e) => {
      const p = e.touches[0];
      const w = window.innerWidth;
      if (e.touches.length !== 1 || p.clientX < 24 || p.clientX > w - 24) {
        sx = null;
        return;
      }
      sx = p.clientX;
      sy = p.clientY;
    },
    { passive: true },
  );
  main.addEventListener(
    'touchend',
    (e) => {
      if (sx == null || (DAY_VIEW && zoomed())) return;
      const p = e.changedTouches[0];
      const dx = p.clientX - sx;
      const dy = p.clientY - sy;
      sx = null;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      const forward = ui.lang === 'ar' ? dx > 0 : dx < 0;
      goTo(addDays(ui.day, forward ? 1 : -1));
    },
    { passive: true },
  );

  // Keep the app above the iPhone keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      const keyboard = window.innerHeight - vv.height > 120;
      const hgt = keyboard ? `${Math.round(vv.height)}px` : '';
      $('app').style.height = hgt;
      $('sheetLayer').style.height = hgt;
      $('gate').style.height = hgt;
      if (keyboard) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit);
  }

  window.addEventListener('hashchange', async () => {
    if (engine && !(await pairFromAddress())) importFromAddress();
  });
  window.addEventListener('online', () => {
    if (engine) {
      engine.flush();
      engine.refresh();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
    else saveOpenEdits();
  });
  window.addEventListener('pagehide', saveOpenEdits);
  setInterval(tick, 30000);
}

// The page may be closed at any moment on a phone: save half-typed edits.
function saveOpenEdits() {
  flushTitle();
  const notes = $('taskNotes');
  if (notes && ui.sheet && ui.sheet.kind === 'task' && engine) updateTask(ui.sheet.id, { notes: normalizeDigits(notes.value) });
  if (engine) engine.flush();
}

// Minute tick: the "now" line and the day rollover at midnight.
function tick() {
  const today = todayKey();
  if (today !== ui.lastToday) {
    if (ui.day === ui.lastToday) ui.day = today;
    ui.lastToday = today;
  }
  if (engine) {
    engine.flush();
    if (document.visibilityState === 'visible') engine.refresh();
  }
  render();
}

applyLang();
applyTheme();
setupComposer();
setupEvents();
render();
registerServiceWorker();
boot();
