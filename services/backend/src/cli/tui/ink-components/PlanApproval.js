'use strict';

/**
 * PlanApproval — presentational view of a generated execution plan awaiting
 * user approval, plus a live "generating" state.
 *
 * This is the ink replacement for planModeService.presentForApproval (which is
 * readline/rl.question based and cannot run under ink). It only renders; the
 * approval command grammar (Enter / skip N / edit N <desc> / add after N <desc>
 * / n) is parsed in App.handleSubmit and re-feeds an updated `plan` here, so the
 * single text input owns all keystrokes (no competing useInput).
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

function PlanApproval({ plan, generating, genText }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  if (generating) {
    const tail = genText ? String(genText).slice(-400) : '';
    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(Text, { color: 'cyan' }, '◴ 正在生成执行计划…'),
      tail ? h(Text, { dimColor: true }, tail) : null
    );
  }

  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;

  const stepNodes = plan.steps.map((s, i) => {
    const skipped = s.status === 'skipped';
    const mark = skipped ? '⊘' : `${i + 1}.`;
    return h(Text, { key: `step-${i}`, color: skipped ? 'gray' : undefined, dimColor: skipped },
      `  ${mark} ${s.description}`);
  });

  // 富计划字段(缺则不渲染,与既有 dataNeeds 同款防呆)。
  const why = typeof plan.why === 'string' ? plan.why.trim() : '';
  const currentState = Array.isArray(plan.currentState) ? plan.currentState : [];
  const expectedOutputs = Array.isArray(plan.expectedOutputs) ? plan.expectedOutputs : [];
  const dataNeeds = Array.isArray(plan.dataNeeds) ? plan.dataNeeds : [];
  const risks = Array.isArray(plan.risks) ? plan.risks : [];
  const verification = Array.isArray(plan.verification) ? plan.verification : [];
  const wrapup = Array.isArray(plan.wrapup) ? plan.wrapup : [];

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    // 为什么做(动机)放最前
    why ? h(Text, { color: 'cyan' }, '为什么做：' + why) : null,
    // 关键现状(实地查证)
    currentState.length > 0 ? h(Text, { dimColor: true }, '  关键现状：' + currentState.join('；')) : null,
    h(Text, { color: 'cyan', bold: true }, '执行计划'),
    h(Box, { flexDirection: 'column' }, stepNodes),
    expectedOutputs.length > 0 ? h(Text, { dimColor: true }, '  预计结果：' + expectedOutputs.join('；')) : null,
    dataNeeds.length > 0 ? h(Text, { dimColor: true }, '  需要的数据：' + dataNeeds.join('；')) : null,
    risks.length > 0 ? h(Text, { color: 'yellow' }, '  ⚠ 风险与对策：' + risks.join('；')) : null,
    verification.length > 0 ? h(Text, { color: 'green' }, '  ✓ 验证：' + verification.join('；')) : null,
    wrapup.length > 0 ? h(Text, { dimColor: true }, '  ↳ 收尾：' + wrapup.join('；')) : null,
    h(Text, { color: 'cyan' },
      '  Enter 确认执行 · skip N · edit N 描述 · add after N 描述 · n 取消')
  );
}

module.exports = PlanApproval;
