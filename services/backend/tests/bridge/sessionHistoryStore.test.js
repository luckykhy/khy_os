'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const oldEnv = { ...process.env };
let tempRoot;
let store;

function _reloadStore() {
  // Drop the bridge sessionHistoryStore so it re-resolves process.env
  // through dataHome (which itself caches via _cached, so also drop it).
  for (const p of [
    '../../src/bridge/sessionHistoryStore',
    '../../src/utils/dataHome',
  ]) {
    try {
      delete require.cache[require.resolve(p)];
    } catch {
      /* ignore */
    }
  }
  const dataHome = require('../../src/utils/dataHome');
  if (typeof dataHome._resetStorageCaches === 'function') {
    dataHome._resetStorageCaches();
  }
  store = require('../../src/bridge/sessionHistoryStore');
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-chat-history-'));
  process.env.KHY_DATA_HOME = path.join(tempRoot, '.khy');
  delete process.env.KHY_APP_HOME;
  _reloadStore();
});

afterEach(() => {
  process.env = { ...oldEnv };
  for (const p of [
    '../../src/bridge/sessionHistoryStore',
    '../../src/utils/dataHome',
  ]) {
    try {
      delete require.cache[require.resolve(p)];
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('loadHistory returns empty doc for a fresh user', () => {
  const doc = store.loadHistory('alice');
  assert.equal(doc.version, store.SCHEMA_VERSION);
  assert.deepEqual(doc.turns, []);
});

test('appendTurn persists a turn and updateTurn patches it', () => {
  const doc1 = store.appendTurn('alice', { id: 't-1', user: 'hi', startedAt: 1000 });
  assert.equal(doc1.turns.length, 1);
  assert.equal(doc1.turns[0].id, 't-1');
  assert.equal(doc1.turns[0].finishedAt, null);

  _reloadStore();
  const reloaded = store.loadHistory('alice');
  assert.equal(reloaded.turns.length, 1);
  assert.equal(reloaded.turns[0].user, 'hi');

  const ok = store.updateTurn('alice', 't-1', { assistant: 'hello back', finishedAt: 2000 });
  assert.equal(ok, true);

  _reloadStore();
  const finalDoc = store.loadHistory('alice');
  assert.equal(finalDoc.turns[0].assistant, 'hello back');
  assert.equal(finalDoc.turns[0].finishedAt, 2000);
  assert.equal(finalDoc.turns[0].cancelled, false);
});

test('updateTurn marks cancelled=true when patched', () => {
  store.appendTurn('alice', { id: 't-c', user: 'abort me' });
  const ok = store.updateTurn('alice', 't-c', { cancelled: true, finishedAt: 9999 });
  assert.equal(ok, true);
  const reloaded = store.loadHistory('alice');
  assert.equal(reloaded.turns[0].cancelled, true);
});

test('updateTurn returns false for unknown turnId (no throw)', () => {
  store.appendTurn('alice', { id: 't-x', user: 'hi' });
  const ok = store.updateTurn('alice', 'nope', { assistant: 'no' });
  assert.equal(ok, false);
});

test('appendTurn caps the per-user ring at MAX_TURNS_PER_USER (FIFO)', () => {
  const N = store.MAX_TURNS_PER_USER + 5;
  for (let i = 0; i < N; i++) {
    store.appendTurn('alice', { id: 't-' + i, user: 'msg ' + i });
  }
  const reloaded = store.loadHistory('alice');
  assert.equal(reloaded.turns.length, store.MAX_TURNS_PER_USER);
  assert.equal(reloaded.turns[0].id, 't-5');
  assert.equal(reloaded.turns[reloaded.turns.length - 1].id, 't-' + (N - 1));
});

test('safeUserId sanitizes path-traversal characters', () => {
  assert.equal(store._safeUserId('../etc/passwd'), '.._etc_passwd');
  assert.equal(store._safeUserId('a/b\\c:d*e?f'), 'a_b_c_d_e_f');
  assert.equal(store._safeUserId(''), 'anon');
  assert.equal(store._safeUserId('real-user_42.ok'), 'real-user_42.ok');
});

test('appendTurn with missing id is a no-op (returns current doc, no crash)', () => {
  const before = store.loadHistory('alice');
  const after = store.appendTurn('alice', { user: 'no id' });
  assert.deepEqual(after.turns, before.turns);
});
