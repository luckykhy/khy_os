'use strict';

/**
 * proactive.js — `/proactive` 命令薄壳:开/关 khy 的主动 idle-tick 模式。对齐 Claude Code 的 /proactive
 * (Toggle proactive autonomous tick-driven mode)。
 *
 * **背后逻辑**(语法解析 + 期望态推导 + 文本渲染)在纯叶子 services/assistant/proactiveTogglePlan.js
 * (单一真源·零 IO);本薄壳只做:门控、读当前态、把 activate/deactivate **委托既有 assistant/index.js 的
 * wired 激活路径**(它已把 onTick 接到真实消费者 —— 记忆 dream 整理,绝不另起一个没有 tick 消费者的空定时器)、
 * 渲染。
 *
 * 诚实边界:khy 的 tick 消费者是后台记忆 dream 整理,不是「模型在 tick 间自主工作」(CC 的语义);
 * 文案如实描述 khy 真实机制。委托 assistant.activate 会一并启用助手日志面(assistant 的既有耦合);
 * status 同时透出 proactive 与 assistantMode 两态,对用户透明,绝不隐瞒。
 *
 * 用法:`/proactive [on|off|toggle|status]`(空参 = toggle)。门控 KHY_PROACTIVE_COMMAND 默认开;
 * 关 → 命令不接管(字节回退)。
 */

const { printInfo, printError } = require('../formatters');
const leaf = require('../../services/assistant/proactiveTogglePlan');

// try/catch combinator 单一真源 utils/tryOr:执行 fn,任何异常 → dflt。
const _safe = require('../../utils/tryOr');

/** assistant SSOT(wired activate/deactivate/getStatus)。 */
function _assistant() {
  return _safe(() => require('../../assistant'), null);
}

/** 采当前自治快照(best-effort;缺面 → 字段 undefined,叶子诚实留白)。 */
function _snapshot() {
  const a = _assistant();
  if (!a || typeof a.getStatus !== 'function') {
    // 退一步直接读 proactive 层(仍是既有 SSOT,不另写)。
    const active = _safe(() => require('../../assistant/proactive').isProactiveActive(), undefined);
    return { proactive: active };
  }
  const st = _safe(() => a.getStatus(), null) || {};
  return {
    proactive: st.proactive,
    assistantMode: st.active,
    dreamNeeded: st.dreamNeeded,
    dreamReason: st.dreamReason,
    lastDream: st.lastDream,
  };
}

/**
 * `/proactive` 入口。
 * @param {string} _subCommand
 * @param {string[]} [args]
 * @param {object} [_options]
 * @returns {Promise<boolean>} 是否接管该命令(门控关 → false)。
 */
async function handleProactive(_subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('Proactive 命令未启用(KHY_PROACTIVE_COMMAND 为关)。');
    return false;
  }

  const parsed = leaf.parseProactiveArgs(args);

  if (parsed.action === 'help') {
    printInfo(leaf.buildHelpText());
    return true;
  }

  if (!parsed.valid && parsed.parseError === 'unknown_action') {
    printError(`未知子命令。${leaf.buildHelpText()}`);
    return true;
  }

  if (parsed.action === 'status') {
    printInfo(leaf.buildStatusText(_snapshot()));
    return true;
  }

  // on / off / toggle —— 由「当前态 + 动作」推导期望态,只在真变化时调既有 wired 路径。
  const before = _snapshot();
  const { desired, changes } = leaf.resolveToggle(before.proactive === true, parsed.action);

  if (changes) {
    const a = _assistant();
    if (desired) {
      _safe(() => { if (a && typeof a.activate === 'function') a.activate(); }, null);
    } else {
      _safe(() => { if (a && typeof a.deactivate === 'function') a.deactivate(); }, null);
    }
  }

  printInfo(leaf.buildToggleResult(desired, changes));
  // 切换后再采一次,透出真实结果态(含 assistantMode 透明披露)。
  printInfo(leaf.buildStatusText(_snapshot()));
  return true;
}

module.exports = { handleProactive };
