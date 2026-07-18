'use strict';

/**
 * bashListingSummary.js — 纯叶子:接缝1 的编排层。把「列目录类 Bash 命令的完整 stdout」在被
 * shellCommand._smartTruncate head+tail 盲截**之前**,解析回条目(listingParse)、喂 fileSalience
 * 抓重点摘要(summarizeListing + renderSalienceBlock),产出一段可**前置到输出顶部**的中文摘要。
 *
 * 背景(goal 2026-07-03「khy 分析 C/D 盘符 / 文件夹时文件太多抓不住重点」进一步修复):
 * 分析大目录时 agent 常绕过 ListDir 直接跑 `ls -R` / `find` / `tree` / `du` / `dir /s`(唯一能覆盖
 * du 体积、任意 shell 组合的通路),而这些海量清单在 shellCommand.js 被盲截,入口/大目录被淹没或
 * 删中段。本叶子在截断前插一层 salience 摘要,摘要必存(截断只砍原始清单)。
 *
 * 契约:零 I/O(只读 env 门控 + 委派两个纯叶子解析/摘要,不碰 fs/网络/子进程)、确定性、绝不抛
 * (fail-soft 返 null → 调用方逐字节回退纯截断)。门控 KHY_BASH_LISTING_SALIENCE 默认开;
 * 关 / 命令非列举 / 解析不足 / 条目数 < KHY_BASH_LISTING_MIN → null。
 *
 * @module services/bashListingSummary
 */

const { isSearchOrReadCommand } = require('../tools/shellClassifier');

/**
 * 从列目录命令的完整 stdout 产出前置摘要文本;不适用则返 null。绝不抛。
 * @param {string} command     命令原文(用于分类 + du 单位判定)
 * @param {string} fullOutput  截断前完整 stdout
 * @param {object} [env]       默认 process.env
 * @returns {string|null}
 */
function extractListingSummary(command, fullOutput, env) {
  try {
    const e = env || process.env;
    let flagRegistry;
    try { flagRegistry = require('./flagRegistry'); } catch { flagRegistry = null; }
    const gateOn = flagRegistry
      ? flagRegistry.isFlagEnabled('KHY_BASH_LISTING_SALIENCE', e)
      : !['0', 'false', 'off', 'no'].includes(String(e.KHY_BASH_LISTING_SALIENCE || '').trim().toLowerCase());
    if (!gateOn) return null;

    // 仅对「列举/搜索类」命令介入(ls/dir/tree/du = isList;find = isSearch,同为目录树枚举)。
    // RTK 代理会把命令改写为 `rtk find …` / `rtk ls …`——剥掉前缀再分类,否则 base=rtk 分类失败。
    const forClass = String(command || '').replace(/^\s*rtk\s+/i, '');
    const cls = isSearchOrReadCommand(forClass);
    if (!cls || (!cls.isList && !cls.isSearch)) return null;

    const { parseListing } = require('./listingParse');
    const parsed = parseListing(fullOutput, { command });
    if (!parsed.parsed || parsed.entries.length === 0) return null;

    const minN = flagRegistry
      ? flagRegistry.resolveNumeric('KHY_BASH_LISTING_MIN', e)
      : 30;
    if (parsed.entries.length < (Number.isFinite(minN) ? minN : 30)) return null;

    const fileSalience = require('./fileSalience');
    if (!fileSalience.isEnabled(e)) return null;
    const summary = fileSalience.summarizeListing(parsed.entries, { env: e, total: parsed.entries.length });
    const block = fileSalience.renderSalienceBlock(summary, { env: e });
    if (!block) return null;

    return `[Directory Summary] 共解析出 ${parsed.entries.length} 个条目(格式:${parsed.format});下方是完整原始输出。\n${block}\n\n--- 原始输出 ---\n`;
  } catch {
    return null;
  }
}

module.exports = { extractListingSummary };
