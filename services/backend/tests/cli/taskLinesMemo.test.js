'use strict';

/**
 * taskLinesMemo.test.js — 任务清单合并解析单槽记忆(纯叶子 + taskPanelLines 集成,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关。
 *  - 门控开:snap 值不变且 planTasks 同引用 → 复用上次结果(computeFn 只调一次)。
 *  - snap 值变 → 重算;planTasks 引用变(即使内容同) → 重算。
 *  - 门控关 → 每次直算(逐字节回退)。
 *  - computeFn 抛错 → 绝不向上抛(兜底 [])。
 *  - **逐字节等价**:memo 返回值恒等于直接 mergeTaskLines(snap, planTasks)。
 *
 * 运行:node --test services/backend/tests/cli/taskLinesMemo.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const memo = require('../../src/cli/tui/ink-components/taskLinesMemo');
const { mergeTaskLines } = require('../../src/cli/tui/ink-components/taskPanelLines');

const ON = {};
const OFF = { KHY_TASK_LINES_MEMO: 'off' };

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_TASK_LINES_MEMO: 'off' }), false);
  assert.equal(memo.isEnabled({ KHY_TASK_LINES_MEMO: '0' }), false);
  assert.equal(memo.isEnabled({ KHY_TASK_LINES_MEMO: 'false' }), false);
  assert.equal(memo.isEnabled({ KHY_TASK_LINES_MEMO: 'no' }), false);
  assert.equal(memo.isEnabled({ KHY_TASK_LINES_MEMO: 'on' }), true);
});

test('门控开:snap 值不变 + planTasks 同引用 → 只算一次', () => {
  memo._reset();
  const snap = '✓ done\n→ working';
  const planTasks = [{ description: 'plan a', status: 'pending' }];
  let calls = 0;
  const compute = () => { calls++; return mergeTaskLines(snap, planTasks); };
  const a = memo.memoMergeTaskLines(snap, planTasks, compute, ON);
  const b = memo.memoMergeTaskLines(snap, planTasks, compute, ON);
  const c = memo.memoMergeTaskLines(snap, planTasks, compute, ON);
  assert.equal(calls, 1, '不变的 snap+planTasks 多帧应只算一次');
  assert.deepEqual(a, mergeTaskLines(snap, planTasks));
  assert.equal(b, a, '命中应返回同一引用');
  assert.equal(c, a);
});

test('门控开:snap 值变 → 重算', () => {
  memo._reset();
  const planTasks = [{ description: 'p', status: 'pending' }];
  let calls = 0;
  const compute = (snap) => () => { calls++; return mergeTaskLines(snap, planTasks); };
  memo.memoMergeTaskLines('snap-1', planTasks, compute('snap-1'), ON);
  memo.memoMergeTaskLines('snap-2', planTasks, compute('snap-2'), ON);
  assert.equal(calls, 2, 'snap 值变应重算');
});

test('门控开:planTasks 引用变(内容同)→ 重算', () => {
  memo._reset();
  const snap = '✓ x';
  let calls = 0;
  const compute = () => { calls++; return ['✓ x']; };
  memo.memoMergeTaskLines(snap, [{ description: 'p', status: 'pending' }], compute, ON);
  memo.memoMergeTaskLines(snap, [{ description: 'p', status: 'pending' }], compute, ON);
  assert.equal(calls, 2, 'planTasks 新引用(即使内容同)应重算——按引用比较');
});

test('门控关 → 每次直算(逐字节回退)', () => {
  memo._reset();
  const snap = 's';
  const planTasks = null;
  let calls = 0;
  const compute = () => { calls++; return mergeTaskLines(snap, planTasks); };
  memo.memoMergeTaskLines(snap, planTasks, compute, OFF);
  memo.memoMergeTaskLines(snap, planTasks, compute, OFF);
  assert.equal(calls, 2, '门控关每帧直算');
});

test('computeFn 抛错 → 绝不向上抛(兜底 空数组)', () => {
  memo._reset();
  const throwing = () => { throw new Error('boom'); };
  let out;
  assert.doesNotThrow(() => { out = memo.memoMergeTaskLines('s', null, throwing, ON); });
  assert.deepEqual(out, [], '两次都抛 → 兜底 []');
});

test('逐字节等价:memo 输出恒等于直接 mergeTaskLines', () => {
  memo._reset();
  const cases = [
    ['', null],
    ['✓ done', null],
    ['✓ a\n→ b\n○ c', [{ description: 'plan1', status: 'in_progress' }]],
    ['→ b\n→ b', [{ description: 'plan1', status: 'completed' }, { description: 'b', status: 'pending' }]], // 去重相交
    [null, [{ description: 'only-plan', status: 'error' }]],
  ];
  for (const [snap, planTasks] of cases) {
    memo._reset();
    const direct = mergeTaskLines(snap, planTasks);
    const viaMemo = memo.memoMergeTaskLines(snap, planTasks, () => mergeTaskLines(snap, planTasks), ON);
    assert.deepEqual(viaMemo, direct, `memo 不改变输出:snap=${JSON.stringify(snap)}`);
  }
});
