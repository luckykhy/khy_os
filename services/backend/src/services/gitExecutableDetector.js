'use strict';

/**
 * gitExecutableDetector — IO 层：检测并缓存可用的 git 可执行文件路径。
 *
 * 职责：结合 gitExecutableResolver（纯叶子策略）与实际 IO（fs.existsSync / spawnSync），
 * 检测系统中可用的 git，优先 Git Bash（Windows），回退到系统 PATH。
 *
 * 缓存策略：首次检测后缓存结果（进程生命周期），避免重复 IO。
 *
 * 降级链：
 * 1. Windows: Git Bash 典型路径 → 系统 PATH 的 git → null（无可用 git）
 * 2. Unix: 系统 PATH 的 git → null
 *
 * 不变量：
 * - 永不抛错（fail-soft）
 * - 返回 null 表示无可用 git（调用方应优雅处理）
 */

const { existsSync } = require('fs');
const { spawnSync } = require('child_process');
const resolver = require('./gitExecutableResolver');

// 进程级缓存：{ gitPath: string|null, checked: boolean }
let _cache = { gitPath: null, checked: false };

/**
 * 检测可用的 git 可执行文件路径（带缓存）。
 *
 * 策略：
 * 1. 已缓存 → 直接返回
 * 2. 遍历候选路径（Windows 优先 Git Bash），逐个检测：
 *    a. 显式路径（非 'git'）→ existsSync 检查
 *    b. 'git'（系统 PATH）→ spawnSync 'git --version' 检查
 * 3. 首个可用路径 → 缓存并返回
 * 4. 全部失败 → 缓存 null
 *
 * @param {Object} [options]
 * @param {boolean} [options.refresh] - 强制刷新缓存
 * @param {string} [options.platform] - 平台（默认 process.platform，测试注入用）
 * @param {Object} [options.env] - 环境变量（默认 process.env，测试注入用）
 * @param {Function} [options._existsSync] - fs.existsSync 注入（测试用）
 * @param {Function} [options._spawnSync] - child_process.spawnSync 注入（测试用）
 * @returns {string|null} git 可执行文件路径，null 表示无可用 git
 */
function detectGitExecutable(options = {}) {
  // 缓存命中（且非强制刷新）
  if (_cache.checked && !options.refresh) {
    return _cache.gitPath;
  }

  const platform = options.platform;
  const env = options.env;
  const _exists = options._existsSync || existsSync;
  const _spawn = options._spawnSync || spawnSync;

  try {
    const candidates = resolver.resolveGitCandidates({ platform, env });

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'string') continue;

      const trimmed = candidate.trim();
      if (!trimmed) continue;

      // 'git'（系统 PATH）→ 通过 spawnSync 'git --version' 验证
      if (trimmed === 'git') {
        if (_isGitAvailableInPath(_spawn)) {
          _cache = { gitPath: 'git', checked: true };
          return 'git';
        }
        continue;
      }

      // 显式路径 → existsSync 检查
      if (_exists(trimmed)) {
        _cache = { gitPath: trimmed, checked: true };
        return trimmed;
      }
    }

    // 全部候选失败 → 缓存 null
    _cache = { gitPath: null, checked: true };
    return null;
  } catch {
    // 任何异常 → fail-soft，缓存 null
    _cache = { gitPath: null, checked: true };
    return null;
  }
}

/**
 * 通过 'git --version' 检查 git 是否在系统 PATH 中可用。
 * @param {Function} _spawn - spawnSync 注入（测试用）
 * @returns {boolean}
 */
function _isGitAvailableInPath(_spawn) {
  try {
    const result = _spawn('git', ['--version'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return result && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 清除缓存（测试用，或运行时强制重新检测）。
 */
function clearCache() {
  _cache = { gitPath: null, checked: false };
}

/**
 * 获取当前缓存状态（调试/测试用）。
 * @returns {{gitPath: string|null, checked: boolean}}
 */
function getCacheState() {
  return { ..._cache };
}

/**
 * 构建无可用 git 时的友好提示信息。
 * @param {Object} [options]
 * @param {string} [options.platform]
 * @returns {string}
 */
function buildNoGitMessage(options = {}) {
  const platform = options.platform || (typeof process !== 'undefined' ? process.platform : 'linux');

  if (platform === 'win32') {
    return [
      '未检测到 git。请安装 Git for Windows 后重试：',
      '  下载：https://git-scm.com/download/win',
      '  或使用包管理器：winget install Git.Git',
      '',
      '如已安装但路径非标准，可设置环境变量：',
      '  set KHY_GIT_BASH_PATH=C:\\your\\path\\to\\git.exe',
    ].join('\n');
  }

  return [
    '未检测到 git。请安装 git 后重试：',
    '  Debian/Ubuntu: sudo apt-get install git',
    '  macOS: brew install git  或  xcode-select --install',
  ].join('\n');
}

module.exports = {
  detectGitExecutable,
  clearCache,
  getCacheState,
  buildNoGitMessage,
};
