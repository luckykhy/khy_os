'use strict';

/**
 * ccSwitch connectivity — minimal probe request for a card's upstream.
 *
 * Given a card + raw key, build and fire ONE minimal request against the
 * card's upstream and classify the outcome (reachable + key valid / reachable +
 * key invalid / unreachable). Deterministic classification lives in the pure
 * leaf below; the network call is isolated here so store/CLI stay IO-light.
 *
 * Fail-soft: never throws — always returns a verdict object. Key is used only
 * in this one request's headers and is never persisted.
 */

const spec = require('../../../gateway/providerConnectivitySpec');
const { request: nativeRequest } = require('../../../../utils/nativeHttp');
const { PROTOCOLS } = require('../../collab/proactiveCollaboration/constants');

function _protocolFamily(protocol) {
  if (protocol === PROTOCOLS.ANTHROPIC) {
    return 'anthropic';
  }
  if (protocol === PROTOCOLS.GEMINI) {
    return 'gemini';
  }
  return 'openai';
}

/**
 * Pure classifier: map { status, errorCode } → verdict. Mirrors
 * providerConnectivitySpec's verdict vocabulary so CLI output stays consistent.
 */
function classify({ status, errorCode } = {}) {
  const s = Number(status) || 0;
  if (s === 200) {
    return { verdict: 'ok', label: '连通且鉴权通过' };
  }
  if (s === 401 || s === 403) {
    return { verdict: 'bad-key', label: '端点可达但密钥无效' };
  }
  if (s === 404) {
    return { verdict: 'model-not-found', label: '端点可达，模型不存在' };
  }
  if (s === 429) {
    return { verdict: 'rate-limited', label: '端点可达但被限流' };
  }
  if (s === 0 && errorCode) {
    return { verdict: 'unreachable', label: '无法连接（网络错误）' };
  }
  if (s >= 500) {
    return { verdict: 'server-error', label: `服务端错误（HTTP ${s}）` };
  }
  if (s >= 400) {
    return { verdict: 'http-error', label: `HTTP 错误（${s}）` };
  }
  return { verdict: 'unknown', label: '未知结果' };
}

/**
 * Fire a single minimal probe request against the card's upstream.
 *
 * @param {{ card: object, key?: string, model?: string, timeoutMs?: number }} input
 * @returns {Promise<{ok:boolean, verdict:string, label:string, status:number, latencyMs:number, model?:string, error?:string}>}
 */
async function testCardConnectivity({ card, key, model, timeoutMs } = {}) {
  const started = Date.now();
  const family = _protocolFamily(card && card.protocol);
  const endpoint = String((card && card.baseUrl) || '').replace(/\/+$/, '');
  const probeModel = model || (card && card.defaultModel) || '';

  if (!endpoint) {
    return {
      ok: false,
      verdict: 'skipped',
      label: '卡片缺少 baseUrl，跳过',
      status: 0,
      latencyMs: Date.now() - started,
      model: probeModel || undefined,
    };
  }

  let url = '';
  let headers = {};
  let body = undefined;

  try {
    if (family === 'anthropic') {
      url = `${endpoint}/v1/messages`;
      headers = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(key ? { 'x-api-key': key } : {}),
      };
      body = JSON.stringify({
        model: probeModel || 'claude-sonnet-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } else if (family === 'gemini') {
      const modelPart = probeModel ? `/${probeModel}` : '';
      url = `${endpoint}/v1beta/models${modelPart}:generateContent`;
      headers = {
        'content-type': 'application/json',
        ...(key ? { 'x-goog-api-key': key } : {}),
      };
      body = JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] });
    } else {
      // openai / openai_responses both probe chat/completions (the responses
      // wire shares the same auth + reachability surface).
      url = `${endpoint}/chat/completions`;
      headers = {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      };
      body = JSON.stringify({
        model: probeModel || 'gpt-4o-mini',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    }
  } catch (e) {
    return {
      ok: false,
      verdict: 'skip',
      label: `构造探针请求失败: ${e && e.message}`,
      status: 0,
      latencyMs: Date.now() - started,
    };
  }

  try {
    const resp = await nativeRequest(url, {
      method: 'POST',
      headers,
      body,
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000,
    });
    const cls = classify({ status: resp.status });
    return {
      ok: cls.verdict === 'ok',
      verdict: cls.verdict,
      label: cls.label,
      status: resp.status,
      latencyMs: Date.now() - started,
      model: probeModel || undefined,
    };
  } catch (err) {
    const status = err && err.response && err.response.status;
    const cls = classify({ status, errorCode: err && err.code });
    return {
      ok: false,
      verdict: cls.verdict,
      label: cls.label,
      status: status || 0,
      latencyMs: Date.now() - started,
      error: err && err.message ? err.message : String(err),
      model: probeModel || undefined,
    };
  }
}

module.exports = { testCardConnectivity, classify, _protocolFamily };
