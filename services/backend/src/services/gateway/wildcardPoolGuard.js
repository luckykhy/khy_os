'use strict';

/**
 * wildcardPoolGuard — 纯叶子:判定一个「裸模型名」是否会被通配兜底(GATEWAY_API_POOL_PROVIDER)
 * 盲路由到一个**与该模型厂商不符**的默认池,从而打到错误端点。
 *
 * 背景(为什么存在):
 *   `api` 通道的 pool 解析 `_resolveApiPoolProviderForRequest` 依次尝试:显式 apiPoolProvider →
 *   显式 provider → 模型前缀 `<pool>:<model>` / `<pool>/<model>` → 最后**盲通配** env
 *   `GATEWAY_API_POOL_PROVIDER`。一个没有 `:`/`/` 的裸模型名(如 `agnes-2.0-flash`)在前三步
 *   全落空,直接被塞进通配默认池(实测 `.env: GATEWAY_API_POOL_PROVIDER=relay`)。
 *
 *   问题:`agnes` 明明是仓内已登记的 provider preset(providerPresets.js,端点
 *   apihub.agnes-ai.com),但用户的运行时池(~/.khy/api_keys.json)里**没有 agnes 池**。
 *   通配兜底不做任何「厂商 vs 池」核对 → 模型继承默认池的端点 → 打到不属于它的上游
 *   (实测 HTTP 400 code 1211「模型不存在」)。
 *
 *   relayModelGuard 已对 `relay_api` 通道做**对称防护**(外来模型丢弃为 null)。本叶子补上
 *   `api` 通配路由这一层的单一真源:当裸模型的厂商前缀命中一个**已知 preset** 却**未注册运行时
 *   池**、且与通配池本身不同 → 判定 mismatch,调用方据此不再盲路由(返回 null),转为清晰失败。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读传入参数与 process.env 做门控;不碰 fs/网络/子进程/时钟/随机)。
 *   - 确定性:同输入恒同输出(纯字符串/集合运算)。
 *   - 绝不抛:任何异常路径都返回安全值(ok:true / '' / false)。
 *   - env 门控 KHY_WILDCARD_POOL_GUARD 默认开;关 = 调用方据 isEnabled() 短路,不拦截 → 逐字节
 *     回退到「裸模型盲落通配默认池」的今日行为。
 *
 * 诚实边界:
 *   - 只拦截**能确证不匹配**的一类:厂商前缀是已知 preset id、无对应运行时池、≠通配池。这是
 *     保守取舍——宁可放过也不误伤能工作的路由(glm/gpt/claude 等命中通配池或有活跃池的一律放行)。
 *   - 不是隔离边界:仅阻止一次必然失败的盲发,并给出可执行的登记指引。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/**
 * 门控 KHY_WILDCARD_POOL_GUARD 是否启用。flagRegistry 优先(集中真源),失败/不可用再退本地
 * CANON 解析。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_WILDCARD_POOL_GUARD', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_WILDCARD_POOL_GUARD;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

/**
 * 从裸模型名提取厂商前缀:取首个分隔符(`-` `.` `:` `/` `_`)之前的 token,小写。
 * 非字符串 / 空 → ''。绝不抛。
 * @param {*} model
 * @returns {string}
 */
