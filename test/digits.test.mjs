import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDigits, hasNonWesternDigits } from '../src/digits.js';

test('Arabic-Indic digits become Western digits', () => {
  assert.equal(normalizeDigits('١٢٣'), '123');
  assert.equal(normalizeDigits('٠٩:٣٠'), '09:30');
  assert.equal(normalizeDigits('١٥/١٠/٢٠٢٦'), '15/10/2026');
});

test('Persian and full-width digits are normalized too', () => {
  assert.equal(normalizeDigits('۱۲۳۴'), '1234');
  assert.equal(normalizeDigits('１２：３０'), '12:30');
});

test('Arabic separators are normalized, text is untouched', () => {
  assert.equal(normalizeDigits('٣٫٥'), '3.5');
  assert.equal(normalizeDigits('قراءة كتاب ٢٠:٠٠'), 'قراءة كتاب 20:00');
  assert.equal(normalizeDigits('مرحبا، أهلا'), 'مرحبا، أهلا');
  assert.equal(normalizeDigits(null), '');
});

test('detection', () => {
  assert.equal(hasNonWesternDigits('abc 123'), false);
  assert.equal(hasNonWesternDigits('١'), true);
  assert.equal(hasNonWesternDigits('١'), true); // regex state does not leak
});
