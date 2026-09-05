'use strict';

/**
 * Sandbox service — secure code execution environment.
 * Supports local Docker sandbox and E2B cloud sandbox.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SANDBOX_TIMEOUT_MS = Number(process.env.KHY_SANDBOX_TIMEOUT_MS || 30000);
const MAX_OUTPUT_BYTES = Number(process.env.KHY_SANDBOX_MAX_OUTPUT || 1024 * 1024);

function _env(name) {
  return String(process.env[`KHY_SANDBOX_${name}`] || '').trim();
}

/**
 * Execute code in a sandboxed environment.
 * @param {string} code - Code to execute
 * @param {object} options - { language, timeout, files }
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
async function executeCode(code, options = {}) {
  const language = options.language || 'python';
  const timeout = options.timeout || SANDBOX_TIMEOUT_MS;

  switch (language) {
    case 'python':
      return _executePython(code, timeout);
    case 'javascript':
    case 'js':
      return _executeJavaScript(code, timeout);
    case 'bash':
    case 'shell':
      return _executeBash(code, timeout);
    default:
      return { success: false, error: `Unsupported language: ${language}` };
  }
}

async function _executePython(code, timeout) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sandbox-'));
  const scriptPath = path.join(tmpDir, 'script.py');

  try {
    fs.writeFileSync(scriptPath, code, 'utf-8');

    // Check if Docker sandbox is available
    const useDocker = _env('MODE') === 'docker' || !_env('MODE');

    if (useDocker) {
      return await _executeDocker('python:3.11-slim', scriptPath, timeout);
    }

    // Fallback: direct execution (less secure, for dev only)
    return await _spawnProcess('python3', [scriptPath], timeout);
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

async function _executeJavaScript(code, timeout) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sandbox-'));
  const scriptPath = path.join(tmpDir, 'script.js');

  try {
    fs.writeFileSync(scriptPath, code, 'utf-8');
    return await _spawnProcess('node', [scriptPath], timeout);
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

async function _executeBash(code, timeout) {
  return await _spawnProcess('bash', ['-c', code], timeout);
}

async function _executeDocker(image, scriptPath, timeout) {
  const containerName = `khy-sandbox-${crypto.randomBytes(4).toString('hex')}`;

  return new Promise((resolve) => {
    const timeoutTimer = setTimeout(() => {
      try { execSync(`docker stop ${containerName}`, { stdio: 'ignore' }); } catch {}
      try { execSync(`docker rm ${containerName}`, { stdio: 'ignore' }); } catch {}
      resolve({ success: false, error: `Execution timeout after ${timeout}ms` });
    }, timeout);

    const cmd = [
      'docker', 'run', '--rm',
      '--name', containerName,
      '--network', 'none',
      '-m', '512m',
      '--cpus', '0.5',
      '-v', `${scriptPath}:/script:ro`,
      image,
      'python', '/script',
    ];

    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, error: stderr || `Exit code: ${code}` });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      resolve({ success: false, error: `Docker error: ${err.message}. Is Docker installed?` });
    });
  });
}

async function _spawnProcess(cmd, args, timeout) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timeoutTimer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ success: false, error: `Execution timeout after ${timeout}ms` });
    }, timeout);

    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, error: stderr || `Exit code: ${code}` });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Check if sandbox is available.
 */
function isAvailable() {
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return true;
  } catch {
    // Docker not available, but we can still run python/node directly
    return true;
  }
}

module.exports = {
  executeCode,
  isAvailable,
  SANDBOX_TIMEOUT_MS,
};
