'use strict';
/**
 * goalStopGate.test.js �?持久目标 Stop-gate 纯叶子契�?node:test)�? *
 * 覆盖:门控 isEnabled(嵌套父门�?KHY_GOAL)/isAutoClearEnabled、再驱动上限
 * resolveMaxRedrives、保守达成判�?looksLikeGoalSatisfied(完成�?vs 否定 vs 未来时计�?�? * 再驱动文�?buildRedriveMessage、编�?evaluateGoalStop(pass/clear/redrive/预算耗尽/门控回退)�? * �?IO、确定性——每个断言显式�?env,不依赖进程环境�? */
const gate = require('../goalStopGate');
const GOAL = { text: '�?khy 学会使用 goal 模式' };
// ── 证据�?KHY_GOAL_EVIDENCE_GATE;参�?Hermes evidence-based verification)────────
test('evaluateGoalStop:�?目标已完�?(不声称验�?�?clear(不被证据门扰�?', () => {
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '目标已完成�?, env: {} });
  expect(v.action).toBe('clear');
  expect(v.reason).toBe('satisfied');
});
// ── 完成标准契约(KHY_GOAL_COMPLETION_CONTRACT;参�?Hermes v0.18.0 completion contracts)────
const GOAL_WITH_CONTRACT = {
  text: '实现 X 功能。\n\n## 完成标准\n- 所有单测全绿\n- arch:god 无新增超限\n',
};

