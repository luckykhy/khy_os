'use strict';

const fs = require('fs');
const path = require('path');

const {
  emitLineAndWait,
  waitForCondition,
  setupCliHarness,
} = require('./replTestHarness');

describe('repl intent assurance debug toggle', () => {
  const activeReadlines = [];
  const settingsFile = path.join('/tmp', '.khy', 'settings.json');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    try { fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    while (activeReadlines.length > 0) {
      const rl = activeReadlines.pop();
      try { rl.close(); } catch { /* ignore */ }
    }
    try { fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true }); } catch { /* ignore */ }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('/intent on enables debug forwarding and renders extracted intent snapshot', async () => {
    const { rl, formatterMock, aiMock, aiRendererMock } = await setupCliHarness({
      mode: 'full',
      ai: {
        chat: jest.fn(async (_message, opts = {}) => {
          if (typeof opts.onStatus === 'function') {
            opts.onStatus({
              phase: 'intent_assurance_debug',
              message: '意图保护调试: 来源 runtime，主目标 1 条，约束 2 条，锚点 2 个，尾部补充 1 条（步骤 1/1）',
              source: 'runtime',
              shouldInject: true,
              requestClass: '代码/文件任务',
              primaryObjective: '检查 backend/src/cli/ai.js 的继续执行逻辑',
              summary: '检查 backend/src/cli/ai.js 的继续执行逻辑',
              constraints: ['不要改接口', '保留 Claude 兼容'],
              detailAnchors: ['backend/src/cli/ai.js', '继续执行'],
              tailDetails: ['另外保留 Claude 兼容'],
              constraintCount: 2,
              detailCount: 2,
              tailDetailCount: 1,
            });
            opts.onStatus({ phase: 'done', message: '完成' });
          }
          return { reply: 'done', provider: 'mock-ai', tokenUsage: null };
        }),
      },
      installMocks: () => {
        jest.doMock('../../src/services/queryEngine', () => ({ isEnabled: jest.fn(() => false) }));
        jest.doMock('../../src/services/toolUseLoop', () => ({
          isEnabled: jest.fn(() => false),
          runToolUseLoop: jest.fn(),
        }));
        jest.doMock('../../src/services/localBrainService', () => ({
          isModelAvailable: jest.fn(() => true),
          tryFallback: jest.fn(),
          listCapabilities: jest.fn(() => []),
          pushContext: jest.fn(),
        }));
        jest.doMock('../../src/services/quickTaskService', () => ({
          detectQuickTask: jest.fn(() => null),
          executeQuickTask: jest.fn(),
          formatQuickTaskResult: jest.fn(),
        }));
        jest.doMock('../../src/services/resourceGuard', () => ({
          startWatchdog: jest.fn(() => ({ touch: jest.fn(), done: jest.fn() })),
          WATCHDOG_TIMEOUT_MS: 300000,
          cancelAll: jest.fn(),
        }));
      },
    });
    activeReadlines.push(rl);

    await emitLineAndWait(rl, '/intent on');
    expect(formatterMock.printSuccess).toHaveBeenCalledWith('已开启意图保护调试显示');

    await emitLineAndWait(rl, '帮我看看 backend/src/cli/ai.js，不要改接口，另外保留 Claude 兼容。');
    const completed = await waitForCondition(() => aiMock.chat.mock.calls.length > 0);
    const rendered = await waitForCondition(() =>
      aiRendererMock.printStepLine.mock.calls.some((call) => call[1] === '意图保护')
    );

    expect(completed).toBe(true);
    expect(rendered).toBe(true);
    expect(aiMock.chat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        intentAssuranceDebug: true,
      })
    );

    const intentStepCalls = aiRendererMock.printStepLine.mock.calls
      .filter((call) => call[1] === '意图保护');
    expect(intentStepCalls.length).toBeGreaterThan(0);
    expect(intentStepCalls.some((call) => String(call[2] || '').includes('代码/文件任务'))).toBe(true);
    expect(intentStepCalls.some((call) => String(call[3] || '').includes('约束 2'))).toBe(true);

    const detailLines = aiRendererMock.printStepDetail.mock.calls.map((call) => String(call[0] || ''));
    expect(detailLines.some((line) => line.includes('主目标: 检查 backend/src/cli/ai.js 的继续执行逻辑'))).toBe(true);
    expect(detailLines.some((line) => line.includes('显式约束: 不要改接口 | 保留 Claude 兼容'))).toBe(true);
    expect(detailLines.some((line) => line.includes('细节锚点: backend/src/cli/ai.js | 继续执行'))).toBe(true);
    expect(detailLines.some((line) => line.includes('尾部补充: 另外保留 Claude 兼容'))).toBe(true);
  });

  test('persisted /intent setting is reloaded after repl restart', async () => {
    const first = await setupCliHarness({
      mode: 'full',
      ai: {
        chat: jest.fn(async () => ({ reply: 'first', provider: 'mock-ai', tokenUsage: null })),
      },
      installMocks: () => {
        jest.doMock('../../src/services/queryEngine', () => ({ isEnabled: jest.fn(() => false) }));
        jest.doMock('../../src/services/toolUseLoop', () => ({
          isEnabled: jest.fn(() => false),
          runToolUseLoop: jest.fn(),
        }));
        jest.doMock('../../src/services/localBrainService', () => ({
          isModelAvailable: jest.fn(() => true),
          tryFallback: jest.fn(),
          listCapabilities: jest.fn(() => []),
          pushContext: jest.fn(),
        }));
        jest.doMock('../../src/services/quickTaskService', () => ({
          detectQuickTask: jest.fn(() => null),
          executeQuickTask: jest.fn(),
          formatQuickTaskResult: jest.fn(),
        }));
        jest.doMock('../../src/services/resourceGuard', () => ({
          startWatchdog: jest.fn(() => ({ touch: jest.fn(), done: jest.fn() })),
          WATCHDOG_TIMEOUT_MS: 300000,
          cancelAll: jest.fn(),
        }));
      },
    });
    activeReadlines.push(first.rl);

    await emitLineAndWait(first.rl, '/intent on');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(saved.intentAssuranceDebug).toBe(true);

    try { first.rl.close(); } catch { /* ignore */ }
    activeReadlines.pop();

    const second = await setupCliHarness({
      mode: 'full',
      ai: {
        chat: jest.fn(async (_message, opts = {}) => {
          if (typeof opts.onStatus === 'function') {
            opts.onStatus({ phase: 'done', message: '完成' });
          }
          return { reply: 'second', provider: 'mock-ai', tokenUsage: null };
        }),
      },
      installMocks: () => {
        jest.doMock('../../src/services/queryEngine', () => ({ isEnabled: jest.fn(() => false) }));
        jest.doMock('../../src/services/toolUseLoop', () => ({
          isEnabled: jest.fn(() => false),
          runToolUseLoop: jest.fn(),
        }));
        jest.doMock('../../src/services/localBrainService', () => ({
          isModelAvailable: jest.fn(() => true),
          tryFallback: jest.fn(),
          listCapabilities: jest.fn(() => []),
          pushContext: jest.fn(),
        }));
        jest.doMock('../../src/services/quickTaskService', () => ({
          detectQuickTask: jest.fn(() => null),
          executeQuickTask: jest.fn(),
          formatQuickTaskResult: jest.fn(),
        }));
        jest.doMock('../../src/services/resourceGuard', () => ({
          startWatchdog: jest.fn(() => ({ touch: jest.fn(), done: jest.fn() })),
          WATCHDOG_TIMEOUT_MS: 300000,
          cancelAll: jest.fn(),
        }));
      },
    });
    activeReadlines.push(second.rl);

    await emitLineAndWait(second.rl, '再次检查这个设置是否自动生效');
    const completed = await waitForCondition(() => second.aiMock.chat.mock.calls.length > 0);

    expect(completed).toBe(true);
    expect(second.aiMock.chat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        intentAssuranceDebug: true,
      })
    );
  });
});
