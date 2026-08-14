'use strict';

/**
 * configureModelProvider.test.js — the agent-callable key-config tool.
 *
 * Verifies routing (built-in vs custom), required-field errors, and the security
 * invariant that the FULL API key never appears in the activity label or result
 * (only the masked form). The two service single sources are spied by mutating
 * their module exports BEFORE the tool is required, so the tool's load-time
 * destructuring captures the spies (no disk / .env writes).
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../../src/services/gateway/builtinProviderConfig');
const reg = require('../../src/services/customProviderRegistrar');

const builtinCalls = [];
const customCalls = [];

svc.applyBuiltinProviderKey = (input) => {
  builtinCalls.push(input);
  return { poolKey: 'deepseek', added: 1, duplicate: 0, model: input.model || '', endpoint: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], primaryKey: input.keyInput };
};
reg.registerCustomProvider = (input) => {
  customCalls.push(input);
  return { poolKey: input.poolKey, displayName: input.displayName, endpoint: input.endpoint, defaultModel: input.defaultModel, models: [input.defaultModel], keyCount: 1, tier: input.tier || '' };
};

// Required AFTER the spies are installed so destructuring captures them.
const tool = require('../../src/tools/ConfigureModelProvider');

const FULL_KEY = 'sk-supersecret-1234567890';

beforeEach(() => { builtinCalls.length = 0; customCalls.length = 0; });

describe('configureModelProvider tool shape', () => {
  test('declares high risk, is not read-only, defers, and redacts in activity', () => {
    assert.equal(tool.risk, 'high');
    assert.equal(tool.isReadOnly(), false);
    assert.equal(tool.shouldDefer, true);
    const label = tool.getActivityDescription({ provider: 'DeepSeek', apiKey: FULL_KEY, model: 'deepseek-chat' });
    assert.doesNotMatch(label, /supersecret/, 'activity label must not contain the full key');
    assert.match(label, /\.\.\.|\*\*\*/, 'key must appear masked');
  });
});

describe('routing', () => {
  test('built-in vendor → applyBuiltinProviderKey, result is redacted', async () => {
    const res = await tool.execute({ provider: 'DeepSeek', apiKey: FULL_KEY, model: 'deepseek-chat' });
    assert.equal(res.success, true);
    assert.equal(res.kind, 'builtin');
    assert.equal(res.poolKey, 'deepseek');
    assert.equal(builtinCalls.length, 1);
    assert.equal(customCalls.length, 0);
    // SECURITY: the full key must not appear anywhere in the structured result.
    assert.doesNotMatch(JSON.stringify(res), /supersecret/);
    assert.ok(res.keyRedacted && res.keyRedacted.length < FULL_KEY.length);
  });

  test('unknown vendor + endpoint + model → registerCustomProvider', async () => {
    const res = await tool.execute({ provider: 'My Relay', apiKey: FULL_KEY, endpoint: 'https://relay.example.com/v1', model: 'gpt-4o' });
    assert.equal(res.success, true);
    assert.equal(res.kind, 'custom');
    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0].poolKey, 'my-relay', 'poolKey slugified from display name');
    assert.equal(customCalls[0].defaultModel, 'gpt-4o');
    assert.doesNotMatch(JSON.stringify(res), /supersecret/);
  });

  test('kind=custom + 内置 poolKey → 提前拦截并给引导(而非撞 registrar terse 异常)', async () => {
    // 修 GLM 死循环:内置 poolKey(deepseek/glm/…)即便显式 kind=custom 也不能落 custom_providers.json
    // (真 registrar 的 normalizePoolKey 会抛 terse 异常)。tool 现在提前拦截,给可操作引导:改用
    // action=add 配置。严格超集(把一条必失败路径的报错换成友好文案),故不再路由 registerCustomProvider。
    const res = await tool.execute({ provider: 'deepseek', apiKey: FULL_KEY, endpoint: 'https://x/v1', model: 'm', kind: 'custom' });
    assert.equal(res.success, false);
    assert.match(res.error, /内置 provider/);
    assert.match(res.error, /action=add|list/);
    assert.equal(customCalls.length, 0, '内置 poolKey 绝不落 custom_providers.json');
  });

  test('kind=custom 对非内置名仍强制走 custom 分支', async () => {
    const res = await tool.execute({ provider: 'My Custom Co', apiKey: FULL_KEY, endpoint: 'https://x/v1', model: 'm', kind: 'custom' });
    assert.equal(res.success, true);
    assert.equal(res.kind, 'custom');
    assert.equal(customCalls.length, 1);
  });
});

describe('required-field errors', () => {
  test('missing apiKey errors', async () => {
    const res = await tool.execute({ provider: 'deepseek' });
    assert.equal(res.success, false);
    assert.match(res.error, /API Key/);
  });

  test('custom provider missing endpoint errors with guidance', async () => {
    const res = await tool.execute({ provider: 'Some Unknown Co', apiKey: FULL_KEY, model: 'm' });
    assert.equal(res.success, false);
    assert.match(res.error, /base-url|endpoint/);
  });

  test('custom provider missing model errors', async () => {
    const res = await tool.execute({ provider: 'Some Unknown Co', apiKey: FULL_KEY, endpoint: 'https://x/v1' });
    assert.equal(res.success, false);
    assert.match(res.error, /模型|model/);
  });

  test('kind=builtin with non-builtin name errors', async () => {
    const res = await tool.execute({ provider: 'totally-made-up', apiKey: FULL_KEY, kind: 'builtin' });
    assert.equal(res.success, false);
    assert.match(res.error, /未知的内置厂商/);
  });
});
