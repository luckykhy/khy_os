'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SOURCE_SECRET,
  decrypt,
  encrypt,
  resolveVersionSourceSecret,
} = require('../../src/services/sourceSnapshotCrypto');

test('version source keys are deterministic and isolated by release version', () => {
  const a = resolveVersionSourceSecret('1.2.3');
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, resolveVersionSourceSecret(' 1.2.3 '));
  assert.notEqual(a, resolveVersionSourceSecret('1.2.4'));
  assert.notEqual(a, DEFAULT_SOURCE_SECRET);
  assert.equal(resolveVersionSourceSecret(''), DEFAULT_SOURCE_SECRET);
});

test('a versioned snapshot decrypts only with its release key', () => {
  const plaintext = Buffer.from('versioned-source-fixture');
  const secret = resolveVersionSourceSecret('1.2.3');
  const encrypted = encrypt(plaintext, secret);
  const header = { crypto: encrypted.crypto };
  assert.deepEqual(decrypt(encrypted.ciphertext, header, secret), plaintext);
  assert.throws(() => decrypt(encrypted.ciphertext, header, DEFAULT_SOURCE_SECRET));
});

test('legacy snapshots still decrypt with the legacy built-in key', () => {
  const plaintext = Buffer.from('legacy-source-fixture');
  const encrypted = encrypt(plaintext, DEFAULT_SOURCE_SECRET);
  assert.deepEqual(decrypt(encrypted.ciphertext, { crypto: encrypted.crypto }, DEFAULT_SOURCE_SECRET), plaintext);
});
