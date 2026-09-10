'use strict';
/**
 * modelSubstitutionNotice.test.js �?node:test 单测(�?services/gateway/*Notice.test.js 同构)�?
 * 纯叶�?�?IO、注�?env 可测;验证「实际响应模�?�?请求模型」的透明提示逻辑与门控�?
 */
const { FLAG, isEnabled, modelIdOf, buildSubstitutionNotice } = require(
  './modelSubstitutionNotice'
);

describe('Model Substitution Notice', () => {
  test('modelIdOf: 提取路由串末段模型名', () => {
      expect(modelIdOf('api:sensenova:deepseek-v4-flash')).toBe('deepseek-v4-flash');
      expect(modelIdOf('deepseek-v4-flash')).toBe('deepseek-v4-flash');
      expect(modelIdOf('api:sensenova:sensenova-6.8-flash-lite')).toBe('sensenova-6.8-flash-lite');
      expect(modelIdOf('')).toBe('');
      expect(modelIdOf(null)).toBe('');
  });

  test('isEnabled: 默认开,显式关则�?, () => {
      expect(isEnabled({})).toBe(true);
      expect(isEnabled({ [FLAG]: '0' })).toBe(false);
      expect(isEnabled({ [FLAG]: 'off' })).toBe(false);
      expect(isEnabled({ [FLAG]: 'true' })).toBe(true);
  });

  test('buildSubstitutionNotice: 模型替换时提�?, () => {
      const notice = buildSubstitutionNotice({
        requestedModel: 'api:sensenova:deepseek-v4-flash',
        servingModel: 'step-3.7-flash',
        servingProvider: 'Relay (step-3.7-flash)',
      });
      expect(notice).toBeTruthy();
      expect(notice).toMatch(/step-3\.7-flash/);
      expect(notice).toMatch(/deepseek-v4-flash/);
      expect(notice).toMatch(/Relay/);
  });

  test('buildSubstitutionNotice: 同一模型(仅路由前缀不同)不提�?, () => {
      const notice = buildSubstitutionNotice({
        requestedModel: 'api:sensenova:sensenova-6.8-flash-lite',
        servingModel: 'sensenova-6.8-flash-lite',
        servingProvider: 'SenseNova',
      });
      expect(notice).toBe(null);
  });

  test('buildSubstitutionNotice: 门关 / 缺参 / 同模�?大小�? 均不提示', () => {
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

});

