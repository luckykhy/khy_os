'use strict';

/**
 * deps.js — `khy deps` 命令:让客户按需查看 / 下载安装项目所缺的依赖工具链。
 *
 * khyos 在开发项目遇到缺失依赖(如 JDK)时,既有「依赖自愈层」(services/dependency)
 * 已能在工具调用失败时自动探测→询问→安装→复验→重试。本命令是**显式入口**,让客户
 * 主动驱动同一套机器,并能**按需指定版本**(「按客户需求」):
 *
 *   khy deps list                 列出已知依赖 + 是否就绪 + 是否可选版本
 *   khy deps versions <dep>       列出某工具链支持的版本(如 openjdk → 8/11/17/21)
 *   khy deps check <dep>          只探测某依赖是否已就绪(不安装)
 *   khy deps install <dep>[@ver]  按需(可选版本)下载安装,装后复验。例:khy deps install jdk@17
 *   khy deps --json               机器可读输出
 *
 * 薄 CLI 表层:所有探测 / 计划 / 安装委派 services/dependency 门面(单一真源)。
 * 安全红线沿用子系统:安装命令仅取自 curated 表(registry / toolchainVersions),
 * 绝不取自模型/报错文本;**绝不自动 sudo**——需提权只如实提示,由人决定。
 *
 * 依赖门面经 `deps` 参数注入(默认绑定真实子系统);测试注入纯内存桩,零网络零真实安装。
 */

const chalk = require('chalk').default || require('chalk');
const {
  printSuccess, printError, printWarn, printInfo, printTable,
} = require('../formatters');

/** 友好的别名 → depId 提示(用于「未知依赖」时给候选)。 */
function _knownIds(dep) {
  try { return dep.listDependencyIds(); } catch { return []; }
}

/** 探测单个依赖,返回 { id, present, detail }。绝不抛。 */
function _probe(dep, depId) {
  try { return dep.probe(depId); } catch { return { id: depId, present: false, detail: 'probe error' }; }
}

/** `khy deps list` — 概览所有依赖 + 就绪状态 + 版本可选标记。 */
function _list(dep, options) {
  let ids;
  try { ids = dep.listDependencyIds(); } catch (e) { printError(`无法读取依赖表: ${e && e.message}`); return; }
  const versionable = new Set();
  try { for (const v of dep.listVersionable()) versionable.add(v.depId); } catch { /* ignore */ }

  const rows = ids.map((id) => {
    const def = dep.getDependency(id) || {};
    const p = _probe(dep, id);
    return {
      id,
      label: def.label || id,
      present: !!p.present,
      versionable: versionable.has(id),
      scope: (def.install && def.install.scope) || '-',
    };
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ dependencies: rows }) + '\n');
    return;
  }

  printInfo(chalk.bold('khyos 可按需安装的依赖 / 工具链') +
    chalk.dim('  (缺失时开发过程中会自动询问安装;此处可主动查看 / 安装)'));
  const table = rows.map((r) => [
    r.id,
    r.present ? chalk.green('已就绪') : chalk.dim('缺失'),
    r.versionable ? chalk.cyan('可选版本') : chalk.dim('-'),
    r.scope,
    r.label,
  ]);
  printTable(['依赖', '状态', '版本', '作用域', '说明'], table);
  printInfo('按需安装:`khy deps install <依赖>[@版本]`,例 `khy deps install jdk@17`。');
  printInfo('看支持版本:`khy deps versions <依赖>`。');
}

/** `khy deps versions <dep>` — 列出某工具链支持的版本。 */
function _versions(dep, spec, options) {
  if (!spec) { printWarn('用法:khy deps versions <依赖>  (如 openjdk / python3 / dotnet)'); return; }
  const { depId } = dep.parseDepSpec(spec);
  if (!dep.isVersionable(depId)) {
    if (options.json) { process.stdout.write(JSON.stringify({ depId, versionable: false, versions: [] }) + '\n'); return; }
    printWarn(`${depId} 未登记按需版本(仅默认版本)。版本可选工具链:` +
      dep.listVersionable().map((v) => v.depId).join(', '));
    return;
  }
  const list = dep.listVersionable().find((v) => v.depId === depId) || { versions: [], default: null };
  if (options.json) {
    process.stdout.write(JSON.stringify({ depId, versionable: true, versions: list.versions, default: list.default }) + '\n');
    return;
  }
  printInfo(chalk.bold(`${depId} 支持的版本`) + (list.default ? chalk.dim(`  默认 ${list.default}`) : ''));
  for (const v of list.versions) {
    printInfo(`  • ${chalk.cyan(v)}${v === list.default ? chalk.dim(' (默认)') : ''}`);
  }
  printInfo(`安装指定版本:\`khy deps install ${depId}@<版本>\``);
}

/** `khy deps check <dep>` — 仅探测,不安装。 */
function _check(dep, spec, options) {
  if (!spec) { printWarn('用法:khy deps check <依赖>'); return; }
  const { depId } = dep.parseDepSpec(spec);
  if (!dep.getDependency(depId)) {
    printError(`未知依赖:${depId}(可选:${_knownIds(dep).join(', ')})`);
    return;
  }
  const p = _probe(dep, depId);
  if (options.json) { process.stdout.write(JSON.stringify(p) + '\n'); return; }
  if (p.present) printSuccess(`${depId} 已就绪:${p.detail || ''}`);
  else printWarn(`${depId} 缺失:${p.detail || '未安装'}。可运行 \`khy deps install ${depId}\` 安装。`);
}

