'use strict';

/**
 * providerConnectivitySpec.test.js — 厂商连通性自检 纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(默认开 / 显式关 / 注册表回退)、serviceFor(openai/anthropic/不可测)、
 * listConnectivityTargets(可测标记 + skipReason + env 端点覆盖)、resolveConnectivityTarget
 * (poolKey / 名称 / 别名容错)、buildConnectivityRequest(openai 端点归一 /v1、anthropic 端点
 * 不剥 /v1、鉴权头形态、缺 key/端点/模型 的 fail、不可测厂商 fail、门关 fail)、
 * classifyConnectivityResult(2xx/401/404/429/400/5xx/网络码/未知)。零 IO、确定性、绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const spec = require('../../../src/services/gateway/providerConnectivitySpec');

const ON = {};
const OFF = { KHY_PROVIDER_CONNECTIVITY_TEST: '0' };

test('isEnabled:默认开;显式关闭词关;其它值仍开', () => {
  assert.strictEqual(spec.isEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(spec.isEnabled({ KHY_PROVIDER_CONNECTIVITY_TEST: v }), false, v);
  }
  assert.strictEqual(spec.isEnabled({ KHY_PROVIDER_CONNECTIVITY_TEST: '1' }), true);
});

test('isEnabled:注册表关时回退本地判定(逐字节等价)', () => {
  assert.strictEqual(spec.isEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.strictEqual(spec.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROVIDER_CONNECTIVITY_TEST: 'off' }), false);
});

test('serviceFor:协议族归类正确', () => {
  for (const k of ['deepseek', 'qwen', 'glm', 'doubao', 'openai', 'relay']) {
    assert.strictEqual(spec.serviceFor(k), 'openai', k);
  }
  assert.strictEqual(spec.serviceFor('anthropic'), 'anthropic');
  assert.strictEqual(spec.serviceFor('wenxin'), '');
  assert.strictEqual(spec.serviceFor('trae'), '');
  assert.strictEqual(spec.serviceFor(''), '');
  assert.strictEqual(spec.serviceFor(null), '');
});

test('listConnectivityTargets:含可测(glm/anthropic)与不可测(wenxin/trae/hf)+ skipReason', () => {
  const list = spec.listConnectivityTargets(ON);
  assert.ok(Array.isArray(list) && list.length > 0);
  const glm = list.find((t) => t.poolKey === 'glm');
  assert.ok(glm && glm.testable === true && glm.service === 'openai');
  assert.ok(glm.testModel && glm.endpoint);
  const ant = list.find((t) => t.poolKey === 'anthropic');
  assert.ok(ant && ant.testable === true && ant.service === 'anthropic');
  const wenxin = list.find((t) => t.poolKey === 'wenxin');
  assert.ok(wenxin && wenxin.testable === false && wenxin.skipReason);
  const trae = list.find((t) => t.poolKey === 'trae');
  assert.ok(trae && trae.testable === false && trae.skipReason);
  const hf = list.find((t) => /HuggingFace/i.test(t.name));
  assert.ok(hf && hf.testable === false && hf.skipReason);
  // 门关 → []。
  assert.deepStrictEqual(spec.listConnectivityTargets(OFF), []);
});

test('listConnectivityTargets:env 端点覆盖生效', () => {
  const list = spec.listConnectivityTargets({ GLM_API_ENDPOINT: 'https://example.test/relay/v1' });
  const glm = list.find((t) => t.poolKey === 'glm');
  assert.strictEqual(glm.endpoint, 'https://example.test/relay/v1');
});

test('resolveConnectivityTarget:poolKey / 名称 / 别名容错', () => {
  assert.strictEqual(spec.resolveConnectivityTarget('glm', ON).poolKey, 'glm');
  assert.strictEqual(spec.resolveConnectivityTarget('claude', ON).poolKey, 'anthropic'); // 别名
  assert.strictEqual(spec.resolveConnectivityTarget('Qwen', ON).poolKey, 'qwen');
  assert.strictEqual(spec.resolveConnectivityTarget('不存在', ON), null);
  assert.strictEqual(spec.resolveConnectivityTarget('', ON), null);
  assert.strictEqual(spec.resolveConnectivityTarget('glm', OFF), null); // 门关
});

test('buildConnectivityRequest:openai 兼容 → chat/completions + Bearer,按端点版本段派生', () => {
  // GLM 端点已含版本段 /api/paas/v4 → 直接 + /chat/completions(不插 /v1,不出现 /v4/v1)。
  const r = spec.buildConnectivityRequest({ poolKey: 'glm', key: 'k-abc', endpoint: 'https://open.bigmodel.cn/api/paas/v4' }, ON);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.service, 'openai');
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.strictEqual(r.headers.Authorization, 'Bearer k-abc');
  assert.strictEqual(r.body.max_tokens, 1);
  assert.strictEqual(r.body.messages[0].role, 'user');
  // 端点以 /v1 结尾 → + /chat/completions(不出现 /v1/v1)。
  const r2 = spec.buildConnectivityRequest({ poolKey: 'openai', key: 'k', endpoint: 'https://api.openai.com/v1' }, ON);
  assert.strictEqual(r2.url, 'https://api.openai.com/v1/chat/completions');
  // 豆包端点 /api/v3 → + /chat/completions。
  const r3 = spec.buildConnectivityRequest({ poolKey: 'doubao', key: 'k', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' }, ON);
  assert.strictEqual(r3.url, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
});

test('buildConnectivityRequest:anthropic → /v1/messages + x-api-key,端点剥尾 /v1 防 /v1/v1', () => {
  const r = spec.buildConnectivityRequest({ poolKey: 'anthropic', key: 'sk-ant', endpoint: 'https://api.anthropic.com/v1' }, ON);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.service, 'anthropic');
  assert.strictEqual(r.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(r.headers['x-api-key'], 'sk-ant');
  assert.ok(r.headers['anthropic-version']);
  assert.strictEqual(r.body.max_tokens, 1);
});

test('buildConnectivityRequest:缺 key / 缺端点 / 不可测厂商 / 门关 → ok:false', () => {
  assert.strictEqual(spec.buildConnectivityRequest({ poolKey: 'glm', key: '' }, ON).ok, false); // 缺 key
  assert.strictEqual(spec.buildConnectivityRequest({ poolKey: 'relay', key: 'k' }, ON).ok, false); // relay 无默认端点
  assert.strictEqual(spec.buildConnectivityRequest({ poolKey: 'wenxin', key: 'k' }, ON).ok, false); // 不可测
  assert.strictEqual(spec.buildConnectivityRequest({ poolKey: 'nope', key: 'k' }, ON).ok, false); // 未知厂商
  assert.strictEqual(spec.buildConnectivityRequest({ poolKey: 'glm', key: 'k' }, OFF).ok, false); // 门关
});

test('buildConnectivityRequest:relay 给了 --endpoint → 可构造 openai 请求', () => {
  const r = spec.buildConnectivityRequest({ poolKey: 'relay', key: 'k', endpoint: 'https://relay.test', model: 'gpt-4o-mini' }, ON);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, 'https://relay.test/v1/chat/completions');
});

test('classifyConnectivityResult:状态码 / 网络码 归类', () => {
  assert.strictEqual(spec.classifyConnectivityResult({ status: 200 }).verdict, 'ok');
  assert.strictEqual(spec.classifyConnectivityResult({ status: 401 }).verdict, 'bad_key');
  assert.strictEqual(spec.classifyConnectivityResult({ status: 403 }).verdict, 'bad_key');
  assert.strictEqual(spec.classifyConnectivityResult({ status: 404 }).verdict, 'model_or_endpoint');
  assert.strictEqual(spec.classifyConnectivityResult({ status: 429 }).verdict, 'rate_limited');
  assert.strictEqual(spec.classifyConnectivityResult({ status: 400 }).verdict, 'bad_request');
  assert.strictEqual(spec.classifyConnectivityResult({ status: 500 }).verdict, 'server_error');
  assert.strictEqual(spec.classifyConnectivityResult({ errorCode: 'ECONNREFUSED' }).verdict, 'unreachable');
  assert.strictEqual(spec.classifyConnectivityResult({ errorCode: 'ETIMEDOUT' }).verdict, 'unreachable');
  assert.strictEqual(spec.classifyConnectivityResult({ errorCode: 'ENOTFOUND' }).verdict, 'unreachable');
  assert.strictEqual(spec.classifyConnectivityResult({}).verdict, 'unknown');
});

test('绝不抛:junk 输入', () => {
  assert.doesNotThrow(() => spec.listConnectivityTargets(null));
  assert.doesNotThrow(() => spec.buildConnectivityRequest(null, null));
  assert.doesNotThrow(() => spec.buildConnectivityRequest({ poolKey: 42 }, ON));
  assert.doesNotThrow(() => spec.classifyConnectivityResult(null));
  assert.doesNotThrow(() => spec.resolveConnectivityTarget(undefined, ON));
});

test('LIVE 接线:router 挂 test-key、flagRegistry 登记 flag', () => {
  const fs = require('fs');
  const path = require('path');
  const routerSrc = fs.readFileSync(path.join(__dirname, '../../../src/cli/router.js'), 'utf8');
  assert.match(routerSrc, /case 'test-key'/);
  assert.match(routerSrc, /handlers\/testKey/);
  const flagSrc = fs.readFileSync(path.join(__dirname, '../../../src/services/flagRegistry.js'), 'utf8');
  assert.match(flagSrc, /KHY_PROVIDER_CONNECTIVITY_TEST/);
});
