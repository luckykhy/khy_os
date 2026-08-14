'use strict';

/**
 * slashRankResultMemo + slashMenuCommandNames 集成测试。
 *
 * 覆盖:
 *  - 叶子:门控 CANON、(身份,filter) 命中同引用、LRU 淘汰、len 守卫失效、非对象键回退、异常回退。
 *  - 集成:slashMenuCommandNames 在 ON / OFF 下对同一命令表 + 一串 filter 输出逐条一致
 *    (逐字节回退不变量);退格回访命中缓存(computeFn 不再调)。
 *  - LIVE wiring:slashMenuFilter.js 源确实 require + 消费本叶子。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/tui/slashRankResultMemo');
const { slashMenuCommandNames } = require('../../src/cli/tui/slashMenuFilter');

const CMDS = [
  { cmd: '/model', label: '模型', desc: 'switch model' },
  { cmd: '/subscribe-pr', label: '订阅', desc: 'subscribe to PR' },
  { cmd: '/autofix-pr', label: '自动修复', desc: 'auto fix PR' },
  { cmd: '/commit-push-pr', label: '提交推送', desc: 'commit push PR' },
  { cmd: '/memory', label: '记忆', desc: 'memory panel' },
];

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_SLASH_RANK_RESULT_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isEnabled({ KHY_SLASH_RANK_RESULT_MEMO: off }), false, `off=${off}`);
  }
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('getRankedNames: same (identity, filter) → cached reference, computeFn once', () => {
  const arr = CMDS.slice();
  let calls = 0;
  const compute = () => { calls++; return ['/a', '/b']; };
  const a = memo.getRankedNames(arr, '/x', compute, {});
  const b = memo.getRankedNames(arr, '/x', compute, {});
  assert.strictEqual(a, b, 'cached reference reused');
  assert.equal(calls, 1, 'computeFn only once for same (identity, filter)');
});

test('getRankedNames: distinct filters each computed, then revisit hits (backspace)', () => {
  const arr = CMDS.slice();
  let calls = 0;
  const mk = (v) => () => { calls++; return [v]; };
  memo.getRankedNames(arr, '/mo', mk('mo'), {});
  memo.getRankedNames(arr, '/mod', mk('mod'), {});
  assert.equal(calls, 2, 'two distinct filters → two computes');
  // backspace back to /mo → cached
  const back = memo.getRankedNames(arr, '/mo', mk('SHOULD_NOT_RUN'), {});
  assert.deepEqual(back, ['mo']);
  assert.equal(calls, 2, 'revisit hits cache, no recompute');
});

test('getRankedNames: LRU eviction beyond CAP', () => {
  const arr = [{ cmd: '/z' }]; // fresh identity for isolation
  let calls = 0;
  const mk = (v) => () => { calls++; return [v]; };
  // Fill CAP+1 distinct filters; the very first should be evicted.
  for (let i = 0; i <= memo.CAP; i++) memo.getRankedNames(arr, `/f${i}`, mk(`f${i}`), {});
  assert.equal(calls, memo.CAP + 1);
  // Re-request the oldest (/f0) → evicted → recompute.
  memo.getRankedNames(arr, '/f0', mk('f0-again'), {});
  assert.equal(calls, memo.CAP + 2, 'oldest filter was evicted, recomputed');
  // Re-request the newest (/fCAP) → still cached.
  memo.getRankedNames(arr, `/f${memo.CAP}`, mk('X'), {});
  assert.equal(calls, memo.CAP + 2, 'newest still cached');
});

test('getRankedNames: len guard invalidates slot on in-place length change', () => {
  const arr = CMDS.slice();
  let calls = 0;
  const mk = (v) => () => { calls++; return [v]; };
  memo.getRankedNames(arr, '/mo', mk('mo'), {});
  assert.equal(calls, 1);
  arr.push({ cmd: '/new' }); // length change → new slot
  memo.getRankedNames(arr, '/mo', mk('mo2'), {});
  assert.equal(calls, 2, 'length change discards prior slot');
});

test('getRankedNames: gate off → computeFn each time', () => {
  const arr = CMDS.slice();
  let calls = 0;
  const compute = () => { calls++; return []; };
  const off = { KHY_SLASH_RANK_RESULT_MEMO: 'off' };
  memo.getRankedNames(arr, '/x', compute, off);
  memo.getRankedNames(arr, '/x', compute, off);
  assert.equal(calls, 2, 'no memoization when gated off');
});

test('getRankedNames: non-object key → computeFn (fail-soft)', () => {
  let calls = 0;
  const compute = () => { calls++; return ['x']; };
  assert.deepEqual(memo.getRankedNames(null, '/x', compute, {}), ['x']);
  assert.deepEqual(memo.getRankedNames('str', '/x', compute, {}), ['x']);
  assert.equal(calls, 2);
});

test('getRankedNames: computeFn throws → [] not throw', () => {
  const arr = CMDS.slice();
  const boom = () => { throw new Error('boom'); };
  assert.deepEqual(memo.getRankedNames(arr, '/x', boom, {}), []);
});

test('slashMenuCommandNames: ON vs OFF byte-identical over a filter sequence', () => {
  const deps = { slashCommands: CMDS, getCompletionsFn: () => [] };
  const filters = ['/', '/m', '/mo', '/mod', '/pr', '/sub', '/记忆', '/PR', '/xyz-none', '/commit'];
  for (const f of filters) {
    const on = slashMenuCommandNames(f, deps, {});
    const off = slashMenuCommandNames(f, deps, { KHY_SLASH_RANK_RESULT_MEMO: 'off' });
    assert.deepEqual(on, off, `filter=${f} identical ON vs OFF`);
  }
});

test('slashMenuCommandNames: gate KHY_TUI_SLASH_SUBSTRING off still falls back to prefix source', () => {
  const deps = { slashCommands: CMDS, getCompletionsFn: (v) => [`prefix:${v}`] };
  const out = slashMenuCommandNames('/m', deps, { KHY_TUI_SLASH_SUBSTRING: 'off' });
  assert.deepEqual(out, ['prefix:/m'], 'substring-off path unaffected by result memo');
});

test('LIVE wiring: slashMenuFilter.js requires and consumes the result memo', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/cli/tui/slashMenuFilter.js'),
    'utf8',
  );
  assert.ok(/require\(['"]\.\/slashRankResultMemo['"]\)/.test(src), 'requires slashRankResultMemo');
  assert.ok(/getRankedNames\(/.test(src), 'calls getRankedNames');
  assert.ok(/rankSlashCommands\(list, value\)\.map\(\(sc\) => sc\.cmd\)/.test(src),
    'computeFn preserves the exact map(sc=>sc.cmd) shape');
});
