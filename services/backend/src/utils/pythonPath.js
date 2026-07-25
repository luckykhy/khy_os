/**
 * Resolve the best Python executable path for backend ML subprocesses.
 * Priority:
 * 1) Container runtime fixed paths (/usr/local/bin/python3, /usr/bin/python3)
 * 2) PYTHON_PATH env
 * 3) Active virtual env (VIRTUAL_ENV)
 * 4) Project-local virtual envs
 * 5) PATH lookup (python3/python/py)
 * 6) Final command fallback
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isWin, searchExecutable } = require('../tools/platformUtils');

let _cached = null;

function isWindows() {
  return isWin;
}

function isAbsoluteOrExplicitPath(value) {
  if (!value) return false;
  return value.includes('/') || value.includes('\\') || path.isAbsolute(value);
}

function isContainerRuntime() {
  if (process.platform === 'win32') return false;
  if (process.env.CONTAINER === 'docker' || process.env.DOCKER_CONTAINER === 'true') return true;
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    // Ignore permission/runtime issues and continue with other checks.
  }
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /(docker|containerd|kubepods)/i.test(cgroup);
  } catch {
    return false;
  }
}

function getContainerPythonCandidates() {
  return [
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    '/usr/local/bin/python',
    '/usr/bin/python'
  ];
}

function canRunPython(executable) {
  if (!executable) return false;
  try {
    execSync(`"${executable}" -c "import sys; sys.exit(0)"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(command) {
  if (!command) return null;
  // Single cross-platform which/where resolver.
  return searchExecutable(command);
}

function collectCandidates() {
  const candidates = [];

  if (isContainerRuntime()) {
    candidates.push(...getContainerPythonCandidates());
  }

  if (process.env.PYTHON_PATH) {
    candidates.push(process.env.PYTHON_PATH);
  }

  if (process.env.VIRTUAL_ENV) {
    if (isWindows()) {
      candidates.push(path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe'));
    } else {
      candidates.push(path.join(process.env.VIRTUAL_ENV, 'bin', 'python3'));
      candidates.push(path.join(process.env.VIRTUAL_ENV, 'bin', 'python'));
    }
  }

  const backendRoot = path.resolve(__dirname, '../..');
  const localVenvCandidates = isWindows()
    ? [
        path.join(backendRoot, '.venv', 'Scripts', 'python.exe'),
        path.join(backendRoot, 'venv', 'Scripts', 'python.exe'),
        path.join(backendRoot, 'ml', '.venv', 'Scripts', 'python.exe'),
        path.join(backendRoot, 'ml', 'venv', 'Scripts', 'python.exe')
      ]
    : [
        path.join(backendRoot, '.venv', 'bin', 'python3'),
        path.join(backendRoot, '.venv', 'bin', 'python'),
        path.join(backendRoot, 'venv', 'bin', 'python3'),
        path.join(backendRoot, 'venv', 'bin', 'python'),
        path.join(backendRoot, 'ml', '.venv', 'bin', 'python3'),
        path.join(backendRoot, 'ml', '.venv', 'bin', 'python'),
        path.join(backendRoot, 'ml', 'venv', 'bin', 'python3'),
        path.join(backendRoot, 'ml', 'venv', 'bin', 'python')
      ];

  candidates.push(...localVenvCandidates);

  // Keep explicit fallback commonly used in local dev environment.
  if (!isWindows() && !isContainerRuntime()) {
    candidates.push('/opt/devenv/python/bin/python3');
  }

  candidates.push(...(isWindows() ? ['python', 'py', 'python3'] : ['python3', 'python']));
  return candidates;
}

// 「解析 Python 解释器路径」的调试行是否静默(KHY_PYTHON_PATH_QUIET;/goal「减少显示的心灵噪音」)──
// findPython() 每次为 OCR / 文档转换等子进程解析解释器时,原本无条件 `console.log("Using Python
// executable: <绝对路径>")`——这是一条纯调试日志,却直冲用户终端(实测 vision→OCR 兜底一屏刷出
// `Using Python executable: D:\Python312\python.exe`,还泄漏本机文件系统路径),从不为用户服务。
// 该门 default-on(静默)→ 解析成功的两条 log + 兜底 warn 全部消音;门关(KHY_PYTHON_PATH_QUIET=off)
// → 逐字节回退旧 verbose 行为(用于本地排障)。委派 flagRegistry;require 失败 → 保守回退静默
// (仅显式 0/false/off/no 时才 verbose),绝不抛,绝不影响解析结果。
function _pythonPathQuiet() {
  try {
    const flagRegistry = require('../services/flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_PYTHON_PATH_QUIET', process.env);
  } catch {
    const raw = String(process.env.KHY_PYTHON_PATH_QUIET == null ? '' : process.env.KHY_PYTHON_PATH_QUIET)
      .trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(raw);
  }
}

function findPython() {
  if (_cached) return _cached;

  const _quiet = _pythonPathQuiet();
  const seen = new Set();
  const candidates = collectCandidates();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    if (isAbsoluteOrExplicitPath(candidate)) {
      if (!fs.existsSync(candidate)) continue;
      if (canRunPython(candidate)) {
        _cached = candidate;
        if (!_quiet) console.log(`Using Python executable: ${_cached}`);
        return _cached;
      }
      continue;
    }

    const resolved = resolveFromPath(candidate);
    if (!resolved) continue;
    if (canRunPython(resolved)) {
      _cached = resolved;
      if (!_quiet) console.log(`Using Python executable: ${_cached}`);
      return _cached;
    }
  }

  _cached = isWindows() ? 'python' : 'python3';
  if (!_quiet) console.warn(`Could not resolve an exact Python path. Falling back to command: ${_cached}`);
  return _cached;
}

module.exports = { findPython };
