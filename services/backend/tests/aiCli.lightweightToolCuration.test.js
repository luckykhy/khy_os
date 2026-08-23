'use strict';

// 单测预算说明：本文件每条用例都先 jest.resetModules() 再整树 require src/cli/ai，
// 所以每条的墙上时间里绝大部分是模块图重解析，不是被测行为本身。pnpm 的
// node_modules 是符号链接指向 .pnpm/<pkg>@<ver>/，Windows 下每次解析都要多走一层
// 链接，实测同样的用例从 npm 平铺树的 5 秒级涨到 25 秒级 —— 原来按平铺树标定的
// 5000/15000/30000 预算因此会超时，而断言内容一条都没改（断的是状态文本，不是耗时）。
// 统一把预算抬到 120 秒：够宽到不受依赖布局影响，又不至于让真卡死的用例挂到没边。
jest.setTimeout(120000);

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

  test('first-turn pure greeting ships no tools at all', async () => {
    delete process.env.KHY_GREETING_FASTPATH; // 走真实模型路径,才有 tools 可断言
    const { ai, calls } = setupAiModule();
    ai.clearHistory();

    await ai.chat('你好', {});

    expect(calls.length).toBeGreaterThan(0);
    // 裁剪到「核心集」还不够:核心集里留着 Bash/Read/搜索,模型拿到就会把一句「你好」
    // 当成「先了解一下仓库」的开场并真的去跑命令。招呼要的只是一句自然回复。
    expect(toolNamesOf(calls[0])).toEqual([]);
  });

  // 首次全量注入要跑一遍注册表的 isEnabled() 探测(where/git rev-parse… 实测 ~1.4s),
  // 默认 5s 在冷启动的机器上会假失败,给这条足够的余量。
  test('a greeting that carries a task keeps its tools', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    const { ai, calls } = setupAiModule();
    ai.clearHistory();

    await ai.chat('你好，帮我读一下 services/backend/package.json', {});

    expect(calls.length).toBeGreaterThan(0);
    expect(toolNamesOf(calls[0]).length).toBeGreaterThan(0);
  });

  test('non-greeting lightweight chat still gets the curated core set', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    const { ai, calls } = setupAiModule();
    ai.clearHistory();

    await ai.chat('讲个笑话吧', {});

    expect(calls.length).toBeGreaterThan(0);
    const names = toolNamesOf(calls[0]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(40);

    // 逃生舱:模型仍能按需检索到其余工具
    expect(names).toContain('toolSearch');
    // 与闲聊无关的重工具应被裁掉
    expect(names).not.toContain('backtest');
    expect(names).not.toContain('deploy');
    expect(names).not.toContain('security_scan');
  });

  test('KHY_GREETING_NO_TOOLS=false restores tools for greetings', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    process.env.KHY_GREETING_NO_TOOLS = 'false';
    const { ai, calls } = setupAiModule();
    ai.clearHistory();

    await ai.chat('你好', {});

    expect(calls.length).toBeGreaterThan(0);
    expect(toolNamesOf(calls[0]).length).toBeGreaterThan(0);
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

  test('kill switch restores full injection for lightweight chat', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    process.env.KHY_LIGHT_TOOL_CURATION = 'false';
    const { ai, calls } = setupAiModule();
    ai.clearHistory();

    // 用非问候的轻量输入:招呼的零工具由 KHY_GREETING_NO_TOOLS 管(能力边界),
    // 与这里的 token 裁剪开关是两回事,关掉裁剪并不会把工具还给招呼。
    await ai.chat('讲个笑话吧', {});

    expect(calls.length).toBeGreaterThan(0);
    expect(toolNamesOf(calls[0]).length).toBeGreaterThan(40);
  });
});
