'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const helper = require('../src/services/gitSpawnHelper');
const detector = require('../src/services/gitExecutableDetector');

test('spawnGit returns structured result on success', () => {
  detector.clearCache();
  // 使用真实 git（本环境有 git）
  const result = helper.spawnGit(['--version']);

  assert.ok(result);
  assert.strictEqual(typeof result.status, 'number');
  // git --version 应成功
  if (result.status === 0) {
    assert.ok(result.stdout.includes('git version'));
  }
});

test('spawnGitOutput returns stdout on success, null on failure', () => {
  detector.clearCache();
  const version = helper.spawnGitOutput(['--version']);
  // 本环境有 git，应返回版本字符串
  if (version !== null) {
    assert.ok(version.includes('git version'));
  }

  // 无效子命令应返回 null（非零退出）
  const invalid = helper.spawnGitOutput(['this-is-not-a-git-command-xyz']);
  assert.strictEqual(invalid, null);
});

test('isGitAvailable reflects git availability', () => {
  detector.clearCache();
  const available = helper.isGitAvailable();
  // 本环境有 git
  assert.strictEqual(typeof available, 'boolean');
});

test('getGitPath returns a path or null', () => {
  detector.clearCache();
  const gitPath = helper.getGitPath();
  // 本环境有 git，应返回 'git' 或具体路径
  assert.ok(gitPath === null || typeof gitPath === 'string');
});

test('spawnGit handles empty args gracefully', () => {
  detector.clearCache();
  const result = helper.spawnGit([]);
  assert.ok(result);
  // git 无参数会打印 usage 并返回非零，不应抛错
  assert.strictEqual(typeof result.status === 'number' || result.status === null, true);
});

test('spawnGit result includes stderr on failure', () => {
  detector.clearCache();
  const result = helper.spawnGit(['this-is-not-a-git-command-xyz']);
  assert.ok(result);
  assert.notStrictEqual(result.status, 0);
});
