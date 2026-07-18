'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// OPS-MAN-160 接线测试:characterizationSnapshot(行为特征化叶)→ falsePositiveFixGuard.finalize
//
// 断桥:characterizationSnapshot 能就地差分出「未覆盖文件上的静默行为漂移」
// (silentBehaviorChanges),falsePositiveFixGuard.finalize 也早就接受 ctx.silentBehaviorChanges,
// 但生产端从来没有任何代码把 baseline/current 快照喂给它去产出这些漂移 → 纯孤儿能力。
// 本轮接线:finalize 在 ctx.baseline && ctx.current 存在时,就地调用 characterizationSnapshot
// 差分静默漂移并入收口裁决;agenticHarnessService 把回归门(bugfixRegressionGate)已产出的
// baseline/current 验证快照透传进 finalize。
//
// gate:KHY_FPF_CHARACTERIZATION(default-on)。关 / 无快照 / 抛错 → silentBehaviorChanges 恒 []
// → 逐字节回退。纯叶 fail-soft。
//
// 本测全部走真实叶(finalize + characterizationSnapshot 皆零 IO 纯函数),无需 require.cache 桩。
// ─────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../src/services');
const guard = require(path.join(SRC, 'falsePositiveFixGuard'));

// ── 最小可达状态:命中 finalize 里 step-3 静默漂移分支所需的前提 ──
//   bugfixIntent + firstSrcEditIteration(有源码编辑)+ sawAnyRed(抑制 phantom 原因,
//   隔离出纯 silent-behavior-change 信号)+ editedSrcFiles。
function makeState({ sawAnyRed = true, reproObserved = false } = {}) {
  const st = guard.createState();
  st.bugfixIntent = true;
  st.firstSrcEditIteration = 1;
  st.editedSrcFiles = new Set(['src/foo.js']);
  st.sawAnyRed = sawAnyRed;
  if (reproObserved) st.reproByKey.set('k', { redAt: 1, greenAt: 2 });
  return st;
}

// baseline/current 快照:syntax 步 summary 从 v1→v2(内容漂移但 pass 不变)= 静默行为变化。
const BASELINE = { steps: [{ name: 'syntax', pass: true, summary: 'v1' }, { name: 'test', pass: true, summary: 't' }] };
const CURRENT = { steps: [{ name: 'syntax', pass: true, summary: 'v2' }, { name: 'test', pass: true, summary: 't' }] };

// KHY_FPF_UNCOVERED_BLOCKS 关:隔离 step-2「未覆盖阻断」原因,使 'silent-behavior-change'
// 的有无纯粹反映特征化接线。
function baseEnv(extra) {
  return Object.assign({ KHY_FPF_UNCOVERED_BLOCKS: 'off' }, extra);
}
function ctx(tier, extra) {
  return Object.assign(
    { tier, changedFiles: ['src/foo.js'], knownFiles: ['src/foo.js'], baseline: BASELINE, current: CURRENT },
    extra,
  );
}
const codes = (v) => v.reasons.map((r) => r.code);

test('WIRE high-tier:未覆盖文件静默漂移 + 门开 + 有快照 → 入裁决(caution)', () => {
  const v = guard.finalize(makeState(), ctx('high'), baseEnv({ KHY_FPF_CHARACTERIZATION: 'on' }));
  assert.ok(codes(v).includes('silent-behavior-change'), 'reasons 应含 silent-behavior-change');
  assert.strictEqual(v.verdict, 'caution', 'high tier 应为 caution');
  assert.strictEqual(v.silentBehaviorChanges.length, 1, '应就地差分出 1 条静默漂移');
});

test('WIRE low-tier:同样漂移 → block', () => {
  const v = guard.finalize(makeState(), ctx('low'), baseEnv({ KHY_FPF_CHARACTERIZATION: 'on' }));
  assert.ok(codes(v).includes('silent-behavior-change'));
  assert.strictEqual(v.verdict, 'block', 'low tier 应为 block');
});

test('BYTE-REVERT 门关(KHY_FPF_CHARACTERIZATION=off):即便有快照也不产静默原因', () => {
  const v = guard.finalize(makeState(), ctx('high'), baseEnv({ KHY_FPF_CHARACTERIZATION: 'off' }));
  assert.ok(!codes(v).includes('silent-behavior-change'), '门关不应有 silent 原因');
  assert.strictEqual(v.silentBehaviorChanges.length, 0, '门关 silentBehaviorChanges 恒 []');
});

