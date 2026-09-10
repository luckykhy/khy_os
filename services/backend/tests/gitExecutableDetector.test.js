'use strict';
const detector = require('../src/services/gitExecutableDetector');

describe('Git Executable Detector', () => {
  test('detectGitExecutable returns git when available in PATH', () => {
      detector.clearCache();
    
      const gitPath = detector.detectGitExecutable({
        platform: 'linux',
        _spawnSync: () => ({ status: 0 }), // 模拟 git --version 成功
      });
    
      expect(gitPath).toBe('git');
  });

  test('detectGitExecutable returns null when git not available', () => {
      detector.clearCache();
    
      const gitPath = detector.detectGitExecutable({
        platform: 'linux',
        _spawnSync: () => ({ status: 1 }), // 模拟 git --version 失败
      });
    
      expect(gitPath).toBe(null);
  });

  test('detectGitExecutable checks Git Bash paths on Windows', () => {
      detector.clearCache();
    
      const mockExists = (path) => path === 'C:\\Program Files\\Git\\bin\\git.exe';
    
      const gitPath = detector.detectGitExecutable({
        platform: 'win32',
        _existsSync: mockExists,
        _spawnSync: () => ({ status: 1 }), // 系统 PATH �?git 不可�?
      });
    
      expect(gitPath).toBe('C:\\Program Files\\Git\\bin\\git.exe');
  });

  test('detectGitExecutable falls back to system git when Git Bash not found', () => {
      detector.clearCache();
    
      const mockExists = () => false; // 所有显式路径都不存�?
    
      const gitPath = detector.detectGitExecutable({
        platform: 'win32',
        _existsSync: mockExists,
        _spawnSync: () => ({ status: 0 }), // 系统 PATH �?git 可用
      });
    
      expect(gitPath).toBe('git');
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
    
      expect(gitPath1).toBe('git');
      expect(gitPath2).toBe('git');
      expect(callCount).toBe(1, 'Should only call spawnSync once (cached)');
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
    
      expect(callCount).toBe(2, 'Should call spawnSync twice (refresh=true)');
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
    
      expect(gitPath).toBe(customPath);
  });

  test('detectGitExecutable handles exceptions gracefully', () => {
      detector.clearCache();
    
      const gitPath = detector.detectGitExecutable({
        platform: 'linux',
        _spawnSync: () => { throw new Error('spawn failed'); },
      });
    
      expect(gitPath).toBe(null, 'Should return null on exception');
  });

  test('clearCache resets cached state', () => {
      detector.clearCache();
    
      detector.detectGitExecutable({
        platform: 'linux',
        _spawnSync: () => ({ status: 0 }),
      });
    
      let state = detector.getCacheState();
      expect(state.checked).toBe(true);
      expect(state.gitPath).toBe('git');
    
      detector.clearCache();
    
      state = detector.getCacheState();
      expect(state.checked).toBe(false);
      expect(state.gitPath).toBe(null);
  });

  test('buildNoGitMessage returns Windows-specific message', () => {
      const msg = detector.buildNoGitMessage({ platform: 'win32' });
    
      expect(msg).toContain('Git for Windows');
      expect(msg).toContain('git-scm.com');
      expect(msg).toContain('KHY_GIT_BASH_PATH');
  });

  test('buildNoGitMessage returns Unix-specific message', () => {
      const msg = detector.buildNoGitMessage({ platform: 'linux' });
    
      expect(msg).toContain('apt-get install git');
      expect(!msg).toContain('Git for Windows');
  });

});

