'use strict';
/**
 * historyBrowseDecision shim tests (node:test).
 *
 * Stage 2 �?KHY_HISTORY_BROWSE_EDITING 门控已退役。判定单一真源已迁出到
 * arrowRouting.js (editing context)。本文件保留以记录「两个导出都恒为 true�?
 * 防止未来有人重新给它接线时静默破�?CC 语义�?
 *
 * 覆盖:
 *   - 两个函数在任何入参下恒返�?true(门控退�?
 *   - 畸形入参绝不�?
 */
const {
  historyBrowseWhileEditingEnabled,
  shouldBrowseHistoryWhileEditing,
} = require('./historyBrowseDecision');
// ── historyBrowseWhileEditingEnabled 恒为 true ───────────────────────────────
// ── shouldBrowseHistoryWhileEditing 恒为 true ────────────────────────────────
// ── 畸形入参绝不�?────────────────────────────────────────────────────────────

describe('History Browse Decision', () => {
  test('historyBrowseWhileEditingEnabled: 恒返�?true,不读 env', () => {
      // 门控退�?任何 env 都不再能关掉它�?
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
        expect(historyBrowseWhileEditingEnabled(env).toBe(true);
      }
  });

  test('shouldBrowseHistoryWhileEditing: 单行与多行均恒返�?true', () => {
      for (const hasNewline of [true, false]) {
        for (const env of [
          {},
          { KHY_HISTORY_BROWSE_EDITING: '0' }, // 历史上这会让单行返回 false —�?退役后不再
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

  test('畸形入参不抛', () => {
      expect(() => historyBrowseWhileEditingEnabled(undefined).not.toThrow());
      expect(() => historyBrowseWhileEditingEnabled(null).not.toThrow());
      expect(() => historyBrowseWhileEditingEnabled(42).not.toThrow());
      expect(() => shouldBrowseHistoryWhileEditing().not.toThrow());
      expect(() => shouldBrowseHistoryWhileEditing(null).not.toThrow());
      expect(() => shouldBrowseHistoryWhileEditing({ hasNewline: false, env: null }).not.toThrow());
  });

});

