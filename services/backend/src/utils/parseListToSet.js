'use strict';

/**
 * parseListToSet.js — 「逗号/空白分隔的 env 列表 → 小写去重 Set」单一真源(纯)。
 *
 * 收敛 3 处 body 逐字节相同的私有 helper:
 *   raw 非字符串→空 Set;否则按 /[,\s]+/ 切,每段 trim+lowercase,非空则加入 Set(去重)。
 *   (gateway/adapterVisionCapability.parseAdapterListEnv ·
 *    gateway/modelToolingCapability.parseModelListEnv ·
 *    gateway/visionCapability.parseModelListEnv)。
 *
 * **刻意不收敛(不可互委)**:
 *   - 不 lowercase、或保留大小写、或不去重(返数组)的变体。
 *   - 用不同分隔符(仅逗号 / 仅空白)的变体。
 *
 * 契约:纯函数、确定性、不 mutate 入参。每次返回**新** Set。正则为函数内字面量
 *   (无 g 标志、无 lastIndex 状态)。
 *
 * 各消费方保留同名本地 `const NAME = require('.../parseListToSet')`→ 调用点逐字节不变。
 */

function parseListToSet(raw) {
  const out = new Set();
  if (!raw || typeof raw !== 'string') return out;
  for (const part of raw.split(/[,\s]+/)) {
    const v = part.trim().toLowerCase();
    if (v) out.add(v);
  }
  return out;
}

module.exports = parseListToSet;
