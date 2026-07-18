'use strict';

/**
 * falsePositiveFixGuard.test.js — 防「小模型误判 bug、把本来正确的代码改成错误的」纯模块单测。
 *
 * 守护(goal 2026-06-25):
 *   1. 不 engage:非 bugfix 意图 / 只读轮 / off / 只改测试文件 → 零产出、verdict pass。
 *   2. 关键对抗:bugfix + 改源码 + 全程无红复现 → phantomSuspected;
 *      低档 finalize → block/passed:false;高档 finalize → caution/passed:true/blocked:false。
 *   3. happy:红→绿真修 → reproObserved、verdict pass、deposit.shouldDeposit、签名稳定。
 *   4. 加固覆盖门:bugfix 改无兄弟测试的源码 → 低档 block / 高档 caution;有兄弟测试 → pass。
 *   5. 行为特征漂移:silentBehaviorChanges 作为一条软理由。
 *   6. failOpen:任何档位都不阻断(仅提示)。
 *   7. 确定性 + episode 去重 + fail-soft(畸形输入不抛)。
 *
 * 纯叶子,无外部依赖,故用 node:test(jest 跑不了 node:test;由 test:node 自动发现)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const g = require('../../src/services/falsePositiveFixGuard');

const ON = { KHY_FALSE_POSITIVE_FIX_GUARD: 'on' };
const edit = (path) => ({ tool: 'edit_file', params: { path }, result: { success: true } });
const red = (over = {}) => ({ kind: 'test', framework: 'jest', command: 'npx jest foo', green: false, failed: 2, failures: ['foo › a', 'foo › b'], ...over });
const green = (over = {}) => ({ kind: 'test', framework: 'jest', command: 'npx jest foo', green: true, failed: 0, failures: [], ...over });

function bugfixState() {
  const st = g.createState();
  st.bugfixIntent = true;
  return st;
}

describe('falsePositiveFixGuard — 不 engage', () => {
  test('非 bugfix 意图 → assess/finalize 跳过', () => {
    const st = g.createState(); // bugfixIntent 默认 false
    g.recordIteration(st, { toolResults: [edit('src/a.js')] }, ON);
    assert.equal(g.assess(st, ON).caution, false);
    const v = g.finalize(st, { tier: 'low', changedFiles: ['src/a.js'], knownFiles: [] }, ON);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.passed, true);
  });

  test('off → 跳过', () => {
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/a.js')] }, { KHY_FALSE_POSITIVE_FIX_GUARD: 'off' });
    assert.equal(g.assess(st, { KHY_FALSE_POSITIVE_FIX_GUARD: 'off' }).caution, false);
    const v = g.finalize(st, { tier: 'low', changedFiles: ['src/a.js'] }, { KHY_FALSE_POSITIVE_FIX_GUARD: 'off' });
    assert.equal(v.verdict, 'pass');
  });

  test('只改测试文件、未改源码 → 不 engage', () => {
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('tests/a.test.js')] }, ON);
    const v = g.finalize(st, { tier: 'low', changedFiles: ['tests/a.test.js'], knownFiles: ['tests/a.test.js'] }, ON);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.phantomSuspected, false);
  });
});

describe('falsePositiveFixGuard — 关键对抗:幻想 bug 无复现', () => {
  test('改源码修 bug 但全程无红复现 → assess 提示 + 低档硬拦 / 高档仅提示', () => {
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);

    const a = g.assess(st, ON);
    assert.equal(a.caution, true);
    assert.equal(a.signals[0].type, 'phantom-no-repro');
    assert.match(a.directive, /复现|失败|红/);

    // 低档:硬拦(knownFiles 空 → 覆盖维度 fail-open,理由仅 phantom)。
    const low = g.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);
    assert.equal(low.phantomSuspected, true);
    assert.equal(low.verdict, 'block');
    assert.equal(low.passed, false);
    assert.equal(low.blocked, true);
    assert.ok(low.reasons.some(r => r.code === 'phantom-no-repro'));

    // 高档:同样命中但绝不阻断。
    const high = g.finalize(st, { tier: 'high', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);
    assert.equal(high.phantomSuspected, true);
    assert.equal(high.verdict, 'caution');
    assert.equal(high.passed, true);
    assert.equal(high.blocked, false);
  });

  test('lowTierOnly=off → 高档命中也可阻断', () => {
    const env = { ...ON, KHY_FPF_LOW_TIER_ONLY: 'off' };
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, env);
    const high = g.finalize(st, { tier: 'high', changedFiles: ['src/services/foo.js'], knownFiles: [] }, env);
    assert.equal(high.verdict, 'block');
    assert.equal(high.passed, false);
  });
});

describe('falsePositiveFixGuard — happy 红→绿真修', () => {
  test('先红后绿 → reproObserved、verdict pass、deposit 描述符 + 签名稳定', () => {
    const st = bugfixState();
    // 第 1 轮:复现红
    g.recordIteration(st, { toolResults: [], testFindings: [red()] }, ON);
    // 第 2 轮:改源码
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    // 第 3 轮:复现转绿
    g.recordIteration(st, { toolResults: [], testFindings: [green()] }, ON);

    const v = g.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);
    assert.equal(v.reproObserved, true);
    assert.equal(v.phantomSuspected, false);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.passed, true);
    assert.equal(v.deposit.shouldDeposit, true);
    assert.equal(v.deposit.framework, 'jest');
    assert.equal(v.deposit.command, 'npx jest foo');
    assert.ok(typeof v.deposit.signature === 'string' && v.deposit.signature.includes('jest'));

    // 确定性:同序列 → 同签名。
    const st2 = bugfixState();
    g.recordIteration(st2, { toolResults: [], testFindings: [red()] }, ON);
    g.recordIteration(st2, { toolResults: [edit('src/services/foo.js')] }, ON);
    g.recordIteration(st2, { toolResults: [], testFindings: [green()] }, ON);
    const v2 = g.finalize(st2, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);
    assert.equal(v2.deposit.signature, v.deposit.signature);
  });

  test('真修后即便文件无兄弟测试也不计未覆盖(复现即覆盖)', () => {
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [], testFindings: [red()] }, ON);
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    g.recordIteration(st, { toolResults: [], testFindings: [green()] }, ON);
    const v = g.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: ['src/services/foo.js'] }, ON);
    assert.equal(v.verdict, 'pass');
    assert.deepEqual(v.uncoveredFiles, []);
  });
});

describe('falsePositiveFixGuard — 加固覆盖门', () => {
  // 关复现门以隔离覆盖维度。
  const env = { ...ON, KHY_FPF_REQUIRE_RED_REPRO: 'off' };

  test('bugfix 改无兄弟测试的源码 → 低档 block / 高档 caution', () => {
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, env);
    const known = ['src/services/foo.js', 'src/services/bar.js']; // 无 foo 的测试
    const low = g.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: known }, env);
    assert.ok(low.uncoveredFiles.includes('src/services/foo.js'));
    assert.equal(low.verdict, 'block');
    const high = g.finalize(st, { tier: 'high', changedFiles: ['src/services/foo.js'], knownFiles: known }, env);
    assert.equal(high.verdict, 'caution');
    assert.equal(high.passed, true);
  });

  test('有兄弟测试 → 不计未覆盖 → pass', () => {
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, env);
    const known = ['src/services/foo.js', 'tests/services/foo.test.js'];
    const v = g.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: known }, env);
    assert.deepEqual(v.uncoveredFiles, []);
    assert.equal(v.verdict, 'pass');
  });

  test('knownFiles 缺失 → 覆盖维度 fail-open(不阻断)', () => {
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, env);
    const v = g.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'] }, env);
    assert.deepEqual(v.uncoveredFiles, []);
    assert.equal(v.verdict, 'pass');
  });
});

describe('falsePositiveFixGuard — 行为特征漂移 + failOpen', () => {
  test('silentBehaviorChanges → 软理由(低档 block)', () => {
    const env = { ...ON, KHY_FPF_REQUIRE_RED_REPRO: 'off', KHY_FPF_UNCOVERED_BLOCKS: 'off' };
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, env);
    const v = g.finalize(st, {
      tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [],
      silentBehaviorChanges: [{ step: 'build', from: 'pass', to: 'fail' }],
    }, env);
    assert.ok(v.reasons.some(r => r.code === 'silent-behavior-change'));
    assert.equal(v.verdict, 'block');
  });

  test('failOpen → 低档命中也不阻断,仅 caution', () => {
    const env = { ...ON, KHY_FPF_FAIL_OPEN: 'on' };
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, env);
    const v = g.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [] }, env);
    assert.equal(v.phantomSuspected, true);
    assert.equal(v.verdict, 'caution');
    assert.equal(v.passed, true);
  });
});

describe('falsePositiveFixGuard — episode 去重 + fail-soft', () => {
  test('同一 phantom 条件不重复打扰(去重)', () => {
    const st = bugfixState();
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    assert.equal(g.assess(st, ON).caution, true);   // 首次浮出
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    assert.equal(g.assess(st, ON).caution, false);  // 第二次不再打扰
  });

  test('畸形输入不抛', () => {
    const st = bugfixState();
    assert.doesNotThrow(() => g.recordIteration(st, { toolResults: [null, { tool: 1 }], testFindings: [null, {}] }, ON));
    assert.doesNotThrow(() => g.recordIteration(null, {}, ON));
    assert.doesNotThrow(() => g.finalize(st, { tier: 'low', changedFiles: [null, 3], knownFiles: 'oops' }, ON));
    assert.doesNotThrow(() => g.finalize(null, {}, ON));
  });

  test('summarize / hasFindings 契约', () => {
    const st = bugfixState();
    assert.equal(g.hasFindings(st), false);
    g.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    g.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);
    assert.equal(g.hasFindings(st), true);
    const s = g.summarize(st);
    assert.equal(s.bugfixIntent, true);
    assert.ok(s.srcFilesTouched >= 1);
    assert.ok(s.byType['phantom-no-repro'] >= 1);
  });
});

describe('falsePositiveFixGuard — 工具函数', () => {
  test('isTestFile 跨语言识别', () => {
    for (const p of ['tests/a.test.js', 'src/__tests__/x.js', 'foo.spec.ts', 'pkg/test_thing.py', 'pkg/thing_test.go']) {
      assert.equal(g.isTestFile(p), true, p);
    }
    for (const p of ['src/services/foo.js', 'lib/bar.ts', 'main.py']) {
      assert.equal(g.isTestFile(p), false, p);
    }
  });

  test('looksLikeBugfixTask', () => {
    assert.equal(g.looksLikeBugfixTask('修复登录崩溃的 bug'), true);
    assert.equal(g.looksLikeBugfixTask('fix the failing test'), true);
    assert.equal(g.looksLikeBugfixTask('新增一个导出功能'), false);
  });
});
