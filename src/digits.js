// Every digit shown or stored by the app is a Western digit (0-9), whatever
// the interface language or keyboard. These helpers convert the other digit
// scripts a user can realistically type or paste.

const DIGIT_BASES = [
  0x0660, // Arabic-Indic        ٠١٢٣٤٥٦٧٨٩
  0x06f0, // Extended (Persian)  ۰۱۲۳۴۵۶۷۸۹
  0xff10, // Full-width          ０１２３４５６７８９
];
const NON_WESTERN_DIGITS = /[٠-٩۰-۹０-９٫٬：]/g;

export function normalizeDigits(input) {
  if (input == null) return '';
  return String(input).replace(NON_WESTERN_DIGITS, (ch) => {
    const code = ch.charCodeAt(0);
    if (ch === '٫') return '.'; // Arabic decimal separator
    if (ch === '٬') return ','; // Arabic thousands separator
    if (ch === '：') return ':'; // Full-width colon
    for (const base of DIGIT_BASES) {
      if (code >= base && code <= base + 9) return String(code - base);
    }
    return ch;
  });
}

export function hasNonWesternDigits(input) {
  NON_WESTERN_DIGITS.lastIndex = 0;
  const found = NON_WESTERN_DIGITS.test(String(input || ''));
  NON_WESTERN_DIGITS.lastIndex = 0;
  return found;
}

// Normalizes an <input>/<textarea> in place as the user types or pastes.
// The mapping is one character to one character, so the caret stays put.
export function bindDigitNormalization(el) {
  const apply = () => {
    const value = el.value;
    if (!hasNonWesternDigits(value)) return;
    let start = null;
    let end = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch (_) {
      // Some input types (time, date) don't expose a selection.
    }
    el.value = normalizeDigits(value);
    if (start != null) {
      try {
        el.setSelectionRange(start, end);
      } catch (_) {}
    }
  };
  el.addEventListener('input', (e) => {
    if (e.isComposing) return;
    apply();
  });
  el.addEventListener('compositionend', apply);
  el.addEventListener('change', apply);
  return apply;
}
