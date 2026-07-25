'use strict';

/**
 * Tests for services/shellSafetyValidator.js — multi-layer shell command safety.
 */

const validator = require('../../src/services/shellSafetyValidator');

describe('shellSafetyValidator exports', () => {
  test('exports all expected functions', () => {
    expect(typeof validator.analyzeCommand).toBe('function');
    expect(typeof validator.unwrapCommand).toBe('function');
    expect(typeof validator.detectInterpreterScript).toBe('function');
    expect(typeof validator.checkShellBleed).toBe('function');
    expect(typeof validator.detectComplexSyntax).toBe('function');
    expect(typeof validator.detectInlineEval).toBe('function');
    expect(typeof validator.detectDangerousBuiltin).toBe('function');
    expect(typeof validator.splitShellArgs).toBe('function');
    expect(typeof validator.normalizeExe).toBe('function');
  });

  test('exports COMMAND_CARRIERS and POSIX_SHELLS sets', () => {
    expect(validator.COMMAND_CARRIERS).toBeInstanceOf(Set);
    expect(validator.POSIX_SHELLS).toBeInstanceOf(Set);
    expect(validator.COMMAND_CARRIERS.has('sudo')).toBe(true);
    expect(validator.POSIX_SHELLS.has('bash')).toBe(true);
  });
});

describe('splitShellArgs', () => {
  test('splits simple command', () => {
    expect(validator.splitShellArgs('ls -la /tmp')).toEqual(['ls', '-la', '/tmp']);
  });

  test('handles single-quoted strings', () => {
    expect(validator.splitShellArgs("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  test('handles double-quoted strings', () => {
    expect(validator.splitShellArgs('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  test('returns null for unbalanced quotes', () => {
    expect(validator.splitShellArgs("echo 'unclosed")).toBeNull();
  });

  test('handles empty string', () => {
    expect(validator.splitShellArgs('')).toEqual([]);
  });
});

describe('analyzeCommand — safe commands', () => {
  test('ls is safe', () => {
    const result = validator.analyzeCommand('ls -la');
    expect(result.safe).toBe(true);
    expect(result.maxSeverity).not.toBe('critical');
  });

  test('git status is safe', () => {
    const result = validator.analyzeCommand('git status');
    expect(result.safe).toBe(true);
  });

  test('cat a file is safe', () => {
    const result = validator.analyzeCommand('cat /etc/hosts');
    expect(result.safe).toBe(true);
  });
});

describe('analyzeCommand — dangerous patterns', () => {
  test('eval is critical risk', () => {
    const result = validator.analyzeCommand('eval "rm -rf /"');
    expect(result.safe).toBe(false);
    expect(result.risks.some(r => r.type === 'dangerous_builtin')).toBe(true);
  });

  test('sudo is unwrapped to effective command', () => {
    const result = validator.analyzeCommand('sudo ls -la');
    expect(result.wrappers).toContain('sudo');
    expect(result.effective).toContain('ls');
  });

  test('pipes are detected as complex syntax', () => {
    const result = validator.analyzeCommand('cat file | grep pattern');
    expect(result.risks.some(r => r.type === 'complex_syntax')).toBe(true);
  });
});

describe('detectInlineEval', () => {
  test('detects python -c', () => {
    const result = validator.detectInlineEval(['python3', '-c', 'print("hi")']);
    expect(result).not.toBeNull();
    expect(result.detected).toBe(true);
    expect(result.interpreter).toBe('python3');
    expect(result.flag).toBe('-c');
  });

  test('detects node -e', () => {
    const result = validator.detectInlineEval(['node', '-e', 'console.log(1)']);
    expect(result).not.toBeNull();
    expect(result.detected).toBe(true);
    expect(result.interpreter).toBe('node');
  });

  test('returns null for safe command', () => {
    const result = validator.detectInlineEval(['ls', '-la']);
    expect(result).toBeNull();
  });
});

describe('checkShellBleed', () => {
  test('detects shell variable injection', () => {
    const result = validator.checkShellBleed('echo $HOME and $PATH');
    expect(result.hasBleed).toBe(true);
    expect(result.variables).toContain('$HOME');
    expect(result.variables).toContain('$PATH');
  });

  test('returns no bleed for safe content', () => {
    const result = validator.checkShellBleed('print("hello world")');
    expect(result.hasBleed).toBe(false);
    expect(result.variables).toEqual([]);
  });

  test('handles null/empty input', () => {
    expect(validator.checkShellBleed(null).hasBleed).toBe(false);
    expect(validator.checkShellBleed('').hasBleed).toBe(false);
  });
});

describe('detectComplexSyntax', () => {
  test('detects pipe', () => {
    const result = validator.detectComplexSyntax('ls | grep test');
    expect(result.hasPipe).toBe(true);
    expect(result.hasComplexSyntax).toBe(true);
  });

  test('detects command substitution', () => {
    const result = validator.detectComplexSyntax('echo $(whoami)');
    expect(result.hasSubshell).toBe(true);
  });

  test('returns clean for simple command', () => {
    const result = validator.detectComplexSyntax('ls -la');
    expect(result.hasComplexSyntax).toBe(false);
  });
});
