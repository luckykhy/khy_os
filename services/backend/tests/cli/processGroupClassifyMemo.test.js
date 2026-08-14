'use strict';

/**
 * processGroupClassifyMemo 单测。
 *
 * 覆盖:
 *  - isEnabled:default-on + CANON off-words。
 *  - memoClassify:同 tool 对象二次调用命中缓存(computeFn 只跑一次)· 缓存 null 也不重算 · 门控关每次现算 ·
 *    非对象直算 · computeFn 抛错 → null · running→done 转变后分类不变(缓存不陈旧)。
 *  - groupTitle 通过 ProcessGroup 端到端:多帧同一 tools 内容分类只算一次(帧数无关)。
 *  - LIVE wiring:ProcessGroup.js 经 processGroupClassifyMemo.memoClassify + 直接算回退。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/tui/ink-components/processGroupClassifyMemo');

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_PROCESS_GROUP_CLASSIFY_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isEnabled({ KHY_PROCESS_GROUP_CLASSIFY_MEMO: off }), false, `off=${off}`);
  }
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('memoClassify: caches by tool identity (computeFn runs once)', () => {
  let calls = 0;
  const t = { name: 'readFile' };
  const compute = () => { calls++; return '读取'; };
  assert.equal(memo.memoClassify(t, compute, {}), '读取');
  assert.equal(memo.memoClassify(t, compute, {}), '读取');
  assert.equal(memo.memoClassify(t, compute, {}), '读取');
  assert.equal(calls, 1, 'computeFn invoked once for a stable tool object');
});

test('memoClassify: caches null result (does not recompute)', () => {
  let calls = 0;
  const t = { name: 'unknownWeirdTool' };
  const compute = () => { calls++; return null; };
  assert.equal(memo.memoClassify(t, compute, {}), null);
  assert.equal(memo.memoClassify(t, compute, {}), null);
  assert.equal(calls, 1, 'null cached, not recomputed each frame');
});

test('memoClassify: gate off → computes every time (no cache)', () => {
  let calls = 0;
  const off = { KHY_PROCESS_GROUP_CLASSIFY_MEMO: 'off' };
  const t = { name: 'grep' };
  const compute = () => { calls++; return '搜索'; };
  memo.memoClassify(t, compute, off);
  memo.memoClassify(t, compute, off);
  assert.equal(calls, 2, 'no caching when gated off');
});

test('memoClassify: non-object key → direct compute', () => {
  assert.equal(memo.memoClassify(null, () => '读取', {}), '读取');
  assert.equal(memo.memoClassify(undefined, () => '搜索', {}), '搜索');
  assert.equal(memo.memoClassify('str', () => '编辑', {}), '编辑');
});

test('memoClassify: computeFn throws → null', () => {
  const boom = () => { throw new Error('boom'); };
  assert.equal(memo.memoClassify({ name: 'x' }, boom, {}), null);
});

test('memoClassify: running→done transition keeps cached class (not stale)', () => {
  let calls = 0;
  const t = { name: 'shellCommand' };
  const compute = () => { calls++; return '执行命令'; };
  assert.equal(memo.memoClassify(t, compute, {}), '执行命令');
  t.result = { ok: true }; // transitions to done — classification is result-independent
  assert.equal(memo.memoClassify(t, compute, {}), '执行命令');
  assert.equal(calls, 1, 'class cached across running→done transition');
});

test('E2E via ProcessGroup.groupTitle: multi-frame classification memoized', () => {
  const ProcessGroup = require('../../src/cli/tui/ink-components/ProcessGroup');
  // Stable tool objects across "frames" (App re-renders with same identities).
  const tools = [{ name: 'readFile' }, { name: 'editFile' }];
  // groupTitle uses memoClassify internally; correctness preserved.
  const title1 = ProcessGroup.groupTitle(tools);
  for (let f = 0; f < 25; f++) {
    const t = ProcessGroup.groupTitle(tools);
    assert.equal(t, title1, `title stable across frame ${f}`);
  }
  assert.ok(/读取/.test(title1) && /编辑/.test(title1), `title reflects both categories: ${title1}`);
});

test('E2E: groupTitle byte-identical with memo ON vs OFF', () => {
  const ProcessGroup = require('../../src/cli/tui/ink-components/ProcessGroup');
  const shapes = [
    [{ name: 'readFile' }, { name: 'editFile' }],
    [{ name: 'grep' }, { name: 'webSearch' }],
    [{ name: 'unknownX' }, { name: 'unknownY' }],
    [{ name: 'Bash', input: '{"command":"ls"}' }, { name: 'readFile', input: '{"file_path":"a.js"}' }],
  ];
  const prevEnv = process.env.KHY_PROCESS_GROUP_CLASSIFY_MEMO;
  try {
    for (const s of shapes) {
      process.env.KHY_PROCESS_GROUP_CLASSIFY_MEMO = '1';
      const on = ProcessGroup.groupTitle(s.map((x) => ({ ...x }))); // fresh objs so memo state independent
      process.env.KHY_PROCESS_GROUP_CLASSIFY_MEMO = 'off';
      const off = ProcessGroup.groupTitle(s.map((x) => ({ ...x })));
      assert.equal(on, off, `ON==OFF for ${JSON.stringify(s)}`);
    }
  } finally {
    if (prevEnv === undefined) delete process.env.KHY_PROCESS_GROUP_CLASSIFY_MEMO;
    else process.env.KHY_PROCESS_GROUP_CLASSIFY_MEMO = prevEnv;
  }
});

test('LIVE wiring: ProcessGroup.js routes classifyTool through memoClassify + direct fallback', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/tui/ink-components/ProcessGroup.js'), 'utf8');
  assert.ok(/require\(['"]\.\/processGroupClassifyMemo['"]\)/.test(src), 'requires the classify memo leaf');
  assert.ok(/_classifyMemo\.memoClassify\(t,\s*\(\)\s*=>\s*classifyTool\(/.test(src), 'delegates classifyTool via memoClassify');
  // direct fallback preserved when leaf unavailable
  assert.ok(/:\s*classifyTool\(t && \(t\.name \|\| t\.toolName \|\| t\.tool\)\)/.test(src), 'direct classifyTool fallback preserved');
});
