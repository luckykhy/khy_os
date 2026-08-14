'use strict';

/**
 * qoderProxyModels.test.js — 锁死「让 khyos 反代消费 qoder-proxy 模型」的纯叶子契约。
 *
 * qoder-proxy 是本机 HTTP 反代(默认 127.0.0.1:3000),同时提供 OpenAI(/v1/chat/completions)
 * 与 Anthropic(/v1/messages)两条线。本叶子声明:模型目录、opt-in 门(默认关,127.0.0.1:3000
 * 没跑会留死条目)、以及两条池注册 spec(端点从单一根派生——anthropic 线端点必须裸主机不带 /v1,
 * 否则 callAnthropic 接 /v1/messages 变 /v1/v1/messages)。
 *
 * 覆盖:常量;opt-in 默认关 + flag 开;env-present;qoderOptedIn;端点派生(关键回归);
 * 两条 spec 的 service/key;深拷贝隔离;junk env 绝不抛;以及 registrar/三接线点的 LIVE 断言。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const q = require('../../../src/services/gateway/qoderProxyModels');

test('constants: two pool keys, 13 models (incl 4 effort variants), non-empty defaults', () => {
  assert.strictEqual(q.QODER_POOL_KEY, 'qoder');
  assert.strictEqual(q.QODER_ANTHROPIC_POOL_KEY, 'qoder-anthropic');
  assert.strictEqual(q.QODER_DEFAULT_MODEL, 'qoder-cn');
  assert.ok(q.QODER_DEFAULT_ROOT && /^https?:\/\//.test(q.QODER_DEFAULT_ROOT));
  assert.ok(q.QODER_DUMMY_KEY && q.QODER_DUMMY_KEY.length > 0);
  assert.strictEqual(q.QODER_MODELS.length, 13);
  assert.ok(q.QODER_MODELS.includes('qoder-cn'));
  assert.ok(q.QODER_MODELS.includes('auto'));
  for (const m of [
    'qwen3.7-max-effort-low', 'qwen3.7-max-effort-medium',
    'qwen3.7-max-effort-high', 'qwen3.7-max-effort-max',
  ]) {
    assert.ok(q.QODER_MODELS.includes(m), m);
  }
  assert.ok(Object.isFrozen(q.QODER_MODELS), 'QODER_MODELS frozen');
});

test('opt-in gate: default OFF; only true/1 enable', () => {
  assert.strictEqual(q.qoderProxyFlagEnabled({}), false);
  assert.strictEqual(q.qoderProxyFlagEnabled({ KHY_QODER_PROXY: 'true' }), true);
  assert.strictEqual(q.qoderProxyFlagEnabled({ KHY_QODER_PROXY: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(q.qoderProxyFlagEnabled({ KHY_QODER_PROXY: v }), false, v);
  }
});

test('env-present: endpoint OR key present → true', () => {
  assert.strictEqual(q.qoderProxyEnvPresent({}), false);
  assert.strictEqual(q.qoderProxyEnvPresent({ QODER_PROXY_ENDPOINT: 'http://127.0.0.1:3000' }), true);
  assert.strictEqual(q.qoderProxyEnvPresent({ QODER_PROXY_API_KEY: 'x' }), true);
  assert.strictEqual(q.qoderProxyEnvPresent({ QODER_PROXY_ENDPOINT: '   ' }), false);
});

test('qoderOptedIn: flag on OR env coordinates present', () => {
  assert.strictEqual(q.qoderOptedIn({}), false);
  assert.strictEqual(q.qoderOptedIn({ KHY_QODER_PROXY: 'true' }), true);
  assert.strictEqual(q.qoderOptedIn({ QODER_PROXY_ENDPOINT: 'http://127.0.0.1:3000' }), true);
  assert.strictEqual(q.qoderOptedIn({ QODER_PROXY_API_KEY: 'k' }), true);
});

test('endpoint derivation (KEY regression): anthropic root stays bare (no /v1)', () => {
  // Explicit endpoint carrying /v1 → normalized root, no double /v1.
  const root = q.qoderProxyRoot({ QODER_PROXY_ENDPOINT: 'http://127.0.0.1:3000/v1' });
  assert.strictEqual(root, 'http://127.0.0.1:3000');
  // Trailing slashes stripped.
  assert.strictEqual(q.qoderProxyRoot({ QODER_PROXY_ENDPOINT: 'http://host:8080/' }), 'http://host:8080');
  // Empty env → default root.
  assert.strictEqual(q.qoderProxyRoot({}), q.QODER_DEFAULT_ROOT);
});

test('qoderProxySpecs: two lines, correct service + endpoint shape', () => {
  const specs = q.qoderProxySpecs({ QODER_PROXY_ENDPOINT: 'http://127.0.0.1:3000/v1' });
  assert.strictEqual(specs.length, 2);
  const openai = specs.find(s => s.poolKey === 'qoder');
  const anthropic = specs.find(s => s.poolKey === 'qoder-anthropic');
  assert.ok(openai && anthropic);
  assert.strictEqual(openai.service, 'openai');
  assert.strictEqual(anthropic.service, 'anthropic');
  // openai line carries /v1 (callOpenAI normalizes either way).
  assert.strictEqual(openai.endpoint, 'http://127.0.0.1:3000/v1');
  // anthropic line MUST be bare root — callAnthropic appends /v1/messages itself.
  assert.strictEqual(anthropic.endpoint, 'http://127.0.0.1:3000');
  assert.ok(!/\/v1$/.test(anthropic.endpoint), 'anthropic endpoint must not end with /v1');
  // both carry the full model set + default.
  assert.strictEqual(openai.defaultModel, 'qoder-cn');
  assert.strictEqual(openai.models.length, 13);
  assert.strictEqual(anthropic.models.length, 13);
});

test('qoderProxySpecs: key override vs dummy fallback', () => {
  const withKey = q.qoderProxySpecs({ QODER_PROXY_API_KEY: 'real-key-123' });
  assert.ok(withKey.every(s => s.key === 'real-key-123'));
  const noKey = q.qoderProxySpecs({});
  assert.ok(noKey.every(s => s.key === q.QODER_DUMMY_KEY && s.key.length > 0));
});

test('deep-copy isolation: mutating returned models never pollutes frozen QODER_MODELS', () => {
  const a = q.listQoderModels();
  a.push('__poison__');
  assert.ok(!q.QODER_MODELS.includes('__poison__'));
  const specs = q.qoderProxySpecs({});
  specs[0].models.push('__poison2__');
  assert.ok(!q.QODER_MODELS.includes('__poison2__'));
});

test('never throws on junk env', () => {
  assert.doesNotThrow(() => q.qoderProxyFlagEnabled(null));
  assert.doesNotThrow(() => q.qoderProxyEnvPresent(null));
  assert.doesNotThrow(() => q.qoderOptedIn(undefined));
  assert.doesNotThrow(() => q.qoderProxyRoot({ QODER_PROXY_ENDPOINT: {} }));
  assert.doesNotThrow(() => q.qoderProxyKey(null));
  assert.doesNotThrow(() => q.qoderProxySpecs(null));
  assert.ok(Array.isArray(q.qoderProxySpecs(null)));
});

test('LIVE wiring: registrar seeds via opt-in gate + registerCustomProvider', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/services/customProviderRegistrar.js'), 'utf8');
  assert.ok(/require\(['"]\.\/gateway\/qoderProxyModels['"]\)/.test(src),
    'registrar requires qoderProxyModels');
  assert.ok(/ensureBuiltinQoder/.test(src), 'registrar defines ensureBuiltinQoder');
  assert.ok(/qoderOptedIn/.test(src), 'ensureBuiltinQoder gates on qoderOptedIn before seeding');
  assert.ok(/qoderProxySpecs/.test(src), 'ensureBuiltinQoder feeds qoderProxySpecs to registration');
  // service param is threaded into the service map.
  assert.ok(/VALID_SERVICES/.test(src), 'registerCustomProvider validates service param');
  assert.ok(/\[poolKey\]:\s*service/.test(src), 'service map uses the service param, not hardcoded openai');
});

test('LIVE wiring: three startup call sites invoke ensureBuiltinQoder', () => {
  const files = [
    '../../../src/services/gateway/aiGateway.js',
    '../../../src/services/aiManagementServer.js',
    '../../../src/cli/handlers/init.js',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(/ensureBuiltinQoder/.test(src), `${rel} calls ensureBuiltinQoder`);
  }
});

test('LIVE wiring: KHY_QODER_PROXY registered as opt-in flag', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/services/flagRegistry.js'), 'utf8');
  assert.ok(/KHY_QODER_PROXY:\s*\{\s*mode:\s*['"]opt-in['"]/.test(src),
    'KHY_QODER_PROXY registered with mode opt-in');
});
