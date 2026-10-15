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
import { parseQuickAdd } from './parse.js';
import { translator } from './i18n.js';
import { SyncEngine } from './sync.js';
import { openIdbStore, memoryStore } from './storage.js';
import { claudeRemote } from './remote.js';
import {
  createKeyring,
  unlockWithPassphrase,
  recoverWithCode,
  changePassphrase,
  newRecoveryCode,
  createLocalKey,
  normalizePassphrase,
  randomId,
} from './crypto.js';

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
  day: todayKey(),
  lastToday: todayKey(),
  sheet: null,
  picker: null,
  ignoreParse: false,
  lastAdded: null,
};
let t = translator(ui.lang);
let engine = null;
let store = null;
let storageWarning = false;
const vault = { mode: null, uid: null, kid: null, remote: null, db: null, dbChecked: false, downloads: null };

const $ = (id) => document.getElementById(id);

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
  $('daySub').textContent = rel ? `${weekday} ${formatDateNumeric(ui.day)}` : formatDateNumeric(ui.day);
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
  render();
  $('main').scrollTop = 0;
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

function dayTasks(key) {
  const list = engine ? engine.tasks().filter((x) => x.date === key) : [];
  const scheduled = list.filter((x) => x.start).sort((a, b) => a.start.localeCompare(b.start) || a.created - b.created);
  const anytime = list.filter((x) => !x.start).sort((a, b) => a.created - b.created);
  return { scheduled, anytime };
}

function carryTasks() {
  if (!engine) return [];
  const today = todayKey();
  return engine
    .tasks()
    .filter((x) => !x.done && x.date < today && diffDays(x.date, today) <= 14)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''));
}

function taskRow(task, info = {}) {
  const meta = [];
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
        onclick: () => engine.update(task.id, { done: !task.done }),
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
// Status line: quiet unless something needs saying.

let pendingSince = null;
function renderStatus() {
  let text = '';
  if (storageWarning) text = t('statusNoStorage');
  if (engine) {
    const s = engine.status();
    if (s.state === 'syncing') pendingSince = pendingSince || Date.now();
    else pendingSince = null;
    if (s.state === 'locked') text = t('statusLocked');
    else if (vault.mode === 'sync' && !engine.remote && vault.dbChecked) text = t('statusOffline');
    else if (s.state === 'offline') text = t('statusOffline');
    else if (s.state === 'syncing' && (!navigator.onLine || Date.now() - pendingSince > 4000)) {
      text = navigator.onLine ? t('statusSyncing') : t('statusOffline');
    }
  }
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
    renderList();
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
}

// ---------------------------------------------------------------------------
// Composer

const input = () => $('newTask');

function renderComposer() {
  const el = input();
  const ph = ui.day === todayKey() ? t('addPlaceholder') : t('addPlaceholderDay', { day: shortDay(ui.day) });
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
  const id = engine.create({
    title: use ? p.title : text,
    date,
    start: use ? p.start : null,
    end: use ? p.end : null,
  });
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
  else if (first || !s.static) {
    const builders = { settings: settingsSheet, carry: carrySheet, calendar: calendarSheet };
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
  if (value) engine.update(id, { title: value });
  titleTarget = null;
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function renderTaskSheet(first) {
  const id = ui.sheet.id;
  const task = engine && engine.get(id);
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
      const current = engine.get(id);
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
      engine.update(id, { notes: normalizeDigits(notes.value) });
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

  $('taskDynamic').replaceChildren(dateField(task), timeField(task), ...conflictBlocks(task));
  $('taskFoot').replaceChildren(
    h(
      'button',
      {
        type: 'button',
        class: 'text-btn quiet',
        'data-k': 'delete',
        onclick: () => {
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
        onclick: () => engine.update(id, { done: !task.done }),
      },
      t(task.done ? 'markIncomplete' : 'markComplete'),
    ),
  );
}

function moveTask(task, date) {
  if (date === task.date) return;
  const from = task.date;
  engine.update(task.id, { when: { date } });
  if (from === ui.day || date !== ui.day) {
    toast(t('movedTo', { day: shortDay(date) }), { label: t('undo'), run: () => engine.update(task.id, { when: { date: from } }) });
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
    engine.update(task.id, { when: { s: value, e: dur ? addMinutes(value, dur) : task.end } });
  } else {
    engine.update(task.id, { when: { e: value } });
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
              engine.update(task.id, { when: { s, e: null } });
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
            engine.update(task.id, { when: { s: null, e: null } });
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
            onclick: () => engine.update(task.id, { when: { e: addMinutes(task.start, m) } }),
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
              engine.update(task.id, { when: { s: addMinutes(task.start, m), e: task.end ? addMinutes(task.end, m) : null } }),
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
    for (const [id] of moved) engine.update(id, { when: { date: today } });
    closeSheet();
    toast(t('movedMany'), { label: t('undo'), run: () => moved.forEach(([id, d]) => engine.update(id, { when: { date: d } })) });
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
            { type: 'button', class: 'chip', 'data-k': 'carry-' + x.id, onclick: () => engine.update(x.id, { when: { date: today } }) },
            t('toToday'),
          ),
        ),
      ),
    ),
    h('div', { class: 'sheet-foot' }, h('button', { type: 'button', class: 'btn primary block', 'data-k': 'carry-all', onclick: moveAll }, t('allToToday'))),
  ];
}

