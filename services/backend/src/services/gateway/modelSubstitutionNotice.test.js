'use strict';

/**
 * modelSubstitutionNotice.test.js — node:test 单测(与 services/gateway/*Notice.test.js 同构)。
 * 纯叶子:零 IO、注入 env 可测;验证「实际响应模型 ≠ 请求模型」的透明提示逻辑与门控。
 */

const assert = require('node:assert');
const test = require('node:test');

const { FLAG, isEnabled, modelIdOf, buildSubstitutionNotice } = require(
  './modelSubstitutionNotice'
);

test('modelIdOf: 提取路由串末段模型名', () => {
  assert.strictEqual(modelIdOf('api:sensenova:deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.strictEqual(modelIdOf('deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.strictEqual(modelIdOf('api:sensenova:sensenova-6.8-flash-lite'), 'sensenova-6.8-flash-lite');
  assert.strictEqual(modelIdOf(''), '');
  assert.strictEqual(modelIdOf(null), '');
});

test('isEnabled: 默认开,显式关则关', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ [FLAG]: '0' }), false);
  assert.strictEqual(isEnabled({ [FLAG]: 'off' }), false);
  assert.strictEqual(isEnabled({ [FLAG]: 'true' }), true);
});

test('buildSubstitutionNotice: 模型替换时提示', () => {
  const notice = buildSubstitutionNotice({
    requestedModel: 'api:sensenova:deepseek-v4-flash',
    servingModel: 'step-3.7-flash',
    servingProvider: 'Relay (step-3.7-flash)',
  });
  assert.ok(notice);
  assert.match(notice, /step-3\.7-flash/);
  assert.match(notice, /deepseek-v4-flash/);
  assert.match(notice, /Relay/);
});

test('buildSubstitutionNotice: 同一模型(仅路由前缀不同)不提示', () => {
  const notice = buildSubstitutionNotice({
    requestedModel: 'api:sensenova:sensenova-6.8-flash-lite',
    servingModel: 'sensenova-6.8-flash-lite',
    servingProvider: 'SenseNova',
  });
  assert.strictEqual(notice, null);
});

test('buildSubstitutionNotice: 门关 / 缺参 / 同模型(大小写) 均不提示', () => {
  assert.strictEqual(
    buildSubstitutionNotice({
      requestedModel: 'deepseek-v4-flash',
      servingModel: 'step-3.7-flash',
      env: { [FLAG]: '0' },
    }),
    null
  );
  // 大小写不敏感视为同一模型
  assert.strictEqual(
    buildSubstitutionNotice({
      requestedModel: 'api:sensenova:DeepSeek-V4-Flash',
      servingModel: 'deepseek-v4-flash',
    }),
    null
  );
  assert.strictEqual(
    buildSubstitutionNotice({ requestedModel: '', servingModel: 'x' }),
    null
  );
});
