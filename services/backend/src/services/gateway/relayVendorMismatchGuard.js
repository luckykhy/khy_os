'use strict';

/**
 * relayVendorMismatchGuard — 纯叶子:判定一次 relay_api 请求的**端点厂商**与**模型厂商**是否
 * 明确不符(从而必然被上游拒为「模型不存在」)。
 *
 * 背景(为什么存在,与 wildcardPoolGuard / relayModelGuard 的分工):
 *   - `wildcardPoolGuard` 只罩 `api` 通道的池解析 `_resolveApiPoolProviderForRequest`——它据「裸模型
 *     厂商 vs 通配池」判定,拿不到真实端点。
 *   - `relayModelGuard` 罩 `relay_api`,但它的「可服务家族」是**端点无关**的静态允许表(围绕
 *     api.trae.ai 假设),既不看真实端点,又会被 `RELAY_API_MODEL` 默认值重新喂回同一个外来模型。
 *   - 二者都罩不到本类:用户把 `RELAY_API_ENDPOINT`(或 apiKeyPool 端点覆盖)直接指到**某已知厂商的
 *     官方 host**(如 open.bigmodel.cn = 智谱 GLM),却发另一厂商的模型(如 agnes-2.0-flash = Agnes)。
 *     GLM 端点上当然没有 agnes 模型 → HTTP 400 code 1211「模型不存在」。relay_api 此前不做「端点厂商
 *     vs 模型厂商」核对,把含糊的上游 1211 直接甩给用户。
 *
 *   本叶子补这一层单一真源:端点 host 命中某已知 preset 官方 host、且模型属**另一个**已知厂商 →
 *   判定 mismatch,调用方在发请求前以清晰可执行提示短路(改端点 / 改模型 / pool:model 显式路由)。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读传入参数 + process.env 门控;不碰 fs/网络/子进程/时钟/随机)。
 *   - 确定性:同输入恒同输出(纯字符串/集合运算;厂商映射由传入的 providerPresets 派生,不硬编码模型名)。
 *   - 绝不抛:任何异常路径都返回安全值(ok:true / mismatch:false / '')。
 *   - env 门控 KHY_RELAY_VENDOR_GUARD 默认开;关 = 调用方据 isEnabled() 短路,不拦截 → 逐字节回退
 *     到「原样把 model 发给端点」的今日行为。
 *
 * 诚实边界(保守取舍,宁放过不误伤):
 *   - 只在**端点厂商与模型厂商都能确证、且两者不同**时才判定 mismatch。
 *   - 端点 host 不是任何已知 preset 官方 host(自定义 relay / 代理,如 your-relay.com)→ 放行:
 *     这正是「一个 relay 同时代理多家」的合法用法,绝不拦。
 *   - 模型厂商无法确证(不在任何 preset 的 models 清单、且家族 token 不匹配任何 preset 默认模型)→ 放行。
 *   - 因此它不是隔离边界,只阻止一次**必然失败**的错配发送,并给出可执行修法。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/**
 * 门控 KHY_RELAY_VENDOR_GUARD 是否启用。flagRegistry 优先(集中真源),失败/不可用再退本地
 * CANON 解析。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_RELAY_VENDOR_GUARD', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_RELAY_VENDOR_GUARD;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

/**
 * 从 URL 提取小写 host(忽略协议/路径/端口以外的差异)。无 scheme 时补 https:// 再解析。
 * 非法/空 → ''。绝不抛。
 * @param {*} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    if (typeof url !== 'string') return '';
    const s = url.trim();
    if (!s) return '';
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    return new URL(withScheme).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 剥掉模型名的 scoped 前缀(`vendor:model` / `vendor/model`)取裸模型名,小写。
 * 非字符串/空 → ''。绝不抛。
 * @param {*} model
 * @returns {string}
 */
function bareModel(model) {
  try {
    if (typeof model !== 'string') return '';
    const m = model.trim().toLowerCase();
    if (!m) return '';
    const scoped = m.match(/^[a-z0-9_-]+[:/](.+)$/i);
    return (scoped ? scoped[1] : m).trim();
  } catch {
    return '';
  }
}

/**
 * 取模型名的「家族 token」:首个字母序列(截到第一个数字/分隔符前),小写。
 * 例:agnes-2.0-flash→agnes,glm-4.6→glm,gpt-4o-mini→gpt,claude-sonnet-4→claude。绝不抛。
 * @param {string} name  裸模型名(应先经 bareModel)
 * @returns {string}
 */
