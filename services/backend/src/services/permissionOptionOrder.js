'use strict';

/**
 * permissionOptionOrder —— 纯叶子(pure leaf):权限审批选项「允许优先」排序的单一真源。
 *
 * 契约:零 IO(不碰 fs/网络/子进程)、确定性、单一真源(选项排序规则只在本文件)、
 * env 门控默认开(`KHY_PERMISSION_ALLOW_FIRST`,仅 0/false/off/no 关闭即字节回退)、
 * fail-soft 绝不抛。
 *
 * 目标:权限框里「允许」类选项应排在**第一个**,方便用户选择(光标默认落在第 0 项 =
 * 允许)。本叶子做稳定分区:非拒绝类选项保持原相对顺序排前、拒绝类排末。
 *
 * **高危(L2)允许优先——用户知情决定,默认开**:L2 高危操作(`highRisk:true`)也按「允许优先」
 * 重排,使「确认执行」落在首位、光标默认命中(反射性回车 = 执行),与普通(L1)授权框完全对齐。
 * 这是用户在知情下(明确接受「反射性回车会直接执行高危操作」)做出的选择,经 env 门控可逆:
 * `KHY_PERMISSION_ALLOW_FIRST_HIGHRISK=off`(0/false/off/no)即恢复既有「拒绝优先」安全护栏。
 * 不静默——默认值是显式记录的决定,回退随时可用(trust-but-verify,覆盖权在用户)。
 */

function _enabled() {
  const v = String(process.env.KHY_PERMISSION_ALLOW_FIRST || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// 高危允许优先:默认开(FALSY 语义),仅 0/false/off/no 显式回退到「拒绝优先」。
function _highRiskOptIn() {
  const v = String(process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// 拒绝类选项的归一化 key(其余一律视为允许/中性,排在拒绝之前)。
const DENY_KEYS = Object.freeze(new Set(['deny', 'deny-all', 'denyall', 'reject', 'no', 'cancel']));

/** 判断一个选项是否「拒绝」类(按其 key / value 归一化判定,零启发式)。 */
function isDenyOption(option) {
  if (!option || typeof option !== 'object') return false;
  const key = String(option.key == null ? '' : option.key).trim().toLowerCase();
  if (DENY_KEYS.has(key)) return true;
  // 经典 CLI 对话框用 value 而非 key(如 {value:'deny'|'deny-all'}),一并识别使本叶子
  // 成为跨两套权限 UI 的单一真源。
  const value = String(option.value == null ? '' : option.value).trim().toLowerCase();
  return DENY_KEYS.has(value);
}

/**
 * 把选项重排为「允许优先」:非拒绝类(保持原序)在前,拒绝类(保持原序)在后。
 * 稳定分区——同类内部相对顺序不变,只把拒绝整体下沉到末尾。
 *
 * @param {Array<object>} options  形如 [{key,label,resolve,...}]
 * @param {{highRisk?:boolean}} [opts]  highRisk=true(L2 高危)默认也允许优先(知情决定);
 *        `KHY_PERMISSION_ALLOW_FIRST_HIGHRISK=off` 时回退为不重排(保持拒绝优先)
 * @returns {Array<object>}  门控关 / 无需改动 / 高危显式回退 → 原数组(同引用)
 */
function orderOptions(options, opts = {}) {
  if (!_enabled()) return options;
  try {
    if (!Array.isArray(options) || options.length < 2) return options;
    // 高危默认允许优先(知情决定);仅显式 KHY_PERMISSION_ALLOW_FIRST_HIGHRISK=off 时回退拒绝优先。
    if (opts && opts.highRisk && !_highRiskOptIn()) return options;

    const allowGroup = [];
    const denyGroup = [];
    for (const o of options) {
      (isDenyOption(o) ? denyGroup : allowGroup).push(o);
    }
    // 已是「允许优先」(无拒绝项,或所有拒绝项本就在末尾)→ 原样返回(同引用,字节回退)。
    if (denyGroup.length === 0) return options;
    const reordered = allowGroup.concat(denyGroup);
    let identical = true;
    for (let i = 0; i < options.length; i += 1) {
      if (options[i] !== reordered[i]) { identical = false; break; }
    }
    return identical ? options : reordered;
  } catch {
    return options; // fail-soft
  }
}

module.exports = {
  isDenyOption,
  orderOptions,
  _enabled,
  _highRiskOptIn,
};
