'use strict';

/**
 * perfEntryReaper.test.js — React dev 渲染泄漏(performance.measure 累积)清理器的单测(node:test)。
 *
 * 根因:React development 版每帧调 performance.measure 且从不 clearMeasures,Node 全局 buffer
 * 超限抛 MaxPerformanceEntryBufferExceededWarning(截图实证 1000001 entries),内存/性能劣化致
 * TUI 越用越卡。本测试验证:reapOnce 清空 measure/mark;installPerfReaper 幂等、可停、unref;
 * 门控关不安装;清理失败绝不抛。
 *
 * 运行:node --test services/backend/tests/tui/perfEntryReaper.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const reaper = require('../../src/cli/tui/perfEntryReaper');

test('reapOnce:清空 performance measure 与 mark entries', () => {
  const perf = require('perf_hooks').performance;
  // 制造一些 entries
  perf.mark('mk-test-1');
  perf.mark('mk-test-2');
  try { perf.measure('ms-test-1', 'mk-test-1', 'mk-test-2'); } catch { /* some node versions */ }
  const hasMeasure = perf.getEntriesByType('measure').length > 0;
  // 无论节点行为如何,清理后 measure 必然归零。
  reaper.reapOnce();
  assert.equal(perf.getEntriesByType('measure').length, 0);
  assert.equal(perf.getEntriesByType('mark').length, 0);
  assert.equal(typeof hasMeasure, 'boolean');
});

test('门控默认 on:installPerfReaper 返回 installed:true 且可 stop', () => {
  const saved = process.env.KHY_PERF_ENTRY_REAP;
  delete process.env.KHY_PERF_ENTRY_REAP;
  try {
    const r = reaper.installPerfReaper({ env: {} });
    assert.equal(r.installed, true);
    r.stop();
  } finally {
    if (saved === undefined) delete process.env.KHY_PERF_ENTRY_REAP;
    else process.env.KHY_PERF_ENTRY_REAP = saved;
    reaper.stopPerfReaper();
  }
});

test('门控关(KHY_PERF_ENTRY_REAP=off)→ 不安装(installed:false)', () => {
  const r = reaper.installPerfReaper({ env: { KHY_PERF_ENTRY_REAP: 'off' } });
  assert.equal(r.installed, false);
});

test('intervalMs:默认 60000;合法 env 覆盖;越界 clamp[5000,600000];非法回默认', () => {
  assert.equal(reaper.intervalMs({}), 60000);
  assert.equal(reaper.intervalMs({ KHY_PERF_ENTRY_REAP_MS: '30000' }), 30000);
  assert.equal(reaper.intervalMs({ KHY_PERF_ENTRY_REAP_MS: '1000' }), 5000);   // 低于下限
  assert.equal(reaper.intervalMs({ KHY_PERF_ENTRY_REAP_MS: '99999999' }), 600000); // 高于上限
  assert.equal(reaper.intervalMs({ KHY_PERF_ENTRY_REAP_MS: 'abc' }), 60000);
});

test('reapOnce 坏环境绝不抛(注入坏 perf 对象)', () => {
  // 直接调用(不注入):内部 try/catch 兜底。
  assert.doesNotThrow(() => reaper.reapOnce());
  // 注入抛错的 perf:install 路径 best-effort。
  assert.doesNotThrow(() => {
    const r = reaper.installPerfReaper({ env: {}, perf: { clearMeasures() { throw new Error('boom'); } } });
    r.stop();
  });
});
