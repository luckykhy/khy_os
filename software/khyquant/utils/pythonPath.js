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
const agentDisplay = require('../services/agentDisplay');

// 工具解析属可观测层（§1）：结果一次性写结构化 NDJSON 到 stderr，保持 stdout 纯净（§1.5），
// 并受 KHY_AGENT_LOG 控制。findPython 结果带缓存，仅首次解析时记录一次，非心跳（§4 R1）。

let _cached = null;

function isWindows() {
  return process.platform === 'win32';
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
  try {
    const lookup = isWindows() ? `where ${command}` : `which ${command}`;
    const output = execSync(lookup, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    if (!output) return null;
    return output.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
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

function findPython() {
  if (_cached) return _cached;

  const seen = new Set();
  const candidates = collectCandidates();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    if (isAbsoluteOrExplicitPath(candidate)) {
      if (!fs.existsSync(candidate)) continue;
      if (canRunPython(candidate)) {
        _cached = candidate;
        agentDisplay.create({ agent: 'pythonPath' }).log('tool', { action: 'python.resolve', detail: _cached, status: 'ok' });
        return _cached;
      }
      continue;
    }

    const resolved = resolveFromPath(candidate);
    if (!resolved) continue;
    if (canRunPython(resolved)) {
      _cached = resolved;
      agentDisplay.create({ agent: 'pythonPath' }).log('tool', { action: 'python.resolve', detail: _cached, status: 'ok' });
      return _cached;
    }
  }

  _cached = isWindows() ? 'python' : 'python3';
  agentDisplay.create({ agent: 'pythonPath' }).log('tool', { action: 'python.resolve', detail: `fallback ${_cached}`, status: 'fallback' });
  return _cached;
}

module.exports = { findPython };
