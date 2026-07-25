'use strict';

/**
 * thinkback.js — `/thinkback` 命令薄壳:khy-native 使用回顾(对齐 Claude Code `/thinkback`)。
 *
 * 真正的「背后逻辑」(门控 + 聚合数据 → 回顾行)在纯叶子 thinkbackReport.js;本薄壳只做 IO:
 *   1. 门控 + 解析 `--days N`(默认 30);
 *   2. 取本地使用数据(tokenUsageService.getUsageHistory 按日聚合)与习惯画像
 *      (usageHabitService.getHabitSummary);
 *   3. 注入 ccFormatTokens(与 khy 其余 token 面同一 SSOT)→ 叶子构造回顾行 → 打印。
 *
 * **诚实边界(核心)**:CC 的 /thinkback 是 plugin/marketplace + 终端动画 + Statsig 门的
 * 「Year in Review」;khy **不复刻**云端/动画层,只对**本地既有使用数据**做确定性、离线、
 * 可复现的回顾——无模型也可用,绝不外发数据。数据不足 → 如实提示,绝不编造。
 *
 * 门控 KHY_THINKBACK 默认开;关 → 命令不接管(printInfo 提示后返回,镜像 handlers 家族)。
 *
 * 用法:
 *   /thinkback            (默认近 30 天)
 *   /thinkback --days 7   (近 7 天;1..365)
 */

const { printInfo, printError } = require('../formatters');
const thinkbackReport = require('../thinkbackReport');

const _DEFAULT_DAYS = 30;
const _MAX_DAYS = 365;

/** 从 args 解析 --days N(1..365;缺/坏 → 默认)。纯本地扫描(不依赖 router 通用解析)。 */
function _parseDays(subCommand, args) {
  const all = [subCommand, ...(Array.isArray(args) ? args : [])]
    .map((a) => String(a == null ? '' : a))
    .filter((a) => a.length > 0);
  for (let i = 0; i < all.length; i += 1) {
    const tok = all[i];
    let raw = null;
    if ((tok === '--days' || tok === '-d') && i + 1 < all.length) raw = all[i + 1];
    const m = /^--days=(.*)$/.exec(tok);
    if (m) raw = m[1];
    if (raw != null) {
      const n = Math.floor(Number(raw));
      if (Number.isFinite(n) && n >= 1) return Math.min(n, _MAX_DAYS);
      return _DEFAULT_DAYS;
    }
  }
  return _DEFAULT_DAYS;
}

/** token 格式器:注入 ccFormatTokens(fail-soft → 朴素整数串)。 */
function _tokenFormatter() {
  try {
    const { ccFormatEnabled, ccFormatTokens } = require('../ccFormat');
    if (ccFormatEnabled(process.env)) {
      return (n) => {
        const out = ccFormatTokens(Number(n));
        return out || String(Math.floor(Number(n) || 0));
      };
    }
  } catch { /* fail-soft */ }
  return (n) => String(Math.floor(Number(n) || 0));
}

/**
 * @param {string} subCommand 第一个位置参数
 * @param {string[]} args 其余参数
 * @returns {Promise<boolean>}
 */
async function handleThinkback(subCommand, args = [], _options = {}) {
  if (!thinkbackReport.thinkbackEnabled(process.env)) {
    printInfo('使用回顾功能已关闭(KHY_THINKBACK)。');
    return true;
  }

  const days = _parseDays(subCommand, args);

  let history = [];
  try {
    history = require('../../services/tokenUsageService').getUsageHistory(days) || [];
  } catch (e) {
    printError(`读取使用数据失败:${e && e.message ? e.message : e}`);
  }

  let habits = {};
  try {
    habits = require('../../services/usageHabitService').getHabitSummary() || {};
  } catch { /* best-effort:习惯画像可选 */ }

  const periodLabel = `近 ${days} 天`;
  let lines = [];
  try {
    lines = thinkbackReport.buildThinkbackReport(
      { history, habits, periodLabel },
      process.env,
      { fmtTokens: _tokenFormatter() },
    );
  } catch (e) {
    printError(`生成使用回顾失败:${e && e.message ? e.message : e}`);
    return true;
  }

  for (const l of lines) printInfo(l);
  return true;
}

module.exports = { handleThinkback, _parseDays };
