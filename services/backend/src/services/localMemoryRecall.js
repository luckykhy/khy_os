'use strict';

/**
 * localMemoryRecall.js — 纯叶子:把「本地记忆库的召回结果」整形成模型友好的结构 + 摘要。
 * 对齐 Claude Code「模型可主动调用记忆工具按需召回」——khy 此前只在拼提示词时被动注入记忆,
 * 模型无法在需要时自己去翻。本叶子是那个工具的纯计算核心。
 *
 * 契约:零 IO(不碰 fs/网络/子进程,只读 process.env 做门控)、确定性、绝不抛(fail-soft)、
 * env 门控 KHY_MEMORY_RECALL_TOOL 默认开。真正的读盘 + 排序(memdir.selectRelevantMemories /
 * searchMemories)由调用方(工具)完成并已是单一真源,本叶子只接收已读入、已排序的条目再整形,
 * 绝不另写一份排序/打分(那会与 memdir 的 scoring 漂移)。
 */

const DEFAULT_BODY_CHARS = 600; // 单条记忆正文预览上限(防一条长记忆撑爆返回)
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  // 记忆总开关 KHY_DISABLE_MEMORY 优先(与 memdir 一致):整库禁用则召回工具也下线。
  const disabled = env && (env.KHY_DISABLE_MEMORY === '1' || env.KHY_DISABLE_MEMORY === 'true');
  if (disabled) return false;
  const raw = env && env.KHY_MEMORY_RECALL_TOOL;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** 把请求的 limit 夹到 [1, MAX_LIMIT];非法 → 默认值。 */
function normalizeLimit(limit) {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function _truncate(text, n) {
  const s = String(text == null ? '' : text);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 整形 memdir.selectRelevantMemories 的结果(已排序、含 score)→ 模型友好结构。
 * @param {Array<{filename,frontmatter,body,score}>} selected
 * @param {object} [opts] - { bodyChars }
 * @returns {Array<{filename,name,type,description,score,body}>}
 */
function shapeRelevant(selected, opts = {}) {
  if (!Array.isArray(selected)) return [];
  const bodyChars = Number.isFinite(opts.bodyChars) && opts.bodyChars > 0 ? Math.floor(opts.bodyChars) : DEFAULT_BODY_CHARS;
  const out = [];
  for (const m of selected) {
    if (!m || typeof m !== 'object') continue;
    const fm = m.frontmatter || {};
    out.push({
      filename: m.filename || '',
      name: fm.name || '',
      type: fm.type || (fm.metadata && fm.metadata.type) || '',
      description: fm.description || '',
      score: Number.isFinite(m.score) ? m.score : 0,
      body: _truncate(m.body, bodyChars),
    });
  }
  return out;
}

/**
 * 整形 memdir.searchMemories 的结果(子串匹配,含 matches 行)→ 模型友好结构。
 * @param {Array<{filename,frontmatter,matches}>} results
 * @returns {Array<{filename,name,type,description,matches}>}
 */
function shapeSearch(results, opts = {}) {
  if (!Array.isArray(results)) return [];
  const maxMatches = Number.isFinite(opts.maxMatches) && opts.maxMatches > 0 ? Math.floor(opts.maxMatches) : 5;
  const out = [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const fm = r.frontmatter || {};
    out.push({
      filename: r.filename || '',
      name: fm.name || '',
      type: fm.type || (fm.metadata && fm.metadata.type) || '',
      description: fm.description || '',
      matches: Array.isArray(r.matches) ? r.matches.slice(0, maxMatches) : [],
    });
  }
  return out;
}

/** 召回结果的一行摘要(给模型 / CLI 看)。纯字符串。 */
function buildRecallSummary(query, shaped) {
  const n = Array.isArray(shaped) ? shaped.length : 0;
  const q = String(query || '').trim();
  if (n === 0) return `本地记忆库没有与「${q}」相关的记忆。`;
  return `从本地记忆库召回 ${n} 条与「${q}」相关的记忆。`;
}

module.exports = {
  isEnabled,
  DEFAULT_BODY_CHARS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  normalizeLimit,
  shapeRelevant,
  shapeSearch,
  buildRecallSummary,
};
