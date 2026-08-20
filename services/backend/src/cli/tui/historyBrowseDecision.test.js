'use strict';

/**
 * historyBrowseDecision shim tests (node:test).
 *
 * Stage 2 注:KHY_HISTORY_BROWSE_EDITING 门控已退役。判定单一真源已迁出到
 * arrowRouting.js (editing context)。本文件保留以记录「两个导出都恒为 true」,
 * 防止未来有人重新给它接线时静默破坏 CC 语义。
 *
 * 覆盖:
 *   - 两个函数在任何入参下恒返回 true(门控退役)
 *   - 畸形入参绝不抛
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  historyBrowseWhileEditingEnabled,
  shouldBrowseHistoryWhileEditing,
} = require('./historyBrowseDecision');

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
    assert.equal(historyBrowseWhileEditingEnabled(env), true, `env=${JSON.stringify(env)}`);
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

// ── 畸形入参绝不抛 ────────────────────────────────────────────────────────────
test('畸形入参不抛', () => {
  assert.doesNotThrow(() => historyBrowseWhileEditingEnabled(undefined));
  assert.doesNotThrow(() => historyBrowseWhileEditingEnabled(null));
  assert.doesNotThrow(() => historyBrowseWhileEditingEnabled(42));
  assert.doesNotThrow(() => shouldBrowseHistoryWhileEditing());
  assert.doesNotThrow(() => shouldBrowseHistoryWhileEditing(null));
  assert.doesNotThrow(() => shouldBrowseHistoryWhileEditing({ hasNewline: false, env: null }));
});
