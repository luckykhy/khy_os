'use strict';

// heapDump 纯叶子契约测试(对齐 CC /heapdump 背后逻辑:dump id / 诊断对象 / 措辞)。
// 零网络零真快照 —— 只验纯函数,注入 now/sessionId/采集量。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/heapDump');

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled({ KHY_HEAPDUMP: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_HEAPDUMP: off }), false, `应关: ${off}`);
  }
});

test('_timestampSlug:epoch → 文件名安全(无冒号无点)', () => {
  const slug = leaf._timestampSlug(0);
  assert.strictEqual(slug, '1970-01-01T00-00-00-000Z');
  assert.ok(!/[:.]/.test(slug), '不含冒号/点');
  // 非数 / 负 → 退化为 0,绝不抛
  assert.strictEqual(leaf._timestampSlug('garbage'), '1970-01-01T00-00-00-000Z');
  assert.strictEqual(leaf._timestampSlug(-5), '1970-01-01T00-00-00-000Z');
});

test('buildDumpId:带 sessionId → heap-<slug>-<short8>;缺失 → heap-<slug>', () => {
  const withSid = leaf.buildDumpId(0, 'abcdef0123456789');
  assert.strictEqual(withSid, 'heap-1970-01-01T00-00-00-000Z-abcdef01', '截 8 位');
  assert.strictEqual(leaf.buildDumpId(0, ''), 'heap-1970-01-01T00-00-00-000Z');
  assert.strictEqual(leaf.buildDumpId(0, null), 'heap-1970-01-01T00-00-00-000Z');
  // 非法字符被剔除
  assert.strictEqual(leaf.buildDumpId(0, 'a/b\\c.d'), 'heap-1970-01-01T00-00-00-000Z-abcd');
});

test('buildDiagnostics:对齐 CC 字段子集,trigger=manual,dumpNumber=0', () => {
  const d = leaf.buildDiagnostics({
    now: 0,
    sessionId: 'sess-1',
    uptimeSeconds: 12.5,
    memoryUsage: { heapUsed: 100, heapTotal: 200, external: 30, arrayBuffers: 5, rss: 500 },
    heapStats: {
      heap_size_limit: 4096,
      malloced_memory: 10,
      peak_malloced_memory: 20,
      number_of_detached_contexts: 2,
      number_of_native_contexts: 3,
    },
    heapSpaces: [{ space_name: 'old_space', space_size: 1000, space_used_size: 600, space_available_size: 400 }],
  });
  assert.strictEqual(d.trigger, 'manual');
  assert.strictEqual(d.dumpNumber, 0);
  assert.strictEqual(d.sessionId, 'sess-1');
  assert.strictEqual(d.timestamp, '1970-01-01T00:00:00.000Z');
  assert.strictEqual(d.uptimeSeconds, 12.5);
  assert.deepStrictEqual(d.memoryUsage, { heapUsed: 100, heapTotal: 200, external: 30, arrayBuffers: 5, rss: 500 });
  assert.strictEqual(d.v8HeapStats.heapSizeLimit, 4096);
  assert.strictEqual(d.v8HeapStats.detachedContexts, 2, 'detachedContexts 是关键泄漏指标');
  assert.strictEqual(d.v8HeapSpaces.length, 1);
  assert.deepStrictEqual(d.v8HeapSpaces[0], { name: 'old_space', size: 1000, used: 600, available: 400 });
});

test('buildDiagnostics:缺失/非数字段 → 守卫为 0,绝不抛/NaN', () => {
  const d = leaf.buildDiagnostics({});
  assert.strictEqual(d.memoryUsage.heapUsed, 0);
  assert.strictEqual(d.v8HeapStats.heapSizeLimit, 0);
  assert.deepStrictEqual(d.v8HeapSpaces, []);
  assert.strictEqual(d.sessionId, '');
  // NaN 不应泄漏
  for (const v of Object.values(d.memoryUsage)) assert.ok(Number.isFinite(v));
});

test('formatResult:含两路径 + 摘要 + DevTools 提示', () => {
  const out = leaf.formatResult({
    heapPath: '/data/heapdump/heap-x.heapsnapshot',
    diagPath: '/data/heapdump/heap-x.json',
    diagnostics: { memoryUsage: { heapUsed: 1048576, rss: 2097152, external: 0 } },
  });
  assert.match(out, /heap-x\.heapsnapshot/);
  assert.match(out, /heap-x\.json/);
  assert.match(out, /heapUsed 1\.0 MB/);
  assert.match(out, /DevTools/);
});

test('formatError:措辞含原因', () => {
  assert.match(leaf.formatError('disk full'), /生成堆快照失败.*disk full/);
  assert.match(leaf.formatError(null), /生成堆快照失败/);
});
