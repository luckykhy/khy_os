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

// 兜底裸命令(`python` / `python3`)的重探冷却。
//
// 原来解析结果一律永久缓存,**降级结果也一样**:第一次调用恰好赶上 venv 还没建好、
// PATH 还没刷新、或某个 canRunPython 探测瞬时超时,就把整个进程钉在裸命令上。裸命令
// 在 PATH 里没有 python 的环境下每次子进程都 ENOENT —— 同一条错误重复到进程结束,
// 哪怕真正的解释器早就就位了。
//
// 现在只有「解析到确切路径」才永久缓存;降级结果带时间戳,过期后下一次调用重新解析。
// 保留冷却窗是因为完整解析要 fork 若干次 canRunPython,不能每次调用都重扫一遍。
const DEGRADED_RETRY_MS = 60_000;

let _cached = null;
let _degradedAt = 0; // >0:当前 _cached 是兜底裸命令,受冷却约束
let _degradedWarned = false;

function isWindows() {
  return isWin;
}

function isAbsoluteOrExplicitPath(value) {
  if (!value) {
    return false;
  }
  return value.includes('/') || value.includes('\\') || path.isAbsolute(value);
}

function isContainerRuntime() {
  if (process.platform === 'win32') {
    return false;
  }
  if (process.env.CONTAINER === 'docker' || process.env.DOCKER_CONTAINER === 'true') {
    return true;
  }
  try {
    if (fs.existsSync('/.dockerenv')) {
      return true;
    }
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
  return ['/usr/local/bin/python3', '/usr/bin/python3', '/usr/local/bin/python', '/usr/bin/python'];
}

function canRunPython(executable) {
  if (!executable) {
    return false;
  }
  try {
    execSync(`"${executable}" -c "import sys; sys.exit(0)"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(command) {
  if (!command) {
    return null;
  }
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
        path.join(backendRoot, 'ml', 'venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(backendRoot, '.venv', 'bin', 'python3'),
        path.join(backendRoot, '.venv', 'bin', 'python'),
        path.join(backendRoot, 'venv', 'bin', 'python3'),
        path.join(backendRoot, 'venv', 'bin', 'python'),
        path.join(backendRoot, 'ml', '.venv', 'bin', 'python3'),
        path.join(backendRoot, 'ml', '.venv', 'bin', 'python'),
        path.join(backendRoot, 'ml', 'venv', 'bin', 'python3'),
        path.join(backendRoot, 'ml', 'venv', 'bin', 'python'),
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
    const raw = String(
      process.env.KHY_PYTHON_PATH_QUIET == null ? '' : process.env.KHY_PYTHON_PATH_QUIET
    )
      .trim()
      .toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(raw);
  }
}

/**
 * 解析可用的 Python 解释器。
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] - 时钟注入(测试用),默认 Date.now。
 * @returns {string} 绝对路径,或解析不到时的兜底命令(该兜底最多保留 DEGRADED_RETRY_MS)。
 */
function findPython(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  if (_cached && (_degradedAt === 0 || now() - _degradedAt < DEGRADED_RETRY_MS)) {
    return _cached;
  }

  const _quiet = _pythonPathQuiet();
  const seen = new Set();
  const candidates = collectCandidates();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (isAbsoluteOrExplicitPath(candidate)) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      if (canRunPython(candidate)) {
        _cached = candidate;
        _degradedAt = 0;
        _degradedWarned = false;
        if (!_quiet) {
          console.log(`Using Python executable: ${_cached}`);
        }
        return _cached;
      }
      continue;
    }

    const resolved = resolveFromPath(candidate);
    if (!resolved) {
      continue;
    }
    if (canRunPython(resolved)) {
      _cached = resolved;
      _degradedAt = 0;
      _degradedWarned = false;
      if (!_quiet) {
        console.log(`Using Python executable: ${_cached}`);
      }
      return _cached;
    }
  }

  _cached = isWindows() ? 'python' : 'python3';
  _degradedAt = now();
  if (!_quiet && !_degradedWarned) {
    // 只在首次降级时告警:冷却过期后会周期性重探,每次都喊一遍就成了新的噪音源。
    _degradedWarned = true;
    console.warn(`Could not resolve an exact Python path. Falling back to command: ${_cached}`);
  }
  return _cached;
}

/**
 * 清空解析缓存(测试用,也可在已知环境变更后主动调用,如刚建好 venv)。
 */
function resetPythonCache() {
  _cached = null;
  _degradedAt = 0;
  _degradedWarned = false;
}

module.exports = { findPython, resetPythonCache };
