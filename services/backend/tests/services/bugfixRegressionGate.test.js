'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/services/verificationAgent', () => ({
  detectProject: jest.fn(),
  verify: jest.fn(),
}));

jest.mock('../../src/services/gateway/aiGateway', () => ({
  getActiveAdapter: jest.fn(() => null),
  getFirstAvailableAdapter: jest.fn(() => 'api'),
}));

const verificationAgent = require('../../src/services/verificationAgent');
const {
  prepareBugfixRegressionGate,
  evaluateBugfixRegressionGate,
  looksLikeBugfixTask,
  isLowTierModel,
  collectChangedFiles,
} = require('../../src/services/bugfixRegressionGate');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-gate-test-'));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

describe('bugfixRegressionGate', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.KHY_BUGFIX_MIN_REQUIRED_STEPS;
    delete process.env.KHY_BUGFIX_REGRESSION_GATE;
    delete process.env.KHY_BUGFIX_LOW_TIER_ONLY;
    delete process.env.KHY_BUGFIX_GATE_BASELINE;
    delete process.env.KHY_BUGFIX_FAIL_ON_MISSING_REQUIRED_STEPS;
    delete process.env.KHY_BUGFIX_GATE_FAIL_OPEN;
    delete process.env.KHY_CHANGE_MIN_REQUIRED_STEPS;
    delete process.env.KHY_CHANGE_REGRESSION_GATE;
    delete process.env.KHY_CHANGE_LOW_TIER_ONLY;
    delete process.env.KHY_CHANGE_GATE_INCLUDE_FEATURE;
    delete process.env.KHY_CHANGE_FAIL_ON_MISSING_REQUIRED_STEPS;
    delete process.env.KHY_CHANGE_GATE_FAIL_OPEN;
    delete process.env.KHY_CHANGE_GATE_BASELINE;

    verificationAgent.detectProject.mockReturnValue({
      type: 'node',
      steps: ['syntax', 'test'],
    });
    verificationAgent.verify.mockReturnValue({
      passed: true,
      steps: [
        { name: 'syntax', pass: true, output: 'ok', durationMs: 10 },
        { name: 'test', pass: true, output: 'ok', durationMs: 20 },
      ],
      summary: 'All 2 verification step(s) passed.',
      projectType: 'node',
    });
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test('detects bugfix intent from user message', () => {
    expect(looksLikeBugfixTask('请修复这个 bug')).toBe(true);
    expect(looksLikeBugfixTask('add a new feature')).toBe(false);
  });

  test('detects low-tier models by model id or adapter', () => {
    expect(isLowTierModel({ model: 'gpt-4o-mini', adapter: 'api' })).toBe(true);
    expect(isLowTierModel({ model: 'claude-opus-4', adapter: 'api' })).toBe(false);
    expect(isLowTierModel({ model: 'custom-model', adapter: 'ollama' })).toBe(true);
  });

  test('prepare gate activates for low-tier bugfix task and captures baseline', () => {
    const gate = prepareBugfixRegressionGate({
      userMessage: 'please fix this regression bug',
      chatOpts: { preferredModel: 'gpt-4o-mini', preferredAdapter: 'api' },
      cwd: process.cwd(),
    });

    expect(gate.enabled).toBe(true);
    expect(gate.shouldRun).toBe(true);
    expect(gate.lowTierModel).toBe(true);
    expect(gate.bugfixIntent).toBe(true);
    expect(gate.requiredSteps).toEqual(['syntax', 'test']);
    expect(gate.baseline).not.toBeNull();
    expect(verificationAgent.verify).toHaveBeenCalledTimes(1);
  });

  test('prepare gate skips high-tier model when low-tier-only is enabled', () => {
    const gate = prepareBugfixRegressionGate({
      userMessage: 'fix the parser bug',
      chatOpts: { preferredModel: 'claude-opus-4', preferredAdapter: 'api' },
      cwd: process.cwd(),
    });

    expect(gate.shouldRun).toBe(false);
    expect(gate.reason).toContain('low-tier-only');
    expect(gate.baseline).toBeNull();
  });

  test('prepare gate also activates for feature implementation on low-tier model', () => {
    const gate = prepareBugfixRegressionGate({
      userMessage: '新增一个风控功能并实现对应接口',
      chatOpts: { preferredModel: 'gpt-4o-mini', preferredAdapter: 'api' },
      cwd: process.cwd(),
    });

    expect(gate.shouldRun).toBe(true);
    expect(gate.taskIntent).toBe('feature');
    expect(gate.featureIntent).toBe(true);
  });

  test('change-prefixed env keys override legacy bugfix keys', () => {
    process.env.KHY_BUGFIX_REGRESSION_GATE = 'false';
    process.env.KHY_CHANGE_REGRESSION_GATE = 'true';

    const gate = prepareBugfixRegressionGate({
      userMessage: 'fix bug in settlement',
      chatOpts: { preferredModel: 'gpt-4o-mini', preferredAdapter: 'api' },
      cwd: process.cwd(),
    });

    expect(gate.enabled).toBe(true);
    expect(gate.shouldRun).toBe(true);
  });

  test('evaluate fails when post-change run has new failing steps', () => {
    verificationAgent.verify
      .mockReturnValueOnce({
        passed: true,
        steps: [
          { name: 'syntax', pass: true, output: 'ok', durationMs: 10 },
          { name: 'test', pass: true, output: 'ok', durationMs: 20 },
        ],
        summary: 'All 2 verification step(s) passed.',
        projectType: 'node',
      })
      .mockReturnValueOnce({
        passed: false,
        steps: [
          { name: 'syntax', pass: true, output: 'ok', durationMs: 10 },
          { name: 'test', pass: false, output: '1 failed', durationMs: 20 },
        ],
        summary: '1/2 step(s) failed: test.',
        projectType: 'node',
      });

    const gate = prepareBugfixRegressionGate({
      userMessage: 'fix bug in order matcher',
      chatOpts: { preferredModel: 'gpt-4o-mini', preferredAdapter: 'api' },
      cwd: process.cwd(),
    });
    const report = evaluateBugfixRegressionGate({
      context: gate,
      cwd: process.cwd(),
      toolCallLog: [],
    });

    expect(report.passed).toBe(false);
    expect(report.regressedSteps).toEqual(['test']);
    expect(report.summary).toContain('blocked delivery');
  });

  test('evaluate passes when failures do not increase vs baseline', () => {
    verificationAgent.verify
      .mockReturnValueOnce({
        passed: false,
        steps: [
          { name: 'syntax', pass: true, output: 'ok', durationMs: 10 },
          { name: 'test', pass: false, output: 'existing failure', durationMs: 20 },
        ],
        summary: '1/2 step(s) failed: test.',
        projectType: 'node',
      })
      .mockReturnValueOnce({
        passed: false,
        steps: [
          { name: 'syntax', pass: true, output: 'ok', durationMs: 10 },
          { name: 'test', pass: false, output: 'existing failure', durationMs: 20 },
        ],
        summary: '1/2 step(s) failed: test.',
        projectType: 'node',
      });

    const gate = prepareBugfixRegressionGate({
      userMessage: 'fix bug in checkout flow',
      chatOpts: { preferredModel: 'gpt-4o-mini', preferredAdapter: 'api' },
      cwd: process.cwd(),
    });
    const report = evaluateBugfixRegressionGate({
      context: gate,
      cwd: process.cwd(),
      toolCallLog: [],
    });

    expect(report.passed).toBe(true);
    expect(report.regressedSteps).toEqual([]);
    expect(report.failCountIncreased).toBe(false);
  });

  test('evaluate uses clean-run policy when baseline is disabled', () => {
    process.env.KHY_BUGFIX_GATE_BASELINE = 'false';
    verificationAgent.verify.mockReturnValue({
      passed: true,
      steps: [
        { name: 'syntax', pass: true, output: 'ok', durationMs: 10 },
        { name: 'test', pass: true, output: 'ok', durationMs: 20 },
      ],
      summary: 'All 2 verification step(s) passed.',
      projectType: 'node',
    });

    const gate = prepareBugfixRegressionGate({
      userMessage: '新增一个风控校验功能',
      chatOpts: { preferredModel: 'gpt-4o-mini', preferredAdapter: 'api' },
      cwd: process.cwd(),
    });
    expect(gate.runBaseline).toBe(false);
    expect(gate.baseline).toBeNull();

    const report = evaluateBugfixRegressionGate({
      context: gate,
      cwd: process.cwd(),
      toolCallLog: [],
    });

    expect(report.passed).toBe(true);
    expect(report.mode).toBe('no_baseline');
    expect(report.summary).toContain('baseline disabled');
  });

  test('evaluate blocks when no verification steps are detectable', () => {
    process.env.KHY_BUGFIX_GATE_BASELINE = 'false';
    verificationAgent.detectProject.mockReturnValue({
      type: 'unknown',
      steps: [],
    });
    verificationAgent.verify.mockReturnValue({
      passed: true,
      steps: [],
      summary: 'No verification steps detected.',
      projectType: 'unknown',
    });

    const gate = prepareBugfixRegressionGate({
      userMessage: '新增一个结算功能',
      chatOpts: { preferredModel: 'gpt-4o-mini', preferredAdapter: 'api' },
      cwd: process.cwd(),
    });
    const report = evaluateBugfixRegressionGate({
      context: gate,
      cwd: process.cwd(),
      toolCallLog: [],
    });

    expect(report.passed).toBe(false);
    expect(report.error).toContain('no verification steps detected');
  });

  test('collectChangedFiles extracts writable file paths from tool log', () => {
    const tmpDir = createTmpDir();
    try {
      const fileA = path.join(tmpDir, 'a.js');
      const fileB = path.join(tmpDir, 'b.js');
      fs.writeFileSync(fileA, 'const a = 1;\n');
      fs.writeFileSync(fileB, 'const b = 2;\n');

      const changed = collectChangedFiles([
        { tool: 'editFile', params: { path: fileA } },
        { tool: 'write_file', params: { path: 'b.js' } },
        { tool: 'read_file', params: { path: 'ignored.js' } },
      ], tmpDir);

      expect(changed.sort()).toEqual(['a.js', 'b.js']);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});
