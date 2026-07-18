'use strict';

/**
 * markProcessFailure.js — 「幂等置进程失败码」单一真源。
 *
 * 收敛 src/ 下 2 处逐字节相同的私有 `_markFailure()`
 * (services/publish/publishUtils · cli/handlers/verify):
 *   `if (!process.exitCode || process.exitCode === 0) { process.exitCode = 1; }`。
 *   仅当当前退出码为假值/0 时置 1;已是非零则保留首个失败码(不覆盖)。
 *
 * 契约:幂等(重复调用不改已非零码)、无入参、无返回。
 * **写全局 process.exitCode(副作用)——非纯**;副作用边界隔离在此单一函数内。
 *
 * 消费方保留同名本地 `const _markFailure = require('../../utils/markProcessFailure')` → 调用点逐字节不变。
 * publishUtils 经 module.exports 再导出 `_markFailure`:委托后本地绑定仍在,导出行为不变。
 */

function markProcessFailure() {
  if (!process.exitCode || process.exitCode === 0) {
    process.exitCode = 1;
  }
}

module.exports = markProcessFailure;
