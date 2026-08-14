'use strict';

/**
 * resumeLastPersistedSession — selection coverage for the full-fidelity bare
 * `resume` path (Store B / JSONL transcript).
 *
 * Contract:
 *   - with no persisted sessions → { success:false, error:'EMPTY' } (never throws),
 *   - otherwise restores the MOST-RECENT session scoped to the current cwd, with
 *     its FULL message list (not a summary), continuing the same transcript id.
 *
 * Isolation: KHY_PROJECT_DATA_HOME (the var sessionPersistence resolves through
 * getProjectDataHome) is pointed at a throwaway temp dir BEFORE the modules are
 * required, so the real project .khy store is never touched. Runnable under both
 * jest and `node --test` via the shim (no jest binary here).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Redirect all on-disk session storage into an isolated temp dir up front.
const TMP_HOME = path.join(os.tmpdir(), `khy-resume-test-${process.pid}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const sp = require('../../src/services/sessionPersistence');
const ai = require('../../src/cli/ai');
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
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
    toBeTruthy: () => assert.ok(actual, 'expected truthy'),
  });
}

/* ── tests ──────────────────────────────────────────────────────────────── */
_describe('resumeLastPersistedSession', () => {
  _test('returns EMPTY when no sessions are persisted', () => {
    const r = ai.resumeLastPersistedSession();
    _expect(r.success).toBe(false);
    _expect(r.error).toBe('EMPTY');
  });

  _test('restores the most-recent full session for the cwd', () => {
    const cwd = process.cwd();
    // Older session.
    sp.persistSession('sess-old', {
      title: 'old',
      messages: [{ role: 'user', content: 'first old' }],
      metadata: { cwd },
    });
    // Newer session (persisted second → later updatedAt → ranks first).
    sp.persistSession('sess-new', {
      title: 'new',
      messages: [
        { role: 'user', content: 'hello new' },
        { role: 'assistant', content: 'reply new' },
      ],
      metadata: { cwd },
    });

    const r = ai.resumeLastPersistedSession();
    _expect(r.success).toBe(true);
    _expect(r.sessionId).toBe('sess-new');
    _expect(r.messageCount).toBe(2);
    // The live transcript id continues the restored session, so follow-up turns
    // append to the same record rather than forking a fresh one.
    _expect(ai.getLiveSessionId()).toBe('sess-new');
  });
});

/* ── resume tool-block pairing ───────────────────────────────────────────── */

/** Count tool_result blocks carrying `id` across the whole live history. */
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

_describe('resumePersistedSession — orphan tool_use pairing', () => {
  _test('pairs a trailing orphan tool_use and stays idempotent across re-resume', () => {
    const cwd = process.cwd();
    // Transcript interrupted mid-turn: the assistant asked for a tool, the
    // tool_result never landed — exactly the state that leaked raw tool blocks.
    sp.persistSession('sess-orphan', {
      title: 'orphan',
      messages: [
        { role: 'user', content: 'read the file' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading now.' },
            { type: 'tool_use', id: 'orphan-1', name: 'Read', input: { path: 'a.js' } },
          ],
        },
      ],
      metadata: { cwd },
    });

    const r = ai.resumePersistedSession('sess-orphan');
    _expect(r.success).toBe(true);

    const msgs = chatState.messages;
    const last = msgs[msgs.length - 1];
    _expect(last.role).toBe('user');
    _expect(Array.isArray(last.content)).toBe(true);
    _expect(_countPlaceholders(msgs, 'orphan-1')).toBe(1);

    // Persisting the repaired history and resuming again must NOT stack a second
    // placeholder — the injected block is a real tool_result, so pairing is a
    // no-op on the next pass.
    sp.persistSession('sess-orphan', { messages: msgs, metadata: { cwd } });
    const again = ai.resumePersistedSession('sess-orphan');
    _expect(again.success).toBe(true);
    _expect(_countPlaceholders(chatState.messages, 'orphan-1')).toBe(1);
  });

  _test('leaves an already-paired transcript untouched', () => {
    const cwd = process.cwd();
    sp.persistSession('sess-paired', {
      title: 'paired',
      messages: [
        { role: 'user', content: 'read the file' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'paired-1', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'paired-1', content: 'ok' }],
        },
      ],
      metadata: { cwd },
    });

    const r = ai.resumePersistedSession('sess-paired');
    _expect(r.success).toBe(true);
    _expect(r.messageCount).toBe(3);
    _expect(_countPlaceholders(chatState.messages, 'paired-1')).toBe(1);
  });
});
