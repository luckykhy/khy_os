'use strict';

/**
 * windowsSpawnHardening.js — 纯叶子 + 早启动补丁:在 win32 上给所有 child_process 派生调用
 * 默认注入 `windowsHide: true`。
 *
 * 症状(用户反馈,Windows):`khy chat` 启动时「大量黑框闪烁」,且「速度比 Linux 慢太多」。
 *
 * 根因:khy 启动/运行要探测 git、node、python、编码(chcp)、各类外部工具,散落在 600+ 处
 * spawn/spawnSync/exec/execSync/execFile/execFileSync 调用里,其中绝大多数**没有设置
 * `windowsHide`**。Node 在 Windows 上对控制台子进程默认 `windowsHide:false` → 每次派生都会
 * **分配并随即销毁一个控制台窗口**:
 *   • 视觉上 = 一连串「黑框闪烁」;
 *   • 性能上 = 控制台窗口分配/销毁 + 每进程一次反病毒扫描,是 Windows 进程创建远慢于 Linux
 *     `fork` 的主要放大器。启动阶段成百次派生把这个常数放大成肉眼可见的卡顿。
 *
 * 修法:与其手改 600+ 处调用点(易漏、易回归),不如在**入口最早处**集中给 `child_process` 的
 * 六个派生方法(+ fork)打一层薄包装,在 win32 上把 `windowsHide:true` 注入到 options(仅当
 * 调用方未显式指定时)。单点、全覆盖、可逐字节回退。
 *
 * 契约:
 *   • 只在 win32 生效;非 win32 → 完全不打补丁,child_process 引用逐字节不变(Linux/mac 零影响)。
 *   • 门控 KHY_WINDOWS_SPAWN_HIDE(default-on,CANON off:4 词)。关 → 不打补丁。
 *   • 幂等:重复安装只打一次(`__khyWindowsHidePatched` 标记)。
 *   • 绝不破坏派生:注入逻辑 try/catch 包裹,任何异常都退回原样调用。
 *   • 只在 options.windowsHide === undefined 时注入 → 尊重调用方显式设置(含显式 false)。
 *
 * 时序红线:必须在**任何模块 `require('child_process')` 并解构派生函数之前**安装,否则那些模块
 * 会捕获未打补丁的原始引用。故在 bin/khy.js 顶部(os require 之后、其余 require 之前)安装。
 */

// ── 门控(KHY_WINDOWS_SPAWN_HIDE,default-on,CANON off:4 词)──────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 是否启用。flagRegistry 优先,注册表不可用(早启动)→ 本地 CANON(4 词)回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_WINDOWS_SPAWN_HIDE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_WINDOWS_SPAWN_HIDE;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// 收敛到 utils/isPlainObject 单一真源(逐字节委托,调用点不变)
const _isPlainObject = require('../utils/isPlainObject');

/**
 * 纯函数:给一次 child_process 派生调用的实参数组注入 windowsHide:true。就地修改并返回同一数组。
 *
 * 覆盖六个方法的所有合法签名形态:
 *   spawn/spawnSync/execFile/execFileSync : (cmd, args?, options?, cb?)
 *   exec/execSync                         : (cmd, options?, cb?)
 * 策略:数组里第一个「纯对象」(非数组、非函数)即 options → 就地补 windowsHide;
 *      没有 options 对象时,插在尾部回调之前(有回调)或直接追加(无回调),两者都是合法签名。
 *
 * @param {Array} callArgs 调用实参数组(会被就地修改)
 * @returns {Array} 同一数组
 */
function injectWindowsHide(callArgs) {
  if (!Array.isArray(callArgs)) return callArgs;
  // 1) 已有 options 对象 → 就地补(仅当未显式设置)。
  for (let i = 0; i < callArgs.length; i++) {
    if (_isPlainObject(callArgs[i])) {
      const opts = callArgs[i];
      if (opts.windowsHide === undefined) {
        try { opts.windowsHide = true; } catch { /* 冻结对象等 → 放弃注入,原样调用 */ }
      }
      return callArgs;
    }
  }
  // 2) 无 options 对象 → 插一个(尾部回调之前 / 否则追加)。
  const newOpts = { windowsHide: true };
  const lastIdx = callArgs.length - 1;
  if (lastIdx >= 0 && typeof callArgs[lastIdx] === 'function') {
    callArgs.splice(lastIdx, 0, newOpts);
  } else {
    callArgs.push(newOpts);
  }
  return callArgs;
}

const _PATCH_METHODS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

/**
 * 安装补丁。仅 win32 + 门控开时生效;否则 no-op(返回原因)。绝不抛。
 * @param {{ env?: object, platform?: string, childProcess?: object }} [opts] 依赖注入(便于测试)
 * @returns {{ installed: boolean, reason?: string, methods?: string[] }}
 */
function installWindowsSpawnHardening(opts = {}) {
  try {
    const env = opts.env || process.env;
    const platform = opts.platform || process.platform;
    if (platform !== 'win32') return { installed: false, reason: 'not-win32' };
    if (!isEnabled(env)) return { installed: false, reason: 'disabled' };

    const cp = opts.childProcess || require('child_process');
    if (cp.__khyWindowsHidePatched) return { installed: false, reason: 'already' };

    const patched = [];
    for (const name of _PATCH_METHODS) {
      const orig = cp[name];
      if (typeof orig !== 'function') continue;
      const wrapped = function (...callArgs) {
        try { injectWindowsHide(callArgs); } catch { /* 绝不因注入失败而破坏派生 */ }
        return orig.apply(this, callArgs);
      };
      wrapped.__khyOrig = orig;
      // 保留原函数上可能存在的静态属性(如 exec.[util.promisify.custom]),避免丢失 promisify 支持。
      try { Object.setPrototypeOf(wrapped, orig); } catch { /* 忽略 */ }
      cp[name] = wrapped;
      patched.push(name);
    }
    Object.defineProperty(cp, '__khyWindowsHidePatched', {
      value: true, enumerable: false, configurable: true, writable: true,
    });
    return { installed: true, methods: patched };
  } catch {
    return { installed: false, reason: 'error' };
  }
}

module.exports = {
  isEnabled,
  injectWindowsHide,
  installWindowsSpawnHardening,
  _isPlainObject,
  _PATCH_METHODS,
  _FALSY,
};
