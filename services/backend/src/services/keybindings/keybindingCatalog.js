'use strict';

/**
 * keybindingCatalog.js — khy 键盘快捷键「分组目录 + 选择 + 渲染」的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;只读入参,绝不读 process.env、绝不触文件。
 * 无任何依赖(连 path 都不需要)。
 *
 * 背后的逻辑(对齐 Claude Code keybindings):CC 的 keybindings 是一套**按上下文分组的键位数据模型**
 * (Global/Chat/Autocomplete/… → {keystroke: action})。CC 还允许把它持久化到 `~/.claude/keybindings.json`
 * 做**重映射**,经 watcher 热加载喂回输入处理器。
 *
 * **诚实边界(与 CC 取舍不同)**:khy 的键位**硬编码**在 Ink TUI 输入处理器(`App.js` 全局链 /
 * `useTextInput.js` 编辑链 / `useVimInput.js`)里,没有一条「配置文件 → 解析 → 解析器 → 喂处理器」的
 * 重映射通路。**造一套跑不通的重映射引擎**(写了 JSON 却不真正改变按键行为)是堆砌假功能,违背
 * goal「注重背后的逻辑」的诚实。因此 khy 刻意只对齐 CC **有价值且可兑现**的那一半 —— 那张
 * **按上下文分组、与真实处理器一一对应的键位目录数据模型** —— 并把它作为**单一真源**:既驱动
 * `/keybindings` 命令的完整列举,也驱动 `?` 帮助浮层(`HelpMenu.js`)的精简视图,取代此前散落且
 * 互不一致的两三份拷贝(HelpMenu 内联表 + skill 的 markdown)。重映射留待未来若真接通输入层再议。
 *
 * 数据来源(真实处理器,逐条核对):
 *   - 全局链   src/cli/tui/ink-components/App.js(Ctrl+C/D/L/V/O/T、Shift+Tab、?、Esc、补全菜单导航)
 *   - 对话 chord src/cli/tui/chatChords.js → App.js 分派(Meta+P 模型 / Meta+O fast / Meta+T thinking)
 *   - 编辑链   src/cli/tui/hooks/useTextInput.js(Enter、Shift/Alt/Ctrl+Enter、emacs Ctrl/Alt 链)
 *   - Vim 链   src/cli/tui/hooks/useVimInput.js(/vim 开启时)
 *   - 入口提示 App.js 状态行 '/ 命令,@ 文件,! shell,# 记忆,? 快捷键'
 */

/**
 * 完整目录:按上下文分组,与真实处理器一一对应。每条 { keys, desc }。
 * `essential` 标注的条目同时进入 `?` 帮助浮层的精简视图(curated 子集,见下方 ESSENTIAL_SHORTCUTS)。
 */
