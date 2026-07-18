'use strict';

// 对齐 CC「后端逻辑也对齐」:字节数 → 人类可读的**单一真源收敛**(剪贴板图片展示面)。
// 续 fileSizeSsot.test.js(health/storage)+ fileSizeMediaSsot.test.js(媒体/附件/归档)——
// 本测试覆盖此前仍各自发散的两个**图片大小展示**本地格式化器,验证它们也都路由到与 CC
// `src/utils/format.ts` `formatFileSize` 逐字节同口径的 ccFormat SSOT:
//   - repl.js._formatImageSize(「图片提示」剪贴板分析结果行,5 个 call-site,旧口径恒 KB
//     无 MB/GB 进位:5MB 图误显 "5120KB")
//   - imageService._imageSizeStr(printImagePreview 预览行,旧口径 2 分支 ≥1MB→"X.XMB"
//     否则 "XKB",无 bytes/GB 档)
// 门控 KHY_CC_FORMAT 开 → 两者都 === ccFormatFileSize;关 → 逐字节回退各自旧本地口径。
// 零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const { ccFormatFileSize } = require('../../src/cli/ccFormat');
const { _formatImageSize } = require('../../src/cli/repl');
const { _imageSizeStr } = require('../../src/services/imageService');

const ON = { KHY_CC_FORMAT: '1' };
const OFF = { KHY_CC_FORMAT: 'off' };
const POSITIVE = [800, 1024, 1536, 500000, 1024 * 1024, 1572864, 5 * 1024 * 1024, 1024 * 1024 * 1024];

// ── 门控开:两个 call-site 都与 CC formatFileSize 逐字节一致 ──────────────
test('repl._formatImageSize 门控开 = CC formatFileSize 逐字节同口径', () => {
  for (const n of POSITIVE) assert.strictEqual(_formatImageSize(n, ON), ccFormatFileSize(n), `bytes=${n}`);
});
test('imageService._imageSizeStr 门控开 = CC formatFileSize 逐字节同口径', () => {
  for (const n of POSITIVE) assert.strictEqual(_imageSizeStr(n, ON), ccFormatFileSize(n), `bytes=${n}`);
});

test('门控开:CC 口径具体形态(MB/GB 进位、bytes 词、去尾随 .0)两者一致', () => {
  for (const fn of [_formatImageSize, _imageSizeStr]) {
    assert.strictEqual(fn(800, ON), '800 bytes');             // <1KB → "N bytes"(旧口径会塌成 KB)
    assert.strictEqual(fn(1024, ON), '1KB');                  // 整 KB 去 .0,无空格
    assert.strictEqual(fn(1572864, ON), '1.5MB');             // 1.5MB 进位(旧 repl 显 "1536KB")
    assert.strictEqual(fn(5 * 1024 * 1024, ON), '5MB');       // 5MB(旧 repl 显 "5120KB")
    assert.strictEqual(fn(1024 * 1024 * 1024, ON), '1GB');    // GB 进位(旧两者都无 GB 档)
  }
});

// ── 门控关:各自逐字节回退本地旧口径(repl 恒 KB·imageService 2 分支)───────
test('repl._formatImageSize 门控关 = 历史 `(b/1024).toFixed(0)KB`(恒 KB 无进位)', () => {
  for (const off of [OFF, { KHY_CC_FORMAT: '0' }, { KHY_CC_FORMAT: 'no' }]) {
    assert.strictEqual(_formatImageSize(5 * 1024 * 1024, off), '5120KB'); // 旧:5MB 显 5120KB
    assert.strictEqual(_formatImageSize(1572864, off), '1536KB');        // 旧:1.5MB 显 1536KB
    assert.strictEqual(_formatImageSize(800, off), '1KB');               // 旧:800B 四舍五入 1KB
  }
});
test('imageService._imageSizeStr 门控关 = 历史 2 分支(≥1MB→X.XMB·否则 XKB)', () => {
  for (const off of [OFF, { KHY_CC_FORMAT: '0' }, { KHY_CC_FORMAT: 'no' }]) {
    assert.strictEqual(_imageSizeStr(5 * 1024 * 1024, off), '5.0MB');    // 旧:带尾随 .0
    assert.strictEqual(_imageSizeStr(500000, off), '488KB');            // 旧:<1MB 走 KB 分支
    assert.strictEqual(_imageSizeStr(800, off), '1KB');                 // 旧:无 bytes 档
  }
});

test('门控开 / 关唯一分歧 = SSOT 进位与 bytes 档(ASCII 数字两态一致由 ccFormat 保证)', () => {
  // 1.5MB:开 "1.5MB"(SSOT 进位)·关 repl "1536KB" / imageService "1.5MB"——锁定本刀修正点。
  assert.notStrictEqual(_formatImageSize(1572864, ON), _formatImageSize(1572864, OFF));
  assert.strictEqual(_formatImageSize(1572864, ON), '1.5MB');
  assert.strictEqual(_formatImageSize(1572864, OFF), '1536KB');
});
