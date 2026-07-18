'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const resolver = require('../src/services/gitExecutableResolver');

test('resolveGitCandidates returns Git Bash paths first on Windows', () => {
  const candidates = resolver.resolveGitCandidates({ platform: 'win32' });

  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length > 0);

  // 最后一个应该是 'git' 回退
  assert.strictEqual(candidates[candidates.length - 1], 'git');

  // 前面应该包含 Git Bash 路径
  const hasGitBashPath = candidates.some(c => c.includes('Program Files') && c.includes('Git'));
  assert.ok(hasGitBashPath, 'Should include Git Bash candidate path');
});

test('resolveGitCandidates returns only git on Unix', () => {
  const candidates = resolver.resolveGitCandidates({ platform: 'linux' });

  assert.ok(Array.isArray(candidates));
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0], 'git');
});

test('resolveGitCandidates respects KHY_GIT_BASH_PATH env override', () => {
  const customPath = 'D:\\CustomGit\\bin\\git.exe';
  const candidates = resolver.resolveGitCandidates({
    platform: 'win32',
    env: { KHY_GIT_BASH_PATH: customPath },
  });

  assert.strictEqual(candidates[0], customPath);
  assert.strictEqual(candidates[candidates.length - 1], 'git');
});

test('shouldPreferGitBash returns true on Windows, false elsewhere', () => {
  assert.strictEqual(resolver.shouldPreferGitBash({ platform: 'win32' }), true);
  assert.strictEqual(resolver.shouldPreferGitBash({ platform: 'linux' }), false);
  assert.strictEqual(resolver.shouldPreferGitBash({ platform: 'darwin' }), false);
});

test('classifyCandidates separates Git Bash paths from system fallback', () => {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Git\\bin\\git.exe',
    'git',
  ];

  const result = resolver.classifyCandidates(candidates);

  assert.strictEqual(result.gitBashPaths.length, 2);
  assert.ok(result.gitBashPaths.includes('C:\\Program Files\\Git\\bin\\git.exe'));
  assert.ok(result.gitBashPaths.includes('C:\\Git\\bin\\git.exe'));
  assert.strictEqual(result.systemFallback, 'git');
});

test('classifyCandidates handles empty array', () => {
  const result = resolver.classifyCandidates([]);

  assert.strictEqual(result.gitBashPaths.length, 0);
  assert.strictEqual(result.systemFallback, 'git');
});

test('buildGitPathLabel identifies Git Bash paths', () => {
  const label1 = resolver.buildGitPathLabel('C:\\Program Files\\Git\\bin\\git.exe');
  assert.ok(label1.includes('Git Bash'));

  const label2 = resolver.buildGitPathLabel('git');
  assert.strictEqual(label2, 'git (system PATH)');

  const label3 = resolver.buildGitPathLabel('/usr/local/bin/git');
  assert.strictEqual(label3, '/usr/local/bin/git');
});

test('GIT_BASH_CANDIDATE_PATHS_WINDOWS includes standard paths', () => {
  const paths = resolver.GIT_BASH_CANDIDATE_PATHS_WINDOWS;

  assert.ok(Array.isArray(paths));
  assert.ok(paths.length >= 2);

  // 应包含 64 位默认路径
  const has64bit = paths.some(p => p === 'C:\\Program Files\\Git\\bin\\git.exe');
  assert.ok(has64bit);

  // 应包含 32 位路径
  const has32bit = paths.some(p => p.includes('Program Files (x86)'));
  assert.ok(has32bit);
});
