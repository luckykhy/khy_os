'use strict';

/**
 * providerConnectivityTester.js — 厂商连通性自检的薄 IO 壳。
 *
 * 判定 / 请求构造全部委托 providerConnectivitySpec(单一真源);本层只负责真正发一次
 * HTTP 探针请求、计时、把网络异常 / 状态码交回 spec 归类。fail-soft:任何异常都转成
 * 一个 verdict 结果对象,绝不抛。**绝不落盘 key**——key 只在本次请求头里用一次。
 *
 * @module services/gateway/providerConnectivityTester
 */

const spec = require('./providerConnectivitySpec');

/**
 * 测试单个厂商的连通性。
 * @param {{poolKey?:string,name?:string,key?:string,endpoint?:string,model?:string,timeoutMs?:number}} input
 * @param {object} [env]
 * @returns {Promise<object>} {ok,verdict,label,status,latencyMs,service,poolKey,name,model,endpoint,[error]}
 */
async function testConnectivity(input = {}, env = process.env) {
  const built = spec.buildConnectivityRequest(input, env);
  if (!built.ok) {
    return {
      ok: false, testable: false, verdict: 'skipped', label: built.reason, reason: built.reason,
      poolKey: (input && input.poolKey) || '', name: (input && (input.name || input.poolKey)) || '',
    };
  }
  const axios = require('axios');
  const timeoutMs = Number(input && input.timeoutMs) > 0 ? Number(input.timeoutMs) : 15000;
  const started = Date.now();
  try {
    const resp = await axios({
      method: built.method,
      url: built.url,
      headers: built.headers,
      data: built.body,
      timeout: timeoutMs,
      validateStatus: () => true, // 自己按状态码归类,不让非 2xx 抛
    });
    const cls = spec.classifyConnectivityResult({ status: resp.status });
    return {
      ok: cls.verdict === 'ok', verdict: cls.verdict, label: cls.label,
      status: resp.status, latencyMs: Date.now() - started,
      service: built.service, poolKey: built.poolKey, name: built.name,
      model: built.model, endpoint: built.endpoint,
    };
  } catch (err) {
    const status = err && err.response && err.response.status;
    const cls = spec.classifyConnectivityResult({ status, errorCode: err && err.code });
    return {
      ok: false, verdict: cls.verdict, label: cls.label,
      status: status || 0, latencyMs: Date.now() - started,
      error: err && err.message ? err.message : String(err),
      service: built.service, poolKey: built.poolKey, name: built.name,
      model: built.model, endpoint: built.endpoint,
    };
  }
}

/**
 * 测试所有可测厂商中「能拿到 key」的那些(key 来源:入参 keys[poolKey] > 环境变量 envKey)。
 * @param {{keys?:object, timeoutMs?:number}} [input]
 * @param {object} [env]
 * @returns {Promise<object[]>}
 */
async function testAll(input = {}, env = process.env) {
  const keys = (input && input.keys) || {};
  const targets = spec.listConnectivityTargets(env).filter((t) => t.testable);
  const results = [];
  for (const t of targets) {
    const key = String(keys[t.poolKey] || (t.envKey && env[t.envKey]) || '').trim();
    if (!key) {
      results.push({ verdict: 'skipped', label: '未提供 key(--key 或环境变量)', reason: '未提供 key', name: t.name, poolKey: t.poolKey });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    results.push(await testConnectivity({ poolKey: t.poolKey, key, timeoutMs: input && input.timeoutMs }, env));
  }
  return results;
}

module.exports = { testConnectivity, testAll };
