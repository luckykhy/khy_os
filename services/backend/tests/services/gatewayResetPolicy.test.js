'use strict';

/**
 * gatewayResetPolicy.test.js — 纯叶子:网关重置判定(确定性)。
 *
 * 锁定 shouldResetGateway 和 getFactoryDefaults:
 *   ① 配置损坏 → 应重置;
 *   ② 必需字段缺失 → 应重置;
 *   ③ adapter 非法 → 应重置;
 *   ④ 配置正常 → 不应重置;
 *   ⑤ 出厂默认值符合预期;
 *   ⑥ 门控关(KHY_GATEWAY_RESET=off) → 不重置;
 *   ⑦ 坏输入 → 不重置不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../../src/services/gatewayResetPolicy');

test('配置正常 → 不应重置', () => {
  const envMap = {
    GATEWAY_PREFERRED_ADAPTER: 'relay_api',
    RELAY_API_ENDPOINT: 'https://api.example.com/v1',
    RELAY_API_KEY: 'sk-test',
    RELAY_API_MODEL: 'gpt-4',
  };
  const result = policy.shouldResetGateway({ envMap, env: {} });
  assert.strictEqual(result.shouldReset, false);
  assert.strictEqual(result.reason, '');
});

test('配置损坏 → 应重置', () => {
  const envMap = {
    GATEWAY_PREFERRED_ADAPTER: 'relay_api',
  };
  const result = policy.shouldResetGateway({ envMap, configCorrupted: true, env: {} });
  assert.strictEqual(result.shouldReset, true);
  assert.strictEqual(result.reason, 'config-corrupted');
});

test('必需字段缺失(adapter 和 relay 全空) → 应重置', () => {
  const envMap = {
    // 全空
  };
  const result = policy.shouldResetGateway({ envMap, env: {} });
  assert.strictEqual(result.shouldReset, true);
  assert.strictEqual(result.reason, 'required-fields-missing');
});

test('adapter 非法 → 应重置', () => {
  const envMap = {
    GATEWAY_PREFERRED_ADAPTER: 'invalid_adapter',
  };
  const result = policy.shouldResetGateway({ envMap, env: {} });
  assert.strictEqual(result.shouldReset, true);
  assert.strictEqual(result.reason, 'invalid-adapter');
});

test('只有 adapter,无 relay 配置 → 正常(不重置)', () => {
  const envMap = {
    GATEWAY_PREFERRED_ADAPTER: 'claude',
  };
  const result = policy.shouldResetGateway({ envMap, env: {} });
  assert.strictEqual(result.shouldReset, false);
  assert.strictEqual(result.reason, '');
});

test('adapter 为空,但有 relay 配置 → 正常(不重置)', () => {
  const envMap = {
    RELAY_API_ENDPOINT: 'https://api.example.com/v1',
    RELAY_API_KEY: 'sk-test',
  };
  const result = policy.shouldResetGateway({ envMap, env: {} });
  assert.strictEqual(result.shouldReset, false);
  assert.strictEqual(result.reason, '');
});

test('adapter 大小写不敏感', () => {
  const envMap = {
    GATEWAY_PREFERRED_ADAPTER: 'RELAY_API', // 大写
  };
  const result = policy.shouldResetGateway({ envMap, env: {} });
  assert.strictEqual(result.shouldReset, false); // 应识别为合法
});

test('合法的 adapter 值都不触发重置', () => {
  const validAdapters = [
    'relay_api',
    'auto',
    'ollama',
    'localllm',
    'claude',
    'codex',
    'kiro',
    'cursor',
    'trae',
    'windsurf',
    'api',
    'relay',
  ];
  for (const adapter of validAdapters) {
    const envMap = { GATEWAY_PREFERRED_ADAPTER: adapter };
    const result = policy.shouldResetGateway({ envMap, env: {} });
    assert.strictEqual(result.shouldReset, false, `adapter=${adapter} 应正常`);
  }
});

test('出厂默认值符合预期', () => {
  const defaults = policy.getFactoryDefaults();
  assert.strictEqual(defaults.GATEWAY_PREFERRED_ADAPTER, 'relay_api');
  assert.strictEqual(defaults.RELAY_API_ENDPOINT, '');
  assert.strictEqual(defaults.RELAY_API_KEY, '');
  assert.strictEqual(defaults.RELAY_API_MODEL, '');
  assert.strictEqual(defaults.RELAY_API_COMPATIBILITY, 'openai');
});

test('门控关(KHY_GATEWAY_RESET=off) → 不重置', () => {
  const envMap = {
    // 全空,正常应触发重置
  };
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    const result = policy.shouldResetGateway({ envMap, env: { KHY_GATEWAY_RESET: off } });
    assert.strictEqual(result.shouldReset, false, `gate=${off} 应不重置`);
    assert.strictEqual(result.reason, '');
  }
});

test('坏输入(envMap 非对象)→ 不重置不抛', () => {
  assert.deepStrictEqual(policy.shouldResetGateway({ envMap: null, env: {} }), {
    shouldReset: false,
    reason: '',
  });
  assert.deepStrictEqual(policy.shouldResetGateway({ envMap: 'not-object', env: {} }), {
    shouldReset: false,
    reason: '',
  });
  assert.deepStrictEqual(policy.shouldResetGateway({ env: {} }), {
    shouldReset: false,
    reason: '',
  });
});

test('isEnabled 门控逻辑', () => {
  assert.strictEqual(policy.isEnabled({ KHY_GATEWAY_RESET: 'true' }), true);
  assert.strictEqual(policy.isEnabled({ KHY_GATEWAY_RESET: '1' }), true);
  assert.strictEqual(policy.isEnabled({}), true); // 默认开
  assert.strictEqual(policy.isEnabled({ KHY_GATEWAY_RESET: '0' }), false);
  assert.strictEqual(policy.isEnabled({ KHY_GATEWAY_RESET: 'false' }), false);
  assert.strictEqual(policy.isEnabled({ KHY_GATEWAY_RESET: 'off' }), false);
  assert.strictEqual(policy.isEnabled({ KHY_GATEWAY_RESET: 'no' }), false);
});

test('VALID_ADAPTERS 常量可访问', () => {
  assert.ok(Array.isArray(policy.VALID_ADAPTERS));
  assert.ok(policy.VALID_ADAPTERS.includes('relay_api'));
  assert.ok(policy.VALID_ADAPTERS.includes('claude'));
});
