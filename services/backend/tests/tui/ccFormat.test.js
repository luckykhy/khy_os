'use strict';
/**
 * ccFormat 纯叶子单测(node:test)。
 *
 * 验证 Claude Code 源 `src/utils/format.ts` 的 formatDuration / formatNumber /
 * formatTokens **逐分支移植正确**——这是「不只显示对齐、后端逻辑也对齐」的核心:
 * Khy 屏幕上的时长 / token 串必须是 CC 同一套算法的输出。
 */
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
test('ccFormatDuration: 分/时档("Mm Ss" 空格 + 保留 0 秒 + 进位)', () => {
  expect(ccFormatDuration(60000)).toBe('1m 0s');
  expect(ccFormatDuration(90000)).toBe('1m 30s');
  expect(ccFormatDuration(90500)).toBe('1m 31s'); // round((90500%60000)/1000)=round(30.5)=31
  expect(ccFormatDuration(119500)).toBe('2m 0s'); // 59.5s round→60 进位到分钟
  expect(ccFormatDuration(3600000)).toBe('1h 0m 0s');
  expect(ccFormatDuration(3661000)).toBe('1h 1m 1s');
});
test('ccFormatFileSize: 非有限 / 负输入 → ""(绝不抛)', () => {
  expect(ccFormatFileSize(NaN)).toBe('');
  expect(ccFormatFileSize(Infinity)).toBe('');
  expect(ccFormatFileSize(-1)).toBe('');
  expect(ccFormatFileSize('abc')).toBe('');
  expect(() => ccFormatFileSize()).not.toThrow();
});

