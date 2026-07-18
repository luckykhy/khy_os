'use strict';

/**
 * visionDescribeCooldownBypass.test.js — 锁定「视觉 describe 级联被首个候选的 model_not_found
 * 冷却连坐挡住次选」的根因修复(已发布 0.1.168 图像识别 404 真 bug)。
 *
 * 历史 bug:图像识别调 `glm/glm-4.6v-flash` 返回 model_not_found 404(该账号未开通/未实名)。
 * describe 级联本应有序降级到次选 `glm-4v-flash`(该账号可用·http=200 已证),但 fast-fail 冷却
 * **按 adapter 键控**(_adapterLastError[adapterKey]),而 glm-4.6v-flash 与 glm-4v-flash 同属
 * GLM adapter → 首个候选刚写下的 model_not_found 冷却把同一次 describe 里的次选直接跳过 →
 * 级联永远救不回,用户只见「recent model_not_found failure cached (cooldown …)」。
 *
 * 修:describe 透传(options._visionDescribePass,恒带**显式候选 model**)遇 model_not_found
 * 冷却时放行(视为未冷却,让这个不同的显式模型获得真实尝试)。其它错误类型 / 非 describe 请求
 * 逐字节不变。判定收敛在纯方法 `_shouldBypassCooldownForVisionDescribe(options, cached)`。
 *
 * 纯正确性修复,不加新 flag(model_not_found 本是按模型的错误,按 adapter 连坐是缺陷)。
 */

const { test } = require('node:test');
const assert = require('node:assert');

// module.exports = gateway 单例;方法直接挂实例。
const gateway = require('../../../src/services/gateway/aiGateway');

const mkCached = (errorType) => ({
  errorType,
  error: `${errorType} raw`,
  at: Date.now(),
  cooldownMs: 30000,
  remainingMs: 26000,
});

test('describe 透传遇 model_not_found 冷却 → 放行(次选显式模型获真实尝试)', () => {
  const got = gateway._shouldBypassCooldownForVisionDescribe(
    { _visionDescribePass: true, model: 'glm-4v-flash' },
    mkCached('model_not_found'),
  );
  assert.strictEqual(got, true);
  // 大小写不敏感(errorType 归一化)。
  assert.strictEqual(
    gateway._shouldBypassCooldownForVisionDescribe(
      { _visionDescribePass: true }, mkCached('MODEL_NOT_FOUND'),
    ),
    true,
  );
});

test('describe 透传遇其它错误类型 → 不放行(仅 model_not_found 才连坐,瞬时/永久错误照常冷却)', () => {
  for (const et of ['rate_limit', 'timeout', 'network', 'overloaded', 'auth', 'unknown']) {
    assert.strictEqual(
      gateway._shouldBypassCooldownForVisionDescribe({ _visionDescribePass: true }, mkCached(et)),
      false,
      `${et} 不应被 describe 放行`,
    );
  }
});

test('非 describe 请求(顶层 generate)遇 model_not_found → 不放行(逐字节保留冷却)', () => {
  assert.strictEqual(
    gateway._shouldBypassCooldownForVisionDescribe(
      { model: 'glm-4.6v-flash' }, mkCached('model_not_found'),
    ),
    false,
  );
  // _visionDescribePass 显式 false / 缺失 → 不放行。
  assert.strictEqual(
    gateway._shouldBypassCooldownForVisionDescribe(
      { _visionDescribePass: false }, mkCached('model_not_found'),
    ),
    false,
  );
});

test('fail-soft:options / cached 缺失或异常一律 false,绝不抛', () => {
  assert.strictEqual(gateway._shouldBypassCooldownForVisionDescribe(null, mkCached('model_not_found')), false);
  assert.strictEqual(gateway._shouldBypassCooldownForVisionDescribe(undefined, mkCached('model_not_found')), false);
  assert.strictEqual(gateway._shouldBypassCooldownForVisionDescribe({ _visionDescribePass: true }, null), false);
  assert.strictEqual(gateway._shouldBypassCooldownForVisionDescribe({ _visionDescribePass: true }, undefined), false);
  // cached.errorType 缺失 → 归一化空串 → 非 model_not_found → false(不抛)。
  assert.strictEqual(
    gateway._shouldBypassCooldownForVisionDescribe({ _visionDescribePass: true }, { error: 'x' }),
    false,
  );
});
