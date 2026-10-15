// Local, private quick-add parsing: "قراءة كتاب 20:00-20:30",
// "الاتصال بالمورد غدًا 10:00", "call mom tomorrow 6pm".
// Nothing leaves the device. The result is only a suggestion: the user can
// dismiss it and save the text exactly as typed.

import { normalizeDigits } from './digits.js';
import { addDays, dayKey, keyToDate, isDayKey, fromMinutes, toMinutes, diffDays } from './dates.js';

const PRE = '(^|[\\s(\\[،,؛;])';
const END = '(?=$|[\\s,.،؛;!?)\\]])';
const MER =
  'صباحاً|صباحًا|صباحا|صباح|مساءً|مساءا|مساء|ظهراً|ظهرًا|ظهرا|ظهر|ليلاً|ليلًا|ليلا|ص|م|a\\.m\\.|p\\.m\\.|am|pm|a|p';
const TIME = `(\\d{1,2})(?::(\\d{2}))?\\s*(${MER})?`;
const RANGE_SEP = '\\s*(?:-|–|—|إلى|الى|لين|حتى|to|until|till)\\s*';

const RE_RANGE = new RegExp(`${PRE}(?:(من|from)\\s+)?${TIME}${RANGE_SEP}${TIME}${END}`, 'giu');
const RE_SINGLE = new RegExp(`${PRE}(?:(الساعة|الساعه|at|@)\\s*)?${TIME}${END}`, 'giu');
const RE_DURATION = new RegExp(
  `^\\s*(?:لمدة|لمده|for)?\\s*(?:(\\d+(?:\\.\\d+)?)\\s*(دقيقة|دقيقه|دقائق|د|minutes|minute|mins|min|m|ساعات|ساعة|ساعه|س|hours|hour|hrs|hr|h)|(ساعتين|ساعة|ساعه|نصف ساعة|نص ساعة|ربع ساعة))${END}`,
  'iu',
);

const AR_DAYS = { احد: 0, أحد: 0, اثنين: 1, إثنين: 1, أثنين: 1, ثلاثاء: 2, ثلاثا: 2, اربعاء: 3, أربعاء: 3, خميس: 4, جمعة: 5, جمعه: 5, سبت: 6 };
const EN_DAYS = { sunday: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6 };

const RE_REL = [
  [new RegExp(`${PRE}((?:في\\s+)?بعد\\s+(?:غد(?:اً|ًا|ا)?|بكر[ةه]|بكرا))${END}`, 'iu'), 2],
  [new RegExp(`${PRE}((?:the\\s+)?day\\s+after\\s+tomorrow)${END}`, 'iu'), 2],
  [new RegExp(`${PRE}(غد(?:اً|ًا|ا)|بكر[ةه]|بكرا)${END}`, 'iu'), 1],
  [new RegExp(`${PRE}(tomorrow|tmrw|tmr)${END}`, 'iu'), 1],
  [new RegExp(`${PRE}(اليوم|الليلة|الليله)${END}`, 'iu'), 0],
  [new RegExp(`${PRE}(today|tonight)${END}`, 'iu'), 0],
];
const RE_AR_WEEKDAY = new RegExp(
  `${PRE}((?:(?:في\\s+)?يوم\\s+)?ال(${Object.keys(AR_DAYS).join('|')}))${END}`,
  'iu',
);
const RE_EN_WEEKDAY = new RegExp(`${PRE}((?:on\\s+|next\\s+)?(${Object.keys(EN_DAYS).join('|')}))${END}`, 'iu');
const RE_NUM_DATE = new RegExp(`${PRE}((?:في\\s+|on\\s+)?(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?)${END}`, 'iu');

const PM = /^(م|مساء|مساءً|مساءا|ليلا|ليلاً|ليلًا|pm|p\.m\.|p)$/i;
const AM = /^(ص|صباح|صباحا|صباحًا|صباحاً|am|a\.m\.|a)$/i;
const NOON = /^ظهر/;

function to24(h, m, mer) {
  if (m > 59) return null;
  if (!mer) return h <= 23 ? h * 60 + m : null;
  if (h < 1 || h > 12) return null;
  if (PM.test(mer)) return ((h % 12) + 12) * 60 + m;
  if (AM.test(mer)) return (h % 12) * 60 + m;
  if (NOON.test(mer)) return (h <= 4 ? h + 12 : h) * 60 + m;
  return null;
}

// Blank out a matched span, keeping string positions stable.
function blank(work, start, end) {
  return work.slice(0, start) + ' '.repeat(end - start) + work.slice(end);
}

function matchSpan(m) {
  const start = m.index + m[1].length;
  return [start, m.index + m[0].length];
}

function parseRange(work) {
  RE_RANGE.lastIndex = 0;
  let m;
  while ((m = RE_RANGE.exec(work))) {
    const [, , from, h1, m1, mer1, h2, m2, mer2] = m;
    const hasSignal = m1 != null || m2 != null || mer1 || mer2 || from;
    if (!hasSignal) continue;
    let endMin = to24(+h2, m2 ? +m2 : 0, mer2);
    let startMin = to24(+h1, m1 ? +m1 : 0, mer1 || mer2);
    if (!mer1 && mer2 && startMin != null && endMin != null && startMin > endMin) {
      startMin = to24(+h1, m1 ? +m1 : 0, null);
    }
    if (startMin == null || endMin == null) continue;
    return { span: matchSpan(m), start: fromMinutes(startMin), end: fromMinutes(endMin) };
  }
  return null;
}