/** `khy deps install <dep>[@ver]` — 按需(可选版本)安装,装后复验。 */
async function _install(dep, spec, options) {
  if (!spec) { printWarn('用法:khy deps install <依赖>[@版本]  (如 jdk@17)'); return; }
  const { depId, version } = dep.parseDepSpec(spec);
  const def = dep.getDependency(depId);
  if (!def) {
    printError(`未知依赖:${depId}(可选:${_knownIds(dep).join(', ')})`);
    return;
  }

  const env = dep.defaultEnv();

  // 已就绪则免装(幂等;诚实告知)。
  const before = _probe(dep, depId);
  if (before.present && !options.force) {
    if (options.json) { process.stdout.write(JSON.stringify({ depId, alreadyPresent: true, probe: before }) + '\n'); return; }
    printSuccess(`${depId} 已就绪(${before.detail || ''}),无需安装。加 --force 可强制重装。`);
    return;
  }

  const plan = dep.buildInstallPlan(depId, env, { version });
  if (!plan) {
    printError(`${depId} 无可用安装计划(本平台无预置命令)。请参考:${def.docsUrl || '官方文档'}`);
    return;
  }

  if (!options.json) {
    printInfo(chalk.bold(`准备安装 ${plan.label}`) +
      (plan.version ? chalk.cyan(`  版本 ${plan.version}`) : '') +
      (plan.versionUnavailable ? chalk.yellow(`  (请求版本 ${plan.requestedVersion} 本平台无预置映射,改用默认版本)`) : ''));
    printInfo(`  命令:${chalk.cyan(plan.displayCommand)}`);
    if (plan.requiresElevation) {
      printWarn('  此为系统级安装,可能需要管理员权限(sudo)。khyos 不会替你提权;' +
        '若因权限失败,请手动以管理员身份重跑上述命令。');
    }
  }

  // 隔离执行(命令仅来自 curated 计划;runInstall 绝不 sudo、绝不经 shell 拼接)。
  const result = await dep.runInstall(plan, { cwd: env.cwd });

  // 装后复验:必须真就绪才算成功(与自愈层一致,绝不「装了就当好」)。
  const after = _probe(dep, depId);
  const ok = !!(result && result.ok) && after.present;

  if (options.json) {
    process.stdout.write(JSON.stringify({
      depId, version: plan.version, requestedVersion: plan.requestedVersion,
      versionUnavailable: plan.versionUnavailable,
      command: plan.displayCommand, install: result, verified: after.present, ok,
    }) + '\n');
    return;
  }

  if (ok) {
    printSuccess(`${plan.label}${plan.version ? ' ' + plan.version : ''} 安装完成并已校验就绪。`);
    return;
  }
  if (result && result.ok && !after.present) {
    printWarn(`安装命令已执行,但 ${depId} 仍未探测到就绪(${after.detail || ''})。` +
      '可能需重开终端刷新 PATH,或手动确认安装位置。');
    return;
  }
  // 安装失败:给出精准归因(包管理器缺失链接 / 提权提示),绝不静默。
  if (result && result.hint) {
    printError(`安装失败:${result.hint}`);
  } else if (plan.requiresElevation) {
    printError(`安装失败(${result && result.error || 'exit-nonzero'})。系统级安装通常需提权,` +
      `请手动运行:${chalk.cyan((process.platform === 'win32' ? '' : 'sudo ') + plan.displayCommand)}`);
  } else {
    printError(`安装失败(${result && result.error || 'unknown'})。请检查网络/权限,或参考 ${plan.docsUrl || '官方文档'}。`);
  }
}

function _help() {
  printInfo('khy deps — 按需查看 / 下载安装项目所缺的依赖工具链');
  printInfo('  khy deps list                 列出已知依赖 + 就绪状态 + 是否可选版本');
  printInfo('  khy deps versions <dep>       列出工具链支持的版本(如 openjdk → 8/11/17/21)');
  printInfo('  khy deps check <dep>          仅探测是否已就绪(不安装)');
  printInfo('  khy deps install <dep>[@ver]  按需(可选版本)下载安装并复验,例 `khy deps install jdk@17`');
  printInfo('  khy deps --json               机器可读输出');
  printInfo(chalk.dim('  注:开发中缺依赖时,khyos 会在工具调用失败处自动询问安装;此命令是主动入口。'));
}

/**
 * Handle the `khy deps` command.
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options - parsed flags ({ json, force })
 * @param {object} [deps] - injected services/dependency facade (default: real)
 * @returns {Promise<boolean>} true (command handled)
 */
async function handleDeps(subCommand, args = [], options = {}, deps = null) {
  const dep = deps || require('../../services/dependency');
  const sub = String(subCommand || 'list').toLowerCase();

  if (sub === 'help' || options.help) { _help(); return true; }
  if (sub === 'list' || sub === 'ls') { _list(dep, options); return true; }
  if (sub === 'versions' || sub === 'version') { _versions(dep, args[0], options); return true; }
  if (sub === 'check' || sub === 'probe') { _check(dep, args[0], options); return true; }
  if (sub === 'install' || sub === 'add') { await _install(dep, args[0], options); return true; }

  // 未知子命令:保守走 help,避免把任意字符串误当依赖名直接安装。
  printWarn(`未知子命令:deps ${subCommand}`);
  _help();
  return true;
}

module.exports = { handleDeps };
