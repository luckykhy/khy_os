'use strict';

/**
 * toolHeaderDisplayName.js — TUI 工具头行「显示名对齐 Claude Code」的纯叶子
 * (零 IO、确定性、绝不抛、可单测)。
 *
 * 立场(用户目标 2026-07-04「做这个对齐」):经典 REPL 的工具头行早已经过
 * `renderTheme.getToolDisplayName` 归一 —— 编辑类工具显示成 CC 的 `Update`、
 * 新建显示 `Write`、读显示 `Read` …… 但 Ink TUI 的头行
 * (`tui/ink-components/ToolLines.js`)**绕过**了这个既有单一真源,直接渲染
 * 工具的**原始注册名**(`Edit` / `Write` / …),于是同一次操作在 TUI 里显示
 * `Edit(...)`,在经典 REPL 与 CC 里却是 `Update(...)`。本叶子只做「门控 + 复用
 * SSOT + fail-soft 回退」这一层薄封装,把 TUI 头行接回同一份映射,消除漂移。
 *
 * 设计要点 —— 保持纯叶子契约:
 *   - 本叶子**不**自己 require `renderTheme`(那条链会在首次取主题时读 default.json,
 *     属 IO)。映射函数由调用方以 `resolver` 注入(即把 `getToolDisplayName` 传进来),
 *     叶子只负责门控判定与回退语义,自身零 IO。
 *   - `getToolDisplayName` 对**未收录**的工具名本就返回原名(是原名的安全超集),
 *     故本对齐只会把 edit-family → `Update` 这类**有据可依**的项改名,其余逐字节不变。
 *
 * 契约:env 门控 KHY_TUI_TOOL_DISPLAY_NAME(默认开,仅显式 0/false/off/no 关闭)。
 * 关闭 / resolver 缺失 / resolver 抛错 / 映射为空 → 一律回退**原始名**(TUI 头行
 * 逐字节回退到改动前)。父门控经 flagRegistry 集中判定,不可用时回退本地 CANON 词表。
 *
 * @module cli/toolHeaderDisplayName
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先走 flagRegistry(集中优先级 + dogfood),不可用时回退本地 CANON 词表。
 * 默认开,仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_TUI_TOOL_DISPLAY_NAME', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_TUI_TOOL_DISPLAY_NAME;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 把工具的原始注册名解析成 CC 对齐的头行显示名。
 *
 * @param {string}   rawName   工具原始名(如 'Edit' / 'Write' / 'shell_command')。
 * @param {object}   [env]     环境(门控)。
 * @param {function} [resolver] 注入的映射函数(通常是 renderTheme.getToolDisplayName)。
 * @returns {string} 门控开且映射有值 → 映射名;否则 → 原始名(字节回退)。
 */
function resolveToolHeaderName(rawName, env, resolver) {
  const raw = String(rawName == null ? '' : rawName);
  // 门控关 / 无注入映射 → 逐字节回退原始名。
  if (!isEnabled(env)) return raw;
  if (typeof resolver !== 'function') return raw;
  try {
    const mapped = resolver(raw);
    const s = mapped == null ? '' : String(mapped);
    // 映射为空串则回退原始名,绝不把头行渲染成空。
    return s.trim() ? s : raw;
  } catch {
    // 映射抛错 → fail-soft 回退原始名(头行渲染是热路径,绝不因对齐而崩)。
    return raw;
  }
}

module.exports = {
  isEnabled,
  resolveToolHeaderName,
};
