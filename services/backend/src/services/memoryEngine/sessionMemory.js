'use strict';

/**
 * sessionMemory.js — 短期「会话内记忆」存储(记忆分层第 1 层)。
 *
 * 记忆分层五点里的第 1 点「短期会话内记忆」+ 第 5 点「遗忘」在**短期侧**的落地:
 *   - 存活范围 = 当前会话(= 当前进程)。**永不落盘**为 memdir 文件 —— 这正是
 *     memoryTier.forgetPolicy('short_term').expiresAtSessionEnd === true 的语义:
 *     会话结束(进程退出 / 显式 clear)即遗忘,不留任何持久痕迹。
 *   - 与持久层(memdir + proactive 引擎)互补:tier=short_term 的记忆路由到这里,
 *     其余 tier 仍写盘。recall 把本会话相关的短期记忆框成系统提示,供本轮使用。
 *
 * 设计:进程内单例存储(短期记忆天然有状态),其余皆纯逻辑;排序用确定性自增序号
 * (不读时钟,避免 Date.now 在本仓被禁);相关度复用 memdir 的同一套 tokenizer/overlap,
 * 不另造一份。env 门控 KHY_SESSION_MEMORY 默认开;任何异常 fail-soft,绝不破坏提示装配。
 */

const memdir = require('../../memdir');
const memoryTier = require('../memoryTier');

const FLAG = 'KHY_SESSION_MEMORY';
const OFF = new Set(['0', 'false', 'off', 'no']);

// 进程内短期记忆表 + 确定性自增序号(越大越新,用于 recency 次序与去重后排序)。
const _store = [];
let _seq = 0;

/** 默认开,仅显式 0/false/off/no 关。 */
function isEnabled() {
  return !OFF.has(String(process.env[FLAG] == null ? '' : process.env[FLAG]).trim().toLowerCase());
}

// 收敛到 utils/collapseWhitespace 单一真源(逐字节委托,调用点不变)
const _norm = require('../../utils/collapseWhitespace');

/**
 * 记下一条短期会话记忆。同名则按 memoryTier.decideUpdate 语义原地更新(信息更新),
 * 正文未变则跳过。tier 恒为 short_term(本存储即短期层),不接受其它 tier。
 *
 * @param {object} entry - { name, content, description? }
 * @returns {{ success:boolean, action?:'insert'|'supersede'|'skip', entry?:object, error?:string }}
 */
function remember(entry = {}) {
  if (!isEnabled()) return { success: false, error: 'session memory disabled' };
  const name = _norm(entry.name);
  const content = String(entry.content == null ? '' : entry.content).trim();
  if (!name) return { success: false, error: '缺少记忆标题(name)' };
  if (!content) return { success: false, error: '缺少记忆内容(content)' };
  const description = _norm(entry.description) || name;

  const existing = _store.find((m) => _norm(m.name) === name) || null;
  const decision = memoryTier.decideUpdate(
    existing ? { name: existing.name, body: existing.content, tier: memoryTier.TIERS.SHORT_TERM } : null,
    { name, body: content, tier: memoryTier.TIERS.SHORT_TERM },
  );

  if (decision.action === 'skip') {
    return { success: true, action: 'skip', entry: existing };
  }
  if (existing) {
    existing.content = content;
    existing.description = description;
    existing.seq = ++_seq;
    return { success: true, action: 'supersede', entry: existing };
  }
  const rec = { name, content, description, tier: memoryTier.TIERS.SHORT_TERM, seq: ++_seq };
  _store.push(rec);
  return { success: true, action: 'insert', entry: rec };
}

function _limit(opts) {
  const v = parseInt((opts && opts.limit) != null ? opts.limit : process.env.KHY_SESSION_MEMORY_LIMIT, 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

/**
 * 召回与 query 最相关的短期记忆,按 相关度 → 新近度 排序。无 query 时返回最近的若干条。
 * 相关度复用 memdir._tokenizeForRecall/_overlapCount(单一真源,不另造分词)。
 *
 * @param {string} query
 * @param {object} [opts] - { limit, minScore }
 * @returns {Array<{name,content,description,seq,score}>}
 */
function recall(query, opts = {}) {
  if (!isEnabled() || _store.length === 0) return [];
  const limit = _limit(opts);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 1;
  const q = _norm(query);

  let scored;
  if (!q) {
    // 无话题:返回最近加入的几条(纯新近度),score 记 0。
    scored = _store.map((m) => ({ ...m, score: 0 }));
  } else {
    let qTokens;
    try { qTokens = memdir._tokenizeForRecall(q); } catch { qTokens = new Set(); }
    scored = _store
      .map((m) => {
        let score = 0;
        try {
          score = memdir._overlapCount(qTokens, memdir._tokenizeForRecall(m.name)) * 3
            + memdir._overlapCount(qTokens, memdir._tokenizeForRecall(m.description)) * 2
            + memdir._overlapCount(qTokens, memdir._tokenizeForRecall(m.content)) * 1;
        } catch { score = 0; }
        return { ...m, score };
      })
      .filter((m) => m.score >= minScore);
  }
  scored.sort((a, b) => b.score - a.score || b.seq - a.seq);
  return scored.slice(0, limit);
}

/**
 * 把召回的短期记忆框成系统提示块(与持久层 proactive 块并列,但明确标注「短期/本会话」,
 * 并提示会话结束即遗忘)。无可呈现内容时返回 null(严格 no-op)。
 *
 * @param {string} query
 * @param {object} [opts]
 * @returns {string|null}
 */
function buildSection(query, opts = {}) {
  let hits;
  try { hits = recall(query, opts); } catch { return null; }
  if (!hits || hits.length === 0) return null;
  const header = [
    '[SESSION_MEMORY] 以下是你在**本次会话内**记下的短期记忆(会话结束即遗忘、不落盘)。',
    '如与当前请求相关,请据此保持上下文连贯;无关则忽略。',
  ].join('\n');
  const lines = hits.map((m) => {
    const snippet = (m.description && m.description !== m.name)
      ? m.description
      : String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return `- ${m.name}：${snippet}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

/** 当前短期记忆条数。 */
function size() { return _store.length; }

/** 当前短期记忆快照(浅拷贝,防外部改内部表)。 */
function list() { return _store.map((m) => ({ ...m })); }

/**
 * 遗忘全部短期记忆(会话结束 / 显式 /clear)。返回被清除的条数。这是「短期层」
 * 第 5 点「遗忘」的显式动作;即便不调用,进程退出也会自然遗忘(从不落盘)。
 * @returns {number}
 */
function clear() {
  const n = _store.length;
  _store.length = 0;
  return n;
}

module.exports = {
  isEnabled,
  remember,
  recall,
  buildSection,
  size,
  list,
  clear,
  FLAG,
};
