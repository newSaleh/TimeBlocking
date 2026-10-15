import test from 'node:test';
import assert from 'node:assert/strict';
import { newVault, importVaultKey, encodePairing, decodePairing, encryptJSON, decryptJSON } from '../src/crypto.js';

test('vault key round trip', async () => {
  const v = newVault();
  const dek = await importVaultKey(v.key);
  const env = await encryptJSON(dek, v.kid, { title: 'سرّي' }, 'aad-1');
  const dek2 = await importVaultKey(v.key);
  assert.deepEqual(await decryptJSON(dek2, env, 'aad-1'), { title: 'سرّي' });
});

test('a different vault cannot read the data', async () => {
  const a = newVault();
  const b = newVault();
  const env = await encryptJSON(await importVaultKey(a.key), a.kid, { x: 1 }, 'x');
  await assert.rejects(decryptJSON(await importVaultKey(b.key), env, 'x'));
});

test('the working key cannot be exported', async () => {
  const dek = await importVaultKey(newVault().key);
  assert.equal(dek.extractable, false);
});

test('ciphertext is bound to its document id (AAD) and is tamper-evident', async () => {
  const v = newVault();
  const dek = await importVaultKey(v.key);
  const env = await encryptJSON(dek, v.kid, { title: 'x' }, 'bucket-1');
  await assert.rejects(decryptJSON(dek, env, 'bucket-2'));
  const bytes = Buffer.from(env.ct, 'base64');
  bytes[0] ^= 1;
  await assert.rejects(decryptJSON(dek, { ...env, ct: bytes.toString('base64') }, 'bucket-1'));
});

test('recovery link carries key, id and sync settings', () => {
  const v = newVault();
  const sync = { type: 'github', repo: 'me/pocket-data', token: 'github_pat_ABC' };
  const code = encodePairing({ ...v, sync });
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  const link = `https://newsaleh.github.io/TimeBlocking/#pair=${code}`;
  for (const input of [link, `#pair=${code}`, code, ` ${link}\n`]) {
    assert.deepEqual(decodePairing(input), { key: v.key, kid: v.kid, sync });
  }
  assert.deepEqual(decodePairing(encodePairing(v)), { key: v.key, kid: v.kid, sync: null });
});

test('bad recovery input is rejected', () => {
  assert.equal(decodePairing(''), null);
  assert.equal(decodePairing('hello world'), null);
  assert.equal(decodePairing('https://example.com/#pair=AAAAAAAAAAAAAAAAAAAAAAAA'), null);
});