const KEYBINDING_CATALOG = Object.freeze([
  {
    context: 'global',
    label: '全局',
    bindings: Object.freeze([
      { keys: 'Ctrl + C', desc: '忙时取消当前回合;空闲时连按两次退出' },
      { keys: 'Ctrl + D', desc: '有文本时向后删除;空行时连按两次退出' },
      { keys: 'Ctrl + L', desc: '清屏(清除已提交的对话记录)' },
      { keys: 'Ctrl + O', desc: '展开/折叠过程组与工具输出' },
      { keys: 'Ctrl + T', desc: '显示/隐藏任务清单面板' },
      { keys: 'Ctrl + V', desc: '粘贴/暂存剪贴板图片到下一回合(Windows 为 Alt + V)' },
      { keys: 'Shift + Tab', desc: '切换权限模式(循环 4 档)' },
      { keys: 'Esc', desc: '取消计划评审 / 中断当前回合 / 连按两次清空输入或回溯' },
      { keys: '?', desc: '在空输入框显示/隐藏键盘快捷键浮层' },
    ]),
  },
  {
    context: 'chat',
    label: '对话',
    bindings: Object.freeze([
      { keys: 'Meta + P', desc: '打开模型选择器(切换模型)' },
      { keys: 'Meta + O', desc: '切换快速模式(fast mode)' },
      { keys: 'Meta + T', desc: '切换扩展思考(thinking)' },
    ]),
  },
  {
    context: 'editing',
    label: '编辑',
    bindings: Object.freeze([
      { keys: 'Enter', desc: '发送消息' },
      { keys: 'Shift / Alt / Ctrl + Enter', desc: '插入换行(多行输入)' },
      { keys: '\\ + Enter', desc: '行尾反斜杠续行:删掉反斜杠并换行(对齐 Claude Code)' },
      { keys: 'Backspace', desc: '向前删除一个字符' },
      { keys: 'Meta + Backspace', desc: '删除前一个词' },
      { keys: 'Ctrl + A', desc: '移到行首' },
      { keys: 'Ctrl + E', desc: '移到行尾' },
      { keys: 'Ctrl + B', desc: '左移一个字符' },
      { keys: 'Ctrl + F', desc: '右移一个字符' },
      { keys: 'Ctrl + K', desc: '删除到行尾' },
      { keys: 'Ctrl + U', desc: '删除到行首' },
      { keys: 'Ctrl + W', desc: '删除前一个词' },
      { keys: 'Ctrl + Y', desc: '粘回(yank)上次删除的内容' },
      { keys: 'Alt + B', desc: '按词左移' },
      { keys: 'Alt + F', desc: '按词右移' },
      { keys: 'Alt + D', desc: '删除后一个词' },
    ]),
  },
  {
    context: 'navigation',
    label: '导航',
    bindings: Object.freeze([
      { keys: '← / →', desc: '按字符移动光标' },
      { keys: 'Meta + ← / →', desc: '按词移动光标' },
      { keys: 'Home / End', desc: '移到行首 / 行尾' },
      { keys: '↑ / ↓', desc: '多行内移动;单行时浏览历史' },
      { keys: 'Ctrl + R', desc: '反向增量搜索历史命令;再按跳到更旧一条,Enter/Tab 灌入输入框' },
    ]),
  },
  {
    context: 'completion',
    label: '补全菜单',
    bindings: Object.freeze([
      { keys: '↑ / ↓', desc: '在补全/命令菜单中移动选择' },
      { keys: 'Tab', desc: '接受补全到输入框' },
      { keys: 'Enter', desc: '运行所选斜杠命令 / 接受所选文件' },
      { keys: 'Esc', desc: '关闭补全菜单' },
    ]),
  },
  {
    context: 'entrypoints',
    label: '输入入口',
    bindings: Object.freeze([
      { keys: '/', desc: '斜杠命令菜单' },
      { keys: '@', desc: '引用文件路径' },
      { keys: '!', desc: '执行 shell 命令' },
      { keys: '#', desc: '写入记忆' },
      { keys: '?', desc: '键盘快捷键' },
    ]),
  },
  {
    context: 'vim',
    label: 'Vim 模式(/vim 开启时)',
    bindings: Object.freeze([
      { keys: 'Esc', desc: '回到 NORMAL 模式' },
      { keys: 'i', desc: '进入 INSERT 模式' },
      { keys: 'v', desc: '进入 VISUAL 模式' },
      { keys: 'h / j / k / l', desc: '左 / 下 / 上 / 右移动' },
    ]),
  },
]);

/**
 * `?` 帮助浮层的精简视图(curated 子集,刻意只列最常用的 15 条)。
 * 这是 HelpMenu.js 唯一数据源(取代其内联表)。其措辞与排序属浮层产品决策,与完整目录正交:
 * 完整目录供 `/keybindings` 全列举,本表供 `?` 一眼速查。两者同源此文件,绝不再各处自写。
 */
