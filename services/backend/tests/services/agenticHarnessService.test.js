'use strict';

jest.mock('../../src/services/contextRouter', () => ({
  routeContextStrategy: jest.fn(),
  truncateToolResults: jest.fn(),
}));

jest.mock('../../src/services/contextCompressor', () => ({
  compress: jest.fn(),
}));

jest.mock('../../src/services/contextWasm', () => ({
  estimateTokens: jest.fn(() => 10),
}));

jest.mock('../../src/services/toolUseLoop', () => ({
  runToolUseLoop: jest.fn(),
}));

jest.mock('../../src/services/backgroundTaskManager', () => ({
  register: jest.fn(),
  complete: jest.fn(),
  fail: jest.fn(),
}));

jest.mock('../../src/services/projectMemoryService', () => ({
  saveSessionTrace: jest.fn(),
}));

jest.mock('../../src/services/changeRegressionGate', () => ({
  prepareBugfixRegressionGate: jest.fn(),
  evaluateBugfixRegressionGate: jest.fn(),
}));

jest.mock('../../src/memdir', () => ({
  searchMemories: jest.fn(),
}));

jest.mock('../../src/skills', () => ({
  discoverAllSkills: jest.fn(),
  getActiveSkills: jest.fn(),
}));

const { createAgenticHarness } = require('../../src/services/agenticHarnessService');
const contextRouter = require('../../src/services/contextRouter');
const contextCompressor = require('../../src/services/contextCompressor');
const toolUseLoop = require('../../src/services/toolUseLoop');
const bgTask = require('../../src/services/backgroundTaskManager');
const projectMemoryService = require('../../src/services/projectMemoryService');
const changeRegressionGate = require('../../src/services/changeRegressionGate');
const memdir = require('../../src/memdir');
const skills = require('../../src/skills');

function makeBgHandle(id = 'bg_1') {
  return {
    task: {
      id,
      meta: {},
      updatedAt: Date.now(),
    },
    signal: { aborted: false },
    release: () => {},
  };
}

