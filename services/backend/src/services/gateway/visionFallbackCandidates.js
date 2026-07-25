'use strict';

/**
 * visionFallbackCandidates.js — 纯叶子:枚举「有可用 key 的备用视觉模型」候选。
 *
 * 背景:describe-and-return 视觉路由里,主视觉模型(decision.model,常见 GLM-4.6V-Flash)
 * 若描述失败,旧行为是静默切到**同一个刚失败的模型** → 下游几乎必然二次失败。用户诉求
 * (「可以帮忙替换」→ 二次确认「两者都要」):先**自动试备用视觉模型**再说明。
 *
 * 本叶子只负责「给定失败的模型 + 环境,产出一串可以再试的备用视觉模型」——判定复用既有
 * 单一真源(visionCapability.isVisionCapableModel 判视觉、apiKeyPool.hasAvailableKeys 判有 key、
 * customProviderRegistry.listProviders 枚举各 pool 的 models、glmVisionModel 提供 GLM 视觉 pin)。
 * 不新造视觉判定,不做任何写入/网络。
 *
 * 契约:纯叶子——零副作用、绝不抛(任何异常/依赖不可用 → 返回 `[]`)、外部 IO 全经注入 deps
 * (默认内部 require 包 try/catch),可 node:test 纯单测。
 *
 * 排序策略:
 *   1. GLM 视觉 pin 优先(门开 KHY_GLM_VISION_MODEL + `hasAvailableKeys('glm')`)——有序降级链
 *      glm-4.6v-flash(新旗舰)→ glm-4v-flash(老牌免费,几乎恒可用),让「主 GLM 视觉模型
 *      404/失败」时先在 GLM 池内降级、再去别的 pool 找视觉模型,而非空转或盲切回同一失败模型。
 *   2. 其后遍历 listProviders():仅取「pool 有可用 key」的 provider,过滤其 models[] 中视觉可用者。
 * 排除失败模型(按去前缀的裸 id 比对,容忍 `glm/glm-4.6v-flash` 与 `glm-4.6v-flash` 视为同一)。
 * 去重(裸 id),保持优先级顺序。
 */

/**
 * 去 provider 前缀取裸模型 id(小写),用于失败排除与去重比对。
 * `glm/glm-4.6v-flash` → `glm-4.6v-flash`;无前缀原样小写。
 * @param {*} model
 * @returns {string}
 */
function _bareId(model) {
  const m = String(model == null ? '' : model).trim().toLowerCase();
  if (!m) return '';
  const idx = m.lastIndexOf('/');
  return idx >= 0 ? m.slice(idx + 1) : m;
}

function _defaultListProviders() {
  try { return require('../customProviderRegistry').listProviders(); } catch { return []; }
}

function _defaultHasAvailableKeys(pool) {
  try { return require('../apiKeyPool').hasAvailableKeys(pool); } catch { return false; }
}

function _defaultIsVisionCapable(model, opts) {
  try { return require('./visionCapability').isVisionCapableModel(model, opts); } catch { return false; }
}

// GLM 视觉降级候选:门开 → 有序 [{ model:'glm-4.6v-flash', poolHint:'glm' },
// { model:'glm-4v-flash', poolHint:'glm' }];门关/异常 → []。首选新旗舰、次选老牌免费——
// 账号缺新模型致 404 时,级联可降级到几乎恒可用的 glm-4v-flash。用裸 model + poolHint 'glm'
// (而非带前缀 pin),与 describe 调用的 { model, apiPoolProvider } 形态直接对齐。
function _defaultGlmPin(env) {
  try {
    const glm = require('./glmVisionModel');
    if (!glm.glmVisionEnabled(env)) return [];
    if (typeof glm.glmVisionCandidatePins === 'function') {
      const pins = glm.glmVisionCandidatePins(env);
      if (Array.isArray(pins)) return pins;
    }
    const id = glm.GLM_VISION_MODEL_ID;
    return id ? [{ model: id, poolHint: 'glm' }] : [];
  } catch {
    return [];
  }
}

/**
 * 枚举可再试的备用视觉模型候选。绝不抛;任何异常 → `[]`。
 *
 * @param {object} a
 * @param {string} [a.failedModel]  刚刚描述失败的视觉模型 id(可带 provider 前缀),将被排除
 * @param {object} [a.env]          注入 env(可测)
 * @param {object} [a.deps]         注入依赖(可测):{ listProviders, hasAvailableKeys, isVisionCapable, glmPin }
 * @returns {Array<{model:string, poolHint:string}>}  有序候选(GLM 优先),去重且排除失败模型
 */
function collectVisionFallbackCandidates({ failedModel, env, deps } = {}) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    const d = deps || {};
    const listProviders = typeof d.listProviders === 'function' ? d.listProviders : _defaultListProviders;
    const hasAvailableKeys = typeof d.hasAvailableKeys === 'function' ? d.hasAvailableKeys : _defaultHasAvailableKeys;
    const isVisionCapable = typeof d.isVisionCapable === 'function' ? d.isVisionCapable : _defaultIsVisionCapable;
    const glmPin = typeof d.glmPin === 'function' ? d.glmPin : _defaultGlmPin;

    const failedBare = _bareId(failedModel);
    const out = [];
    const seen = new Set();

    const push = (model, poolHint) => {
      const m = String(model == null ? '' : model).trim();
      if (!m) return;
      const bare = _bareId(m);
      if (!bare || bare === failedBare || seen.has(bare)) return;
      seen.add(bare);
      out.push({ model: m, poolHint: poolHint ? String(poolHint).trim() : '' });
    };

    // 1. GLM 视觉 pin 优先(有 key 才收)。glmPin 可返回单个 pin 对象(向后兼容)或有序数组
    //    (降级链 glm-4.6v-flash → glm-4v-flash);两种形态统一归一为数组,共用一次 glm 有 key 判定。
    try {
      const pinResult = glmPin(e);
      const pins = Array.isArray(pinResult) ? pinResult : (pinResult ? [pinResult] : []);
      if (pins.length) {
        let glmHasKey = false;
        try { glmHasKey = !!hasAvailableKeys('glm'); } catch { glmHasKey = false; }
        if (glmHasKey) {
          for (const pin of pins) {
            if (pin && pin.model) push(pin.model, pin.poolHint || 'glm');
          }
        }
      }
    } catch { /* fail-soft */ }

    // 2. 各 provider 的视觉可用 models(仅 pool 有可用 key 者)。
    let providers = [];
    try { providers = listProviders() || []; } catch { providers = []; }
    if (Array.isArray(providers)) {
      for (const p of providers) {
        if (!p || !Array.isArray(p.models)) continue;
        const poolKey = String(p.poolKey || '').trim();
        if (!poolKey) continue;
        let poolHasKey = false;
        try { poolHasKey = !!hasAvailableKeys(poolKey); } catch { poolHasKey = false; }
        if (!poolHasKey) continue;
        for (const m of p.models) {
          const id = String(m == null ? '' : m).trim();
          if (!id) continue;
          let vis = false;
          try { vis = !!isVisionCapable(id, { env: e }); } catch { vis = false; }
          if (vis) push(id, poolKey);
        }
      }
    }

    return out;
  } catch {
    return [];
  }
}

module.exports = {
  collectVisionFallbackCandidates,
  _bareId,
};
