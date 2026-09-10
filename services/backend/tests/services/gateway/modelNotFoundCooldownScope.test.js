'use strict';
/**
 * modelNotFoundCooldownScope.test.js �?model_not_found 冷却「按模型」放�?纯叶�?�?
 *
 * 用户实测复现:复合 id `api:glm:glm-4.6v-flash` �?404 �?冷却写到整条 api 通道(30s),随后剥成
 * 裸名 `glm-4.6v-flash` 的修正请求被同一通道冷却 fast-fail 短路,吐陈旧「recent model_not_found
 * failure cached (cooldown 28s)」——而该裸名模型可用(此前报过 token 超限=已送达上游)�?
 * 本套件锁死叶子契�?
 *   - shouldBypassModelNotFoundCooldown:当前模型�?�?缓存 404 模型�?�?true(放行真实尝试);
 *   - 相同模型�?�?false(尊重冷却,不硬撞确实不存在的模�?;
 *   - �?model_not_found / 缺当前或缓存模型�?/ 门关 �?false(逐字节回退);
 *   - 门控 KHY_MNF_COOLDOWN_PER_MODEL 默认开,off �?�?�?
 *   - 绝不抛�?
 */
const {
  isEnabled,
  shouldBypassModelNotFoundCooldown,
  describeModelNotFoundCooldownScope,
} = require('../../../src/services/gateway/modelNotFoundCooldownScope');

describe('Model Not Found Cooldown Scope', () => {
  test('gate default-on; CANON off values close it (byte-revert)', () => {
      expect(isEnabled({})).toBe(true);
      expect(isEnabled({ KHY_MNF_COOLDOWN_PER_MODEL: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(isEnabled({ KHY_MNF_COOLDOWN_PER_MODEL: v })).toBe(false, v);
      }
  });

  test('different model string �?bypass (composite id 404, corrected bare name retries)', () => {
      const cached = { errorType: 'model_not_found', model: 'api:glm:glm-4.6v-flash', error: '404' };
      assert.strictEqual(shouldBypassModelNotFoundCooldown({
        cached,
        currentModel: 'glm-4.6v-flash',
        env: {},
      }), true);
  });

  test('same model string �?honor cooldown (do not hammer a truly absent model)', () => {
      const cached = { errorType: 'model_not_found', model: 'glm-4.6v-flash', error: '404' };
      assert.strictEqual(shouldBypassModelNotFoundCooldown({
        cached,
        currentModel: 'glm-4.6v-flash',
        env: {},
      }), false);
      // 归一(trim/大小�?后相同也算相�?
      assert.strictEqual(shouldBypassModelNotFoundCooldown({
        cached,
        currentModel: '  GLM-4.6V-Flash ',
        env: {},
      }), false);
  });

  test('non-model_not_found cached error �?never bypass (out of scope)', () => {
      for (const t of ['rate_limit', 'timeout', 'auth', 'unknown', '']) {
        assert.strictEqual(shouldBypassModelNotFoundCooldown({
          cached: { errorType: t, model: 'a', error: 'x' },
          currentModel: 'b',
          env: {},
        }), false, t);
      }
  });

  test('missing current or cached model �?conservative false (byte-revert to channel cooldown)', () => {
      const cached = { errorType: 'model_not_found', model: 'glm-4.6v-flash' };
      expect(shouldBypassModelNotFoundCooldown({ cached, currentModel: '', env: {} })).toBe(false);
      expect(shouldBypassModelNotFoundCooldown({ cached, currentModel: null, env: {} })).toBe(false);
      // 旧记录无 model 字段 �?保守不放�?
      assert.strictEqual(shouldBypassModelNotFoundCooldown({
        cached: { errorType: 'model_not_found', error: '404' },
        currentModel: 'glm-4.6v-flash',
        env: {},
      }), false);
  });

  test('gate off �?never bypass even with different models', () => {
      assert.strictEqual(shouldBypassModelNotFoundCooldown({
        cached: { errorType: 'model_not_found', model: 'api:glm:glm-4.6v-flash' },
        currentModel: 'glm-4.6v-flash',
        env: { KHY_MNF_COOLDOWN_PER_MODEL: 'off' },
      }), false);
  });

  test('never throws on garbage input', () => {
      expect(shouldBypassModelNotFoundCooldown()).toBe(false);
      expect(shouldBypassModelNotFoundCooldown(null)).toBe(false);
      expect(shouldBypassModelNotFoundCooldown({ cached: 123, currentModel: {} })).toBe(false);
      expect(shouldBypassModelNotFoundCooldown({ cached: { errorType: 'model_not_found', model: [] }, currentModel: [] })).toBe(false);
  });

  test('describe self-report exposes gate + parent', () => {
      const d = describeModelNotFoundCooldownScope();
      expect(d.gate).toBe('KHY_MNF_COOLDOWN_PER_MODEL');
      expect(d.parent).toBe('KHY_MODEL_NOT_FOUND_RECOVERY');
      expect(d.defaultOn).toBe(true);
      expect(typeof d.summary === 'string' && d.summary.length > 0).toBeTruthy();
  });

});

