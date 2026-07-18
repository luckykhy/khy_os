'use strict';

/**
 * envFlagByName.js — 「按名读 process.env 的布尔标志」单一真源(remote/* 家族)。
 *
 * 收敛 src/ 下 4 处逐字节相同的私有 `_envFlag(name, fallback)`
 * (services/remote/remoteStatePersistence · remoteFileTransferService · deployOrchestrator ·
 *  remoteExecService):
 *   读 `process.env[name]`;未设(null)或 trim 后为空 → fallback;
 *   否则 trim+lowercase ∈ {'1','true','yes','on','enabled'} → true,其余 → false。
 *
 * **注意语义**:未知值(如 'maybe')返回 false 而非 fallback——只有 null/空串走 fallback。
 *
 * **刻意不收敛**:services/queryEngine 的 `_envFlag(value, fallback)` 是**值型**(非按名读 env)、
 *   带独立 off-set 且未知值返 fallback、on-set 含 y/n——签名与语义不同,留原样(C 组)。
 *   亦区别于 utils/parseBoolean(值型·无 'enabled')与 utils/resolveEnv(取整个 env 对象)。
 *
 * 契约:确定性、不 mutate、恒返布尔。读全局 process.env(非纯·name-based env 读取惯用)。
 *
 * 各消费方保留同名本地 `const _envFlag = require('.../envFlagByName')` → 调用点逐字节不变。
 */

function envFlagByName(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

module.exports = envFlagByName;
