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
