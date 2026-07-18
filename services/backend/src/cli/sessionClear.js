'use strict';

// sessionClear.js — 会话清空(/clear、/new、/reset、双 Ctrl+C)时复位网关熔断的
// 单一真源(SSOT)。REPL(src/cli/repl.js)与 Ink TUI(src/cli/tui/ink-components/App.js)
// 共用此叶子,避免两套 UI 分叉出「一处复位、另一处忘了」的经典缺口。
//
// 语义(对齐 CC「fresh start」):网关会话级熔断一旦跳闸会持续拦截后续调用;用户
// 主动清空会话时应把它也复位,让误锁可经 /clear 自愈。
//
// 门控 KHY_BREAKER_RESET_ON_NEW(默认开;仅显式 0/false/off/no/disable/disabled 关闭)。
// 零 IO、绝不抛(任何异常吞掉并返回 false,清空动作的其余步骤不受影响)。

const _OFF = ['0', 'false', 'off', 'no', 'disable', 'disabled'];

/**
 * 复位网关会话熔断。门控关或复位失败均安全返回 false,绝不抛。
 * @param {Record<string,string|undefined>} [env=process.env] 环境变量源(便于测试穿透)
 * @returns {boolean} 是否真正执行了复位(用于提示/测试)
 */
function resetGatewayBreakerOnSessionClear(env = process.env) {
  try {
    const v = String((env && env.KHY_BREAKER_RESET_ON_NEW) || '').trim().toLowerCase();
    if (_OFF.includes(v)) return false;
    const gw = require('../services/syscallGateway');
    if (typeof gw.resetAllSessions === 'function') gw.resetAllSessions();
    else if (typeof gw.resetSession === 'function') gw.resetSession();
    else return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { resetGatewayBreakerOnSessionClear };
