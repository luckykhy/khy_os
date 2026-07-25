'use strict';

/**
 * gitExecutableResolver — 纯叶子模块：解析 git 可执行文件路径（Windows 优先 Git Bash）。
 *
 * 职责：提供跨平台 git 可执行文件路径解析策略，Windows 上优先尝试 Git Bash 安装路径，
 * 回退到系统 PATH。纯判定逻辑，零 IO（existsSync 等检查由调用方执行）。
 *
 * 设计原则：
 * - 纯叶子：仅返回候选路径列表，不执行 IO、不抛错
 * - Windows 优先 Git Bash：用户主要使用 Git Bash，优先其路径
 * - 优雅降级：Git Bash 不存在时自动降级到系统 git
 * - 可注入：platform/env 可注入，便于测试
 */

/**
 * Git Bash 在 Windows 上的典型安装路径（按优先级排序）。
 */
const GIT_BASH_CANDIDATE_PATHS_WINDOWS = [
  'C:\\Program Files\\Git\\bin\\git.exe',           // 默认安装路径（64位）
  'C:\\Program Files (x86)\\Git\\bin\\git.exe',    // 32位系统或32位安装
  'C:\\Git\\bin\\git.exe',                          // 便携式/自定义安装
];

/**
 * 解析 git 可执行文件候选路径列表（按优先级排序）。
 *
 * Windows 策略：
 * 1. 优先 Git Bash 典型安装路径（C:\Program Files\Git\bin\git.exe 等）
 * 2. 回退到 'git'（依赖系统 PATH）
 *
 * Unix 策略：
 * 1. 直接使用 'git'（依赖系统 PATH）
 *
 * @param {Object} [options]
 * @param {string} [options.platform] - 平台标识（默认 process.platform）
 * @param {Object} [options.env] - 环境变量（默认 process.env）
 * @returns {string[]} 候选路径列表（按优先级排序，至少包含 'git' 回退）
 */
function resolveGitCandidates(options = {}) {
  const platform = options.platform || (typeof process !== 'undefined' ? process.platform : 'linux');
  const env = options.env || (typeof process !== 'undefined' ? process.env : {});

  const candidates = [];

  // Windows: 优先 Git Bash 安装路径
  if (platform === 'win32') {
    // 1. 环境变量覆盖（KHY_GIT_BASH_PATH，允许用户指定非标准路径）
    const customPath = env.KHY_GIT_BASH_PATH;
    if (customPath && typeof customPath === 'string' && customPath.trim()) {
      candidates.push(customPath.trim());
    }

    // 2. 典型 Git Bash 安装路径
    candidates.push(...GIT_BASH_CANDIDATE_PATHS_WINDOWS);
  }

  // 所有平台：最终回退到 'git'（依赖系统 PATH）
  candidates.push('git');

  return candidates;
}

/**
 * 判定是否应该优先使用 Git Bash（纯策略判定）。
 *
 * @param {Object} [options]
 * @param {string} [options.platform] - 平台标识
 * @returns {boolean} Windows 平台返回 true，其他平台 false
 */
function shouldPreferGitBash(options = {}) {
  const platform = options.platform || (typeof process !== 'undefined' ? process.platform : 'linux');
  return platform === 'win32';
}

/**
 * 从候选列表中选出「Git Bash 路径」与「系统回退路径」（纯分类逻辑）。
 *
 * @param {string[]} candidates - 候选路径列表
 * @returns {{gitBashPaths: string[], systemFallback: string}}
 */
function classifyCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { gitBashPaths: [], systemFallback: 'git' };
  }

  const gitBashPaths = [];
  let systemFallback = 'git';

  for (const c of candidates) {
    const path = String(c || '').trim();
    if (!path) continue;

    // 'git' 是系统回退（不含路径分隔符）
    if (path === 'git') {
      systemFallback = path;
    } else {
      // 其他都视为显式路径（Git Bash 或自定义）
      gitBashPaths.push(path);
    }
  }

  return { gitBashPaths, systemFallback };
}

/**
 * 构建人类可读的 git 路径说明（用于日志/提示）。
 *
 * @param {string} gitPath - git 可执行文件路径
 * @returns {string} 说明文本
 */
function buildGitPathLabel(gitPath) {
  if (!gitPath || gitPath === 'git') {
    return 'git (system PATH)';
  }
  // 提取 Git Bash 特征
  if (/Program Files.*Git/i.test(gitPath)) {
    return `Git Bash (${gitPath})`;
  }
  return gitPath;
}

module.exports = {
  resolveGitCandidates,
  shouldPreferGitBash,
  classifyCandidates,
  buildGitPathLabel,
  GIT_BASH_CANDIDATE_PATHS_WINDOWS, // 导出供测试
};
