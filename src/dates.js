// Calendar days are stored as local 'YYYY-MM-DD' keys and times as 'HH:MM'
// (24-hour). Formatting is done by hand or through Intl with the Latin
// numbering system, so no Arabic-Indic digit can reach the screen.

const pad2 = (n) => String(n).padStart(2, '0');

export function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayKey(now = new Date()) {
  return dayKey(now);
}

// Noon avoids daylight-saving edges when doing day arithmetic.
export function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function isDayKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return dayKey(keyToDate(key)) === key;
}

export function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

export function diffDays(a, b) {
  return Math.round((keyToDate(b) - keyToDate(a)) / 86400000);
}

export function formatDateNumeric(key) {
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

export function formatDateShort(key) {
  const [, m, d] = key.split('-');
  return `${d}/${m}`;
}

function intlLocale(lang) {
  return lang === 'ar' ? 'ar-u-nu-latn-ca-gregory' : 'en-GB-u-nu-latn-ca-gregory';
}

export function weekdayName(key, lang, style = 'long') {
  return new Intl.DateTimeFormat(intlLocale(lang), { weekday: style }).format(keyToDate(key));
}

export function monthName(key, lang) {
  return new Intl.DateTimeFormat(intlLocale(lang), { month: 'long' }).format(keyToDate(key));
}

// First day of the week (0 = Sunday ... 6 = Saturday) for the device's
// region, falling back to the usual convention for the interface language.
export function firstDayOfWeek(lang, navigatorLang) {
  try {
    const loc = new Intl.Locale(navigatorLang || (lang === 'ar' ? 'ar' : 'en-US'));
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;
  } catch (_) {}
  return lang === 'ar' ? 6 : 0;
}

export function weekDays(key, firstDay) {
  const d = keyToDate(key);
  const offset = (d.getDay() - firstDay + 7) % 7;
  const start = addDays(key, -offset);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// --- Times -----------------------------------------------------------------

export function isTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

export function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export function addMinutes(t, n) {
  return fromMinutes(toMinutes(t) + n);
}

// Duration in minutes; an end before the start runs past midnight.
export function durationMinutes(start, end) {
  if (!isTime(start) || !isTime(end)) return null;
  let d = toMinutes(end) - toMinutes(start);
  if (d <= 0) d += 1440;
  return d;
}

export function formatDuration(mins, lang) {
  if (mins == null) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const H = lang === 'ar' ? 'س' : 'h';
  const M = lang === 'ar' ? 'د' : 'm';
  if (h && m) return `${h}${H} ${m}${M}`;
  if (h) return `${h}${H}`;
  return `${m}${M}`;
}

export function nowTime(now = new Date()) {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

// Next quarter of an hour after now, used as a default start time.
export function nextQuarter(now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  return fromMinutes(Math.ceil((mins + 1) / 15) * 15);
}
