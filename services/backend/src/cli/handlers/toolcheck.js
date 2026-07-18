'use strict';

/**
 * ToolCheck Command Handler — khy 工具契约体检（审计工具注册表的精准可用性）。
 *
 * 承 goal「保证 khy 工具的精准可用性，每个小工具都能达到预期的目的」:
 * `/toolcheck` 在主交互面(TUI/CLI)对整个工具注册表跑一次契约巡检——形状、schema、
 * 命名冲突——把「坏工具 / 跨风险冲突」当场列出。消费单一 SSOT
 * (services/toolCatalog/toolContract.auditTools,读工具注册表)。
 *
 * 与 `/toollist`(工具清单)互补:
 *   - /toollist   → 有哪些工具（分组浏览）
 *   - /toolcheck  → 这些工具是否合契约、是否互相冲突（质量巡检）
 *
 * 用法:
 *   toolcheck            跑全量契约审计并打印 error/warning + 汇总
 *   toolcheck --json     机器可读输出
 *
 * 门控 KHY_TOOL_CONTRACT 默认开;关 → 不巡检,提示不可用（守卫脚本不受此门控影响）。
 *
 * @module handlers/toolcheck
 */
const chalk = require('chalk').default || require('chalk');
const { printInfo, printWarn, printError } = require('../formatters');

/**
 * @param {string} subCommand   第一个位置参数(未使用,占位对齐)
 * @param {string[]} args        其余位置参数
 * @param {object} options       parseInput 解析的 --flags
 */
async function handleToolCheck(subCommand, args = [], options = {}) {
  const env = process.env;
  const { auditTools, toolContractEnabled } = require('../../services/toolCatalog/toolContract');

  if (!toolContractEnabled(env)) {
    printWarn('工具契约审计已被 KHY_TOOL_CONTRACT 禁用（当前为关闭状态）。CI 守卫 check-tool-contract.js 不受此开关影响。');
    return true;
  }

  const report = auditTools({}, env);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return true;
  }

  console.log(chalk.bold('\n  🔎 khy 工具契约体检')
    + chalk.dim(`  (共 ${report.total} 个工具 · ${report.errors} error / ${report.warnings} warning)\n`));

  if (report.findings.length === 0) {
    printInfo('全部工具合契约，无命名冲突。工具地基精准可用。');
    return true;
  }

  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warning');

  if (errors.length) {
    console.log(chalk.bold.red(`  ✗ ${errors.length} 个 error（需修复）`));
    for (const f of errors) {
      console.log(`    ${chalk.red('✗')} ${chalk.dim('[' + f.rule + ']')} ${chalk.bold(f.tool)}`);
      console.log(chalk.dim(`      ${f.message}`));
    }
    console.log('');
  }
  if (warnings.length) {
    console.log(chalk.bold.yellow(`  ⚠ ${warnings.length} 个 warning（同类孪生，已在模型清单折叠去重）`));
    for (const f of warnings) {
      console.log(`    ${chalk.yellow('⚠')} ${chalk.dim('[' + f.rule + ']')} ${f.tool}`);
      console.log(chalk.dim(`      ${f.message}`));
    }
    console.log('');
  }

  if (errors.length) {
    printError(`发现 ${errors.length} 个契约 error——工具解析可能不确定，请修复后再依赖这些工具。`);
  } else {
    printInfo('无 error：无跨风险/跨类别命名冲突，工具解析确定。warning 为同类孪生（信息性）。');
  }
  return true;
}

module.exports = {
  handleToolCheck,
};