function extractVendorPrefix(model) {
  try {
    if (typeof model !== 'string') return '';
    const m = model.trim().toLowerCase();
    if (!m) return '';
    const match = m.match(/^([a-z0-9]+)(?:[-._:/]|$)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function _toLowerSet(list) {
  const out = new Set();
  try {
    for (const item of Array.isArray(list) ? list : []) {
      const s = String(item || '').trim().toLowerCase();
      if (s) out.add(s);
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * 评估一个裸模型在通配兜底下是否会被盲路由到不匹配的池。
 *
 * @param {object} params
 * @param {string} params.model            裸模型名(调用方已确认无 `:`/`/` scoped 前缀命中池)
 * @param {string} params.wildcardPool     即将兜底的通配池(GATEWAY_API_POOL_PROVIDER 归一后)
 * @param {string[]} params.knownPresetIds 已登记 provider preset 的 id 列表(单一真源,防漂移)
 * @param {string[]} params.registeredPools 运行时池里真实存在的 provider 列表
 * @returns {{ok:boolean, mismatch:boolean, vendor:string, reason:string}}
 */
function evaluateWildcardModel(params = {}) {
  try {
    const model = String(params.model || '').trim();
    const wildcardPool = String(params.wildcardPool || '').trim().toLowerCase();
    const vendor = extractVendorPrefix(model);

    // 无法判定的一律放行(保守):无模型 / 无厂商前缀 / 无通配池。
    if (!model || !vendor || !wildcardPool) {
      return { ok: true, mismatch: false, vendor, reason: 'insufficient-signal' };
    }

    // 厂商正是通配池本身 → 匹配,放行。
    if (vendor === wildcardPool) {
      return { ok: true, mismatch: false, vendor, reason: 'vendor-is-wildcard-pool' };
    }

    const presetIds = _toLowerSet(params.knownPresetIds);
    const pools = _toLowerSet(params.registeredPools);

    // 厂商不是任何已登记 preset → 无从断定不匹配(可能是通配池家族的一个模型)→ 放行。
    if (!presetIds.has(vendor)) {
      return { ok: true, mismatch: false, vendor, reason: 'vendor-not-a-known-preset' };
    }

    // 厂商有对应的运行时池(能被正确服务)→ 放行(调用方会另经显式/scoped 命中该池,
    // 或该池本就可用)。
    if (pools.has(vendor)) {
      return { ok: true, mismatch: false, vendor, reason: 'vendor-has-registered-pool' };
    }

    // 确证不匹配:厂商是已知 preset、无运行时池、≠通配池 → 盲发必打错端点。
    return {
      ok: false,
      mismatch: true,
      vendor,
      reason: 'known-preset-without-pool-differs-from-wildcard',
    };
  } catch {
    return { ok: true, mismatch: false, vendor: '', reason: 'error-fail-open' };
  }
}

/**
 * 生成「模型未登记」的清晰可执行提示。门关 → ''(不注入)。绝不抛。
 * key 本体绝不出现在提示里。
 * @param {object} params
 * @param {string} params.model
 * @param {string} params.vendor
 * @param {object} [env]
 * @returns {string}
 */
function buildUnregisteredModelHint(params = {}, env = process.env) {
  try {
    if (!isEnabled(env)) return '';
    const model = String(params.model || '').trim();
    const vendor = String(params.vendor || '').trim();
    if (!model) return '';
    const who = vendor || '该厂商';
    return `模型 ${model} 未登记(${who} provider 无运行时池,无法路由)。`
      + `请先为 ${who} 配置 key/endpoint,或用 pool:model 形式显式指定(如 ${who}:${model})。`;
  } catch {
    return '';
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeWildcardPoolGuard() {
  return {
    gate: 'KHY_WILDCARD_POOL_GUARD',
    defaultOn: true,
    summary: '通配兜底守卫:`api` 通道的裸模型名在显式/scoped 全落空后会盲落 '
      + 'GATEWAY_API_POOL_PROVIDER 默认池。若该模型厂商是已登记 preset 却无运行时池、且≠通配池,'
      + '则盲发必打错端点(实测 agnes-2.0-flash → open.bigmodel.cn → 400 code 1211)。守卫据此'
      + '判定 mismatch,调用方不再盲路由(返回 null),转清晰失败并给出登记/pool:model 指引。'
      + '对称于 relay_api 的 relayModelGuard;显式 pool:model / provider 命中的路由永不受影响。'
      + '门控关则原样盲落(今日行为)。',
  };
}

module.exports = {
  isEnabled,
  extractVendorPrefix,
  evaluateWildcardModel,
  buildUnregisteredModelHint,
  describeWildcardPoolGuard,
};
