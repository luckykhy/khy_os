'use strict';

/**
 * commandCompletionIndexMemo + commandRegistry.getCompletions 集成测试。
 *
 * 覆盖:
 *  - 叶子:门控 CANON、(身份,size) 命中同引用、size 守卫失效、非 Map 键回退、异常回退。
 *  - 集成:commandRegistry.getCompletions 在 ON / OFF 下对一串 partial 输出**逐字节一致**
 *    (投影排序 = 原 matches.sort() 不变量);注册新命令后 size 变→结果纳入新命令。
 *  - LIVE wiring:commandRegistry.js 源确实 require + 消费本叶子且免去 matches.sort()。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/commandCompletionIndexMemo');
const registry = require('../../src/cli/commandRegistry');

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_COMMAND_COMPLETION_INDEX_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isEnabled({ KHY_COMMAND_COMPLETION_INDEX_MEMO: off }), false, `off=${off}`);
  }
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('getCompletionIndex: same (identity, size) → cached reference, computeFn once', () => {
  const m = new Map([['/a', 1], ['/b', 2]]);
  let calls = 0;
  const compute = () => { calls++; return [{ cmd: '/a', cmdLower: '/a' }]; };
  const a = memo.getCompletionIndex(m, compute, {});
  const b = memo.getCompletionIndex(m, compute, {});
  assert.strictEqual(a, b, 'cached reference reused');
  assert.equal(calls, 1, 'computeFn only once for stable (identity, size)');
});

test('getCompletionIndex: size guard invalidates on Map growth', () => {
  const m = new Map([['/a', 1]]);
  let calls = 0;
  const compute = () => { calls++; return [...m.keys()].map((c) => ({ cmd: c, cmdLower: c })); };
  memo.getCompletionIndex(m, compute, {});
  assert.equal(calls, 1);
  m.set('/b', 2); // size change
  memo.getCompletionIndex(m, compute, {});
  assert.equal(calls, 2, 'size change forces rebuild');
});

test('getCompletionIndex: gate off → computeFn each time', () => {
  const m = new Map([['/a', 1]]);
  let calls = 0;
  const compute = () => { calls++; return []; };
  const off = { KHY_COMMAND_COMPLETION_INDEX_MEMO: 'off' };
  memo.getCompletionIndex(m, compute, off);
  memo.getCompletionIndex(m, compute, off);
  assert.equal(calls, 2, 'no memoization when gated off');
});

test('getCompletionIndex: non-Map key (no .size) → computeFn (fail-soft)', () => {
  let calls = 0;
  const compute = () => { calls++; return ['x']; };
  assert.deepEqual(memo.getCompletionIndex(null, compute, {}), ['x']);
  assert.deepEqual(memo.getCompletionIndex({}, compute, {}), ['x']); // plain obj: size undefined
  assert.deepEqual(memo.getCompletionIndex('str', compute, {}), ['x']);
  assert.equal(calls, 3);
});

test('getCompletionIndex: computeFn throws → [] not throw', () => {
  const m = new Map([['/a', 1]]);
  assert.deepEqual(memo.getCompletionIndex(m, () => { throw new Error('boom'); }, {}), []);
});

test('registry.getCompletions: ON vs OFF byte-identical across partials', () => {
  // Use real (already-populated) registry. Compare ON vs OFF for a spread of prefixes.
  const partials = ['/', '/m', '/mo', '/g', '/gi', '/s', '/help', '/xyz-none', '/A', ''];
  const prev = process.env.KHY_COMMAND_COMPLETION_INDEX_MEMO;
  try {
    for (const p of partials) {
      process.env.KHY_COMMAND_COMPLETION_INDEX_MEMO = 'on';
      const on = registry.getCompletions(p);
      process.env.KHY_COMMAND_COMPLETION_INDEX_MEMO = 'off';
      const off = registry.getCompletions(p);
      assert.deepEqual(on, off, `partial=${JSON.stringify(p)} identical ON vs OFF`);
    }
  } finally {
    if (prev == null) delete process.env.KHY_COMMAND_COMPLETION_INDEX_MEMO;
    else process.env.KHY_COMMAND_COMPLETION_INDEX_MEMO = prev;
  }
});

test('registry.getCompletions: result is sorted (subsequence of sorted projection)', () => {
  const out = registry.getCompletions('/');
  const sorted = out.slice().sort();
  assert.deepEqual(out, sorted, 'output is lexicographically sorted like original matches.sort()');
});

test('registry.getCompletions: newly registered command reflected after size change', () => {
  const uniq = '/zz-memo-probe-' + registry.count();
  const before = registry.getCompletions(uniq);
  assert.deepEqual(before, [], 'probe not present initially');
  registry.register({ cmd: uniq, label: 'probe', desc: 'test', route: uniq });
  try {
    const after = registry.getCompletions(uniq);
    assert.ok(after.includes(uniq), 'size change invalidated index; new command visible');
  } finally {
    registry.unregister(uniq);
  }
});

test('LIVE wiring: commandRegistry.js requires leaf + drops matches.sort()', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/cli/commandRegistry.js'),
    'utf8',
  );
  assert.ok(/require\(['"]\.\/commandCompletionIndexMemo['"]\)/.test(src), 'requires the memo');
  assert.ok(/getCompletionIndex\(_commands,/.test(src), 'calls getCompletionIndex with _commands');
  // The rewritten getCompletions must no longer *call* matches.sort() (projection is pre-sorted).
  // Match an actual statement `return matches.sort()`, not the substring inside an explanatory comment.
  assert.ok(!/return\s+matches\.sort\(\)/.test(src), 'getCompletions no longer returns matches.sort()');
});
