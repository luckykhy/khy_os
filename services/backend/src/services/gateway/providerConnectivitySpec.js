'use strict';

/**
 * providerConnectivitySpec.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * /goal「把各个模型厂商的测试命令写成脚本,方便 pip 装后输入 key 测试是否连通」。
 * 本叶子是「厂商连通性自检」的单一真源:给定 厂商 + key(+ 可选端点/模型),确定性地
 * 产出一条**最小探针请求** {method,url,headers,body};并把 HTTP 状态码 / 网络错误码
 * 归类成人话结论(连通且 key 有效 / 连通但 key 无效 / 换模型 / 不可达 …)。
 * 真正发请求由薄 IO 壳 providerConnectivityTester.js 承担;本层不碰网络/文件。
 *
 * 复用 builtinProviderConfig.BUILTIN_PROVIDERS 作为厂商目录 SSoT(名称 / poolKey / 端点 /
 * 模型),不另维护一份厂商表。协议族按 poolKey 归类:OpenAI 兼容(chat/completions,Bearer)、
 * Anthropic(/v1/messages,x-api-key);无法用这两种统一探针可靠自测的厂商(文心 AK/SK、
 * Trae 原生协议、HuggingFace Token)诚实标记为「跳过」并给出理由,绝不伪造测试结果。
 *
 * 契约(leaf-contract):零 IO、确定性(同输入同输出)、fail-soft 绝不抛、env 门控
 * KHY_PROVIDER_CONNECTIVITY_TEST 默认开(flagRegistry-first + 注册表关时本地回退)。
 * **绝不落盘任何 key**——key 只在调用时传入,产物 headers 里含 key 仅供即时发一次请求。
 *
 * @module services/gateway/providerConnectivitySpec
 */

const flagRegistry = require('../flagRegistry');
const { listBuiltinProviders, findBuiltinProvider } = require('./builtinProviderConfig');

