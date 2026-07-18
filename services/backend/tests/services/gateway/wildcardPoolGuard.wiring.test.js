'use strict';

/**
 * wildcardPoolGuard.wiring.test.js — 功能级接线验证:守卫接入 aiGateway 的
 * `_resolveApiPoolProviderForRequest`(通配兜底解析末位)。
 *
 * 锁死用户实测语义(agnes-2.0-flash → open.bigmodel.cn 400 code 1211):
 *   - 显式 apiPoolProvider / provider 命中 → 原样返回(守卫永不触及);
 *   - scoped `pool:model` / `pool/model` 命中 → 原样返回;
 *   - 裸 agnes(已登记 preset、运行时无 agnes 池)在通配 relay 下 → 守卫返回 null(不盲落);
 *   - 门控 KHY_WILDCARD_POOL_GUARD 关 → 逐字节回退(原样盲落通配池);
 *   - 无通配 env → 与今日一致(返回 '')。
 *
 * 备注:运行时池由本机 ~/.khy/api_keys.json 决定(现场 sensenova/glm/example-provider,无 agnes)。
 * 本测试只断言 agnes(确定无池)与显式/scoped/门控路径,不依赖某个恰好有池的裸厂商,避免环境漂移。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gateway = require('../../../src/services/gateway/aiGateway');
const resolve = gateway.__test__._resolveApiPoolProviderForRequest;

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; process.env[k] = overrides[k]; }
  try { return fn(); }
  finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('explicit apiPoolProvider is honored — guard never fires', () => {
  withEnv({ GATEWAY_API_POOL_PROVIDER: 'relay' }, () => {
    assert.strictEqual(resolve({ apiPoolProvider: 'glm', model: 'agnes-2.0-flash' }), 'glm');
  });
});

test('explicit provider is honored — guard never fires', () => {
  withEnv({ GATEWAY_API_POOL_PROVIDER: 'relay' }, () => {
    assert.strictEqual(resolve({ provider: 'glm', model: 'agnes-2.0-flash' }), 'glm');
  });
});

test('scoped pool:model hint is honored — passes through', () => {
  withEnv({ GATEWAY_API_POOL_PROVIDER: 'relay' }, () => {
    assert.strictEqual(resolve({ model: 'agnes:agnes-2.0-flash' }), 'agnes');
    assert.strictEqual(resolve({ model: 'glm/glm-4.6' }), 'glm');
  });
});

test('bare agnes under wildcard relay → guard blocks blind fallback (null)', () => {
  withEnv({ GATEWAY_API_POOL_PROVIDER: 'relay' }, () => {
    assert.strictEqual(resolve({ model: 'agnes-2.0-flash' }), null);
  });
});

test('gate off → byte-revert: bare agnes falls to wildcard pool (today behavior)', () => {
  withEnv({ GATEWAY_API_POOL_PROVIDER: 'relay', KHY_WILDCARD_POOL_GUARD: '0' }, () => {
    assert.strictEqual(resolve({ model: 'agnes-2.0-flash' }), 'relay');
  });
});

test('no wildcard env → unchanged (null, byte-equivalent to today), no throw', () => {
  withEnv({ GATEWAY_API_POOL_PROVIDER: '' }, () => {
    assert.strictEqual(resolve({ model: 'agnes-2.0-flash' }), null);
  });
});

test('resolver never throws on garbage options', () => {
  withEnv({ GATEWAY_API_POOL_PROVIDER: 'relay' }, () => {
    assert.doesNotThrow(() => resolve());
    assert.doesNotThrow(() => resolve({ model: 42 }));
  });
});
