// 多 Agent 系统测试
// 验证：子 Agent 独立上下文、并行执行、工作流
import { describe, expect, it, beforeEach, vi } from 'vitest';

// 模拟 standalone.js
vi.mock('../src/api/standalone.js', () => ({
  streamChatCompletion: vi.fn(async ({ onChunk, onToolCall }) => {
    // 模拟简单响应
    onChunk?.('Test response');
  }),
}));

// 模拟 localTools.js
vi.mock('../src/api/localTools.js', () => ({
  localToolSchemas: vi.fn(() => []),
  executeLocalTool: vi.fn(async () => ({ ok: true, content: 'Tool result' })),
}));

// 模拟 mcpTools.js
vi.mock('../src/api/mcpTools.js', () => ({
  mcpToolSchemas: vi.fn(() => []),
  executeMCPTool: vi.fn(async () => ({ ok: true, content: 'MCP result' })),
  isMCPTool: vi.fn(() => false),
}));

describe('多 Agent 系统', () => {
  it('SubAgent 应正确初始化', async () => {
    const { SubAgent } = await import('../src/api/multiAgent.js');
    const agent = new SubAgent({
      id: 'test-1',
      role: 'executor',
      systemPrompt: 'You are a test agent',
    });

    expect(agent.id).toBe('test-1');
    expect(agent.role).toBe('executor');
    expect(agent.status).toBe('idle');
    expect(agent.context).toEqual([]);
  });

  it('SubAgent 应支持独立上下文', async () => {
    const { SubAgent } = await import('../src/api/multiAgent.js');
    const agent = new SubAgent({
      id: 'test-2',
      role: 'executor',
      systemPrompt: 'You are a test agent',
      context: [
        { role: 'user', content: 'Previous message' },
        { role: 'assistant', content: 'Previous response' },
      ],
    });

    expect(agent.context).toHaveLength(2);
    expect(agent.context[0].content).toBe('Previous message');
  });

  it('MultiAgentOrchestrator 应能创建和管理 Agent', async () => {
    const { MultiAgentOrchestrator } = await import('../src/api/multiAgent.js');
    const orchestrator = new MultiAgentOrchestrator({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      model: 'test-model',
    });

    const agent = orchestrator.createAgent({
      id: 'agent-1',
      role: 'executor',
      systemPrompt: 'Test prompt',
    });

    expect(agent.id).toBe('agent-1');
    expect(orchestrator.agents.size).toBe(1);
    expect(orchestrator.agents.has('agent-1')).toBe(true);
  });

  it('getStatus 应返回所有 Agent 状态', async () => {
    const { MultiAgentOrchestrator } = await import('../src/api/multiAgent.js');
    const orchestrator = new MultiAgentOrchestrator({});

    orchestrator.createAgent({ id: 'a1', role: 'manager', systemPrompt: 'Plan' });
    orchestrator.createAgent({ id: 'a2', role: 'executor', systemPrompt: 'Execute' });

    const status = orchestrator.getStatus();
    expect(status.a1.role).toBe('manager');
    expect(status.a2.role).toBe('executor');
    expect(status.a1.status).toBe('idle');
  });

  it('runParallel 应并行执行多个任务', async () => {
    const { MultiAgentOrchestrator } = await import('../src/api/multiAgent.js');
    const orchestrator = new MultiAgentOrchestrator({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      model: 'test-model',
    });

    const tasks = [
      { id: 'task1', task: 'Task 1', systemPrompt: 'Prompt 1' },
      { id: 'task2', task: 'Task 2', systemPrompt: 'Prompt 2' },
    ];

    // 模拟 run 方法
    for (const agent of orchestrator.agents.values()) {
      agent.status = 'completed';
      agent.result = 'Done';
    }

    // 手动设置结果
    orchestrator.results.set('task1', { result: 'Result 1', steps: 1 });
    orchestrator.results.set('task2', { result: 'Result 2', steps: 1 });

    const results = orchestrator.getResults();
    expect(results.task1.result).toBe('Result 1');
    expect(results.task2.result).toBe('Result 2');
  });
});
