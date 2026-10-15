// End-to-end encryption with the browser's built-in Web Crypto API only.
//
//   DEK  random AES-GCM-256 key that encrypts all task data.
//   The server stores the DEK only wrapped (encrypted) twice:
//     - by a key derived from the passphrase (PBKDF2-SHA-256, 600k iterations)
//     - by a key derived from a 160-bit recovery code (HKDF-SHA-256)
//   Devices keep the DEK as a non-extractable CryptoKey in IndexedDB.

import { normalizeDigits } from './digits.js';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;
const DEK_AAD = enc.encode('pocket-time/v1/dek');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomId(len = 12) {
  const bytes = randomBytes(len);
  let s = '';
  for (const b of bytes) s += 'abcdefghijkmnpqrstuvwxyz23456789'[b & 31];
  return s;
}

export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The same passphrase must give the same bytes on every keyboard: Unicode
// NFC, Western digits, no stray leading/trailing spaces from autocorrect.
export function normalizePassphrase(pass) {
  return normalizeDigits(String(pass || '').normalize('NFC')).trim();
}

async function passphraseKey(pass, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(normalizePassphrase(pass)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// --- Recovery code -----------------------------------------------------------

export function formatRecoveryCode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

export function parseRecoveryCode(code) {
  const clean = normalizeDigits(String(code || ''))
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '');
  if (clean.length !== 32) return null;
  const out = new Uint8Array(20);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of clean) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) return null;
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

async function recoveryKey(codeBytes, salt) {
  const base = await subtle().importKey('raw', codeBytes, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('pocket-time/v1/recovery') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// --- DEK wrapping ------------------------------------------------------------

async function wrapRaw(rawDek, kek) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: DEK_AAD }, kek, rawDek);
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function unwrapRaw(wrapped, kek) {
  const raw = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromB64(wrapped.iv), additionalData: DEK_AAD },
    kek,
    fromB64(wrapped.ct),
  );
  return new Uint8Array(raw);
}

function importDek(raw) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function wrapWithPassphrase(raw, pass, iterations) {
  const salt = randomBytes(16);
  const kek = await passphraseKey(pass, salt, iterations);
  return { kdf: 'PBKDF2-SHA-256', iter: iterations, salt: toB64(salt), ...(await wrapRaw(raw, kek)) };
}

async function wrapWithRecovery(raw) {
  const code = randomBytes(20);
  const salt = randomBytes(16);
  const kek = await recoveryKey(code, salt);
  return { wrapped: { kdf: 'HKDF-SHA-256', salt: toB64(salt), ...(await wrapRaw(raw, kek)) }, code: formatRecoveryCode(code) };
}

export class WrongSecretError extends Error {
  constructor() {
    super('wrong-secret');
    this.code = 'wrong-secret';
  }
}

async function rawFromPassphrase(keyring, pass) {
  const p = keyring.pass;
  const kek = await passphraseKey(pass, fromB64(p.salt), p.iter);
  try {
    return await unwrapRaw(p, kek);
  } catch (_) {
    throw new WrongSecretError();
  }
}

async function rawFromRecovery(keyring, code) {
  const bytes = parseRecoveryCode(code);
  if (!bytes) throw new WrongSecretError();
  const r = keyring.rec;
  const kek = await recoveryKey(bytes, fromB64(r.salt));
  try {
    return await unwrapRaw(r, kek);
  } catch (_) {
    throw new WrongSecretError();
  }
}

/** Creates a new vault: returns the keyring for the server, the DEK, and the
 *  recovery code to show once. */
export async function createKeyring(pass, iterations = PBKDF2_ITERATIONS) {
  const raw = randomBytes(32);
  const pw = await wrapWithPassphrase(raw, pass, iterations);
  const rec = await wrapWithRecovery(raw);
  const keyring = { v: 1, kid: randomId(10), created: new Date().toISOString(), pass: pw, rec: rec.wrapped };
  const dek = await importDek(raw);
  raw.fill(0);
  return { keyring, dek, recoveryCode: rec.code };
}

export async function unlockWithPassphrase(keyring, pass) {
  const raw = await rawFromPassphrase(keyring, pass);
  const dek = await importDek(raw);
  raw.fill(0);
  return dek;
}

/** Recovery: proves the code, then sets a new passphrase. */
export async function recoverWithCode(keyring, code, newPass, iterations = PBKDF2_ITERATIONS) {
  const raw = await rawFromRecovery(keyring, code);
  const pass = await wrapWithPassphrase(raw, newPass, iterations);
  const dek = await importDek(raw);
  raw.fill(0);
  return { keyring: { ...keyring, pass }, dek };
}

export async function changePassphrase(keyring, oldPass, newPass, iterations = PBKDF2_ITERATIONS) {
  const raw = await rawFromPassphrase(keyring, oldPass);
  const pass = await wrapWithPassphrase(raw, newPass, iterations);
  raw.fill(0);
  return { ...keyring, pass };
}

export async function newRecoveryCode(keyring, pass) {
  const raw = await rawFromPassphrase(keyring, pass);
  const rec = await wrapWithRecovery(raw);
  raw.fill(0);
  return { keyring: { ...keyring, rec: rec.wrapped }, recoveryCode: rec.code };
}

/** A random key for a device that cannot sync (no server keyring). */
export async function createLocalKey() {
  const raw = randomBytes(32);
  const dek = await importDek(raw);
  raw.fill(0);
  return { dek, kid: 'local-' + randomId(8) };
}

// --- Data encryption ---------------------------------------------------------

export async function encryptJSON(dek, kid, value, aad) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    dek,
    enc.encode(JSON.stringify(value)),
  );
  return { v: 1, k: kid, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(dek, envelope, aad) {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromB64(envelope.iv), additionalData: enc.encode(aad) },
    dek,
    fromB64(envelope.ct),
  );
  return JSON.parse(dec.decode(pt));
}
