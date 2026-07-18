'use strict';

/**
 * sandboxToggleState.js — `/sandbox-toggle` 的「OS 沙箱开关归一·状态解析·动作规划」零 IO
 * 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;flag/平台探测事实全经入参注入,
 * 本叶子绝不读 process.env、绝不触文件、绝不 spawn、绝不调 Date、绝不调平台探测。
 *
 * 背后的逻辑(对齐 Claude Code /sandbox-toggle):CC 的 /sandbox-toggle 是 local-jsx 面板,
 * 真正决定「命令是否被 OS 沙箱包裹」的后端逻辑是一张「flag × 平台可用性 → 生效态」的判定表。
 * khy 的等价 SSOT 是 toolSandbox.isOsSandboxEnabled():读 env `KHY_OS_SANDBOX`('true'|'false'|
 * 'auto',默认 'auto'),auto 时按平台探测(Linux=bwrap / macOS=sandbox-exec / Windows=Job Object,
 * 始终可用)决定是否生效。本叶子把那张判定表抽成纯函数(平台探测结果由薄壳注入),并补上
 * /sandbox-toggle 面板需要的「期望动作 → 该写什么 env」规划:
 *   - normalizeSandboxFlag(raw) → 'true'|'false'|'auto'|''(无法识别)
 *   - resolveSandboxState({flag, platform, bwrapAvailable, seatbeltAvailable})
 *       → { flag, effective:boolean, backend, available, reason }  —— 复刻 isOsSandboxEnabled 判定
 *   - planSandboxAction(action, currentFlag)
 *       → { ok, flag|unset, parseError }  —— on|off|auto|toggle → 该落的 env(toggle 基于当前生效语义)
 * 真正的 IO(探测 bwrap/seatbelt、读写 .env、回显)在薄壳 handlers/sandboxToggle.js;本叶子只算。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。
 * 本叶子零依赖。
 */

// 归一别名:小写去空白后比对。与 isOsSandboxEnabled 的 'false'/'0' 判定保持一致并扩展友好别名。
const _TRUE = new Set(['true', 'on', '1', 'yes', 'enable', 'enabled']);
const _FALSE = new Set(['false', 'off', '0', 'no', 'disable', 'disabled']);
const _AUTO = new Set(['auto', 'default', '']);

/**
 * 归一 OS 沙箱 flag 输入。
 * @param {string} raw
 * @returns {'true'|'false'|'auto'|''} 无法识别返回空串(由调用方友好报错)。
 */
function normalizeSandboxFlag(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (_AUTO.has(s)) return 'auto';
  if (_TRUE.has(s)) return 'true';
  if (_FALSE.has(s)) return 'false';
  return '';
}

/** 由注入的平台探测事实判定「当前平台沙箱后端 + 是否可用」。绝不自己探测。 */
function _backendFor(platform, bwrapAvailable, seatbeltAvailable) {
  switch (String(platform || '')) {
    case 'linux':
      return { backend: 'bubblewrap', available: !!bwrapAvailable };
    case 'darwin':
      return { backend: 'seatbelt', available: !!seatbeltAvailable };
    case 'win32':
      return { backend: 'job-object', available: true }; // Job Object 始终可用
    default:
      return { backend: 'none', available: false };
  }
}

/**
 * 复刻 isOsSandboxEnabled 的判定:flag='false'→关;否则按平台可用性决定生效。
 * @param {object} input
 *   @param {string}  input.flag             归一后的 'true'|'false'|'auto'
 *   @param {string}  input.platform         process.platform(薄壳注入)
 *   @param {boolean} input.bwrapAvailable   Linux 探测结果(薄壳注入)
 *   @param {boolean} input.seatbeltAvailable macOS 探测结果(薄壳注入)
 * @returns {{flag:string, effective:boolean, backend:string, available:boolean, reason:string}}
 */
function resolveSandboxState(input = {}) {
  const flag = normalizeSandboxFlag(input.flag) || 'auto';
  const { backend, available } = _backendFor(input.platform, input.bwrapAvailable, input.seatbeltAvailable);

  if (flag === 'false') {
    return { flag, effective: false, backend, available, reason: '已显式关闭(KHY_OS_SANDBOX=false)' };
  }
  // flag 为 'true' 或 'auto':均按平台可用性决定(对齐 isOsSandboxEnabled——它对 true/auto 不区分)。
  if (!available) {
    const why = backend === 'none'
      ? `当前平台(${String(input.platform || '未知')})无 OS 沙箱后端`
      : `${backend} 不可用(未检测到依赖)`;
    return { flag, effective: false, backend, available, reason: why };
  }
  const label = flag === 'true' ? '已显式开启' : 'auto(平台后端可用)';
  return { flag, effective: true, backend, available, reason: `${label} → ${backend} 生效` };
}

/**
 * 规划期望动作落成什么 env 变更。
 *   on    → 写 KHY_OS_SANDBOX=true
 *   off   → 写 KHY_OS_SANDBOX=false
 *   auto  → 删除 KHY_OS_SANDBOX(回到默认 auto)
 *   toggle→ 基于「当前生效语义」翻转:当前 false→on、否则→off
 * @param {string} action  on|off|auto|toggle|true|false|enable|disable
 * @param {string} currentFlag  当前归一 flag('true'|'false'|'auto')
 * @returns {{ok:boolean, flag?:string, unset?:boolean, parseError:string|null}}
 */
function planSandboxAction(action, currentFlag) {
  const a = String(action == null ? '' : action).trim().toLowerCase();
  const cur = normalizeSandboxFlag(currentFlag) || 'auto';

  if (a === 'auto' || a === 'default' || a === 'reset') {
    return { ok: true, unset: true, parseError: null };
  }
  if (_TRUE.has(a)) return { ok: true, flag: 'true', parseError: null };
  if (_FALSE.has(a)) return { ok: true, flag: 'false', parseError: null };
  if (a === 'toggle' || a === '') {
    // 翻转:当前显式关 → 开;当前 true/auto → 关(off 总是显式,便于可预测)。
    const next = cur === 'false' ? 'true' : 'false';
    return { ok: true, flag: next, parseError: null };
  }
  return { ok: false, parseError: `未知动作:${action}(支持 on|off|auto|toggle)` };
}

// 收敛到 utils/isOffValue 单一真源(逐字节委托,调用点不变)
const _falsy = require('../../utils/isOffValue');

/** 门控读取(KHY_SANDBOX_TOGGLE 默认开;关 → 命令不接管)。注入 env,叶子不读 process.env。 */
function isEnabled(env = {}) {
  return !_falsy(env && env.KHY_SANDBOX_TOGGLE === undefined ? 'true' : (env && env.KHY_SANDBOX_TOGGLE));
}

module.exports = {
  normalizeSandboxFlag,
  resolveSandboxState,
  planSandboxAction,
  isEnabled,
};
