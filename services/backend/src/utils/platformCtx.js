'use strict';

/**
 * platformCtx.js — 「解析当前平台上下文(id + appliesTo 白名单判定器)」共享 helper
 *   (非纯·委派 envPlatform 服务·envPlatform 读 process.platform 等运行时信号·绝不抛)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_platformCtx()`——
 *   services/envProbes(内部用·runProbes :261)· services/envRepair(内部用·runRepairs :137)。
 *
 * 语义:`require('../services/envPlatform')` → `detectPlatform()` 取 `{ id }`,
 *   连同 `appliesTo` 白名单判定器返回 `{ id, appliesTo }`;require/探测任何失败 →
 *   保守回退 `{ id: 'linux', appliesTo: () => true }`(fail-soft 降级 linux·全放行)。绝不抛。
 *
 * 契约:非纯(委派 envPlatform·其读运行时平台信号)·无状态·不 mutate·绝不抛。
 *   各消费方保留同名本地 `const _platformCtx = require('../utils/platformCtx')`
 *   → 调用点逐字节不变。utils/ 与 services/ 同为 src/ 直属子目录,
 *   `../services/envPlatform` 解析到原处 `./envPlatform` 同一模块。
 */

function _platformCtx() {
  try {
    const ep = require('../services/envPlatform');
    const plat = ep.detectPlatform();
    return { id: plat.id, appliesTo: ep.appliesTo };
  } catch {
    return { id: 'linux', appliesTo: () => true };
  }
}

module.exports = _platformCtx;
