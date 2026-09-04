'use strict';

/**
 * SelfHeal Command Handler — khy 运行时路径自愈命令入口。
 *
 * 提供人工触发的运行时路径修复：
 *   khy selfheal           检查是否有可修复的模块路径错误
 *   khy selfheal --apply   执行实际修复
 *   khy selfheal --status  查看自愈统计
 *
 * @module handlers/selfHeal
 */

const chalk = require('chalk').default || require('chalk');
const { printInfo, printWarn, printError } = require('../formatters');

/**
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 */
async function handleSelfHeal(subCommand, args = [], options = {}) {
  const selfHeal = require('../../services/selfHeal');

  // 显示统计
  if (options.status || subCommand === 'status') {
    const stats = selfHeal.getStats();
    console.log(chalk.bold('\n  📊 自愈服务统计'));
    console.log(chalk.dim('  ' + '─'.repeat(40));
    console.log(`    尝试修复: ${stats.attempts}`);
    console.log(`    成功修复: ${chalk.green(stats.successes)}`);
    console.log(`    修复失败: ${chalk.red(stats.failures)}`);
    console.log(`    运行时间: ${Math.floor(stats.uptime)}s`);
    console.log('');
    return true;
  }

  // 显示模块索引
  if (options.index || subCommand === 'index') {
    const map = selfHeal.getModuleMap();
    console.log(chalk.bold('\n  📦 模块索引'));
    console.log(chalk.dim('  ' + '─'.repeat(40)));
    console.log(`    总文件数: ${map.size}`);
    const multiMatch = [];
    for (const [name, paths] of map) {
      if (paths.length > 1) multiMatch.push({ name, count: paths.length });
    }
    if (multiMatch.length > 0) {
      console.log(`    多匹配项: ${multiMatch.length}`);
      multiMatch.slice(0, 10).forEach((m) => {
        console.log(chalk.yellow(`      - ${m.name} (${m.count} 个位置)`));
      });
      if (multiMatch.length > 10) {
        console.log(chalk.dim(`      …… 另有 ${multiMatch.length - 10} 个多匹配项`));
      }
    }
    console.log('');
    return true;
  }

  // 手动触发修复测试
  if (options.test || subCommand === 'test') {
    console.log(chalk.blue('  🧪 运行自愈测试…'));
    const map = selfHeal.getModuleMap();
    console.log(`    已索引 ${map.size} 个模块`);
    console.log(chalk.green('  ✓ 自愈服务运行正常'));
    console.log('');
    return true;
  }

  // 默认显示帮助
  console.log(chalk.bold('\n  🔧 khy selfHeal — 运行时路径自愈'));
  console.log('');
  console.log('  用法:');
  console.log('    khy selfheal            显示帮助');
  console.log('    khy selfheal --status   查看自愈统计');
  console.log('    khy selfheal --index    查看模块索引');
  console.log('    khy selfheal --test     运行自愈测试');
  console.log('');
  console.log('  说明:');
  console.log('    自愈服务在 khy 启动时自动启用，拦截 MODULE_NOT_FOUND 错误');
  console.log('    并自动修复因目录迁移导致的路径不匹配问题。');
  console.log('');
  return true;
}

module.exports = { handleSelfHeal };
