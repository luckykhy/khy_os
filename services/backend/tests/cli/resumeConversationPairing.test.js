'use strict';

/**
 * resumeConversation / autoResumeLastSession — orphan tool_use pairing on the
 * legacy conversations/*.json restore path (Store A).
 *
 * #60 taught the JSONL store (resumePersistedSession) to pair orphan tool_use
 * blocks; #64 makes the older per-folder JSON restore flow symmetric so it can
 * no longer feed a bare tool_use back to the model (which leaks raw tool blocks
 * into user-facing text). This suite asserts the placeholder is injected and
 * that a second pass is idempotent (no stacked duplicates).
 *
 * Isolation: KHY_PROJECT_DATA_HOME + KHYQUANT_PORTABLE_ROOT are pinned to a
 * throwaway temp dir BEFORE any require so getConvoDir() resolves there and the
 * real project conversation store is never touched. Runs under both jest and
 * `node --test` via the shim (no jest binary in this repo).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-resume-json-${process.pid}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHYQUANT_PORTABLE_ROOT = TMP_HOME;

const ai = require('../../src/cli/ai');
const aiSession = require('../../src/cli/aiSession');
const chatState = require('../../src/cli/aiChatState');

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
    toBeTruthy: () => assert.ok(actual, 'expected truthy'),
  });
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function _countPlaceholders(messages, id) {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_result' && b.tool_use_id === id) n += 1;
    }
  }
  return n;
}

/** Write a conversations/*.json snapshot into the isolated convo dir. */
function _writeConvo(file, messages, timestamp) {
  const dir = aiSession.getConvoDir();
  const data = {
    sessionId: file.replace(/\.json$/i, ''),
    timestamp: timestamp || new Date().toISOString(),
    cwd: process.cwd(),
    messages,
    messageCount: messages.length,
  };
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2), 'utf-8');
}

const ORPHAN_MESSAGES = [
  { role: 'user', content: 'read the file' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Reading now.' },
      { type: 'tool_use', id: 'orphan-1', name: 'Read', input: { path: 'a.js' } },
    ],
  },
];

/* ── resumeConversation ─────────────────────────────────────────────────── */

_describe('resumeConversation — orphan tool_use pairing (legacy JSON store)', () => {
  _test('injects exactly one placeholder tool_result for a trailing orphan', () => {
    _writeConvo('orphan-a.json', ORPHAN_MESSAGES);
    const r = ai.resumeConversation('orphan-a.json');
    _expect(r.success).toBe(true);

    const msgs = chatState.messages;
    const last = msgs[msgs.length - 1];
    _expect(last.role).toBe('user');
    _expect(Array.isArray(last.content)).toBe(true);
    _expect(_countPlaceholders(msgs, 'orphan-1')).toBe(1);
  });

  _test('stays idempotent — an already-paired transcript gains no new placeholder', () => {
    // A file that already carries the matching tool_result: pairing is a no-op.
    _writeConvo('paired-a.json', [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan-1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan-1', content: 'ok' }] },
    ]);
    const r = ai.resumeConversation('paired-a.json');
    _expect(r.success).toBe(true);
    _expect(_countPlaceholders(chatState.messages, 'orphan-1')).toBe(1);
  });
});

/* ── autoResumeLastSession ──────────────────────────────────────────────── */

_describe('autoResumeLastSession — orphan tool_use pairing (legacy JSON store)', () => {
  _test('pairs a trailing orphan when auto-resuming the latest conversation', () => {
    // Future-dated filename → guaranteed lexically-latest, so loadLastConversation
    // picks it; timestamp = now → inside the auto-resume window and segment.
    _writeConvo('9999-12-31T23-59-59-auto.json', ORPHAN_MESSAGES, new Date().toISOString());
    const r = ai.autoResumeLastSession();
    _expect(r).toBeTruthy();
    _expect(r.resumed).toBe(true);
    _expect(_countPlaceholders(chatState.messages, 'orphan-1')).toBe(1);
  });
});
