'use strict';

/**
 * isEnabledDefaultOn.js — 「按名读 env 门控·默认开·委派 flagRegistry 判定」共享 helper
 *   (非纯·只读 env·委派 flagRegistry·零文件/网络 IO·无状态·绝不抛)。
 *
 * 收敛 11 处 body 逐字节相同的私有门控判定(归一 md5 `e73985bd…`)——
 *   services/ 下:answerEchoGuard(名 `_isEnabledDefaultOn`)· diagnosticGrounding·
 *   diskAnalyzeCatalog· diskAnalyzeReport· externalAgentDirective· followThroughGuard·
 *   planModeDirective· roundAdvanceAssessor· upstreamStudyCatalog· upstreamStudyPlan·
 *   upstreamStudyReport(后 10 名 `_isEnabled`)——均内部私有(未导出)。
 *
 * 语义:env 缺省 process.env(带 `typeof process` 守卫)。委派
 *   `flagRegistry.isFlagEnabled(name, e)` 判定;require flagRegistry 失败 → 保守回退
 *   「缺值(undefined/null)→ true;否则仅显式 OFF_VALUES(0/false/off/no)关」。绝不抛。
 *
 * 契约:非纯(读 process.env·require flagRegistry 服务)·不 mutate 入参·绝不抛。
 *   各消费方保留同名本地(`_isEnabled` / `_isEnabledDefaultOn`):
 *   `const _isEnabled = require('../utils/isEnabledDefaultOn')` → 调用点逐字节不变。
 *   utils/ 与 services/ 同为 src/ 直属子目录→`../services/flagRegistry` 解析到原处
 *   `./flagRegistry` 同一模块。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _isEnabledDefaultOn(name, env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('../services/flagRegistry');
    return flagRegistry.isFlagEnabled(name, e);
  } catch {
    const raw = e && e[name];
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  }
}

module.exports = _isEnabledDefaultOn;
