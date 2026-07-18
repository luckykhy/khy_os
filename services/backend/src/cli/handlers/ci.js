'use strict';

/**
 * ci.js — `khy ci` command handler: report CI/CD pipeline status from the CLI.
 *
 * Thin CLI surface over services/ciStatusService. Reads the latest CI run for
 * the current branch via `gh` (GitHub Actions) / `glab` (GitLab CI), classifies
 * it pass/fail/pending, and renders a one-line verdict. `ci watch` polls until a
 * terminal state (or timeout) so you can wait on a green build without leaving
 * the terminal.
 *
 * Usage:
 *   khy ci [status]        当前分支最新 CI 状态（pass / fail / pending）
 *   khy ci watch           轮询直至 CI 结束（成功 / 失败 / 超时）
 *   khy ci --json          机器可读输出
 *   khy ci --branch <b>    指定分支（默认当前分支）
 *
 * Requires gh（GitHub）或 glab（GitLab）已安装并登录；缺失时 fail-soft 给出提示。
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printInfo, printWarn, printError, printSuccess } = require('../formatters');

/**
 * Map a classification to a colored, emoji-prefixed label.
 * Pure & deterministic (no IO) so it can be unit-tested directly.
 * @param {string} classification - 'pass' | 'fail' | 'pending' | 'unknown'
 * @returns {string}
 */
function formatClassification(classification) {
  switch (String(classification || '').toLowerCase()) {
    case 'pass': return chalk.green('✅ 通过 (pass)');
    case 'fail': return chalk.red('❌ 失败 (fail)');
    case 'pending': return chalk.yellow('⏳ 进行中 (pending)');
    default: return chalk.gray('❔ 未知 (unknown)');
  }
}

/**
 * Build the ciStatusService options from parsed CLI flags.
 * Pure & deterministic (no IO).
 * @param {object} options - flat parsed flags ({ branch, cwd })
 * @returns {object} ciStatusService options
 */
function buildStatusOptions(options = {}) {
  const opt = {};
  const branch = String(options.branch || '').trim();
  if (branch) opt.branch = branch;
  const cwd = String(options.cwd || '').trim();
  if (cwd) opt.cwd = cwd;
  return opt;
}

function _printHelp() {
  printInfo('khy ci — 查看当前分支的 CI/CD 流水线状态');
  printInfo('  khy ci [status]      当前分支最新 CI 状态（pass / fail / pending）');
  printInfo('  khy ci watch         轮询直至 CI 结束（成功 / 失败 / 超时）');
  printInfo('  khy ci --branch <b>  指定分支（默认当前分支）');
  printInfo('  khy ci --json        机器可读输出');
  printInfo('  需要已安装 gh（GitHub）或 glab（GitLab）并已登录。');
}

function _renderStatus(result) {
  if (result && result.error) {
    printError(`❌ ${result.error}`);
    return;
  }
  printInfo(`平台：${result.platform || '?'}`);
  printInfo(`状态：${formatClassification(result.classification)}` +
    (result.status ? chalk.gray(`  [${result.status}${result.conclusion ? '/' + result.conclusion : ''}]`) : ''));
  if (result.name) printInfo(`工作流：${result.name}`);
  if (result.url) printInfo(result.url);
}

/**
 * Handle the `khy ci` command.
 * @param {string} subCommand - 'status' | 'watch' | 'help' | undefined (defaults to status)
 * @param {string[]} args
 * @param {object} options - parsed flags
 * @param {object} [deps] - injectable for tests: { checkCIStatus, pollCIStatus }
 * @returns {Promise<boolean>} true (command handled)
 */
async function handleCi(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'status').toLowerCase();

  if (sub === 'help' || options.help) {
    _printHelp();
    return true;
  }

  const svc = require('../../services/ciStatusService');
  const checkCIStatus = deps.checkCIStatus || svc.checkCIStatus;
  const pollCIStatus = deps.pollCIStatus || svc.pollCIStatus;
  const opt = buildStatusOptions(options);

  // ── watch: poll until terminal state ──────────────────────────────
  if (sub === 'watch') {
    if (!options.json) printInfo(chalk.cyan('👀 正在轮询 CI 状态（直至结束或超时）…'));
    let result;
    try {
      result = await pollCIStatus({
        ...opt,
        onPoll: options.json ? undefined : (r) => {
          printInfo(chalk.gray(`  …${r.classification} [${r.status}]`));
        },
      });
    } catch (err) {
      result = { error: (err && err.message) || String(err) };
    }
    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return true;
    }
    if (result && result.error) {
      printError(`❌ ${result.error}`);
    } else if (result && result.classification === 'pass') {
      printSuccess(`✅ CI 通过（${result.polls} 次轮询）`);
      if (result.url) printInfo(result.url);
    } else if (result && result.classification === 'fail') {
      printError(`❌ CI 失败（${result.polls} 次轮询）`);
      if (result.url) printInfo(result.url);
    } else {
      printWarn(`⏳ 未在限定时间内结束（${(result && result.status) || 'timeout'}）`);
    }
    return true;
  }

  if (sub !== 'status') {
    printWarn(`未知子命令：ci ${subCommand}`);
    _printHelp();
    return true;
  }

  // ── status: single check ──────────────────────────────────────────
  let result;
  try {
    result = checkCIStatus(opt);
  } catch (err) {
    result = { error: (err && err.message) || String(err) };
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return true;
  }
  _renderStatus(result);
  return true;
}

module.exports = { handleCi, buildStatusOptions, formatClassification };
