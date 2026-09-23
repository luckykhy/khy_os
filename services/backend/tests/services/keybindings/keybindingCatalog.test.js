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
} = require('../../../src/services/domain/config/keybindings/keybindingCatalog.js');

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
  // 唯一一处**有意**改动:Ctrl+O 从「就地展开最后一条」改绑为「打开会话记录视图」
  // (对齐 CC 的 app:toggleTranscript,门控 KHY_TRANSCRIPT_VIEW),文案随之更新 ——
  // 这是键位语义真的变了,不是漂移。其余 14 条仍逐字节钉死。
  //
  // 第二处有意改动(BUG-35, 2026-09-21):第 2 条从「Shift/Alt + Enter」改为「Ctrl + J」。
  // 真终端逐键实测(Windows Terminal 1.24)：Shift+Enter 与 Enter 送同一串 `\r`(会直接发送),
  // Ctrl+Enter 零字节(终端自用为全屏),Alt+Enter 只送回一个孤立 ESC(终端自用为全屏)——
  // 三条全是假承诺;唯一稳定送达并插入换行的是 Ctrl+J(裸 LF)。收窄到本机真能按出来的那一集,
  // 不是漂移。
  const LEGACY = [
    ['Enter', '发送消息'],
    ['Ctrl + J', '换行（多行输入）'],
    ['/', '斜杠命令菜单'],
    ['@', '引用文件路径'],
    // Stage 2 有意变更:门控退役后 ↑/↓ 无条件逐条回溯,文案随之说清「逐条」。
    ['↑ / ↓', '逐条浏览历史 / 在菜单中移动'],
    ['Tab', '接受补全'],
    ['Shift + Tab', '切换权限模式'],
    ['Ctrl + C', '取消当前回合 / 退出'],
    ['Ctrl + O', '打开会话记录视图(滚动回看 / 展开)'],
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

describe('目录条目不得宣称终端送不出的键位(BUG-35 真源守卫)', () => {
  // 这个目录此前只对着「处理器有没有这条分支」核对,没对「终端送不送得出这个字节」
  // 核对,于是浮层宣称的 Shift+Enter / Ctrl+Enter 换行在 Windows Terminal 上是假承诺
  // (实测:Shift+Enter 与 Enter 同送 `\r` 会直接发送;Ctrl+Enter 零字节,被终端自用为全屏)。
  // 守卫只钉住已被实测否定的那一类:凡键位名里带 Shift/Ctrl + Enter,描述必须言明
  // 它依赖 kitty/CSI-u 键协议,否则就是又一次「代码里能跑、按出来不是那回事」。
  const ENTER_ROWS = KEYBINDING_CATALOG.flatMap((g) => g.bindings).filter((b) =>
    /Enter/i.test(b.keys)
  );

  test('存在被实测否定的 Enter 条目可供校验', () => {
    assert.ok(ENTER_ROWS.some((b) => /Shift|Ctrl/i.test(b.keys)));
  });

  test('Shift/Ctrl + Enter 条目必须标注 CSI-u 依赖', () => {
    for (const b of ENTER_ROWS) {
      if (!/Shift|Ctrl/i.test(b.keys)) continue;
      assert.ok(
        /CSI-u|kitty/i.test(b.desc),
        `条目「${b.keys}」未标注终端协议依赖 —— 多数终端送不出可区分的字节`
      );
    }
  });

  test('Alt + Enter 条目必须言明其在 Windows Terminal 上不可用', () => {
    const alt = ENTER_ROWS.find((b) => /^Alt \+ Enter$/.test(b.keys));
    assert.ok(alt, '缺 Alt+Enter 条目(该组合常被终端自用,须说清前提)');
    assert.match(alt.desc, /不可用|仅当/);
    assert.match(alt.desc, /全屏|ESC/);
  });

  test('Ctrl + J 是本机实测唯一稳定可用的换行组合键', () => {
    const all = KEYBINDING_CATALOG.flatMap((g) => g.bindings);
    const ctrlJ = all.find((b) => /^Ctrl \+ J$/.test(b.keys));
    assert.ok(ctrlJ, '缺 Ctrl+J 条目(裸 LF → 插入换行,实测可用)');
    assert.match(ctrlJ.desc, /换行/);
    // 浮层那一行也必须与目录同源:钉在 ESSENTIAL_SHORTCUTS 第 2 条。
    assert.deepEqual(
      getEssentialShortcuts()[1].map((s) => s),
      ['Ctrl + J', '换行（多行输入）']
    );
    // 不得再出现把 Shift 与 Enter 换行并列为「本机可用」的合并写法。
    for (const b of ENTER_ROWS) {
      assert.doesNotMatch(b.keys, /Shift\s*\/\s*Alt/, `合并写法「${b.keys}」又把 Shift 许诺了出去`);
    }
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
