'use strict';
/**
 * zhipuGlmModel.test.js �?智谱 GLM 默认/清单收敛(修「glm-5.2 做适配�?�?
 *
 * 现场:zhipu 默认模型 + builtin/preset 清单在全仓三�?SSoT 里仍停留 glm-4 世代,
 * glm-5.2 从不作默认、也不出现在可选清单里。本套件锁死这个纯叶�?
 *   - 开�?default)�?默认 = glm-5.2,清单�?glm-5.2 打头(glm-4 系仍�?可�?;
 *   - 关门(0/false/off/no)�?逐字节回退历史默认 glm-4 与旧清单 [glm-4, glm-4-flash, glm-4-air];
 *   - 绝不�?junk env / null)�?
 */
const {
  latestGlmModelEnabled,
  defaultZhipuModel,
  knownZhipuModels,
  LATEST_ZHIPU_MODEL,
  LEGACY_ZHIPU_MODEL,
  LATEST_ZHIPU_MODELS,
  LEGACY_ZHIPU_MODELS,
} = require('../../src/services/zhipuGlmModel');

describe('Zhipu Glm Model', () => {
  test('constants match the documented ids', () => {
      expect(LATEST_ZHIPU_MODEL).toBe('glm-5.2');
      expect(LEGACY_ZHIPU_MODEL).toBe('glm-4');
      expect(LEGACY_ZHIPU_MODELS).toEqual(['glm-4', 'glm-4-flash', 'glm-4-air']);
      expect(LATEST_ZHIPU_MODELS[0]).toBe('glm-5.2'); // latest leads
  });

  test('gate default-on �?latest glm-5.2', () => {
      expect(latestGlmModelEnabled({})).toBe(true);
      expect(defaultZhipuModel({})).toBe('glm-5.2');
      expect(latestGlmModelEnabled({ KHY_GLM_LATEST_MODEL: '1' })).toBe(true);
      expect(defaultZhipuModel({ KHY_GLM_LATEST_MODEL: 'on' })).toBe('glm-5.2');
  });

  test('gate off (0/false/off/no, case/space-insensitive) �?byte-reverts to glm-4', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
        expect(latestGlmModelEnabled({ KHY_GLM_LATEST_MODEL: v })).toBe(false, v);
        expect(defaultZhipuModel({ KHY_GLM_LATEST_MODEL: v })).toBe('glm-4', v);
        expect(knownZhipuModels({ KHY_GLM_LATEST_MODEL: v })).toEqual(['glm-4', 'glm-4-flash', 'glm-4-air'], v);
      }
  });

  test('knownZhipuModels() default-on �?glm-5.2 first, glm-4 family retained (selectable)', () => {
      const models = knownZhipuModels({});
      expect(models[0]).toBe('glm-5.2');
      expect(models.includes('glm-4')).toBeTruthy();
      expect(models).toContain('glm-4-flash');
      expect(models).toContain('glm-4-air');
  });

  test('knownZhipuModels() returns a fresh copy (caller mutation is isolated)', () => {
      const a = knownZhipuModels({});
      a.push('mutant');
      expect(!knownZhipuModels({})).toContain('mutant');
      expect(a).not.toBe(LATEST_ZHIPU_MODELS);
  });

  test('GLM_DEFAULT_MODEL explicit override has highest priority', () => {
      // GLM_DEFAULT_MODEL 明确指定时，优先级高�?KHY_GLM_LATEST_MODEL
      expect(defaultZhipuModel({ GLM_DEFAULT_MODEL: 'glm-4-flash' })).toBe('glm-4-flash');
      expect(defaultZhipuModel({ GLM_DEFAULT_MODEL: 'glm-4-air' })).toBe('glm-4-air');
      // 即使 KHY_GLM_LATEST_MODEL=1，GLM_DEFAULT_MODEL 仍然优先
      expect(defaultZhipuModel({ GLM_DEFAULT_MODEL: 'glm-4-flash', KHY_GLM_LATEST_MODEL: '1' })).toBe('glm-4-flash');
      // 空字符串视为未设置，回退到门控逻辑
      expect(defaultZhipuModel({ GLM_DEFAULT_MODEL: '', KHY_GLM_LATEST_MODEL: '0' })).toBe('glm-4');
      expect(defaultZhipuModel({ GLM_DEFAULT_MODEL: '  ', KHY_GLM_LATEST_MODEL: '1' })).toBe('glm-5.2');
  });

  test('never throws on junk env', () => {
      expect(() => defaultZhipuModel(null).not.toThrow());
      expect(() => defaultZhipuModel(undefined).not.toThrow());
      expect(() => latestGlmModelEnabled(null).not.toThrow());
      expect(() => knownZhipuModels({ KHY_GLM_LATEST_MODEL: {} }).not.toThrow());
  });

  test('LIVE wiring: consumers route zhipu default/list through this leaf', () => {
      const fs = require('fs');
      const path = require('path');
      const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const routes = read('../../src/routes/ai.js');
      expect(/zhipuGlmModel/.test(routes) && /defaultZhipuModel\(\)/.test(routes)).toBeTruthy();
      const presets = read('../../src/services/gateway/providerPresets.js');
      expect(/zhipuGlmModel/.test(presets)).toBeTruthy();
      const builtin = read('../../src/services/gateway/builtinProviderConfig.js');
      expect(/zhipuGlmModel/.test(builtin)).toBeTruthy();
  });

});

