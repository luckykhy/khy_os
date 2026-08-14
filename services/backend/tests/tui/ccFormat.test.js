'use strict';

/**
 * ccFormat 纯叶子单测(node:test)。
 *
 * 验证 Claude Code 源 `src/utils/format.ts` 的 formatDuration / formatNumber /
 * formatTokens **逐分支移植正确**——这是「不只显示对齐、后端逻辑也对齐」的核心:
 * Khy 屏幕上的时长 / token 串必须是 CC 同一套算法的输出。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ccFormatEnabled,
  ccFormatDuration,
  ccFormatDurationOr,
  ccFormatNumber,
  ccFormatTokens,
  ccFormatTokensOr,
  ccFormatFileSize,
  ccRelativeAgeParts,
} = require('../../src/cli/ccFormat');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

test('ccFormatEnabled: 默认开 / 关 token', () => {
  assert.equal(ccFormatEnabled({}), true);
  assert.equal(ccFormatEnabled({ KHY_CC_FORMAT: '' }), true);
  assert.equal(ccFormatEnabled({ KHY_CC_FORMAT: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(ccFormatEnabled({ KHY_CC_FORMAT: off }), false, off);
  }
});

test('ccFormatDuration: 秒档(CC floor + 0s 特例)', () => {
  assert.equal(ccFormatDuration(0), '0s');
  assert.equal(ccFormatDuration(400), '0s');
  assert.equal(ccFormatDuration(1000), '1s');
  assert.equal(ccFormatDuration(7000), '7s');
  assert.equal(ccFormatDuration(7800), '7s'); // floor,不是 round
  assert.equal(ccFormatDuration(59000), '59s');
  assert.equal(ccFormatDuration(59500), '59s'); // <60000 仍 floor
});

test('ccFormatDuration: 分/时档("Mm Ss" 空格 + 保留 0 秒 + 进位)', () => {
  assert.equal(ccFormatDuration(60000), '1m 0s');
  assert.equal(ccFormatDuration(90000), '1m 30s');
  assert.equal(ccFormatDuration(90500), '1m 31s'); // round((90500%60000)/1000)=round(30.5)=31
  assert.equal(ccFormatDuration(119500), '2m 0s'); // 59.5s round→60 进位到分钟
  assert.equal(ccFormatDuration(3600000), '1h 0m 0s');
  assert.equal(ccFormatDuration(3661000), '1h 1m 1s');
});

test('ccFormatDuration: mostSignificantOnly / hideTrailingZeros', () => {
  assert.equal(ccFormatDuration(3661000, { mostSignificantOnly: true }), '1h');
  assert.equal(ccFormatDuration(90000, { mostSignificantOnly: true }), '1m');
  assert.equal(ccFormatDuration(7000, { mostSignificantOnly: true }), '7s');
  assert.equal(ccFormatDuration(3600000, { hideTrailingZeros: true }), '1h');
  assert.equal(ccFormatDuration(60000, { hideTrailingZeros: true }), '1m');
});

test('ccFormatNumber: Intl 紧凑记数 + 小写', () => {
  assert.equal(ccFormatNumber(42), '42');
  assert.equal(ccFormatNumber(900), '900');
  assert.equal(ccFormatNumber(999), '999');
  assert.equal(ccFormatNumber(1000), '1.0k');
  assert.equal(ccFormatNumber(1234), '1.2k');
  assert.equal(ccFormatNumber(12500), '12.5k');
  assert.equal(ccFormatNumber(123456), '123.5k');
  assert.equal(ccFormatNumber(1000000), '1.0m');
});

test('ccFormatTokens: 去尾随 .0', () => {
  assert.equal(ccFormatTokens(42), '42');
  assert.equal(ccFormatTokens(999), '999');
  assert.equal(ccFormatTokens(1000), '1k'); // "1.0k" → "1k"
  assert.equal(ccFormatTokens(1234), '1.2k');
  assert.equal(ccFormatTokens(12500), '12.5k');
  assert.equal(ccFormatTokens(123456), '123.5k');
  assert.equal(ccFormatTokens(1000000), '1m');
});

test('ccFormatTokensOr: 门控开 → ccFormatTokens(裸数字),门控关 → call-site legacy', () => {
  const ON = {};
  const OFF = { KHY_CC_FORMAT: 'off' };
  // 门控开:忽略 legacy,走紧凑记数
  assert.equal(ccFormatTokensOr(45000, '45.0k', ON), '45k');
  assert.equal(ccFormatTokensOr(128000, '128.0k', ON), '128k');
  assert.equal(ccFormatTokensOr(1500000, '1500.0k', ON), '1.5m');
  assert.equal(ccFormatTokensOr(200000, '200k', ON), '200k'); // limit 的 toFixed(0) legacy
  // 门控关:逐字节回退 call-site 传入的 legacy(各自规则,绝不串味)
  assert.equal(ccFormatTokensOr(45000, '45.0k', OFF), '45.0k');
  assert.equal(ccFormatTokensOr(1000000, '1000k', OFF), '1000k'); // toFixed(0) 旧 limit
  assert.equal(ccFormatTokensOr(500, '500', OFF), '500');
  // 非有限 → ccFormatTokens 产 '' → 回退 legacy(即便门控开)
  assert.equal(ccFormatTokensOr(NaN, 'fallback', ON), 'fallback');
  assert.equal(ccFormatTokensOr(Infinity, 'fallback', ON), 'fallback');
  // 默认门控(无 env)= 开
  const prev = process.env.KHY_CC_FORMAT;
  delete process.env.KHY_CC_FORMAT;
  try {
    assert.equal(ccFormatTokensOr(45000, '45.0k'), '45k');
  } finally {
    if (prev == null) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = prev;
  }
});

test('ccFormatDurationOr: 门控开 → ccFormatDuration(人读时长),门控关 → call-site legacy', () => {
  const ON = {};
  const OFF = { KHY_CC_FORMAT: 'off' };
  // 门控开:忽略 legacy,走 CC formatDuration(裸秒数被人读化)。
  assert.equal(ccFormatDurationOr(300000, '300s', ON), '5m 0s');       // 5 分钟会话
  assert.equal(ccFormatDurationOr(3600000, '3600s', ON), '1h 0m 0s');  // 1 小时会话
  assert.equal(ccFormatDurationOr(2000, '2s', ON), '2s');              // <60s 整秒
  assert.equal(ccFormatDurationOr(90000, '90s', ON), '1m 30s');
  // 门控关:逐字节回退 call-site 传入的 legacy(旧 `${toFixed(0)}s` 口径,绝不串味)。
  assert.equal(ccFormatDurationOr(300000, '300s', OFF), '300s');
  assert.equal(ccFormatDurationOr(3600000, '3600s', OFF), '3600s');
  // 非有限 → ccFormatDuration 产 '' → 回退 legacy(即便门控开)。
  assert.equal(ccFormatDurationOr(NaN, 'fallback', ON), 'fallback');
  assert.equal(ccFormatDurationOr(Infinity, 'fallback', ON), 'fallback');
  // options 透传(hideTrailingZeros)。
  assert.equal(ccFormatDurationOr(3600000, '3600s', ON, { hideTrailingZeros: true }), '1h');
  // 默认门控(无 env)= 开。
  const prev = process.env.KHY_CC_FORMAT;
  delete process.env.KHY_CC_FORMAT;
  try {
    assert.equal(ccFormatDurationOr(300000, '300s'), '5m 0s');
  } finally {
    if (prev == null) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = prev;
  }
});

test('绝不抛:畸形 / 非有限输入安全降级', () => {
  assert.equal(ccFormatDuration(NaN), '');
  assert.equal(ccFormatDuration(Infinity), '');
  assert.equal(ccFormatDuration('abc'), '');
  assert.equal(ccFormatNumber(NaN), '');
  assert.equal(ccFormatNumber(Infinity), '');
  assert.doesNotThrow(() => ccFormatDuration());
  assert.doesNotThrow(() => ccFormatTokens());
  assert.doesNotThrow(() => ccFormatTokens('xyz'));
});

test('ccFormatFileSize: CC formatFileSize 逐分支移植', () => {
  // <1KB → "${bytes} bytes"(小文件不塌成 0.0KB)
  assert.equal(ccFormatFileSize(0), '0 bytes');
  assert.equal(ccFormatFileSize(15), '15 bytes');
  assert.equal(ccFormatFileSize(1023), '1023 bytes');
  // <1MB → KB,去尾随 .0,无空格
  assert.equal(ccFormatFileSize(1024), '1KB');          // 1.0 → "1"
  assert.equal(ccFormatFileSize(1536), '1.5KB');        // 1.5
  assert.equal(ccFormatFileSize(100 * 1024), '100KB');
  assert.equal(ccFormatFileSize(250000), '244.1KB');
  // <1GB → MB
  assert.equal(ccFormatFileSize(1024 * 1024), '1MB');
  assert.equal(ccFormatFileSize(1024 * 1024 * 5.5), '5.5MB');
  // ≥1GB → GB
  assert.equal(ccFormatFileSize(1024 * 1024 * 1024), '1GB');
  assert.equal(ccFormatFileSize(1024 * 1024 * 1024 * 2.3), '2.3GB');
});

test('ccFormatFileSize: 非有限 / 负输入 → ""(绝不抛)', () => {
  assert.equal(ccFormatFileSize(NaN), '');
  assert.equal(ccFormatFileSize(Infinity), '');
  assert.equal(ccFormatFileSize(-1), '');
  assert.equal(ccFormatFileSize('abc'), '');
  assert.doesNotThrow(() => ccFormatFileSize());
});

test('ccRelativeAgeParts: CC 用 Math.trunc 截断(绝不进位 / 不 round)', () => {
  // 90s → minute, trunc(90/60)=1(legacy round(1.5)=2 是虚报)
  assert.deepEqual(ccRelativeAgeParts(90 * SEC), { value: 1, unit: 'minute', isPast: true });
  // 119s → 1 分钟(trunc(119/60)=1)
  assert.deepEqual(ccRelativeAgeParts(119 * SEC), { value: 1, unit: 'minute', isPast: true });
  // 23h59m → hour 档 23(legacy round 会进位成 1 天)
  assert.deepEqual(ccRelativeAgeParts(23 * HOUR + 59 * MIN), { value: 23, unit: 'hour', isPast: true });
  // 89 分钟 → 1 小时(trunc(89/60)=1)
  assert.deepEqual(ccRelativeAgeParts(89 * MIN), { value: 1, unit: 'hour', isPast: true });
});

test('ccRelativeAgeParts: 完整 year→second 区间表 + 标准日历阈值', () => {
  assert.deepEqual(ccRelativeAgeParts(0), { value: 0, unit: 'second', isPast: true });
  assert.deepEqual(ccRelativeAgeParts(5 * SEC), { value: 5, unit: 'second', isPast: true });
  assert.deepEqual(ccRelativeAgeParts(59 * SEC), { value: 59, unit: 'second', isPast: true });
  assert.deepEqual(ccRelativeAgeParts(MIN), { value: 1, unit: 'minute', isPast: true });
  assert.deepEqual(ccRelativeAgeParts(HOUR), { value: 1, unit: 'hour', isPast: true });
  assert.deepEqual(ccRelativeAgeParts(DAY), { value: 1, unit: 'day', isPast: true });   // day=24h 整
  assert.deepEqual(ccRelativeAgeParts(6 * DAY), { value: 6, unit: 'day', isPast: true });
  assert.deepEqual(ccRelativeAgeParts(WEEK), { value: 1, unit: 'week', isPast: true });  // week=7d
  assert.deepEqual(ccRelativeAgeParts(29 * DAY), { value: 4, unit: 'week', isPast: true }); // trunc(29*86400/604800)=4
  assert.deepEqual(ccRelativeAgeParts(30 * DAY), { value: 1, unit: 'month', isPast: true }); // month≈30d
  assert.deepEqual(ccRelativeAgeParts(365 * DAY), { value: 1, unit: 'year', isPast: true });
});

test('ccRelativeAgeParts: 未来(负 ageMs)→ isPast:false,绝对值同截断', () => {
  assert.deepEqual(ccRelativeAgeParts(-90 * SEC), { value: 1, unit: 'minute', isPast: false });
  assert.deepEqual(ccRelativeAgeParts(-2 * HOUR), { value: 2, unit: 'hour', isPast: false });
  // <1s 未来 → {0, second, isPast:false}
  assert.deepEqual(ccRelativeAgeParts(-500), { value: 0, unit: 'second', isPast: false });
});

test('ccRelativeAgeParts: <1s → 0s 档;非有限 → null(绝不抛)', () => {
  assert.deepEqual(ccRelativeAgeParts(500), { value: 0, unit: 'second', isPast: true });
  assert.equal(ccRelativeAgeParts(NaN), null);
  assert.equal(ccRelativeAgeParts(Infinity), null);
  assert.equal(ccRelativeAgeParts('abc'), null);
  assert.doesNotThrow(() => ccRelativeAgeParts());
});
