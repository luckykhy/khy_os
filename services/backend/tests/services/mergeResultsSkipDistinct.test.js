'use strict';

// node:test coverage for mergeResults' dependency-skip rendering (OPS-MAN-092).
//
// OPS-MAN-087 emits `{ success:false, skipped:true, error:'依赖失败，已跳过' }`
// for subtasks whose upstream dependency collapsed. Before this change,
// mergeResults folded those into the plain 失败 bucket — indistinguishable from
// a subtask that genuinely ran and failed. These tests pin the DISTINCT
// rendering (gate on) AND the byte-identical fallback (gate off).
//
// Run: node --test services/backend/tests/services/mergeResultsSkipDistinct.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { mergeResults } = require('../../src/services/taskDecomposer');

const GATE = 'KHY_MERGE_SKIP_DISTINCT';

// Restore the env var to its original state after each toggle so tests don't
// leak into one another.
function withGate(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, GATE);
  const prev = process.env[GATE];
  if (value === undefined) delete process.env[GATE];
  else process.env[GATE] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[GATE] = prev;
    else delete process.env[GATE];
  }
}

// Minimal subtask shape mergeResults relies on: { prompt, originIndex }.
const sub = (prompt, originIndex) => ({ prompt, role: 'general', originIndex });
// Aggregated item shape: { name: `subtask-<n>`, result }.
const agg = (n, result) => ({ name: `subtask-${n}`, result });

// ── Gate ON: skip is distinct from failure ──────────────────────────────────

test('gate on: 1 real failure + 2 dependency-skips render distinctly and split in footer', () => {
  withGate(undefined, () => {
    const subtasks = [sub('探索代码库', 0), sub('实现功能', 1), sub('验证结果', 2)];
    const aggregated = [
      agg(1, { success: false, error: '真的炸了', text: '炸了的输出' }),
      agg(2, { success: false, skipped: true, error: '依赖失败，已跳过' }),
      agg(3, { success: false, skipped: true, error: '依赖失败，已跳过' }),
    ];
    const out = mergeResults(subtasks, aggregated);

    // Two distinct skip status lines, not folded into 失败.
    const skipStatusCount = (out.match(/\*\*状态\*\*: 跳过（依赖失败）/g) || []).length;
    assert.strictEqual(skipStatusCount, 2, 'expected 2 distinct skip status lines');

    // The real failure still renders as 失败.
    assert.match(out, /\*\*状态\*\*: 失败: 真的炸了/);

    // Footer splits the counts: exactly 1 failed, 2 skipped.
    assert.match(out, /- 失败: 1 项/);
    assert.match(out, /- 跳过（依赖失败）: 2 项/);

    // Skipped items must NOT render the (无输出) placeholder noise (the sole
    // subtask with empty output above is the real failure, which carries a
    // body, so any (无输出) here would have to come from a skip).
    assert.ok(!out.includes('(无输出)'), 'skipped items should not render (无输出)');
  });
});

test('gate on: skipped item does NOT contribute filesModified to the 修改文件 line', () => {
  withGate(undefined, () => {
    const subtasks = [sub('实现', 0), sub('验证', 1)];
    const aggregated = [
      agg(1, { success: true, text: 'done', filesModified: ['a.js'] }),
      // A skip item that erroneously carries filesModified must be ignored.
      agg(2, { success: false, skipped: true, error: '依赖失败，已跳过', filesModified: ['ghost.js'] }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.match(out, /- 修改文件: a\.js/);
    assert.ok(!out.includes('ghost.js'), 'skipped item filesModified must not leak into 修改文件');
    assert.match(out, /- 跳过（依赖失败）: 1 项/);
  });
});

test('gate on: pure-success plan has no 跳过 footer line and 完成 count unchanged', () => {
  withGate(undefined, () => {
    const subtasks = [sub('a', 0), sub('b', 1)];
    const aggregated = [
      agg(1, { success: true, text: 'x' }),
      agg(2, { success: true, text: 'y' }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.match(out, /- 完成: 2\/2 项/);
    assert.ok(!out.includes('跳过'), 'no skip footer when there are no skips');
    assert.ok(!out.includes('- 失败:'), 'no fail footer when there are no failures');
  });
});

// ── Gate OFF: byte-identical fallback to today's behavior ────────────────────

test('gate off: dependency-skips fall back to 失败 bucket, no 跳过 footer', () => {
  withGate('off', () => {
    const subtasks = [sub('探索', 0), sub('实现', 1), sub('验证', 2)];
    const aggregated = [
      agg(1, { success: false, error: '真的炸了', text: '' }),
      agg(2, { success: false, skipped: true, error: '依赖失败，已跳过' }),
      agg(3, { success: false, skipped: true, error: '依赖失败，已跳过' }),
    ];
    const out = mergeResults(subtasks, aggregated);

    // No distinct skip status line — skips render as 失败 with their error.
    assert.ok(!out.includes('跳过（依赖失败）'), 'gate off must not render distinct skip status/footer');
    const failStatusCount = (out.match(/\*\*状态\*\*: 失败: 依赖失败，已跳过/g) || []).length;
    assert.strictEqual(failStatusCount, 2, 'both skips render as 失败: 依赖失败，已跳过');

    // Footer: all 3 counted as failures, no skip line.
    assert.match(out, /- 失败: 3 项/);
  });
});

test('gate off via each falsy token (0/false/no) all fall back', () => {
  for (const tok of ['0', 'false', 'no', 'OFF']) {
    withGate(tok, () => {
      const subtasks = [sub('实现', 0)];
      const aggregated = [agg(1, { success: false, skipped: true, error: '依赖失败，已跳过' })];
      const out = mergeResults(subtasks, aggregated);
      assert.ok(!out.includes('跳过（依赖失败）'), `token ${tok} must disable distinct skip`);
      assert.match(out, /- 失败: 1 项/);
    });
  }
});

// ── Boundaries (unchanged behavior) ─────────────────────────────────────────

test('empty aggregated → unchanged sentinel', () => {
  withGate(undefined, () => {
    assert.strictEqual(mergeResults([sub('x', 0)], []), '所有子任务未返回结果。');
  });
});

test('null result item → 未执行 (unchanged, not treated as skip)', () => {
  withGate(undefined, () => {
    const out = mergeResults([sub('x', 0)], [agg(1, null)]);
    assert.match(out, /\*\*状态\*\*: 未执行/);
    assert.ok(!out.includes('跳过'), 'null result is 未执行, not 跳过');
  });
});
