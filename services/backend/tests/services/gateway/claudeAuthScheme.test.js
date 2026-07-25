'use strict';

/**
 * claudeAuthScheme.test.js — 锁定「khyos 复用 CC 的中转 key 时 direct 请求用错 auth header」修复。
 *
 * 背景:用户的 Claude Code 靠 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 指向第三方中转。
 * 这类中转(和官方 Claude Code 在配 AUTH_TOKEN 时一样)期望 `Authorization: Bearer sk-...`,
 * 而 claudeAdapter direct 模式旧行为只发 `x-api-key: sk-...` → 中转拒(401),khy 无法复用同一 key。
 *
 * 修(纯正确性,源感知,镜像上游 Anthropic SDK 语义):
 *   - ANTHROPIC_API_KEY    → `x-api-key`（官方直连;逐字节保留旧行为)
 *   - ANTHROPIC_AUTH_TOKEN → `Authorization: Bearer`（中转/网关)
 *   - pool / CLAUDE_API_KEY → `x-api-key`（Anthropic 原生默认)
 * `ANTHROPIC_AUTH_SCHEME`(auto|bearer|x-api-key|both)为兼容性覆盖,非特性门:默认 auto 已正确,
 * 关掉只会重新弄坏 AUTH_TOKEN 中转。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { __test__ } = require('../../../src/services/gateway/adapters/claudeAdapter');
const {
  resolveAnthropicCredentialFromEnv: resolveCred,
  resolveAnthropicAuthScheme: resolveScheme,
  buildAnthropicAuthHeaders: buildHeaders,
} = __test__;

test('凭据来源识别:遵循 API_KEY > AUTH_TOKEN > CLAUDE_API_KEY 优先级', () => {
  assert.deepStrictEqual(resolveCred({ ANTHROPIC_API_KEY: 'sk-a' }), { apiKey: 'sk-a', source: 'ANTHROPIC_API_KEY' });
  assert.deepStrictEqual(resolveCred({ ANTHROPIC_AUTH_TOKEN: 'sk-b' }), { apiKey: 'sk-b', source: 'ANTHROPIC_AUTH_TOKEN' });
  assert.deepStrictEqual(resolveCred({ CLAUDE_API_KEY: 'sk-c' }), { apiKey: 'sk-c', source: 'CLAUDE_API_KEY' });
  // 同时存在 → API_KEY 优先(保留旧解析顺序)
  assert.strictEqual(resolveCred({ ANTHROPIC_API_KEY: 'sk-a', ANTHROPIC_AUTH_TOKEN: 'sk-b' }).source, 'ANTHROPIC_API_KEY');
  // 都没有 → null,不抛
  assert.deepStrictEqual(resolveCred({}), { apiKey: null, source: null });
  assert.deepStrictEqual(resolveCred(null), { apiKey: null, source: null });
});

test('auto(默认)源感知:AUTH_TOKEN→bearer,其它→x-api-key', () => {
  assert.strictEqual(resolveScheme('ANTHROPIC_AUTH_TOKEN', {}), 'bearer');
  assert.strictEqual(resolveScheme('ANTHROPIC_API_KEY', {}), 'x-api-key');
  assert.strictEqual(resolveScheme('CLAUDE_API_KEY', {}), 'x-api-key');
  assert.strictEqual(resolveScheme('pool', {}), 'x-api-key');
  assert.strictEqual(resolveScheme(null, {}), 'x-api-key');
});

test('ANTHROPIC_AUTH_SCHEME 覆盖:显式值优先,非法值回退 auto', () => {
  assert.strictEqual(resolveScheme('ANTHROPIC_API_KEY', { ANTHROPIC_AUTH_SCHEME: 'bearer' }), 'bearer');
  assert.strictEqual(resolveScheme('ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_SCHEME: 'x-api-key' }), 'x-api-key');
  assert.strictEqual(resolveScheme('ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_SCHEME: 'both' }), 'both');
  assert.strictEqual(resolveScheme('ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_SCHEME: 'BEARER' }), 'bearer', '大小写不敏感');
  // 非法/空覆盖 → 回退源感知 auto
  assert.strictEqual(resolveScheme('ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_SCHEME: 'nonsense' }), 'bearer');
  assert.strictEqual(resolveScheme('ANTHROPIC_API_KEY', { ANTHROPIC_AUTH_SCHEME: '' }), 'x-api-key');
});

test('header 构造:x-api-key 逐字节保留旧行为,bearer 用 Authorization,both 兼具', () => {
  // 关键回归:官方 x-api-key 路径必须与旧行为逐字节一致(只有这一个 header)。
  assert.deepStrictEqual(buildHeaders('sk-x', 'x-api-key'), { 'x-api-key': 'sk-x' });
  // 中转路径:发 Bearer(不再是 x-api-key)。
  assert.deepStrictEqual(buildHeaders('sk-x', 'bearer'), { Authorization: 'Bearer sk-x' });
  // 宽松中转:两个都发。
  assert.deepStrictEqual(buildHeaders('sk-x', 'both'), { 'x-api-key': 'sk-x', Authorization: 'Bearer sk-x' });
  // 缺省/未知 scheme → 安全回退旧行为 x-api-key(callAnthropicStream 未传时不破坏其它调用者)。
  assert.deepStrictEqual(buildHeaders('sk-x', undefined), { 'x-api-key': 'sk-x' });
  assert.deepStrictEqual(buildHeaders('sk-x', 'weird'), { 'x-api-key': 'sk-x' });
});

test('端到端场景:用户 AUTH_TOKEN + 中转 → 发 Bearer(修复的核心诉求)', () => {
  const env = { ANTHROPIC_AUTH_TOKEN: 'sk-relay-token', ANTHROPIC_BASE_URL: 'https://relay.example/api' };
  const cred = resolveCred(env);
  const scheme = resolveScheme(cred.source, env);
  const headers = buildHeaders(cred.apiKey, scheme);
  assert.strictEqual(scheme, 'bearer');
  assert.deepStrictEqual(headers, { Authorization: 'Bearer sk-relay-token' });
  assert.ok(!('x-api-key' in headers), '中转路径不应再发 x-api-key');
});

test('端到端场景:官方 API_KEY 直连 → 逐字节保留 x-api-key(零回归)', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-official' };
  const cred = resolveCred(env);
  const headers = buildHeaders(cred.apiKey, resolveScheme(cred.source, env));
  assert.deepStrictEqual(headers, { 'x-api-key': 'sk-official' });
});
