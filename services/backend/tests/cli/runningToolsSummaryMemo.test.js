'use strict';

/**
 * runningToolsSummaryMemo 单测。
 *
 * 覆盖:
 *  - isEnabled:default-on + CANON off-words。
 *  - classifyTool:同 tool 对象二次调用命中缓存(分类器只跑一次)· 门控关每次现算 · 非对象直算 ·
 *    分类器抛错 → 'other' · running→done 转变后分类不变(缓存不陈旧)。
 *  - summarizeRunning:非数组 → {} · 仅统计在跑 · 按注入分类器归类 · 与历史内联实现逐字节等价 ·
 *    分类经对象身份记忆(重复帧分类器调用数不随帧数线性增长)。
 *  - LIVE wiring:statusBroadcast.js 经 runningToolsSummaryMemo.summarizeRunning + 内联历史回退。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/tui/ink-components/runningToolsSummaryMemo');

// 简化分类器(计数调用次数,验证记忆生效)。
function makeClassifier() {
  let calls = 0;
  const fn = (name) => {
    calls++;
    const n = String(name || '').toLowerCase();
    if (n.includes('read')) return 'read';
    if (n.includes('search') || n.includes('grep')) return 'search';
    if (n.includes('bash') || n.includes('exec')) return 'command';
    return 'other';
  };
  fn.calls = () => calls;
  return fn;
}

const isRunning = (t) => !!t && !t.result;
const toolName = (t) => (t && (t.name || t.toolName)) || '';

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_RUNNING_TOOLS_SUMMARY_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isEnabled({ KHY_RUNNING_TOOLS_SUMMARY_MEMO: off }), false, `off=${off}`);
  }
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('classifyTool: caches by tool identity (classifier runs once)', () => {
  const cls = makeClassifier();
  const t = { name: 'readFile' };
  assert.equal(memo.classifyTool(t, 'readFile', cls, {}), 'read');
  assert.equal(memo.classifyTool(t, 'readFile', cls, {}), 'read');
  assert.equal(memo.classifyTool(t, 'readFile', cls, {}), 'read');
  assert.equal(cls.calls(), 1, 'classifier invoked once for a stable tool object');
});

test('classifyTool: gate off → classifies every time (no cache)', () => {
  const cls = makeClassifier();
  const off = { KHY_RUNNING_TOOLS_SUMMARY_MEMO: 'off' };
  const t = { name: 'grep' };
  memo.classifyTool(t, 'grep', cls, off);
  memo.classifyTool(t, 'grep', cls, off);
  assert.equal(cls.calls(), 2, 'no caching when gated off');
});

test('classifyTool: non-object key → direct classify', () => {
  const cls = makeClassifier();
  assert.equal(memo.classifyTool(null, 'readFile', cls, {}), 'read');
  assert.equal(memo.classifyTool(undefined, 'grep', cls, {}), 'search');
});

test('classifyTool: classifier throws → other', () => {
  const boom = () => { throw new Error('boom'); };
  assert.equal(memo.classifyTool({ name: 'x' }, 'x', boom, {}), 'other');
});

test('classifyTool: running→done transition keeps cached class (not stale)', () => {
  const cls = makeClassifier();
  const t = { name: 'bashRun' }; // running (no result)
  assert.equal(memo.classifyTool(t, 'bashRun', cls, {}), 'command');
  t.result = { ok: true }; // transitions to done — class is independent of running-state
  assert.equal(memo.classifyTool(t, 'bashRun', cls, {}), 'command');
  assert.equal(cls.calls(), 1, 'class cached across running→done transition');
});

test('summarizeRunning: non-array → empty counts', () => {
  const cls = makeClassifier();
  assert.deepEqual({ ...memo.summarizeRunning(null, isRunning, toolName, cls, {}) }, {});
  assert.deepEqual({ ...memo.summarizeRunning(undefined, isRunning, toolName, cls, {}) }, {});
});

test('summarizeRunning: counts only running, grouped by injected classifier', () => {
  const cls = makeClassifier();
  const tools = [
    { name: 'readFile' },                     // running, read
    { name: 'readFile', result: { ok: 1 } },  // done → excluded
    { name: 'grep' },                         // running, search
    { name: 'bashRun' },                      // running, command
    { name: 'readAgain' },                    // running, read
  ];
  const counts = memo.summarizeRunning(tools, isRunning, toolName, cls, {});
  assert.equal(counts.read, 2);
  assert.equal(counts.search, 1);
  assert.equal(counts.command, 1);
  assert.equal(counts.other, undefined);
});

test('summarizeRunning: byte-identical to historical inline impl', () => {
  const cls = makeClassifier();
  // historical inline reference
  const refImpl = (tools) => {
    const list = Array.isArray(tools) ? tools.filter(isRunning) : [];
    const c = Object.create(null);
    for (const t of list) {
      const cat = cls(toolName(t));
      c[cat] = (c[cat] || 0) + 1;
    }
    return c;
  };
  const shapes = [
    [],
    [{ name: 'readFile' }],
    [{ name: 'grep' }, { name: 'grep', result: 1 }, { name: 'bash' }],
    [{ toolName: 'searchCode' }, { name: 'weird' }, { name: 'readX' }],
    [{ result: 1 }, { result: 1 }], // all done
  ];
  for (const s of shapes) {
    const got = memo.summarizeRunning(s, isRunning, toolName, cls, {});
    const ref = refImpl(s);
    assert.deepEqual({ ...got }, { ...ref }, `shape ${JSON.stringify(s)}`);
  }
});

test('summarizeRunning: classification memoized across frames (calls do not grow with frames)', () => {
  const cls = makeClassifier();
  // Stable tool objects across "frames" (same identities each render).
  const tools = [{ name: 'readFile' }, { name: 'grep' }, { name: 'bashRun' }];
  const FRAMES = 25;
  for (let f = 0; f < FRAMES; f++) {
    memo.summarizeRunning(tools, isRunning, toolName, cls, {});
  }
  // Each distinct tool classified exactly once despite 25 frames.
  assert.equal(cls.calls(), 3, `classifier called once per distinct tool, not per frame (got ${cls.calls()})`);
});

test('LIVE wiring: statusBroadcast.js routes through runningToolsSummaryMemo + inline fallback', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/statusBroadcast.js'), 'utf8');
  assert.ok(/require\(['"]\.\/tui\/ink-components\/runningToolsSummaryMemo['"]\)/.test(src), 'requires the summary memo leaf');
  assert.ok(/_summaryMemo\.summarizeRunningByArrayIdentity\(tools,\s*_isRunning,\s*_toolName,\s*classifyAgentTool,\s*env\)/.test(src), 'delegates to summarizeRunningByArrayIdentity');
  // inline historical fallback preserved
  assert.ok(/tools\.filter\(_isRunning\)/.test(src), 'historical inline fallback preserved');
  assert.ok(/classifyAgentTool\(_toolName\(t\)\)/.test(src), 'historical classify preserved in fallback');
});

// ── 第二层:按 streaming.tools 数组对象身份整体记忆 counts ────────────────────────────────
test('isArrayMemoEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isArrayMemoEnabled({}), true);
  assert.equal(memo.isArrayMemoEnabled({ KHY_RUNNING_TOOLS_ARRAY_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isArrayMemoEnabled({ KHY_RUNNING_TOOLS_ARRAY_MEMO: off }), false, `off=${off}`);
  }
});

test('summarizeRunningByArrayIdentity: same array ref → whole scan skipped (isRunning not re-read)', () => {
  const cls = makeClassifier();
  // isRunning 计数:命中缓存后不应对整条数组再走一遍 _isRunning。
  let runCalls = 0;
  const countingIsRunning = (t) => { runCalls++; return !!t && !t.result; };
  const tools = [{ name: 'readFile' }, { name: 'grep' }, { name: 'bashRun' }];
  const FRAMES = 25;
  for (let f = 0; f < FRAMES; f++) {
    memo.summarizeRunningByArrayIdentity(tools, countingIsRunning, toolName, cls, {});
  }
  // 首帧扫 3 次,其后 24 帧命中缓存 → 恒为 3(不随帧线性增长)。
  assert.equal(runCalls, 3, `isRunning scanned once per tool total, not per frame (got ${runCalls})`);
  // counts 正确。
  const c = memo.summarizeRunningByArrayIdentity(tools, countingIsRunning, toolName, cls, {});
  assert.equal(c.read, 1);
  assert.equal(c.search, 1);
  assert.equal(c.command, 1);
});

test('summarizeRunningByArrayIdentity: new array ref (append/resolve) → recompute', () => {
  const cls = makeClassifier();
  let runCalls = 0;
  const countingIsRunning = (t) => { runCalls++; return !!t && !t.result; };
  const a = [{ name: 'readFile' }];
  memo.summarizeRunningByArrayIdentity(a, countingIsRunning, toolName, cls, {}); // scan 1
  memo.summarizeRunningByArrayIdentity(a, countingIsRunning, toolName, cls, {}); // hit, +0
  const b = [...a, { name: 'grep' }]; // 追加 → 新数组引用
  memo.summarizeRunningByArrayIdentity(b, countingIsRunning, toolName, cls, {}); // scan 2 (2 tools)
  assert.equal(runCalls, 3, `1 (first a) + 2 (new b) = 3 scans; hit on repeat a costs 0 (got ${runCalls})`);
  const cb = memo.summarizeRunningByArrayIdentity(b, countingIsRunning, toolName, cls, {}); // hit
  assert.equal(cb.read, 1);
  assert.equal(cb.search, 1);
});

test('summarizeRunningByArrayIdentity: gate off → every frame full scan (byte-identical to summarizeRunning)', () => {
  const cls = makeClassifier();
  let runCalls = 0;
  const countingIsRunning = (t) => { runCalls++; return !!t && !t.result; };
  const off = { KHY_RUNNING_TOOLS_ARRAY_MEMO: 'off' };
  const tools = [{ name: 'readFile' }, { name: 'grep' }];
  for (let f = 0; f < 5; f++) {
    memo.summarizeRunningByArrayIdentity(tools, countingIsRunning, toolName, cls, off);
  }
  assert.equal(runCalls, 10, '门控关每帧全扫描(5 帧 × 2 工具 = 10)');
  // 输出与直接 summarizeRunning 逐字节等价。
  const got = memo.summarizeRunningByArrayIdentity(tools, isRunning, toolName, cls, off);
  const ref = memo.summarizeRunning(tools, isRunning, toolName, cls, off);
  assert.deepEqual({ ...got }, { ...ref });
});

test('summarizeRunningByArrayIdentity: non-array → falls through to summarizeRunning safely', () => {
  const cls = makeClassifier();
  assert.deepEqual({ ...memo.summarizeRunningByArrayIdentity(null, isRunning, toolName, cls, {}) }, {});
  assert.deepEqual({ ...memo.summarizeRunningByArrayIdentity(undefined, isRunning, toolName, cls, {}) }, {});
});

test('summarizeRunningByArrayIdentity: output byte-identical to summarizeRunning across shapes', () => {
  const cls = makeClassifier();
  const shapes = [
    [],
    [{ name: 'readFile' }],
    [{ name: 'grep' }, { name: 'grep', result: 1 }, { name: 'bash' }],
    [{ toolName: 'searchCode' }, { name: 'weird' }, { name: 'readX' }],
    [{ result: 1 }, { result: 1 }],
  ];
  for (const s of shapes) {
    // 用**新数组副本**避免跨形状 WeakMap 命中干扰(每个 shape 独立键)。
    const got = memo.summarizeRunningByArrayIdentity([...s], isRunning, toolName, cls, {});
    const ref = memo.summarizeRunning(s, isRunning, toolName, cls, {});
    assert.deepEqual({ ...got }, { ...ref }, `shape ${JSON.stringify(s)}`);
  }
});
