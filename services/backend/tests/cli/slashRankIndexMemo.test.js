'use strict';

/**
 * slashRankIndexMemo + rankSlashCommands 集成测试。
 *
 * 覆盖:
 *  - 叶子:门控解析、身份命中、len 守卫失效、非对象键回退、异常回退。
 *  - 集成:rankSlashCommands 在 ON / OFF 下对同一命令表 + 一串 filter 输出逐条一致
 *    (逐字节回退不变量);记忆确实复用同一投影引用。
 *  - LIVE wiring:slashCommandFilter.js 源确实 require + 消费本叶子。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/repl/slashRankIndexMemo');
const { rankSlashCommands } = require('../../src/cli/repl/slashCommandFilter');

const CMDS = [
  { cmd: '/model', label: '模型', desc: 'switch model' },
  { cmd: '/subscribe-pr', label: '订阅', desc: 'subscribe to PR' },
  { cmd: '/autofix-pr', label: '自动修复', desc: 'auto fix PR' },
  { cmd: '/commit-push-pr', label: '提交推送', desc: 'commit push PR' },
  { cmd: '/memory', label: '记忆', desc: 'memory panel' },
];

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_SLASH_RANK_INDEX_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isEnabled({ KHY_SLASH_RANK_INDEX_MEMO: off }), false, `off=${off}`);
  }
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('getRankIndex: same array identity → same cached reference', () => {
  const arr = CMDS.slice();
  let calls = 0;
  const compute = () => { calls++; return [{ tag: 'built' }]; };
  const a = memo.getRankIndex(arr, compute, {});
  const b = memo.getRankIndex(arr, compute, {});
  assert.strictEqual(a, b, 'cached reference reused');
  assert.equal(calls, 1, 'computeFn only called once for stable identity');
});

test('getRankIndex: len guard invalidates on in-place length change', () => {
  const arr = CMDS.slice();
  let calls = 0;
  const compute = () => { calls++; return new Array(arr.length).fill(0).map((_, i) => i); };
  memo.getRankIndex(arr, compute, {});
  assert.equal(calls, 1);
  arr.push({ cmd: '/new' }); // in-place mutation changes length
  memo.getRankIndex(arr, compute, {});
  assert.equal(calls, 2, 'length change forces recompute');
});

test('getRankIndex: gate off → computeFn each time (no caching)', () => {
  const arr = CMDS.slice();
  let calls = 0;
  const compute = () => { calls++; return []; };
  memo.getRankIndex(arr, compute, { KHY_SLASH_RANK_INDEX_MEMO: 'off' });
  memo.getRankIndex(arr, compute, { KHY_SLASH_RANK_INDEX_MEMO: 'off' });
  assert.equal(calls, 2, 'no memoization when gated off');
});

test('getRankIndex: non-object key → computeFn (fail-soft)', () => {
  let calls = 0;
  const compute = () => { calls++; return ['x']; };
  assert.deepEqual(memo.getRankIndex(null, compute, {}), ['x']);
  assert.deepEqual(memo.getRankIndex('str', compute, {}), ['x']);
  assert.equal(calls, 2);
});

test('getRankIndex: computeFn throws → inner fallback returns [] not throw', () => {
  const arr = CMDS.slice();
  const boom = () => { throw new Error('boom'); };
  assert.deepEqual(memo.getRankIndex(arr, boom, {}), []);
});

test('rankSlashCommands: ON vs OFF produce byte-identical ordered results', () => {
  const filters = ['/', '/m', '/mo', '/pr', '/sub', '/记忆', '/PR', '/xyz-nomatch', '/commit'];
  for (const f of filters) {
    const on = rankSlashCommands(CMDS, f).map((s) => s.cmd);
    // Force OFF path by temporarily setting env then restoring.
    const prev = process.env.KHY_SLASH_RANK_INDEX_MEMO;
    process.env.KHY_SLASH_RANK_INDEX_MEMO = 'off';
    const off = rankSlashCommands(CMDS, f).map((s) => s.cmd);
    if (prev == null) delete process.env.KHY_SLASH_RANK_INDEX_MEMO;
    else process.env.KHY_SLASH_RANK_INDEX_MEMO = prev;
    assert.deepEqual(on, off, `filter=${f} must be identical ON vs OFF`);
  }
});

test('rankSlashCommands: prefix > cmd-substring > label/desc-substring ordering', () => {
  // '/pr' : cmd-substring hits the three *-pr commands (score 2), none prefix.
  const pr = rankSlashCommands(CMDS, '/pr').map((s) => s.cmd);
  assert.ok(pr.includes('/subscribe-pr'));
  assert.ok(pr.includes('/autofix-pr'));
  assert.ok(pr.includes('/commit-push-pr'));
  assert.ok(!pr.includes('/model'));
  // '/mo' : prefix hit /model (score 3) ranks before desc-only hits.
  const mo = rankSlashCommands(CMDS, '/mo');
  assert.equal(mo[0].cmd, '/model');
});

test('rankSlashCommands: empty / bare-slash filter returns full copy', () => {
  const full = rankSlashCommands(CMDS, '/');
  assert.equal(full.length, CMDS.length);
  assert.notStrictEqual(full, CMDS, 'returns a copy, not the same array');
});

test('LIVE wiring: slashCommandFilter.js requires and consumes the memo', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/cli/repl/slashCommandFilter.js'),
    'utf8',
  );
  assert.ok(/require\(['"]\.\/slashRankIndexMemo['"]\)/.test(src), 'requires slashRankIndexMemo');
  assert.ok(/getRankIndex\(/.test(src), 'calls getRankIndex');
  assert.ok(/_buildRankIndex\(/.test(src), 'has inline builder for fallback/first-compute');
});
