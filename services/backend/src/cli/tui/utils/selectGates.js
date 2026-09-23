'use strict';

/**
 * selectGates —— 应用内自绘选择的三个门控（单一真源）。
 *
 * 为什么抽出来（[DESIGN-ARCH-124] §3.1）：
 *   这三个开关的语义在 Legacy `App.js` 里原本是三个本地函数。CC 模式接选择时
 *   要读**同一套** env —— 抄一份的代价不是代码重复，是**语义漂移**：哪天有人
 *   改了 Legacy 的默认值或新增一个 off 值，CC 侧就静默两套行为，排查时谁都想不到
 *   「两个模式的开关不是同一个」。这正是 [DESIGN-ARCH-119] 反复踩的那类坑。
 *   所以这里落成纯叶子，两个模式都 require 它。
 *
 * 默认值的选择是**权衡后的保守值**，不是「安全默认」：
 *   开  → 复制可用（用户报的诉求），但会**替换**原生拖选（1002 吃掉了 press 起点）；
 *  关  → 保留原生拖选（未开追踪的终端下真的能用），但用户报的问题依旧。
 * 既然「无法复制」是已确认的用户可见故障、且备屏下原生拖选本就被追踪吃掉，选 **开**。
 *
 * 三个子开关的存在理由各不相同（别合并）：
 *   KHY_SELECT        总闸。关掉 = 不接管拖选、不开 1002、Viewport 不画反色。
 *   KHY_SELECT_CLIP   松手自动写剪贴板。关掉 = 能选中能看，但不自动复制。
 *   KHY_SELECT_DRAG   1002 位移追踪。关掉 = 只支持「按下-松开」两点式选择（诊断用）。
 *
 * 纯叶子：零 IO、无 require、绝不抛。
 */

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** env 里的显式 falsy → 关；其余（含未设置）→ 开。 */
function gateOn(env, name) {
  try {
    const raw = (env || process.env)[name];
    const v = String(raw === undefined || raw === null ? '' : raw)
      .trim()
      .toLowerCase();
    return !OFF_VALUES.has(v);
  } catch {
    return true;
  }
}

/**
 * 自绘选择总闸（默认开）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function selectEnabled(env) {
  return gateOn(env, 'KHY_SELECT');
}

/**
 * 松手自动写剪贴板（默认开）。关掉 → 只画反色不复制。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function selectClipEnabled(env) {
  return gateOn(env, 'KHY_SELECT_CLIP');
}

/**
 * 拖动位移追踪（默认开）。关掉 → 不开 1002，只认按下/松开两点。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function selectDragEnabled(env) {
  return gateOn(env, 'KHY_SELECT_DRAG');
}

module.exports = {
  OFF_VALUES,
  selectEnabled,
  selectClipEnabled,
  selectDragEnabled,
};
