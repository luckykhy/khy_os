'use strict';

const {
  emitLineAndWait,
  waitForCondition,
  setupCliHarness,
} = require('./replTestHarness');

describe('repl /tasks interaction', () => {
  let consoleLogSpy;
  const activeReadlines = [];

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

  test('shows /tasks help usage in interactive line mode', async () => {
    const taskControlServiceMock = {
      controlTask: jest.fn(),
      listTasks: jest.fn(() => []),
      getTaskDetail: jest.fn(),
    };
    const { rl } = await setupCliHarness({
      mode: 'full',
      taskControlService: taskControlServiceMock,
    });
    activeReadlines.push(rl);

    await emitLineAndWait(rl, '/tasks help');

    const output = consoleLogSpy.mock.calls.map((args) => String(args[0] || ''));
    expect(output.some((line) => line.includes('/tasks 用法:'))).toBe(true);
    expect(output.some((line) => line.includes('/tasks <taskId>'))).toBe(true);
    expect(taskControlServiceMock.controlTask).not.toHaveBeenCalled();
    expect(taskControlServiceMock.getTaskDetail).not.toHaveBeenCalled();
  });

  test('renders /tasks <taskId> detail via taskControlService audit payload', async () => {
    const now = '2026-05-19T12:00:00.000Z';
    const taskControlServiceMock = {
      controlTask: jest.fn(),
      listTasks: jest.fn(() => []),
      getTaskDetail: jest.fn(() => ({
        ok: true,
        task: {
          id: 'task-1',
          status: 'running',
          type: 'demo-task',
          payload_json: { source: 'background_task_manager', description: 'detail test' },
          progress_pct: 40,
          attempt_count: 1,
          max_attempts: 3,
          created_at: now,
          updated_at: now,
        },
        audit: {
          attempts: [{
            attempt_no: 1,
            result_status: 'running',
            error_type: null,
            retry_delay_ms: null,
            started_at: now,
            ended_at: now,
          }],
          events: [{
            event_id: 11,
            state_from: 'claimed',
            state_to: 'running',
            attempt_no: 1,
            at: now,
          }],
        },
      })),
    };
    const { rl, formatterMock } = await setupCliHarness({
      mode: 'full',
      taskControlService: taskControlServiceMock,
    });
    activeReadlines.push(rl);

    await emitLineAndWait(rl, '/tasks task-1');

    expect(taskControlServiceMock.getTaskDetail).toHaveBeenCalledWith('task-1', { includeAudit: true });
    expect(consoleLogSpy.mock.calls.some((args) => String(args[0] || '').includes('任务详情: task-1'))).toBe(true);
    expect(formatterMock.printTable).toHaveBeenCalled();
    const tableHeaders = formatterMock.printTable.mock.calls.map((call) => call[0]);
    expect(tableHeaders.some((headers) => Array.isArray(headers) && headers.includes('尝试'))).toBe(true);
    expect(tableHeaders.some((headers) => Array.isArray(headers) && headers.includes('事件'))).toBe(true);
  });

  test('supports mixed Chinese/English aliases in /tasks control commands', async () => {
    const taskControlServiceMock = {
      listTasks: jest.fn(() => []),
      getTaskDetail: jest.fn(),
      controlTask: jest.fn((taskId, action, options = {}) => {
        if (action === 'pause') return { ok: true, task: { id: taskId, status: 'paused' } };
        if (action === 'resume') return { ok: true, task: { id: taskId, status: 'running' } };
        return {
          ok: true,
          task: { id: taskId, status: 'cancelled' },
          reasonEcho: options.reason,
        };
      }),
    };
    const { rl, formatterMock } = await setupCliHarness({
      mode: 'full',
      taskControlService: taskControlServiceMock,
    });
    activeReadlines.push(rl);

    await emitLineAndWait(rl, '/tasks 暂停 t-alias');
    await emitLineAndWait(rl, '/tasks resume t-alias');
    await emitLineAndWait(rl, '/tasks 取消 t-alias 手动停止');

    expect(taskControlServiceMock.controlTask).toHaveBeenNthCalledWith(1, 't-alias', 'pause', {});
    expect(taskControlServiceMock.controlTask).toHaveBeenNthCalledWith(2, 't-alias', 'resume', {});
    expect(taskControlServiceMock.controlTask).toHaveBeenNthCalledWith(3, 't-alias', 'cancel', { reason: '手动停止' });

    const successLines = formatterMock.printSuccess.mock.calls.map((call) => String(call[0] || ''));
    expect(successLines.some((line) => line.includes('已暂停任务: t-alias'))).toBe(true);
    expect(successLines.some((line) => line.includes('已恢复任务: t-alias'))).toBe(true);
    expect(successLines.some((line) => line.includes('已取消任务: t-alias'))).toBe(true);
  });

  test('local greeting fallback renders the intro only once', async () => {
    const taskControlServiceMock = {
      controlTask: jest.fn(),
      listTasks: jest.fn(() => []),
      getTaskDetail: jest.fn(),
    };

    const introText = '你好！我是 KHY — 你的本地智能助手。';
    const localBrainMock = {
      isModelAvailable: jest.fn(() => false),
      tryFallback: jest.fn(async () => ({
        handled: true,
        response: introText,
        category: '问候',
      })),
      listCapabilities: jest.fn(() => []),
      pushContext: jest.fn(),
    };

    const quickTaskServiceMock = {
      detectQuickTask: jest.fn(() => null),
      executeQuickTask: jest.fn(),
      formatQuickTaskResult: jest.fn(),
    };

    const { rl, formatterMock, aiMock, aiRendererMock } = await setupCliHarness({
      mode: 'full',
      taskControlService: taskControlServiceMock,
      ai: {
        chat: jest.fn(async () => ({ reply: 'ignored', provider: 'mock-ai', tokenUsage: null })),
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

    await emitLineAndWait(rl, '你好');
    const completed = await waitForCondition(() => localBrainMock.tryFallback.mock.calls.length > 0);

    expect(completed).toBe(true);
    expect(localBrainMock.tryFallback).toHaveBeenCalled();
    expect(aiMock.chat).not.toHaveBeenCalled();
    const renderedIntroCalls = aiRendererMock.renderAiResponse.mock.calls
      .filter((call) => String(call[0] || '').includes(introText));
    expect(renderedIntroCalls).toHaveLength(0);
    expect(formatterMock.printError).not.toHaveBeenCalled();
  });

  test('deterministic quick-task reply is not rendered twice', async () => {
    const taskControlServiceMock = {
      controlTask: jest.fn(),
      listTasks: jest.fn(() => []),
      getTaskDetail: jest.fn(),
    };

    const quickReply = '123 * 456 = 56088';
    const localBrainMock = {
      isModelAvailable: jest.fn(() => true),
      tryFallback: jest.fn(),
      listCapabilities: jest.fn(() => []),
      pushContext: jest.fn(),
    };

    const quickTaskServiceMock = {
      detectQuickTask: jest.fn(() => ({ type: 'math', label: '计算', category: 'math' })),
      executeQuickTask: jest.fn(async () => ({ success: true, value: 56088 })),
      formatQuickTaskResult: jest.fn(() => quickReply),
    };

    const { rl, aiMock, aiRendererMock } = await setupCliHarness({
      mode: 'full',
      taskControlService: taskControlServiceMock,
      ai: {
        chat: jest.fn(async () => ({ reply: 'ignored', provider: 'mock-ai', tokenUsage: null })),
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

    await emitLineAndWait(rl, '123 * 456');
    const completed = await waitForCondition(() => quickTaskServiceMock.executeQuickTask.mock.calls.length > 0);

    expect(completed).toBe(true);
    expect(quickTaskServiceMock.executeQuickTask).toHaveBeenCalled();
    expect(aiMock.chat).not.toHaveBeenCalled();
    const renderedQuickCalls = aiRendererMock.renderAiResponse.mock.calls
      .filter((call) => String(call[0] || '').includes(quickReply));
    expect(renderedQuickCalls).toHaveLength(1);
  });
});
