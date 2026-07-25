'use strict';

/**
 * keybindings.js — `/keybindings` 命令薄壳:列出 khy TUI 的键盘快捷键(按上下文分组)。
 *
 * 对齐 Claude Code 的 keybindings。**背后逻辑**(按上下文分组、与真实输入处理器一一对应的键位
 * 目录数据模型)在纯叶子 keybindingCatalog.js(单一真源,同源驱动 `?` 帮助浮层);本薄壳只做
 * 取数 + 打印,无 IO。
 *
 * **诚实边界(与 CC 取舍不同)**:CC 把 keybindings 持久化到 `~/.claude/keybindings.json` 做**重映射**
 * 并热加载喂回输入处理器;khy 的键位**硬编码**在 Ink 输入处理器里、没有这条重映射通路,故 khy 刻意
 * 只对齐 CC 可兑现的那一半 —— 完整、准确的**键位目录展示**(而非造一套写了配置却不真正改变按键行为
 * 的假重映射引擎)。这是与 [[terminalSetup]] 同款的诚实取舍:给准确的事实,不假装有不存在的能力。
 *
 * 用法:`/keybindings`(全部)、`/keybindings vim`(按上下文)、`/keybindings ctrl`(自由查询过滤)。
 * 门控 KHY_KEYBINDINGS 默认开;关 → 命令不接管(字节回退到「无此命令」的历史世界,提示按 ? 看浮层)。
 */

const { printInfo } = require('../formatters');
const catalog = require('../../services/keybindings/keybindingCatalog');

/**
 * @param {string} _subCommand 预留(无子命令)
 * @param {string[]} args 可选:上下文名(global/editing/navigation/completion/entrypoints/vim)或自由查询词
 * @returns {Promise<boolean>}
 */
async function handleKeybindings(_subCommand, args = [], _options = {}) {
  if (!catalog.isEnabled(process.env)) {
    printInfo('在空输入框按 ? 可显示键盘快捷键浮层。');
    return false;
  }

  const term = Array.isArray(args) ? args.join(' ').trim() : String(args || '').trim();

  // 已知上下文名 → 当作 context 精确筛;否则当作自由查询。
  const KNOWN = new Set(catalog.KEYBINDING_CATALOG.map((g) => g.context.toLowerCase())
    .concat(catalog.KEYBINDING_CATALOG.map((g) => g.label.toLowerCase())));
  let groups;
  if (term && KNOWN.has(term.toLowerCase())) {
    groups = catalog.selectCatalog({ context: term });
  } else if (term) {
    groups = catalog.selectCatalog({ query: term });
  } else {
    groups = catalog.selectCatalog();
  }

  if (!groups.length) {
    printInfo(`未找到匹配「${term}」的快捷键。直接运行 /keybindings 查看全部。`);
    return true;
  }

  printInfo('键盘快捷键' + (term ? `(过滤:${term})` : ''));
  printInfo(catalog.formatCatalog(groups));
  printInfo('提示:在空输入框按 ? 可随时唤出精简浮层;Vim 键位需 /vim 开启。');
  return true;
}

module.exports = { handleKeybindings };
