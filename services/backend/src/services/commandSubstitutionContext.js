'use strict';

/**
 * commandSubstitutionContext.js — 判定 `$()` / 反引号是否为「值得硬拒的 POSIX 命令替换」
 * (纯叶子:零 IO、确定性、绝不抛)。
 *
 * 问题定位(2026-07-04 用户现场:Windows 上「权限已经批准却显示禁止」):
 *   execApproval.checkCommand 有一条**硬拒**——凡检出命令替换(`$(` 或反引号)且权限档
 *   != FULL,直接 `allowed:false` **且不带 requestId**(即**没有审批通道**),理由
 *   「Command substitution ($() or ``) detected — potential injection risk」。这是一条
 *   **bash 视角**的启发式:在 POSIX shell 里 `$(...)`/反引号 = 命令替换 = 可绕过风险分类器
 *   的注入面,硬拒有理。**但** `$(...)`(子表达式运算符)与反引号(转义符/续行)是
 *   **PowerShell 的原生语法**——于是 Windows 上每一条用了子表达式的 `powershell`/`pwsh`
 *   命令都被误判成注入并硬拒,且**无路可批**(除非切 FULL 档)。用户批了 shellCommand 权限,
 *   那条 `$()` 命令仍显示「权限被拒绝」→ 「已批准却禁止」的矛盾。
 *
 * 本叶子把「命令替换是否应硬拒」变成**shell 感知**的确定性判定:
 *   - 外层调用是 POSIX 上下文(bash/sh/裸命令)→ `$()`/反引号是真命令替换 → 仍按原样硬拒。
 *   - 外层调用是非 POSIX shell(powershell/pwsh)→ `$()`/反引号是该 shell 的原生语法,
 *     **不**当作 bash 注入硬拒;execApproval 改走**正常审批通道**(创建可批准的请求),
 *     用户看得到、可批准——**不是静默放行**,只是把「无路可批的硬拒」降级为「需人工确认」。
 *
 * 安全姿态:fail-safe 永远偏保守——门控关 / 解析异常 / 拿不准 → 返回 true(= 当作 POSIX
 * 命令替换,保持原硬拒),绝不因本叶子而放松 bash 注入防线。bash 行为逐字节不变。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_SUBST_SHELL_AWARE(默认开,仅显式 0/false/off/no
 * 关;关闭后 isPosixCommandSubstitution 恒返 true → execApproval 接缝逐字节回退到旧硬拒)。
 * 父门控经 flagRegistry 集中判定(CANON 词表),fail-soft 回退本地 CANON。
 *
 * @module services/commandSubstitutionContext
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先走 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_SUBST_SHELL_AWARE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_SUBST_SHELL_AWARE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 非 POSIX shell:其 `$(...)` / 反引号是原生语法,不是 POSIX 命令替换注入面。
// 只列 PowerShell 家族——那里 `$(...)`(子表达式)与反引号(转义/续行)确为原生;cmd.exe
// 不用 `$()`(用 %VAR%),不在此列,故 cmd 里的 `$(` 仍按 POSIX 硬拒(保守)。
const _NON_POSIX_SHELLS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

/**
 * 取命令的首个可执行名(去引号、取 basename、小写)。纯字符串解析,绝不抛。
 * @param {string} command
 * @returns {string} 小写 basename;无法解析 → ''
 */
function baseExecutable(command) {
  if (!command || typeof command !== 'string') return '';
  const trimmed = command.trim();
  if (!trimmed) return '';
  // First token. If the command starts with a quote, the executable path may
  // contain spaces (Windows: "C:\Program Files\...\pwsh.exe") — take up to the
  // matching closing quote. Otherwise split on the first whitespace run.
  let firstTok;
  const q = trimmed[0];
  if (q === '"' || q === "'") {
    const end = trimmed.indexOf(q, 1);
    firstTok = end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  } else {
    firstTok = trimmed.split(/\s+/)[0] || '';
  }
  // Strip any residual surrounding quotes.
  const unquoted = firstTok.replace(/^["']|["']$/g, '');
  // 取路径 basename(兼容 Windows `\` 与 POSIX `/`)。
  const parts = unquoted.split(/[\\/]/);
  const base = parts[parts.length - 1] || '';
  return base.toLowerCase();
}

/**
 * 外层调用是否为非 POSIX shell(PowerShell 家族)。
 * @param {string} command
 * @returns {boolean}
 */
function isNonPosixShellInvocation(command) {
  return _NON_POSIX_SHELLS.has(baseExecutable(command));
}

/**
 * execApproval 要问的问题:检出的 `$()`/反引号是否应作为「值得硬拒的 POSIX 命令替换」处理?
 *
 *   - 门控关 → 恒 true(逐字节回退:一切命令替换按原硬拒)。
 *   - 门控开 → 外层是 PowerShell 家族返 false(原生语法,改走审批通道);否则 true(仍硬拒)。
 *   - 任何异常 → fail-safe 返 true(保守,绝不放松 bash 防线)。
 *
 * 注意:仅回答「要不要硬拒」;调用方 execApproval 在 false 时不会静默放行,而是落到正常
 * 风险/审批路径,由用户决定。
 *
 * @param {string} command
 * @param {object} [env]
 * @returns {boolean}
 */
function isPosixCommandSubstitution(command, env) {
  try {
    if (!isEnabled(env)) return true;
    return !isNonPosixShellInvocation(command);
  } catch {
    return true;
  }
}

module.exports = {
  isEnabled,
  baseExecutable,
  isNonPosixShellInvocation,
  isPosixCommandSubstitution,
};
