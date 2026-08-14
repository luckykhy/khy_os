'use strict';

/**
 * streamStaleThresholdHoist.test —— 流陈旧阈值按 provider 前缀选取
 * (Ch2「不要每轮重建可复用结构」;node:test)。
 *
 * StreamStaleDetector 构造时的 provider 键扫描已从每构造 Object.keys(PROVIDER_STALE_MS) 现建
 * 提升为模块常量 _PROVIDER_STALE_KEYS(且 PROVIDER_STALE_MS 冻结)。此提升是纯重构(逐字节等价
 * 行为、无门),本套件把阈值选取契约钉死:各 provider 前缀→正确阈值、override 优先、未知→default、
 * 且 PROVIDER_STALE_MS 已冻结(防意外突变致键快照漂移)。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  StreamStaleDetector,
  PROVIDER_STALE_MS,
} = require('../src/services/gateway/adapters/_streamStaleDetector.js');

// 门关(KHY_STREAM_STALE_TUNING=off)时的历史查表契约:逐字节等价 I1 之前。
const OFF = { KHY_STREAM_STALE_TUNING: 'off' };

function thresholdFor(provider, thresholdMs, env = OFF) {
  const opts = { env };
  if (provider !== undefined) opts.provider = provider;
  if (thresholdMs !== undefined) opts.thresholdMs = thresholdMs;
  return new StreamStaleDetector(opts)._thresholdMs;
}

test('各 provider 前缀映射到正确阈值(门关 = 历史查表)', () => {
  const cases = [
    ['claude-3-opus', 90_000],
    ['anthropic', 90_000],
    ['gpt-4o', 45_000],
    ['openai', 45_000],
    ['deepseek-v3', 90_000],
    ['ollama-llama3', 120_000],
    ['gemini-1.5', 60_000],
  ];
  for (const [provider, expected] of cases) {
    assert.strictEqual(thresholdFor(provider), expected, `${provider} → ${expected}`);
  }
});

test('未知 provider / 缺省 → default 阈值(门关)', () => {
  assert.strictEqual(thresholdFor('some-unknown-model'), 90_000);
  assert.strictEqual(thresholdFor(undefined), 90_000);
});

test('显式 thresholdMs override 优先(门开门关皆然)', () => {
  assert.strictEqual(thresholdFor('claude', 12_345), 12_345);
  assert.strictEqual(thresholdFor('gpt', 1), 1);
  const d = new StreamStaleDetector({ provider: 'gpt', thresholdMs: 12_345, env: {} });
  assert.strictEqual(d._thresholdMs, 12_345);
  assert.strictEqual(d._graceMs, 12_345, '显式 override → 无宽限,grace 回落到该值');
});

test('warn 阈值为 threshold 的 80%(门关 gpt=45000)', () => {
  const d = new StreamStaleDetector({ provider: 'gpt', env: OFF });
  assert.strictEqual(d._warnMs, Math.floor(45_000 * 0.8));
});

// ── I1 阈值调优(门 KHY_STREAM_STALE_TUNING 默认开)────────────────────────
test('I1 门开(默认):gpt/openai 稳态抬齐 default 90s,其余不变', () => {
  const on = {};
  assert.strictEqual(thresholdFor('gpt-4o', undefined, on), 90_000, 'gpt → 90000');
  assert.strictEqual(thresholdFor('openai', undefined, on), 90_000, 'openai → 90000');
  assert.strictEqual(thresholdFor('claude-3', undefined, on), 90_000);
  assert.strictEqual(thresholdFor('gemini-1.5', undefined, on), 60_000);
  assert.strictEqual(thresholdFor('ollama-x', undefined, on), 120_000);
});

test('I1 首 token 宽限:首 chunk 前用 graceMs(默认 120s),touch 记录首 chunk', () => {
  const d = new StreamStaleDetector({ provider: 'gpt-4o', env: {} });
  assert.strictEqual(d._thresholdMs, 90_000, '稳态 90s');
  assert.strictEqual(d._graceMs, 120_000, '宽限 120s');
  assert.strictEqual(d._firstChunkTs, null);
  d.touch(10);
  assert.notStrictEqual(d._firstChunkTs, null, 'touch 后记录首 chunk 时刻');
});

test('I1 门关:grace===threshold(首 token 前后阈值一致 = 字节等价)', () => {
  const d = new StreamStaleDetector({ provider: 'gpt-4o', env: OFF });
  assert.strictEqual(d._thresholdMs, 45_000);
  assert.strictEqual(d._graceMs, 45_000);
});

test('I1 KHY_STREAM_STALE_MS(>0)整体覆盖稳态阈值', () => {
  const d = new StreamStaleDetector({ provider: 'claude', env: { KHY_STREAM_STALE_MS: '200000' } });
  assert.strictEqual(d._thresholdMs, 200_000);
});

test('I1 KHY_STREAM_FIRST_TOKEN_GRACE_MS 自定义宽限 / 0 无宽限', () => {
  const d = new StreamStaleDetector({ provider: 'claude', env: { KHY_STREAM_FIRST_TOKEN_GRACE_MS: '300000' } });
  assert.strictEqual(d._graceMs, 300_000);
  const d0 = new StreamStaleDetector({ provider: 'claude', env: { KHY_STREAM_FIRST_TOKEN_GRACE_MS: '0' } });
  assert.strictEqual(d0._graceMs, 90_000, 'grace=0 → 回落到稳态阈值');
});

test('I1 坏 env 值 fail-soft(非数字 → 默认宽限 / 忽略 override)', () => {
  const d = new StreamStaleDetector({ provider: 'gpt', env: { KHY_STREAM_FIRST_TOKEN_GRACE_MS: 'nonsense' } });
  assert.strictEqual(d._graceMs, 120_000);
  const d2 = new StreamStaleDetector({ provider: 'gpt', env: { KHY_STREAM_STALE_MS: 'nonsense' } });
  assert.strictEqual(d2._thresholdMs, 90_000, '坏 override → 忽略,用稳态');
});

test('PROVIDER_STALE_MS 已冻结(键快照不会漂移)', () => {
  assert.ok(Object.isFrozen(PROVIDER_STALE_MS));
});