/** 关闭词表(对齐仓库既有门控约定)。注册表关时的 OFF-fallback 路径。 */
const _OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 本功能是否启用。默认开;仅当 KHY_PROVIDER_CONNECTIVITY_TEST 显式置关闭词才禁用。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    if (flagRegistry.isRegistryEnabled(env)) {
      return flagRegistry.isFlagEnabled('KHY_PROVIDER_CONNECTIVITY_TEST', env);
    }
    const raw = String((env && env.KHY_PROVIDER_CONNECTIVITY_TEST) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

// ── 协议族归类(按 poolKey)──────────────────────────────────────────────────────
// OpenAI 兼容:POST {root}/v1/chat/completions,Authorization: Bearer。
const _OPENAI_COMPATIBLE = new Set(['deepseek', 'qwen', 'glm', 'doubao', 'openai', 'relay']);
// Anthropic:POST {base}/v1/messages,x-api-key + anthropic-version。
const _ANTHROPIC = new Set(['anthropic']);

// 无法用统一 OpenAI/Anthropic 探针可靠自测的厂商 → 诚实跳过并说明理由(而非伪造结果)。
const _SKIP_REASON = Object.freeze({
  wenxin: '百度文心用 AK/SK 换 access_token 的独有鉴权(非 Bearer),统一探针会误判',
  trae: 'Trae 用原生 adaptive-api 协议(非 OpenAI/Anthropic 兼容)且默认端点留空',
  huggingface: 'HuggingFace 用 HF Token + Inference API,与本探针的 chat/completions 形态不同',
});

// 每个可测厂商的**廉价探针模型**(尽量选小/快);缺省回退到目录 models[0]。
// 注:豆包(doubao)的 model 实为用户自建的推理接入点 ID,默认名很可能 model_not_found——
// 但那仍证明「端点可达 + 鉴权通过」,连通性判定依旧有意义(结论会提示换模型)。
const _TEST_MODEL = Object.freeze({
  deepseek: 'deepseek-chat',
  qwen: 'qwen-turbo',
  glm: 'glm-4-flash',
  doubao: 'doubao-lite-32k',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-20241022',
});

/**
 * 返回 poolKey 对应的协议族:'openai' | 'anthropic' | ''(不可自测)。
 * @param {string} poolKey
 * @returns {string}
 */
function serviceFor(poolKey) {
  const k = String(poolKey || '').trim().toLowerCase();
  if (!k) return '';
  if (_ANTHROPIC.has(k)) return 'anthropic';
  if (_OPENAI_COMPATIBLE.has(k)) return 'openai';
  return '';
}

/** 由 env 覆盖 + 目录默认解析端点(纯函数:仅读传入 env)。 */
function _resolveEndpoint(p, env) {
  const override = p.envEndpoint ? String((env && env[p.envEndpoint]) || '').trim() : '';
  return override || String(p.defaultEndpoint || '').trim();
}

/**
 * 由厂商端点派生 OpenAI 兼容的 chat/completions 完整 URL(适配各厂商版本段约定)。
 *   已是完整 …/chat/completions → 原样;以版本段结尾(/v1、/v3、/v4…)→ + /chat/completions;
 *   裸主机(无版本段)→ + /v1/chat/completions。
 * @param {string} endpoint
 * @returns {string}
 */
function _openaiChatCompletionsUrl(endpoint) {
  const base = String(endpoint || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * 列出全部厂商的连通性目标(含不可测者,诚实带 skipReason)。
 * @param {object} [env]
 * @returns {Array<{name,poolKey,envKey,envEndpoint,service,endpoint,testModel,testable,skipReason}>}
 */
function listConnectivityTargets(env = process.env) {
  if (!isEnabled(env)) return [];
  try {
    const out = [];
    for (const p of listBuiltinProviders()) {
      const poolKey = p.poolKey || '';
      if (!poolKey) {
        // HuggingFace(poolKey=null / Token)等:不可用统一探针测。
        out.push({
          name: p.name, poolKey: '', envKey: p.envKey || '', envEndpoint: '',
          service: '', endpoint: '', testModel: '',
          testable: false, skipReason: _SKIP_REASON.huggingface || '暂不支持自动连通测试',
        });
        continue;
      }
      const service = serviceFor(poolKey);
      const endpoint = _resolveEndpoint(p, env);
      const testModel = _TEST_MODEL[poolKey]
        || (Array.isArray(p.models) && p.models[0]) || '';
      const testable = !!service && !_SKIP_REASON[poolKey];
      out.push({
        name: p.name, poolKey, envKey: p.envKey || '', envEndpoint: p.envEndpoint || '',
        service, endpoint, testModel,
        testable, skipReason: testable ? '' : (_SKIP_REASON[poolKey] || '暂不支持自动连通测试'),
      });
    }
    return out;
  } catch { return []; }
}

/**
 * 解析单个厂商(名称 / poolKey / 别名,借 findBuiltinProvider 的别名容错)→ 连通性目标。
 * @param {string} nameOrPoolKey
 * @param {object} [env]
 * @returns {object|null}
 */
function resolveConnectivityTarget(nameOrPoolKey, env = process.env) {
  if (!isEnabled(env)) return null;
  try {
    const needle = String(nameOrPoolKey || '').trim();
    if (!needle) return null;
    const p = findBuiltinProvider(needle);
    const list = listConnectivityTargets(env);
    if (p && p.poolKey) {
      const byKey = list.find((t) => t.poolKey === p.poolKey);
      if (byKey) return byKey;
    }
    // 名称精确(小写)兜底(覆盖 poolKey=null 的 HuggingFace)。
    const low = needle.toLowerCase();
    return list.find((t) => String(t.name || '').toLowerCase() === low
      || String(t.poolKey || '').toLowerCase() === low) || null;
  } catch { return null; }
}

/**
 * 为一个厂商构造最小连通性探针请求。纯函数:给定输入即定输出,绝不抛。
 * 成功 → {ok:true, service, poolKey, name, method, url, headers, body, model, endpoint};
 * 失败 → {ok:false, reason}(门关 / 未知厂商 / 不可测 / 缺 key / 缺端点 / 缺模型)。
 * @param {{poolKey?:string,name?:string,key?:string,endpoint?:string,model?:string}} input
 * @param {object} [env]
 */
function buildConnectivityRequest(input = {}, env = process.env) {
  const FAIL = (reason) => ({ ok: false, reason: String(reason || '无法构造请求') });
  try {
    if (!isEnabled(env)) return FAIL('连通性自检已被 KHY_PROVIDER_CONNECTIVITY_TEST 关闭');
    const idOrName = String((input && (input.poolKey || input.name)) || '').trim();
    const target = resolveConnectivityTarget(idOrName, env);
    if (!target) return FAIL(`未知厂商: ${idOrName || '(空)'}`);
    if (!target.testable) return FAIL(`${target.name} ${target.skipReason || '不支持自动连通测试'}`);

    const key = String((input && input.key) || '').trim();
    if (!key) return FAIL(`缺少 ${target.name} 的 API Key`);
    const endpoint = String((input && input.endpoint) || target.endpoint || '').trim();
    const model = String((input && input.model) || target.testModel || '').trim();
    if (!endpoint) return FAIL(`${target.name} 缺少端点(请用 --endpoint 指定)`);
    if (!model) return FAIL(`${target.name} 缺少测试模型(请用 --model 指定)`);

    if (target.service === 'anthropic') {
      // callAnthropic 语义:端点应为**裸主机**(不含 /v1),再接 /v1/messages。目录里 anthropic
      // 端点存的是 `https://api.anthropic.com/v1`,故先剥尾部 /v1,避免 /v1/v1/messages。
      const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
      return {
        ok: true, service: 'anthropic', poolKey: target.poolKey, name: target.name,
        method: 'POST', url: `${base}/v1/messages`,
        headers: {
          'x-api-key': key,
          'anthropic-version': '2024-10-22',
          'Content-Type': 'application/json',
        },
        body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
        model, endpoint: base,
      };
    }

    // OpenAI 兼容:各厂商端点约定不一,统一派生 chat/completions:
    //   - 已是完整 …/chat/completions → 原样;
    //   - 以版本段结尾(/v1、/v3、/api/paas/v4、…/compatible-mode/v1)→ 直接 + /chat/completions;
    //   - 裸主机(无版本段,如 https://api.openai.com、中转根)→ + /v1/chat/completions。
    const base = _openaiChatCompletionsUrl(endpoint);
    return {
      ok: true, service: 'openai', poolKey: target.poolKey, name: target.name,
      method: 'POST', url: base,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
      model, endpoint: endpoint.replace(/\/+$/, ''),
    };
  } catch (e) { return FAIL(e && e.message ? e.message : String(e)); }
}

// 网络层错误码(非 HTTP 状态)→ 判为「不可达」。
const _NET_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET',
  'ECONNABORTED', 'EPROTO', 'EHOSTUNREACH', 'ENETUNREACH',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/**
 * 把 HTTP 状态码 / 网络错误码归类成人话结论。纯函数,绝不抛。
 * @param {{status?:number, errorCode?:string}} input
 * @returns {{verdict:string, reachable:boolean, keyValid?:boolean, label:string}}
 */
function classifyConnectivityResult(input = {}) {
  try {
    const status = Number(input && input.status);
    const code = String((input && input.errorCode) || '').toUpperCase();
    if (Number.isFinite(status) && status > 0) {
      if (status >= 200 && status < 300) {
        return { verdict: 'ok', reachable: true, keyValid: true, label: '连通,key 有效' };
      }
      if (status === 401 || status === 403) {
        return { verdict: 'bad_key', reachable: true, keyValid: false, label: '连通,但 API Key 无效或未授权' };
      }
      if (status === 404) {
        return { verdict: 'model_or_endpoint', reachable: true, label: '连通,但模型名或端点不对(换模型 / 端点)' };
      }
      if (status === 429) {
        return { verdict: 'rate_limited', reachable: true, keyValid: true, label: '连通,key 有效,但被限流(429)' };
      }
      if (status === 400 || status === 422) {
        return { verdict: 'bad_request', reachable: true, label: `连通,但请求被拒(${status},可能模型 / 参数问题)` };
      }
      if (status >= 500) {
        return { verdict: 'server_error', reachable: true, label: `连通,但服务端错误(${status})` };
      }
      return { verdict: 'unknown', reachable: true, label: `连通,未知状态码(${status})` };
    }
    if (code && (_NET_CODES.has(code) || code.includes('TIMEOUT'))) {
      return { verdict: 'unreachable', reachable: false, label: `无法连通(${code})` };
    }
    if (code) return { verdict: 'unknown', reachable: false, label: `未知错误(${code})` };
    return { verdict: 'unknown', reachable: false, label: '未知结果' };
  } catch { return { verdict: 'unknown', reachable: false, label: '未知结果' }; }
}

module.exports = {
  isEnabled,
  serviceFor,
  listConnectivityTargets,
  resolveConnectivityTarget,
  buildConnectivityRequest,
  classifyConnectivityResult,
  _TEST_MODEL,
  _SKIP_REASON,
};
