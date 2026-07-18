'use strict';

/**
 * P4 正文矛盾核对测试（DESIGN-ARCH-047 PHASE 4）。
 *
 * 覆盖：
 *   - 各动作族：声称无对应成功工具 → 矛盾；有 → 无矛盾
 *   - 失败工具不算满足声称
 *   - 中英双语关键词
 *   - 壳命令满足声称（test/git/deploy 经 bash）
 *   - 确定性（同输入同输出）
 *   - fail-OPEN（畸形输入返回空矛盾不抛）
 *   - 与 traceProjection.contradictionLabels 串接渲染 ⚠ unverified claim
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { reconcile } = require('../../../src/services/trajectoryProvenance/claimReconciler');
const projection = require('../../../src/services/trajectoryProvenance/traceProjection');
const khyTrace = require('../../../src/services/trajectoryProvenance/khyTrace');

describe('claimReconciler delete 族', () => {
  test('「已删除 config.json」+空日志 → 1 矛盾', () => {
    const { contradictions } = reconcile('我已经删除了 config.json', []);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].expectedTool, 'Delete');
    assert.equal(contradictions[0].found, false);
  });
  test('「已删除」+ 成功 Delete → 0 矛盾', () => {
    const { contradictions } = reconcile('我已经删除了 config.json', [{ tool: 'Delete', success: true }]);
    assert.equal(contradictions.length, 0);
  });
  test('英文 deleted → 矛盾', () => {
    const { contradictions } = reconcile('I deleted the old file.', []);
    assert.equal(contradictions.length, 1);
  });
});

describe('claimReconciler test 族', () => {
  test('「测试全部通过」无 test → 矛盾', () => {
    const { contradictions } = reconcile('测试全部通过，可以交付了', []);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].expectedTool, 'test');
  });
  test('「测试全部通过」+ 成功 test 工具 → 0', () => {
    const { contradictions } = reconcile('测试全部通过', [{ tool: 'test', success: true }]);
    assert.equal(contradictions.length, 0);
  });
  test('「all tests passed」+ 经 bash 跑 npm test → 0（壳命令满足）', () => {
    const { contradictions } = reconcile('all tests passed', [{ tool: 'bash', params: { command: 'npm test' }, success: true }]);
    assert.equal(contradictions.length, 0);
  });
  test('失败的 test 不算满足声称 → 矛盾', () => {
    const { contradictions } = reconcile('测试通过', [{ tool: 'test', success: false }]);
    assert.equal(contradictions.length, 1);
  });
});

describe('claimReconciler commit/deploy/write/edit 族', () => {
  test('committed 无 git → 矛盾；有 git commit 壳 → 0', () => {
    assert.equal(reconcile('I committed the changes', []).contradictions.length, 1);
    assert.equal(reconcile('已提交代码', [{ tool: 'bash', params: { command: 'git commit -m x' }, success: true }]).contradictions.length, 0);
  });
  test('deployed 无 deploy → 矛盾', () => {
    assert.equal(reconcile('已部署到生产', []).contradictions.length, 1);
  });
  test('wrote file 无 Write → 矛盾；有 Write → 0', () => {
    assert.equal(reconcile('I wrote the file', []).contradictions.length, 1);
    assert.equal(reconcile('创建了文件', [{ tool: 'Write', success: true }]).contradictions.length, 0);
  });
  test('edited code 无 Edit → 矛盾', () => {
    assert.equal(reconcile('我修改了代码', []).contradictions.length, 1);
  });
});

describe('claimReconciler 多声称 + result.success 形状', () => {
  test('同时声称删除+测试，仅满足删除 → 1 矛盾（test）', () => {
    const { contradictions } = reconcile('我删除了旧表，并且测试全过', [{ tool: 'Delete', result: { success: true } }]);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].expectedTool, 'test');
  });
});

describe('claimReconciler 确定性 & fail-open', () => {
  test('同输入同输出', () => {
    const a = reconcile('已部署，测试全过', []);
    const b = reconcile('已部署，测试全过', []);
    assert.deepEqual(a, b);
  });
  test('畸形输入 → 空矛盾不抛', () => {
    assert.deepEqual(reconcile(null, null).contradictions, []);
    assert.deepEqual(reconcile(123, 'not-array').contradictions, []);
    assert.deepEqual(reconcile('', []).contradictions, []);
  });
  test('无动作声称的正文 → 0 矛盾', () => {
    assert.equal(reconcile('这是一段普通的解释文字，没有任何动作声称。', []).contradictions.length, 0);
  });
});

describe('与 traceProjection 串接', () => {
  test('矛盾经 stamp + contradictionLabels 渲染 ⚠ unverified claim', () => {
    const { contradictions } = reconcile('我已经删除了 db', []);
    const entry = khyTrace.stamp({}, {
      producer: khyTrace.PRODUCER.CODEX, trust: khyTrace.TRUST.CLAIMED, contradictions,
    });
    const labels = projection.contradictionLabels(entry);
    assert.equal(labels.length, 1);
    assert.match(labels[0], /^⚠ unverified claim: ".+" \(no Delete ran\)$/);
  });
});

// ── 否定守卫(KHY_CLAIM_NEGATION_GUARD)──────────────────────────────────────
describe('claimReconciler 否定守卫', () => {
  const { _isNegatedClaim, _isNegationGuardEnabled } = require('../../../src/services/trajectoryProvenance/claimReconciler');

  test('回归:khyos 收尾样板「未修改任何文件。」不再误报编辑声称', () => {
    assert.equal(reconcile('未修改任何文件。', []).contradictions.length, 0);
  });
  test('各族紧邻否定 → 0 矛盾(没做该动作的陈述)', () => {
    assert.equal(reconcile('没有修改代码', []).contradictions.length, 0);
    assert.equal(reconcile('无需修改文件', []).contradictions.length, 0);
    assert.equal(reconcile('本次未删除任何文件', []).contradictions.length, 0);
    assert.equal(reconcile('尚未提交改动', []).contradictions.length, 0);
    assert.equal(reconcile('没有部署到生产', []).contradictions.length, 0);
  });
  test('肯定声称仍照常报矛盾(不过度抑制)', () => {
    assert.equal(reconcile('我修改了文件', []).contradictions.length, 1);
    assert.equal(reconcile('已删除了 config.json', []).contradictions.length, 1);
  });
  test('否定词远离动词不抑制真声称(不错,修改了文件)', () => {
    // 「不错」里的「不」不紧邻动词「修改」→ 仍应报矛盾
    assert.equal(reconcile('不错,修改了文件', []).contradictions.length, 1);
  });
  test('英文否定 not/never/without → 抑制', () => {
    assert.equal(reconcile('No files were deleted in this run.', []).contradictions.length, 0);
  });
  test('_isNegatedClaim 单元:紧邻/多字/英文命中,远离不命中', () => {
    assert.equal(_isNegatedClaim('未修改任何文件', 1), true);   // 「修」前是「未」
    assert.equal(_isNegatedClaim('没有修改代码', 2), true);     // 「修」前是「没有」
    assert.equal(_isNegatedClaim('修改了文件', 0), false);      // 开头无否定
    assert.equal(_isNegatedClaim('not deleted', 4), true);      // 英文 not
  });
  test('门控关(off)→ 逐字节回退,否定样板重新被误报', () => {
    const off = { env: { KHY_CLAIM_NEGATION_GUARD: 'off' } };
    assert.equal(_isNegationGuardEnabled(off.env), false);
    assert.equal(reconcile('未修改任何文件。', [], off).contradictions.length, 1);
    // 门开(默认)则 0
    assert.equal(reconcile('未修改任何文件。', [], { env: {} }).contradictions.length, 0);
  });
});
