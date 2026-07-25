'use strict';

/**
 * ToolList Command Handler — khy 工具清单（列出 khy 拥有的所有 AI 工具，按类分组）。
 *
 * 承 goal「做一个工具列表当输入 /toollist 时可以看见 khy 拥有的所有工具」:
 * `/toollist` 在主交互面(TUI/CLI)打印一张按类别分组的**工具**总清单——即模型在
 * 推理中可调用的能力(Read/Edit/Bash/Grep/… + MCP + 自定义工具),消费单一 SSOT
 * (services/toolCatalog/toolCatalog.buildToolCatalog,读工具注册表)。
 *
 * 与 `/features`(斜杠命令索引)互补:
 *   - /features  → 用户在 CLI/TUI 输入的斜杠命令
 *   - /toollist  → 模型可调用的 AI 工具
 *
 * 用法:
 *   toollist               列出全部工具(按类别分组)
 *   toollist <keyword>     只显示工具名/别名/描述匹配关键字的条目
 *   toollist --json        机器可读输出
 *
 * 门控 KHY_TOOL_CATALOG 默认开;关 → 清单为空,提示不可用。
 *
 * @module handlers/toollist
 */
const chalk = require('chalk').default || require('chalk');
const { printInfo, printWarn } = require('../formatters');

/** 关键字过滤:工具名 / 别名 / 描述任一命中(大小写不敏感)。 */
function _filterToolCatalog(catalog, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return catalog;
  const categories = [];
  for (const cat of catalog.categories) {
    const tools = cat.tools.filter((t) =>
      t.name.toLowerCase().includes(kw)
      || (t.desc && t.desc.toLowerCase().includes(kw))
      || (Array.isArray(t.aliases) && t.aliases.some((a) => a.toLowerCase().includes(kw))));
    if (tools.length) categories.push({ ...cat, tools });
  }
  const total = categories.reduce((n, c) => n + c.tools.length, 0);
  return { ...catalog, categories, total };
}

/**
 * @param {string} subCommand   第一个位置参数(当作关键字)
 * @param {string[]} args        其余位置参数
 * @param {object} options       parseInput 解析的 --flags
 */
async function handleToolList(subCommand, args = [], options = {}) {
  const env = process.env;
  const { buildToolCatalog, toolCatalogEnabled } = require('../../services/toolCatalog/toolCatalog');

  if (!toolCatalogEnabled(env)) {
    printWarn('工具清单已被 KHY_TOOL_CATALOG 禁用（当前为关闭状态）。');
    return true;
  }

  const raw = (subCommand && !subCommand.startsWith('-')) ? subCommand : (args[0] || '');
  const keyword = raw && !raw.startsWith('-') ? raw : '';
  let catalog = buildToolCatalog({}, env);
  if (keyword) catalog = _filterToolCatalog(catalog, keyword);

  if (options.json) {
    console.log(JSON.stringify(catalog, null, 2));
    return true;
  }

  console.log(chalk.bold('\n  🧰 khy 工具清单') + chalk.dim(`  (共 ${catalog.total} 个工具，可 /toollist <关键字> 过滤)\n`));
  if (catalog.total === 0) {
    printInfo(keyword ? `没有匹配「${keyword}」的工具。` : '当前没有可展示的工具。');
    return true;
  }
  for (const cat of catalog.categories) {
    console.log(chalk.bold.cyan(`  ${cat.label}`) + chalk.dim(`  (${cat.tools.length})`));
    for (const t of cat.tools) {
      const name = chalk.green(t.name.padEnd(22));
      const tag = t.readOnly ? chalk.dim('[只读]') : chalk.yellow(`[${t.risk}]`);
      console.log(`    ${name} ${tag}`);
      if (t.desc) console.log(chalk.dim(`      ${t.desc}`));
      if (Array.isArray(t.aliases) && t.aliases.length) {
        console.log(chalk.dim(`      别名: ${t.aliases.join(', ')}`));
      }
    }
    console.log('');
  }
  printInfo('这些是模型在推理中可调用的 AI 工具。斜杠命令请用 /features 浏览。');
  return true;
}

module.exports = {
  handleToolList,
  _filterToolCatalog,
};
