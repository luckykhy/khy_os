'use strict';

/**
 * diskCleanupClarify.test.js — 「清盘前让用户选扫描深度/颗粒细度」纯叶子单测(node:test)。
 *
 * 覆盖:门控、意图检测(清理动作+磁盘目标须同现)、routeDiskCleanupClarify(need→指令/否→null)、
 * 指令内容契约(含两维度+推荐档说明+参数映射)、resolveScanDepth(档/数字/缺省 null)、
 * resolveGranularity、shapeScanCandidates(coarse 汇总 / fine 体积降序 / standard 原引用)、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const dc = require('../../src/services/diskCleanupClarify');

test('isEnabled: 默认开,仅显式 falsy 关', () => {
  assert.equal(dc.isEnabled({}), true);
  assert.equal(dc.isEnabled({ KHY_DISK_CLEANUP_CLARIFY: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(dc.isEnabled({ KHY_DISK_CLEANUP_CLARIFY: off }), false, off);
  }
});

test('detectDiskCleanupIntent: 清理动作 + 磁盘目标须同现', () => {
  assert.equal(dc.detectDiskCleanupIntent('帮我清理一下C盘'), true);
  assert.equal(dc.detectDiskCleanupIntent('清理 D盘 空间'), true);
  assert.equal(dc.detectDiskCleanupIntent('清一下磁盘垃圾'), true);
  assert.equal(dc.detectDiskCleanupIntent('clean up my C: drive'), true);
  assert.equal(dc.detectDiskCleanupIntent('腾出空间 硬盘'), true);
  // 只有动作、没有磁盘目标 → 不触发
  assert.equal(dc.detectDiskCleanupIntent('清理一下代码'), false);
  // 只有磁盘、没有清理动作 → 不触发
  assert.equal(dc.detectDiskCleanupIntent('看看C盘还有多少空间'), false);
  assert.equal(dc.detectDiskCleanupIntent(''), false);
  assert.equal(dc.detectDiskCleanupIntent(null), false);
});

test('routeDiskCleanupClarify: need 时给指令,否则 null', () => {
  const on = dc.routeDiskCleanupClarify({ text: '清理C盘', env: {} });
  assert.equal(on.need, true);
  assert.equal(typeof on.directive, 'string');
  assert.ok(on.directive.length > 0);

  // 无意图 → null
  const noIntent = dc.routeDiskCleanupClarify({ text: '你好', env: {} });
  assert.equal(noIntent.need, false);
  assert.equal(noIntent.directive, null);

  // 门控关 → null(即便有意图)
  const off = dc.routeDiskCleanupClarify({ text: '清理C盘', env: { KHY_DISK_CLEANUP_CLARIFY: '0' } });
  assert.equal(off.need, false);
  assert.equal(off.directive, null);

  // options 覆盖
  const optOff = dc.routeDiskCleanupClarify({ text: '清理C盘', options: { diskCleanupClarify: 'off' } });
  assert.equal(optOff.directive, null);
});

test('buildDiskCleanupDirective: 含两维度 + AskUserQuestion + 推荐 + 参数映射', () => {
  const d = dc.buildDiskCleanupDirective();
  assert.match(d, /扫描深度/);
  assert.match(d, /颗粒细度/);
  assert.match(d, /AskUserQuestion/);
  assert.match(d, /推荐/);
  assert.match(d, /maxDepth/);
  assert.match(d, /granularity/);
});

test('resolveScanDepth: 数字优先 → 钳位;否则档位;否则 null', () => {
  assert.equal(dc.resolveScanDepth({ maxDepth: 8 }), 8);
  assert.equal(dc.resolveScanDepth({ maxDepth: 999 }), dc.DEPTH_MAX);
  assert.equal(dc.resolveScanDepth({ maxDepth: 0 }), dc.DEPTH_MIN);
  assert.equal(dc.resolveScanDepth({ scanDepth: 'shallow' }), 2);
  assert.equal(dc.resolveScanDepth({ scanDepth: 'standard' }), 6);
  assert.equal(dc.resolveScanDepth({ scanDepth: 'deep' }), 12);
  // maxDepth 优先于 scanDepth
  assert.equal(dc.resolveScanDepth({ maxDepth: 3, scanDepth: 'deep' }), 3);
  // 缺省 / 非法 → null(scanner 回退全局阈值)
  assert.equal(dc.resolveScanDepth({}), null);
  assert.equal(dc.resolveScanDepth({ scanDepth: 'bogus' }), null);
  assert.equal(dc.resolveScanDepth(null), null);
});

test('resolveGranularity: 合法值透传,否则 standard', () => {
  assert.equal(dc.resolveGranularity({ granularity: 'coarse' }), 'coarse');
  assert.equal(dc.resolveGranularity({ granularity: 'fine' }), 'fine');
  assert.equal(dc.resolveGranularity({ granularity: 'STANDARD' }), 'standard');
  assert.equal(dc.resolveGranularity({ granularity: 'bogus' }), 'standard');
  assert.equal(dc.resolveGranularity({}), 'standard');
});

test('shapeScanCandidates: coarse 按大类汇总', () => {
  const cands = [
    { category: 'pkg-cache', sizeBytes: 100, fileCount: 3, eligible: true },
    { category: 'pkg-cache', sizeBytes: 50, fileCount: 2, eligible: false },
    { category: 'browser-cache', sizeBytes: 200, fileCount: 5, eligible: true },
  ];
  const out = dc.shapeScanCandidates(cands, 'coarse');
  assert.equal(out.rolledUp, true);
  assert.equal(out.granularity, 'coarse');
  // 按 sizeBytes 降序 → browser-cache(200) 在前
  assert.equal(out.rows[0].category, 'browser-cache');
  assert.equal(out.rows[0].sizeBytes, 200);
  const pkg = out.rows.find((r) => r.category === 'pkg-cache');
  assert.equal(pkg.entryCount, 2);
  assert.equal(pkg.sizeBytes, 150);
  assert.equal(pkg.fileCount, 5);
  assert.equal(pkg.eligibleCount, 1);
});

test('shapeScanCandidates: fine 按体积降序(稳定),standard 原引用', () => {
  const cands = [
    { label: 'a', sizeBytes: 10 },
    { label: 'b', sizeBytes: 300 },
    { label: 'c', sizeBytes: 300 },
    { label: 'd', sizeBytes: 50 },
  ];
  const fine = dc.shapeScanCandidates(cands, 'fine');
  assert.equal(fine.rolledUp, false);
  assert.deepEqual(fine.rows.map((r) => r.label), ['b', 'c', 'd', 'a']); // 300,300 稳定保序

  const std = dc.shapeScanCandidates(cands, 'standard');
  assert.strictEqual(std.rows, cands); // 原引用逐字节等价
});

test('绝不抛:畸形输入 fail-soft', () => {
  assert.doesNotThrow(() => dc.shapeScanCandidates(null, 'coarse'));
  assert.doesNotThrow(() => dc.shapeScanCandidates(undefined, 'fine'));
  assert.doesNotThrow(() => dc.detectDiskCleanupIntent(12345));
  assert.equal(dc.shapeScanCandidates(null, 'coarse').rows.length, 0);
});
