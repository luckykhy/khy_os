'use strict';

/**
 * sessionPersistence.renameSession — real-filesystem coverage.
 *
 * 在 require 持久化模块**之前**先把 KHY_PROJECT_DATA_HOME 钉到临时目录，
 * 让会话写入隔离的 sessions 树，测试结束后整体清理。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = path.join(os.tmpdir(), `khy-sess-rename-${process.pid}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const sp = require('../../src/services/sessionPersistence');

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('renameSession updates the snapshot title and bumps updatedAt', () => {
  const cwd = process.cwd();
  sp.persistSession('rename-target', {
    title: 'Original',
    model: 'opus',
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { cwd },
  });

  const before = sp.listPersistedSessions().find(s => s.sessionId === 'rename-target');
  assert.ok(before, 'session should be listed before rename');
  assert.strictEqual(before.title, 'Original');

  const ok = sp.renameSession('rename-target', '  New Title  ');
  assert.strictEqual(ok, true);

  const after = sp.restoreSession('rename-target');
  assert.strictEqual(after.title, 'New Title', 'title is trimmed and updated');
  assert.ok(after.messages.length === 1, 'transcript is untouched by rename');
});

test('renameSession caps the title at 200 chars', () => {
  sp.persistSession('rename-long', {
    title: 'x',
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { cwd: process.cwd() },
  });

  const huge = 'a'.repeat(500);
  assert.strictEqual(sp.renameSession('rename-long', huge), true);

  const after = sp.restoreSession('rename-long');
  assert.strictEqual(after.title.length, 200);
});

test('renameSession returns false for an unknown session', () => {
  assert.strictEqual(sp.renameSession('does-not-exist', 'whatever'), false);
});

test('deleteSession removes snapshot, transcript and de-lists the session', () => {
  sp.persistSession('delete-me', {
    title: 'Doomed',
    messages: [{ role: 'user', content: 'bye' }],
    metadata: { cwd: process.cwd() },
  });
  assert.ok(sp.listPersistedSessions().some(s => s.sessionId === 'delete-me'));

  const removed = sp.deleteSession('delete-me');
  assert.strictEqual(removed, true);
  assert.ok(!sp.listPersistedSessions().some(s => s.sessionId === 'delete-me'));
  assert.strictEqual(sp.restoreSession('delete-me'), null);
});