function parseSingle(work) {
  RE_SINGLE.lastIndex = 0;
  let m;
  while ((m = RE_SINGLE.exec(work))) {
    const [, , at, h, mm, mer] = m;
    // A bare number ("10 eggs") is not a time.
    if (mm == null && !mer && !at) continue;
    // Single letters a/p only count right after digits ("6p"), not "6 a".
    if (mer && /^[ap]$/i.test(mer) && /\s$/.test(m[0].slice(0, m[0].length - 1))) continue;
    const mins = to24(+h, mm ? +mm : 0, mer);
    if (mins == null) continue;
    return { span: matchSpan(m), start: fromMinutes(mins) };
  }
  return null;
}

function parseDuration(rest) {
  const m = RE_DURATION.exec(rest);
  if (!m) return null;
  let mins;
  if (m[3]) {
    mins = { ساعتين: 120, ساعة: 60, ساعه: 60, 'نصف ساعة': 30, 'نص ساعة': 30, 'ربع ساعة': 15 }[m[3]];
  } else {
    const n = parseFloat(m[1]);
    mins = /^(د|دقي|دقا|m)/i.test(m[2]) ? n : n * 60;
  }
  if (!mins || mins <= 0 || mins > 1440) return null;
  return { length: m[0].length, mins: Math.round(mins) };
}

function nextWeekday(fromKey, dow) {
  const d = keyToDate(fromKey).getDay();
  return addDays(fromKey, (dow - d + 7) % 7);
}

function parseDate(work, today) {
  for (const [re, offset] of RE_REL) {
    const m = re.exec(work);
    if (m) return { span: matchSpan(m), date: addDays(today, offset) };
  }
  let m = RE_AR_WEEKDAY.exec(work);
  if (m) {
    const key = m[3].replace(/^ال/, '');
    if (key in AR_DAYS) return { span: matchSpan(m), date: nextWeekday(today, AR_DAYS[key]) };
  }
  m = RE_EN_WEEKDAY.exec(work);
  if (m) {
    const key = m[3].toLowerCase();
    if (key in EN_DAYS) return { span: matchSpan(m), date: nextWeekday(today, EN_DAYS[key]) };
  }
  m = RE_NUM_DATE.exec(work);
  if (m) {
    const d = +m[3];
    const mo = +m[4];
    let y = m[5] ? +m[5] : keyToDate(today).getFullYear();
    if (y < 100) y += 2000;
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (isDayKey(key)) {
      let date = key;
      if (!m[5] && diffDays(today, key) < -180) date = dayKey(new Date(y + 1, mo - 1, d, 12));
      return { span: matchSpan(m), date };
    }
  }
  return null;
}

function tidy(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—,،:؛;]+|[\s\-–—,،:؛;]+$/g, '')
    .replace(/\s+(في|يوم|الساعة|at|on|from|من)$/iu, '')
    .trim();
}

/**
 * @param {string} raw     what the user typed
 * @param {string} today   today's day key, for words like "tomorrow"
 * @returns {{title:string, date:string|null, start:string|null, end:string|null, found:boolean}}
 */
export function parseQuickAdd(raw, today) {
  const text = normalizeDigits(raw || '').replace(/\s+/g, ' ').trim();
  let work = text;
  const result = { title: text, date: null, start: null, end: null, found: false };
  if (!text) return result;

  const date = parseDate(work, today);
  if (date) {
    work = blank(work, ...date.span);
    result.date = date.date;
  }

  const range = parseRange(work);
  if (range) {
    work = blank(work, ...range.span);
    result.start = range.start;
    result.end = range.end;
  } else {
    const single = parseSingle(work);
    if (single) {
      result.start = single.start;
      const dur = parseDuration(work.slice(single.span[1]));
      let spanEnd = single.span[1];
      if (dur) {
        result.end = fromMinutes(toMinutes(single.start) + dur.mins);
        spanEnd += dur.length;
      }
      work = blank(work, single.span[0], spanEnd);
    }
  }

  result.found = Boolean(result.date || result.start);
  if (result.found) {
    const title = tidy(work);
    result.title = title || text;
  }
  return result;
}

// Lines pasted from Reminders (or produced by an iPhone Shortcut), one task
// per line. Understood forms, most specific first:
//   "2026-10-16 09:00 Morning workout"   date + time + title
//   "2026-10-16 Buy a gift"              date + title
//   "09:00 Morning workout"              time + title
//   anything else                        read like the quick-add line
const BULLETS = /^[\s•\-–—*○◯●◦☐☑✓✔▢□]+/;
const pad2i = (n) => String(n).padStart(2, '0');

export function parseImportLines(raw, today) {
  const out = [];
  for (let line of normalizeDigits(raw || '').split(/\r?\n/)) {
    line = line.replace(BULLETS, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    let m = line.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?\s+(.+)$/);
    if (m) {
      const date = `${m[1]}-${pad2i(m[2])}-${pad2i(m[3])}`;
      if (isDayKey(date)) {
        const ok = m[4] != null && +m[4] < 24 && +m[5] < 60;
        out.push({ title: m[6].trim(), date, start: ok ? `${pad2i(m[4])}:${m[5]}` : null, end: null });
        continue;
      }
    }
    m = line.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
    if (m && +m[1] < 24 && +m[2] < 60) {
      out.push({ title: m[3].trim(), date: null, start: `${pad2i(m[1])}:${m[2]}`, end: null });
      continue;
    }
    const p = parseQuickAdd(line, today);
    out.push(p.found ? { title: p.title, date: p.date, start: p.start, end: p.end } : { title: line, date: null, start: null, end: null });
  }
  return out;
}
