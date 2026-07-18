'use strict';

/**
 * memoryContentDedup —— 纯叶子(pure leaf):记忆写入期「内容查重」决策器。
 *
 * 契约:零 IO(枚举/读取既有记忆的 IO 留在调用方,本叶子只接收已读入的数据)、
 * 确定性、单一真源(等价判据只在本文件)、env 门控默认开(`KHY_MEMORY_CONTENT_DEDUP`,
 * 仅 0/false/off/no 关闭,关闭即字节回退既有写入行为)、fail-soft 绝不抛。
 *
 * 背景(经源码核实):既有 `memoryTier.decideUpdate` 已处理「同名记忆」的 skip/supersede,
 * 但它按 (type,name) 派生的**文件名**判同一性——改了标题、正文不变的同义记忆会落到不同
 * 文件名,被当成新主题盲目新增,长期堆叠近重复副本(膨胀/上下文浪费)。本叶子补这一道:
 * 在「按文件名查无同名」即将插入前,对**正文**做归一化等价比对,命中则让调用方跳过新增。
 *
 * 零假阳性底线:写入期只认「归一化后**完全相等**」的正文(精确等价),绝不做模糊近似合并
 * ——模糊近重复由 distiller 在蒸馏期用 Jaccard 处理,写入期合并不同事实的风险太高。
 * "相同内容"即字面同内容,精确等价正是该诉求的安全实现。
 */

function _enabled() {
  const v = String(process.env.KHY_MEMORY_CONTENT_DEDUP || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 正文归一化:折叠所有空白(空格/制表/换行)为单空格、首尾去白、小写化
 * (小写对 latin 生效,对 CJK 为恒等)。确定性、无副作用。
 * @param {string} text
 * @returns {string}
 */
function normalizeBody(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 两段正文是否归一化后完全相等(且非空)。
 * @returns {boolean}
 */
function bodiesEquivalent(a, b) {
  const na = normalizeBody(a);
  const nb = normalizeBody(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * 在既有记忆列表里查找与候选正文内容等价的一条(异名同内容)。
 *
 * @param {{name?:string, body:string, filename?:string}} candidate - 待写入的候选记忆
 * @param {Array<{filename:string, name?:string, body:string}>} existingList - 已读入的既有记忆
 * @returns {{filename:string, name?:string}|null} 命中的既有记忆(取 filename 最先匹配),否则 null
 *
 * 关闭门控 / 入参非法 / 候选正文空 → 一律返回 null(不介入)。绝不抛。
 */
function findContentDuplicate(candidate, existingList) {
  if (!_enabled()) return null;
  try {
    if (!candidate || !Array.isArray(existingList)) return null;
    const body = normalizeBody(candidate.body);
    if (!body) return null;
    const selfName = candidate.filename || null;
    for (const m of existingList) {
      if (!m || !m.filename) continue;
      if (selfName && m.filename === selfName) continue; // 不与自身比
      if (bodiesEquivalent(candidate.body, m.body)) {
        return { filename: m.filename, name: m.name };
      }
    }
    return null;
  } catch {
    return null; // fail-soft
  }
}

module.exports = {
  normalizeBody,
  bodiesEquivalent,
  findContentDuplicate,
  _enabled,
};
