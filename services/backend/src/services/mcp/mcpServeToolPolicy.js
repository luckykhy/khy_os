'use strict';

/**
 * mcpServeToolPolicy.js — 纯叶子:`khy mcp serve` 对外暴露哪些工具的策略层(单一真源)。
 *
 * 定位:用户拍板「暴露全部已启用工具」(经 tools/index.getEnabled(),含 shell/文件写/破坏性),
 * 但仍把策略收口成一个叶子——好处:①可观测(启动横幅要在 stderr 报「本次暴露 N 个工具、含破坏性
 * yes/no」);②可后续收紧(readonly/safe 模式无需改传输层);③纯过滤,不碰 registry(叶子契约)。
 *
 * 契约:零 IO(只读 process.env 做门控)、确定性、绝不抛。入参 `selectExposedTools` 的工具数组由
 * **调用方**传入(`[...getEnabled().values()]`),本叶子不 require registry,保持纯。
 * 门控随 KHY_MCP_SERVE(读法复用 mcpServerProtocol.isServeEnabled 的等价本地逻辑);关 →
 * resolveExposeMode 恒回缺省 'all' 但上游根本不会起 server,故策略层无副作用。
 */

const { RISK_ORDER } = require('../../constants/riskOrder');

// ── 暴露模式 ────────────────────────────────────────────────────────────────
// all      → 全部已启用工具(尊重用户拍板,缺省)。
// safe     → 只读工具 + 风险 ∈ {safe, low} 的写工具。
// readonly → 仅 isReadOnly() 为真的工具。
const EXPOSE_MODES = Object.freeze({ ALL: 'all', SAFE: 'safe', READONLY: 'readonly' });
const _VALID_MODES = new Set([EXPOSE_MODES.ALL, EXPOSE_MODES.SAFE, EXPOSE_MODES.READONLY]);

/**
 * 从 env 解析暴露模式。读 KHY_MCP_SERVE_EXPOSE,缺省 / 未知 → 'all'(尊重用户拍板)。绝不抛。
 * @param {object} [env]
 * @returns {'all'|'safe'|'readonly'}
 */
function resolveExposeMode(env = process.env) {
  const e = env || {};
  const raw = String(e.KHY_MCP_SERVE_EXPOSE == null ? '' : e.KHY_MCP_SERVE_EXPOSE).trim().toLowerCase();
  return _VALID_MODES.has(raw) ? raw : EXPOSE_MODES.ALL;
}

/**
 * 安全读一个工具的只读性(behavioral 声明可能抛/缺失 → 保守当 false=非只读)。
 * @param {object} tool
 * @returns {boolean}
 */
function _isReadOnly(tool) {
  try {
    return typeof tool.isReadOnly === 'function' ? !!tool.isReadOnly() : false;
  } catch { return false; }
}

/**
 * 安全读一个工具的风险 ordinal(未知 → medium=2)。
 * @param {object} tool
 * @returns {number}
 */
function _riskOrdinal(tool) {
  const r = tool && typeof tool.risk === 'string' ? tool.risk : 'medium';
  const ord = RISK_ORDER[r];
  return typeof ord === 'number' ? ord : RISK_ORDER.medium;
}

/**
 * 纯过滤:从已启用工具数组里按模式选出要暴露的工具。绝不抛。
 * @param {Array<object>} enabledTools - 调用方传入的 [...getEnabled().values()]
 * @param {'all'|'safe'|'readonly'} mode
 * @returns {Array<object>}
 */
function selectExposedTools(enabledTools, mode) {
  const list = Array.isArray(enabledTools) ? enabledTools.filter(Boolean) : [];
  const m = _VALID_MODES.has(mode) ? mode : EXPOSE_MODES.ALL;
  if (m === EXPOSE_MODES.ALL) return list;
  if (m === EXPOSE_MODES.READONLY) return list.filter((t) => _isReadOnly(t));
  // safe:只读工具,或写工具但风险 ∈ {safe, low}。
  return list.filter((t) => _isReadOnly(t) || _riskOrdinal(t) <= RISK_ORDER.low);
}

/**
 * 汇总暴露集,给启动横幅用。绝不抛。
 * @param {Array<object>} selected
 * @returns {{ total: number, byRisk: Record<string, number>, hasDestructive: boolean }}
 */
function summarizeExposure(selected) {
  const list = Array.isArray(selected) ? selected.filter(Boolean) : [];
  const byRisk = { safe: 0, low: 0, medium: 0, high: 0, critical: 0 };
  let hasDestructive = false;
  for (const t of list) {
    const risk = t && typeof t.risk === 'string' && byRisk[t.risk] !== undefined ? t.risk : 'medium';
    byRisk[risk] += 1;
    // 破坏性 = 风险 ≥ high,或工具自报 isDestructive()。
    if (_riskOrdinal(t) >= RISK_ORDER.high) hasDestructive = true;
    try {
      if (typeof t.isDestructive === 'function' && t.isDestructive()) hasDestructive = true;
    } catch { /* isDestructive 抛 → 保守不升级判断 */ }
  }
  return { total: list.length, byRisk, hasDestructive };
}

module.exports = {
  EXPOSE_MODES,
  resolveExposeMode,
  selectExposedTools,
  summarizeExposure,
};