describe('agenticHarnessService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    bgTask.register.mockReturnValue(makeBgHandle());
    contextCompressor.compress.mockResolvedValue({ compressed: [] });
    memdir.searchMemories.mockReturnValue([]);
    skills.discoverAllSkills.mockImplementation(() => {});
    skills.getActiveSkills.mockReturnValue([]);
    changeRegressionGate.prepareBugfixRegressionGate.mockReturnValue({
      enabled: true,
      shouldRun: false,
      reason: 'not bugfix',
      baseline: null,
    });
    changeRegressionGate.evaluateBugfixRegressionGate.mockReturnValue({
      enabled: true,
      skipped: true,
      passed: true,
      reason: 'not active',
      summary: 'Bugfix regression gate skipped.',
    });
  });

  test('buildContextPacket applies context route and tool truncation strategy', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'truncate_tool_results_only',
      overflow: 32,
      toolResultTokens: 180,
    });

    const harness = createAgenticHarness();
    const packet = await harness.buildContextPacket({
      userMessage: 'check logs',
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'tool', content: 'tool-result' },
      ],
    });

    expect(packet.contextRoute.route).toBe('truncate_tool_results_only');
    expect(contextRouter.truncateToolResults).toHaveBeenCalledTimes(1);
    expect(contextRouter.truncateToolResults.mock.calls[0][1]).toBe(32);
  });

  test('run retries transient loop outcome and returns recovered result', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    toolUseLoop.runToolUseLoop
      .mockResolvedValueOnce({
        finalResponse: 'temporary network issue',
        errorType: 'network',
        toolCallLog: [],
        iterations: 1,
      })
      .mockResolvedValueOnce({
        finalResponse: 'recovered',
        errorType: null,
        toolCallLog: [],
        iterations: 2,
        provider: 'mock',
      });

    const harness = createAgenticHarness({
      retryAttempts: 2,
      retryMinDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    const result = await harness.run({
      userMessage: 'run task',
      chat: async () => ({ reply: 'unused' }),
    });

    expect(toolUseLoop.runToolUseLoop).toHaveBeenCalledTimes(2);
    expect(result.finalResponse).toBe('recovered');
    expect(bgTask.complete).toHaveBeenCalledTimes(1);
    expect(projectMemoryService.saveSessionTrace).toHaveBeenCalledTimes(1);
    const report = bgTask.complete.mock.calls[0][1];
    expect(report.deliveryVerdict).toBeTruthy();
    expect(report.deliveryVerdict.verdict).toBe('pass');
  });

  test('run blocks delivery when bugfix regression gate reports new failures', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    changeRegressionGate.prepareBugfixRegressionGate.mockReturnValue({
      enabled: true,
      shouldRun: true,
      reason: 'active',
      requiredSteps: ['syntax', 'test'],
      model: 'gpt-4o-mini',
      adapter: 'api',
      baseline: { summary: 'All 2 verification step(s) passed.' },
    });
    changeRegressionGate.evaluateBugfixRegressionGate.mockReturnValue({
      enabled: true,
      skipped: false,
      passed: false,
      reason: 'active',
      summary: 'Bugfix regression gate blocked delivery: new failing step(s): test.',
      regressedSteps: ['test'],
      changedFiles: ['backend/src/demo.js'],
      requiredSteps: ['syntax', 'test'],
      recommendations: ['Reproduce the new failing steps and fix them before final delivery.'],
    });

    toolUseLoop.runToolUseLoop.mockResolvedValue({
      finalResponse: 'patch applied',
      errorType: null,
      toolCallLog: [{ tool: 'editFile', params: { path: 'backend/src/demo.js' }, success: true }],
      iterations: 2,
      provider: 'mock',
    });

    const harness = createAgenticHarness();
    const result = await harness.run({
      userMessage: 'please fix bug in parser',
      chat: async () => ({ reply: 'unused' }),
    });

    expect(result.errorType).toBe('regression_gate');
    expect(result.finalResponse).toContain('[Regression Gate]');
    expect(result.finalResponse).toContain('blocked delivery');
    expect(bgTask.complete).toHaveBeenCalledTimes(1);
    const report = bgTask.complete.mock.calls[0][1];
    expect(report.deliveryVerdict).toMatchObject({
      verdict: 'fail',
      blockedBy: expect.arrayContaining(['regression_gate']),
    });
    expect(report.regressionGate).toMatchObject({
      passed: false,
      regressedSteps: ['test'],
    });
  });

  test('run emits both change and legacy regression gate events for compatibility', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    changeRegressionGate.prepareBugfixRegressionGate.mockReturnValue({
      enabled: true,
      shouldRun: true,
      reason: 'active',
      requiredSteps: ['syntax', 'test'],
      model: 'gpt-4o-mini',
      adapter: 'api',
      baseline: { summary: 'All 2 verification step(s) passed.' },
    });
    changeRegressionGate.evaluateBugfixRegressionGate.mockReturnValue({
      enabled: true,
      skipped: false,
      passed: true,
      reason: 'active',
      summary: 'Change regression gate passed.',
      regressedSteps: [],
      changedFiles: [],
      requiredSteps: ['syntax', 'test'],
      recommendations: [],
    });

    toolUseLoop.runToolUseLoop.mockResolvedValue({
      finalResponse: 'ok',
      errorType: null,
      toolCallLog: [],
      iterations: 1,
      provider: 'mock',
    });

    const events = [];
    const harness = createAgenticHarness();
    await harness.run({
      userMessage: 'fix bug in parser',
      chat: async () => ({ reply: 'unused' }),
      onEvent: (event) => { events.push(event); },
    });

    const baselineTypes = events
      .filter(e => e && e.phase === 'baseline_completed')
      .map(e => e.type);
    const finalTypes = events
      .filter(e => e && e.phase === 'final_evaluation')
      .map(e => e.type);

    expect(baselineTypes).toEqual(expect.arrayContaining(['change_regression_gate', 'bugfix_regression_gate']));
    expect(finalTypes).toEqual(expect.arrayContaining(['change_regression_gate', 'bugfix_regression_gate']));
  });

  test('buildContextPacket produces ranked memory and skill hints', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    memdir.searchMemories.mockImplementation((query) => {
      if (String(query).includes('alpha')) {
        return [
          {
            filename: 'alpha.md',
            frontmatter: { name: 'Alpha Decision', description: 'alpha strategy decision' },
            matches: ['alpha strategy baseline'],
          },
          {
            filename: 'beta.md',
            frontmatter: { name: 'Beta Note', description: 'beta plan' },
            matches: ['beta context only'],
          },
        ];
      }
      return [];
    });

    skills.getActiveSkills.mockReturnValue([
      {
        name: 'alpha-skill',
        trigger: '/alpha',
        description: 'alpha workflow helper',
        tags: ['alpha', 'workflow'],
      },
      {
        name: 'beta-skill',
        trigger: '/beta',
        description: 'beta workflow helper',
        tags: ['beta'],
      },
    ]);

    const harness = createAgenticHarness();
    const packet = await harness.buildContextPacket({
      userMessage: 'need alpha workflow update',
      cwd: process.cwd(),
      recentFiles: ['src/alpha.js'],
    });

    expect(packet.memoryHints.length).toBeGreaterThan(0);
    expect(packet.memoryHints[0].filename).toBe('alpha.md');
    expect(packet.skillHints.length).toBeGreaterThan(0);
    expect(packet.skillHints[0].trigger).toBe('/alpha');
    expect(skills.discoverAllSkills).toHaveBeenCalled();
  });
});
