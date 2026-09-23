'use strict';
/**
 * pythonCommandResolver.js — resolve a bare MCP stdio `python` launcher to a
 * portable interpreter target.
 *
 * A configured MCP server (e.g. deepseek-eyes) is usually declared with a bare
 * `python` command. On a relocated/portable install the interpreter that has
 * the package installed lives in a venv under the install root (or in
 * VIRTUAL_ENV), NOT on the generic PATH — and a stale absolute path baked in on
 * a previous machine (e.g. `C:\khy-os\tools\deepseek-eyes\.venv\Scripts\
 * python.exe`) ENOENTs here.
 *
 * This leaf is PURE + injectable (fs/PATH-scan are passed in) so it is trivially
 * unit-testable and side-effect free. Resolution order for a bare launcher:
 *   VIRTUAL_ENV → PYTHON_PATH → install-root venv candidates → PATH scan.
 * An explicit (absolute) path is used as-configured but flagged `stale` when it
 * does not exist, so callers can fail fast with an actionable hint instead of a
 * silent ENOENT.
 */

const BARE = new Set(['python', 'python3', 'py', 'python.exe']);

function isBareLauncher(command) {
  const c = String(command || '').trim();
  if (!c) return false;
  // A bare launcher has no path separator (relative name / PATH lookup).
  if (/[\\/]/.test(c)) return false;
  const base = c.replace(/\.exe$/i, '').toLowerCase();
  return BARE.has(base) || base.startsWith('python');
}

function venvPythonVirtualEnv(virtualEnv, platform) {
  const isWin = platform === 'win32';
  return isWin
    ? `${virtualEnv}\\Scripts\\python.exe`
    : `${virtualEnv}/bin/python`;
}

/**
 * @param {string} command - The configured stdio command (bare or a path).
 * @param {object} [ctx]
 * @param {string} [ctx.platform]      process.platform
 * @param {object} [ctx.env]           env source (VIRTUAL_ENV / PYTHON_PATH)
 * @param {(p:string)=>boolean} [ctx.fsExists]  existence probe (injected)
 * @param {(name:string)=>(string|null)} [ctx.pathScan]  PATH lookup (injected)
 * @param {string[]} [ctx.venvCandidates] install-root venv python paths to try
 * @returns {{command:string, source:string, exists:boolean, stale:boolean, portable:boolean}}
 */
function resolveStdioCommand(command, ctx = {}) {
  const env = ctx.env || {};
  const fsExists = typeof ctx.fsExists === 'function' ? ctx.fsExists : () => false;
  const pathScan = typeof ctx.pathScan === 'function' ? ctx.pathScan : () => null;
  const venvCandidates = Array.isArray(ctx.venvCandidates) ? ctx.venvCandidates : [];
  const platform = ctx.platform || 'win32';
  const cmd = String(command || '').trim();

  if (!isBareLauncher(cmd)) {
    // Explicit path: use as configured, but surface staleness for fail-fast.
    const exists = fsExists(cmd);
    return { command: cmd, source: 'as_configured', exists, stale: !exists, portable: false };
  }

  // 1. VIRTUAL_ENV (the active venv's interpreter).
  if (env.VIRTUAL_ENV) {
    const cand = venvPythonVirtualEnv(env.VIRTUAL_ENV, platform);
    if (fsExists(cand)) {
      return { command: cand, source: 'virtualenv', exists: true, stale: false, portable: true };
    }
  }

  // 2. PYTHON_PATH (explicit interpreter override).
  if (env.PYTHON_PATH) {
    const exists = fsExists(env.PYTHON_PATH);
    if (exists) {
      return { command: env.PYTHON_PATH, source: 'python_path', exists: true, stale: false, portable: true };
    }
  }

  // 3. Install-root venv candidates (e.g. tools/deepseek-eyes/.venv).
  for (const cand of venvCandidates) {
    if (cand && fsExists(cand)) {
      return { command: cand, source: 'venv_candidate', exists: true, stale: false, portable: true };
    }
  }

  // 4. PATH scan for the bare launcher.
  const scanned = pathScan(cmd);
  if (scanned) {
    const exists = fsExists(scanned);
    return { command: scanned, source: 'path_scan', exists, stale: !exists, portable: true };
  }

  // Nothing resolvable — keep the bare name (the spawn will surface a clear ENOENT).
  return { command: cmd, source: 'bare_unresolved', exists: false, stale: false, portable: false };
}

module.exports = { resolveStdioCommand, isBareLauncher };
