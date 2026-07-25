'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const planner = require('../../src/services/localExecutionPlanner');

// ── planOrderedSteps: edit-replace (先读后写) ─────────────────────────────────
test('edit-replace intent → Read then Edit, ordered', () => {
  const plan = planner.planOrderedSteps('把 a.txt 里的 foo 改成 bar');
  assert.ok(plan, 'should detect compound edit intent');
  assert.strictEqual(plan.kind, 'edit_replace');
  assert.strictEqual(plan.steps.length, 2);
  assert.strictEqual(plan.steps[0].name, 'Read');
  assert.strictEqual(plan.steps[0].phase, 'read');
  assert.strictEqual(plan.steps[1].name, 'Edit');
  assert.strictEqual(plan.steps[1].phase, 'write');
  assert.strictEqual(plan.steps[1].params.old_string, 'foo');
  assert.strictEqual(plan.steps[1].params.new_string, 'bar');
  // read targets the same file as the edit
  assert.strictEqual(planner._stepFile(plan.steps[0]), planner._stepFile(plan.steps[1]));
});

test('edit-replace honors allowedSet canonical names', () => {
  const allowedSet = new Set(['readFile', 'editFile']);
  const plan = planner.planOrderedSteps('将 config.json 中的 dev 替换为 prod', { allowedSet });
  assert.ok(plan);
  assert.strictEqual(plan.steps[0].name, 'readFile');
  assert.strictEqual(plan.steps[1].name, 'editFile');
});

// ── planOrderedSteps: write-then-verify (先写再读) ───────────────────────────
test('create-with-content + verify → Write then verify-Read', () => {
  const plan = planner.planOrderedSteps('创建 hello.txt 内容为 你好世界，然后读回确认');
  assert.ok(plan);
  assert.strictEqual(plan.kind, 'write_then_verify');
  assert.strictEqual(plan.steps.length, 2);
  assert.strictEqual(plan.steps[0].name, 'Write');
  assert.strictEqual(plan.steps[0].phase, 'write');
  // verify tail stripped from content
  assert.strictEqual(plan.steps[0].params.content, '你好世界');
  assert.strictEqual(plan.steps[1].phase, 'verify');
  assert.strictEqual(plan.steps[1].name, 'Read');
});

test('create-with-content WITHOUT verify → Write only, no fabricated read', () => {
  const plan = planner.planOrderedSteps('创建 note.md 内容为 草稿');
  assert.ok(plan);
  assert.strictEqual(plan.steps.length, 1);
  assert.strictEqual(plan.steps[0].name, 'Write');
  assert.strictEqual(plan.steps[0].params.content, '草稿');
});

test('write-content-to form detected', () => {
  const plan = planner.planOrderedSteps('把 日志内容 写入 out.log');
  assert.ok(plan);
  assert.strictEqual(plan.steps[0].name, 'Write');
  assert.strictEqual(planner._stepFile(plan.steps[0]), 'out.log');
  assert.strictEqual(plan.steps[0].params.content, '日志内容');
});

test('non-compound / ambiguous input → null (caller falls back to single-call)', () => {
  assert.strictEqual(planner.planOrderedSteps('帮我看看这个项目'), null);
  assert.strictEqual(planner.planOrderedSteps(''), null);
  assert.strictEqual(planner.planOrderedSteps('修改一下 a.txt'), null, 'no explicit replacement → null');
});

// ── enforceReadWriteOrder: the structural safety net ─────────────────────────
test('enforce splices a Read before an Edit when none precedes it', () => {
  const steps = [{ name: 'Edit', params: { file_path: 'x.js' }, phase: 'write' }];
  const { steps: out, inserted } = planner.enforceReadWriteOrder(steps);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'Read');
  assert.strictEqual(out[0].inserted, true);
  assert.strictEqual(out[1].name, 'Edit');
  assert.strictEqual(inserted.length, 1);
});

test('enforce does NOT add a read when one already precedes the edit', () => {
  const steps = [
    { name: 'Read', params: { file_path: 'x.js' }, phase: 'read' },
    { name: 'Edit', params: { file_path: 'x.js' }, phase: 'write' },
  ];
  const { steps: out, inserted } = planner.enforceReadWriteOrder(steps);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(inserted.length, 0);
});

test('enforce: Write on EXISTING file needs prior read; fresh create does not', () => {
  const existing = planner.enforceReadWriteOrder(
    [{ name: 'Write', params: { file_path: 'present.txt' }, phase: 'write' }],
    { fileExists: () => true },
  );
  assert.strictEqual(existing.steps.length, 2, 'overwrite of existing → prior read inserted');
  assert.strictEqual(existing.steps[0].name, 'Read');

  const fresh = planner.enforceReadWriteOrder(
    [{ name: 'Write', params: { file_path: 'new.txt' }, phase: 'write' }],
    { fileExists: () => false },
  );
  assert.strictEqual(fresh.steps.length, 1, 'fresh create → no read needed');
  assert.strictEqual(fresh.steps[0].name, 'Write');
});

test('enforce: a verify-read does NOT satisfy a later edit on the same file', () => {
  // verify read comes first (unusual), but phase:'verify' must not count as prior-read.
  const steps = [
    { name: 'Read', params: { file_path: 'x.js' }, phase: 'verify' },
    { name: 'Edit', params: { file_path: 'x.js' }, phase: 'write' },
  ];
  const { steps: out, inserted } = planner.enforceReadWriteOrder(steps);
  assert.strictEqual(inserted.length, 1, 'verify-read does not satisfy invariant');
  // sequence becomes: verify-read, inserted Read, Edit
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[1].name, 'Read');
  assert.strictEqual(out[1].inserted, true);
});

test('enforce never mutates the input array', () => {
  const steps = [{ name: 'Edit', params: { file_path: 'x.js' }, phase: 'write' }];
  const before = steps.length;
  planner.enforceReadWriteOrder(steps);
  assert.strictEqual(steps.length, before);
});
