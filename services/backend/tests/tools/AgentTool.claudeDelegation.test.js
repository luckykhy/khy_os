'use strict';

/**
 * AgentTool × Claude Code 委派接线集成测试（jest）。
 *
 * 验证用户两条诉求在 execute() 端到端落地：
 *   ① 显式 subagent_type:'claude' + claude 可用 → 委派，结果 delegated:true。
 *   ② 显式 claude 但 CLI 不可用 → 不强求、不中断：降级为 Khy 自身 agent 跑完，
 *      结果 delegated:false + delegationReason 说明原因（任务仍成功完成）。
 *
 * toolUseLoop 被 mock，避免触真适配器/网络；探测经 mock claudeAdapter.detect 控制。
 */

describe('AgentTool Claude Code delegation wiring', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  function mockLoop() {
    const runToolUseLoop = jest.fn(async () => ({ finalResponse: 'done', iterations: 1 }));
    jest.doMock('../../src/services/toolUseLoop', () => ({ isEnabled: () => true, runToolUseLoop }));
    jest.doMock('../../src/cli/ai', () => ({ chat: jest.fn(async () => ({ reply: 'unused' })) }));
    return runToolUseLoop;
  }

  test('explicit claude + 可用 → delegated:true, delegatedTo:claude-code', async () => {
    mockLoop();
    jest.doMock('../../src/services/gateway/adapters/claudeAdapter', () => ({ detect: () => true }));

    const agentTool = require('../../src/tools/AgentTool');
    const result = await agentTool.execute(
      { prompt: 'Refactor across multiple files', subagent_type: 'claude' },
      { traceContext: {} }
    );

    expect(result.success).toBe(true);
    expect(result.delegated).toBe(true);
    expect(result.delegatedTo).toBe('claude-code');
    expect(result.role).toBe('claude');
  });

  test('explicit claude + 不可用 → 不报错、降级跑完，delegated:false + reason 含「未安装」', async () => {
    mockLoop();
    jest.doMock('../../src/services/gateway/adapters/claudeAdapter', () => ({ detect: () => false }));

    const agentTool = require('../../src/tools/AgentTool');
    const result = await agentTool.execute(
      { prompt: 'Refactor across multiple files', subagent_type: 'claude' },
      { traceContext: {} }
    );

    // 任务仍成功完成（绝不因 claude 缺失中断）。
    expect(result.success).toBe(true);
    expect(result.delegated).toBe(false);
    expect(result.delegatedTo).toBeNull();
    expect(result.delegationReason).toMatch(/未安装/);
    // 已降级为 Khy 自身 general agent。
    expect(result.role).toBe('general');
  });

  test('显式委派决策经 progressCallback 上报（透明度）', async () => {
    mockLoop();
    jest.doMock('../../src/services/gateway/adapters/claudeAdapter', () => ({ detect: () => false }));

    const agentTool = require('../../src/tools/AgentTool');
    const onAgentProgress = jest.fn();
    await agentTool.execute(
      { prompt: 'Refactor across multiple files', subagent_type: 'claude' },
      { traceContext: { onAgentProgress } }
    );

    const delegationEvent = onAgentProgress.mock.calls
      .map(c => c[0])
      .find(e => e && e.type === 'delegation');
    expect(delegationEvent).toBeTruthy();
    expect(delegationEvent.delegated).toBe(false);
    expect(delegationEvent.reason).toMatch(/未安装/);
  });
});
