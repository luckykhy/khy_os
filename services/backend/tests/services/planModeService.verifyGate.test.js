'use strict';

/**
 * planModeService.verifyGate.test.js — 富计划「验证」段落地执行（P-verify）。
 *
 * 需求:KHY 面对复杂任务应「提高实际可交付性、切合使用者心意」——PLAN_PROMPT_RICH 产出含
 * 「验证」段,但审批后从未真正运行这些验证。本套件锁定 `_runPlanVerification` 的契约:
 *   - 有验证段时,把「验证」命令交给 AI 工具循环实地执行,并按真实证据判定 PASS/FAIL;
 *   - 诚实语义:[FAIL] 或模型自报失败 → 未通过;[PASS] 有证据 → 通过;两者皆无 → 「未取得
 *     验证证据」(不假装成功);
 *   - 门控 KHY_PLAN_VERIFY=off 关闭;验证段为空 → null(零行为变化);
 *   - executePlanSteps 完成后可通过 getLastVerification() 读到报告(持久化到计划文件)。
 */

const planModeService = require('../../src/services/planModeService');

function makeAi(reply) {
  const calls = [];
  return {
    chat: async (message, opts) => {
      calls.push({ message, opts });
      return { reply, provider: 'mock', tokenUsage: null };
    },
    calls,
  };
}

describe('planModeService._runPlanVerification', () => {
  test('验证全通过 → passed=true, summary=验证通过, 有 PASS 证据', async () => {
    const ai = makeAi('[PASS] npm test 通过 (exit 0)\n[PASS] config 模块存在\n验证通过 2/2');
    const r = await planModeService._runPlanVerification(
      { verification: ['跑 npm test', '检查 config 模块'] },
      { ai }
    );
    expect(r.passed).toBe(true);
    expect(r.summary).toBe('验证通过');
    expect(r.counts).toEqual({ pass: 2, fail: 0, skip: 0 });
    expect(ai.calls.length).toBe(1);
    expect(ai.calls[0].message).toMatch(/Plan Verification Gate/);
    expect(ai.calls[0].message).toMatch(/npm test/);
  });

  test('存在 FAIL → 判定不通过,绝不假装成功', async () => {
    const ai = makeAi('[PASS] A 通过\n[FAIL] 测试垮了');
    const r = await planModeService._runPlanVerification(
      { verification: ['A', 'B'] },
      { ai }
    );
    expect(r.passed).toBe(false);
    expect(r.summary).toBe('验证存在失败');
    expect(r.counts.fail).toBe(1);
  });

  test('无 PASS 也无 FAIL → 未取得验证证据(不伪造成功)', async () => {
    const ai = makeAi('我检查过了应该没问题');
    const r = await planModeService._runPlanVerification({ verification: ['检查'] }, { ai });
    expect(r.passed).toBe(false);
    expect(r.summary).toBe('未取得验证证据');
    expect(r.counts.pass).toBe(0);
    expect(r.counts.fail).toBe(0);
  });

  test('验证段为空 → 返回 null(零行为变化)', async () => {
    const ai = makeAi('不会调用');
    const r = await planModeService._runPlanVerification({ verification: [] }, { ai });
    expect(r).toBeNull();
    expect(ai.calls.length).toBe(0);
  });

  test('门控 KHY_PLAN_VERIFY=off → 返回 null,不调用模型', async () => {
    const ai = makeAi('不应调用');
    const r = await planModeService._runPlanVerification(
      { verification: ['跑测试'] },
      { ai, env: { KHY_PLAN_VERIFY: 'off' } }
    );
    expect(r).toBeNull();
    expect(ai.calls.length).toBe(0);
  });

  test('无 ai 模块 → 返回 null', async () => {
    const r = await planModeService._runPlanVerification({ verification: ['x'] }, {});
    expect(r).toBeNull();
  });

  test('模型抛异常 → 判定不通过并带错误信息', async () => {
    const ai = { chat: async () => { throw new Error('boom'); } };
    const r = await planModeService._runPlanVerification({ verification: ['跑测试'] }, { ai });
    expect(r.passed).toBe(false);
  });

  test('getLastVerification 透传最近一次报告', async () => {
    planModeService.reset();
    const ai = makeAi('[PASS] ok\n验证通过 1/1');
    await planModeService._runPlanVerification({ verification: ['ok'] }, { ai });
    const last = planModeService.getLastVerification();
    expect(last && last.passed).toBe(true);
    planModeService.reset();
    expect(planModeService.getLastVerification()).toBeNull();
  });
});