function familyToken(name) {
  try {
    const m = String(name || '').trim().toLowerCase();
    if (!m) return '';
    const match = m.match(/^([a-z]+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function _presetList(presets) {
  return Array.isArray(presets) ? presets.filter((p) => p && typeof p === 'object') : [];
}

/**
 * 端点 host → 厂商 id。仅当 host 精确等于某 preset 的 baseUrl host 时命中(官方 host 唯一)。
 * @param {*} endpoint            端点 URL(RELAY_API_ENDPOINT / 覆盖 / cfg.endpoint)
 * @param {object[]} presets      providerPresets.getProviderPresets() 结果(单一真源,防漂移)
 * @returns {string}              命中的 preset id;无 → ''
 */
function vendorForEndpoint(endpoint, presets) {
  try {
    const host = hostOf(endpoint);
    if (!host) return '';
    for (const p of _presetList(presets)) {
      const ph = hostOf(p.baseUrl);
      if (ph && ph === host) return String(p.id || '').trim().toLowerCase();
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 模型名 → 厂商 id。两级判定,全部由 presets 派生(不硬编码模型名):
 *   1) 裸模型名精确出现在某 preset 的 models 清单 → 该 preset。
 *   2) 否则用家族 token 匹配各 preset(defaultModel 家族 + models 家族)构成的家族→id 映射。
 * 皆落空 → ''(无法确证,调用方保守放行)。绝不抛。
 * @param {*} model
 * @param {object[]} presets
 * @returns {string}
 */
function vendorForModel(model, presets) {
  try {
    const bare = bareModel(model);
    if (!bare) return '';
    const list = _presetList(presets);

    // 1) 精确命中 models 清单。
    for (const p of list) {
      const models = Array.isArray(p.models) ? p.models : [];
      for (const mm of models) {
        if (String(mm || '').trim().toLowerCase() === bare) return String(p.id || '').trim().toLowerCase();
      }
    }

    // 2) 家族 token 映射(首个登记者胜出,确定性)。
    const fam = familyToken(bare);
    if (!fam) return '';
    const familyMap = new Map();
    for (const p of list) {
      const id = String(p.id || '').trim().toLowerCase();
      if (!id) continue;
      const candidates = [];
      if (p.defaultModel) candidates.push(p.defaultModel);
      if (Array.isArray(p.models)) candidates.push(...p.models);
      for (const c of candidates) {
        const f = familyToken(bareModel(c));
        if (f && !familyMap.has(f)) familyMap.set(f, id);
      }
    }
    return familyMap.get(fam) || '';
  } catch {
    return '';
  }
}

/**
 * 评估一次 relay 请求的端点厂商与模型厂商是否明确不符。
 *
 * @param {object} params
 * @param {string} params.endpoint    解析后的 relay 端点 URL
 * @param {string} params.model       即将发送的模型名(可能带 scoped 前缀)
 * @param {object[]} params.presets   providerPresets.getProviderPresets() 结果
 * @returns {{ok:boolean, mismatch:boolean, endpointVendor:string, modelVendor:string, reason:string}}
 */
function evaluateRelayRequest(params = {}) {
  try {
    const endpointVendor = vendorForEndpoint(params.endpoint, params.presets);
    const modelVendor = vendorForModel(params.model, params.presets);

    // 任一侧无法确证 → 保守放行(自定义 relay / 未知模型家族)。
    if (!endpointVendor || !modelVendor) {
      return { ok: true, mismatch: false, endpointVendor, modelVendor, reason: 'insufficient-signal' };
    }
    // 厂商一致 → 放行。
    if (endpointVendor === modelVendor) {
      return { ok: true, mismatch: false, endpointVendor, modelVendor, reason: 'vendor-match' };
    }
    // 确证错配:端点是某厂商官方 host,模型属另一厂商 → 必然「模型不存在」。
    return {
      ok: false,
      mismatch: true,
      endpointVendor,
      modelVendor,
      reason: 'endpoint-vendor-differs-from-model-vendor',
    };
  } catch {
    return { ok: true, mismatch: false, endpointVendor: '', modelVendor: '', reason: 'error-fail-open' };
  }
}

/**
 * 生成跨厂商错配的清晰可执行提示。门关 → ''(不拦截)。key 本体绝不出现。绝不抛。
 * @param {object} params
 * @param {string} params.endpoint
 * @param {string} params.model
 * @param {string} params.endpointVendor
 * @param {string} params.modelVendor
 * @param {object[]} [params.presets]   用于给出 modelVendor 的正确端点建议
 * @param {object} [env]
 * @returns {string}
 */
function buildMismatchHint(params = {}, env = process.env) {
  try {
    if (!isEnabled(env)) return '';
    const model = String(params.model || '').trim();
    const endpointVendor = String(params.endpointVendor || '').trim();
    const modelVendor = String(params.modelVendor || '').trim();
    if (!model || !endpointVendor || !modelVendor) return '';
    const host = hostOf(params.endpoint) || '该端点';
    let correctUrl = '';
    try {
      const target = _presetList(params.presets).find(
        (p) => String(p.id || '').trim().toLowerCase() === modelVendor.toLowerCase(),
      );
      if (target && target.baseUrl) correctUrl = String(target.baseUrl).trim();
    } catch { /* 无建议端点 → 省略 */ }
    const urlPart = correctUrl ? `(${correctUrl})` : '';
    return `relay 端点 ${host} 属于 ${endpointVendor},但模型 ${model} 属于 ${modelVendor};`
      + `该端点上没有此模型,会返回「模型不存在」。请二选一:`
      + `① 把 RELAY_API_ENDPOINT 改为 ${modelVendor} 的端点${urlPart}并配对应 key;`
      + `② 改用 ${endpointVendor} 端点上真实存在的模型。`
      + `或用 pool:model 前缀把它显式路由到已登记的 ${modelVendor} 池(如 ${modelVendor}:${model})。`;
  } catch {
    return '';
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeRelayVendorGuard() {
  return {
    gate: 'KHY_RELAY_VENDOR_GUARD',
    defaultOn: true,
    summary: 'relay_api 跨厂商错配守卫:当 RELAY_API_ENDPOINT 指向某已知厂商官方 host、而发送的 model '
      + '属另一厂商时,上游必回「模型不存在」(实测 open.bigmodel.cn + agnes-2.0-flash → 400 code 1211)。'
      + '守卫在发请求前判定 mismatch,relayApiAdapter 以清晰可执行提示短路(改端点/改模型/pool:model),'
      + '而非把含糊的 1211 甩给用户。厂商映射由 providerPresets 单一真源派生(不硬编码模型名)。'
      + '端点是自定义 relay(未知 host)或模型厂商无法确证时一律放行;门控关则原样发送(今日行为)。',
  };
}

module.exports = {
  isEnabled,
  hostOf,
  bareModel,
  familyToken,
  vendorForEndpoint,
  vendorForModel,
  evaluateRelayRequest,
  buildMismatchHint,
  describeRelayVendorGuard,
};