describe('Cc Format', () => {
  test('ccFormatEnabled: 默认开 / 关 token', () => {
      expect(ccFormatEnabled({})).toBe(true);
      expect(ccFormatEnabled({ KHY_CC_FORMAT: '' })).toBe(true);
      expect(ccFormatEnabled({ KHY_CC_FORMAT: 'on' })).toBe(true);
      for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(ccFormatEnabled({ KHY_CC_FORMAT: off })).toBe(false);
      }
  });

  test('ccFormatDuration: 秒档(CC floor + 0s 特例)', () => {
      expect(ccFormatDuration(0)).toBe('0s');
      expect(ccFormatDuration(400)).toBe('0s');
      expect(ccFormatDuration(1000)).toBe('1s');
      expect(ccFormatDuration(7000)).toBe('7s');
      expect(ccFormatDuration(7800)).toBe('7s'); // floor,不是 round
      expect(ccFormatDuration(59000)).toBe('59s');
      expect(ccFormatDuration(59500)).toBe('59s'); // <60000 仍 floor
  });

  test('ccFormatDuration: mostSignificantOnly / hideTrailingZeros', () => {
      expect(ccFormatDuration(3661000, { mostSignificantOnly: true })).toBe('1h');
      expect(ccFormatDuration(90000, { mostSignificantOnly: true })).toBe('1m');
      expect(ccFormatDuration(7000, { mostSignificantOnly: true })).toBe('7s');
      expect(ccFormatDuration(3600000, { hideTrailingZeros: true })).toBe('1h');
      expect(ccFormatDuration(60000, { hideTrailingZeros: true })).toBe('1m');
  });

  test('ccFormatNumber: Intl 紧凑记数 + 小写', () => {
      expect(ccFormatNumber(42)).toBe('42');
      expect(ccFormatNumber(900)).toBe('900');
      expect(ccFormatNumber(999)).toBe('999');
      expect(ccFormatNumber(1000)).toBe('1.0k');
      expect(ccFormatNumber(1234)).toBe('1.2k');
      expect(ccFormatNumber(12500)).toBe('12.5k');
      expect(ccFormatNumber(123456)).toBe('123.5k');
      expect(ccFormatNumber(1000000)).toBe('1.0m');
  });

  test('ccFormatTokens: 去尾随 .0', () => {
      expect(ccFormatTokens(42)).toBe('42');
      expect(ccFormatTokens(999)).toBe('999');
      expect(ccFormatTokens(1000)).toBe('1k'); // "1.0k" → "1k"
      expect(ccFormatTokens(1234)).toBe('1.2k');
      expect(ccFormatTokens(12500)).toBe('12.5k');
      expect(ccFormatTokens(123456)).toBe('123.5k');
      expect(ccFormatTokens(1000000)).toBe('1m');
  });

  test('ccFormatTokensOr: 门控开 → ccFormatTokens(裸数字),门控关 → call-site legacy', () => {
      const ON = {};
      const OFF = { KHY_CC_FORMAT: 'off' };
      // 门控开:忽略 legacy,走紧凑记数
      expect(ccFormatTokensOr(45000, '45.0k', ON)).toBe('45k');
      expect(ccFormatTokensOr(128000, '128.0k', ON)).toBe('128k');
      expect(ccFormatTokensOr(1500000, '1500.0k', ON)).toBe('1.5m');
      expect(ccFormatTokensOr(200000, '200k', ON)).toBe('200k'); // limit 的 toFixed(0) legacy
      // 门控关:逐字节回退 call-site 传入的 legacy(各自规则,绝不串味)
      expect(ccFormatTokensOr(45000, '45.0k', OFF)).toBe('45.0k');
      expect(ccFormatTokensOr(1000000, '1000k', OFF)).toBe('1000k'); // toFixed(0) 旧 limit
      expect(ccFormatTokensOr(500, '500', OFF)).toBe('500');
      // 非有限 → ccFormatTokens 产 '' → 回退 legacy(即便门控开)
      expect(ccFormatTokensOr(NaN, 'fallback', ON)).toBe('fallback');
      expect(ccFormatTokensOr(Infinity, 'fallback', ON)).toBe('fallback');
      // 默认门控(无 env)= 开
      const prev = process.env.KHY_CC_FORMAT;
      delete process.env.KHY_CC_FORMAT;
      try {
        expect(ccFormatTokensOr(45000, '45.0k')).toBe('45k');
      } finally {
        if (prev == null) delete process.env.KHY_CC_FORMAT;
        else process.env.KHY_CC_FORMAT = prev;
      }
  });

  test('ccFormatDurationOr: 门控开 → ccFormatDuration(人读时长),门控关 → call-site legacy', () => {
      const ON = {};
      const OFF = { KHY_CC_FORMAT: 'off' };
      // 门控开:忽略 legacy,走 CC formatDuration(裸秒数被人读化)。
      expect(ccFormatDurationOr(300000, '300s', ON)).toBe('5m 0s');       // 5 分钟会话
      expect(ccFormatDurationOr(3600000, '3600s', ON)).toBe('1h 0m 0s');  // 1 小时会话
      expect(ccFormatDurationOr(2000, '2s', ON)).toBe('2s');              // <60s 整秒
      expect(ccFormatDurationOr(90000, '90s', ON)).toBe('1m 30s');
      // 门控关:逐字节回退 call-site 传入的 legacy(旧 `${toFixed(0)}s` 口径,绝不串味)。
      expect(ccFormatDurationOr(300000, '300s', OFF)).toBe('300s');
      expect(ccFormatDurationOr(3600000, '3600s', OFF)).toBe('3600s');
      // 非有限 → ccFormatDuration 产 '' → 回退 legacy(即便门控开)。
      expect(ccFormatDurationOr(NaN, 'fallback', ON)).toBe('fallback');
      expect(ccFormatDurationOr(Infinity, 'fallback', ON)).toBe('fallback');
      // options 透传(hideTrailingZeros)。
      expect(ccFormatDurationOr(3600000, '3600s', ON, { hideTrailingZeros: true })).toBe('1h');
      // 默认门控(无 env)= 开。
      const prev = process.env.KHY_CC_FORMAT;
      delete process.env.KHY_CC_FORMAT;
      try {
        expect(ccFormatDurationOr(300000, '300s')).toBe('5m 0s');
      } finally {
        if (prev == null) delete process.env.KHY_CC_FORMAT;
        else process.env.KHY_CC_FORMAT = prev;
      }
  });

  test('绝不抛:畸形 / 非有限输入安全降级', () => {
      expect(ccFormatDuration(NaN)).toBe('');
      expect(ccFormatDuration(Infinity)).toBe('');
      expect(ccFormatDuration('abc')).toBe('');
      expect(ccFormatNumber(NaN)).toBe('');
      expect(ccFormatNumber(Infinity)).toBe('');
      expect(() => ccFormatDuration().not.toThrow());
      expect(() => ccFormatTokens().not.toThrow());
      expect(() => ccFormatTokens('xyz').not.toThrow());
  });

  test('ccFormatFileSize: CC formatFileSize 逐分支移植', () => {
      // <1KB → "${bytes} bytes"(小文件不塌成 0.0KB)
      expect(ccFormatFileSize(0)).toBe('0 bytes');
      expect(ccFormatFileSize(15)).toBe('15 bytes');
      expect(ccFormatFileSize(1023)).toBe('1023 bytes');
      // <1MB → KB,去尾随 .0,无空格
      expect(ccFormatFileSize(1024)).toBe('1KB');          // 1.0 → "1"
      expect(ccFormatFileSize(1536)).toBe('1.5KB');        // 1.5
      expect(ccFormatFileSize(100 * 1024)).toBe('100KB');
      expect(ccFormatFileSize(250000)).toBe('244.1KB');
      // <1GB → MB
      expect(ccFormatFileSize(1024 * 1024)).toBe('1MB');
      expect(ccFormatFileSize(1024 * 1024 * 5.5)).toBe('5.5MB');
      // ≥1GB → GB
      expect(ccFormatFileSize(1024 * 1024 * 1024)).toBe('1GB');
      expect(ccFormatFileSize(1024 * 1024 * 1024 * 2.3)).toBe('2.3GB');
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
      expect(ccRelativeAgeParts(NaN)).toBe(null);
      expect(ccRelativeAgeParts(Infinity)).toBe(null);
      expect(ccRelativeAgeParts('abc')).toBe(null);
      expect(() => ccRelativeAgeParts().not.toThrow());
  });

});
