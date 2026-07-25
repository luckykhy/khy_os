'use strict';

/**
 * goalModeService.report.test.js — 富完成报告骨架。
 *
 * 需求:不同任务的总结应同样完善 —— 为什么做 / 状态 / 做了什么 / 交付物 / 验证 /
 * 收尾(残留风险 + 下一步)。本套件锁定:
 *  - 富字段齐全时各段都在;
 *  - 富字段缺失时整段省略(不留空标题);
 *  - 只传旧字段的历史调用方输出等价(零回归);
 *  - 逃生阀 KHY_REPORT_RICH=0 完全回退旧扁平模板。
 */

const goalModeService = require('../../src/services/goalModeService');

describe('buildCompletionReport — 富报告各段', () => {
  const report = goalModeService.buildCompletionReport({
    goalText: '让 khy 的总结更完善',
    success: true,
    why: '用户要求对标 Claude Code 的丰富过程输出',
    steps: [
      { description: '改报告骨架', status: 'completed' },
      { description: '加测试', status: 'completed' },
    ],
    deliverables: ['goalModeService.js 富报告'],
    verification: ['单测全绿', '回归无新增失败'],
    residualRisks: ['措辞勿与既有段重复'],
    nextSteps: ['重建 wheel'],
    elapsed: 65000,
  });

  test('标题为任务执行完成', () => {
    expect(report).toMatch(/## 任务执行完成/);
  });

  test('含为什么做', () => {
    expect(report).toMatch(/\*\*为什么做：\*\* 用户要求对标/);
  });

  test('含做了什么(带状态图标)', () => {
    expect(report).toMatch(/\*\*做了什么：\*\*/);
    expect(report).toMatch(/\+ 改报告骨架/);
  });

  test('含交付物', () => {
    expect(report).toMatch(/\*\*交付物：\*\*/);
  });

  test('含验证(✓)', () => {
    expect(report).toMatch(/\*\*验证：\*\*/);
    expect(report).toMatch(/✓ 单测全绿/);
  });

  test('含收尾(残留 + 下一步)', () => {
    expect(report).toMatch(/\*\*收尾：\*\*/);
    expect(report).toMatch(/⚠ 残留：措辞勿与既有段重复/);
    expect(report).toMatch(/↳ 下一步：重建 wheel/);
  });

  test('含耗时', () => {
    expect(report).toMatch(/\*\*耗时：\*\* 1分5秒/);
  });
});

describe('buildCompletionReport — 缺字段整段省略', () => {
  const report = goalModeService.buildCompletionReport({
    goalText: '简单任务',
    success: true,
    steps: [{ description: '只做了一步', status: 'completed' }],
  });

  test('无富字段时不出现验证/收尾标题', () => {
    expect(report).not.toMatch(/\*\*验证：\*\*/);
    expect(report).not.toMatch(/\*\*收尾：\*\*/);
    expect(report).not.toMatch(/\*\*为什么做：\*\*/);
  });

  test('仍输出目标/状态/步骤(等价旧扁平)', () => {
    expect(report).toMatch(/\*\*目标：\*\* 简单任务/);
    expect(report).toMatch(/\*\*状态：\*\* 成功/);
    expect(report).toMatch(/只做了一步/);
  });
});

describe('buildCompletionReport — 失败路径', () => {
  test('success=false 走任务执行结束 + 错误', () => {
    const report = goalModeService.buildCompletionReport({
      goalText: '会失败的任务',
      success: false,
      error: '权限不足',
    });
    expect(report).toMatch(/## 任务执行结束/);
    expect(report).toMatch(/\*\*状态：\*\* 失败/);
    expect(report).toMatch(/\*\*错误：\*\* 权限不足/);
  });
});

describe('buildCompletionReport — 逃生阀 KHY_REPORT_RICH=0', () => {
  const prev = process.env.KHY_REPORT_RICH;
  beforeAll(() => { process.env.KHY_REPORT_RICH = '0'; });
  afterAll(() => {
    if (prev === undefined) delete process.env.KHY_REPORT_RICH;
    else process.env.KHY_REPORT_RICH = prev;
  });

  test('关闭后即便传富字段也回退扁平(无验证/收尾/为什么做)', () => {
    const report = goalModeService.buildCompletionReport({
      goalText: '任务',
      success: true,
      why: '动机在这',
      steps: [{ description: '一步', status: 'completed' }],
      verification: ['测试绿'],
      residualRisks: ['风险'],
      nextSteps: ['下一步'],
    });
    expect(report).not.toMatch(/\*\*为什么做：\*\*/);
    expect(report).not.toMatch(/\*\*验证：\*\*/);
    expect(report).not.toMatch(/\*\*收尾：\*\*/);
    // 步骤标签回退为「执行步骤」。
    expect(report).toMatch(/\*\*执行步骤：\*\*/);
  });
});
