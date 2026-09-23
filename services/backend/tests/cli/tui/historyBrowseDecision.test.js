'use strict';

/**
 * historyBrowseDecision shim tests (node:test).
 *
 * Stage 2: the KHY_HISTORY_BROWSE_EDITING gate has been retired. The decision
 * single-source-of-truth moved out to arrowRouting.js (editing context).
 * This file is kept to record that "both exports are now constant true", so
 * that nobody silently re-wires the gate and breaks CC semantics.
 *
 * 修复记录(2026-09-16): 本文件头自称 (node:test),但**没有** `require('node:test')`,
 * 于是 jest 用全局 `describe`/`test`/`expect` 跑它(看着是绿),而 `node --test` 跑它
 * 直接 `ReferenceError: describe is not defined` —— 双 runner 皆"跑得动但跑的不是同一份"。
 * 按 tests/DEBT.md §三 B 的修法补齐 node:test 导入并把 `expect` 换成 `assert.*`;
 * 补完后 jest 会按 `findNodeTestFiles` 的 `require('node:test')` 标记自动把它交给
 * `test:node`(jest.config.js 无需改动)。
 *
 * 覆盖:
 *   - 两个函数在任何入参下恒返回 true(门控退役)
 *   - 畸形入参绝不抛
 *
 * Run: `node --test tests/cli/tui/historyBrowseDecision.test.js`
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  historyBrowseWhileEditingEnabled,
  shouldBrowseHistoryWhileEditing,
} = require('../../../src/cli/tui/historyBrowseDecision.js');

// ── historyBrowseWhileEditingEnabled 恒为 true ───────────────────────────────

test('historyBrowseWhileEditingEnabled: 恒返回 true,不读 env', () => {
  // 门控退役:任何 env 都不再能关掉它。
  for (const env of [
    {},
    { KHY_HISTORY_BROWSE_EDITING: '0' },
    { KHY_HISTORY_BROWSE_EDITING: 'false' },
    { KHY_HISTORY_BROWSE_EDITING: 'off' },
    { KHY_HISTORY_BROWSE_EDITING: 'no' },
    { KHY_HISTORY_BROWSE_EDITING: 'NO' },
    { KHY_HISTORY_BROWSE_EDITING: ' no ' },
    { KHY_HISTORY_BROWSE_EDITING: '1' },
    undefined,
    null,
  ]) {
    assert.equal(historyBrowseWhileEditingEnabled(env), true);
  }
});

// ── shouldBrowseHistoryWhileEditing 恒为 true ────────────────────────────────

test('shouldBrowseHistoryWhileEditing: 单行与多行均恒返回 true', () => {
  for (const hasNewline of [true, false]) {
    for (const env of [
      {},
      { KHY_HISTORY_BROWSE_EDITING: '0' }, // 历史上这会让单行返回 false —— 退役后不再
      undefined,
    ]) {
      assert.equal(
        shouldBrowseHistoryWhileEditing({ hasNewline, env }),
        true,
        `hasNewline=${hasNewline} env=${JSON.stringify(env)}`
      );
    }
  }
});

// ── 畸形入参绝不抛 ──────────────────────────────────────────────────────────

test('畸形入参不抛', () => {
  assert.doesNotThrow(() => historyBrowseWhileEditingEnabled(undefined));
  assert.doesNotThrow(() => historyBrowseWhileEditingEnabled(null));
  assert.doesNotThrow(() => historyBrowseWhileEditingEnabled(42));
  assert.doesNotThrow(() => shouldBrowseHistoryWhileEditing());
  assert.doesNotThrow(() => shouldBrowseHistoryWhileEditing(null));
  assert.doesNotThrow(() => shouldBrowseHistoryWhileEditing({ hasNewline: false, env: null }));
});
