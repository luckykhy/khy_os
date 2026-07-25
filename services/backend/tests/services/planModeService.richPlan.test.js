'use strict';

/**
 * planModeService.richPlan.test.js — 资深工程师级富计划解析。
 *
 * 需求:khy 面对同类任务时应产出带「为什么做 / 关键现状(实地查证) / 计划 / 预计结果 /
 * 风险与对策 / 验证 / 收尾」的结构化计划(对标高质量交付计划)。本套件锁定:
 *  - 富模板各段被正确抽取到结构化字段;
 *  - **步骤只来自「计划」段** —— 验证/收尾段里的编号项(1./2.)不被误当成可执行步骤(关键回归);
 *  - 旧扁平计划与纯编号列表仍解析正常(零回归);
 *  - 逃生阀 KHY_PLAN_RICH=0 回退旧模板。
 */

const planModeService = require('../../src/services/planModeService');

const RICH = `## 为什么做
要让 khy 的计划更完善。这是动机所在。

## 关键现状
- planModeService.js:379 → 旧 4 段模板
- goalModeService.js:185 → 扁平报告

## 计划
1. 改计划模板
2. 改解析器 [depends: 1]
3. 加测试

## 预计结果
- 富计划落地

## 风险与对策
- 小模型填不满 → 缺段降级为空

## 验证
1. 单测全绿
2. 回归无新增失败

## 收尾
- 残留:措辞勿与既有段重复
- 下一步:重建 wheel`;

describe('parsePlanFromResponse — 富计划各段抽取', () => {
  const plan = planModeService.parsePlanFromResponse(RICH);

  test('为什么做 → why(散文段)', () => {
    expect(typeof plan.why).toBe('string');
    expect(plan.why).toMatch(/动机/);
  });

  test('关键现状 → currentState 逐条(含 file:line 证据)', () => {
    expect(plan.currentState).toHaveLength(2);
    expect(plan.currentState[0]).toMatch(/planModeService\.js:379/);
  });

  test('预计结果 → expectedOutputs', () => {
    expect(plan.expectedOutputs).toEqual(['富计划落地']);
  });

  test('风险与对策 → risks(配对文本)', () => {
    expect(plan.risks).toHaveLength(1);
    expect(plan.risks[0]).toMatch(/→/);
  });

  test('验证 → verification 逐条', () => {
    expect(plan.verification).toEqual(['单测全绿', '回归无新增失败']);
  });

  test('收尾 → wrapup 逐条', () => {
    expect(plan.wrapup).toHaveLength(2);
    expect(plan.wrapup.join(' ')).toMatch(/下一步/);
  });
});

describe('parsePlanFromResponse — 步骤只来自「计划」段(关键回归)', () => {
  const plan = planModeService.parsePlanFromResponse(RICH);

  test('恰好 3 个步骤(验证段的 1./2. 未被吞)', () => {
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.map(s => s.description)).toEqual(['改计划模板', '改解析器', '加测试']);
  });

  test('[depends: 1] 注解被解析并从描述剥离', () => {
    const step2 = plan.steps.find(s => s.id === 2);
    expect(step2.description).toBe('改解析器');
    expect(step2.blockedBy).toContain(1);
  });
});

describe('parsePlanFromResponse — 向后兼容(零回归)', () => {
  test('纯编号列表仍解析为步骤,富字段为空', () => {
    const plan = planModeService.parsePlanFromResponse('1. 第一步\n2. 第二步');
    expect(plan.steps).toHaveLength(2);
    expect(plan.why).toBe('');
    expect(plan.currentState).toEqual([]);
    expect(plan.verification).toEqual([]);
    expect(plan.wrapup).toEqual([]);
  });

  test('旧 4 段模板(执行计划/需要的数据/预计输出/风险)仍解析', () => {
    const legacy = `## 执行计划
1. 步骤甲
2. 步骤乙

## 需要的数据
- 数据项A

## 预计输出
- 输出X

## 风险与注意事项
- 风险Y`;
    const plan = planModeService.parsePlanFromResponse(legacy);
    expect(plan.steps).toHaveLength(2);
    expect(plan.dataNeeds).toEqual(['数据项A']);
    expect(plan.expectedOutputs).toEqual(['输出X']);
    expect(plan.risks).toEqual(['风险Y']);
  });
});

describe('PLAN_PROMPT 模板与逃生阀', () => {
  test('默认富模板含五段以上结构标题', () => {
    expect(planModeService.PLAN_PROMPT).toMatch(/## 为什么做/);
    expect(planModeService.PLAN_PROMPT).toMatch(/## 关键现状/);
    expect(planModeService.PLAN_PROMPT).toMatch(/## 验证/);
    expect(planModeService.PLAN_PROMPT).toMatch(/## 收尾/);
  });
});
