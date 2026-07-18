'use strict';

/**
 * Tests for D3 extended ToolGuards: RateLimit, PathTraversal, ErrorRecovery.
 */

const {
  rateLimitGuard,
  pathTraversalGuard,
  errorRecoveryGuard,
  _toolCallCounts,
  RATE_LIMIT_MAX,
} = require('../../src/services/toolGuards');

describe('rateLimitGuard', () => {
  beforeEach(() => {
    _toolCallCounts.clear();
  });

  test('allows calls under the limit', () => {
    const result = rateLimitGuard({ toolName: 'readFile', params: {} });
    expect(result.action).toBe('allow');
  });

  test('allows up to RATE_LIMIT_MAX calls', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const r = rateLimitGuard({ toolName: 'editFile', params: {} });
      expect(r.action).toBe('allow');
    }
  });

  test('blocks after exceeding RATE_LIMIT_MAX', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      rateLimitGuard({ toolName: 'overused', params: {} });
    }
    const result = rateLimitGuard({ toolName: 'overused', params: {} });
    expect(result.action).toBe('block');
    expect(result.reason).toMatch(/Rate limit/);
  });

  test('allows when toolName is missing', () => {
    const result = rateLimitGuard({ params: {} });
    expect(result.action).toBe('allow');
  });

  test('tracks tools independently', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      rateLimitGuard({ toolName: 'toolA', params: {} });
    }
    // toolA is over limit
    expect(rateLimitGuard({ toolName: 'toolA', params: {} }).action).toBe('block');
    // toolB is still fine
    expect(rateLimitGuard({ toolName: 'toolB', params: {} }).action).toBe('allow');
  });
});

describe('pathTraversalGuard', () => {
  test('allows normal paths', () => {
    const result = pathTraversalGuard({ params: { file_path: 'src/index.js' } });
    expect(result.action).toBe('allow');
  });

  test('allows when no path params', () => {
    const result = pathTraversalGuard({ params: { content: 'hello' } });
    expect(result.action).toBe('allow');
  });

  test('allows benign .. in filenames', () => {
    // ".." without "/" or "\" after it
    const result = pathTraversalGuard({ params: { file_path: 'file..name.txt' } });
    expect(result.action).toBe('allow');
  });

  test('blocks path traversal escaping root', () => {
    // This depends on CWD being a real path; mock env
    const original = process.env.KHYQUANT_CWD;
    process.env.KHYQUANT_CWD = '/home/user/project';

    const result = pathTraversalGuard({ params: { file_path: '../../../etc/passwd' } });
    expect(result.action).toBe('block');
    expect(result.reason).toMatch(/Path traversal/);

    process.env.KHYQUANT_CWD = original;
  });

  test('allows .. that stays within root', () => {
    const original = process.env.KHYQUANT_CWD;
    process.env.KHYQUANT_CWD = '/home/user/project';

    const result = pathTraversalGuard({ params: { file_path: 'src/../lib/index.js' } });
    expect(result.action).toBe('allow');

    process.env.KHYQUANT_CWD = original;
  });
});

describe('errorRecoveryGuard', () => {
  test('allows successful results', () => {
    const result = errorRecoveryGuard({ result: { success: true, output: 'done' } });
    expect(result.action).toBe('allow');
  });

  test('allows null/undefined results', () => {
    expect(errorRecoveryGuard({ result: null }).action).toBe('allow');
    expect(errorRecoveryGuard({}).action).toBe('allow');
  });

  test('injects hint for old_string not found', () => {
    const result = errorRecoveryGuard({
      result: { success: false, error: 'old_string not found in file' },
    });
    expect(result.action).toBe('modify');
    expect(result.result._recoveryHint).toMatch(/Re-read the file/);
  });

  test('injects hint for permission denied', () => {
    const result = errorRecoveryGuard({
      result: { success: false, error: 'EACCES: permission denied' },
    });
    expect(result.action).toBe('modify');
    expect(result.result._recoveryHint).toMatch(/permission/i);
  });

  test('injects hint for timeout', () => {
    const result = errorRecoveryGuard({
      result: { success: false, output: 'Command timed out after 30s' },
    });
    expect(result.action).toBe('modify');
    expect(result.result._recoveryHint).toMatch(/timeout/i);
  });

  test('allows unknown errors without hint', () => {
    const result = errorRecoveryGuard({
      result: { success: false, error: 'Some random error' },
    });
    expect(result.action).toBe('allow');
  });
});

describe('toolCallGuardrail bounded LRU + TTL (REQ-2026-003)', () => {
  afterEach(() => {
    delete process.env.KHY_GUARDRAIL_MAX_ENTRIES;
    delete process.env.KHY_GUARDRAIL_TTL_MS;
    jest.resetModules();
  });

  test('_guardrailState never exceeds GUARDRAIL_MAX_ENTRIES across many distinct params', () => {
    jest.resetModules();
    process.env.KHY_GUARDRAIL_MAX_ENTRIES = '50';
    const g = require('../../src/services/toolGuards');
    expect(g.GUARDRAIL_MAX_ENTRIES).toBe(50);
    for (let i = 0; i < 500; i++) {
      g.toolCallGuardrail('readFile', { path: `f${i}.txt` });
    }
    expect(g._guardrailState.size).toBeLessThanOrEqual(50);
  });

  test('TTL sweep evicts stale entries on next call', () => {
    jest.resetModules();
    process.env.KHY_GUARDRAIL_TTL_MS = '1000';
    const g = require('../../src/services/toolGuards');
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_000_000);
      g.toolCallGuardrail('readFile', { path: 'old.txt' });
      expect(g._guardrailState.size).toBe(1);
      // Advance clock beyond TTL; the next call's eviction pass sweeps the stale key.
      nowSpy.mockReturnValue(1_000_000 + 5000);
      g.toolCallGuardrail('readFile', { path: 'new.txt' });
      // Only the fresh 'new.txt' key survives; 'old.txt' was TTL-swept.
      expect(g._guardrailState.size).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

