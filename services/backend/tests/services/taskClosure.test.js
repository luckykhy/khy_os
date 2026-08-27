'use strict';

/**
 * taskClosure.test.js — 单一权威收尾裁决器纯叶子（node:test）。
 *
 * 覆盖：
 *   - isFinalDelivery 的终态交付判定（含否定 / 未来时／阶段进度遮蔽，根治「提前收尾」）；
 *   - claimsVerificationWithoutEvidence / hasConcreteEvidence / verificationCommandRan；
 *   - incompleteSteps（未完成步骤）；
 *   - decideClosure 的有界仲裁（close / redrive / close_partial）；
 *   - 绝不抛、确定性；
 *   - wiring：toolUseLoopCore 已路由到 taskClosure.isFinalDelivery（替代脆弱 hasConclusion）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const taskClosure = require('../../src/services/taskClosure');
const {
  isFinalDelivery,
  hasConcreteEvidence,
  claimsVerificationWithoutEvidence,
  verificationCommandRan,
  incompleteSteps,
  resolveMaxRedrives,
  buildRedriveMessage,
  buildPartialDeliveryNote,
  decideClosure,
} = taskClosure;

const BACKEND_ROOT = path.resolve(__dirname, '../..');

// ── isFinalDelivery：终态交付判定 ─────────────────────────────────────
test('终态交付：完成/无需操作/结果小结 → true', () => {
  assert.equal(isFinalDelivery('任务已完成，结果如下：xx 已创建。'), true);
  assert.equal(isFinalDelivery('我已整理好桌面，无需操作。'), true);
  assert.equal(isFinalDelivery('全部测试通过（12 passed）。'), true);
  assert.equal(isFinalDelivery('审计完成，无阻塞项。'), true);
});

test('提前收尾根治：阶段性小结被未来时/计划腔遮蔽 → false', () => {
  // 旧脆弱正则把「已完成第一步，接下来我将重构」判成完成 → 提前收尾。本判定应拦下。
  assert.equal(isFinalDelivery('已完成第一步，接下来我将重构整个模块。'), false);
  assert.equal(isFinalDelivery('已修复一个 bug，下一步我会继续处理其余问题。'), false);
  assert.equal(isFinalDelivery('先看看文件，然后开始改。'), false);
});

test('否定完成 → false（明说没完成）', () => {
  assert.equal(isFinalDelivery('尚未完成，还需要继续。'), false);
  assert.equal(isFinalDelivery('还没做完，我来处理。'), false);
  assert.equal(isFinalDelivery('未完成，仍有两个步骤。'), false);
});

test('空回复 / 无信号 → false', () => {
  assert.equal(isFinalDelivery(''), false);
  assert.equal(isFinalDelivery(null), false);
  assert.equal(isFinalDelivery('我在想下一步该怎么做。'), false);
});

// ── 证据 / 验证门（委托 goalStopGate 单一真源）────────────────────────
test('claimsVerificationWithoutEvidence / hasConcreteEvidence', () => {
  // 声称验证但无具体证据 → 命中。
  assert.equal(claimsVerificationWithoutEvidence('已验证通过。'), true);
  // 有具体证据（代码块 / 通过计数）→ 不命中。
  assert.equal(claimsVerificationWithoutEvidence('```\n12 passed\n```'), false);
  assert.equal(hasConcreteEvidence('测试通过（9/9）'), true);
  assert.equal(hasConcreteEvidence('我完成了。'), false);
});

test('verificationCommandRan：真正跑过验证命令才算', () => {
  assert.equal(
    verificationCommandRan([
      { tool: 'ShellCommand', params: { command: 'npm test' }, success: true },
    ]),
    true
  );
  assert.equal(verificationCommandRan([{ tool: 'ReadFile', params: { path: 'a.js' } }]), false);
  assert.equal(verificationCommandRan([]), false);
  assert.equal(verificationCommandRan(null), false);
});

// ── incompleteSteps ──────────────────────────────────────────────────
test('incompleteSteps：只认 completed 为完成，其余保守视为未完成', () => {
  assert.deepEqual(incompleteSteps([]), []);
  const steps = [
    { label: 'a', status: 'completed' },
    { label: 'b', status: 'pending' },
    { label: 'c', status: 'in_progress' },
    { label: 'd', status: 'skipped' },
  ];
  const inc = incompleteSteps(steps);
  assert.equal(inc.length, 2);
  assert.deepEqual(inc.map((s) => s.label), ['b', 'c']);
});

// ── resolveMaxRedrives ───────────────────────────────────────────────
test('resolveMaxRedrives：默认 1，clamp [0,6]，env 可覆盖', () => {
  assert.equal(resolveMaxRedrives(undefined, {}), 1);
  assert.equal(resolveMaxRedrives(3, {}), 3);
  assert.equal(resolveMaxRedrives(99, {}), 6);
  assert.equal(resolveMaxRedrives(-1, {}), 1);
  assert.equal(resolveMaxRedrives(undefined, { KHY_TASK_CLOSURE_REDRIVE_MAX: '2' }), 2);
});

// ── decideClosure：单一权威有界仲裁 ──────────────────────────────────
test('decideClosure：终态交付 + 无未完成步骤 → close', () => {
  const r = decideClosure({
    reply: '任务全部完成，结果如下：xx 已创建。',
    planSteps: [{ label: 'a', status: 'completed' }],
    toolCallLog: [{ tool: 'ShellCommand', params: { command: 'npm test' }, success: true }],
    redriveCount: 0,
    taskDescription: '做 X',
  });
  assert.equal(r.action, 'close');
  assert.equal(r.reason, 'concluded');
});

test('decideClosure：阶段性小结（未来时遮蔽）→ redrive 而非 close', () => {
  const r = decideClosure({
    reply: '已完成第一步，接下来我将重构整个模块。',
    planSteps: [],
    redriveCount: 0,
    taskDescription: '做 X',
  });
  assert.equal(r.action, 'redrive');
  assert.ok(r.message.includes('终态交付结论'));
});

test('decideClosure：完成态但缺证据 → 有界 redrive；预算耗尽 → close_partial(诚实降级)', () => {
  const base = {
    reply: '已验证通过。', // 声称验证却无证据
    planSteps: [],
    toolCallLog: [], // 没真跑过验证命令
    taskDescription: '做 X',
  };
  assert.equal(decideClosure({ ...base, redriveCount: 0 }).action, 'redrive');
  const exhausted = decideClosure({ ...base, redriveCount: 1, maxRedrives: 1 });
  assert.equal(exhausted.action, 'close_partial');
  assert.equal(exhausted.reason, 'established-but-unclean-exhausted');
  assert.ok(exhausted.note.includes('未经证实'));
});

test('decideClosure：未完成步骤 → redrive；耗尽 → close_partial(留缺口清单)', () => {
  const steps = [
    { label: '步骤一', status: 'completed' },
    { label: '步骤二', status: 'pending' },
  ];
  const base = { reply: '任务全部完成。', planSteps: steps, redriveCount: 0, taskDescription: '做 X' };
  assert.equal(decideClosure(base).action, 'redrive');
  const exhausted = decideClosure({ ...base, redriveCount: 2, maxRedrives: 2 });
  assert.equal(exhausted.action, 'close_partial');
  assert.ok(exhausted.note.includes('步骤二'));
});

// ── 绝不抛 / 确定性 ─────────────────────────────────────────────────
test('绝不抛：坏输入返安全默认', () => {
  // eslint-disable-next-line no-unused-expressions
  [null, undefined, 42, {}, []].forEach((bad) => {
    assert.doesNotThrow(() => isFinalDelivery(bad));
  });
  // 空输入 + 预算未尽 → redrive(要求给出收尾结论);预算耗尽 → close_partial(诚实降级),绝不抛。
  assert.doesNotThrow(() => decideClosure({}));
  assert.equal(decideClosure({}).action, 'redrive');
  assert.equal(decideClosure({ redriveCount: 9, maxRedrives: 1 }).action, 'close_partial');
  assert.doesNotThrow(() => buildRedriveMessage(null));
  assert.doesNotThrow(() => buildPartialDeliveryNote(null));
});

test('确定性：同输入 → 同输出', () => {
  const a = decideClosure({ reply: '任务全部完成。', planSteps: [], redriveCount: 0 });
  const b = decideClosure({ reply: '任务全部完成。', planSteps: [], redriveCount: 0 });
  assert.equal(a.action, b.action);
  assert.equal(a.reason, b.reason);
});

// ── wiring grep ─────────────────────────────────────────────────────
test('wiring：toolUseLoopCore 已将收尾判定路由到 taskClosure.isFinalDelivery', () => {
  const loop = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/toolUseLoopCore.js'), 'utf8');
  assert.ok(loop.includes("require('./taskClosure')"), '懒加载叶子');
  assert.ok(loop.includes('_looksConcluded'), 'fail-soft 判定 helper');
  assert.ok(loop.includes('const hasConclusion = _looksConcluded(strippedReply)'), '两处接线');
  const count = loop.split('const hasConclusion = _looksConcluded(strippedReply)').length - 1;
  assert.equal(count, 2, '替换了两处脆弱 hasConclusion 正则');
});
