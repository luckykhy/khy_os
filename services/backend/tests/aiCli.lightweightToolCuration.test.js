'use strict';

// 轻量对话工具裁剪回归:一句「你好」不该背着 160 个工具定义(≈5.7 万 token)去问模型。
// 见 aiMessageBuilder._isLightweightConversationTool / aiChatCore 的 _lightweightConversation。

function setupAiModule() {
  jest.resetModules();

  const calls = [];
  const gatewayGenerate = jest.fn(async (_prompt, opts) => {
    calls.push(opts || {});
    return {
      success: true,
      content: 'ok',
      provider: 'mock',
      adapter: 'mock',
    };
  });

  jest.doMock('../src/services/gateway/aiGateway', () => ({
    _initialized: true,
    isInitialized() {
      return this._initialized;
    },
    init: jest.fn(async () => {}),
    getStatus: jest.fn(() => []),
    getFirstAvailableAdapter: jest.fn(() => 'codex'),
    getActiveAdapter: jest.fn(() => null),
    generate: gatewayGenerate,
  }));

  jest.doMock('../src/services/traceAuditService', () => ({
    ensureDiagnosticsBridge: jest.fn(),
    attachTrace: jest.fn(),
    logEvent: jest.fn(),
  }));

  const ai = require('../src/cli/ai');
  return { ai, calls };
}

const toolNamesOf = (opts) =>
  (Array.isArray(opts.tools) ? opts.tools : [])
    .map((t) => t.name || (t.function && t.function.name))
    .filter(Boolean);

describe('lightweight conversation tool curation', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('greeting ships a small curated tool set, not the full catalog', async () => {
    delete process.env.KHY_GREETING_FASTPATH; // 走真实模型路径,才有 tools 可断言
    const { ai, calls } = setupAiModule();
    ai.clearHistory();

    await ai.chat('你好', {});

    expect(calls.length).toBeGreaterThan(0);
    const names = toolNamesOf(calls[0]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(40);

    // 逃生舱:模型仍能按需检索到其余工具
    expect(names).toContain('toolSearch');
    // 日常按需核心仍在
    expect(names).toContain('Read');
    expect(names).toContain('WebSearch');
    // 与招呼无关的重工具应被裁掉
    expect(names).not.toContain('backtest');
    expect(names).not.toContain('deploy');
    expect(names).not.toContain('security_scan');
  });

  test('a real task request still gets the full tool catalog', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    const { ai, calls } = setupAiModule();
    ai.clearHistory();

    await ai.chat('帮我重构 services 目录下的鉴权模块并补测试', {});

    expect(calls.length).toBeGreaterThan(0);
    const names = toolNamesOf(calls[0]);
    expect(names.length).toBeGreaterThan(40);
  });

  test('kill switch restores full injection for greetings', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    process.env.KHY_LIGHT_TOOL_CURATION = 'false';
    const { ai, calls } = setupAiModule();
    ai.clearHistory();

    await ai.chat('你好', {});

    expect(calls.length).toBeGreaterThan(0);
    expect(toolNamesOf(calls[0]).length).toBeGreaterThan(40);
  });
});
