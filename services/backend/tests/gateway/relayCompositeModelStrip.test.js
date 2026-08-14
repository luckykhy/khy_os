'use strict';

/**
 * Test for aiGateway.normalizeModelForAdapter — relay_api 剥离 khy 内部三段式路由 id。
 *
 * 回归根因:khy 内部路由 id 是 `api:<pool>:<model>`(例 `api:glm:glm-4.7-flash`),仅供内部
 * 选池,绝非可上线的 wire 模型名。`relay_api` 适配器把 model 直写进 HTTP body → 复合 id 原样
 * 发给 bigmodel → 每个模型都撞 1211「模型不存在」(用户报「更新几个版本后所有模型都不存在了」)。
 * 修复:relay_api 发线前把 `api:pool:model` 剥成裸 `model`;只对 relay_api 生效,绝不动 api
 * 适配器(它需要复合 id 解析池)。门控 KHY_RELAY_COMPOSITE_MODEL_STRIP 默认开,关 → 原样透传。
 *
 * 纯字符串规范化,确定性,无 IO。经 __test__ 钩子取内部函数。
 */
const test = require('node:test');
const assert = require('node:assert');

const gateway = require('../../src/services/gateway/aiGateway');
const { normalizeModelForAdapter } = gateway.__test__;

function withGate(value, fn) {
  const prev = process.env.KHY_RELAY_COMPOSITE_MODEL_STRIP;
  if (value === undefined) delete process.env.KHY_RELAY_COMPOSITE_MODEL_STRIP;
  else process.env.KHY_RELAY_COMPOSITE_MODEL_STRIP = value;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_RELAY_COMPOSITE_MODEL_STRIP;
    else process.env.KHY_RELAY_COMPOSITE_MODEL_STRIP = prev;
  }
}

test('relay_api 剥离复合 id 为裸模型名(默认开)', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      normalizeModelForAdapter('relay_api', 'api:glm:glm-4.7-flash'),
      'glm-4.7-flash',
    );
    // 视觉模型同理
    assert.strictEqual(
      normalizeModelForAdapter('relay_api', 'api:glm:glm-4.6v-flash'),
      'glm-4.6v-flash',
    );
    // 斜杠分隔形态也剥
    assert.strictEqual(
      normalizeModelForAdapter('relay_api', 'api/glm/glm-4.7-flash'),
      'glm-4.7-flash',
    );
  });
});

test('api 适配器绝不被剥(它需要复合 id 解析池)', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      normalizeModelForAdapter('api', 'api:glm:glm-4.7-flash'),
      'api:glm:glm-4.7-flash',
    );
  });
});

test('relay_api 裸模型名原样透传(无复合前缀不受影响)', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      normalizeModelForAdapter('relay_api', 'glm-4.7-flash'),
      'glm-4.7-flash',
    );
  });
});

test('门控关(off/0/false/no)→ relay_api 原样透传复合 id(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withGate(off, () => {
      assert.strictEqual(
        normalizeModelForAdapter('relay_api', 'api:glm:glm-4.7-flash'),
        'api:glm:glm-4.7-flash',
        `gate=${off} 应原样透传`,
      );
    });
  }
});

test('非字符串 / 空值安全透传', () => {
  withGate(undefined, () => {
    assert.strictEqual(normalizeModelForAdapter('relay_api', null), null);
    assert.strictEqual(normalizeModelForAdapter('relay_api', ''), '');
    assert.strictEqual(normalizeModelForAdapter('relay_api', undefined), undefined);
  });
});
