'use strict';

/**
 * zhipuRequestShape.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「multiFreeService.callZhipu 仍停留在旧版 JWT 鉴权 + 丢弃 reasoning_effort」两处缺口,
 * 使之对齐智谱 GLM v4 chat-completions 官方调用约定:
 *
 *   ① 鉴权:v4 端点(https://open.bigmodel.cn/api/paas/v4/chat/completions)采用**标准 HTTP
 *      Bearer**、直接以原始 API key 作 token——不再要求把 key 拆成 `id.secret` 再签 JWT。仓内
 *      主路径(routes/ai.js、gateway/providerPresets zhipu preset、apiKeyPool)早已是原始 Bearer,
 *      唯 multiFreeService.callZhipu 仍走 generateZhipuJWT:遇到**非 `id.secret` 形态**(新版单段
 *      不透明 key)会直接抛 'Invalid Zhipu API key format, expected id.secret'。
 *   ② reasoning_effort:GLM-5.2 招牌请求参数(max/xhigh/high/medium/low/minimal/none),
 *      callZhipu 目前只透传 temperature/max_tokens,把它丢了 → 经此路径调 GLM-5.2 打不到线上。
 *
 * 本叶子只提供**纯决策**,真正的 JWT 签名 / axios 发送仍在 multiFreeService 侧:
 *
 *   - 鉴权模式(KHY_ZHIPU_RAW_BEARER 默认开):
 *       · 关(0/false/off/no)→ resolveZhipuAuthMode 恒 'jwt' → 调用方逐字节回退「永远
 *         generateZhipuJWT」旧行为(含对坏格式 key 抛错);
 *       · 开 → `id.secret` 形态仍判 'jwt'(不改变今日**能正常工作**的 key 的行为,严格超集),
 *         非 `id.secret` 形态判 'raw'(把原始 key 直接作 Bearer,修掉原本必抛的那一类)。
 *   - reasoning_effort 透传(KHY_ZHIPU_REASONING_EFFORT 默认开):
 *       · 关 → pickReasoningEffort 恒 null → 调用方不写该字段(逐字节回退);
 *       · 开 → 从 opts.reasoningEffort / opts.reasoning_effort 取值,规范化为合法枚举后返回,
 *         非法/缺失 → null(仍不写,避免污染请求体)。
 *
 * 密钥仅在进程内经 Bearer 头传递,绝不落命令行或日志。绝不抛:异常一律回退关门语义
 * (auth→'jwt'、reasoning_effort→null),即最保守的「不改变旧行为」。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// GLM v4 reasoning_effort 合法枚举(见官方 chat-completions 文档):
//   none|minimal 关闭/最小思考;low|medium 提升到 high;high 标准;xhigh→max;max 最大。
// 我们只做「合法性过滤 + 原样透传」,不做等价折叠(折叠由智谱服务端负责,叶子保持诚实原样)。
const VALID_REASONING_EFFORT = Object.freeze([
  'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none',
]);

/**
 * 通用门控读取:flagRegistry 优先(登记为 default-on),不可用则回退本地 CANON 解析。
 * 异常回退关门(false)。
 * @param {string} flagName
 * @param {Record<string,string>} env
 * @returns {boolean}
 */
