'use strict';

/**
 * Lazy Command Handler — `khy lazy …`.
 *
 * 「懒人资深工程师 / 最小代码方法论」(学自 ponytail)的命令行面。判定逻辑与数据全在
 * 纯叶子 `services/codeLaziness`(单一真源);本 handler 只做 IO(走树读文件、打印、
 * 经 config._writeEnvPatch 持久化开关 —— 用户最高权限,绝不让用户自己去文件里改)。
 *
 *   lazy [ladder]        — 打印「懒人阶梯」与铁律(只读,来自叶子 LADDER/RULES SSOT)
 *   lazy debt            — 收割全树 `// lazy:` 标记成债务台账(deferral 不会悄悄变 never)
 *   lazy level <lvl>     — 设强度 lite|full|ultra(持久化 KHY_CODE_LAZINESS_LEVEL)
 *   lazy on | off        — 开/关懒人方法论(持久化 KHY_CODE_LAZINESS)
 *
 * @module handlers/lazy
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk').default || require('chalk');
const { printInfo, printError, printTable, printSuccess } = require('../formatters');
const cl = require('../../services/codeLaziness');

// 收割覆盖的文本扩展名(常见栈即可,debt 标记多在源码注释里)。
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.sh', '.bash',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.go', '.rs', '.java', '.rb', '.php',
  '.css', '.scss', '.html', '.md', '.lua', '.swift', '.kt',
]);
const SKIP_DIR = new Set(['node_modules', 'bundled', '_source', 'dist', 'build', 'coverage', 'vendor', '.git']);
const MAX_FILES = 20000; // lazy: 平面上限防超大树扫描失控,真要无界再换流式遍历

/** 递归收集文本源文件(跳过依赖/构建/隐藏目录)。 */
function _walk(dir, acc) {
  if (acc.length >= MAX_FILES) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (acc.length >= MAX_FILES) break;
    if (ent.name.startsWith('.') || SKIP_DIR.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) _walk(full, acc);
    else if (ent.isFile() && TEXT_EXT.has(path.extname(ent.name))) acc.push(full);
  }
  return acc;
}

function _handleLadder() {
  printInfo(chalk.bold('懒人阶梯 —— 写任何代码前,停在第一条成立的横档(学自 ponytail):'));
  for (const r of cl.LADDER) printInfo(`  ${r.n}. ${r.text}`);
  printInfo('');
  printInfo(chalk.bold('铁律:'));
  for (const r of cl.RULES) printInfo(`  • ${r}`);
  printInfo('');
  printInfo(chalk.bold('绝不偷懒的事:'));
  for (const r of cl.NEVER_LAZY) printInfo(`  • ${r}`);
  printInfo('');
  printInfo(`当前强度:${cl.resolveLevel(process.env)}（改:khy lazy level <lite|full|ultra>）`);
  printInfo('开/关:khy lazy on | khy lazy off（或直接说「关闭懒人模式」）。');
  return 0;
}

function _handleDebt(rootDir) {
  const root = rootDir || process.cwd();
  const files = _walk(root, []);
  const loaded = [];
  for (const f of files) {
    let content = '';
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    loaded.push({ path: path.relative(root, f).split(path.sep).join('/'), content });
  }
  const rows = cl.harvestDebtMarkers(loaded);
  const sum = cl.summarizeDebt(rows);
  if (sum.total === 0) {
    printSuccess('没有 lazy: 债务。台账干净。');
    return 0;
  }
  printInfo(`懒人债务台账 ${sum.total} 条(扫描 ${loaded.length} 个文本源,${sum.noTrigger} 条无升级路径会悄悄烂掉):`);
  const tableRows = rows.map((r) => [
    `${r.file}:${r.line}`,
    r.ceiling || '-',
    r.upgrade || (r.hasTrigger ? '-' : chalk.yellow('no-trigger')),
  ]);
  printTable(['位置', '上限(简化点)', '升级路径(触发器)'], tableRows);
  printInfo(`合计 ${sum.total} 条标记,其中 ${sum.noTrigger} 条无触发器(优先补升级路径或落实)。`);
  return 0;
}

function _persist(envKey, value, deps) {
  const writeEnvPatch = (deps && typeof deps.writeEnvPatch === 'function')
    ? deps.writeEnvPatch
    : require('./config')._writeEnvPatch;
  return writeEnvPatch({ [envKey]: value });
}

function _handleLevel(level, deps) {
  const lv = String(level || '').trim().toLowerCase();
  if (!cl.LEVELS.includes(lv)) {
    printError(`未知强度:${level || '(空)'}。可选:${cl.LEVELS.join(' | ')}。`);
    return 1;
  }
  try {
    const p = _persist('KHY_CODE_LAZINESS_LEVEL', lv, deps);
    printSuccess(`✅ 懒人强度已设为 ${lv}（KHY_CODE_LAZINESS_LEVEL=${lv}）。已即时生效并持久化。`);
    printInfo(`已写入:${p}`);
    return 0;
  } catch (e) {
    printError(`无法持久化:${(e && e.message) || e}`);
    return 1;
  }
}

function _handleToggle(turnOn, deps) {
  const value = turnOn ? 'true' : 'off';
  try {
    const p = _persist('KHY_CODE_LAZINESS', value, deps);
    printSuccess(`✅ 懒人方法论${turnOn ? '已开启' : '已关闭'}（KHY_CODE_LAZINESS=${value}）。已即时生效并持久化。`);
    printInfo(`已写入:${p}`);
    return 0;
  } catch (e) {
    printError(`无法持久化:${(e && e.message) || e}`);
    return 1;
  }
}

/**
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 * @param {object} [deps] - { writeEnvPatch, rootDir } 可注入便于测试
 * @returns {number}
 */
function handleLazy(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'ladder').toLowerCase();
  if (sub === 'help' || options.help) {
    printInfo('用法: lazy [ladder] | lazy debt | lazy level <lite|full|ultra> | lazy on | lazy off');
    return 0;
  }
  if (!sub || sub === 'ladder' || sub === 'show') return _handleLadder();
  if (sub === 'debt' || sub === 'ledger') return _handleDebt(deps.rootDir);
  if (sub === 'level') return _handleLevel(args[0], deps);
  if (sub === 'on') return _handleToggle(true, deps);
  if (sub === 'off') return _handleToggle(false, deps);
  printError(`未知子命令:${sub}`);
  printInfo('用法: lazy [ladder] | debt | level <lite|full|ultra> | on | off');
  return 1;
}

module.exports = { handleLazy };
