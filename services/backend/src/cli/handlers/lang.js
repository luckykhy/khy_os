'use strict';

/**
 * lang.js — `/lang` 命令薄壳:查看 / 设置输出语言偏好(zh / en / auto)。
 *
 * 对齐 Claude Code 的 /lang(设置 preferredLanguage)。khy 的语言注入早已就位:
 * prompts.js `getLanguageSection(KHY_LANGUAGE)` 在系统提示里下发语言指令,
 * config.js 已能 `config set language.preference <v>` 持久化 KHY_LANGUAGE。
 * 本命令只是补上缺失的 /菜单入口,真正的归一/解析逻辑在纯叶子 langPreference.js,
 * 持久化复用既有 config.js `set`(绝不另写一份 .env 落盘逻辑)。
 *
 * 门控 KHY_LANG_COMMAND 默认开;关 → 命令不接管(字节回退到「无此命令」的历史世界,
 * 用户仍可用 `config set language.preference`)。
 */

const { printInfo, printError } = require('../formatters');
const leaf = require('../../services/config/langPreference');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _enabled(env = process.env) {
  const raw = env && env.KHY_LANG_COMMAND;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * @param {string} subCommand 第一个位置参数(如 'zh' / 'en' / 'auto' / 'status')
 * @param {string[]} args 其余参数
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function handleLang(subCommand, args = [], options = {}) {
  if (!_enabled(process.env)) {
    printInfo('使用 `config set language.preference <zh|en|auto>` 设置输出语言。');
    return false;
  }

  const arg = String(subCommand || (Array.isArray(args) && args[0]) || '').trim();

  // 无参数 / 查看 → 只读显示当前生效语言。
  if (!arg || arg === 'status' || arg === 'show' || arg === 'get') {
    const { preference, source } = leaf.resolveActive(process.env);
    printInfo(`当前输出语言:${leaf.describeLanguage(preference)}${source === 'default' ? '(默认未覆盖)' : ''}`);
    printInfo('可选:`/lang zh`、`/lang en`、`/lang auto`');
    return true;
  }

  // 设置 → 归一校验后复用 config.js 既有持久化路径(单一落盘真源)。
  const norm = leaf.normalizeLanguage(arg);
  if (!norm) {
    printError(`不支持的语言:${arg}`);
    printInfo('可选:zh / en / auto');
    return false;
  }
  const { handleConfig } = require('./config');
  await handleConfig('set', ['language.preference', arg], options);
  return true;
}

module.exports = { handleLang };