test('BYTE-REVERT 无快照(既有调用方形状):不产静默原因', () => {
  const v = guard.finalize(
    makeState(),
    { tier: 'high', changedFiles: ['src/foo.js'], knownFiles: ['src/foo.js'] },
    baseEnv({ KHY_FPF_CHARACTERIZATION: 'on' }),
  );
  assert.ok(!codes(v).includes('silent-behavior-change'), '无 baseline/current 应逐字节回退');
});

test('SUPPRESS 全覆盖(改动文件有 sibling 测试):allCovered → 不算静默', () => {
  const v = guard.finalize(
    makeState(),
    ctx('low', { knownFiles: ['src/foo.js', 'src/foo.test.js'] }),
    baseEnv({ KHY_FPF_CHARACTERIZATION: 'on' }),
  );
  assert.ok(!codes(v).includes('silent-behavior-change'), '改动被 sibling 测试覆盖不应算静默漂移');
  assert.strictEqual(v.silentBehaviorChanges.length, 0);
});

test('SUPPRESS 仅测试步漂移:测试步视为已覆盖 → 不算静默', () => {
  const b2 = { steps: [{ name: 'syntax', pass: true, summary: 's' }, { name: 'test', pass: true, summary: 't1' }] };
  const c2 = { steps: [{ name: 'syntax', pass: true, summary: 's' }, { name: 'test', pass: true, summary: 't2' }] };
  const v = guard.finalize(
    makeState(),
    ctx('high', { baseline: b2, current: c2 }),
    baseEnv({ KHY_FPF_CHARACTERIZATION: 'on' }),
  );
  assert.ok(!codes(v).includes('silent-behavior-change'), '仅测试步漂移不应算静默');
});

test('SUPPRESS reproObserved(红→绿闭环):静默原因被抑制,verdict pass', () => {
  const v = guard.finalize(
    makeState({ reproObserved: true }),
    ctx('high'),
    baseEnv({ KHY_FPF_CHARACTERIZATION: 'on' }),
  );
  assert.ok(!codes(v).includes('silent-behavior-change'), 'reproObserved 应抑制静默原因');
  assert.strictEqual(v.verdict, 'pass', '真复现闭环 → pass');
});

test('PRECEDENCE 调用方已预算 ctx.silentBehaviorChanges → 优先,不就地差分', () => {
  const pre = [{ step: 'lint', from: 'pass', to: 'fail' }];
  const v = guard.finalize(
    makeState(),
    ctx('high', { silentBehaviorChanges: pre }),
    baseEnv({ KHY_FPF_CHARACTERIZATION: 'on' }),
  );
  assert.deepStrictEqual(v.silentBehaviorChanges, pre, '应原样采用调用方预算,不用 syntax 漂移覆盖');
});

test('SOURCE falsePositiveFixGuard.finalize require characterizationSnapshot 且以 baseline/current 为闸', () => {
  const src = fs.readFileSync(path.join(SRC, 'falsePositiveFixGuard.js'), 'utf8');
  assert.ok(/require\(['"]\.\/characterizationSnapshot['"]\)/.test(src), '应 require ./characterizationSnapshot');
  assert.ok(/ctx\.baseline\s*&&\s*ctx\.current/.test(src), '应以 ctx.baseline && ctx.current 为进入闸');
  assert.ok(/_computeUncovered\(/.test(src), '应复用 _computeUncovered 作 coveredFiles 单一真源');
});

test('SOURCE agenticHarnessService 把回归门 baseline/current 透传进 finalize', () => {
  const src = fs.readFileSync(path.join(SRC, 'agenticHarnessService.js'), 'utf8');
  assert.ok(/_fpfGuard\.finalize\(/.test(src), '应调用 _fpfGuard.finalize');
  assert.ok(/regressionGateReport\s*\?\s*regressionGateReport\.baseline/.test(src), '应透传 regressionGateReport.baseline');
  assert.ok(/regressionGateReport\s*\?\s*regressionGateReport\.current/.test(src), '应透传 regressionGateReport.current');
});
