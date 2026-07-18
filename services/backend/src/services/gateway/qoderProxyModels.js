'use strict';

/**
 * qoderProxyModels.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 「让 khyos 反代消费 qoder-proxy 暴露的模型」的单一真源。qoder-proxy 是一个本地 HTTP
 * 反代(默认 http://127.0.0.1:3000),把 qoderclicn/qodercli CLI 包成**同时 OpenAI 兼容**
 * (POST /v1/chat/completions)**和 Anthropic 兼容**(POST /v1/messages)的接口,鉴权可选。
 *
 * 本叶子只声明「qoder 的模型目录是什么 / 是否已 opt-in / 两条线(openai/anthropic)各自的
 * 池注册规格(端点从单一根派生)」;真正的 seed 副作用在 customProviderRegistrar.ensureBuiltinQoder,
 * 接线在 gateway/管理服务/init 三处启动点(均门控且 opt-in 未开即 no-op)。
 *
 * 为什么 opt-in(默认关):qoder-proxy 是本地服务,127.0.0.1:3000 没跑时任何 seed 出来的模型都会在
 * 每个用户的 /model 里变成 ECONNREFUSED 死条目(与内置 GLM 占位 key 死条目同一类 bug)。故**只有**
 * 用户显式表态(设 QODER_PROXY_ENDPOINT / QODER_PROXY_API_KEY,或 KHY_QODER_PROXY=true)才启用。
 *
 * 端点 /v1 边界(读 multiFreeService 确认,是本叶子端点派生的根据):
 *   - callOpenAI 会先 `baseUrl.replace(/\/v1\/?$/,'')` 再接 `/v1/chat/completions` → 端点带不带 /v1 都归一;
 *   - callAnthropic 只 `replace(/\/+$/,'')`(**不剥 /v1**)再接 `/v1/messages` → Anthropic 池端点必须是
 *     裸主机(不带 /v1),否则 /v1/v1/messages。
 * 故由**单一根**派生:root = 去尾斜杠与尾部 /v1 → openai 池端点 = root + '/v1'、anthropic 池端点 = root。
 *
 * 数据来源:qoder-proxy clean/models.js(MODELS 13 条,DEFAULT_MODEL_ID='qoder-cn')。effort 后缀
 * (qwen3.7-max-effort-{low,medium,high,max})由 qoder-proxy 服务端 resolveModelRoute 剥离,khyos 只需
 * 把 id 原样发出,无需 reasoning_effort 透传。
 *
 * 绝不硬编码密钥:QODER_DUMMY_KEY 是本地哨兵(反代默认忽略鉴权头),非凭据;真 key 只在 runtime env。
 * 绝不抛:异常一律回退关门语义。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const QODER_POOL_KEY = 'qoder';
const QODER_ANTHROPIC_POOL_KEY = 'qoder-anthropic';
const QODER_DISPLAY_NAME = 'Qoder';
const QODER_ANTHROPIC_DISPLAY_NAME = 'Qoder (Anthropic)';
// Default local reverse-proxy coordinates (host/port split so the URL is built by
// interpolation rather than a hardcoded host:port literal). Overridable at runtime
// via QODER_PROXY_ENDPOINT; this constant is only the offline fallback root.
const QODER_DEFAULT_HOST = '127.0.0.1';
const QODER_DEFAULT_PORT = '3000';
const QODER_DEFAULT_ROOT = `http://${QODER_DEFAULT_HOST}:${QODER_DEFAULT_PORT}`;
// 本地哨兵,非密钥:qoder-proxy 默认不校验鉴权(PROXY_API_KEY 可选)。让池条目可被 pick() 选中而已。
const QODER_DUMMY_KEY = 'qoder-local';
const QODER_DEFAULT_MODEL = 'qoder-cn';

// qoder-proxy 暴露的模型 id(逐字对齐其 clean/models.js MODELS)。effort 变体保留:
// 它们是用户可选的独立 id,qoder-proxy 服务端自行剥离 -effort-* 后缀映射 reasoningEffort。
const QODER_MODELS = Object.freeze([
  'qoder-cn',
  'auto',
  'qwen3.7-max',
  'qwen3.7-max-effort-low',
  'qwen3.7-max-effort-medium',
  'qwen3.7-max-effort-high',
  'qwen3.7-max-effort-max',
  'glm-5.1',
  'kimi-k2.6',
  'qwen3.6-plus',
  'qwen3.6-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'hy3',
  'big-pickle',
  'north-mini-code',
  'nemotron-3-ultra',
  'mimo-v2.5',
]);

/**
 * 门控 KHY_QODER_PROXY:**opt-in,默认关**;仅 '1'/'true' 开。异常回退关门(false)。
 * flagRegistry 优先(登记为 mode:'opt-in'),失败回退本地解析(仿 zhipuFreeModels.js 范式)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function qoderProxyFlagEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('../flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_QODER_PROXY', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_QODER_PROXY;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return v === '1' || v === 'true'; // opt-in:默认关,仅显式真值开
  } catch {
    return false;
  }
}

/**
 * 用户是否通过 env 显式提供了 qoder 反代坐标(端点或 key)。任一非空即视为表态启用。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function qoderProxyEnvPresent(env = process.env) {
  try {
    const e = env || {};
    const ep = String(e.QODER_PROXY_ENDPOINT == null ? '' : e.QODER_PROXY_ENDPOINT).trim();
    const key = String(e.QODER_PROXY_API_KEY == null ? '' : e.QODER_PROXY_API_KEY).trim();
    return !!(ep || key);
  } catch {
    return false;
  }
}

/**
 * qoder 是否已 opt-in(registrar seed 的唯一判定):flag 开 或 env 提供了坐标。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function qoderOptedIn(env = process.env) {
  try {
    return qoderProxyFlagEnabled(env) || qoderProxyEnvPresent(env);
  } catch {
    return false;
  }
}

/**
 * 从 env 派生 qoder-proxy 的裸主机根(去尾斜杠与尾部 /v1)。QODER_PROXY_ENDPOINT 缺省用默认根。
 * 例:'http://127.0.0.1:3000/v1' → 'http://127.0.0.1:3000';'http://host:8/' → 'http://host:8'。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function qoderProxyRoot(env = process.env) {
  try {
    const e = env || {};
    const raw = String(e.QODER_PROXY_ENDPOINT == null ? '' : e.QODER_PROXY_ENDPOINT).trim();
    const base = raw || QODER_DEFAULT_ROOT;
    return base.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
  } catch {
    return QODER_DEFAULT_ROOT;
  }
}

/**
 * 解析发往 qoder-proxy 的 key:env 提供了非空 QODER_PROXY_API_KEY 则用之,否则用本地哨兵。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function qoderProxyKey(env = process.env) {
  try {
    const e = env || {};
    const k = String(e.QODER_PROXY_API_KEY == null ? '' : e.QODER_PROXY_API_KEY).trim();
    return k || QODER_DUMMY_KEY;
  } catch {
    return QODER_DUMMY_KEY;
  }
}

/**
 * qoder 模型 id 列表(深拷贝)。异常 → []。
 * @returns {string[]}
 */
