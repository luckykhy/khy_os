'use strict';

/**
 * sessionTag.js — 纯叶子:`/tag` 的确定性核心。
 *
 * 契约:零 IO、零业务 require、确定性、fail-soft 绝不抛、env 门控默认开
 * (`KHY_TAG`,仅 `0/false/off/no` 关闭)、单一真源。读/写 session 元数据的副作用全留在
 * 薄壳 `handlers/tag.js`;本叶子只对**已读入的标签数组**做纯集合变换:解析参数、切换
 * (toggle)、去重、保序。
 *
 * 对齐 Claude Code `/tag`:给会话打可搜索标签;**同一标签再打一次 = 移除**(toggle)。
 * 因 `updateSessionMetadata` 是浅合并(整组 `tags` 覆盖),必须由本叶子算出完整新数组再交
 * 薄壳写回 —— 这正是把「读现状→算增删→写整组」的决策收敛为单一真源。
 */

function isEnabled(env) {
  const raw = env && env.KHY_TAG;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 规范化单个标签:转串、trim、内部空白折叠为单空格。空 → null。 */
function normalizeTag(tag) {
  if (tag == null) return null;
  const t = String(tag).trim().replace(/\s+/g, ' ');
  return t === '' ? null : t;
}

/**
 * 把参数 token 流解析成规范化标签数组(支持空格与逗号分隔),保序去重。
 * @returns {string[]}
 */
function parseTagArgs(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (raw == null) continue;
    for (const piece of String(raw).split(',')) {
      const t = normalizeTag(piece);
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

/**
 * 切换标签:对每个 requested,存在则移除、不存在则加入(toggle)。保序去重。
 * @param {string[]} existing  现有标签(来自 session 元数据)
 * @param {string[]} requested 本次请求的标签(已规范化更好,这里再防呆)
 * @returns {{ tags: string[], added: string[], removed: string[] }}
 */
function applyTags(existing, requested) {
  // 现有标签:规范化 + 保序去重。
  const cur = [];
  const curSet = new Set();
  for (const e of Array.isArray(existing) ? existing : []) {
    const t = normalizeTag(e);
    if (t && !curSet.has(t)) { curSet.add(t); cur.push(t); }
  }
  const req = parseTagArgs(requested);
  const added = [];
  const removed = [];
  const removeSet = new Set();
  for (const t of req) {
    if (curSet.has(t)) {
      removeSet.add(t);
      removed.push(t);
    } else {
      curSet.add(t);
      cur.push(t);
      added.push(t);
    }
  }
  const tags = cur.filter((t) => !removeSet.has(t));
  return { tags, added, removed };
}

module.exports = { isEnabled, normalizeTag, parseTagArgs, applyTags };
