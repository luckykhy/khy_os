'use strict';

/**
 * toolNameVariants.js — 「工具名归一变体集」纯叶子(零 IO·确定性)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_toolNameVariants(name)`——
 *   services/toolCalling(内部调用·:495/:508)·
 *   services/toolExecutionEngine(内部调用·:103·原注「Mirrors toolCalling…kept local
 *     to avoid a reverse dependency」)。
 * 抽入中立 utils/ 正解消「反向依赖」顾虑:两 service 皆依赖 utils·互不依赖。
 *
 * 语义:给定工具名 → 返回归一变体去重数组(原样·snake_case·camelCase·全小写)·
 *   空/非串 → []。纯变换·不 mutate 入参·无副作用。
 *
 * 各消费方保留同名本地 `const _toolNameVariants = require('../utils/toolNameVariants')`
 *   → 调用点逐字节不变。
 */

function toolNameVariants(name) {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const variants = new Set([raw]);
  const snake = raw
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  variants.add(snake);
  variants.add(camel);
  variants.add(raw.toLowerCase());
  return [...variants].filter(Boolean);
}

module.exports = toolNameVariants;
