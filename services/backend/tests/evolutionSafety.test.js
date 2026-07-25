'use strict';

/**
 * evolutionSafety.test.js — 纯叶子 evolutionSafety 的 node:test 覆盖。
 * 覆盖:行为源判定、测试映射 SSOT、node:test 判定(防 jest 地雷)、覆盖率评估、
 * 安全裁决(验证通过 / 回归阻断 / 未验证告警 / enforce 升级)、主动清单 / 事后报告 /
 * describeSafety、门控关字节回退;以及 decideOutcome + transactionRunner 集成。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const safety = require('../src/services/evolutionSafety');
const leaf = require('../src/services/selfRepairTransaction');

const ON = { KHY_EVOLUTION_SAFETY: '1' };
const OFF = { KHY_EVOLUTION_SAFETY: 'off' };
const ENFORCE = { KHY_EVOLUTION_SAFETY: '1', KHY_EVOLUTION_SAFETY_ENFORCE: '1' };

// ── 门控 ────────────────────────────────────────────────────────────
test('isEnabled: 默认开,仅 {0,false,off,no} 关', () => {
  assert.equal(safety.isEnabled({}), true);
  assert.equal(safety.isEnabled({ KHY_EVOLUTION_SAFETY: '1' }), true);
  assert.equal(safety.isEnabled({ KHY_EVOLUTION_SAFETY: 'off' }), false);
  assert.equal(safety.isEnabled({ KHY_EVOLUTION_SAFETY: '0' }), false);
  assert.equal(safety.isEnabled({ KHY_EVOLUTION_SAFETY: 'no' }), false);
});

test('isEnforce: 默认关', () => {
  assert.equal(safety.isEnforce({}), false);
  assert.equal(safety.isEnforce({ KHY_EVOLUTION_SAFETY_ENFORCE: '1' }), true);
  assert.equal(safety.isEnforce({ KHY_EVOLUTION_SAFETY_ENFORCE: 'off' }), false);
});

// ── 行为源 / 测试文件判定 ─────────────────────────────────────────────
test('isBehavioralSource: 代码源是,测试/数据/文档不是', () => {
  assert.equal(safety.isBehavioralSource('services/backend/src/services/x.js'), true);
  assert.equal(safety.isBehavioralSource('apps/ai-frontend/src/App.vue'), false); // .vue 不在 CODE_EXTS
  assert.equal(safety.isBehavioralSource('services/backend/src/a.ts'), true);
  assert.equal(safety.isBehavioralSource('services/backend/tests/x.test.js'), false);
  assert.equal(safety.isBehavioralSource('services/backend/tests/x.spec.ts'), false);
  assert.equal(safety.isBehavioralSource('config/data.json'), false);
  assert.equal(safety.isBehavioralSource('docs/readme.md'), false);
  assert.equal(safety.isBehavioralSource(''), false);
  assert.equal(safety.isBehavioralSource(null), false);
});

test('isBehavioralSource: 仅限 services/backend/src/(约定成立区),范围外代码不算', () => {
  // 前端 / platform / scripts 各有自己的测试运行器,不映射到 services/backend/tests。
  assert.equal(safety.isBehavioralSource('apps/ai-frontend/src/composables/useGateway.js'), false);
  assert.equal(safety.isBehavioralSource('platform/packages/shared/src/runtime/khyos/diskImage.js'), false);
  assert.equal(safety.isBehavioralSource('scripts/check-agent-rules.js'), false);
  assert.equal(safety.candidateTestFor('apps/ai-frontend/src/composables/useGateway.js'), null);
});

test('isTestFile: *.test.* / *.spec.* 命中', () => {
  assert.equal(safety.isTestFile('tests/foo.test.js'), true);
  assert.equal(safety.isTestFile('tests/foo.spec.ts'), true);
  assert.equal(safety.isTestFile('foo.test.mjs'), true);
  assert.equal(safety.isTestFile('foo.js'), false);
});

// ── 测试映射 SSOT ───────────────────────────────────────────────────
test('candidateTestFor: 行为源 → services/backend/tests/<stem>.test.js;非行为源 → null', () => {
  assert.equal(
    safety.candidateTestFor('services/backend/src/services/webSearchService.js'),
    'services/backend/tests/webSearchService.test.js',
  );
  assert.equal(safety.candidateTestFor('kernel/src/sched.c'), null);
  assert.equal(safety.candidateTestFor('tests/x.test.js'), null);
});

test('selectAffectedTests: 只挑行为源,去重', () => {
  const sel = safety.selectAffectedTests([
    'services/backend/src/services/a.js',
    'services/backend/src/services/a.js', // dup
    'docs/x.md',
    'services/backend/tests/a.test.js',
  ]);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].file, 'services/backend/src/services/a.js');
  assert.equal(sel[0].candidate, 'services/backend/tests/a.test.js');
});

// ── node:test 判定(防 jest 地雷)──────────────────────────────────
test('isNodeTestSource: 引用 node:test 为真,jest 风格为假', () => {
  assert.equal(safety.isNodeTestSource("const { test } = require('node:test');"), true);
  assert.equal(safety.isNodeTestSource('import { test } from "node:test";'), true);
  assert.equal(safety.isNodeTestSource("describe('x', () => { it('y', () => {}); });"), false);
  assert.equal(safety.isNodeTestSource(''), false);
  assert.equal(safety.isNodeTestSource(null), false);
});

// ── 覆盖率评估 ───────────────────────────────────────────────────────
test('assessCoverage: 有可运行测试 → covered;无 → uncovered', () => {
  const cov = safety.assessCoverage({
    changedFiles: [
      'services/backend/src/services/a.js',
      'services/backend/src/services/b.js',
      'docs/x.md',
    ],
    runnableTests: ['services/backend/tests/a.test.js'],
  });
  assert.deepEqual(cov.behavioral, ['services/backend/src/services/a.js', 'services/backend/src/services/b.js']);
  assert.deepEqual(cov.covered, ['services/backend/src/services/a.js']);
  assert.deepEqual(cov.uncovered, ['services/backend/src/services/b.js']);
});

test('assessCoverage: 无 runnableTests → 全部行为源 uncovered', () => {
  const cov = safety.assessCoverage({ changedFiles: ['services/backend/src/services/a.js'] });
  assert.deepEqual(cov.uncovered, ['services/backend/src/services/a.js']);
});

// ── classifyTests ───────────────────────────────────────────────────
test('classifyTests: ran/passed/failed 归一', () => {
  assert.deepEqual(safety.classifyTests({ ran: true, ok: true }), { ran: true, passed: true, failed: false, summary: '' });
  assert.equal(safety.classifyTests({ ran: true, ok: false }).failed, true);
  assert.equal(safety.classifyTests({ ran: false }).passed, false);
  assert.equal(safety.classifyTests(null).ran, false);
});

// ── requiresVerification ────────────────────────────────────────────
test('requiresVerification: 门控开 + 有行为源 → true;无行为源或门控关 → false', () => {
  assert.equal(safety.requiresVerification({ changedFiles: ['services/backend/src/services/a.js'], env: ON }), true);
  assert.equal(safety.requiresVerification({ changedFiles: ['docs/x.md'], env: ON }), false);
  assert.equal(safety.requiresVerification({ changedFiles: ['services/backend/src/services/a.js'], env: OFF }), false);
});

// ── assessSafety ────────────────────────────────────────────────────
test('assessSafety: 行为改动经测试通过且全覆盖 → verified', () => {
  const a = safety.assessSafety({
    changedFiles: ['services/backend/src/services/a.js'],
    tests: { ran: true, ok: true },
    coverage: { behavioral: ['services/backend/src/services/a.js'], covered: ['services/backend/src/services/a.js'], uncovered: [] },
    env: ON,
  });
  assert.equal(a.enabled, true);
  assert.equal(a.verified, true);
  assert.deepEqual(a.blockers, []);
});

test('assessSafety: 测试跑了且失败 → blocker(回归),not verified', () => {
  const a = safety.assessSafety({
    changedFiles: ['services/backend/src/services/a.js'],
    tests: { ran: true, ok: false, summary: '1 failing' },
    coverage: { behavioral: ['services/backend/src/services/a.js'], covered: ['services/backend/src/services/a.js'], uncovered: [] },
    env: ON,
  });
  assert.equal(a.verified, false);
  assert.equal(a.blockers.length, 1);
  assert.match(a.blockers[0], /回归/);
});

test('assessSafety: 行为改动无测试覆盖 → 默认 warning(非 blocker)', () => {
  const a = safety.assessSafety({
    changedFiles: ['services/backend/src/services/a.js'],
    tests: { ran: false },
    coverage: { behavioral: ['services/backend/src/services/a.js'], covered: [], uncovered: ['services/backend/src/services/a.js'] },
    env: ON,
  });
  assert.equal(a.verified, false);
  assert.deepEqual(a.blockers, []);
  assert.equal(a.warnings.length, 1);
  assert.deepEqual(a.unverified, ['services/backend/src/services/a.js']);
});

test('assessSafety: enforce 开 → 未覆盖升级为 blocker', () => {
  const a = safety.assessSafety({
    changedFiles: ['services/backend/src/services/a.js'],
    coverage: { behavioral: ['services/backend/src/services/a.js'], covered: [], uncovered: ['services/backend/src/services/a.js'] },
    env: ENFORCE,
  });
  assert.equal(a.enforce, true);
  assert.equal(a.blockers.length, 1);
  assert.deepEqual(a.warnings, []);
});

test('assessSafety: 无行为源改动 → verified(无需验证)', () => {
  const a = safety.assessSafety({ changedFiles: ['docs/x.md'], env: ON });
  assert.equal(a.verified, true);
  assert.match(a.summary, /无行为源改动/);
});

test('assessSafety: 门控关 → 安全空(enabled:false)', () => {
  const a = safety.assessSafety({ changedFiles: ['services/backend/src/services/a.js'], env: OFF });
  assert.equal(a.enabled, false);
  assert.deepEqual(a.blockers, []);
  assert.deepEqual(a.unverified, []);
});

test('assessSafety: 入参非法 fail-soft', () => {
  const a = safety.assessSafety({ changedFiles: null, env: ON });
  assert.equal(a.enabled, true);
  assert.deepEqual(a.blockers, []);
});

// ── 指令构建 ─────────────────────────────────────────────────────────
test('buildSafetyChecklist: 门控开有清单(含写测试/回归/最小可逆),关则空', () => {
  const d = safety.buildSafetyChecklist(ON);
  assert.match(d, /\[SYSTEM:进化安全\]/);
  assert.match(d, /写或扩一个对应测试/);
  assert.match(d, /回归/);
  assert.equal(safety.buildSafetyChecklist(OFF), '');
});

test('buildSafetyReport: 阻断 + 未验证分列;无可说为空', () => {
  const a = safety.assessSafety({
    changedFiles: ['services/backend/src/services/a.js'],
    tests: { ran: true, ok: false, summary: 'x' },
    coverage: { behavioral: ['services/backend/src/services/a.js', 'services/backend/src/services/b.js'], covered: ['services/backend/src/services/a.js'], uncovered: ['services/backend/src/services/b.js'] },
    env: ON,
  });
  const r = safety.buildSafetyReport(a);
  assert.match(r, /阻断/);
  assert.match(r, /未验证/);
  // 门控关 → 空。
  const off = safety.assessSafety({ changedFiles: ['services/backend/src/services/a.js'], env: OFF });
  assert.equal(safety.buildSafetyReport(off), '');
});

test('describeSafety: 暴露门控/保证/分层/地雷防护', () => {
  const s = safety.describeSafety();
  assert.equal(s.gate, 'KHY_EVOLUTION_SAFETY');
  assert.equal(s.enforceGate, 'KHY_EVOLUTION_SAFETY_ENFORCE');
  assert.ok(typeof s.guarantee === 'string' && s.guarantee.length > 0);
  assert.ok(Array.isArray(s.layers) && s.layers.length >= 5);
  assert.match(s.landmine, /jest/);
});

// ── decideOutcome 集成(加性安全分支)────────────────────────────────
test('decideOutcome: 安全未验证(默认) → 非阻断告警(keep:true)', () => {
  const safetyAssessment = safety.assessSafety({
    changedFiles: ['services/backend/src/services/a.js'],
    coverage: { behavioral: ['services/backend/src/services/a.js'], covered: [], uncovered: ['services/backend/src/services/a.js'] },
    env: ON,
  });
  const d = leaf.decideOutcome({ syntax: [], guards: [], safety: safetyAssessment }, ON);
  assert.equal(d.keep, true);
  assert.ok(d.warnings.some((w) => /行为未经验证/.test(w)));
});

test('decideOutcome: enforce 下安全未验证 → 阻断(keep:false)', () => {
  const safetyAssessment = safety.assessSafety({
    changedFiles: ['services/backend/src/services/a.js'],
    coverage: { behavioral: ['services/backend/src/services/a.js'], covered: [], uncovered: ['services/backend/src/services/a.js'] },
    env: ENFORCE,
  });
  const d = leaf.decideOutcome({ syntax: [], guards: [], safety: safetyAssessment }, ENFORCE);
  assert.equal(d.keep, false);
  assert.ok(d.failures.some((f) => /行为未经验证/.test(f)));
});

test('decideOutcome: 安全门控关时被忽略(字节回退)', () => {
  const safetyAssessment = safety.assessSafety({ changedFiles: ['services/backend/src/services/a.js'], env: OFF });
  const withS = leaf.decideOutcome({ syntax: [], guards: [], safety: safetyAssessment }, OFF);
  const without = leaf.decideOutcome({ syntax: [], guards: [] }, OFF);
  assert.equal(withS.keep, without.keep);
  assert.deepEqual(withS.failures, without.failures);
  assert.deepEqual(withS.warnings, without.warnings);
});

// ── transactionRunner 集成 ──────────────────────────────────────────
test('transactionRunner: 门控开 + 行为源改动 → 强制 runTests=true 传给 validateFiles', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  let seenPlan = null;
  await runRepairTransaction({
    env: { ...ON, KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'fix', filesModified: ['services/backend/src/services/x.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => true,
    validateFiles: async (files, plan) => { seenPlan = plan; return { syntax: [], guards: [], tests: { ran: false, ok: true } }; },
  });
  assert.ok(seenPlan, 'validateFiles 应被调用');
  assert.equal(seenPlan.runTests, true, '行为源改动应强制 runTests');
});

test('transactionRunner: 安全门控关 → 不强制 runTests(字节回退)', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  let seenPlan = null;
  await runRepairTransaction({
    env: { ...OFF, KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'fix', filesModified: ['services/backend/src/services/x.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => true,
    validateFiles: async (files, plan) => { seenPlan = plan; return { syntax: [], guards: [] }; },
  });
  assert.ok(seenPlan);
  assert.notEqual(seenPlan.runTests, true, '门控关时不应强制 runTests');
});

test('transactionRunner: 受影响测试失败 → 回滚(由 v.tests 阻断,安全层不重复但裁决一致)', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  let restored = false;
  const res = await runRepairTransaction({
    env: { ...ON, KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'fix', filesModified: ['services/backend/src/services/x.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => { restored = true; return true; },
    validateFiles: async () => ({
      syntax: [], guards: [],
      tests: { ran: true, ok: false, summary: '1 failing' },
      coverage: { behavioral: ['services/backend/src/services/x.js'], covered: ['services/backend/src/services/x.js'], uncovered: [] },
    }),
  });
  assert.equal(restored, true, '测试失败应回滚');
  assert.equal(res.transaction.decision.keep, false);
});

test('transactionRunner: 行为改动未覆盖(默认) → 保留 + 告警(不回滚)', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  let restored = false;
  const res = await runRepairTransaction({
    env: { ...ON, KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'fix', filesModified: ['services/backend/src/services/x.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => { restored = true; return true; },
    validateFiles: async () => ({
      syntax: [], guards: [],
      tests: { ran: false, ok: true },
      coverage: { behavioral: ['services/backend/src/services/x.js'], covered: [], uncovered: ['services/backend/src/services/x.js'] },
    }),
  });
  assert.equal(restored, false, '未覆盖默认不回滚(只告警)');
  assert.equal(res.transaction.decision.keep, true);
  assert.ok(res.transaction.decision.warnings.some((w) => /行为未经验证/.test(w)));
});

test('transactionRunner: 未覆盖时 repair_validate_done 事件携带 safetyReport(供 onEvent 消费)', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  const events = [];
  await runRepairTransaction({
    env: { ...ON, KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'fix', filesModified: ['services/backend/src/services/x.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => true,
    onEvent: (e) => events.push(e),
    validateFiles: async () => ({
      syntax: [], guards: [],
      tests: { ran: false, ok: true },
      coverage: { behavioral: ['services/backend/src/services/x.js'], covered: [], uncovered: ['services/backend/src/services/x.js'] },
    }),
  });
  const done = events.find((e) => e.type === 'repair_validate_done');
  assert.ok(done, '应发 repair_validate_done 事件');
  assert.match(done.safetyReport, /未验证/);
});

test('transactionRunner: enforce 下行为改动未覆盖 → 回滚', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  let restored = false;
  const res = await runRepairTransaction({
    env: { ...ENFORCE, KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'fix', filesModified: ['services/backend/src/services/x.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => { restored = true; return true; },
    validateFiles: async () => ({
      syntax: [], guards: [],
      tests: { ran: false, ok: true },
      coverage: { behavioral: ['services/backend/src/services/x.js'], covered: [], uncovered: ['services/backend/src/services/x.js'] },
    }),
  });
  assert.equal(restored, true, 'enforce 下未覆盖应回滚');
  assert.equal(res.transaction.decision.keep, false);
});
