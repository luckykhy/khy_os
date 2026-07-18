'use strict';

/**
 * prCommentsFormat.js — 纯叶子 (pure leaf)：把一个 GitHub PR 的评论
 * (顶层讨论 comments / 评审 reviews / 行内代码评论 review-comments) 渲染成
 * 一段给用户看的中文块。对齐 Claude Code `/pr_comments`（把 PR 评论拉进上下文）。
 *
 * 契约 (CONTRACT)：零 IO、确定性、绝不抛、env 门控默认开 (KHY_PR_COMMENTS)。
 *   本叶子不连网/不 shell gh——所有评论数据由调用方 (handlers/prComments.js
 *   经 services/prCommentsService.js 跑 gh) 抓取后作为参数传入，叶子只做
 *   确定性的分组、排序稳定性无关（保持输入顺序）、截断与文案组装。
 *
 * 为什么存在 (缺口)：Claude Code 有 `/pr_comments` 把当前 PR 的评审/行内评论
 *   注入会话；khy 已经能 shell gh (forge/pr/subscribe-pr/ci) 但没有把 PR 评论
 *   浮现出来的命令。这是普查里「ABSENT + 实质逻辑 + 诚实可移植」的最强槽位。
 *
 * 诚实边界：
 *   - 只负责**文案**；gh 可用性探测、PR 号解析、REST 抓取全在 handler/service。
 *   - 门控关 / 坏输入 → 返回 null → handler 不接管（字节回退：命令视作未知）。
 *   - 仅 GitHub 结构 (gh pr view --json comments,reviews + REST pulls/:n/comments)；
 *     GitLab 的评论结构不同，service 层直接拒绝，不在此臆造。
 *   - 长评论体按字符截断（预算保护），只截显示不改数据。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 评审状态 → 友好中文。未列出的原样显示。
const REVIEW_STATE_LABELS = {
  APPROVED: '已批准',
  CHANGES_REQUESTED: '请求修改',
  COMMENTED: '评论',
  DISMISSED: '已忽略',
  PENDING: '待提交',
};

const BODY_CLIP = 600;

/** 是否启用 `/pr-comments`（门控 KHY_PR_COMMENTS 默认开）。 */
function prCommentsEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_PR_COMMENTS) || '').trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** 取评论作者（gh pr view 用 author.login；REST 行内评论用 user.login）。 */
function _who(x) {
  if (!x || typeof x !== 'object') return '未知';
  if (x.author && typeof x.author === 'object' && x.author.login) return String(x.author.login);
  if (x.user && typeof x.user === 'object' && x.user.login) return String(x.user.login);
  if (typeof x.author === 'string' && x.author) return x.author;
  return '未知';
}

/** 截断长评论体，压平首尾空白；只影响显示。 */
function _clip(body, n = BODY_CLIP) {
  const s = String(body == null ? '' : body).replace(/\r\n/g, '\n').trim();
  if (!s) return '(空)';
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

/**
 * 组装 PR 评论块。
 * @param {Object} data
 * @param {number} [data.prNumber]
 * @param {string} [data.title]
 * @param {string} [data.url]
 * @param {Array}  [data.comments]        顶层讨论：[{author:{login}, body}]
 * @param {Array}  [data.reviews]         评审：[{author:{login}, state, body}]
 * @param {Array}  [data.reviewComments]  行内代码评论：[{user:{login}, path, line, body}]
 * @param {Object} [env]
 * @returns {string|null} 多行文本，或 null（门控关 / 坏输入）
 */
function formatPrComments(data, env) {
  try {
    if (!prCommentsEnabled(env)) return null;
    if (!data || typeof data !== 'object') return null;

    const comments = Array.isArray(data.comments) ? data.comments : [];
    // 评审里状态为 COMMENTED 且 body 为空的是「行内评论的载体」，无独立内容，过滤掉。
    const reviews = (Array.isArray(data.reviews) ? data.reviews : []).filter((r) => {
      if (!r || typeof r !== 'object') return false;
      const hasBody = String(r.body || '').trim().length > 0;
      const meaningfulState = r.state && r.state !== 'COMMENTED';
      return hasBody || meaningfulState;
    });
    const reviewComments = Array.isArray(data.reviewComments) ? data.reviewComments : [];

    const lines = [];
    const num = data.prNumber != null ? `#${data.prNumber}` : '';
    const header = `PR ${num} ${String(data.title || '').trim()}`.replace(/\s+/g, ' ').trim();
    lines.push(header || 'PR 评论');
    if (data.url) lines.push(String(data.url));

    const total = comments.length + reviews.length + reviewComments.length;
    lines.push(
      `共 ${total} 条（讨论 ${comments.length}·评审 ${reviews.length}·行内 ${reviewComments.length}）`,
    );

    if (total === 0) {
      lines.push('暂无评论。');
      return lines.join('\n');
    }

    if (comments.length) {
      lines.push('');
      lines.push('讨论：');
      for (const c of comments) {
        lines.push(`  💬 @${_who(c)}: ${_clip(c && c.body)}`);
      }
    }

    if (reviews.length) {
      lines.push('');
      lines.push('评审：');
      for (const r of reviews) {
        const st = REVIEW_STATE_LABELS[r.state] || r.state || '';
        const tag = st ? ` [${st}]` : '';
        const body = String((r && r.body) || '').trim();
        lines.push(`  📝 @${_who(r)}${tag}${body ? `: ${_clip(body)}` : ''}`);
      }
    }

    if (reviewComments.length) {
      lines.push('');
      lines.push('行内评论：');
      for (const rc of reviewComments) {
        const path = String((rc && rc.path) || '').trim();
        const ln = rc && (rc.line != null ? rc.line : rc.original_line);
        const loc = path ? ` ${path}${ln != null ? `:${ln}` : ''}` : '';
        lines.push(`  📎 @${_who(rc)}${loc}: ${_clip(rc && rc.body)}`);
      }
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

module.exports = {
  prCommentsEnabled,
  formatPrComments,
  REVIEW_STATE_LABELS,
};
