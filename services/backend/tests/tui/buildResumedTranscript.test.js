'use strict';

/**
 * buildResumedTranscript — unit coverage for the `khy resume <id>` visible-window
 * replay. When a session is resumed, the transcript was already restored into
 * ai._messages at the process level; this PURE helper projects those messages
 * into the <Static> items the Ink TUI renders, so the user actually SEES the
 * previous conversation instead of an empty shell (the reported bug: resume
 * printed "已恢复" then dropped back to the shell prompt with no window).
 *
 * Only user/assistant turns with plain-string content survive — tool-block /
 * system entries don't render cleanly and aren't needed for the visible replay,
 * because the model context already lives in _messages.
 *
 * Runnable under both jest (describe/test/expect) and `node --test` via the tiny
 * shim below, because this checkout ships no jest binary.
 */

const { buildResumedTranscript } = require('../../src/cli/tui/hooks/useQueryBridge');

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
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeTruthy: () => assert.ok(actual),
  });
}

_describe('buildResumedTranscript', () => {
  _test('returns [] for a non-array / empty input', () => {
    _expect(buildResumedTranscript(null)).toEqual([]);
    _expect(buildResumedTranscript(undefined)).toEqual([]);
    _expect(buildResumedTranscript([])).toEqual([]);
  });

  _test('keeps user + assistant string turns, stamping a fixed timestamp', () => {
    const out = buildResumedTranscript(
      [
        { role: 'user', content: '清理一下 pip 缓存' },
        { role: 'assistant', content: '已执行 pip cache purge，移除 573 个文件。' },
      ],
      1234,
    );
    _expect(out).toEqual([
      { role: 'user', content: '清理一下 pip 缓存', timestamp: 1234, restored: true },
      { role: 'assistant', content: '已执行 pip cache purge，移除 573 个文件。', timestamp: 1234, restored: true },
    ]);
  });

  _test('drops tool-block (array content), system, and blank entries', () => {
    const out = buildResumedTranscript([
      { role: 'system', content: 'you are a helpful assistant' },
      { role: 'user', content: '  ' }, // whitespace-only → dropped
      { role: 'assistant', content: [{ type: 'tool_use', name: 'shellCommand' }] }, // array → dropped
      { role: 'user', content: '真正的问题' }, // kept
      { role: 'tool', content: '[Tool Result] ...' }, // non user/assistant → dropped
    ], 7);
    _expect(out).toEqual([
      { role: 'user', content: '真正的问题', timestamp: 7, restored: true },
    ]);
  });

  _test('marks every item restored:true so the renderer can distinguish replay', () => {
    const out = buildResumedTranscript([{ role: 'user', content: 'hi' }], 1);
    _expect(out.length).toBe(1);
    _expect(out[0].restored).toBe(true);
  });
});
