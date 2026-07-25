'use strict';

/**
 * pr.js — `khy pr` command handler: create a pull/merge request from the CLI.
 *
 * Thin CLI surface over services/prCreateService. Wires the live model
 * (cli/ai.chat) as the AI description generator and renders the result.
 * Wraps `gh pr create` (GitHub) / `glab mr create` (GitLab); the model writes
 * a title + body from the branch diff, then the platform CLI opens the PR/MR.
 *
 * Usage:
 *   khy pr [create] [自由文本说明…]   创建 PR/MR（AI 自动生成标题+正文）
 *   khy pr --base <branch>            指定目标分支（默认探测 origin HEAD）
 *   khy pr --title "..." [--body ...] 跳过 AI 生成，直接用给定标题/正文
 *   khy pr --draft                    创建草稿 PR/MR
 *   khy pr --json                     机器可读输出
 *
 * Dependency direction stays cli→services: the model is injected into the
 * service via deps.callModel so prCreateService never reverse-requires cli/ai.
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printInfo, printWarn, printError, printSuccess } = require('../formatters');

/**
 * Single-shot model call, injected into prCreateService as deps.callModel.
 * Mirrors cli/handlers/learn.js _directCallModel: keep services decoupled from
 * cli/ai (no R1 layering inversion). fail-soft: returns '' on any failure so the
 * service falls back to a branch-name title rather than throwing.
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<{reply?:string, content?:string}|string>}
 */
async function _directCallModel(prompt, opts) {
  try {
    const aiMod = require('../ai');
    const ai = typeof aiMod === 'function' ? aiMod() : aiMod;
    if (!ai || typeof ai.chat !== 'function') return '';
    return await ai.chat(prompt, opts);
  } catch {
    return '';
  }
}

/**
 * Map parsed CLI flags + positional args to prCreateService.createPR options.
 * Pure & deterministic (no IO) so it can be unit-tested directly.
 * @param {string[]} args - positional tokens after `pr [create]`
 * @param {object} options - flat parsed flags ({ base, title, body, draft })
 * @returns {object} createPR options
 */
function buildCreateOptions(args = [], options = {}) {
  const opt = {};
  const base = String(options.base || options.target || '').trim();
  if (base) opt.base = base;
  const title = String(options.title || '').trim();
  if (title) opt.title = title;
  const body = typeof options.body === 'string' ? options.body : '';
  if (body) opt.body = body;
  if (options.draft) opt.draft = true;

  // Free-text positional args become a context hint for the AI description.
  const rest = (Array.isArray(args) ? args : [])
    .filter((a) => a != null && !String(a).startsWith('-'))
    .map((a) => String(a).trim())
    .filter(Boolean);
  if (rest.length) opt.userContext = rest.join(' ');
  return opt;
}

function _printHelp() {
  printInfo('khy pr — 从命令行创建 PR / MR（AI 生成标题与正文）');
  printInfo('  khy pr [create] [说明…]      当前分支 → 目标分支，AI 自动写标题/正文');
  printInfo('  khy pr --base <branch>        指定目标分支（默认 origin HEAD）');
  printInfo('  khy pr --title "..." [--body] 跳过 AI，直接用给定标题/正文');
  printInfo('  khy pr --draft                创建草稿');
  printInfo('  khy pr --json                 机器可读输出');
  printInfo('  需要已安装 gh（GitHub）或 glab（GitLab）。');
}

/**
 * Handle the `khy pr` command.
 * @param {string} subCommand - 'create' | 'help' | undefined (defaults to create)
 * @param {string[]} args
 * @param {object} options - parsed flags
 * @param {object} [deps] - injectable for tests: { createPR, callModel }
 * @returns {Promise<boolean>} true (command handled)
 */
async function handlePr(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'create').toLowerCase();

  if (sub === 'help' || options.help) {
    _printHelp();
    return true;
  }
  if (sub !== 'create') {
    printWarn(`未知子命令：pr ${subCommand}`);
    _printHelp();
    return true;
  }

  const createPR = deps.createPR || require('../../services/prCreateService').createPR;
  const callModel = deps.callModel || _directCallModel;
  const opt = buildCreateOptions(args, options);

  if (!options.json) {
    printInfo(chalk.cyan('🔀 正在创建 PR / MR …') + (opt.title ? '' : ' （AI 生成标题/正文）'));
  }

  let result;
  try {
    result = await createPR({ callModel }, opt);
  } catch (err) {
    result = { success: false, error: (err && err.message) || String(err) };
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return true;
  }

  if (result && result.success) {
    printSuccess(`✅ 已创建：${result.title || '(无标题)'}`);
    if (result.url) printInfo(result.url);
  } else {
    printError(`❌ 创建失败：${(result && result.error) || '未知错误'}`);
  }
  return true;
}

module.exports = { handlePr, buildCreateOptions };
