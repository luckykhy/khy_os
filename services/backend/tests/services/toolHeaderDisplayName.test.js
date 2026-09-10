'use strict';
/**
 * toolHeaderDisplayName.test.js — TUI 工具头行「显示名对齐 CC」叶子的单元 + 门控
 * 字节回退 + E2E 接缝(node:test)。
 *
 * 立场(goal 2026-07-04「做这个对齐」):Ink TUI 头行此前直接用工具原始注册名,
 * 与经典 REPL/CC 的 `getToolDisplayName` 归一名漂移。本叶子做门控 + 复用 SSOT +
 * fail-soft 回退。覆盖:
 *   ① 门控默认开,仅显式 0/false/off/no 关;
 *   ② 开 → 用注入的 resolver 映射(edit→Update);关 → 逐字节回退原始名;
 *   ③ resolver 缺失 / 抛错 / 映射空 → 回退原始名(绝不渲染空头行);
 *   ④ E2E:接入真实 renderTheme.getToolDisplayName,Edit→Update、Write→Write、
 *      未收录名原样返回。
 */
const thn = require('../../src/cli/toolHeaderDisplayName');
// 假 resolver:模拟 getToolDisplayName 的收录子集。
function fakeResolver(name) {
  const raw = String(name).toLowerCase().replace(/[\s_-]/g, '');
  const map = { edit: 'Update', editfile: 'Update', multiedit: 'Update', write: 'Write', read: 'Read' };
  return map[raw] || name;
}
// ── E2E:接入真实 renderTheme.getToolDisplayName ──────────────────────────────
// ── 复刻 ToolLines.js 头行接线块,证接缝语义(ON 映射 / OFF 字节回退)──────────
function simulateHeaderName(t, env) {
  let name = t.name || t.toolName || t.tool || 'tool';
  try {
    name = require('../../src/cli/toolHeaderDisplayName').resolveToolHeaderName(
      name, env, require('../../src/cli/renderTheme').getToolDisplayName
    );
  } catch { /* additive */ }
  return name;
}

describe('Tool Header Display Name', () => {
  test('isEnabled: 默认开,仅显式 0/false/off/no 关', () => {
      expect(thn.isEnabled({})).toBe(true);
      expect(thn.isEnabled({ KHY_TUI_TOOL_DISPLAY_NAME: '1' })).toBe(true);
      expect(thn.isEnabled({ KHY_TUI_TOOL_DISPLAY_NAME: 'yes' })).toBe(true);
      for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(thn.isEnabled({ KHY_TUI_TOOL_DISPLAY_NAME: off })).toBe(false, `off=${off}`);
      }
  });

  test('resolveToolHeaderName: 门控开 → 映射(edit→Update / multiedit→Update)', () => {
      expect(thn.resolveToolHeaderName('Edit', {}, fakeResolver)).toBe('Update');
      expect(thn.resolveToolHeaderName('edit_file', {}, fakeResolver)).toBe('Update');
      expect(thn.resolveToolHeaderName('MultiEdit', {}, fakeResolver)).toBe('Update');
  });

  test('resolveToolHeaderName: 门控开但工具未收录 → 原样返回(安全超集)', () => {
      expect(thn.resolveToolHeaderName('SomeCustomTool', {}, fakeResolver)).toBe('SomeCustomTool');
      expect(thn.resolveToolHeaderName('Bash', {}, fakeResolver)).toBe('Bash');
  });

  test('resolveToolHeaderName: 门控关 → 逐字节回退原始名', () => {
      const env = { KHY_TUI_TOOL_DISPLAY_NAME: '0' };
      expect(thn.resolveToolHeaderName('Edit', env, fakeResolver)).toBe('Edit');
      expect(thn.resolveToolHeaderName('MultiEdit', env, fakeResolver)).toBe('MultiEdit');
      for (const off of ['false', 'off', 'no']) {
        expect(thn.resolveToolHeaderName('Edit', { KHY_TUI_TOOL_DISPLAY_NAME: off }, fakeResolver)).toBe('Edit');
      }
  });

  test('resolveToolHeaderName: resolver 缺失 → 回退原始名', () => {
      expect(thn.resolveToolHeaderName('Edit', {}, undefined)).toBe('Edit');
      expect(thn.resolveToolHeaderName('Edit', {}, null)).toBe('Edit');
      expect(thn.resolveToolHeaderName('Edit', {}, 'not-a-fn')).toBe('Edit');
  });

  test('resolveToolHeaderName: resolver 抛错 → fail-soft 回退原始名', () => {
      const boom = () => { throw new Error('boom'); };
      expect(thn.resolveToolHeaderName('Edit', {}, boom)).toBe('Edit');
  });

  test('resolveToolHeaderName: 映射为空/空白 → 回退原始名(绝不渲染空头行)', () => {
      expect(thn.resolveToolHeaderName('Edit', {}, () => '')).toBe('Edit');
      expect(thn.resolveToolHeaderName('Edit', {}, () => '   ')).toBe('Edit');
      expect(thn.resolveToolHeaderName('Edit', {}, () => null)).toBe('Edit');
  });

  test('resolveToolHeaderName: 空/异常输入不抛', () => {
      expect(thn.resolveToolHeaderName('', {}, fakeResolver)).toBe('');
      expect(thn.resolveToolHeaderName(null, {}, fakeResolver)).toBe('');
      expect(thn.resolveToolHeaderName(undefined, {}, fakeResolver)).toBe('');
  });

  test('E2E: 真实 SSOT 下 Edit→Update、Write→Write、Read→Read', () => {
      const { getToolDisplayName } = require('../../src/cli/renderTheme');
      expect(thn.resolveToolHeaderName('Edit', {}, getToolDisplayName)).toBe('Update');
      expect(thn.resolveToolHeaderName('MultiEdit', {}, getToolDisplayName)).toBe('Update');
      expect(thn.resolveToolHeaderName('Write', {}, getToolDisplayName)).toBe('Write');
      expect(thn.resolveToolHeaderName('Read', {}, getToolDisplayName)).toBe('Read');
  });

  test('E2E: 门控关 → 即使真实 SSOT 也逐字节回退原始名', () => {
      const { getToolDisplayName } = require('../../src/cli/renderTheme');
      const env = { KHY_TUI_TOOL_DISPLAY_NAME: 'off' };
      expect(thn.resolveToolHeaderName('Edit', env, getToolDisplayName)).toBe('Edit');
  });

  test('E2E 接缝: t.name=Edit → 头行 Update;门控关 → Edit', () => {
      expect(simulateHeaderName({ name: 'Edit' }, {})).toBe('Update');
      expect(simulateHeaderName({ name: 'Edit' }, { KHY_TUI_TOOL_DISPLAY_NAME: '0' })).toBe('Edit');
      // 兜底链:无 name → 'tool'
      expect(simulateHeaderName({}, {})).toBe('tool');
  });

});
