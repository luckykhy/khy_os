'use strict';

/**
 * contextWindowDefaults.js — 「未知模型上下文窗口回退值」的单一真源(纯常量叶)。
 *
 * 契约 (CONTRACT): 零依赖、零 IO、确定性、绝不抛、无副作用;env 经入参注入。
 *
 * 背后的逻辑:模型真实窗口的唯一真源永远是 aiGateway 适配器上报值
 * (getModelContextWindow);本模块只提供「适配器还不知道时」的保守回退。
 * 在此之前 128000 这个回退值散落在 6+ 个文件里各自硬编码,一处改不动其余,
 * 于是显示层与预算层能对同一个未知模型给出不同的分母(见 AGENTS.md「零硬编码」)。
 *
 * 为何回退取 128000 而非更大:**宁可写小不可写大**。窗口写小的代价是多压缩一次
 * (可恢复);写大的代价是运行时 400/413 请求直接失败(不可恢复)。同理
 * MAX_PLAUSIBLE_CONTEXT_WINDOW 是给「上游谎报」兜的理性上限 —— 现实中最大的真实
 * 窗口是 GPT-4.1 系的 1047576,取 1048576 (1Mi) 作天花板。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器误判幽灵依赖。
 */

/** 未知模型的保守回退窗口 —— 显示分母与压缩预算共用同一个数。 */
const UNKNOWN_MODEL_CONTEXT_WINDOW = 128000;

/** Claude 系(及同级大窗口模型)的默认窗口,用于已知家族但未拿到适配器真值时。 */
const LARGE_FAMILY_CONTEXT_WINDOW = 200000;

/** 上游上报值的理性天花板;超过即视为谎报并钳回,防止运行时 400/413。 */
const MAX_PLAUSIBLE_CONTEXT_WINDOW = 1048576;

/** 安全转正整数;非有限/非正 → 0。 */
function _posInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.floor(n);
}

/**
 * 从注入 env 解析回退窗口(KHY_CONTEXT_WINDOW),无效 → UNKNOWN_MODEL_CONTEXT_WINDOW。
 * @param {Record<string,string>} [env] 注入环境(默认空对象,绝不读 process.env)
 * @returns {number}
 */
function resolveFallbackWindow(env = {}) {
  const n = _posInt(env && env.KHY_CONTEXT_WINDOW);
  return n > 0 ? n : UNKNOWN_MODEL_CONTEXT_WINDOW;
}

module.exports = {
  UNKNOWN_MODEL_CONTEXT_WINDOW,
  LARGE_FAMILY_CONTEXT_WINDOW,
  MAX_PLAUSIBLE_CONTEXT_WINDOW,
  resolveFallbackWindow,
};
