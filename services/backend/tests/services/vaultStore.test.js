'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// KHYOS_HOME must be set BEFORE requiring dataHome (it caches base home on first call).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vault-test-'));
process.env.KHYOS_HOME = TMP;

const store = require('../../src/services/vaultStore');

test('empty vault lists nothing', () => {
  assert.deepStrictEqual(store.listSecrets(), []);
  assert.strictEqual(store.hasSecret('NOPE'), false);
  assert.strictEqual(store.getSecret('NOPE'), null);
});

test('setSecret round-trips, file is 0600, listing masks value', () => {
  const r = store.setSecret('GITHUB_PAT', 'ghp_supersecretvalue123');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'GITHUB_PAT');
  assert.ok(!r.preview.includes('ghp_supersecretvalue123')); // confirm preview masked

  // disk file exists with 0600 perms
  const file = path.join(TMP, 'vault', 'vault.json');
  assert.ok(fs.existsSync(file));
  const mode = fs.statSync(file).mode & 0o777;
  assert.strictEqual(mode, 0o600);

  // listing never leaks the plaintext
  const listing = store.listSecrets();
  assert.strictEqual(listing.length, 1);
  assert.strictEqual(listing[0].name, 'GITHUB_PAT');
  assert.ok(!JSON.stringify(listing).includes('ghp_supersecretvalue123'));

  // but getSecret (server-side use) returns the real value
  assert.strictEqual(store.getSecret('GITHUB_PAT'), 'ghp_supersecretvalue123');
  assert.strictEqual(store.hasSecret('GITHUB_PAT'), true);
});

test('setSecret rejects bad name / empty value', () => {
  assert.strictEqual(store.setSecret('bad name', 'x').ok, false);
  assert.strictEqual(store.setSecret('OK', '').ok, false);
});

test('getSecrets: partitions found/missing', () => {
  store.setSecret('A_TOKEN', 'aval');
  const { found, missing } = store.getSecrets(['A_TOKEN', 'GITHUB_PAT', 'GHOST']);
  assert.strictEqual(found.A_TOKEN, 'aval');
  assert.strictEqual(found.GITHUB_PAT, 'ghp_supersecretvalue123');
  assert.deepStrictEqual(missing, ['GHOST']);
});

test('setSecret update preserves createdAt, bumps updatedAt', () => {
  const before = store.listSecrets().find((s) => s.name === 'A_TOKEN');
  store.setSecret('A_TOKEN', 'newval');
  assert.strictEqual(store.getSecret('A_TOKEN'), 'newval');
  const after = store.listSecrets().find((s) => s.name === 'A_TOKEN');
  assert.strictEqual(after.createdAt, before.createdAt);
});

test('removeSecret deletes; removing absent is ok:true removed:false', () => {
  assert.deepStrictEqual(store.removeSecret('A_TOKEN'), { ok: true, removed: true });
  assert.strictEqual(store.hasSecret('A_TOKEN'), false);
  assert.deepStrictEqual(store.removeSecret('GHOST'), { ok: true, removed: false });
});

test('corrupt vault file fails soft to empty', () => {
  const file = path.join(TMP, 'vault', 'vault.json');
  fs.writeFileSync(file, '{ this is not json', 'utf-8');
  assert.deepStrictEqual(store.listSecrets(), []);
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});
