'use strict';

/**
 * visionFailureSummaryModernKey.test.js — R5 接线:把 modernKeyRedaction 叶子(R2,门控
 * KHY_MODERN_KEY_REDACTION)接进 gateway/visionFailureSummary.sanitizeCause,闭合第二处
 * 现代 OpenAI key 泄漏(RecognizeImage 工具默认失败路径)。
 *
 * 覆盖:门开 → sk-proj-/sk-svcacct-/sk-admin- 脱敏、legacy sk- 与诊断真因保留;
 * 门关 → 逐字节回退(现代 key 泄漏,legacy 仍抹)。
 */

const test = require('node:test');
const assert = require('node:assert');

function freshVision() {
  delete require.cache[require.resolve('../src/services/gateway/visionFailureSummary')];
  delete require.cache[require.resolve('../src/services/modernKeyRedaction')];
  return require('../src/services/gateway/visionFailureSummary');
}

function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('wiring ON: sanitizeCause redacts modern keys the inline pattern missed', () => {
  withEnv({ KHY_MODERN_KEY_REDACTION: undefined }, () => {
    const m = freshVision();
    assert.strictEqual(
      m.sanitizeCause('Incorrect API key provided: sk-proj-abcd1234EFGH5678ijkl. Find it at ...'),
      'Incorrect API key provided: ***. Find it at ...');
    assert.strictEqual(m.sanitizeCause('智谱AI 401 with key sk-svcacct-abcd1234EFGH5678'), '智谱AI 401 with key ***');
    assert.strictEqual(m.sanitizeCause('auth using sk-admin-abcd1234EFGH5678ijklMNOP'), 'auth using ***');
    // legacy key still redacted; operable diagnostics preserved
    assert.strictEqual(m.sanitizeCause('legacy key sk-abcd1234EFGH5678ijkl works'), 'legacy key *** works');
    assert.strictEqual(m.sanitizeCause('ECONNREFUSED 127.0.0.1:7890 [auth] 401'), 'ECONNREFUSED 127.0.0.1:7890 [auth] 401');
  });
});

test('wiring OFF: byte-revert → modern key leaks, legacy still redacted', () => {
  withEnv({ KHY_MODERN_KEY_REDACTION: '0' }, () => {
    const m = freshVision();
    assert.strictEqual(m.sanitizeCause('key sk-proj-abcd1234EFGH5678ijkl x'), 'key sk-proj-abcd1234EFGH5678ijkl x');
    assert.strictEqual(m.sanitizeCause('key sk-abcd1234EFGH5678ijkl works'), 'key *** works');
  });
});

test('classify/build still function (no regression to the summary path)', () => {
  const m = freshVision();
  assert.strictEqual(m.classifyVisionFailure('智谱AI 401 [auth]'), 'auth');
  const msg = m.buildVisionFailureMessage
    ? m.buildVisionFailureMessage({ category: 'auth', modelId: 'glm/glm-4.6v-flash', cause: 'key sk-proj-abcd1234EFGH5678ijkl invalid' })
    : null;
  if (msg) assert.ok(!/sk-proj-abcd1234EFGH5678ijkl/.test(msg), 'key must not leak into built message');
});
