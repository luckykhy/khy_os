'use strict';

/**
 * vertexRequestShaping.test.js — Vertex AI 请求成形纯叶子(node:test)。
 *
 * 覆盖:门控(默认开 / 0/false/off/no 关 / 异常不抛)、buildVertexHost(regional vs global)、
 * buildVertexBaseUrl(含 projects/locations/publishers/google + apiVersion 默认 v1)、
 * buildVertexEndpoint(generate vs streamGenerate)、describeVertexRequest(完整 plan / 缺参 reason /
 * 门关 disabled / 确定性 / 绝不抛),以及 wiring-grep(providerPresets 含 vertex + flagRegistry 注册)。
 * 零 IO、确定性。用 `node --test` 跑。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  KHY_VERTEX_REQUEST_SHAPING,
  VERTEX_KEY_FIELD,
  VERTEX_BODY_FORMAT,
  vertexShapingEnabled,
  buildVertexHost,
  buildVertexBaseUrl,
  buildVertexEndpoint,
  describeVertexRequest,
} = require('../../../src/services/gateway/vertexRequestShaping');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');

// ── 门控 ─────────────────────────────────────────────────────────────────
test('vertexShapingEnabled:默认开;显式 falsy 关(大小写/空白健壮)', () => {
  assert.equal(vertexShapingEnabled({}), true);
  assert.equal(vertexShapingEnabled({ [KHY_VERTEX_REQUEST_SHAPING]: '1' }), true);
  assert.equal(vertexShapingEnabled({ [KHY_VERTEX_REQUEST_SHAPING]: 'on' }), true);
  assert.equal(vertexShapingEnabled({ [KHY_VERTEX_REQUEST_SHAPING]: '' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.equal(vertexShapingEnabled({ [KHY_VERTEX_REQUEST_SHAPING]: v }), false, v);
  }
});

test('vertexShapingEnabled:异常输入不抛', () => {
  assert.doesNotThrow(() => vertexShapingEnabled(null));
  assert.doesNotThrow(() => vertexShapingEnabled(42));
});

// ── host ─────────────────────────────────────────────────────────────────
test('buildVertexHost:regional 带地域前缀;global 无前缀', () => {
  assert.equal(buildVertexHost('us-central1'), 'us-central1-aiplatform.googleapis.com');
  assert.equal(buildVertexHost('europe-west4'), 'europe-west4-aiplatform.googleapis.com');
  assert.equal(buildVertexHost('global'), 'aiplatform.googleapis.com');
  assert.equal(buildVertexHost('GLOBAL'), 'aiplatform.googleapis.com');
  assert.equal(buildVertexHost(''), 'aiplatform.googleapis.com');
});

// ── baseUrl ──────────────────────────────────────────────────────────────
test('buildVertexBaseUrl:含 projects/locations/publishers/google,apiVersion 默认 v1', () => {
  assert.equal(
    buildVertexBaseUrl({ project: 'my-proj', location: 'us-central1' }),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google',
  );
  assert.equal(
    buildVertexBaseUrl({ project: 'my-proj', location: 'us-central1', apiVersion: 'v1beta1' }),
    'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/us-central1/publishers/google',
  );
});

test('buildVertexBaseUrl:缺 project/location → 空串', () => {
  assert.equal(buildVertexBaseUrl({ location: 'us-central1' }), '');
  assert.equal(buildVertexBaseUrl({ project: 'my-proj' }), '');
  assert.equal(buildVertexBaseUrl({}), '');
});

// ── endpoint ─────────────────────────────────────────────────────────────
test('buildVertexEndpoint:generateContent vs streamGenerateContent', () => {
  const spec = { project: 'my-proj', location: 'us-central1', model: 'gemini-1.5-pro' };
  assert.equal(
    buildVertexEndpoint(spec),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-1.5-pro:generateContent',
  );
  assert.equal(
    buildVertexEndpoint({ ...spec, streaming: true }),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-1.5-pro:streamGenerateContent',
  );
});

test('buildVertexEndpoint:缺 model → 空串', () => {
  assert.equal(buildVertexEndpoint({ project: 'my-proj', location: 'us-central1' }), '');
});

// ── describeVertexRequest ────────────────────────────────────────────────
test('describeVertexRequest:完整 plan(bearer + gemini 体格式)', () => {
  const r = describeVertexRequest(
    { project: 'my-proj', location: 'us-central1', model: 'gemini-1.5-pro' },
    {},
  );
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'shaped');
  assert.equal(r.host, 'us-central1-aiplatform.googleapis.com');
  assert.equal(r.keyField, VERTEX_KEY_FIELD);
  assert.equal(r.keyField, 'authorization_bearer');
  assert.equal(r.bodyFormat, VERTEX_BODY_FORMAT);
  assert.equal(r.bodyFormat, 'gemini');
  assert.equal(r.method, 'generateContent');
  assert.ok(r.url.endsWith(':generateContent'));
  assert.ok(r.baseUrl.endsWith('/publishers/google'));
});

test('describeVertexRequest:缺参 → ok:false + 对应 reason', () => {
  assert.equal(describeVertexRequest({ location: 'us-central1', model: 'm' }, {}).reason, 'missing-project');
  assert.equal(describeVertexRequest({ project: 'p', model: 'm' }, {}).reason, 'missing-location');
  assert.equal(describeVertexRequest({ project: 'p', location: 'us-central1' }, {}).reason, 'missing-model');
});

test('describeVertexRequest:门关 → disabled,不成形', () => {
  const r = describeVertexRequest(
    { project: 'p', location: 'us-central1', model: 'm' },
    { [KHY_VERTEX_REQUEST_SHAPING]: '0' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(r.url, undefined);
});

test('describeVertexRequest:确定性(同输入同输出)', () => {
  const spec = { project: 'p', location: 'us-central1', model: 'm', streaming: true };
  assert.deepEqual(describeVertexRequest(spec, {}), describeVertexRequest(spec, {}));
});

test('describeVertexRequest:坏输入绝不抛', () => {
  assert.doesNotThrow(() => describeVertexRequest(null, {}));
  assert.doesNotThrow(() => describeVertexRequest(undefined, undefined));
  assert.doesNotThrow(() => describeVertexRequest(42, 42));
  assert.equal(describeVertexRequest(null, {}).ok, false);
});

// ── wiring grep ──────────────────────────────────────────────────────────
test('wiring:providerPresets 含 vertex(gemini 格式 + bearer)且 flagRegistry 已注册', () => {
  const { getProviderPresets } = require('../../../src/services/gateway/providerPresets');
  const presets = getProviderPresets();
  const vertex = presets.find((p) => p.id === 'vertex');
  assert.ok(vertex, 'providerPresets 应含 vertex 预设');
  assert.equal(vertex.apiFormat, 'gemini', 'vertex 复用 gemini 线格式');
  assert.equal(vertex.keyField, 'authorization_bearer', 'vertex 用 OAuth Bearer');
  assert.ok(/publishers\/google/.test(vertex.baseUrl), 'baseUrl 模板止于 publishers/google');

  const reg = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/flagRegistry.js'), 'utf8');
  assert.ok(reg.includes('KHY_VERTEX_REQUEST_SHAPING'), 'flag 注册');
});
