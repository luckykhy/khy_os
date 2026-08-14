'use strict';

// 对齐 CC「后端逻辑也对齐」:字节数 → 人类可读的**单一真源收敛**(媒体 / 附件 / 归档展示面)。
// 续 tests/cli/handlers/fileSizeSsot.test.js(health/storage 两 call-site)——本测试覆盖
// 此前仍各自发散的三个**媒体 / 附件 / 归档大小展示**本地格式化器,验证它们也都路由到
// 与 CC `src/utils/format.ts` `formatFileSize` 逐字节同口径的 ccFormat SSOT:
//   - multimodalInputService._formatBytes(媒体清单行,旧口径 KB 用 Math.round 无小数)
//   - aiUploadStore.humanSize(附件提示块,旧口径带空格 " KB"/GB 两位小数)
//   - archiveManifestPolicy._formatBytes(归档条目,旧口径带空格 " KB")
// 门控 KHY_CC_FORMAT 开 → 三者都 === ccFormatFileSize;关 → 逐字节回退各自旧本地口径。
const test = require('node:test');
const assert = require('node:assert');

const { ccFormatFileSize } = require('../../src/cli/ccFormat');
const { _formatBytes: mmBytes } = require('../../src/services/multimodalInputService');
const { humanSize: uploadHuman } = require('../../src/services/aiUploadStore');
const { _formatBytes: archiveBytes } = require('../../src/services/archiveManifestPolicy');

const ON = { KHY_CC_FORMAT: '1' };
const OFF = { KHY_CC_FORMAT: 'off' };
const POSITIVE = [1, 512, 1023, 1024, 1536, 1024 * 1024, 5 * 1024 * 1024, 1024 * 1024 * 1024, 3 * 1024 * 1024 * 1024];

// ── 门控开:三个 call-site 都与 CC formatFileSize 逐字节一致 ──────────────
test('multimodalInputService._formatBytes 门控开 = CC formatFileSize 逐字节同口径', () => {
  for (const n of POSITIVE) assert.strictEqual(mmBytes(n, ON), ccFormatFileSize(n), `bytes=${n}`);
});
test('aiUploadStore.humanSize 门控开 = CC formatFileSize 逐字节同口径', () => {
  for (const n of POSITIVE) assert.strictEqual(uploadHuman(n, ON), ccFormatFileSize(n), `bytes=${n}`);
});
test('archiveManifestPolicy._formatBytes 门控开 = CC formatFileSize 逐字节同口径', () => {
  for (const n of POSITIVE) assert.strictEqual(archiveBytes(n, ON), ccFormatFileSize(n), `bytes=${n}`);
});

test('门控开:CC 口径具体形态(无空格 / "bytes" 词 / 去尾随 .0 / GB 进位)三者一致', () => {
  for (const fn of [mmBytes, uploadHuman, archiveBytes]) {
    assert.strictEqual(fn(512, ON), '512 bytes');               // <1KB → "N bytes"
    assert.strictEqual(fn(1024, ON), '1KB');                     // 整数 KB 去 .0,无空格
    assert.strictEqual(fn(1536, ON), '1.5KB');                   // 1 位小数,无空格
    assert.strictEqual(fn(5 * 1024 * 1024, ON), '5MB');          // MB 进位
    assert.strictEqual(fn(2 * 1024 * 1024 * 1024, ON), '2GB');   // GB 进位
    assert.strictEqual(fn(0, ON), '0 bytes');                    // 0 → "0 bytes"(kb<1)
  }
});

// ── 门控关:逐字节回退各自的旧本地口径(三者历史输出彼此不同,正是本刀消除的发散)──
test('multimodalInputService._formatBytes 门控关 = 旧本地口径(0B / KB 用 Math.round 无小数)', () => {
  assert.strictEqual(mmBytes(0, OFF), '0B');
  assert.strictEqual(mmBytes(-5, OFF), '0B');                    // n<=0
  assert.strictEqual(mmBytes(1536, OFF), '2KB');                 // Math.round(1.5)=2,无小数
  assert.strictEqual(mmBytes(5 * 1024 * 1024, OFF), '5.0MB');    // .toFixed(1) 保留 .0
});
test('aiUploadStore.humanSize 门控关 = 旧本地口径(带空格、GB 两位小数)', () => {
  assert.strictEqual(uploadHuman(512, OFF), '512 B');
  assert.strictEqual(uploadHuman(1536, OFF), '1.5 KB');         // 带空格,保留 .5
  assert.strictEqual(uploadHuman(2 * 1024 * 1024 * 1024, OFF), '2.00 GB'); // GB 两位小数
});
test('archiveManifestPolicy._formatBytes 门控关 = 旧本地口径(带空格、GB 一位小数)', () => {
  assert.strictEqual(archiveBytes(512, OFF), '512 B');
  assert.strictEqual(archiveBytes(1536, OFF), '1.5 KB');
  assert.strictEqual(archiveBytes(2 * 1024 * 1024 * 1024, OFF), '2.0 GB'); // GB 一位小数
});

// ── 边界:负数 → ccFormatFileSize 返 '' → 即便门控开也 fall-through 到旧口径(诚实不编造)──
test('负字节数:门控开也回退旧口径(ccFormatFileSize 返空串触发 fall-through)', () => {
  assert.strictEqual(mmBytes(-5, ON), '0B');                     // 与 OFF 一致
  assert.strictEqual(uploadHuman(-5, ON), '-5 B');
  assert.strictEqual(archiveBytes(-5, ON), '-5 B');
});

// ── 门控关默认即字节回退(无 env 时取 process.env,本测试显式传 env 以确定性隔离)──
test('门控关三者输出彼此发散 = 本刀消除的真实分歧(同一 1536 字节)', () => {
  assert.strictEqual(mmBytes(1536, OFF), '2KB');     // ← 三种历史口径互不相同
  assert.strictEqual(uploadHuman(1536, OFF), '1.5 KB');
  assert.strictEqual(archiveBytes(1536, OFF), '1.5 KB');
  // 门控开则三者统一
  assert.strictEqual(mmBytes(1536, ON), uploadHuman(1536, ON));
  assert.strictEqual(uploadHuman(1536, ON), archiveBytes(1536, ON));
});