function _flagEnabled(flagName, env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled(flagName, e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e[flagName];
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 门控 KHY_ZHIPU_RAW_BEARER:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function zhipuRawBearerEnabled(env = process.env) {
  return _flagEnabled('KHY_ZHIPU_RAW_BEARER', env);
}

/**
 * 门控 KHY_ZHIPU_REASONING_EFFORT:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function zhipuReasoningEffortEnabled(env = process.env) {
  return _flagEnabled('KHY_ZHIPU_REASONING_EFFORT', env);
}

/**
 * 门控 KHY_ZHIPU_V4_RAW_BEARER:默认开(parent KHY_ZHIPU_RAW_BEARER)。
 * 官方 v4 端点上,即使 `id.secret` 形态的 key 也改走**原始 Bearer**(而非 JWT)。
 * 背景/实测:multiFreeService.callZhipu 对 `id.secret` 形态一直签 legacy JWT
 * (`{api_key:id, exp, timestamp}` HS256),而仓内所有主路径 + `khy test-key`(providerConnectivitySpec)
 * 对同一 key 走「原始 key 作 Bearer」,对官方 v4 端点(https://open.bigmodel.cn/api/paas/v4)
 * 的新版永久免费视觉模型(glm-4.6v-flash / glm-4v-flash)实测 **raw Bearer→200、JWT→404
 * model_not_found**(legacy JWT 鉴权上下文看不到这批新模型)。开门 → v4 端点上 id.secret 也用 raw,
 * 与 test-key 一致;关门/异常 → 逐字节回退原「id.secret→jwt」。仅收窄到官方 v4 端点,
 * 自定义/中转端点仍保留 JWT(严格超集,不动那些今日靠 JWT 工作的端点)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function zhipuV4RawBearerEnabled(env = process.env) {
  return _flagEnabled('KHY_ZHIPU_V4_RAW_BEARER', env);
}

/**
 * 判定 endpoint 是否为智谱**官方 v4** 端点(host = open.bigmodel.cn 且路径含 /api/paas/v4)。
 * 纯字符串判定:大小写不敏感、容忍尾斜杠与是否已带 /chat/completions。绝不抛。
 * @param {string} endpoint
 * @returns {boolean}
 */
function isOfficialZhipuV4Endpoint(endpoint) {
  try {
    const e = String(endpoint == null ? '' : endpoint).trim().toLowerCase();
    if (!e) return false;
    return e.includes('open.bigmodel.cn') && e.includes('/api/paas/v4');
  } catch {
    return false;
  }
}

/**
 * apiKey 是否为历史 `id.secret` 形态(两段、皆非空)——即今日 generateZhipuJWT 能正常签发的形态。
 * 用于「严格超集」判定:此类 key 今日能用,保持走 JWT 不改行为;其余(单段新 key)才改走 raw。
 * @param {string} apiKey
 * @returns {boolean}
 */
function hasIdSecretShape(apiKey) {
  try {
    if (typeof apiKey !== 'string') return false;
    const parts = apiKey.split('.');
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
  } catch {
    return false;
  }
}

/**
 * 解析 zhipu 鉴权模式:
 *   - 门关 → 'jwt'(逐字节回退:调用方永远 generateZhipuJWT,含对坏格式 key 抛错的旧行为);
 *   - 门开 → `id.secret` 形态:官方 v4 端点 + KHY_ZHIPU_V4_RAW_BEARER 开 → 'raw'
 *     (与 test-key/主路径一致,救回新版免费视觉模型);否则 'jwt'(不改今日靠 JWT 工作的
 *     自定义/中转端点);非 `id.secret` 形态 → 'raw'(原始 key 作 Bearer)。
 * 异常 → 'jwt'(最保守,回退旧行为)。
 * @param {string} apiKey
 * @param {Record<string,string>} [env]
 * @param {string} [endpoint]  实际请求端点(供官方 v4 判定;缺省 → 不视为 v4,保留 JWT)
 * @returns {'jwt'|'raw'}
 */
function resolveZhipuAuthMode(apiKey, env = process.env, endpoint = '') {
  try {
    if (!zhipuRawBearerEnabled(env)) return 'jwt';
    if (!hasIdSecretShape(apiKey)) return 'raw';
    // `id.secret` 形态:默认保守走 JWT,唯官方 v4 端点(raw Bearer 已被 test-key 实测证明可用、
    // 且新版免费视觉模型只在此鉴权上下文可见)+ 子门开 → 改走 raw。
    if (isOfficialZhipuV4Endpoint(endpoint) && zhipuV4RawBearerEnabled(env)) return 'raw';
    return 'jwt';
  } catch {
    return 'jwt';
  }
}

/**
 * 规范化 reasoning_effort 值:trim + lowercase,命中合法枚举则原样返回,否则 null。
 * @param {*} value
 * @returns {string|null}
 */
function normalizeReasoningEffort(value) {
  try {
    if (value == null) return null;
    const v = String(value).trim().toLowerCase();
    return VALID_REASONING_EFFORT.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 从 opts 取 reasoning_effort 透传值:
 *   - 门关 → null(逐字节回退:调用方不写该字段);
 *   - 门开 → opts.reasoningEffort ?? opts.reasoning_effort 规范化后返回,非法/缺失 → null。
 * 异常 → null。
 * @param {Record<string,*>} [opts]
 * @param {Record<string,string>} [env]
 * @returns {string|null}
 */
function pickReasoningEffort(opts = {}, env = process.env) {
  try {
    if (!zhipuReasoningEffortEnabled(env)) return null;
    const o = opts || {};
    const raw = o.reasoningEffort != null ? o.reasoningEffort : o.reasoning_effort;
    return normalizeReasoningEffort(raw);
  } catch {
    return null;
  }
}

module.exports = {
  VALID_REASONING_EFFORT,
  zhipuRawBearerEnabled,
  zhipuReasoningEffortEnabled,
  zhipuV4RawBearerEnabled,
  isOfficialZhipuV4Endpoint,
  hasIdSecretShape,
  resolveZhipuAuthMode,
  normalizeReasoningEffort,
  pickReasoningEffort,
};
