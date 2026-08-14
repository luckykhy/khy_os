'use strict';

/**
 * evolutionPolicy.test.js — 纯叶子 evolutionPolicy 的 node:test 覆盖。
 * 覆盖:可变性分级、级联推导、改动集评估(blocked)、门控关字节回退、
 * 自修复 decideOutcome 的进化分支(不可变→阻断 / 联动→告警 / 门控关不变)、
 * transactionRunner 集成(不可变改动 → 回滚,即使无可校验源)。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const evo = require('../src/services/evolutionPolicy');
const leaf = require('../src/services/selfRepairTransaction');

const ON = { KHY_EVOLUTION_POLICY: '1' };
const OFF = { KHY_EVOLUTION_POLICY: 'off' };

// ── 分级 ────────────────────────────────────────────────────────────
test('classifyPath: 内核/安全机器/法律/机密 → IMMUTABLE', () => {
  assert.equal(evo.classifyPath('kernel/src/sched.c').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('services/backend/src/services/evolutionPolicy.js').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('services/backend/src/services/selfRepairTransaction.js').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('services/backend/src/services/selfRepair/primitives.js').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('scripts/check-leaf-contract.js').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('scripts/lib/leafContractGuard.js').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('LICENSE').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('.env').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('config/server.key').tier, evo.TIERS.IMMUTABLE);
});

test('classifyPath: 绝对路径前缀也能命中(段匹配)', () => {
  assert.equal(evo.classifyPath('/home/u/Khy-OS/kernel/boot.s').tier, evo.TIERS.IMMUTABLE);
  assert.equal(evo.classifyPath('C:\\repo\\kernel\\mm.c').tier, evo.TIERS.IMMUTABLE);
});

test('classifyPath: SSOT 常量/打包/CI/.ai 契约 → GUARDED', () => {
  assert.equal(evo.classifyPath('services/backend/src/constants/models.js').tier, evo.TIERS.GUARDED);
  assert.equal(evo.classifyPath('setup.py').tier, evo.TIERS.GUARDED);
  assert.equal(evo.classifyPath('package.json').tier, evo.TIERS.GUARDED);
  assert.equal(evo.classifyPath('.github/workflows/ci.yml').tier, evo.TIERS.GUARDED);
  assert.equal(evo.classifyPath('.ai/GUARDS.md').tier, evo.TIERS.GUARDED);
});

test('classifyPath: 业务源/应用/文档/测试/派生骨架 → EVOLVABLE', () => {
  assert.equal(evo.classifyPath('services/backend/src/services/webSearchService.js').tier, evo.TIERS.EVOLVABLE);
  assert.equal(evo.classifyPath('apps/ai-frontend/src/App.vue').tier, evo.TIERS.EVOLVABLE);
  assert.equal(evo.classifyPath('docs/readme.md').tier, evo.TIERS.EVOLVABLE);
  assert.equal(evo.classifyPath('services/backend/tests/foo.test.js').tier, evo.TIERS.EVOLVABLE);
  assert.equal(evo.classifyPath('.ai/SKELETON.auto.md').tier, evo.TIERS.EVOLVABLE);
});

test('classifyPath: .env.example 是模板(可变),不是机密', () => {
  assert.notEqual(evo.classifyPath('.env.example').tier, evo.TIERS.IMMUTABLE);
});

test('classifyPath: 未匹配 → UNKNOWN(不阻断)', () => {
  const c = evo.classifyPath('some/random/path.bin');
  assert.equal(c.tier, evo.TIERS.UNKNOWN);
});

test('classifyPath: 空/非法输入 fail-soft', () => {
  assert.equal(evo.classifyPath('').tier, evo.TIERS.UNKNOWN);
  assert.equal(evo.classifyPath(null).tier, evo.TIERS.UNKNOWN);
  assert.equal(evo.classifyPath(undefined).tier, evo.TIERS.UNKNOWN);
});

// ── 级联 ────────────────────────────────────────────────────────────
test('deriveCascades: commandSchema 改但 router 未改 → 未满足', () => {
  const cs = evo.deriveCascades(['services/backend/src/constants/commandSchema.js']);
  const wiring = cs.find((c) => c.id === 'command-wiring');
  assert.ok(wiring);
  assert.equal(wiring.satisfied, false);
});

test('deriveCascades: commandSchema + router 同改 → 满足', () => {
  const cs = evo.deriveCascades([
    'services/backend/src/constants/commandSchema.js',
    'services/backend/src/cli/router.js',
  ]);
  const wiring = cs.find((c) => c.id === 'command-wiring');
  assert.equal(wiring.satisfied, true);
});

test('deriveCascades: 改叶子无对应 test → leaf-test 未满足;同改其 test → 满足', () => {
  const noTest = evo.deriveCascades(['services/backend/src/services/fooLeaf.js']);
  const lt1 = noTest.find((c) => c.id === 'leaf-test');
  assert.ok(lt1 && lt1.satisfied === false);

  const withTest = evo.deriveCascades([
    'services/backend/src/services/fooLeaf.js',
    'services/backend/tests/fooLeaf.test.js',
  ]);
  const lt2 = withTest.find((c) => c.id === 'leaf-test');
  assert.ok(lt2 && lt2.satisfied === true);
});

test('deriveCascades: 改后端源 → wheel-rebuild 动作提醒', () => {
  const cs = evo.deriveCascades(['services/backend/src/services/x.js']);
  assert.ok(cs.some((c) => c.id === 'wheel-rebuild' && c.kind === 'action'));
});

test('deriveCascades: 不可变叶子不触发 leaf-test 噪声', () => {
  const cs = evo.deriveCascades(['services/backend/src/services/evolutionPolicy.js']);
  assert.ok(!cs.some((c) => c.id === 'leaf-test'));
});

// ── 评估 ────────────────────────────────────────────────────────────
test('assessEvolution: 触碰不可变 → blocked', () => {
  const a = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c', 'apps/x.vue'], env: ON });
  assert.equal(a.enabled, true);
  assert.equal(a.blocked, true);
  assert.equal(a.immutable.length, 1);
  assert.equal(a.immutable[0].file, 'kernel/src/sched.c');
});

test('assessEvolution: 只改可进化 → 不 blocked', () => {
  const a = evo.assessEvolution({ changedFiles: ['services/backend/src/services/x.js'], env: ON });
  assert.equal(a.blocked, false);
});

test('assessEvolution: 门控关 → 安全空评估(enabled:false, blocked:false)', () => {
  const a = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c'], env: OFF });
  assert.equal(a.enabled, false);
  assert.equal(a.blocked, false);
  assert.deepEqual(a.immutable, []);
});

test('assessEvolution: 入参非法 fail-soft', () => {
  const a = evo.assessEvolution({ changedFiles: null, env: ON });
  assert.equal(a.blocked, false);
  assert.deepEqual(a.immutable, []);
});

// ── 指令构建 ─────────────────────────────────────────────────────────
test('buildEvolutionDirective: 不可变触碰列入禁止段', () => {
  const a = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c'], env: ON });
  const d = evo.buildEvolutionDirective(a);
  assert.match(d, /\[SYSTEM:进化策略\]/);
  assert.match(d, /禁止改动/);
  assert.match(d, /kernel\/src\/sched\.c/);
});

test('buildEvolutionDirective: 门控关 → 空串', () => {
  const a = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c'], env: OFF });
  assert.equal(evo.buildEvolutionDirective(a), '');
});

test('buildPolicyDirective: 门控开有地形图,关则空', () => {
  assert.match(evo.buildPolicyDirective(ON), /IMMUTABLE/);
  assert.equal(evo.buildPolicyDirective(OFF), '');
});

// ── 自修复 decideOutcome 的进化分支 ──────────────────────────────────
test('decideOutcome: 进化评估含不可变触碰 → keep:false(阻断回滚)', () => {
  const evolution = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c'], env: ON });
  const d = leaf.decideOutcome({ syntax: [], guards: [], evolution }, ON);
  assert.equal(d.keep, false);
  assert.ok(d.failures.some((f) => /不可变区域被改动/.test(f)));
});

test('decideOutcome: 联动缺口 → 非阻断告警(keep:true)', () => {
  const evolution = evo.assessEvolution({
    changedFiles: ['services/backend/src/constants/commandSchema.js'], env: ON,
  });
  const d = leaf.decideOutcome({ syntax: [], guards: [], evolution }, ON);
  assert.equal(d.keep, true);
  assert.ok(d.warnings.some((w) => /联动缺口/.test(w)));
});

test('decideOutcome: 门控关时进化字段被忽略(字节回退)', () => {
  // evolution.enabled=false → decideOutcome 不读不写,结果与无 evolution 完全一致。
  const evolution = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c'], env: OFF });
  const withEvo = leaf.decideOutcome({ syntax: [], guards: [], evolution }, OFF);
  const without = leaf.decideOutcome({ syntax: [], guards: [] }, OFF);
  assert.equal(withEvo.keep, without.keep);
  assert.deepEqual(withEvo.failures, without.failures);
  assert.deepEqual(withEvo.warnings, without.warnings);
});

// ── transactionRunner 集成:不可变改动 → 回滚(即使无可校验源)──────────
test('transactionRunner: fix 改了不可变内核文件 → 回滚,filesModified 不计', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  let restored = false;
  const res = await runRepairTransaction({
    env: { ...ON, KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'edited kernel', filesModified: ['kernel/src/sched.c'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => { restored = true; return true; },
    validateFiles: async () => ({ syntax: [], guards: [] }),
  });
  assert.equal(restored, true, '应触发回滚');
  assert.equal(res.transaction.decision.keep, false);
  assert.ok(res.transaction.decision.failures.some((f) => /不可变区域/.test(f)));
});

test('transactionRunner: fix 只改可进化源 → 保留(不回滚)', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  let restored = false;
  const res = await runRepairTransaction({
    env: { ...ON, KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'fixed', filesModified: ['services/backend/src/services/x.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => { restored = true; return true; },
    validateFiles: async () => ({ syntax: [], guards: [] }),
  });
  assert.equal(restored, false, '不应回滚');
  assert.equal(res.transaction.decision.keep, true);
});

// ── 规则正本元数据(明确陈述)────────────────────────────────────────
test('describePolicy: 暴露版本/范围/不变量/执行点/越权通道(规则正本)', () => {
  const p = evo.describePolicy();
  assert.equal(typeof p.version, 'string');
  assert.ok(p.version.length > 0);
  assert.ok(p.scope && p.scope.governs && p.scope.notGoverns);
  assert.ok(Array.isArray(p.invariants) && p.invariants.length >= 3);
  assert.ok(Array.isArray(p.enforcement) && p.enforcement.length >= 1);
  assert.equal(p.override.gate, 'KHY_EVOLUTION_OVERRIDE');
  assert.equal(p.override.default, 'off');
  // 三条永不可越权规则必须如实陈述。
  for (const r of ['safety-machinery', 'secrets', 'legal-policy']) {
    assert.ok(p.override.nonOverridable.includes(r), `${r} 应在 nonOverridable`);
  }
});

test('buildPolicyDirective: 主动地形图陈述范围与越权例外', () => {
  const d = evo.buildPolicyDirective(ON);
  assert.match(d, /不限制人类维护者/);
  assert.match(d, /KHY_EVOLUTION_OVERRIDE/);
  assert.match(d, /永不可越权/);
});

// ── 有意识越权(KHY_EVOLUTION_OVERRIDE)──────────────────────────────
const OVR = (val) => ({ KHY_EVOLUTION_POLICY: '1', KHY_EVOLUTION_OVERRIDE: val });

test('overrideAllowlist: 默认空 = 无越权;解析规则名与路径片段', () => {
  assert.deepEqual([...evo.overrideAllowlist({ KHY_EVOLUTION_OVERRIDE: '' }).rules], []);
  assert.deepEqual([...evo.overrideAllowlist({}).rules], []);
  const al = evo.overrideAllowlist({ KHY_EVOLUTION_OVERRIDE: 'kernel-abi, kernel/src/foo.c' });
  assert.ok(al.rules.has('kernel-abi'));
  assert.ok(al.paths.includes('kernel/src/foo.c'));
});

test('isOverrideAuthorized: 按规则名授权 kernel-abi;非可越权规则恒拒绝', () => {
  assert.equal(evo.isOverrideAuthorized('kernel-abi', 'kernel/src/sched.c', OVR('kernel-abi')), true);
  // 刹车的刹车:即便显式列入也拒绝。
  assert.equal(evo.isOverrideAuthorized('safety-machinery', 'scripts/check-leaf-contract.js', OVR('safety-machinery')), false);
  assert.equal(evo.isOverrideAuthorized('secrets', '.env', OVR('secrets')), false);
  assert.equal(evo.isOverrideAuthorized('legal-policy', 'LICENSE', OVR('legal-policy')), false);
  // 未授权 → false。
  assert.equal(evo.isOverrideAuthorized('kernel-abi', 'kernel/src/sched.c', OVR('off')), false);
});

test('assessEvolution: 授权越权 kernel-abi → 不 blocked,但仍列入 immutable(留痕 overridden)', () => {
  const a = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c'], env: OVR('kernel-abi') });
  assert.equal(a.blocked, false, '已授权越权不阻断');
  assert.equal(a.immutable.length, 1);
  assert.equal(a.immutable[0].overridden, true);
  assert.equal(a.overrides.length, 1);
});

test('assessEvolution: 越权只授权 kernel-abi 时,改安全守卫仍 blocked(非可越权)', () => {
  const a = evo.assessEvolution({
    changedFiles: ['kernel/src/sched.c', 'scripts/lib/leafContractGuard.js'],
    env: OVR('kernel-abi'),
  });
  assert.equal(a.blocked, true, '存在未越权的不可变触碰');
  const guardHit = a.immutable.find((im) => im.rule === 'safety-machinery');
  assert.ok(guardHit && guardHit.overridden === false);
});

test('assessEvolution: 越权门控关时 overridden 恒假(字节回退)', () => {
  const a = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c'], env: ON });
  assert.equal(a.blocked, true);
  assert.equal(a.immutable[0].overridden, false);
});

// ── decideOutcome:授权越权 → 审计告警而非回滚 ───────────────────────
test('decideOutcome: 授权越权的不可变触碰 → keep:true + 审计告警', () => {
  const evolution = evo.assessEvolution({ changedFiles: ['kernel/src/sched.c'], env: OVR('kernel-abi') });
  const d = leaf.decideOutcome({ syntax: [], guards: [], evolution }, OVR('kernel-abi'));
  assert.equal(d.keep, true, '已授权越权不回滚');
  assert.ok(d.warnings.some((w) => /已授权越权/.test(w)));
  assert.ok(!d.failures.some((f) => /不可变区域被改动/.test(f)));
});

test('decideOutcome: 非可越权(safety-machinery)即便列入白名单仍 keep:false', () => {
  const evolution = evo.assessEvolution({
    changedFiles: ['scripts/lib/leafContractGuard.js'], env: OVR('safety-machinery'),
  });
  const d = leaf.decideOutcome({ syntax: [], guards: [], evolution }, OVR('safety-machinery'));
  assert.equal(d.keep, false, '刹车的刹车不可越权');
  assert.ok(d.failures.some((f) => /不可变区域被改动/.test(f)));
});

test('transactionRunner: 授权越权改内核 → 保留(不回滚)+ 审计留痕', async () => {
  const { runRepairTransaction } = require('../src/services/selfRepair/transactionRunner');
  let restored = false;
  const res = await runRepairTransaction({
    env: { ...OVR('kernel-abi'), KHY_SELF_REPAIR_TRANSACTION: '1' },
    runFix: async () => ({ text: 'edited kernel (authorized)', filesModified: ['kernel/src/sched.c'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'HEAD' }),
    restore: async () => { restored = true; return true; },
    validateFiles: async () => ({ syntax: [], guards: [] }),
  });
  assert.equal(restored, false, '已授权越权不应回滚');
  assert.equal(res.transaction.decision.keep, true);
  assert.ok(res.transaction.decision.warnings.some((w) => /已授权越权/.test(w)));
});
