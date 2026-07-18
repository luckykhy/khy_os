'use strict';

const test = require('node:test');
const assert = require('node:assert');

const plan = require('../../../src/services/gitSpawnPlan');

// ── 门控(CANON 4 词)──────────────────────────────────────────────────────────
test('isShellFreeGitEnabled: default-on', () => {
  assert.strictEqual(plan.isShellFreeGitEnabled({}), true);
  assert.strictEqual(plan.isShellFreeGitEnabled(undefined), true);
});

test('isShellFreeGitEnabled: CANON falsy words → off', () => {
  for (const w of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(plan.isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: w }), false, w);
  }
});

test('isShellFreeGitEnabled: EXTENDED words stay on for CANON flag', () => {
  assert.strictEqual(plan.isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: 'disable' }), true);
  assert.strictEqual(plan.isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: 'disabled' }), true);
});

// ── toGitArgv:分词 + shell 元字符防御 ────────────────────────────────────────
test('toGitArgv: tokenizes the real git-context commands', () => {
  assert.deepStrictEqual(plan.toGitArgv('rev-parse --show-toplevel'), ['rev-parse', '--show-toplevel']);
  assert.deepStrictEqual(plan.toGitArgv('rev-parse --abbrev-ref HEAD'), ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.deepStrictEqual(plan.toGitArgv('symbolic-ref refs/remotes/origin/HEAD'), ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  assert.deepStrictEqual(plan.toGitArgv('branch --list main master'), ['branch', '--list', 'main', 'master']);
  assert.deepStrictEqual(plan.toGitArgv('status --short --branch -u'), ['status', '--short', '--branch', '-u']);
  assert.deepStrictEqual(plan.toGitArgv('log --oneline -15 --no-decorate'), ['log', '--oneline', '-15', '--no-decorate']);
  assert.deepStrictEqual(plan.toGitArgv('diff --cached --stat'), ['diff', '--cached', '--stat']);
});

test('toGitArgv: collapses irregular whitespace', () => {
  assert.deepStrictEqual(plan.toGitArgv('  rev-parse   --show-toplevel  '), ['rev-parse', '--show-toplevel']);
});

test('toGitArgv: returns null on shell metacharacters (forces execSync fallback)', () => {
  assert.strictEqual(plan.toGitArgv('log --format="%H"'), null);      // quotes
  assert.strictEqual(plan.toGitArgv('status; rm -rf x'), null);        // ;
  assert.strictEqual(plan.toGitArgv('log | head'), null);             // pipe
  assert.strictEqual(plan.toGitArgv('log --pretty=$FORMAT'), null);    // $ var
  assert.strictEqual(plan.toGitArgv('log > out.txt'), null);          // redirect
  assert.strictEqual(plan.toGitArgv('log --grep=(x)'), null);         // parens
});

test('toGitArgv: null/empty/non-string → null', () => {
  assert.strictEqual(plan.toGitArgv(''), null);
  assert.strictEqual(plan.toGitArgv('   '), null);
  assert.strictEqual(plan.toGitArgv(null), null);
  assert.strictEqual(plan.toGitArgv(undefined), null);
  assert.strictEqual(plan.toGitArgv(42), null);
});

test('never throws', () => {
  assert.doesNotThrow(() => plan.isShellFreeGitEnabled(null));
  assert.doesNotThrow(() => plan.toGitArgv({}));
  assert.doesNotThrow(() => plan.toGitArgv([1, 2, 3]));
});
