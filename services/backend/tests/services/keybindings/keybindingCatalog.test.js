'use strict';

/**
 * keybindingCatalog.test.js — 纯叶子键位目录契约(node:test,零 IO)。
 *
 * 锁定:分组目录结构;`?` 浮层精简视图(ESSENTIAL_SHORTCUTS)与 HelpMenu 历史 15 条逐字节一致
 * (防 HelpMenu 收敛后视觉回归);selectCatalog 按上下文/查询过滤;formatCatalog 确定性对齐渲染;
 * 门控 isEnabled;防呆。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYBINDING_CATALOG,
  ESSENTIAL_SHORTCUTS,
  getEssentialShortcuts,
  selectCatalog,
  formatCatalog,
  isEnabled,
} = require('../../../src/services/keybindings/keybindingCatalog');

describe('完整目录结构', () => {
  test('每组有 context/label/非空 bindings,每条有 keys/desc', () => {
    assert.ok(Array.isArray(KEYBINDING_CATALOG) && KEYBINDING_CATALOG.length >= 5);
    for (const g of KEYBINDING_CATALOG) {
      assert.equal(typeof g.context, 'string');
      assert.equal(typeof g.label, 'string');
      assert.ok(Array.isArray(g.bindings) && g.bindings.length > 0);
      for (const b of g.bindings) {
        assert.equal(typeof b.keys, 'string');
        assert.equal(typeof b.desc, 'string');
        assert.ok(b.keys.length > 0 && b.desc.length > 0);
      }
    }
  });
  test('包含真实处理器的关键上下文', () => {
    const ctxs = KEYBINDING_CATALOG.map((g) => g.context);
    for (const c of ['global', 'editing', 'navigation', 'completion', 'entrypoints', 'vim']) {
      assert.ok(ctxs.includes(c), `缺上下文 ${c}`);
    }
  });
  test('CC 对齐:新增 chat chord 组(Meta+P/O/T)与 global Ctrl+T', () => {
    const chat = KEYBINDING_CATALOG.find((g) => g.context === 'chat');
    assert.ok(chat, '缺 chat 上下文');
    const chatKeys = chat.bindings.map((b) => b.keys);
    assert.ok(chatKeys.includes('Meta + P'), '缺 Meta+P 模型选择器');
    assert.ok(chatKeys.includes('Meta + O'), '缺 Meta+O fast');
    assert.ok(chatKeys.includes('Meta + T'), '缺 Meta+T thinking');
    const global = KEYBINDING_CATALOG.find((g) => g.context === 'global');
    assert.ok(global.bindings.some((b) => b.keys === 'Ctrl + T'), '缺 global Ctrl+T 任务清单');
  });
});

describe('?  浮层精简视图(防 HelpMenu 收敛后回归)', () => {
  // 与 HelpMenu.js 历史内联 SHORTCUTS 逐字节一致:键位收敛后浮层不得有任何视觉漂移。
  const LEGACY = [
    ['Enter', '发送消息'],
    ['Shift/Alt + Enter', '换行（多行输入）'],
    ['/', '斜杠命令菜单'],
    ['@', '引用文件路径'],
    ['↑ / ↓', '浏览历史 / 在菜单中移动'],
    ['Tab', '接受补全'],
    ['Shift + Tab', '切换权限模式'],
    ['Ctrl + C', '取消当前回合 / 退出'],
    ['Ctrl + O', '展开/折叠过程组与工具输出'],
    ['Ctrl + L', '清屏'],
    ['Ctrl + A / E', '行首 / 行尾'],
    ['Ctrl + W', '删除前一个词'],
    ['Ctrl + K / U', '删除到行尾 / 行首'],
    ['Esc', '关闭菜单'],
    ['?', '显示/隐藏本帮助'],
  ];
  test('getEssentialShortcuts 与历史 15 条逐字节一致', () => {
    const got = getEssentialShortcuts().map((p) => [p[0], p[1]]);
    assert.deepEqual(got, LEGACY);
  });
  test('ESSENTIAL_SHORTCUTS 与 getEssentialShortcuts 同源', () => {
    assert.equal(getEssentialShortcuts(), ESSENTIAL_SHORTCUTS);
  });
});

describe('selectCatalog 过滤', () => {
  test('无参 → 全部分组', () => {
    const g = selectCatalog();
    assert.equal(g.length, KEYBINDING_CATALOG.length);
  });
  test('按上下文名(vim)→ 仅该组', () => {
    const g = selectCatalog({ context: 'vim' });
    assert.equal(g.length, 1);
    assert.equal(g[0].context, 'vim');
  });
  test('按上下文 label(编辑)→ 仅该组', () => {
    const g = selectCatalog({ context: '编辑' });
    assert.equal(g.length, 1);
    assert.equal(g[0].context, 'editing');
  });
  test('自由查询(ctrl)→ 每组只保留命中行,空组剔除', () => {
    const g = selectCatalog({ query: 'ctrl' });
    assert.ok(g.length >= 1);
    for (const grp of g) {
      assert.ok(grp.bindings.length > 0);
      assert.ok(grp.bindings.every((b) =>
        b.keys.toLowerCase().includes('ctrl') ||
        b.desc.toLowerCase().includes('ctrl') ||
        grp.label.toLowerCase().includes('ctrl') ||
        grp.context.toLowerCase().includes('ctrl')));
    }
  });
  test('查询无命中 → 空数组', () => {
    assert.deepEqual(selectCatalog({ query: 'zzzz-nope' }), []);
  });
  test('返回的是拷贝,不污染原目录', () => {
    const g = selectCatalog();
    g[0].bindings.push({ keys: 'X', desc: 'Y' });
    assert.ok(KEYBINDING_CATALOG[0].bindings.every((b) => b.keys !== 'X'));
  });
});

describe('formatCatalog 确定性渲染', () => {
  test('含组标题【】,键列右对齐(键后至少 2 空格)', () => {
    const out = formatCatalog(selectCatalog({ context: 'navigation' }));
    assert.match(out, /【导航】/);
    // 每条形如 "  <keys><padding><desc>";键列对齐到最长键宽。
    assert.ok(out.split('\n').some((l) => /^ {2}\S.* {2,}\S/.test(l) || /^ {2}.+  .+/.test(l)));
  });
  test('空 groups → 空串', () => {
    assert.equal(formatCatalog([]), '');
    assert.equal(formatCatalog(null), '');
  });
  test('多组之间有空行分隔', () => {
    const out = formatCatalog(selectCatalog());
    assert.match(out, /\n\n【/);
  });
});

describe('门控 isEnabled', () => {
  test('默认(未设)→ 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_KEYBINDINGS: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_KEYBINDINGS: v }), false);
    }
  });
});
