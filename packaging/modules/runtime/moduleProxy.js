'use strict';

/**
 * Cross-module transparent call proxy.
 *
 * In combined mode: direct require() calls to target module.
 * In standalone mode: spawn the target module's executable via child_process.
 *
 * Usage:
 *   const proxy = require('./moduleProxy');
 *   const result = await proxy.call('khy-gateway', 'query', { prompt: 'hello' });
 */

const { execFile } = require('child_process');
const path = require('path');
const { isStandalone, getCurrentModule } = require('./modeDetector');

// Map module IDs to their executable names (platform-specific)
const EXECUTABLE_MAP = {
  'khy-ai': process.platform === 'win32' ? 'khy-ai.exe' : 'khy-ai',
  'khy-gateway': process.platform === 'win32' ? 'khy-gateway.exe' : 'khy-gateway',
  'khy-quant': process.platform === 'win32' ? 'khy-quant.exe' : 'khy-quant',
  'khy-server': process.platform === 'win32' ? 'khy-server.exe' : 'khy-server',
  'khy-tools': process.platform === 'win32' ? 'khy-tools.exe' : 'khy-tools',
  'khy': process.platform === 'win32' ? 'khy.exe' : 'khy',
};

// Map module IDs to their in-process entry require paths (for combined mode)
const REQUIRE_MAP = {
  'khy-ai': '../../entries/khy-ai-entry',
  'khy-gateway': '../../../services/ai-backend/server',
  'khy-quant': '../../entries/khy-quant-entry',
  'khy-server': '../../../services/backend/server',
  'khy-tools': '../../entries/khy-tools-entry',
};

/**
 * Find the executable path for a module.
 * Searches: same directory as current exe -> PATH -> fallback to node + entry script.
 */
function findExecutable(moduleId) {
  const exeName = EXECUTABLE_MAP[moduleId];
  if (!exeName) throw new Error(`Unknown module: ${moduleId}`);

  // First try same directory as current process
  const currentDir = path.dirname(process.execPath);
  const sameDirPath = path.join(currentDir, exeName);

  // Return the executable name (will search PATH if not in same dir)
  try {
    const fs = require('fs');
    if (fs.existsSync(sameDirPath)) return sameDirPath;
  } catch { /* ignore */ }

  return exeName; // Fallback to PATH lookup
}

/**
 * Call a function on another module.
 *
 * @param {string} targetModule - Target module ID
 * @param {string} command - Command/action to execute
 * @param {object} [params] - Parameters to pass
 * @param {object} [options] - Additional options (timeout, cwd, etc.)
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function call(targetModule, command, params = {}, options = {}) {
  const currentModule = getCurrentModule();

  // If target is current module or we're in combined mode, try direct require
  if (!isStandalone() || targetModule === currentModule) {
    return callDirect(targetModule, command, params);
  }

  // Standalone mode: spawn the target executable
  return callViaExec(targetModule, command, params, options);
}

/**
 * Direct in-process call (combined mode).
 */
async function callDirect(targetModule, command, params) {
  // In combined mode, the router handles everything
  try {
    const routerPath = path.resolve(__dirname, '../../../services/backend/src/cli/router');
    const { route } = require(routerPath);
    const result = await route(command, params);
    return { stdout: JSON.stringify(result), stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: err.message, exitCode: 1 };
  }
}

/**
 * Execute via spawning target module's executable (standalone mode).
 */
function callViaExec(targetModule, command, params, options = {}) {
  return new Promise((resolve, reject) => {
    const exe = findExecutable(targetModule);
    const args = [command];

    // Pass params as JSON via --params flag
    if (Object.keys(params).length > 0) {
      args.push('--params', JSON.stringify(params));
    }

    const timeout = options.timeout || 30000;

    execFile(exe, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error && error.killed) {
        reject(new Error(`Module ${targetModule} call timed out after ${timeout}ms`));
        return;
      }
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? error.code || 1 : 0,
      });
    });
  });
}

module.exports = {
  call,
  callDirect,
  callViaExec,
  findExecutable,
  EXECUTABLE_MAP,
};
