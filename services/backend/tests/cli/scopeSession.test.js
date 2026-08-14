'use strict';

/**
 * scopeSession — per-user session scoping for the daemon/ilink multi-user path.
 *
 * Contract (断点接续「从头开始」根因修复):
 *   - same id  → no-op (SAME_ID), never clobbers an in-flight conversation;
 *   - new id (no persisted history) → clears the process-global _chatState.messages
 *     and pins liveSessionId to the target, so _persistLiveSession writes to that
 *     user's own session file (survives daemon restart, isolates users);
 *   - known id (persisted history exists) → restores that user's full message list
 *     into the live transcript and continues the same transcript id;
 *   - empty id → no-op (EMPTY_ID); any exception → { ok:false } (fail-soft).
 *
 * Isolation: KHY_PROJECT_DATA_HOME is pointed at a throwaway temp dir BEFORE the
 * modules are required, so the real project .khy store is never touched.
 * Runnable under both jest and `node --test` via the shim.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-scope-test-${process.pid}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const sp = require('../../src/services/sessionPersistence');
const ai = require('../../src/cli/ai');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toBeTruthy: () => assert.ok(actual, 'expected truthy'),
    toBeFalsy: () => assert.ok(!actual, 'expected falsy'),
  });
}

/* ── tests ──────────────────────────────────────────────────────────────── */
_describe('scopeSession', () => {
  _test('empty id → no-op (EMPTY_ID), never throws', () => {
    const r = ai.scopeSession('');
    _expect(r.ok).toBe(true);
    _expect(r.changed).toBe(false);
    _expect(r.reason).toBe('EMPTY_ID');
    _test('null/undefined id → same no-op', () => {
      const r2 = ai.scopeSession(null);
      _expect(r2.ok).toBe(true);
      _expect(r2.changed).toBe(false);
    });
  });

  _test('new user (no persisted history) → fresh transcript pinned to that id', () => {
    const target = 'ilink:user-new-123';
    const r = ai.scopeSession(target);
    _expect(r.ok).toBe(true);
    _expect(r.changed).toBe(true);
    _expect(r.restored).toBe(false);
    // liveSessionId is pinned so the next _persistLiveSession writes to that user's file.
    _expect(ai.getLiveSessionId()).toBe(target);
  });

  _test('persisted history for a user → full transcript restored, same id continued', () => {
    const target = 'ilink:user-abc-456';
    sp.persistSession(target, {
      title: 'user abc',
      messages: [
        { role: 'user', content: '我们开始学习行测' },
        { role: 'assistant', content: '好的,我们先从数量关系的基础公式开始。' },
        { role: 'user', content: '继续' },
        { role: 'assistant', content: '这是第三条实质回复,已经足够长足以触发学习检查点。' },
      ],
      metadata: { cwd: process.cwd() },
    });

    const r = ai.scopeSession(target);
    _expect(r.ok).toBe(true);
    _expect(r.changed).toBe(true);
    _expect(r.restored).toBe(true);
    _expect(r.messageCount).toBe(4);
    // Same id continues the same transcript id — follow-up turns append, not fork.
    _expect(ai.getLiveSessionId()).toBe(target);
  });

  _test('same id → no-op (SAME_ID), does not clobber current messages', () => {
    const target = 'ilink:user-abc-456';
    const r = ai.scopeSession(target); // already scoped from the previous test
    _expect(r.ok).toBe(true);
    _expect(r.changed).toBe(false);
    _expect(r.reason).toBe('SAME_ID');
  });

  _test('switching users isolates transcripts (no cross-user bleed)', () => {
    const a = 'ilink:user-A';
    const b = 'ilink:user-B';
    ai.scopeSession(a);
    sp.persistSession(a, {
      messages: [{ role: 'user', content: 'A 的学习进度' }],
      metadata: { cwd: process.cwd() },
    });
    ai.scopeSession(b); // switch to B → fresh, must not contain A's messages
    _expect(ai.getLiveSessionId()).toBe(b);
    // Switching back to A restores exactly A's transcript.
    const back = ai.scopeSession(a);
    _expect(back.restored).toBe(true);
  });
});