const ESSENTIAL_SHORTCUTS = Object.freeze([
  Object.freeze(['Enter', '发送消息']),
  Object.freeze(['Shift/Alt + Enter', '换行（多行输入）']),
  Object.freeze(['/', '斜杠命令菜单']),
  Object.freeze(['@', '引用文件路径']),
  Object.freeze(['↑ / ↓', '浏览历史 / 在菜单中移动']),
  Object.freeze(['Tab', '接受补全']),
  Object.freeze(['Shift + Tab', '切换权限模式']),
  Object.freeze(['Ctrl + C', '取消当前回合 / 退出']),
  Object.freeze(['Ctrl + O', '展开/折叠过程组与工具输出']),
  Object.freeze(['Ctrl + L', '清屏']),
  Object.freeze(['Ctrl + A / E', '行首 / 行尾']),
  Object.freeze(['Ctrl + W', '删除前一个词']),
  Object.freeze(['Ctrl + K / U', '删除到行尾 / 行首']),
  Object.freeze(['Esc', '关闭菜单']),
  Object.freeze(['?', '显示/隐藏本帮助']),
]);

// 收敛到 utils/isOffValue 单一真源(逐字节委托,调用点不变)
const _falsy = require('../../utils/isOffValue');

/** `?` 浮层取数(SSOT)。返回不可变的 [keys, desc] 元组数组。 */
function getEssentialShortcuts() {
  return ESSENTIAL_SHORTCUTS;
}

/**
 * 按上下文名或自由查询筛选目录。纯函数,绝不抛。
 * @param {object} [opts]
 *   @param {string} [opts.context] 上下文名(精确匹配 context 或 label,大小写不敏感)
 *   @param {string} [opts.query]   自由查询(在 keys/desc/label 上做大小写不敏感子串匹配,逐条过滤)
 * @returns {Array<{context:string,label:string,bindings:Array<{keys:string,desc:string}>}>}
 */
function selectCatalog(opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const ctx = String(o.context == null ? '' : o.context).trim().toLowerCase();
  const query = String(o.query == null ? '' : o.query).trim().toLowerCase();

  let groups = KEYBINDING_CATALOG.map((g) => ({
    context: g.context,
    label: g.label,
    bindings: g.bindings.slice(),
  }));

  if (ctx) {
    groups = groups.filter((g) => g.context.toLowerCase() === ctx || g.label.toLowerCase() === ctx);
  }

  if (query) {
    groups = groups
      .map((g) => ({
        context: g.context,
        label: g.label,
        bindings: g.bindings.filter(
          (b) =>
            b.keys.toLowerCase().includes(query) ||
            b.desc.toLowerCase().includes(query) ||
            g.label.toLowerCase().includes(query) ||
            g.context.toLowerCase().includes(query)
        ),
      }))
      .filter((g) => g.bindings.length > 0);
  }

  return groups;
}

/**
 * 把(筛选后的)目录渲染成确定性纯文本(不含颜色,着色归薄壳)。键列右对齐到本组最长键宽 + 2 空格。
 * @param {Array} groups selectCatalog 的输出(或 KEYBINDING_CATALOG)
 * @returns {string} 多行文本;groups 为空 → 空串。
 */
function formatCatalog(groups) {
  const list = Array.isArray(groups) ? groups : [];
  const lines = [];
  for (const g of list) {
    if (!g || !Array.isArray(g.bindings) || g.bindings.length === 0) continue;
    if (lines.length) lines.push('');
    lines.push(`【${g.label}】`);
    const keyWidth = g.bindings.reduce((w, b) => Math.max(w, String(b.keys).length), 0);
    for (const b of g.bindings) {
      lines.push(`  ${String(b.keys).padEnd(keyWidth + 2)}${b.desc}`);
    }
  }
  return lines.join('\n');
}

/** 门控读取(KHY_KEYBINDINGS 默认开;关 → 命令不接管)。注入 env,叶子不读 process.env。 */
function isEnabled(env = {}) {
  return !_falsy(env && env.KHY_KEYBINDINGS === undefined ? 'true' : (env && env.KHY_KEYBINDINGS));
}

module.exports = {
  KEYBINDING_CATALOG,
  ESSENTIAL_SHORTCUTS,
  getEssentialShortcuts,
  selectCatalog,
  formatCatalog,
  isEnabled,
};
