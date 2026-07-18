'use strict';

/**
 * historyBrowseDecision leaf tests (node:test).
 *
 * Covers:
 *   - gate ladder (default on / 0·false·off·no incl. case + whitespace / other on)
 *   - single-line forward only when gate on; swallow when gate off (legacy)
 *   - multiline always forwards regardless of gate (interior cursor moves)
 *   - defensive: missing args / undefined env
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  historyBrowseWhileEditingEnabled,
  shouldBrowseHistoryWhileEditing,
} = require('./historyBrowseDecision');

// ── gate ladder ─────────────────────────────────────────────────────────────
test('historyBrowseWhileEditingEnabled: default on (unset)', () => {
  assert.equal(historyBrowseWhileEditingEnabled({}), true);
});

test('historyBrowseWhileEditingEnabled: 0/false/off/no (case + whitespace) off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO', ' no ']) {
    assert.equal(
      historyBrowseWhileEditingEnabled({ KHY_HISTORY_BROWSE_EDITING: v }),
      false,
      `value ${JSON.stringify(v)} should disable`
    );
  }
});

test('historyBrowseWhileEditingEnabled: other values on', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.equal(
      historyBrowseWhileEditingEnabled({ KHY_HISTORY_BROWSE_EDITING: v }),
      true,
      `value ${JSON.stringify(v)} should enable`
    );
  }
});

// ── single-line: gated ───────────────────────────────────────────────────────
test('single-line + gate on → forward (browse history)', () => {
  assert.equal(shouldBrowseHistoryWhileEditing({ hasNewline: false, env: {} }), true);
});

test('single-line + gate off → swallow (legacy)', () => {
  assert.equal(
    shouldBrowseHistoryWhileEditing({ hasNewline: false, env: { KHY_HISTORY_BROWSE_EDITING: '0' } }),
    false
  );
});

// ── multiline: always forwards ───────────────────────────────────────────────
test('multiline + gate on → forward', () => {
  assert.equal(shouldBrowseHistoryWhileEditing({ hasNewline: true, env: {} }), true);
});

test('multiline + gate off → STILL forward (interior cursor move not gated)', () => {
  assert.equal(
    shouldBrowseHistoryWhileEditing({ hasNewline: true, env: { KHY_HISTORY_BROWSE_EDITING: 'off' } }),
    true
  );
});

// ── defensive ────────────────────────────────────────────────────────────────
test('defensive: no args → uses default env, single-line default on', () => {
  // No env passed → falls back to process.env; default-on unless the runner sets
  // the flag. Assert the boolean shape and the gate predicate agree.
  const r = shouldBrowseHistoryWhileEditing();
  assert.equal(typeof r, 'boolean');
  assert.equal(r, historyBrowseWhileEditingEnabled());
});

test('defensive: undefined/null env does not throw', () => {
  assert.doesNotThrow(() => historyBrowseWhileEditingEnabled(undefined));
  assert.doesNotThrow(() => historyBrowseWhileEditingEnabled(null));
  assert.doesNotThrow(() => shouldBrowseHistoryWhileEditing({ hasNewline: false, env: null }));
});
