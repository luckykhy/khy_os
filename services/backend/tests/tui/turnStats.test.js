'use strict';

/**
 * turnStats 纯叶子单测(node:test)。
 *
 * 覆盖:门控判定 + 阈值解析 + 确定性时长/token 格式化 + 统计行单一真源拼装 +
 * 诚实省略缺失量 + trivial 抑噪 + 门控关字节回退(返 null) + 绝不抛。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  turnStatsEnabled,
  turnStatsMinMs,
  humanizeElapsed,
  fmtTokens,
  buildTurnStatsLine,
} = require('../../src/cli/turnStats');

test('turnStatsEnabled: 默认开 / 关 token', () => {
  assert.equal(turnStatsEnabled({}), true);
  assert.equal(turnStatsEnabled({ KHY_TURN_STATS: '' }), true);
  assert.equal(turnStatsEnabled({ KHY_TURN_STATS: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(turnStatsEnabled({ KHY_TURN_STATS: off }), false, off);
  }
});

test('turnStatsMinMs: 默认 2000 / 自定义 / 无效回退', () => {
  assert.equal(turnStatsMinMs({}), 2000);
  assert.equal(turnStatsMinMs({ KHY_TURN_STATS_MIN_MS: '5000' }), 5000);
  assert.equal(turnStatsMinMs({ KHY_TURN_STATS_MIN_MS: '0' }), 0);
  assert.equal(turnStatsMinMs({ KHY_TURN_STATS_MIN_MS: 'abc' }), 2000);
  assert.equal(turnStatsMinMs({ KHY_TURN_STATS_MIN_MS: '-1' }), 2000);
});

test('humanizeElapsed: 秒/分钟/亚秒(CC formatDuration 口径)', () => {
  assert.equal(humanizeElapsed(0), '');
  assert.equal(humanizeElapsed(400), '');
  assert.equal(humanizeElapsed(999), ''); // 亚秒省略(不显 CC 的 "0s")
  assert.equal(humanizeElapsed(1000), '1s');
  assert.equal(humanizeElapsed(7000), '7s');
  assert.equal(humanizeElapsed(7800), '7s'); // CC floor(legacy 才 round→8)
  assert.equal(humanizeElapsed(60000), '1m 0s'); // CC 保留 0 秒
  assert.equal(humanizeElapsed(90000), '1m 30s'); // CC 空格分隔
  assert.equal(humanizeElapsed(NaN), '');
});

test('humanizeElapsed: KHY_CC_FORMAT 关 → 逐字节回退 legacy', () => {
  const legacy = { KHY_CC_FORMAT: '0' };
  assert.equal(humanizeElapsed(7800, legacy), '8s');
  assert.equal(humanizeElapsed(60000, legacy), '1m');
  assert.equal(humanizeElapsed(90000, legacy), '1m30s');
});

test('fmtTokens: 个位 / 千 / 十万(CC formatTokens 口径)', () => {
  assert.equal(fmtTokens(0), '');
  assert.equal(fmtTokens(-5), '');
  assert.equal(fmtTokens(NaN), '');
  assert.equal(fmtTokens(42), '42 tokens');
  assert.equal(fmtTokens(999), '999 tokens');
  assert.equal(fmtTokens(1000), '1k tokens');
  assert.equal(fmtTokens(1234), '1.2k tokens');
  assert.equal(fmtTokens(12500), '12.5k tokens');
  assert.equal(fmtTokens(123456), '123.5k tokens'); // CC Intl 紧凑保留 1 位小数
});

test('fmtTokens: KHY_CC_FORMAT 关 → 逐字节回退 legacy', () => {
  const legacy = { KHY_CC_FORMAT: '0' };
  assert.equal(fmtTokens(123456, legacy), '123k tokens'); // legacy ≥100k 取整无小数
  assert.equal(fmtTokens(1234, legacy), '1.2k tokens');
});

test('buildTurnStatsLine: 全量(时长+工具+token,CC 口径)', () => {
  assert.equal(
    buildTurnStatsLine({ elapsedMs: 90000, tokens: 1234, toolCount: 3, env: {} }),
    '✓ 1m 30s · 3 工具 · 1.2k tokens'
  );
});

test('buildTurnStatsLine: KHY_CC_FORMAT 关 → 时长回退 legacy(无空格)', () => {
  assert.equal(
    buildTurnStatsLine({ elapsedMs: 90000, tokens: 1234, toolCount: 3, env: { KHY_CC_FORMAT: '0' } }),
    '✓ 1m30s · 3 工具 · 1.2k tokens'
  );
});

test('buildTurnStatsLine: 诚实省略缺失量', () => {
  // 无 token → 省略 token 段
  assert.equal(
    buildTurnStatsLine({ elapsedMs: 7000, tokens: 0, toolCount: 2, env: {} }),
    '✓ 7s · 2 工具'
  );
  // 无工具但耗时够长(纯聊天)→ 只时长 + token
  assert.equal(
    buildTurnStatsLine({ elapsedMs: 3000, tokens: 1500, toolCount: 0, env: {} }),
    '✓ 3s · 1.5k tokens'
  );
});

test('buildTurnStatsLine: trivial 抑噪(无工具且 < 阈值)→ null', () => {
  assert.equal(buildTurnStatsLine({ elapsedMs: 500, tokens: 200, toolCount: 0, env: {} }), null);
  // 自定义阈值:1s 在默认 2000ms 下被抑;阈值降到 100ms 则放行
  assert.equal(buildTurnStatsLine({ elapsedMs: 1000, tokens: 0, toolCount: 0, env: {} }), null);
  assert.equal(
    buildTurnStatsLine({ elapsedMs: 1000, tokens: 0, toolCount: 0, env: { KHY_TURN_STATS_MIN_MS: '100' } }),
    '✓ 1s'
  );
});

test('buildTurnStatsLine: 有工具即放行(即便耗时很短)', () => {
  assert.equal(
    buildTurnStatsLine({ elapsedMs: 300, tokens: 0, toolCount: 1, env: {} }),
    '✓ 1 工具'
  );
});

test('buildTurnStatsLine: 门控关 → null(字节回退)', () => {
  assert.equal(
    buildTurnStatsLine({ elapsedMs: 90000, tokens: 1234, toolCount: 3, env: { KHY_TURN_STATS: '0' } }),
    null
  );
});

test('buildTurnStatsLine: 无任何可显量 → null', () => {
  // 阈值降到 0 放行抑噪门,但三量全空 → 仍 null(无内容可拼)
  assert.equal(
    buildTurnStatsLine({ elapsedMs: 0, tokens: 0, toolCount: 0, env: { KHY_TURN_STATS_MIN_MS: '0' } }),
    null
  );
});

test('绝不抛:畸形入参安全降级', () => {
  assert.doesNotThrow(() => buildTurnStatsLine());
  assert.doesNotThrow(() => buildTurnStatsLine({}));
  assert.doesNotThrow(() => buildTurnStatsLine({ elapsedMs: 'x', tokens: {}, toolCount: [] }));
  assert.doesNotThrow(() => fmtTokens('abc'));
  assert.doesNotThrow(() => humanizeElapsed(null));
});