// --- Settings sheet -------------------------------------------------------------

function settingsSheet() {
  const s = ui.sheet;
  if (s.sub) return securitySub(s.sub);
  const status = engine ? engine.status() : { state: 'local' };
  const rows = [];

  rows.push(
    h(
      'div',
      { class: 'field' },
      h(
        'div',
        { class: 'settings-row' },
        h('span', null, t('language')),
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-label': t('language') },
          [
            ['ar', 'العربية'],
            ['en', 'English'],
          ].map(([code, label]) =>
            h(
              'button',
              { type: 'button', lang: code, 'data-k': 'lang-' + code, 'aria-pressed': String(ui.lang === code), onclick: () => setLang(code) },
              label,
            ),
          ),
        ),
      ),
    ),
  );

  const syncKids = [h('span', { class: 'field-label' }, t('sync')), h('p', { class: 'prose' }, vault.mode === 'sync' ? t('syncOn') : t('syncLocal'))];
  if (vault.mode === 'sync' && engine && engine.lastSync) {
    const d = new Date(engine.lastSync);
    syncKids.push(h('p', { class: 'prose tnum' }, t('lastSync', { time: `${nowTime(d)} ${formatDateShort(dayKey(d))}` })));
  }
  if (vault.mode === 'sync' && status.state !== 'synced') {
    const text = status.state === 'locked' ? t('statusLocked') : status.state === 'offline' || !engine.remote ? t('statusOffline') : t('statusSyncing');
    syncKids.push(h('p', { class: 'prose' }, text));
  }
  if (vault.mode === 'local' && vault.db) {
    syncKids.push(h('button', { type: 'button', class: 'btn primary', 'data-k': 'enableSync', onclick: () => (closeSheet(), startSyncFlow()) }, t('syncEnable')));
  }
  rows.push(h('div', { class: 'field' }, syncKids));

  if (vault.mode === 'sync' && vault.remote) {
    rows.push(
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, t('security')),
        h('button', { type: 'button', class: 'settings-row link', 'data-k': 'sub-pass', onclick: () => setSub('pass') }, t('changePass'), chevron(true)),
        h('button', { type: 'button', class: 'settings-row link', 'data-k': 'sub-rec', onclick: () => setSub('recovery') }, t('newRecovery'), chevron(true)),
        h('button', { type: 'button', class: 'settings-row link', 'data-k': 'sub-lock', onclick: () => setSub('lock') }, t('lockDevice'), chevron(true)),
      ),
    );
  }

  if (vault.downloads && engine) {
    rows.push(
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, t('export')),
        h('p', { class: 'prose' }, t('exportHint')),
        h('button', { type: 'button', class: 'btn', 'data-k': 'export', onclick: exportData }, t('export')),
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
  const f = $('sheet').querySelector('input');
  if (f) f.focus();
}

