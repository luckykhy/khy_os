'use strict';

/**
 * toolUseLoop.externalAgentNudge.integration.test.js
 *
 * 回归:externalAgentNudge 首轮注入的 TDZ 修复。
 *
 * 背景 bug:nudge 接线在 iteration===1 用 `sanitizedUser || userMessage`,但 sanitizedUser
 * 在本函数更靠后才 const 声明 → 此处引用触发 TDZ ReferenceError → 被 fail-soft catch 静默
 * 吞掉 → nudge 永不注入(点名「用 claude code」也从不委派)。修:改用 originalUserMessage
 * (函数早段声明·在 scope)。
 *
 * 本测试通过 mock chat 断言:用户点名外部 agent 时,**首轮** chat 收到的消息含路由 nudge;
 * 未点名时不含。用真实 runToolUseLoop(不 mock 叶子),故能捕获 TDZ 回归——若引用越界抛错
 * 被吞,首轮消息就不含 nudge,断言失败。
 */

describe('toolUseLoop — 外部 agent 点名首轮 nudge 注入(TDZ 回归)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  function makeChat() {
    // 首轮返回无工具的纯文本 → 循环收尾,足够捕获首轮注入的消息。
    return jest.fn().mockResolvedValue({ reply: '好的,已完成。' });
  }

  test('点名「用 claude code」→ 首轮 chat 消息含 [SYSTEM:外部 agent 路由] 与 subagent_type', async () => {
    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = makeChat();

    await toolUseLoop.runToolUseLoop('用 claude code 帮我读取 package.json 并总结', {
      chat,
      maxIterations: 2,
    });

    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(1);
    const firstTurn = String(chat.mock.calls[0][0] || '');
    expect(firstTurn).toContain('[SYSTEM:外部 agent 路由]');
    expect(firstTurn).toContain("subagent_type: 'claude'");
  }, 20000);

  test('未点名外部 agent → 首轮 chat 消息不含路由 nudge', async () => {
    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = makeChat();

    await toolUseLoop.runToolUseLoop('帮我读取 package.json 并总结', {
      chat,
      maxIterations: 2,
    });

    const firstTurn = String(chat.mock.calls[0][0] || '');
    expect(firstTurn).not.toContain('[SYSTEM:外部 agent 路由]');
  });

  test('门关 KHY_EXTERNAL_AGENT_NUDGE → 即便点名也不注入(逐字节回退)', async () => {
    process.env.KHY_EXTERNAL_AGENT_NUDGE = '0';
    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = makeChat();

    await toolUseLoop.runToolUseLoop('用 claude code 帮我读取 package.json 并总结', {
      chat,
      maxIterations: 2,
    });

    const firstTurn = String(chat.mock.calls[0][0] || '');
    expect(firstTurn).not.toContain('[SYSTEM:外部 agent 路由]');
  });
});
