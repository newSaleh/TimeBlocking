// End-to-end encryption with the browser's built-in Web Crypto API only.
//
// One random AES-GCM-256 "vault key" encrypts all task data. It is created
// on the first device and never sent to the sync server. Other devices get
// it from a recovery link the user sends to themselves (email, Telegram,
// notes...). No passphrase to remember.

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

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

const toB64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);

/** A new vault: raw key (base64, kept on the device) and a public key id. */
export function newVault() {
  return { key: toB64(randomBytes(32)), kid: randomId(10) };
}

/** The usable CryptoKey for a stored raw key. */
export function importVaultKey(keyB64) {
  const raw = fromB64(keyB64);
  if (raw.length !== 32) throw new Error('bad-key');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// --- Recovery / pairing payload -----------------------------------------------
// Everything a new device needs, carried in the URL fragment (never sent to
// any web server): the vault key, its id and, if set, the sync settings.

export function encodePairing({ key, kid, sync }) {
  const payload = { v: 1, k: key, i: kid };
  if (sync && sync.type === 'github') payload.g = { r: sync.repo, t: sync.token };
  return toB64url(btoa(unescape(encodeURIComponent(JSON.stringify(payload)))));
}

/** Accepts a full link, a "#pair=..." fragment or the bare code. */
export function decodePairing(input) {
  let s = String(input || '').trim();
  const m = s.match(/[#&?]pair=([A-Za-z0-9_-]+)/);
  if (m) s = m[1];
  s = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(s)) return null;
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(fromB64url(s)))));
    if (p.v !== 1 || typeof p.k !== 'string' || typeof p.i !== 'string') return null;
    if (fromB64(p.k).length !== 32) return null;
    const out = { key: p.k, kid: p.i, sync: null };
    if (p.g && typeof p.g.r === 'string' && typeof p.g.t === 'string') out.sync = { type: 'github', repo: p.g.r, token: p.g.t };
    return out;
  } catch (_) {
    return null;
  }
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
