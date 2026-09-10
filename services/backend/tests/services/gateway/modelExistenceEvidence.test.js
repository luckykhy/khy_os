'use strict';
/**
 * modelExistenceEvidence.test.js �?model_not_found 显示纠偏(纯叶�?�?
 *
 * 用户反馈:「glm-4.6v-flash 是可以用�?之前出现过复�?id 错误,后面又说 token 太大�?既然存在
 * 就不应该显示为找不到模型」。token 超限(1210/1211、max_tokens)证明请求已到达模�?模型存在;
 * 却又把某�?model_not_found 顶到「真实失败原因」头条显示成「不存在�?自相矛盾�?
 * 本套件锁死叶子契�?
 *   - annotateModelNotFoundLine:有存在性证据时追加注解(复合 id �?送错字符�?已送达 �?非不存在);
 *   - �?model_not_found / 无证�?/ 门关 �?原样返回入参 line(逐字节回退);
 *   - hasReachedEvidence:参数/token 类报错、或非「不存在/鉴权」类 errorType �?true;
 *   - 门控 KHY_MNF_EXISTENCE_NOTE 默认开,off �?�?�?
 *   - 绝不抛�?
 */
const {
  isEnabled,
  hasReachedEvidence,
  annotateModelNotFoundLine,
  describeModelExistenceEvidence,
} = require('../../../src/services/gateway/modelExistenceEvidence');
describe('Model Existence Evidence', () => {
  test('annotate: reached evidence �?appends "model exists" note', () => {
    const line = '- api [model_not_found]: recent model_not_found failure cached: 404 (cooldown 28s)';
    const attempts = [
      { success: false, errorType: 'model_not_found', error: '404' },
      { success: false, errorType: 'bad_request', error: 'code 1210 max_tokens too large' },
    ];
    const out = annotateModelNotFoundLine({ line, errorType: 'model_not_found', attempts, env: {} });
    expect(out).not.toBe(line);
    expect(out.startsWith(line)).toBeTruthy();
    expect(out).toContain('非模型真的不存在');
  });
  test('annotate: composite id shape �?appends "wrong string" note (no reached evidence needed)', () => {
    const line = '- api [model_not_found]: model_not_found: api:glm:glm-4.6v-flash';
    const out = annotateModelNotFoundLine({
      line,
      errorType: 'model_not_found',
      message: 'model_not_found: api:glm:glm-4.6v-flash',
      attempts: [{ success: false, errorType: 'model_not_found', error: '404' }],
      env: {},
    });
    expect(out).not.toBe(line);
    expect(out).toContain('复合路由 id');
  });
  
  test('gate default-on; CANON off values close it (byte-revert)', () => {
      expect(isEnabled({})).toBe(true);
      expect(isEnabled({ KHY_MNF_EXISTENCE_NOTE: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(isEnabled({ KHY_MNF_EXISTENCE_NOTE: v })).toBe(false, v);
      }
  });

  test('hasReachedEvidence: token/param error proves the model was reached', () => {
      assert.strictEqual(hasReachedEvidence([
        { success: false, errorType: 'bad_request', error: 'code 1210 max_tokens too large' },
      ]), true);
      assert.strictEqual(hasReachedEvidence([
        { success: false, errorType: 'model_not_found', error: 'context length exceeded' },
      ]), true); // 消息命中 context length 也算已送达
      assert.strictEqual(hasReachedEvidence([
        { success: false, errorType: 'rate_limit', error: '429' },
      ]), true); // 非「不存在/鉴权」类 errorType
  });

  test('hasReachedEvidence: pure absence/auth failures give no evidence', () => {
      assert.strictEqual(hasReachedEvidence([
        { success: false, errorType: 'model_not_found', error: 'Request failed with status code 404' },
        { success: false, errorType: 'auth', error: '401' },
      ]), false);
      expect(hasReachedEvidence([])).toBe(false);
      expect(hasReachedEvidence(null)).toBe(false);
  });

  test('annotate: no evidence, non-composite �?byte-identical passthrough', () => {
      const line = '- api [model_not_found]: no such model glm-9-ultra';
      const out = annotateModelNotFoundLine({
        line,
        errorType: 'model_not_found',
        message: 'no such model glm-9-ultra',
        attempts: [{ success: false, errorType: 'model_not_found', error: 'no such model glm-9-ultra' }],
        env: {},
      });
      expect(out).toBe(line);
  });

  test('annotate: non-model_not_found line �?untouched', () => {
      const line = '- api [rate_limit]: 429 too many requests';
      const out = annotateModelNotFoundLine({
        line,
        errorType: 'rate_limit',
        attempts: [{ success: false, errorType: 'bad_request', error: '1210' }],
        env: {},
      });
      expect(out).toBe(line);
  });

  test('annotate: gate off �?byte-identical passthrough', () => {
      const line = '- api [model_not_found]: model_not_found: api:glm:glm-4.6v-flash';
      const out = annotateModelNotFoundLine({
        line,
        errorType: 'model_not_found',
        message: 'model_not_found: api:glm:glm-4.6v-flash',
        attempts: [{ success: false, errorType: 'bad_request', error: '1210' }],
        env: { KHY_MNF_EXISTENCE_NOTE: 'off' },
      });
      expect(out).toBe(line);
  });

  test('never throws on garbage input; returns a string', () => {
      expect(typeof annotateModelNotFoundLine()).toBe('string');
      expect(annotateModelNotFoundLine({ line: 'x', errorType: 'model_not_found', attempts: 42 })).toBe('x');
      expect(typeof annotateModelNotFoundLine(null)).toBe('string');
  });

  test('describe self-report exposes gate + parent', () => {
      const d = describeModelExistenceEvidence();
      expect(d.gate).toBe('KHY_MNF_EXISTENCE_NOTE');
      expect(d.parent).toBe('KHY_MODEL_NOT_FOUND_RECOVERY');
      expect(d.defaultOn).toBe(true);
      expect(typeof d.summary === 'string' && d.summary.length > 0).toBeTruthy();
  });

});

