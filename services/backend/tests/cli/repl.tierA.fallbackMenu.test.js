'use strict';

/**
 * repl.tierA.fallbackMenu.test.js — Tier A(无模型 + 无网络)NL 诚实降级回归。
 *
 * 目标契约:「自然语言要能驱动一切 —— 无网络无模型也应可以」。当无可用模型且
 * localBrain.tryFallback **未命中**(返回 unhandled)时,REPL 打印「兜底能力菜单」
 * 作为本轮诚实回复。此前该分支漏设 responseAlreadyRendered=true 且 finalResponse 为
 * 空 → 触发下游 zero-silent-failure 闸门(empty_reply)→ 在诚实菜单之后再叠加一个
 * 自相矛盾的「模型请求失败」错误面板,破坏了 Tier A 的诚实降级契约。
 *
 * 本测试锁定修复后行为:
 *   - 兜底菜单被打印(用户看到诚实的本地能力清单);
 *   - 绝不再叠加 printErrorPanel(「模型请求失败」)—— 菜单本身即本轮回复;
 *   - 不触达模型(ai.chat 未被调用)。
 */

const {
  emitLineAndWait,
  waitForCondition,
  flushTimersAndAsync,
  setupCliHarness,
} = require('./replTestHarness');

describe('repl Tier A 无模型回退菜单', () => {
  const activeReadlines = [];
  let consoleLogSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    while (activeReadlines.length > 0) {
      const rl = activeReadlines.pop();
      try { rl.close(); } catch { /* ignore */ }
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('无模型 + tryFallback 未命中 → 打印诚实菜单,绝不叠加「模型请求失败」面板', async () => {
    const localBrainMock = {
      isModelAvailable: jest.fn(() => false),
      // 未命中:返回 null(等价 handled:false)→ 走兜底菜单分支
      tryFallback: jest.fn(async () => null),
      listCapabilities: jest.fn(() => ['列目录文件', '读取文件内容', '本地搜索']),
      pushContext: jest.fn(),
    };

    const quickTaskServiceMock = {
      detectQuickTask: jest.fn(() => null),
      executeQuickTask: jest.fn(),
      formatQuickTaskResult: jest.fn(),
    };

    const { rl, formatterMock, aiMock } = await setupCliHarness({
      mode: 'full',
      ai: {
        chat: jest.fn(async () => ({ reply: 'should-not-be-called', provider: 'mock-ai', tokenUsage: null })),
      },
      installMocks: () => {
        jest.doMock('../../src/services/localBrainService', () => localBrainMock);
        jest.doMock('../../src/services/quickTaskService', () => quickTaskServiceMock);
        jest.doMock('../../src/services/queryEngine', () => ({ isEnabled: jest.fn(() => false) }));
        jest.doMock('../../src/services/toolUseLoop', () => ({
          isEnabled: jest.fn(() => false),
          runToolUseLoop: jest.fn(),
        }));
      },
    });
    activeReadlines.push(rl);

    await emitLineAndWait(rl, '帮我看看当前目录有哪些文件');
    const completed = await waitForCondition(() => localBrainMock.tryFallback.mock.calls.length > 0);
    // tryFallback 在回合早期(打印菜单前)即被调用;下游 zero-silent-failure 闸门与
    // (buggy 版的)错误面板在回合更靠后的异步链里。再充分排空一段虚拟时间,确保整个
    // 回合落定后再断言 —— 否则会在错误面板代码执行**前**就断言通过,沦为空测试。
    for (let i = 0; i < 60; i += 1) await flushTimersAndAsync();

    expect(completed).toBe(true);
    expect(localBrainMock.tryFallback).toHaveBeenCalled();
    // 模型不可用 → 绝不触达模型
    expect(aiMock.chat).not.toHaveBeenCalled();

    const output = consoleLogSpy.mock.calls.map((args) => String(args[0] || ''));
    // 诚实菜单被打印
    expect(output.some((line) => line.includes('当前未配置 AI 模型'))).toBe(true);
    // 核心回归:菜单本身即本轮回复,绝不在其后再叠加自相矛盾的 empty_reply 道歉/
    // 「模型请求失败」。buggy 版会因空 finalResponse 触发 zero-silent-failure 闸门,
    // 在诚实菜单之后再打印「抱歉,本轮未能生成有效回复…」(实测命中此断言)。
    expect(output.some((line) => line.includes('未能生成有效回复'))).toBe(false);
    expect(output.some((line) => line.includes('模型请求失败'))).toBe(false);
    expect(formatterMock.printErrorPanel).not.toHaveBeenCalled();
  });
});
