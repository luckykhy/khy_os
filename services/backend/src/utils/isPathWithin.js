'use strict';

const path = require('path');

/**
 * isPathWithin.js — 「target 路径是否被 parent 目录包含(含相等)」单一真源(纯·安全)。
 *
 * 收敛 3 处 body 逐字节相同的私有 `_isPathWithin`——
 *   services/gateway/adapters/codexAdapter · cli/handlers/init · cli/handlers/gateway
 *   (均判定 HOME 是否落在临时目录内的 tmp-home 风险探测)。
 *
 * 语义:parent/target 各 trim;任一空→false。resolve 两端后取 path.relative,
 *   rel==='' (相等) 或 (不以 '..' 开头且非绝对) → true(target 在 parent 之内);否则 false。
 *   resolve/relative 抛错(极端非法路径)→ 兜底 false(fail-closed·安全默认拒绝)。
 *
 * 安全:统一路径包含判定口径防各处分叉出不一致的包含逻辑(临时目录/越权路径误判风险)。
 *   fail-closed:异常一律返 false 而非 true——宁可漏报包含也不误判「在范围内」。
 *
 * 契约:纯函数、确定性、不 mutate 入参、无 fs IO(仅 path 纯计算)。
 *   各消费方保留同名本地 `const _isPathWithin = require('.../isPathWithin')`→ 调用点逐字节不变。
 */

function isPathWithin(parent = '', target = '') {
  const base = String(parent || '').trim();
  const value = String(target || '').trim();
  if (!base || !value) return false;
  try {
    const rel = path.relative(path.resolve(base), path.resolve(value));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

module.exports = isPathWithin;