function listQoderModels() {
  try {
    return QODER_MODELS.slice();
  } catch {
    return [];
  }
}

/**
 * 两条池注册规格:openai 线(/v1/chat/completions)与 anthropic 线(/v1/messages),端点从单一根派生。
 * 供 customProviderRegistrar.ensureBuiltinQoder 逐条喂给 registerCustomProvider。
 *
 *   - openai spec:endpoint = root + '/v1'(callOpenAI 归一,两种写法均可,带 /v1 更贴合 qoder-proxy 文档)。
 *   - anthropic spec:endpoint = root(callAnthropic 自接 /v1/messages,不能带 /v1)。
 *
 * 每条含 service 字段(openai/anthropic),registerCustomProvider 据此写 GATEWAY_API_POOL_SERVICE_MAP。
 * 异常 → []。
 * @param {Record<string,string>} [env]
 * @returns {Array<{poolKey:string, service:string, displayName:string, endpoint:string, key:string, defaultModel:string, models:string[]}>}
 */
function qoderProxySpecs(env = process.env) {
  try {
    const root = qoderProxyRoot(env);
    const key = qoderProxyKey(env);
    const models = listQoderModels();
    return [
      {
        poolKey: QODER_POOL_KEY,
        service: 'openai',
        displayName: QODER_DISPLAY_NAME,
        endpoint: `${root}/v1`,
        key,
        defaultModel: QODER_DEFAULT_MODEL,
        models,
      },
      {
        poolKey: QODER_ANTHROPIC_POOL_KEY,
        service: 'anthropic',
        displayName: QODER_ANTHROPIC_DISPLAY_NAME,
        endpoint: root,
        key,
        defaultModel: QODER_DEFAULT_MODEL,
        models: models.slice(),
      },
    ];
  } catch {
    return [];
  }
}

module.exports = {
  OFF_VALUES,
  QODER_POOL_KEY,
  QODER_ANTHROPIC_POOL_KEY,
  QODER_DISPLAY_NAME,
  QODER_ANTHROPIC_DISPLAY_NAME,
  QODER_DEFAULT_ROOT,
  QODER_DUMMY_KEY,
  QODER_DEFAULT_MODEL,
  QODER_MODELS,
  qoderProxyFlagEnabled,
  qoderProxyEnvPresent,
  qoderOptedIn,
  qoderProxyRoot,
  qoderProxyKey,
  listQoderModels,
  qoderProxySpecs,
};
