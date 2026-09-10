'use strict';

const { execFileSync } = require('child_process');

jest.mock('child_process');

const gitSoftExec = require('../../src/utils/gitSoftExec');

describe('gitSoftExec', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns ok with trimmed output on success', () => {
    execFileSync.mockReturnValue(Buffer.from('  hello world  \n'));
    const result = gitSoftExec(['status'], '/tmp');
    expect(result).toEqual({ ok: true, out: 'hello world' });
    expect(execFileSync).toHaveBeenCalledWith('git', ['status'], {
      cwd: '/tmp',
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  test('returns ok with string output', () => {
    execFileSync.mockReturnValue('clean output');
    const result = gitSoftExec(['log', '-1'], '/repo');
    expect(result).toEqual({ ok: true, out: 'clean output' });
  });

  test('returns not ok with error message on failure', () => {
    execFileSync.mockImplementation(() => {
      const err = new Error('git: command not found');
      throw err;
    });
    const result = gitSoftExec(['status'], '/tmp');
    expect(result.ok).toBe(false);
    expect(result.out).toBe('');
    expect(result.err).toBe('git: command not found');
  });

  test('handles error without message', () => {
    execFileSync.mockImplementation(() => {
      throw 'raw error';
    });
    const result = gitSoftExec(['status'], '/tmp');
    expect(result).toEqual({ ok: false, out: '', err: 'raw error' });
  });

  test('handles null/undefined error', () => {
    execFileSync.mockImplementation(() => {
      throw null;
    });
    const result = gitSoftExec(['status'], '/tmp');
    expect(result.ok).toBe(false);
    expect(result.out).toBe('');
  });

  test('passes cwd correctly', () => {
    execFileSync.mockReturnValue('output');
    gitSoftExec(['branch'], '/custom/path');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['branch'],
      expect.objectContaining({ cwd: '/custom/path' })
    );
  });

  test('passes args correctly', () => {
    execFileSync.mockReturnValue('output');
    gitSoftExec(['commit', '-m', 'test message'], '/repo');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'test message'],
      expect.any(Object)
    );
  });
});

