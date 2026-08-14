'use strict';

/**
 * commitmentTrack.test.js — commitmentTrack 薄壳接线测试。
 *
 * 验证:门控 KHY_COMMITMENT、无 chat 时 enqueueExtraction fail-soft、list/markSent/dismiss/
 * expireOld 空实现不抛、注入 aiChatPort 后端到端提取、_resetForTest 可重置单例。
 * 不 mock aiChatPort(保持壳的 IoC seam 真实);无 chat 即验证 fail-soft 路径。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('commitmentTrack — thin-shell wiring', () => {
  let ct;
  let prevHome;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.KHY_COMMITMENT;
    prevHome = os.homedir;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-commit-'));
    os.homedir = () => tmp;
    process.env.KHY_DATA_HOME = path.join(tmp, '.khy');
    ct = require('../../src/services/commitmentTrack');
  });

  afterEach(() => {
    os.homedir = prevHome;
    delete process.env.KHY_DATA_HOME;
    delete process.env.KHY_COMMITMENT;
    ct._resetForTest();
    try { const { _resetForTest: resetPort } = require('../../src/services/aiChatPort'); resetPort(); } catch { /* ignore */ }
  });

  test('commitmentEnabled: default on; 0/false/off/no off', () => {
    expect(ct.commitmentEnabled({})).toBe(true);
    for (const off of ['0', 'false', 'off', 'no']) {
      expect(ct.commitmentEnabled({ KHY_COMMITMENT: off })).toBe(false);
    }
  });

  test('trackCommitment without a registered chat → enqueues but never extracts (no throw)', async () => {
    const ok = ct.trackCommitment({ userText: 'hello', assistantText: 'hi' });
    expect(ok).toBe(true);
    await ct._flushForTest();
    expect(ct.listCommitments()).toEqual([]);
  }, 8000);

  test('listCommitments / markSent / dismiss / expireOld are safe on empty state', () => {
    expect(ct.listCommitments()).toEqual([]);
    expect(() => ct.markSent('nope')).not.toThrow();
    expect(() => ct.dismiss('nope')).not.toThrow();
    expect(ct.expireOld()).toBe(0);
  });

  test('KHY_COMMITMENT=off → trackCommitment false, list empty', () => {
    process.env.KHY_COMMITMENT = 'off';
    expect(ct.trackCommitment({ userText: 'a', assistantText: 'b' })).toBe(false);
    expect(ct.listCommitments()).toEqual([]);
  });

  test('injectable gateway via aiChatPort works end-to-end (extraction + lifecycle)', async () => {
    const { registerAiChat, _resetForTest: resetPort } = require('../../src/services/aiChatPort');
    const now = Date.now();
    const fakeReply = JSON.stringify({
      candidates: [{
        kind: 'deadline_check',
        sensitivity: 'routine',
        source: 'agent_promise',
        reason: 'user asked for reminder',
        suggestedText: 'Reminder: submit report',
        dedupeKey: 'report-reminder',
        confidence: 0.9,
        dueWindow: {
          earliest: new Date(now + 3600_000).toISOString(),
          latest: new Date(now + 7200_000).toISOString(),
        },
      }],
    });
    registerAiChat(async (prompt, opts) => ({ reply: fakeReply }));
    try {
      const ok = ct.trackCommitment({ userText: 'remind me about report', assistantText: 'sure' });
      expect(ok).toBe(true);
      await ct._flushForTest();
      const all = ct.listCommitments();
      expect(all.length).toBe(1);
      expect(all[0].kind).toBe('deadline_check');
      expect(all[0].status).toBe('pending');
      ct.markSent(all[0].id);
      expect(ct.listCommitments()[0].status).toBe('sent');
    } finally {
      resetPort();
    }
  }, 15000);
});
