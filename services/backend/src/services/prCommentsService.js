'use strict';

/**
 * prCommentsService.js — `/pr-comments` 的 IO 层：shell `gh` 抓取一个 GitHub PR 的
 * 顶层讨论 / 评审 / 行内代码评论，返回结构化数据。**非纯叶子**（做 child_process IO）。
 *
 * 与 prCreateService.js 同族（都 shell gh）。抓取用两条命令：
 *   1) gh pr view [<n>] --json number,title,url,comments,reviews
 *        —— 未给 PR 号时 gh 用当前分支推断 PR。
 *   2) gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate
 *        —— 行内代码评论（gh 自动填充 {owner}/{repo}）。
 *
 * 诚实边界：
 *   - 仅 GitHub（detectPlatform()==='github'）；GitLab 结构不同，直接给出可读拒绝。
 *   - 只读：从不修改任何人的 PR / 评论。
 *   - fail-soft：任一 gh 调用失败返回 {success:false, error}；行内评论抓取失败
 *     不致命（降级为空列表 + 顶层数据仍返回）。
 *   - 门控由上层 handler / 叶子负责；本 service 只做抓取。
 */

const { spawnSync } = require('child_process');
const { detectPlatform } = require('./prCreateService');

const GH_TIMEOUT_MS = 20000;

function _gh(args, cwd) {
  try {
    const r = spawnSync('gh', args, {
      cwd,
      encoding: 'utf-8',
      timeout: GH_TIMEOUT_MS,
      stdio: 'pipe',
    });
    if (!r || r.error) {
      return { ok: false, error: (r && r.error && r.error.message) || '无法执行 gh' };
    }
    if (r.status !== 0) {
      const msg = String((r.stderr || r.stdout || '')).trim() || `gh 退出码 ${r.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, stdout: String(r.stdout || '').trim() };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function _parseJson(s, dflt) {
  try {
    const v = JSON.parse(s);
    return v == null ? dflt : v;
  } catch {
    return dflt;
  }
}

/**
 * 抓取一个 GitHub PR 的评论。
 * @param {Object} [options]
 * @param {string} [options.cwd]        仓库工作目录
 * @param {number} [options.prNumber]   PR 号；缺省则由当前分支推断
 * @returns {Promise<Object>} {success, prNumber, title, url, comments, reviews, reviewComments} 或 {success:false, error}
 */
async function fetchPrComments(options = {}) {
  const cwd = options.cwd || process.env.KHYQUANT_CWD || process.cwd();

  let platform = null;
  try {
    platform = detectPlatform();
  } catch {
    platform = null;
  }
  if (platform !== 'github') {
    return {
      success: false,
      error:
        platform === 'gitlab'
          ? '/pr-comments 目前仅支持 GitHub（gh）。GitLab 请用 glab mr note list。'
          : '未找到 GitHub CLI（gh）。安装：https://cli.github.com/ ，并 gh auth login。',
    };
  }

  const viewArgs = ['pr', 'view'];
  if (options.prNumber != null && String(options.prNumber).trim()) {
    viewArgs.push(String(options.prNumber).trim());
  }
  viewArgs.push('--json', 'number,title,url,comments,reviews');

  const view = _gh(viewArgs, cwd);
  if (!view.ok) {
    return {
      success: false,
      error: `获取 PR 失败：${view.error}（可显式指定 PR 号：/pr-comments <号>）`,
    };
  }

  const pr = _parseJson(view.stdout, null);
  if (!pr || typeof pr.number !== 'number') {
    return {
      success: false,
      error: '未找到当前分支对应的 PR（可显式指定 PR 号：/pr-comments <号>）。',
    };
  }

  const prNumber = pr.number;

  // 行内代码评论走 REST；失败不致命，降级空列表。
  const inline = _gh(
    ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`, '--paginate'],
    cwd,
  );
  const reviewComments = inline.ok ? _parseJson(inline.stdout, []) : [];

  return {
    success: true,
    prNumber,
    title: pr.title || '',
    url: pr.url || '',
    comments: Array.isArray(pr.comments) ? pr.comments : [],
    reviews: Array.isArray(pr.reviews) ? pr.reviews : [],
    reviewComments: Array.isArray(reviewComments) ? reviewComments : [],
  };
}

module.exports = { fetchPrComments };
