'use strict';

/**
 * modelSubstitutionNotice.js — 纯叶子:「实际响应的模型 ≠ 用户所选的模型」时,返回一段
 * 面向用户的**状态透明**提示,让用户知道本次不是由他选的模型作答(常见于:所选通道不可用,
 * 网关自动回退到另一个模型/provider)。
 *
 * 背景(/goal 2026-08-24「khy 自述供应商与 api 矛盾」):请求 `api:sensenova:deepseek-v4-flash`
 * 但该模型在商汤感言 channel 返回 404 → 网关静默回退到 relay 的 `step-3.7-flash`(步科星�辰),
 * 于是那个模型的自述把「请求身份(sensenova/deepseek)」与「自身品牌(阶跃)」混在一起,出现
 * 「SenseNova(阶跃星辰)」的自相矛盾。此叶子在网关成功路径上把「实际响应的模型」明确说出来,
 * 避免用户误以为在和所选模型对话。
 *
 * 诚实边界:仅在**确实**替换时提示。判据 = 双方提取的**模型标识**(路由串末段,如
 * `api:sensenova:deepseek-v4-flash` → `deepseek-v4-flash`)不一致。仅在路由前缀不同、而模型名
 * 相同(如 `api:sensenova:sensenova-6.8-flash-lite` vs 服务端回 `sensenova-6.8-flash-lite`)
 * 视为**同一模型**,不提示(避免误报)。
 *
 * 门控 KHY_MODEL_SUBSTITUTION_NOTICE(default-on,仅 0/false/off/no 关):关 → 返 null,不提示,
 * 逐字节回退。绝不抛:任何异常 fail-safe 视为「无提示」。
 *
 * 常量/约定:零 IO、确定性、无 env 读写除门控入参外,与 services/gateway/*Notice.js 同构。
 *
 * @module services/gateway/modelSubstitutionNotice
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

const FLAG = 'KHY_MODEL_SUBSTITUTION_NOTICE';

/** 门是否开(default-on;仅显式 0/false/off/no 关)。 */
function isEnabled(env = process.env) {
  const raw = String((env && env[FLAG]) || '').trim().toLowerCase();
  if (raw === '') {
    return true;
  }
  return !_FALSY.has(raw);
}

/** 从路由串(如 `api:sensenova:deepseek-v4-flash` 或裸模型名)中抽出纯模型标识(末段)。 */
function modelIdOf(modelRef) {
  if (!modelRef) {
    return '';
  }
  const s = String(modelRef).trim();
  if (!s) {
    return '';
  }
  const i = s.lastIndexOf(':');
  return (i >= 0 ? s.slice(i + 1) : s).trim();
}

/**
 * 构造「实际响应模型 ≠ 请求模型」的提示。返回 null 表示无需提示(同模型 / 门关 / 缺参)。
 *
 * @param {{requestedModel?:string, servingModel?:string, servingProvider?:string, env?:object}} opts
 * @returns {string|null}
 */
function buildSubstitutionNotice(opts = {}) {
  if (!isEnabled(opts.env || process.env)) {
    return null;
  }
  const requested = modelIdOf(opts.requestedModel);
  const served = modelIdOf(opts.servingModel);
  if (!requested || !served) {
    return null;
  }
  if (requested.toLowerCase() === served.toLowerCase()) {
    return null;
  }
  const provider = opts.servingProvider ? `(${opts.servingProvider})` : '';
  return `注意: 本次实际由 ${served}${provider} 响应,与你选择的 ${requested} 不同——` +
    `可能是所选通道不可用而自动回退。`;
}

module.exports = {
  FLAG,
  isEnabled,
  modelIdOf,
  buildSubstitutionNotice,
};
