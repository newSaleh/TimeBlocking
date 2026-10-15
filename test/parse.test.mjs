import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from '../src/parse.js';

const TODAY = '2026-10-15'; // Thursday
const p = (s) => parseQuickAdd(s, TODAY);

test('plain text is kept as-is', () => {
  assert.deepEqual(p('شراء هدية'), { title: 'شراء هدية', date: null, start: null, end: null, found: false });
});

test('bare numbers are not times', () => {
  const r = p('اشتر 10 بيضات');
  assert.equal(r.found, false);
  assert.equal(r.title, 'اشتر 10 بيضات');
  assert.equal(p('read 20 pages').found, false);
});

test('time range', () => {
  const r = p('قراءة كتاب 20:00-20:30');
  assert.equal(r.title, 'قراءة كتاب');
  assert.equal(r.start, '20:00');
  assert.equal(r.end, '20:30');
  assert.equal(r.date, null);
});

test('tomorrow + time (Arabic, with tanween variants)', () => {
  for (const word of ['غدًا', 'غداً', 'غدا', 'بكرة']) {
    const r = p(`الاتصال بالمورد ${word} 10:00`);
    assert.equal(r.title, 'الاتصال بالمورد', word);
    assert.equal(r.date, '2026-10-16', word);
    assert.equal(r.start, '10:00', word);
  }
});

test('Arabic-Indic digits in quick add', () => {
  const r = p('رياضة ٨:٣٠ م');
  assert.equal(r.start, '20:30');
  assert.equal(r.title, 'رياضة');
});

test('meridiem forms', () => {
  assert.equal(p('call mom 6pm').start, '18:00');
  assert.equal(p('call mom 6 pm').start, '18:00');
  assert.equal(p('breakfast 7am').start, '07:00');
  assert.equal(p('غداء 2 ظهرا').start, '14:00');
  assert.equal(p('اجتماع 9 صباحًا').start, '09:00');
  assert.equal(p('عشاء 8 مساءً').start, '20:00');
  assert.equal(p('midnight 12am').start, '00:00');
});

test('meridiem does not eat the next word', () => {
  const r = p('10:00 مراجعة العقد');
  assert.equal(r.start, '10:00');
  assert.equal(r.title, 'مراجعة العقد');
});

test('range inherits meridiem from its end', () => {
  const r = p('درس 8-9م');
  assert.equal(r.start, '20:00');
  assert.equal(r.end, '21:00');
  const r2 = p('lunch 11-1pm');
  assert.equal(r2.start, '11:00');
  assert.equal(r2.end, '13:00');
});

test('"at" and "الساعة" make a bare hour a time', () => {
  assert.equal(p('meet Sam at 5').start, '05:00');
  assert.equal(p('موعد الساعة 4').start, '04:00');
  assert.equal(p('موعد الساعة 4').title, 'موعد');
});

test('from ... to ...', () => {
  const r = p('مذاكرة من 9 إلى 11');
  assert.equal(r.start, '09:00');
  assert.equal(r.end, '11:00');
  assert.equal(r.title, 'مذاكرة');
});

test('duration after a start time', () => {
  const r = p('مشي 18:00 لمدة 45 دقيقة');
  assert.equal(r.start, '18:00');
  assert.equal(r.end, '18:45');
  assert.equal(r.title, 'مشي');
  assert.equal(p('run 7:00 for 1h').end, '08:00');
  assert.equal(p('قيلولة 15:00 لمدة نص ساعة').end, '15:30');
});

test('weekdays', () => {
  assert.equal(p('اجتماع الأحد 9:30').date, '2026-10-18');
  assert.equal(p('اجتماع يوم السبت').date, '2026-10-17');
  assert.equal(p('اجتماع الخميس').date, '2026-10-15');
  assert.equal(p('gym on monday 7:00').date, '2026-10-19');
  assert.equal(p('gym on monday 7:00').title, 'gym');
});

test('relative days', () => {
  assert.equal(p('تنظيف بعد غد').date, '2026-10-17');
  assert.equal(p('dentist day after tomorrow 9am').date, '2026-10-17');
  assert.equal(p('dentist tomorrow').date, '2026-10-16');
  assert.equal(p('سباحة اليوم 17:00').date, '2026-10-15');
});

test('numeric dates', () => {
  assert.equal(p('تجديد الجواز 20/11').date, '2026-11-20');
  assert.equal(p('renew 1/2/2027').date, '2027-02-01');
  assert.equal(p('event 31/02').date, null);
});

test('a time alone keeps the text as title', () => {
  const r = p('10:00');
  assert.equal(r.start, '10:00');
  assert.equal(r.title, '10:00');
});

test('invalid times are ignored', () => {
  assert.equal(p('code 25:00').found, false);
  assert.equal(p('x 10:75').found, false);
});

import { parseImportLines } from '../src/parse.js';

test('import: Shortcut lines, plain lines, bullets and Arabic digits', () => {
  const text = [
    '2026-10-16 09:00 تمارين الصباح',
    '2026-10-16 00:05 تشييك التنزيل + أخبار ارسنال',
    '٢٠٢٦-١٠-١٦ ١٥:٠٠ حلاق (Oct/15)',
    '2026-10-17 شراء هدية',
    '• 14:30 مكالمة',
    '○ قراءة كتاب 20:00-20:30',
    '',
    '- فكرة بلا وقت',
  ].join('\n');
  assert.deepEqual(parseImportLines(text, TODAY), [
    { title: 'تمارين الصباح', date: '2026-10-16', start: '09:00', end: null },
    { title: 'تشييك التنزيل + أخبار ارسنال', date: '2026-10-16', start: '00:05', end: null },
    { title: 'حلاق (Oct/15)', date: '2026-10-16', start: '15:00', end: null },
    { title: 'شراء هدية', date: '2026-10-17', start: null, end: null },
    { title: 'مكالمة', date: null, start: '14:30', end: null },
    { title: 'قراءة كتاب', date: null, start: '20:00', end: '20:30' },
    { title: 'فكرة بلا وقت', date: null, start: null, end: null },
  ]);
});
