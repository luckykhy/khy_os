'use strict';

/**
 * dedupeText.js — 「文本数组 trim + 去重(保序·丢空)」单一真源(纯)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_dedupeText`——
 *   services/capabilityAssessment · services/toolUseLoopCore(能力评估的证据/理由列表清洗)。
 *
 * 语义:遍历 items,每项 String(item||'').trim();空或已见过则跳过;否则记入 Set 并 push。
 *   => 去空白项、去重复项、保留首现顺序、统一 trim 后的字符串。
 *
 * 契约:纯函数、确定性、不 mutate 入参、返回新数组。
 *   各消费方保留同名本地 `const _dedupeText = require('.../dedupeText')`→ 调用点逐字节不变。
 */

function dedupeText(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const normalized = String(item || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

module.exports = dedupeText;