function backToSettings() {
  ui.sheet.sub = null;
  ui.sheet.static = false;
  renderSheet(true);
}

function passwordInput(id, label, autocomplete) {
  const el = h('input', { id, class: 'text-input', type: 'password', autocomplete, spellcheck: 'false', autocapitalize: 'off', dir: 'auto' });
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

function securitySub(sub) {
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const fail = (msg) => {
    err.textContent = msg;
    err.hidden = false;
  };
  const back = h('button', { type: 'button', class: 'text-btn quiet', onclick: backToSettings }, t('back'));

  if (sub === 'pass') {
    const btn = h('button', { type: 'submit', class: 'btn primary block' }, t('save'));
    const form = h(
      'form',
      { class: 'gate-inner' },
      passwordInput('oldPass', t('oldPass'), 'current-password'),
      passwordInput('newPass1', t('newPass'), 'new-password'),
      passwordInput('newPass2', t('passConfirm'), 'new-password'),
      h('p', { class: 'note' }, t('passTip')),
      err,
      btn,
    );
    form.addEventListener(
      'submit',
      busyButton(btn, async () => {
        const p1 = $('newPass1').value;
        if (normalizePassphrase(p1).length < 10) return fail(t('passTooShort'));
        if (normalizePassphrase(p1) !== normalizePassphrase($('newPass2').value)) return fail(t('passMismatch'));
        try {
          const keyring = await vault.remote.getKeyring();
          const next = await changePassphrase(keyring, $('oldPass').value, p1);
          await vault.remote.saveKeyring(next);
          backToSettings();
          toast(t('passChanged'));
        } catch (e) {
          fail(e && e.code === 'wrong-secret' ? t('wrongPass') : t('errorGeneric'));
        }
      }),
    );
    return [sheetHead(t('changePass'), back), form];
  }

  if (sub === 'recovery') {
    const btn = h('button', { type: 'submit', class: 'btn primary block' }, t('newRecovery'));
    const form = h('form', { class: 'gate-inner' }, passwordInput('recPass', t('passLabel'), 'current-password'), err, btn);
    form.addEventListener(
      'submit',
      busyButton(btn, async () => {
        try {
          const keyring = await vault.remote.getKeyring();
          const { keyring: next, recoveryCode } = await newRecoveryCode(keyring, $('recPass').value);
          await vault.remote.saveKeyring(next);
          $('sheet').replaceChildren(sheetHead(t('recoveryTitle')), recoveryCodeView(recoveryCode, backToSettings));
        } catch (e) {
          fail(e && e.code === 'wrong-secret' ? t('wrongPass') : t('errorGeneric'));
        }
      }),
    );
    return [sheetHead(t('newRecovery'), back), form];
  }

  // lock
  const btn = h('button', { type: 'button', class: 'btn primary block' }, t('lockConfirm'));
  btn.addEventListener(
    'click',
    busyButton(btn, async () => {
      if (engine) {
        await engine.flush();
        if (engine.dirty.size) return fail(t('lockPending'));
        engine.stop();
      }
      await store.clear();
      prefs.set('draft', '');
      input().value = '';
      engine = null;
      closeSheet();
      boot();
    }),
  );
  return [sheetHead(t('lockDevice'), back), h('div', { class: 'gate-inner' }, h('p', { class: 'prose' }, t('lockHint')), err, btn)];
}

async function exportData() {
  if (!vault.downloads || !engine) return;
  try {
    const data = JSON.stringify({ app: 'Pocket Time', exported: new Date().toISOString(), tasks: engine.exportPlain() }, null, 2);
    const res = await vault.downloads.save({ filename: `pocket-time-${todayKey()}.json`, data });
    if (res && res.status === 'saved') toast(t('exportDone'));
  } catch (_) {
    // Declined or unavailable: nothing to do.
  }
}

function setLang(code) {
  ui.lang = code;
  prefs.set('lang', code);
  applyLang();
  render();
}

// ---------------------------------------------------------------------------
// Vault screens (first run on a device)

function showGate(...kids) {
  const gate = $('gate');
  gate.replaceChildren(h('div', { class: 'gate-inner' }, h('span', { class: 'brand' }, t('appName')), ...kids));
  gate.hidden = false;
  const f = gate.querySelector('input');
  if (f) f.focus();
}

function hideGate() {
  $('gate').hidden = true;
  $('gate').replaceChildren();
}

function errorLine() {
  return h('p', { class: 'error', role: 'alert', hidden: true });
}

function langSwitch() {
  const other = ui.lang === 'ar' ? ['en', 'English'] : ['ar', 'العربية'];
  return h(
    'button',
    {
      type: 'button',
      class: 'link',
      lang: other[0],
      onclick: () => {
        setLang(other[0]);
        boot();
      },
    },
    other[1],
  );
}

function gateLoading() {
  showGate(h('p', { class: 'prose' }, t('loading')));
}

function gateNoSync() {
  showGate(
    h('h1', null, t('noSyncTitle')),
    h('p', { class: 'prose' }, t('noSyncBody')),
    h('button', { type: 'button', class: 'btn primary block', onclick: () => location.reload() }, t('retry')),
    h('button', { type: 'button', class: 'btn block', onclick: startLocalVault }, t('useLocal')),
    langSwitch(),
  );
}

function gateSetup() {
  const err = errorLine();
  const btn = h('button', { type: 'submit', class: 'btn primary block' }, t('createVault'));
  const form = h(
    'form',
    { class: 'gate-inner' },
    passwordInput('pass1', t('passLabel'), 'new-password'),
    passwordInput('pass2', t('passConfirm'), 'new-password'),
    h('p', { class: 'note' }, t('passTip')),
    err,
    btn,
  );
  form.addEventListener(
    'submit',
    busyButton(btn, async () => {
      const fail = (m) => ((err.textContent = m), (err.hidden = false));
      const p1 = $('pass1').value;
      if (normalizePassphrase(p1).length < 10) return fail(t('passTooShort'));
      if (normalizePassphrase(p1) !== normalizePassphrase($('pass2').value)) return fail(t('passMismatch'));
      try {
        const { keyring, dek, recoveryCode } = await createKeyring(p1);
        const inForce = await vault.remote.createKeyring(keyring);
        if (inForce.kid !== keyring.kid) {
          // Another device created the vault first: unlock that one instead.
          gateUnlock(inForce);
          return;
        }
        await openVault({ dek, kid: keyring.kid, mode: 'sync' });
        showGate(h('h1', null, t('recoveryTitle')), recoveryCodeView(recoveryCode, hideGate));
      } catch (e) {
        fail(e && e.code === 'busy' ? t('errorBusy') : t('errorGeneric'));
      }
    }),
  );
  showGate(h('h1', null, t('setupTitle')), h('p', { class: 'prose' }, t('setupBody')), form, langSwitch());
}

function recoveryCodeView(code, onDone) {
  const copyBtn = h('button', { type: 'button', class: 'btn' }, t('copy'));
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copyBtn.textContent = t('copied');
    } catch (_) {
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  const codeEl = h('div', { class: 'code', translate: 'no' }, code);
  const box = h('input', { type: 'checkbox', id: 'savedIt' });
  const go = h('button', { type: 'button', class: 'btn primary block', disabled: true, onclick: onDone }, t('begin'));
  box.addEventListener('change', () => (go.disabled = !box.checked));
  return h(
    'div',
    { class: 'gate-inner' },
    h('p', { class: 'prose' }, t('recoveryBody')),
    codeEl,
    copyBtn,
    h('label', { class: 'check-line' }, box, t('savedIt')),
    go,
  );
}

function gateUnlock(keyring) {
  const err = errorLine();
  const btn = h('button', { type: 'submit', class: 'btn primary block' }, t('unlock'));
  const form = h('form', { class: 'gate-inner' }, passwordInput('unlockPass', t('passLabel'), 'current-password'), err, btn);
  form.addEventListener(
    'submit',
    busyButton(btn, async () => {
      try {
        const dek = await unlockWithPassphrase(keyring, $('unlockPass').value);
        await openVault({ dek, kid: keyring.kid, mode: 'sync' });
        hideGate();
      } catch (e) {
        err.textContent = e && e.code === 'wrong-secret' ? t('wrongPass') : t('errorGeneric');
        err.hidden = false;
      }
    }),
  );
  showGate(
    h('h1', null, t('unlockTitle')),
    h('p', { class: 'prose' }, t('unlockBody')),
    form,
    h('button', { type: 'button', class: 'link', onclick: () => gateRecover(keyring) }, t('forgot')),
    langSwitch(),
  );
}

function gateRecover(keyring) {
  const err = errorLine();
  const codeInput = h('input', { id: 'recCode', class: 'text-input tnum', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', dir: 'ltr' });
  bindDigitNormalization(codeInput);
  const btn = h('button', { type: 'submit', class: 'btn primary block' }, t('recover'));
  const form = h(
    'form',
    { class: 'gate-inner' },
    h('label', null, t('recoveryLabel'), codeInput),
    passwordInput('recNew1', t('newPass'), 'new-password'),
    passwordInput('recNew2', t('passConfirm'), 'new-password'),
    err,
    btn,
  );
  form.addEventListener(
    'submit',
    busyButton(btn, async () => {
      const fail = (m) => ((err.textContent = m), (err.hidden = false));
      const p1 = $('recNew1').value;
      if (normalizePassphrase(p1).length < 10) return fail(t('passTooShort'));
      if (normalizePassphrase(p1) !== normalizePassphrase($('recNew2').value)) return fail(t('passMismatch'));
      try {
        const { keyring: next, dek } = await recoverWithCode(keyring, codeInput.value, p1);
        await vault.remote.saveKeyring(next);
        await openVault({ dek, kid: next.kid, mode: 'sync' });
        hideGate();
        toast(t('passChanged'));
      } catch (e) {
        fail(e && e.code === 'wrong-secret' ? t('wrongCode') : t('errorGeneric'));
      }
    }),
  );
  showGate(
    h('h1', null, t('recoverTitle')),
    h('p', { class: 'prose' }, t('recoverBody')),
    form,
    h('button', { type: 'button', class: 'link', onclick: () => gateUnlock(keyring) }, t('back')),
    h('button', { type: 'button', class: 'link', onclick: gateReset }, t('lostBoth')),
  );
}

function gateReset() {
  const err = errorLine();
  const word = h('input', { id: 'resetWord', class: 'text-input', type: 'text', autocomplete: 'off', dir: 'auto' });
  const btn = h('button', { type: 'submit', class: 'btn primary block' }, t('resetConfirm'));
  const form = h('form', { class: 'gate-inner' }, h('label', null, t('resetTypeHint'), word), err, btn);
  form.addEventListener(
    'submit',
    busyButton(btn, async () => {
      if (word.value.trim() !== t('resetWord')) {
        err.textContent = t('resetTypeHint');
        err.hidden = false;
        return;
      }
      try {
        await vault.remote.wipe();
        await store.clear();
        boot();
      } catch (_) {
        err.textContent = t('errorGeneric');
        err.hidden = false;
      }
    }),
  );
  showGate(
    h('h1', null, t('resetTitle')),
    h('p', { class: 'prose' }, t('resetBody')),
    form,
    h('button', { type: 'button', class: 'link', onclick: () => boot() }, t('back')),
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

async function startEngine({ dek, kid, mode }) {
  const deviceId = await getDeviceId();
  if (engine) engine.stop();
  engine = new SyncEngine({
    store,
    remote: mode === 'sync' ? vault.remote : null,
    dek,
    kid,
    deviceId,
    onKeyMismatch: () => {
      render();
      if (vault.remote) vault.remote.getKeyring().then((k) => k && gateUnlock(k));
    },
  });
  vault.mode = mode;
  vault.kid = kid;
  await engine.load();
  engine.onChange(render);
  if (engine.remote) engine.start();
  render();
}

// Saves the key on this device and opens the vault. When a device-only vault
// is joining sync, its tasks are re-encrypted with the synced key.
async function openVault({ dek, kid, mode }) {
  const saved = await store.get('kv', 'vault');
  const joining = engine && vault.mode === 'local' && mode === 'sync';
  if (!joining && saved && saved.kid !== kid) {
    for (const [id] of await store.entries('buckets')) await store.del('buckets', id);
  }
  await store.put('kv', 'vault', { mode, kid, dek, uid: vault.uid });
  if (joining) {
    await engine.adoptKey(dek, kid, vault.remote);
    vault.mode = 'sync';
    vault.kid = kid;
    engine.start();
    render();
    return;
  }
  await startEngine({ dek, kid, mode });
}

async function startLocalVault() {
  const { dek, kid } = await createLocalKey();
  await openVault({ dek, kid, mode: 'local' });
  hideGate();
}

async function startSyncFlow() {
  if (!vault.remote) return;
  try {
    const keyring = await vault.remote.getKeyring();
    if (keyring) gateUnlock(keyring);
    else gateSetup();
  } catch (_) {
    showGate(h('p', { class: 'error' }, t('errorGeneric')), h('button', { type: 'button', class: 'btn primary block', onclick: () => boot() }, t('retry')));
  }
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
  const saved = await store.get('kv', 'vault').catch(() => null);

  // A device that already holds the key opens straight from its local copy;
  // the server connection attaches when it is ready.
  if (saved && saved.dek && saved.kid) {
    vault.uid = saved.uid || null;
    await startEngine({ dek: saved.dek, kid: saved.kid, mode: saved.mode });
  }

  const loadingTimer = setTimeout(() => !saved && gateLoading(), 400);
  const conn = await connectClaude();
  clearTimeout(loadingTimer);
  vault.dbChecked = true;
  vault.db = conn ? conn.db : null;

  if (conn) {
    if (saved && saved.uid && saved.uid !== conn.uid) {
      // A different account on this browser: start clean.
      if (engine) engine.stop();
      engine = null;
      await store.clear();
      return boot();
    }
    vault.uid = conn.uid;
    vault.remote = claudeRemote(conn.db, conn.uid);
  }

  if (saved && saved.dek) {
    if (saved.mode === 'sync' && vault.remote && engine && !engine.remote) {
      engine.remote = vault.remote;
      engine.start();
    }
    render();
    return;
  }

  if (!vault.remote) {
    gateNoSync();
    return;
  }
  startSyncFlow();
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
      if (sx == null) return;
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

  window.addEventListener('online', () => engine && engine.flush());
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
  if (notes && ui.sheet && ui.sheet.kind === 'task' && engine) engine.update(ui.sheet.id, { notes: normalizeDigits(notes.value) });
  if (engine) engine.flush();
}

// Minute tick: the "now" line and the day rollover at midnight.
function tick() {
  const today = todayKey();
  if (today !== ui.lastToday) {
    if (ui.day === ui.lastToday) ui.day = today;
    ui.lastToday = today;
  }
  if (engine) engine.flush();
  render();
}

applyLang();
setupComposer();
setupEvents();
render();
boot();