describe('Goal Stop Gate', () => {
  test('isEnabled:默认开;显式 falsy �?父门�?KHY_GOAL 关则本门也关', () => {
      expect(gate.isEnabled({})).toBe(true);
      expect(gate.isEnabled({ KHY_GOAL_STOP_GATE: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(gate.isEnabled({ KHY_GOAL_STOP_GATE: v })).toBe(false);
      }
      // 嵌套父门�?KHY_GOAL �?�?无论子门控如何都�?      expect(gate.isEnabled({ KHY_GOAL: '0' })).toBe(false);
      expect(gate.isEnabled({ KHY_GOAL: 'off', KHY_GOAL_STOP_GATE: '1' })).toBe(false);
  });

  test('isAutoClearEnabled:默认开;显式 falsy �?, () => {
      expect(gate.isAutoClearEnabled({})).toBe(true);
      for (const v of ['0', 'false', 'off', 'no']) {
        expect(gate.isAutoClearEnabled({ KHY_GOAL_AUTO_CLEAR: v })).toBe(false);
      }
  });

  test('resolveMaxRedrives:默认 1、env 覆盖、非法回退、clamp [0,10]', () => {
      expect(gate.resolveMaxRedrives({})).toBe(gate.GOAL_STOP_GATE_DEFAULT_MAX);
      expect(gate.GOAL_STOP_GATE_DEFAULT_MAX).toBe(1);
      expect(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: '3' })).toBe(3);
      expect(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: '0' })).toBe(0); // 0 合法(相当于只判达�?清除,不再驱动)
      expect(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: '99' })).toBe(10); // clamp 上限
      expect(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: '-2' })).toBe(1); // �?�?默认
      expect(gate.resolveMaxRedrives({ KHY_GOAL_STOP_GATE_MAX: 'abc' })).toBe(1); // 非法 �?默认
  });

  test('looksLikeGoalSatisfied:显式目标达成措辞 �?true', () => {
      expect(gate.looksLikeGoalSatisfied('目标已完�? 所有测试通过�?)).toBe(true);
      expect(gate.looksLikeGoalSatisfied('已达成该目标�?)).toBe(true);
      expect(gate.looksLikeGoalSatisfied('The goal is complete.')).toBe(true);
      expect(gate.looksLikeGoalSatisfied('goal accomplished')).toBe(true);
  });

  test('looksLikeGoalSatisfied:完成态通用信号且无未来时计�?�?true', () => {
      expect(gate.looksLikeGoalSatisfied('已完�?新增 goalStopGate.js, 单测全绿�?)).toBe(true);
      expect(gate.looksLikeGoalSatisfied('全部测试通过, 已验证�?)).toBe(true);
      expect(gate.looksLikeGoalSatisfied('Done. All checks passed.')).toBe(true);
  });

  test('looksLikeGoalSatisfied:否定完成 �?false(优先级最�?', () => {
      expect(gate.looksLikeGoalSatisfied('尚未完成, 还差最后一步�?)).toBe(false);
      expect(gate.looksLikeGoalSatisfied('目标还没完成�?)).toBe(false);
      expect(gate.looksLikeGoalSatisfied('Not done yet, still working on it.')).toBe(false);
      // 即便同时出现「已完成」字�?否定优先 �?未达�?保守)
      expect(gate.looksLikeGoalSatisfied('虽然已完成一部分, 但目标尚未完成�?)).toBe(false);
  });

  test('looksLikeGoalSatisfied:完成态被未来时计划主�?�?false(保守再推)', () => {
      expect(gate.looksLikeGoalSatisfied('已看完文�? 接下来我将重构核心模块�?)).toBe(false);
      expect(gate.looksLikeGoalSatisfied('已完成初步分�? 下一步我会写测试�?)).toBe(false);
      assert.equal(
        gate.looksLikeGoalSatisfied("I've finished reading; next I will implement it."),
        false
      );
  });

  test('looksLikeGoalSatisfied:�?纯前言/无完成信�?�?false', () => {
      expect(gate.looksLikeGoalSatisfied('')).toBe(false);
      expect(gate.looksLikeGoalSatisfied('   ')).toBe(false);
      expect(gate.looksLikeGoalSatisfied('让我先看看桌面上有什么文件�?)).toBe(false);
      expect(gate.looksLikeGoalSatisfied('我先来分析一下这个问题�?)).toBe(false);
  });

  test('buildRedriveMessage:含目标文本、二选一、GoalTool(clear)、用户请求截�?, () => {
      const m = gate.buildRedriveMessage(GOAL, { userMessage: '让khy学会使用goal模式' });
      expect(m).toContain(GOAL.text);
      expect(m.includes('GoalTool(action=clear).toBeTruthy()'));
      expect(m).toContain('尚未确认达成');
      expect(m).toContain('用户原始请求:');
      // �?userMessage 时不追加该行
      const m2 = gate.buildRedriveMessage(GOAL, {});
      expect(!m2).toContain('用户原始请求:');
  });

  test('evaluateGoalStop:门控�?�?pass(字节回退今日行为)', () => {
      const v = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '让我先看看�?,
        env: { KHY_GOAL_STOP_GATE: '0' },
      });
      expect(v.action).toBe('pass');
      expect(v.reason).toBe('gate-off');
      // 父门控关同样 pass
      assert.equal(
        gate.evaluateGoalStop({ goal: GOAL, reply: 'x', env: { KHY_GOAL: 'off' } }).action,
        'pass'
      );
  });

  test('evaluateGoalStop:无活动目�?�?pass', () => {
      expect(gate.evaluateGoalStop({ goal: null, reply: 'x', env: {} }).action).toBe('pass');
      expect(gate.evaluateGoalStop({ goal: { text: '' }, reply: 'x', env: {} }).action).toBe('pass');
  });

  test('evaluateGoalStop:达成 + 自动清除开 �?clear', () => {
      // 声称验证须带证据(证据门默认开),否则会被降级�?evidence-missing redrive
      const v = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '目标已完�?已验�?\n```\n8 passed\n```',
        env: {},
      });
      expect(v.action).toBe('clear');
      expect(v.reason).toBe('satisfied');
  });

  test('evaluateGoalStop:达成 + 自动清除�?�?pass(交由模型自清)', () => {
      const v = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '目标已完成�?,
        env: { KHY_GOAL_AUTO_CLEAR: '0' },
      });
      expect(v.action).toBe('pass');
      expect(v.reason).toBe('satisfied');
  });

  test('evaluateGoalStop:未达成且预算未耗尽 �?redrive(�?message)', () => {
      const v = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '我先看看代码�?,
        redriveCount: 0,
        env: {},
      });
      expect(v.action).toBe('redrive');
      expect(v.reason).toBe('not-satisfied');
      expect(v.message && v.message).toContain(GOAL.text);
  });

  test('evaluateGoalStop:未达成但预算耗尽 �?pass(跨轮由轮次预算兜�?', () => {
      // 默认 max=1:redriveCount>=1 即耗尽
      const v = gate.evaluateGoalStop({ goal: GOAL, reply: '继续分析中�?, redriveCount: 1, env: {} });
      expect(v.action).toBe('pass');
      expect(v.reason).toBe('redrive-exhausted');
      // max=0:任何未达成都直接 pass(不再驱动)
      const v0 = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '继续�?,
        redriveCount: 0,
        env: { KHY_GOAL_STOP_GATE_MAX: '0' },
      });
      expect(v0.action).toBe('pass');
  });

  test('evaluateGoalStop:reply 非字符串不抛,按未达成处理', () => {
      const v = gate.evaluateGoalStop({ goal: GOAL, reply: undefined, redriveCount: 0, env: {} });
      expect(v.action).toBe('redrive');
  });

  test('isEvidenceGateEnabled:默认开;显式 falsy �?父门�?KHY_GOAL_STOP_GATE/KHY_GOAL 关则本门也关', () => {
      expect(gate.isEvidenceGateEnabled({})).toBe(true);
      expect(gate.isEvidenceGateEnabled({ KHY_GOAL_EVIDENCE_GATE: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(gate.isEvidenceGateEnabled({ KHY_GOAL_EVIDENCE_GATE: v })).toBe(false);
      }
      expect(gate.isEvidenceGateEnabled({ KHY_GOAL_STOP_GATE: '0' })).toBe(false);
      expect(gate.isEvidenceGateEnabled({ KHY_GOAL: 'off', KHY_GOAL_EVIDENCE_GATE: '1' })).toBe(false);
  });

  test('hasConcreteEvidence:代码�?通过�?比�?退出码/TAP/对勾/PASS/shell/框架命令 �?true', () => {
      expect(gate.hasConcreteEvidence('结果:\n```\nok\n```')).toBe(true);
      expect(gate.hasConcreteEvidence('12 passed, 0 failed')).toBe(true);
      expect(gate.hasConcreteEvidence('单测 8 通过')).toBe(true);
      expect(gate.hasConcreteEvidence('回归 9/9 全绿')).toBe(true);
      expect(gate.hasConcreteEvidence('exit code 0')).toBe(true);
      expect(gate.hasConcreteEvidence('退出码 0')).toBe(true);
      expect(gate.hasConcreteEvidence('ok 1 - parses')).toBe(true);
      expect(gate.hasConcreteEvidence('# pass 8')).toBe(true);
      expect(gate.hasConcreteEvidence('�?all good')).toBe(true);
      expect(gate.hasConcreteEvidence('PASS src/foo.test.js')).toBe(true);
      expect(gate.hasConcreteEvidence('$ npm test')).toBe(true);
      expect(gate.hasConcreteEvidence('跑了 node --test 全绿')).toBe(true);
  });

  test('hasConcreteEvidence:空口声称/�?纯前言 �?false', () => {
      expect(gate.hasConcreteEvidence('')).toBe(false);
      expect(gate.hasConcreteEvidence('   ')).toBe(false);
      expect(gate.hasConcreteEvidence('已验证通过�?)).toBe(false);
      expect(gate.hasConcreteEvidence('全部测试通过, 目标达成�?)).toBe(false);
      expect(gate.hasConcreteEvidence('All tests passed.')).toBe(false);
  });

  test('claimsVerificationWithoutEvidence:声称验证但无证据 �?true;有证�?未声�?�?false', () => {
      // 声称验证 + 无证�?�?命中
      expect(gate.claimsVerificationWithoutEvidence('全部测试通过, 目标达成�?)).toBe(true);
      expect(gate.claimsVerificationWithoutEvidence('已验证通过�?)).toBe(true);
      expect(gate.claimsVerificationWithoutEvidence('All tests passed. Done.')).toBe(true);
      // 声称验证 + 有证�?�?不命�?      expect(gate.claimsVerificationWithoutEvidence('全部测试通过:\n```\n12 passed\n```')).toBe(false);
      expect(gate.claimsVerificationWithoutEvidence('已验证通过, 单测 9/9�?)).toBe(false);
      // 未声称验�?�?目标已完�?)�?不命�?保持原接受路径不被扰�?
      expect(gate.claimsVerificationWithoutEvidence('目标已完成�?)).toBe(false);
      expect(gate.claimsVerificationWithoutEvidence('已实现该功能�?)).toBe(false);
      // �?�?false
      expect(gate.claimsVerificationWithoutEvidence('')).toBe(false);
  });

  test('buildEvidenceRedriveMessage:含目标文本、要求粘贴输出、GoalTool(clear)、用户请求截�?, () => {
      const m = gate.buildEvidenceRedriveMessage(GOAL, { userMessage: '让khy学会' });
      expect(m).toContain(GOAL.text);
      expect(m.includes('GoalTool(action=clear).toBeTruthy()'));
      expect(m).toContain('没有任何**具体证据**');
      expect(m).toContain('用户原始请求:');
      const m2 = gate.buildEvidenceRedriveMessage(GOAL, {});
      expect(!m2).toContain('用户原始请求:');
  });

  test('evaluateGoalStop:声称验证但无证据 �?redrive(evidence-missing,带证据文�?', () => {
      const v = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '全部测试通过,目标已完成�?,
        redriveCount: 0,
        env: {},
      });
      expect(v.action).toBe('redrive');
      expect(v.reason).toBe('evidence-missing');
      expect(v.message && v.message).toContain('具体证据');
  });

  test('evaluateGoalStop:声称验证且有证据 �?clear(证据门放�?', () => {
      const v = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '全部测试通过:\n```\n12 passed, 0 failed\n```\n目标已完成�?,
        env: {},
      });
      expect(v.action).toBe('clear');
      expect(v.reason).toBe('satisfied');
  });

  test('evaluateGoalStop:证据门关 �?字节回退(声称无证据也 clear)', () => {
      const v = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '全部测试通过,目标已完成�?,
        env: { KHY_GOAL_EVIDENCE_GATE: '0' },
      });
      expect(v.action).toBe('clear');
      expect(v.reason).toBe('satisfied');
  });

  test('evaluateGoalStop:证据缺失�?redrive 预算耗尽 �?pass(不自动清除未证实目标)', () => {
      const v = gate.evaluateGoalStop({
        goal: GOAL,
        reply: '全部测试通过,目标已完成�?,
        redriveCount: 1,
        env: {},
      });
      expect(v.action).toBe('pass');
      expect(v.reason).toBe('evidence-missing-exhausted');
  });

  test('isCompletionContractEnabled:默认开;显式 falsy �?父门�?KHY_GOAL_STOP_GATE/KHY_GOAL 关则本门也关', () => {
      expect(gate.isCompletionContractEnabled({})).toBe(true);
      expect(gate.isCompletionContractEnabled({ KHY_GOAL_COMPLETION_CONTRACT: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(gate.isCompletionContractEnabled({ KHY_GOAL_COMPLETION_CONTRACT: v })).toBe(false);
      }
      expect(gate.isCompletionContractEnabled({ KHY_GOAL_STOP_GATE: '0' })).toBe(false);
      assert.equal(
        gate.isCompletionContractEnabled({ KHY_GOAL: 'off', KHY_GOAL_COMPLETION_CONTRACT: '1' }),
        false
      );
  });

  test('evaluateGoalStop:声明了标准但证据未全覆盖 �?redrive(contract-unmet,指名缺哪�?', () => {
      // reply 有测试证据但没跑 arch:god �?�?arch:god 一�?      const reply = '目标已完�?\n```\n12 passed\n```';
      const v = gate.evaluateGoalStop({ goal: GOAL_WITH_CONTRACT, reply, redriveCount: 0, env: {} });
      expect(v.action).toBe('redrive');
      expect(v.reason).toBe('contract-unmet');
      expect(v.message && v.message.includes('arch:god')).toBeTruthy();
  });

  test('evaluateGoalStop:声明了标准且证据逐条齐全 �?clear', () => {
      const reply = '目标已完�?\n```\n12 passed\n```\narch:god 检查通过,无超限�?;
      const v = gate.evaluateGoalStop({ goal: GOAL_WITH_CONTRACT, reply, env: {} });
      expect(v.action).toBe('clear');
      expect(v.reason).toBe('satisfied');
  });

  test('evaluateGoalStop:契约未覆盖但预算耗尽 �?pass(不自动清除证据不全目�?', () => {
      const reply = '目标已完�?\n```\n12 passed\n```';
      const v = gate.evaluateGoalStop({ goal: GOAL_WITH_CONTRACT, reply, redriveCount: 1, env: {} });
      expect(v.action).toBe('pass');
      expect(v.reason).toBe('contract-unmet-exhausted');
  });

  test('evaluateGoalStop:契约门关 �?字节回退(不再逐条核对,证据齐即 clear)', () => {
      const reply = '目标已完�?\n```\n12 passed\n```'; // 只满足测�?�?arch:god
      const v = gate.evaluateGoalStop({
        goal: GOAL_WITH_CONTRACT,
        reply,
        env: { KHY_GOAL_COMPLETION_CONTRACT: '0' },
      });
      expect(v.action).toBe('clear');
      expect(v.reason).toBe('satisfied');
  });

  test('evaluateGoalStop:目标无声明标�?�?契约不生�?既有行为不变)', () => {
      const v = gate.evaluateGoalStop({ goal: GOAL, reply: '目标已完成�?, env: {} });
      expect(v.action).toBe('clear');
      expect(v.reason).toBe('satisfied');
  });

});

