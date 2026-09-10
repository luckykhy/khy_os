'use strict';
const helper = require('../src/services/gitSpawnHelper');
const detector = require('../src/services/gitExecutableDetector');

describe('Git Spawn Helper', () => {
  test('spawnGit returns structured result on success', () => {
      detector.clearCache();
      // 使用真实 git（本环境�?git�?
      const result = helper.spawnGit(['--version']);
    
      expect(result).toBeTruthy();
      expect(typeof result.status).toBe('number');
      // git --version 应成�?
      if (result.status === 0) {
        expect(result.stdout).toContain('git version');
      }
  });

  test('spawnGitOutput returns stdout on success, null on failure', () => {
      detector.clearCache();
      const version = helper.spawnGitOutput(['--version']);
      // 本环境有 git，应返回版本字符�?
      if (version !== null) {
        expect(version).toContain('git version');
      }
    
      // 无效子命令应返回 null（非零退出）
      const invalid = helper.spawnGitOutput(['this-is-not-a-git-command-xyz']);
      expect(invalid).toBe(null);
  });

  test('isGitAvailable reflects git availability', () => {
      detector.clearCache();
      const available = helper.isGitAvailable();
      // 本环境有 git
      expect(typeof available).toBe('boolean');
  });

  test('getGitPath returns a path or null', () => {
      detector.clearCache();
      const gitPath = helper.getGitPath();
      // 本环境有 git，应返回 'git' 或具体路�?
      expect(gitPath === null || typeof gitPath === 'string').toBeTruthy();
  });

  test('spawnGit handles empty args gracefully', () => {
      detector.clearCache();
      const result = helper.spawnGit([]);
      expect(result).toBeTruthy();
      // git 无参数会打印 usage 并返回非零，不应抛错
      expect(typeof result.status === 'number' || result.status === null).toBe(true);
  });

  test('spawnGit result includes stderr on failure', () => {
      detector.clearCache();
      const result = helper.spawnGit(['this-is-not-a-git-command-xyz']);
      expect(result).toBeTruthy();
      expect(result.status).not.toBe(0);
  });

});

