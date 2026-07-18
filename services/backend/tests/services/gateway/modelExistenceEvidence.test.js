'use strict';

/**
 * modelExistenceEvidence.test.js — model_not_found 显示纠偏(纯叶子)。
 *
 * 用户反馈:「glm-4.6v-flash 是可以用的,之前出现过复合 id 错误,后面又说 token 太大了,既然存在
 * 就不应该显示为找不到模型」。token 超限(1210/1211、max_tokens)证明请求已到达模型=模型存在;
 * 却又把某次 model_not_found 顶到「真实失败原因」头条显示成「不存在」,自相矛盾。
 * 本套件锁死叶子契约:
 *   - annotateModelNotFoundLine:有存在性证据时追加注解(复合 id → 送错字符串;已送达 → 非不存在);
 *   - 非 model_not_found / 无证据 / 门关 → 原样返回入参 line(逐字节回退);
 *   - hasReachedEvidence:参数/token 类报错、或非「不存在/鉴权」类 errorType → true;
 *   - 门控 KHY_MNF_EXISTENCE_NOTE 默认开,off 值 → 关;
 *   - 绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isEnabled,
  hasReachedEvidence,
  annotateModelNotFoundLine,
  describeModelExistenceEvidence,
} = require('../../../src/services/gateway/modelExistenceEvidence');

test('gate default-on; CANON off values close it (byte-revert)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_MNF_EXISTENCE_NOTE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(isEnabled({ KHY_MNF_EXISTENCE_NOTE: v }), false, v);
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
  assert.strictEqual(hasReachedEvidence([]), false);
  assert.strictEqual(hasReachedEvidence(null), false);
});

test('annotate: reached evidence → appends "model exists" note', () => {
  const line = '- api [model_not_found]: recent model_not_found failure cached: 404 (cooldown 28s)';
  const attempts = [
    { success: false, errorType: 'model_not_found', error: '404' },
    { success: false, errorType: 'bad_request', error: 'code 1210 max_tokens too large' },
  ];
  const out = annotateModelNotFoundLine({ line, errorType: 'model_not_found', attempts, env: {} });
  assert.notStrictEqual(out, line);
  assert.ok(out.startsWith(line));
  assert.ok(out.includes('非模型真的不存在'));
});

test('annotate: composite id shape → appends "wrong string" note (no reached evidence needed)', () => {
  const line = '- api [model_not_found]: model_not_found: api:glm:glm-4.6v-flash';
  const out = annotateModelNotFoundLine({
    line,
    errorType: 'model_not_found',
    message: 'model_not_found: api:glm:glm-4.6v-flash',
    attempts: [{ success: false, errorType: 'model_not_found', error: '404' }],
    env: {},
  });
  assert.notStrictEqual(out, line);
  assert.ok(out.includes('复合路由 id'));
});

test('annotate: no evidence, non-composite → byte-identical passthrough', () => {
  const line = '- api [model_not_found]: no such model glm-9-ultra';
  const out = annotateModelNotFoundLine({
    line,
    errorType: 'model_not_found',
    message: 'no such model glm-9-ultra',
    attempts: [{ success: false, errorType: 'model_not_found', error: 'no such model glm-9-ultra' }],
    env: {},
  });
  assert.strictEqual(out, line);
});

test('annotate: non-model_not_found line → untouched', () => {
  const line = '- api [rate_limit]: 429 too many requests';
  const out = annotateModelNotFoundLine({
    line,
    errorType: 'rate_limit',
    attempts: [{ success: false, errorType: 'bad_request', error: '1210' }],
    env: {},
  });
  assert.strictEqual(out, line);
});

test('annotate: gate off → byte-identical passthrough', () => {
  const line = '- api [model_not_found]: model_not_found: api:glm:glm-4.6v-flash';
  const out = annotateModelNotFoundLine({
    line,
    errorType: 'model_not_found',
    message: 'model_not_found: api:glm:glm-4.6v-flash',
    attempts: [{ success: false, errorType: 'bad_request', error: '1210' }],
    env: { KHY_MNF_EXISTENCE_NOTE: 'off' },
  });
  assert.strictEqual(out, line);
});

test('never throws on garbage input; returns a string', () => {
  assert.strictEqual(typeof annotateModelNotFoundLine(), 'string');
  assert.strictEqual(annotateModelNotFoundLine({ line: 'x', errorType: 'model_not_found', attempts: 42 }), 'x');
  assert.strictEqual(typeof annotateModelNotFoundLine(null), 'string');
});

test('describe self-report exposes gate + parent', () => {
  const d = describeModelExistenceEvidence();
  assert.strictEqual(d.gate, 'KHY_MNF_EXISTENCE_NOTE');
  assert.strictEqual(d.parent, 'KHY_MODEL_NOT_FOUND_RECOVERY');
  assert.strictEqual(d.defaultOn, true);
  assert.ok(typeof d.summary === 'string' && d.summary.length > 0);
});
