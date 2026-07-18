'use strict';

// renderTheme._formatElapsed 时长显示一律走 ccFormatDuration SSOT 的契约测试。
// 对齐 CC src/utils/format.ts::formatDuration —— spinner(SpinnerAnimationRow)、
// step 行、task 面板共享这一格式器,CC 在 spinner 调 formatDuration() **无 options**
// (保留整分的 `0s`、滚动进 h/d)。Khy 历史 _formatElapsed **丢秒**(整分显 "2m")
// 且**无小时进位**(分钟无界增长 "123m 4s")。门控 KHY_CC_FORMAT 默认开 → ccFormatDuration
// (60s → "1m 0s"、3723s → "1h 2m 3s");关 → 逐字节回退本地旧口径。亚秒两态恒一致。
const test = require('node:test');
const assert = require('node:assert/strict');

const { _formatElapsed } = require('../../src/cli/renderTheme');
const { ccFormatDuration } = require('../../src/cli/ccFormat');

function withGate(value, fn) {
  const saved = process.env.KHY_CC_FORMAT;
  if (value === undefined) delete process.env.KHY_CC_FORMAT;
  else process.env.KHY_CC_FORMAT = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = saved;
  }
}

test('门控开(默认):整分保留 0s,非整分带空格(对齐 CC formatDuration 无 options)', () => {
  withGate(undefined, () => {
    assert.equal(_formatElapsed(60), '1m 0s');   // 旧口径丢秒显 "1m"
    assert.equal(_formatElapsed(120), '2m 0s');  // 旧口径 "2m"
    assert.equal(_formatElapsed(135), '2m 15s'); // 非整分两态一致
  });
});

test('门控开:≥1h 滚动进小时/天(旧口径分钟无界增长)', () => {
  withGate(undefined, () => {
    assert.equal(_formatElapsed(3600), '1h 0m 0s');  // 旧口径 "60m"
    assert.equal(_formatElapsed(3723), '1h 2m 3s');  // 旧口径 "62m 3s"
    assert.equal(_formatElapsed(7384), '2h 3m 4s');  // 旧口径 "123m 4s"
  });
});

test('门控开:亚秒(<60s)与 legacy floor 逐字节一致', () => {
  withGate(undefined, () => {
    assert.equal(_formatElapsed(0), '0s');
    assert.equal(_formatElapsed(5), '5s');
    assert.equal(_formatElapsed(59), '59s');
    assert.equal(_formatElapsed(5.9), '5s'); // 先 floor
  });
});

test('门控开:与 ccFormatDuration(sec*1000) SSOT 逐项一致', () => {
  withGate(undefined, () => {
    for (const sec of [0, 5, 59, 60, 120, 135, 3600, 3723, 7384, 90061]) {
      assert.equal(_formatElapsed(sec), ccFormatDuration(sec * 1000));
    }
  });
});

test('门控关:逐字节回退本地旧口径(丢秒 + 无小时进位)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withGate(off, () => {
      assert.equal(_formatElapsed(60), '1m');      // 丢 0s
      assert.equal(_formatElapsed(120), '2m');
      assert.equal(_formatElapsed(3600), '60m');   // 无小时进位
      assert.equal(_formatElapsed(3723), '62m 3s');
      assert.equal(_formatElapsed(7384), '123m 4s');
      // 亚秒/非整分仍与门控开一致(发散只在整分丢秒与小时进位)
      assert.equal(_formatElapsed(5), '5s');
      assert.equal(_formatElapsed(135), '2m 15s');
    });
  }
});

test('唯一发散点:整分(0s)与 ≥1h 进位;其余两态字节一致', () => {
  const probe = [0, 1, 5, 59, 61, 135, 3661];
  for (const sec of probe) {
    const on = withGate(undefined, () => _formatElapsed(sec));
    const off = withGate('0', () => _formatElapsed(sec));
    // 61s → on "1m 1s" / off "1m 1s"(rem≠0 一致);3661s → on "1h 1m 1s" / off "61m 1s"(发散)
    if (sec === 3661) assert.notEqual(on, off);
    else assert.equal(on, off);
  }
});
