'use strict';

/**
 * gitSpawnHelper — 统一 git 命令执行辅助函数（Windows 优先 Git Bash）。
 *
 * 职责：提供标准化的 git 命令执行接口，自动处理：
 * 1. Windows 优先 Git Bash 路径检测（通过 gitExecutableDetector）
 * 2. 回退到系统 PATH 的 git
 * 3. 路径引号包裹（处理 Windows 空格路径）
 * 4. 统一的 fail-soft 语义
 *
 * 使用场景：所有需要调用 git 的模块都应该通过此辅助函数，而非直接 spawnSync('git')。
 */

const { spawnSync } = require('child_process');

/**
 * 执行 git 命令（同步，Windows 优先 Git Bash）。
 *
 * @param {string[]} args - git 参数数组（不含 'git' 本身），如 ['status', '--porcelain']
 * @param {Object} [options] - spawnSync 选项（cwd, timeout, stdio 等）
 * @returns {{status: number|null, stdout: string, stderr: string, error?: Error}}
 *          status=0 成功，非零/null 失败，error 存在表示 spawn 异常
 */
function spawnGit(args, options = {}) {
  let gitPath = 'git';

  // 检测 git 可执行文件路径（Windows 优先 Git Bash，带缓存）
  try {
    const detector = require('./gitExecutableDetector');
    const detected = detector.detectGitExecutable();
    if (detected) {
      gitPath = detected;
    }
    // 如果 detected 为 null（无可用 git），仍尝试 'git'（历史回退行为）
  } catch {
    // 检测失败 → 回退到 'git'
  }

  // 合并选项（设置合理默认值）
  const spawnOptions = {
    encoding: 'utf-8',
    timeout: options.timeout || 10000,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  };

  try {
    const result = spawnSync(gitPath, args, spawnOptions);

    return {
      status: result.status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
      error: result.error,
      // 兼容原始 spawnSync 返回值的其他字段
      signal: result.signal,
      output: result.output,
      pid: result.pid,
    };
  } catch (error) {
    // spawn 异常 → 返回错误对象
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
      signal: null,
      output: null,
      pid: undefined,
    };
  }
}

/**
 * 执行 git 命令并返回 stdout（成功）或 null（失败）。
 * 简化接口，适用于只需要 stdout 的场景。
 *
 * @param {string[]} args - git 参数数组
 * @param {Object} [options] - spawnSync 选项
 * @returns {string|null} stdout（成功）或 null（失败）
 */
function spawnGitOutput(args, options = {}) {
  const result = spawnGit(args, options);
  return result.status === 0 ? result.stdout : null;
}

/**
 * 检查 git 是否可用（用于前置检查）。
 *
 * @returns {boolean} true 表示 git 可用
 */
function isGitAvailable() {
  try {
    const detector = require('./gitExecutableDetector');
    return detector.detectGitExecutable() !== null;
  } catch {
    return false;
  }
}

/**
 * 获取当前使用的 git 路径（调试/日志用）。
 *
 * @returns {string|null} git 路径或 null
 */
function getGitPath() {
  try {
    const detector = require('./gitExecutableDetector');
    return detector.detectGitExecutable();
  } catch {
    return null;
  }
}

module.exports = {
  spawnGit,
  spawnGitOutput,
  isGitAvailable,
  getGitPath,
};
