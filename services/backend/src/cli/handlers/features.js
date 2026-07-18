'use strict';

/**
 * Features Command Handler — khy 功能索引（把所有可发现命令按类分组列出）。
 *
 * 承 goal「khyos 应把设计的功能在 TUI 与前端网页 UI 中充分暴露，不要有了功能用户
 * 却不知去哪用」：`/features` 在主交互面(TUI/CLI)打印一张按类别分组的命令总索引，
 * 与后端 `GET /api/commands`、前端 FeatureCatalog 视图消费**同一** SSOT
 * (services/commandCatalog/commandCatalog.buildCommandCatalog)。
 *
 * 用法：
 *   features               列出全部功能(按类别分组)
 *   features <keyword>     只显示命令名/标签/描述匹配关键字的条目
 *   features --json        机器可读输出(与 HTTP 端点同结构)
 *
 * 门控 KHY_COMMAND_CATALOG 默认开；关 → 目录为空，提示不可用。
 *
 * @module handlers/features
 */
const chalk = require('chalk').default || require('chalk');
const { printInfo, printWarn } = require('../formatters');

/** 关键字过滤：命令名 / 标签 / 描述任一命中(大小写不敏感)。 */
function _filterCatalog(catalog, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return catalog;
  const categories = [];
  for (const cat of catalog.categories) {
    const commands = cat.commands.filter((c) =>
      c.cmd.toLowerCase().includes(kw)
      || c.label.toLowerCase().includes(kw)
      || (c.desc && c.desc.toLowerCase().includes(kw))
      || (Array.isArray(c.aliases) && c.aliases.some((a) => a.toLowerCase().includes(kw))));
    if (commands.length) categories.push({ ...cat, commands });
  }
  const total = categories.reduce((n, c) => n + c.commands.length, 0);
  return { ...catalog, categories, total };
}

/**
 * @param {string} subCommand   第一个位置参数(当作关键字)
 * @param {string[]} args        其余位置参数
 * @param {object} options       parseInput 解析的 --flags
 */
async function handleFeatures(subCommand, args = [], options = {}) {
  const env = process.env;
  const { buildCommandCatalog, commandCatalogEnabled } = require('../../services/commandCatalog/commandCatalog');

  if (!commandCatalogEnabled(env)) {
    printWarn('功能索引已被 KHY_COMMAND_CATALOG 禁用（当前为关闭状态）。');
    return true;
  }

  const raw = (subCommand && !subCommand.startsWith('-')) ? subCommand : (args[0] || '');
  const keyword = raw && !raw.startsWith('-') ? raw : '';
  let catalog = buildCommandCatalog({}, env);
  if (keyword) catalog = _filterCatalog(catalog, keyword);

  if (options.json) {
    console.log(JSON.stringify(catalog, null, 2));
    return true;
  }

  console.log(chalk.bold('\n  🧭 khy 功能索引') + chalk.dim(`  (共 ${catalog.total} 项命令，可 /features <关键字> 过滤)\n`));
  if (catalog.total === 0) {
    printInfo(keyword ? `没有匹配「${keyword}」的命令。` : '当前没有可展示的命令。');
    return true;
  }
  for (const cat of catalog.categories) {
    console.log(chalk.bold.cyan(`  ${cat.label}`) + chalk.dim(`  (${cat.commands.length})`));
    for (const c of cat.commands) {
      const name = chalk.green(c.cmd.padEnd(18));
      const label = c.label && c.label !== c.name ? chalk.white(c.label) : '';
      console.log(`    ${name} ${label}`);
      if (Array.isArray(c.aliases) && c.aliases.length) {
        console.log(chalk.dim(`      别名: ${c.aliases.join('、')}`));
      }
      if (c.desc) console.log(chalk.dim(`      ${c.desc}`));
    }
    console.log('');
  }
  printInfo('直接键入命令即可执行，例如 /help、/status、/cost。前端网页也可在「功能索引」页浏览。');
  return true;
}

module.exports = {
  handleFeatures,
  _filterCatalog,
};
