import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeyring, unlockWithPassphrase, recoverWithCode, changePassphrase, newRecoveryCode,
  encryptJSON, decryptJSON, parseRecoveryCode, formatRecoveryCode, randomBytes, WrongSecretError, PBKDF2_ITERATIONS,
} from '../src/crypto.js';

const FAST = 1000;

test('keyring round trip with passphrase (Arabic digits typed on another keyboard)', async () => {
  const { keyring, dek, recoveryCode } = await createKeyring('رحلة 2026 قمر شاي', FAST);
  assert.equal(typeof recoveryCode, 'string');
  const env = await encryptJSON(dek, keyring.kid, { title: 'سرّي' }, 'aad-1');
  const dek2 = await unlockWithPassphrase(keyring, '  رحلة ٢٠٢٦ قمر شاي ');
  assert.deepEqual(await decryptJSON(dek2, env, 'aad-1'), { title: 'سرّي' });
});

test('default iteration count is 600k', async () => {
  assert.equal(PBKDF2_ITERATIONS, 600000);
  const { keyring } = await createKeyring('correct horse battery staple');
  assert.equal(keyring.pass.iter, 600000);
  assert.equal(keyring.pass.kdf, 'PBKDF2-SHA-256');
});

test('wrong passphrase is rejected', async () => {
  const { keyring } = await createKeyring('good passphrase here', FAST);
  await assert.rejects(unlockWithPassphrase(keyring, 'bad passphrase here'), WrongSecretError);
});

test('keyring holds no usable secret in clear', async () => {
  const pass = 'my secret passphrase';
  const { keyring } = await createKeyring(pass, FAST);
  const json = JSON.stringify(keyring);
  assert.ok(!json.includes(pass));
  assert.deepEqual(Object.keys(keyring).sort(), ['created', 'kid', 'pass', 'rec', 'v']);
});

test('the data key cannot be exported from a device', async () => {
  const { dek } = await createKeyring('whatever passphrase', FAST);
  assert.equal(dek.extractable, false);
  await assert.rejects(globalThis.crypto.subtle.exportKey('raw', dek));
});

test('recovery code resets the passphrase and keeps the data readable', async () => {
  const { keyring, dek, recoveryCode } = await createKeyring('forgotten passphrase', FAST);
  const env = await encryptJSON(dek, keyring.kid, { a: 1 }, 'x');
  const messy = recoveryCode.toLowerCase().replace(/-/g, ' ');
  const { keyring: k2, dek: dek2 } = await recoverWithCode(keyring, messy, 'new passphrase 123', FAST);
  assert.deepEqual(await decryptJSON(dek2, env, 'x'), { a: 1 });
  const dek3 = await unlockWithPassphrase(k2, 'new passphrase 123');
  assert.deepEqual(await decryptJSON(dek3, env, 'x'), { a: 1 });
  await assert.rejects(unlockWithPassphrase(k2, 'forgotten passphrase'), WrongSecretError);
  await assert.rejects(recoverWithCode(keyring, 'AAAA-BBBB', 'x', FAST), WrongSecretError);
});

test('change passphrase and rotate recovery code', async () => {
  const { keyring, dek } = await createKeyring('old passphrase one', FAST);
  const env = await encryptJSON(dek, keyring.kid, [1, 2], 'y');
  const k2 = await changePassphrase(keyring, 'old passphrase one', 'new passphrase two', FAST);
  const { keyring: k3, recoveryCode } = await newRecoveryCode(k2, 'new passphrase two');
  const { dek: d } = await recoverWithCode(k3, recoveryCode, 'third passphrase', FAST);
  assert.deepEqual(await decryptJSON(d, env, 'y'), [1, 2]);
});

test('ciphertext is bound to its document id (AAD) and is tamper-evident', async () => {
  const { keyring, dek } = await createKeyring('passphrase for aad', FAST);
  const env = await encryptJSON(dek, keyring.kid, { title: 'x' }, 'bucket-1');
  await assert.rejects(decryptJSON(dek, env, 'bucket-2'));
  const bytes = Buffer.from(env.ct, 'base64');
  bytes[0] ^= 1;
  await assert.rejects(decryptJSON(dek, { ...env, ct: bytes.toString('base64') }, 'bucket-1'));
});

test('recovery code format', () => {
  const bytes = randomBytes(20);
  const code = formatRecoveryCode(bytes);
  assert.match(code, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  assert.deepEqual(parseRecoveryCode(code), bytes);
  assert.deepEqual(parseRecoveryCode(code.replace(/0/g, 'O').toLowerCase()), bytes);
  assert.equal(parseRecoveryCode('short'), null);
});
