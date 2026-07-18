'use strict';

/**
 * prComments.js — `/pr-comments` 命令入口（薄壳）。对齐 Claude Code `/pr_comments`：
 * 把当前（或指定）GitHub PR 的评论拉进会话，供接续讨论/修复参考。
 *
 * 分层：
 *   - IO（shell gh）      → services/prCommentsService.js::fetchPrComments
 *   - 纯文案（渲染/截断） → cli/prCommentsFormat.js::formatPrComments
 *   - 本 handler          → 解析 PR 号、串联两者、打印
 *
 * 门控 KHY_PR_COMMENTS 默认开；关 → 命令不接管（返回 false，字节回退：命令视作未知）。
 */

const { printInfo, printError } = require('../formatters');
const { prCommentsEnabled, formatPrComments } = require('../prCommentsFormat');

/** 从 subCommand + args 里找第一个形如 `123` / `#123` 的 PR 号。 */
function _parsePrNumber(subCommand, args) {
  const tokens = [subCommand, ...(Array.isArray(args) ? args : [])];
  for (const t of tokens) {
    const s = String(t == null ? '' : t).trim();
    const m = /^#?(\d+)$/.exec(s);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * `/pr-comments [<PR 号>]` 入口。
 * @param {string} subCommand
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<boolean>} 是否接管该命令（门控关 → false）。
 */
async function handlePrComments(subCommand, args = [], options = {}) {
  if (!prCommentsEnabled(process.env)) {
    printInfo('pr-comments 命令未启用（KHY_PR_COMMENTS 为关）。');
    return false;
  }

  const cwd = (options && options.cwd) || process.env.KHYQUANT_CWD || process.cwd();
  const prNumber = _parsePrNumber(subCommand, args);

  let data;
  try {
    const svc = require('../../services/prCommentsService');
    data = await svc.fetchPrComments({ cwd, prNumber });
  } catch (e) {
    printError(`获取 PR 评论失败：${(e && e.message) || e}`);
    return true;
  }

  if (!data || !data.success) {
    printError((data && data.error) || '获取 PR 评论失败。');
    return true;
  }

  const text = formatPrComments(data, process.env);
  if (text) {
    printInfo(text);
  } else {
    // 门控在抓取后被关，或渲染返回空——退化为最简可读输出。
    printInfo(`PR #${data.prNumber} ${data.title || ''}`.trim());
  }
  return true;
}

module.exports = { handlePrComments };
