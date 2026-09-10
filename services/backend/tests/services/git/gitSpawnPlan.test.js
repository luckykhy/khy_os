'use strict';
const plan = require('../../../src/services/gitSpawnPlan');
// ── 门控(CANON 4 词)──────────────────────────────────────────────────────────
// ── toGitArgv:分词 + shell 元字符防御 ────────────────────────────────────────

describe('Git Spawn Plan', () => {
  test('isShellFreeGitEnabled: default-on', () => {
      expect(plan.isShellFreeGitEnabled({})).toBe(true);
      expect(plan.isShellFreeGitEnabled(undefined)).toBe(true);
  });

  test('isShellFreeGitEnabled: CANON falsy words → off', () => {
      for (const w of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(plan.isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: w })).toBe(false, w);
      }
  });

  test('isShellFreeGitEnabled: EXTENDED words stay on for CANON flag', () => {
      expect(plan.isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: 'disable' })).toBe(true);
      expect(plan.isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: 'disabled' })).toBe(true);
  });

  test('toGitArgv: tokenizes the real git-context commands', () => {
      expect(plan.toGitArgv('rev-parse --show-toplevel')).toEqual(['rev-parse', '--show-toplevel']);
      expect(plan.toGitArgv('rev-parse --abbrev-ref HEAD')).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
      expect(plan.toGitArgv('symbolic-ref refs/remotes/origin/HEAD')).toEqual(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      expect(plan.toGitArgv('branch --list main master')).toEqual(['branch', '--list', 'main', 'master']);
      expect(plan.toGitArgv('status --short --branch -u')).toEqual(['status', '--short', '--branch', '-u']);
      expect(plan.toGitArgv('log --oneline -15 --no-decorate')).toEqual(['log', '--oneline', '-15', '--no-decorate']);
      expect(plan.toGitArgv('diff --cached --stat')).toEqual(['diff', '--cached', '--stat']);
  });

  test('toGitArgv: collapses irregular whitespace', () => {
      expect(plan.toGitArgv('  rev-parse   --show-toplevel  ')).toEqual(['rev-parse', '--show-toplevel']);
  });

  test('toGitArgv: returns null on shell metacharacters (forces execSync fallback)', () => {
      expect(plan.toGitArgv('log --format="%H"')).toBe(null);      // quotes
      expect(plan.toGitArgv('status; rm -rf x')).toBe(null);        // ;
      expect(plan.toGitArgv('log | head')).toBe(null);             // pipe
      expect(plan.toGitArgv('log --pretty=$FORMAT')).toBe(null);    // $ var
      expect(plan.toGitArgv('log > out.txt')).toBe(null);          // redirect
      expect(plan.toGitArgv('log --grep=(x)')).toBe(null);         // parens
  });

  test('toGitArgv: null/empty/non-string → null', () => {
      expect(plan.toGitArgv('')).toBe(null);
      expect(plan.toGitArgv('   ')).toBe(null);
      expect(plan.toGitArgv(null)).toBe(null);
      expect(plan.toGitArgv(undefined)).toBe(null);
      expect(plan.toGitArgv(42)).toBe(null);
  });

  test('never throws', () => {
      expect(() => plan.isShellFreeGitEnabled(null).not.toThrow());
      expect(() => plan.toGitArgv({}).not.toThrow());
      expect(() => plan.toGitArgv([1, 2, 3]).not.toThrow());
  });

});
