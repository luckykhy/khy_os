'use strict';

/**
 * vertexRequestShaping — 纯叶子:把 Gemini 线格式的模型规格,确定性地成形为 Google Vertex AI
 * 的端点 URL、鉴权方式与请求体格式描述。零 IO、确定性、绝不抛。
 *
 * 背景(移植自 Hermes v0.18.0「支持 Google Vertex AI」):
 *   Vertex 复用 Gemini 的线格式请求体(contents / generationConfig,由共享 protocolConverter
 *   的 buildGeminiRequest 产出),与 Google AI Studio(generativelanguage.googleapis.com)相比
 *   唯二不同的是:
 *     1) 端点 URL 方案 —— Vertex 走
 *        https://{location}-aiplatform.googleapis.com/{apiVersion}/projects/{project}/
 *        locations/{location}/publishers/google/models/{model}:generateContent
 *        (location='global' 时 host 改为 aiplatform.googleapis.com,不带地域前缀)。
 *     2) 鉴权 —— OAuth2 access token 作 `Authorization: Bearer`(keyField=authorization_bearer),
 *        而非 AI Studio 的 `x-goog-api-key`。
 *
 * 本叶子只做「字符串成形 + 参数描述」:不发任何 HTTP 请求、不构造请求体(体沿用现有 Gemini
 * 转换器,单一真源),也不含任何模型名字面量(model 一律由调用方作参数传入)。它是未来 live
 * adapter 拼 Vertex URL / 选鉴权头的确定性 SSOT。
 *
 * 门控 KHY_VERTEX_REQUEST_SHAPING(默认开;0/false/off/no → 关)。关门 / 缺参 / 异常 →
 *   describeVertexRequest 返回 { ok:false, reason },不改任何其他行为。
 *
 * 纯函数:除一次门控读取外零副作用、绝不抛。
 */

const KHY_VERTEX_REQUEST_SHAPING = 'KHY_VERTEX_REQUEST_SHAPING';
const DEFAULT_API_VERSION = 'v1';
const VERTEX_KEY_FIELD = 'authorization_bearer'; // OAuth2 access token → Authorization: Bearer
const VERTEX_BODY_FORMAT = 'gemini'; // 请求体沿用 Gemini 线格式(单一真源:protocolConverter)

/**
 * 门控 KHY_VERTEX_REQUEST_SHAPING:默认开;0/false/off/no → 关。异常 → 关门(false)。
 * @param {object} [env]
 * @returns {boolean}
 */
function vertexShapingEnabled(env = process.env) {
  try {
    const raw = env && env[KHY_VERTEX_REQUEST_SHAPING];
    if (raw == null || String(raw).trim() === '') return true; // 缺省 → 默认开
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  } catch {
    return false;
  }
}

function _str(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Vertex 端点 host。global 端点无地域前缀。
 * @param {string} location 地域,如 `us-central1` 或 `global`
 * @returns {string}
 */
function buildVertexHost(location) {
  const loc = _str(location);
  if (!loc || loc.toLowerCase() === 'global') return 'aiplatform.googleapis.com';
  return `${loc}-aiplatform.googleapis.com`;
}

/**
 * Vertex 基址(到 `.../publishers/google` 为止)—— 正是填进网关表单 baseUrl 的值,配合现有
 * Gemini relay 分支(它会再拼 `/models/${model}:generateContent`)即得到完整 Vertex URL。
 * @param {{project?:string, location?:string, apiVersion?:string}} spec
 * @returns {string} 成形失败(缺 project/location)→ 空串
 */
function buildVertexBaseUrl(spec = {}) {
  const project = _str(spec.project);
  const location = _str(spec.location);
  if (!project || !location) return '';
  const apiVersion = _str(spec.apiVersion) || DEFAULT_API_VERSION;
  const host = buildVertexHost(location);
  return `https://${host}/${apiVersion}/projects/${project}/locations/${location}/publishers/google`;
}

/**
 * 完整 Vertex 端点 URL(含 `:generateContent` 或 `:streamGenerateContent`)。
 * @param {{project?:string, location?:string, model?:string, streaming?:boolean, apiVersion?:string}} spec
 * @returns {string} 成形失败(缺 project/location/model)→ 空串
 */
function buildVertexEndpoint(spec = {}) {
  const base = buildVertexBaseUrl(spec);
  const model = _str(spec.model);
  if (!base || !model) return '';
  const method = spec.streaming ? 'streamGenerateContent' : 'generateContent';
  return `${base}/models/${model}:${method}`;
}

/**
 * 一次性成形规划:门关 → disabled;缺参 → missing-*;否则返回完整 plan。绝不抛。
 * @param {{project?:string, location?:string, model?:string, streaming?:boolean, apiVersion?:string}} spec
 * @param {object} [env]
 * @returns {{ok:boolean, reason:string, host?:string, baseUrl?:string, url?:string, method?:string, keyField?:string, bodyFormat?:string}}
 */
function describeVertexRequest(spec = {}, env = process.env) {
  try {
    if (!vertexShapingEnabled(env)) return { ok: false, reason: 'disabled' };
    const project = _str(spec && spec.project);
    const location = _str(spec && spec.location);
    const model = _str(spec && spec.model);
    if (!project) return { ok: false, reason: 'missing-project' };
    if (!location) return { ok: false, reason: 'missing-location' };
    if (!model) return { ok: false, reason: 'missing-model' };
    const apiVersion = _str(spec && spec.apiVersion) || DEFAULT_API_VERSION;
    const host = buildVertexHost(location);
    const baseUrl = buildVertexBaseUrl({ project, location, apiVersion });
    const url = buildVertexEndpoint({ project, location, model, streaming: !!(spec && spec.streaming), apiVersion });
    const method = spec && spec.streaming ? 'streamGenerateContent' : 'generateContent';
    return {
      ok: true,
      reason: 'shaped',
      host,
      baseUrl,
      url,
      method,
      keyField: VERTEX_KEY_FIELD,
      bodyFormat: VERTEX_BODY_FORMAT,
    };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

module.exports = {
  KHY_VERTEX_REQUEST_SHAPING,
  VERTEX_KEY_FIELD,
  VERTEX_BODY_FORMAT,
  vertexShapingEnabled,
  buildVertexHost,
  buildVertexBaseUrl,
  buildVertexEndpoint,
  describeVertexRequest,
};
