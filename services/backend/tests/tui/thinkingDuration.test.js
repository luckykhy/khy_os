'use strict';

/**
 * thinkingDuration 纯叶子单测(node:test)。
 *
 * 覆盖:门控判定 + 确定性 ms→人读时长 + 折叠/展开两态文案单一真源 +
 * 门控关逐字节回退 + <1s 亚秒思考诚实不显时长 + 绝不抛。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  thinkingDurationEnabled,
  humanizeThinkingMs,
  buildThinkingSummary,
  buildThinkingHeader,
} = require('../../src/cli/thinkingDuration');

test('thinkingDurationEnabled: 默认开(空 env)', () => {
  assert.equal(thinkingDurationEnabled({}), true);
  assert.equal(thinkingDurationEnabled({ KHY_THINKING_DURATION: '' }), true);
  assert.equal(thinkingDurationEnabled({ KHY_THINKING_DURATION: '1' }), true);
  assert.equal(thinkingDurationEnabled({ KHY_THINKING_DURATION: 'on' }), true);
});

test('thinkingDurationEnabled: 关 token 全识别', () => {
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO']) {
    assert.equal(thinkingDurationEnabled({ KHY_THINKING_DURATION: off }), false, off);
  }
});

test('humanizeThinkingMs: 无效/非正 → 空串', () => {
  assert.equal(humanizeThinkingMs(0), '');
  assert.equal(humanizeThinkingMs(-100), '');
  assert.equal(humanizeThinkingMs(NaN), '');
  assert.equal(humanizeThinkingMs('abc'), '');
  assert.equal(humanizeThinkingMs(null), '');
  assert.equal(humanizeThinkingMs(undefined), '');
});

test('humanizeThinkingMs: 亚秒(<1s)诚实不显(CC 对齐:不夸大成 0s)', () => {
  // CC 口径(默认 KHY_CC_FORMAT 开):任何 <1s 一律不显时长(诚实),不夸大成 CC 的 "0s"。
  assert.equal(humanizeThinkingMs(1), '');
  assert.equal(humanizeThinkingMs(400), '');
  assert.equal(humanizeThinkingMs(499), '');
  assert.equal(humanizeThinkingMs(500), '');
  assert.equal(humanizeThinkingMs(999), '');
});

test('humanizeThinkingMs: 秒级(CC formatDuration = floor 取秒)', () => {
  assert.equal(humanizeThinkingMs(1000), '1s');
  assert.equal(humanizeThinkingMs(7000), '7s');
  assert.equal(humanizeThinkingMs(7400), '7s');
  assert.equal(humanizeThinkingMs(7600), '7s'); // CC: floor(7.6)=7(legacy 才 round→8)
  assert.equal(humanizeThinkingMs(7999), '7s');
  assert.equal(humanizeThinkingMs(59000), '59s');
  assert.equal(humanizeThinkingMs(59999), '59s');
});

test('humanizeThinkingMs: 分钟级(CC formatDuration = "Mm Ss" 空格 + 保留 0 秒)', () => {
  assert.equal(humanizeThinkingMs(60000), '1m 0s'); // CC 保留 0 秒(legacy 才 "1m")
  assert.equal(humanizeThinkingMs(90000), '1m 30s'); // CC 空格分隔(legacy "1m30s")
  assert.equal(humanizeThinkingMs(120000), '2m 0s');
  assert.equal(humanizeThinkingMs(125000), '2m 5s');
});

test('humanizeThinkingMs: KHY_CC_FORMAT 关 → 逐字节回退 legacy 口径', () => {
  const legacy = { KHY_CC_FORMAT: '0' };
  assert.equal(humanizeThinkingMs(500, legacy), '1s'); // legacy round(0.5)=1
  assert.equal(humanizeThinkingMs(7600, legacy), '8s'); // legacy round
  assert.equal(humanizeThinkingMs(60000, legacy), '1m'); // legacy 丢 0 秒
  assert.equal(humanizeThinkingMs(90000, legacy), '1m30s'); // legacy 无空格
});

test('buildThinkingSummary: 门控开 + 真实时长 → 带时长', () => {
  assert.equal(
    buildThinkingSummary({ chars: 42, durationMs: 7000, env: {} }),
    '💭 思考 7s · 42 字（Ctrl+O 展开）'
  );
});

test('buildThinkingSummary: 门控开但无时长 → 旧文案(字节回退)', () => {
  assert.equal(
    buildThinkingSummary({ chars: 42, durationMs: 0, env: {} }),
    '💭 思考 · 42 字（Ctrl+O 展开）'
  );
  assert.equal(
    buildThinkingSummary({ chars: 42, env: {} }),
    '💭 思考 · 42 字（Ctrl+O 展开）'
  );
});

test('buildThinkingSummary: 门控关 → 旧文案(逐字节回退,即便有时长)', () => {
  assert.equal(
    buildThinkingSummary({ chars: 42, durationMs: 7000, env: { KHY_THINKING_DURATION: '0' } }),
    '💭 思考 · 42 字（Ctrl+O 展开）'
  );
});

test('buildThinkingSummary: 亚秒时长 → 不显时长(诚实)', () => {
  assert.equal(
    buildThinkingSummary({ chars: 10, durationMs: 200, env: {} }),
    '💭 思考 · 10 字（Ctrl+O 展开）'
  );
});

test('buildThinkingHeader: 门控开 + 时长 → 带时长(CC 空格口径)', () => {
  assert.equal(buildThinkingHeader({ durationMs: 90000, env: {} }), '💭 思考 1m 30s');
});

test('buildThinkingHeader: 门控关 / 无时长 → 裸 💭 思考', () => {
  assert.equal(buildThinkingHeader({ durationMs: 7000, env: { KHY_THINKING_DURATION: 'off' } }), '💭 思考');
  assert.equal(buildThinkingHeader({ env: {} }), '💭 思考');
  assert.equal(buildThinkingHeader({}), '💭 思考');
});

test('绝不抛:畸形入参全部安全降级', () => {
  assert.doesNotThrow(() => buildThinkingSummary());
  assert.doesNotThrow(() => buildThinkingSummary({}));
  assert.doesNotThrow(() => buildThinkingHeader());
  assert.doesNotThrow(() => humanizeThinkingMs({}));
});
