'use strict';

/**
 * externalAgentPanelReachability.test.js — 回归:弱模型(T3)面板裁剪 × 外部 agent 委派可达性。
 *
 * 背景(实测发现的自相矛盾):toolUseLoop 对 T3 弱模型把工具面板裁到 coding profile,而
 * coding profile 不含 Agent 工具;但 externalAgentDirective(parent=KHY_WEAK_MODEL_GUIDANCE,
 * 专打弱模型)向 coding profile 注入「调 Agent 工具 subagent_type 委派外部 CLI agent」指令 +
 * 点名 nudge。结果弱模型被指令要求用一个它面板里看不见的工具 → 无法委派 → 只能内联做。
 *
 * 修:裁剪处 directive 开时把 'agent' 保留进 allowedSet(byte-revert:门关不加)。
 * 本测试复现裁剪处的可达性判决(不依赖 runToolUseLoop 全链),锁定契约。
 */

const { getProfileTools } = require('../../tools/toolProfile');
const ead = require('../externalAgentDirective');

// 复现 toolUseLoop.js:1798 裁剪块的可达性决策(仅 Agent 相关部分)。
function survivesTrim(toolName, env) {
  const allowed = getProfileTools('coding');
  const allowedSet = new Set(allowed.map((n) => n.toLowerCase()));
  // 外部 agent 委派可达性:directive 开 → 保留 Agent。
  if (ead.isExternalAgentDirectiveEnabled(env)) allowedSet.add('agent');
  return allowedSet.has(String(toolName || '').toLowerCase());
}

describe('弱模型面板裁剪 × 外部 agent 可达性', () => {
  test('前提:coding profile 本身不含 Agent 工具(bug 根因)', () => {
    const coding = getProfileTools('coding').map((n) => n.toLowerCase());
    expect(coding.includes('agent')).toBe(false);
  });

  test('directive 默认 on → Agent 工具在弱模型面板存活(委派可达)', () => {
    // Agent 工具规范名 'Agent'(AgentTool.toolName)。
    expect(survivesTrim('Agent', {})).toBe(true);
  });

  test('directive 关 → Agent 被裁(逐字节回退,与修复前一致)', () => {
    expect(survivesTrim('Agent', { KHY_EXTERNAL_AGENT_DIRECTIVE: '0' })).toBe(false);
  });

  test('父门 KHY_WEAK_MODEL_GUIDANCE 关 → directive 必关 → Agent 被裁', () => {
    expect(survivesTrim('Agent', { KHY_WEAK_MODEL_GUIDANCE: 'false' })).toBe(false);
  });

  test('非 Agent 工具不受影响:coding 内工具恒存活、profile 外工具恒被裁', () => {
    // editFile 属 coding profile → 恒存活(与 directive 无关)。
    expect(survivesTrim('editFile', {})).toBe(true);
    expect(survivesTrim('editFile', { KHY_EXTERNAL_AGENT_DIRECTIVE: '0' })).toBe(true);
    // backtest 属 analysis profile,不属 coding → 恒被裁。
    expect(survivesTrim('backtest', {})).toBe(false);
    expect(survivesTrim('backtest', { KHY_EXTERNAL_AGENT_DIRECTIVE: '0' })).toBe(false);
  });
});
