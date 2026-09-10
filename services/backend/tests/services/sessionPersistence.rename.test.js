'use strict';
/**
 * sessionPersistence.renameSession �?real-filesystem coverage.
 *
 * �?require 持久化模�?*之前**先把 KHY_PROJECT_DATA_HOME 钉到临时目录�?
 * 让会话写入隔离的 sessions 树，测试结束后整体清理�?
 */
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

describe('Session Persistence rename', () => {
  test('renameSession updates the snapshot title and bumps updatedAt', () => {
      const cwd = process.cwd();
      sp.persistSession('rename-target', {
        title: 'Original',
        model: 'opus',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { cwd },
      });
    
      const before = sp.listPersistedSessions().find(s => s.sessionId === 'rename-target');
      expect(before).toBeTruthy();
      expect(before.title).toBe('Original');
    
      const ok = sp.renameSession('rename-target', '  New Title  ');
      expect(ok).toBe(true);
    
      const after = sp.restoreSession('rename-target');
      expect(after.title).toBe('New Title', 'title is trimmed and updated');
      expect(after.messages.length === 1).toBeTruthy();
  });

  test('renameSession caps the title at 200 chars', () => {
      sp.persistSession('rename-long', {
        title: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { cwd: process.cwd() },
      });
    
      const huge = 'a'.repeat(500);
      expect(sp.renameSession('rename-long', huge)).toBe(true);
    
      const after = sp.restoreSession('rename-long');
      expect(after.title.length).toBe(200);
  });

  test('renameSession returns false for an unknown session', () => {
      expect(sp.renameSession('does-not-exist', 'whatever')).toBe(false);
  });

  test('deleteSession removes snapshot, transcript and de-lists the session', () => {
      sp.persistSession('delete-me', {
        title: 'Doomed',
        messages: [{ role: 'user', content: 'bye' }],
        metadata: { cwd: process.cwd() },
      });
      expect(sp.listPersistedSessions().toBeTruthy().some(s => s.sessionId === 'delete-me'));
    
      const removed = sp.deleteSession('delete-me');
      expect(removed).toBe(true);
      expect(!sp.listPersistedSessions().toBeTruthy().some(s => s.sessionId === 'delete-me'));
      expect(sp.restoreSession('delete-me')).toBe(null);
  });

});

