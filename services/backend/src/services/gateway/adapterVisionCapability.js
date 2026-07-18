'use strict';

/**
 * adapterVisionCapability.js — 「某条适配器(渠道)是否原生收图、能自行做视觉识别」的
 * 单一真源。
 *
 * 背景:visionCapability.js 判定的是「某个 model id 是否收图像输入」,适用于
 * SenseNova 这类「按 model 名走 /v1/chat/completions」的 OpenAI 兼容通道——那里
 * 没有视觉模型,带图必须退回 OCR。但有些**适配器**(如 codex 的 direct 模式 →
 * Responses API)无论当前 model 名是否「看起来像视觉」,都会把 `input_image` 块
 * 原生发给上游、由上游真正读图。对这类通道,aiGateway 的 decideVisionRouting 不应
 * 把图剥成 OCR——那会让本可真视觉识别的请求降级成「只认文字」。
 *
 * 经实测:codex 渠道(direct 模式 → mindflow gpt-5.3-codex-review)能原生读图。
 * 于是把「哪些适配器原生收图」收口为本叶子的单一真源,供 aiGateway 在视觉路由前
 * 短路:首选适配器原生收图 → 保留图、让该通道真视觉识别;否则维持既有
 * keep / switch-model / ocr-fallback 决策不变。
 *
 * 判定优先级:
 *   1. 显式覆盖集(env KHY_NATIVE_VISION_ADAPTERS,逗号/空白分隔) —— 命中即 true,
 *      允许用户在不改代码的前提下登记新的原生收图通道(最高权限)。
 *   2. 内置集 NATIVE_VISION_ADAPTERS —— 命中即 true。
 *   3. 默认 false。
 *
 * 安全:这只是「保留图、交给通道」的放行判定。若该通道实际拒绝图像(404 /
 * model_not_found / bad_request),aiGateway 的 post-failure OCR 网(shouldOcrRescue
 * → extractImageOcrTexts → cascade)会兜底救回,不会毒死会话——故放行是安全的。
 *
 * 纯叶子:零外部依赖、无副作用、env 经 opts 注入可测、绝不抛、门控关即字节回退。
 */

// 门控关闭判据(沿用全网关惯例:仅这些值算「关」,其余一律默认开)。
const _FALSY = new Set(['0', 'false', 'off', 'no']);

// 内置「原生收图」适配器集(精确小写匹配 adapterKey)。
//   - codex —— direct 模式经 Responses API 把 input_image 块原生发给上游(mindflow
//     gpt-5.3-codex-review 实测可真视觉读图);CLI 模式是纯文本 stdin,但带图请求会被
//     codexAdapter 强制切到 direct 模式(见 codexAdapter 强制 direct 逻辑),故 codex
//     通道对带图请求一律走原生视觉。
const NATIVE_VISION_ADAPTERS = Object.freeze([
  'codex',
]);

/**
 * 门控是否开启(默认开;仅 KHY_ADAPTER_NATIVE_VISION ∈ {0,false,off,no} 时关)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env;
  const raw = e && e.KHY_ADAPTER_NATIVE_VISION;
  if (raw == null) return true;
  return !_FALSY.has(String(raw).trim().toLowerCase());
}

// 收敛到 utils/trimLowerNullish 单一真源(逐字节委托,调用点不变)
const _normKey = require('../../utils/trimLowerNullish');

/**
 * 解析逗号/空白分隔的 env 列表为一组小写适配器名。
 * @param {string} raw
 * @returns {Set<string>}
 */
const parseAdapterListEnv = require('../../utils/parseListToSet');

/**
 * 判定某条适配器是否原生收图、能自行做视觉识别(从而无需把图剥成 OCR)。
 *
 * @param {string} adapterKey  适配器键(如 'codex'、'sensenova')
 * @param {object} [env]       注入的环境对象(默认 process.env)
 * @returns {boolean}  门控关 → 恒 false(字节回退,等于此能力不存在)
 */
function adapterHandlesImagesNatively(adapterKey, env) {
  const e = env || process.env;
  if (!isEnabled(e)) return false; // 门控关 → 逐字节回退到「无此判定」语义

  const key = _normKey(adapterKey);
  if (!key) return false;

  const override = parseAdapterListEnv(e && e.KHY_NATIVE_VISION_ADAPTERS);
  if (override.has(key)) return true;

  return NATIVE_VISION_ADAPTERS.includes(key);
}

module.exports = {
  NATIVE_VISION_ADAPTERS,
  isEnabled,
  parseAdapterListEnv,
  adapterHandlesImagesNatively,
};
