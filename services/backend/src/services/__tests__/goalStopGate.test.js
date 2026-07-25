'use strict';

/**
 * goalStopGate.test.js — 持久目标 Stop-gate 纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(嵌套父门控 KHY_GOAL)/isAutoClearEnabled、再驱动上限
 * resolveMaxRedrives、保守达成判定 looksLikeGoalSatisfied(完成态 vs 否定 vs 未来时计划)、
 * 再驱动文案 buildRedriveMessage、编排 evaluateGoalStop(pass/clear/redrive/预算耗尽/门控回退)。
 * 零 IO、确定性——每个断言显式传 env,不依赖进程环境。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gate = require('../goalStopGate');

const GOAL = { text: '让 khy 学会使用 goal 模式' };

test('isEnabled:默认开;显式 falsy 关;父门控 KHY_GOAL 关则本门也关', () => {
  assert.equal(gate.isEnabled({}), true);
  assert.equal(gate.isEnabled({ KHY_GOAL_STOP_GATE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(gate.isEnabled({ KHY_GOAL_STOP_GATE: v }), false, v);
  }
  // 嵌套父门控:KHY_GOAL 关 → 无论子门控如何都关
  assert.equal(gate.isEnabled({ KHY_GOAL: '0' }), false);
  assert.equal(gate.isEnabled({ KHY_GOAL: 'off', KHY_GOAL_STOP_GATE: '1' }), false);
});

test('isAutoClearEnabled:默认开;显式 falsy 关', () => {
  assert.equal(gate.isAutoClearEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.equal(gate.isAutoClearEnabled({ KHY_GOAL_AUTO_CLEAR: v }), false, v);
  }
});

test('resolveMaxRedrives:默认 1、env 覆盖、非法回退、clamp [0,10]', () => {
  assert.equal(gate.resolveMaxRedrives({}), gate.GOAL_STOP_GATE_DEFAULT_MAX);
  assert.equal(gate.GOAL_STOP_GATE_DEFAULT_MAX, 1);
  assert.equal(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: '3' }), 3);
  assert.equal(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: '0' }), 0);   // 0 合法(相当于只判达成/清除,不再驱动)
  assert.equal(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: '99' }), 10); // clamp 上限
  assert.equal(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: '-2' }), 1);  // 负 → 默认
  assert.equal(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: 'abc' }), 1); // 非法 → 默认
});

test('looksLikeGoalSatisfied:显式目标达成措辞 → true', () => {
  assert.equal(gate.looksLikeGoalSatisfied('目标已完成,所有测试通过。'), true);
  assert.equal(gate.looksLikeGoalSatisfied('已达成该目标。'), true);
  assert.equal(gate.looksLikeGoalSatisfied('The goal is complete.'), true);
  assert.equal(gate.looksLikeGoalSatisfied('goal accomplished'), true);
});

test('looksLikeGoalSatisfied:完成态通用信号且无未来时计划 → true', () => {
  assert.equal(gate.looksLikeGoalSatisfied('已完成:新增 goalStopGate.js,单测全绿。'), true);
  assert.equal(gate.looksLikeGoalSatisfied('全部测试通过,已验证。'), true);
  assert.equal(gate.looksLikeGoalSatisfied('Done. All checks passed.'), true);
});

test('looksLikeGoalSatisfied:否定完成 → false(优先级最高)', () => {
  assert.equal(gate.looksLikeGoalSatisfied('尚未完成,还差最后一步。'), false);
  assert.equal(gate.looksLikeGoalSatisfied('目标还没完成。'), false);
  assert.equal(gate.looksLikeGoalSatisfied('Not done yet, still working on it.'), false);
  // 即便同时出现「已完成」字样,否定优先 → 未达成(保守)
  assert.equal(gate.looksLikeGoalSatisfied('虽然已完成一部分,但目标尚未完成。'), false);
});

test('looksLikeGoalSatisfied:完成态被未来时计划主导 → false(保守再推)', () => {
  assert.equal(gate.looksLikeGoalSatisfied('已看完文件,接下来我将重构核心模块。'), false);
  assert.equal(gate.looksLikeGoalSatisfied('已完成初步分析,下一步我会写测试。'), false);
  assert.equal(gate.looksLikeGoalSatisfied("I've finished reading; next I will implement it."), false);
});

test('looksLikeGoalSatisfied:空/纯前言/无完成信号 → false', () => {
  assert.equal(gate.looksLikeGoalSatisfied(''), false);
  assert.equal(gate.looksLikeGoalSatisfied('   '), false);
  assert.equal(gate.looksLikeGoalSatisfied('让我先看看桌面上有什么文件。'), false);
  assert.equal(gate.looksLikeGoalSatisfied('我先来分析一下这个问题。'), false);
});

test('buildRedriveMessage:含目标文本、二选一、GoalTool(clear)、用户请求截断', () => {
  const m = gate.buildRedriveMessage(GOAL, { userMessage: '让khy学会使用goal模式' });
  assert.ok(m.includes(GOAL.text));
  assert.ok(m.includes('GoalTool(action=clear)'));
  assert.ok(m.includes('尚未确认达成'));
  assert.ok(m.includes('用户原始请求:'));
  // 无 userMessage 时不追加该行
  const m2 = gate.buildRedriveMessage(GOAL, {});
  assert.ok(!m2.includes('用户原始请求:'));
});

test('evaluateGoalStop:门控关 → pass(字节回退今日行为)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '让我先看看。', env: { KHY_GOAL_STOP_GATE: '0' } });
  assert.equal(v.action, 'pass');
  assert.equal(v.reason, 'gate-off');
  // 父门控关同样 pass
  assert.equal(gate.evaluateGoalStop({ goal: GOAL, reply: 'x', env: { KHY_GOAL: 'off' } }).action, 'pass');
});

test('evaluateGoalStop:无活动目标 → pass', () => {
  assert.equal(gate.evaluateGoalStop({ goal: null, reply: 'x', env: {} }).action, 'pass');
  assert.equal(gate.evaluateGoalStop({ goal: { text: '' }, reply: 'x', env: {} }).action, 'pass');
});

test('evaluateGoalStop:达成 + 自动清除开 → clear', () => {
  // 声称验证须带证据(证据门默认开),否则会被降级为 evidence-missing redrive
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '目标已完成,已验证:\n```\n8 passed\n```', env: {} });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:达成 + 自动清除关 → pass(交由模型自清)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '目标已完成。', env: { KHY_GOAL_AUTO_CLEAR: '0' } });
  assert.equal(v.action, 'pass');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:未达成且预算未耗尽 → redrive(带 message)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '我先看看代码。', redriveCount: 0, env: {} });
  assert.equal(v.action, 'redrive');
  assert.equal(v.reason, 'not-satisfied');
  assert.ok(v.message && v.message.includes(GOAL.text));
});

test('evaluateGoalStop:未达成但预算耗尽 → pass(跨轮由轮次预算兜底)', () => {
  // 默认 max=1:redriveCount>=1 即耗尽
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '继续分析中。', redriveCount: 1, env: {} });
  assert.equal(v.action, 'pass');
  assert.equal(v.reason, 'redrive-exhausted');
  // max=0:任何未达成都直接 pass(不再驱动)
  const v0 = gate.evaluateGoalStop({ goal: GOAL, reply: '继续。', redriveCount: 0, env: { KHY_GOAL_STOP_GATE_MAX: '0' } });
  assert.equal(v0.action, 'pass');
});

test('evaluateGoalStop:reply 非字符串不抛,按未达成处理', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: undefined, redriveCount: 0, env: {} });
  assert.equal(v.action, 'redrive');
});

// ── 证据门(KHY_GOAL_EVIDENCE_GATE;参考 Hermes evidence-based verification)────────

test('isEvidenceGateEnabled:默认开;显式 falsy 关;父门控 KHY_GOAL_STOP_GATE/KHY_GOAL 关则本门也关', () => {
  assert.equal(gate.isEvidenceGateEnabled({}), true);
  assert.equal(gate.isEvidenceGateEnabled({ KHY_GOAL_EVIDENCE_GATE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(gate.isEvidenceGateEnabled({ KHY_GOAL_EVIDENCE_GATE: v }), false, v);
  }
  assert.equal(gate.isEvidenceGateEnabled({ KHY_GOAL_STOP_GATE: '0' }), false);
  assert.equal(gate.isEvidenceGateEnabled({ KHY_GOAL: 'off', KHY_GOAL_EVIDENCE_GATE: '1' }), false);
});

test('hasConcreteEvidence:代码块/通过数/比值/退出码/TAP/对勾/PASS/shell/框架命令 → true', () => {
  assert.equal(gate.hasConcreteEvidence('结果:\n```\nok\n```'), true);
  assert.equal(gate.hasConcreteEvidence('12 passed, 0 failed'), true);
  assert.equal(gate.hasConcreteEvidence('单测 8 通过'), true);
  assert.equal(gate.hasConcreteEvidence('回归 9/9 全绿'), true);
  assert.equal(gate.hasConcreteEvidence('exit code 0'), true);
  assert.equal(gate.hasConcreteEvidence('退出码 0'), true);
  assert.equal(gate.hasConcreteEvidence('ok 1 - parses'), true);
  assert.equal(gate.hasConcreteEvidence('# pass 8'), true);
  assert.equal(gate.hasConcreteEvidence('✓ all good'), true);
  assert.equal(gate.hasConcreteEvidence('PASS src/foo.test.js'), true);
  assert.equal(gate.hasConcreteEvidence('$ npm test'), true);
  assert.equal(gate.hasConcreteEvidence('跑了 node --test 全绿'), true);
});

test('hasConcreteEvidence:空口声称/空/纯前言 → false', () => {
  assert.equal(gate.hasConcreteEvidence(''), false);
  assert.equal(gate.hasConcreteEvidence('   '), false);
  assert.equal(gate.hasConcreteEvidence('已验证通过。'), false);
  assert.equal(gate.hasConcreteEvidence('全部测试通过,目标达成。'), false);
  assert.equal(gate.hasConcreteEvidence('All tests passed.'), false);
});

test('claimsVerificationWithoutEvidence:声称验证但无证据 → true;有证据/未声称 → false', () => {
  // 声称验证 + 无证据 → 命中
  assert.equal(gate.claimsVerificationWithoutEvidence('全部测试通过,目标达成。'), true);
  assert.equal(gate.claimsVerificationWithoutEvidence('已验证通过。'), true);
  assert.equal(gate.claimsVerificationWithoutEvidence('All tests passed. Done.'), true);
  // 声称验证 + 有证据 → 不命中
  assert.equal(gate.claimsVerificationWithoutEvidence('全部测试通过:\n```\n12 passed\n```'), false);
  assert.equal(gate.claimsVerificationWithoutEvidence('已验证通过,单测 9/9。'), false);
  // 未声称验证(纯"目标已完成")→ 不命中(保持原接受路径不被扰动)
  assert.equal(gate.claimsVerificationWithoutEvidence('目标已完成。'), false);
  assert.equal(gate.claimsVerificationWithoutEvidence('已实现该功能。'), false);
  // 空 → false
  assert.equal(gate.claimsVerificationWithoutEvidence(''), false);
});

test('buildEvidenceRedriveMessage:含目标文本、要求粘贴输出、GoalTool(clear)、用户请求截断', () => {
  const m = gate.buildEvidenceRedriveMessage(GOAL, { userMessage: '让khy学会' });
  assert.ok(m.includes(GOAL.text));
  assert.ok(m.includes('GoalTool(action=clear)'));
  assert.ok(m.includes('没有任何**具体证据**'));
  assert.ok(m.includes('用户原始请求:'));
  const m2 = gate.buildEvidenceRedriveMessage(GOAL, {});
  assert.ok(!m2.includes('用户原始请求:'));
});

test('evaluateGoalStop:声称验证但无证据 → redrive(evidence-missing,带证据文案)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '全部测试通过,目标已完成。', redriveCount: 0, env: {} });
  assert.equal(v.action, 'redrive');
  assert.equal(v.reason, 'evidence-missing');
  assert.ok(v.message && v.message.includes('具体证据'));
});

test('evaluateGoalStop:声称验证且有证据 → clear(证据门放行)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '全部测试通过:\n```\n12 passed, 0 failed\n```\n目标已完成。', env: {} });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:纯"目标已完成"(不声称验证)→ clear(不被证据门扰动)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '目标已完成。', env: {} });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:证据门关 → 字节回退(声称无证据也 clear)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '全部测试通过,目标已完成。', env: { KHY_GOAL_EVIDENCE_GATE: '0' } });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:证据缺失但 redrive 预算耗尽 → pass(不自动清除未证实目标)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '全部测试通过,目标已完成。', redriveCount: 1, env: {} });
  assert.equal(v.action, 'pass');
  assert.equal(v.reason, 'evidence-missing-exhausted');
});

// ── 完成标准契约(KHY_GOAL_COMPLETION_CONTRACT;参考 Hermes v0.18.0 completion contracts)────

const GOAL_WITH_CONTRACT = {
  text: '实现 X 功能。\n\n## 完成标准\n- 所有单测全绿\n- arch:god 无新增超限\n',
};

test('isCompletionContractEnabled:默认开;显式 falsy 关;父门控 KHY_GOAL_STOP_GATE/KHY_GOAL 关则本门也关', () => {
  assert.equal(gate.isCompletionContractEnabled({}), true);
  assert.equal(gate.isCompletionContractEnabled({ KHY_GOAL_COMPLETION_CONTRACT: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(gate.isCompletionContractEnabled({ KHY_GOAL_COMPLETION_CONTRACT: v }), false, v);
  }
  assert.equal(gate.isCompletionContractEnabled({ KHY_GOAL_STOP_GATE: '0' }), false);
  assert.equal(gate.isCompletionContractEnabled({ KHY_GOAL: 'off', KHY_GOAL_COMPLETION_CONTRACT: '1' }), false);
});

test('evaluateGoalStop:声明了标准但证据未全覆盖 → redrive(contract-unmet,指名缺哪条)', () => {
  // reply 有测试证据但没跑 arch:god → 缺 arch:god 一条
  const reply = '目标已完成:\n```\n12 passed\n```';
  const v = gate.evaluateGoalStop({ goal: GOAL_WITH_CONTRACT, reply, redriveCount: 0, env: {} });
  assert.equal(v.action, 'redrive');
  assert.equal(v.reason, 'contract-unmet');
  assert.ok(v.message && v.message.includes('arch:god'), '文案指名缺失标准');
});

test('evaluateGoalStop:声明了标准且证据逐条齐全 → clear', () => {
  const reply = '目标已完成:\n```\n12 passed\n```\narch:god 检查通过,无超限。';
  const v = gate.evaluateGoalStop({ goal: GOAL_WITH_CONTRACT, reply, env: {} });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:契约未覆盖但预算耗尽 → pass(不自动清除证据不全目标)', () => {
  const reply = '目标已完成:\n```\n12 passed\n```';
  const v = gate.evaluateGoalStop({ goal: GOAL_WITH_CONTRACT, reply, redriveCount: 1, env: {} });
  assert.equal(v.action, 'pass');
  assert.equal(v.reason, 'contract-unmet-exhausted');
});

test('evaluateGoalStop:契约门关 → 字节回退(不再逐条核对,证据齐即 clear)', () => {
  const reply = '目标已完成:\n```\n12 passed\n```'; // 只满足测试,缺 arch:god
  const v = gate.evaluateGoalStop({ goal: GOAL_WITH_CONTRACT, reply, env: { KHY_GOAL_COMPLETION_CONTRACT: '0' } });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:目标无声明标准 → 契约不生效(既有行为不变)', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '目标已完成。', env: {} });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});
