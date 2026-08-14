'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const detector = require('../src/services/gitExecutableDetector');

test('detectGitExecutable returns git when available in PATH', () => {
  detector.clearCache();

  const gitPath = detector.detectGitExecutable({
    platform: 'linux',
    _spawnSync: () => ({ status: 0 }), // 模拟 git --version 成功
  });

  assert.strictEqual(gitPath, 'git');
});

test('detectGitExecutable returns null when git not available', () => {
  detector.clearCache();

  const gitPath = detector.detectGitExecutable({
    platform: 'linux',
    _spawnSync: () => ({ status: 1 }), // 模拟 git --version 失败
  });

  assert.strictEqual(gitPath, null);
});

test('detectGitExecutable checks Git Bash paths on Windows', () => {
  detector.clearCache();

  const mockExists = (path) => path === 'C:\\Program Files\\Git\\bin\\git.exe';

  const gitPath = detector.detectGitExecutable({
    platform: 'win32',
    _existsSync: mockExists,
    _spawnSync: () => ({ status: 1 }), // 系统 PATH 的 git 不可用
  });

  assert.strictEqual(gitPath, 'C:\\Program Files\\Git\\bin\\git.exe');
});

test('detectGitExecutable falls back to system git when Git Bash not found', () => {
  detector.clearCache();

  const mockExists = () => false; // 所有显式路径都不存在

  const gitPath = detector.detectGitExecutable({
    platform: 'win32',
    _existsSync: mockExists,
    _spawnSync: () => ({ status: 0 }), // 系统 PATH 的 git 可用
  });

  assert.strictEqual(gitPath, 'git');
});

test('detectGitExecutable caches result', () => {
  detector.clearCache();

  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    return { status: 0 };
  };

  const gitPath1 = detector.detectGitExecutable({
    platform: 'linux',
    _spawnSync: mockSpawn,
  });

  const gitPath2 = detector.detectGitExecutable({
    platform: 'linux',
    _spawnSync: mockSpawn,
  });

  assert.strictEqual(gitPath1, 'git');
  assert.strictEqual(gitPath2, 'git');
  assert.strictEqual(callCount, 1, 'Should only call spawnSync once (cached)');
});

test('detectGitExecutable refresh option bypasses cache', () => {
  detector.clearCache();

  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    return { status: 0 };
  };

  detector.detectGitExecutable({ platform: 'linux', _spawnSync: mockSpawn });
  detector.detectGitExecutable({ platform: 'linux', _spawnSync: mockSpawn, refresh: true });

  assert.strictEqual(callCount, 2, 'Should call spawnSync twice (refresh=true)');
});

test('detectGitExecutable respects KHY_GIT_BASH_PATH', () => {
  detector.clearCache();

  const customPath = 'D:\\MyGit\\bin\\git.exe';
  const mockExists = (path) => path === customPath;

  const gitPath = detector.detectGitExecutable({
    platform: 'win32',
    env: { KHY_GIT_BASH_PATH: customPath },
    _existsSync: mockExists,
    _spawnSync: () => ({ status: 1 }),
  });

  assert.strictEqual(gitPath, customPath);
});

test('detectGitExecutable handles exceptions gracefully', () => {
  detector.clearCache();

  const gitPath = detector.detectGitExecutable({
    platform: 'linux',
    _spawnSync: () => { throw new Error('spawn failed'); },
  });

  assert.strictEqual(gitPath, null, 'Should return null on exception');
});

test('clearCache resets cached state', () => {
  detector.clearCache();

  detector.detectGitExecutable({
    platform: 'linux',
    _spawnSync: () => ({ status: 0 }),
  });

  let state = detector.getCacheState();
  assert.strictEqual(state.checked, true);
  assert.strictEqual(state.gitPath, 'git');

  detector.clearCache();

  state = detector.getCacheState();
  assert.strictEqual(state.checked, false);
  assert.strictEqual(state.gitPath, null);
});

test('buildNoGitMessage returns Windows-specific message', () => {
  const msg = detector.buildNoGitMessage({ platform: 'win32' });

  assert.ok(msg.includes('Git for Windows'));
  assert.ok(msg.includes('git-scm.com'));
  assert.ok(msg.includes('KHY_GIT_BASH_PATH'));
});

test('buildNoGitMessage returns Unix-specific message', () => {
  const msg = detector.buildNoGitMessage({ platform: 'linux' });

  assert.ok(msg.includes('apt-get install git'));
  assert.ok(!msg.includes('Git for Windows'));
});
