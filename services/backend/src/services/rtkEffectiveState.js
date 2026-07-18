'use strict';

/**
 * rtkEffectiveState.js — RTK「真实生效状态」的诚实对账(纯叶子:零 IO、确定性、绝不抛、可单测)。
 *
 * 背景(用户目标 2026-07-04):RTK(Rust Token Killer)是 khy 默认开启的省 token 层,但它的
 * 「是否启用」此前**只读 env `KHY_RTK_MODE`**,与「二进制是否真的装了」**从不对账**。于是
 * `khy rtk status` 能同屏打印「状态:已启用」+「二进制:未找到(rtk 未安装)」——状态在撒谎:
 * 声称启用,实际因缺二进制什么也没做(实际没生效)。用户原话:「rtk 不是能力直接集成在 rtk
 * 模式中吗,可以开关才对」——即这个开关必须反映真实生效态,不能幻影启用。
 *
 * 本叶子把「意图(mode)× 安装(installed)」对账成一个三态真值 + 一句人话标签:
 *   · mode && installed   → active         「已启用并生效」
 *   · mode && !installed  → pending-install 「已开启但 rtk 未安装(暂未生效;当前用原生截断兜底)」
 *   · !mode               → off            「已关闭」
 * 关键诚实点:mode-on 但没装 ≠「已启用」。这一档必须显式说「未生效」,并说清 khy 仍有原生
 * smartTruncation 兜底(所以 token 仍在被压,只是没有 RTK 那 60–90% 的深压)。
 *
 * 纯/零 IO:mode / installed / autoInstall 三个布尔由**调用方(IO 壳:rtk.js / RtkGainTool /
 * capability.js)注入**,本叶子只做对账与措辞,不读盘、不 spawn、不 require rtkMode。
 *
 * 契约:门控 KHY_RTK_EFFECTIVE_STATE(默认开,仅显式 0/false/off/no 关)。关 →
 * describeEffectiveState 返 null → 调用方逐字节回退到各自旧的「只读 env」渲染。绝不抛。
 *
 * @module services/rtkEffectiveState
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先 flagRegistry(集中优先级 + dogfood),不可用回退本地 CANON。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_RTK_EFFECTIVE_STATE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_RTK_EFFECTIVE_STATE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

function _bool(v) { return v === true; }

/**
 * 纯对账:把三个布尔算成三态真值 + 措辞。不看门控(门控由 describeEffectiveState 施加),
 * 便于单测直接断言语义。绝不抛。
 *
 * @param {{mode?:boolean, installed?:boolean, autoInstall?:boolean}} input
 * @returns {{mode:boolean, installed:boolean, autoInstall:boolean, effective:boolean,
 *            status:'active'|'pending-install'|'off', label:string, hint:string}}
 */
function resolveEffectiveState(input = {}) {
  const mode = _bool(input.mode);
  const installed = _bool(input.installed);
  const autoInstall = _bool(input.autoInstall);
  const effective = mode && installed;

  let status;
  let label;
  let hint;

  if (!mode) {
    status = 'off';
    label = installed
      ? '已关闭(rtk 二进制已安装,但省 token 模式被关掉;当前用原生 smartTruncation)'
      : '已关闭(当前用原生 smartTruncation)';
    hint = '开启:khy rtk on';
  } else if (installed) {
    status = 'active';
    label = '已启用并生效(命令输出经 rtk 深度压缩)';
    hint = '查看省量:khy rtk gain';
  } else {
    // 关键诚实档:开着但没装 → 未生效。绝不显示为「已启用」。
    status = 'pending-install';
    label = '已开启,但 rtk 未安装 —— 暂未生效(当前用原生 smartTruncation 兜底,token 仍在压,只是缺 RTK 的 60–90% 深压)';
    hint = autoInstall
      ? '立即安装:khy rtk install(或首次跑 shell 命令时会自动安装)'
      : '立即安装:khy rtk install(自动安装当前关闭 KHY_RTK_AUTO_INSTALL)';
  }

  return { mode, installed, autoInstall, effective, status, label, hint };
}

/**
 * 门控化对账:门控开 → 返回对账态;门控关 → 返回 null(调用方逐字节回退旧渲染)。绝不抛。
 * @param {{mode?:boolean, installed?:boolean, autoInstall?:boolean}} input
 * @param {object} [env]
 * @returns {ReturnType<typeof resolveEffectiveState>|null}
 */
function describeEffectiveState(input = {}, env) {
  try {
    if (!isEnabled(env)) return null;
    return resolveEffectiveState(input);
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  resolveEffectiveState,
  describeEffectiveState,
};
