'use strict';

/**
 * runners — execute the install / build / start steps of a deployment.
 *
 * Install and build are *blocking* steps (we must know they succeeded before
 * continuing), so they run via spawnSync with captured output. Start is a
 * *detached* long-lived process whose stdout/stderr are redirected to a log
 * file, so `khy deploy` can return while the deployed app keeps running.
 *
 * All process spawning goes through an injected `cp` (child_process) and `fs`
 * so tests can assert behaviour with stubs and zero real processes.
 */

const path = require('path');

function defaultDeps() {
  return {
    cp: require('child_process'),
    fs: require('fs'),
    platform: process.platform,
  };
}

const MAX_CAPTURE = 4000; // chars of stdout/stderr to retain for diagnostics

/**
 * Resolve the actual spawn target for a command. On Windows a `.cmd`/`.bat`
 * shim cannot be spawned directly — historically we passed `shell:true`, but an
 * args array + shell:true triggers Node DEP0190 and leaks the deprecation
 * warning. Instead invoke cmd.exe explicitly (/d /s /c), which resolves the shim
 * without the warning. Args originate from the curated plan, not user input.
 */
function _spawnTarget(command, platform) {
  const useCmd = platform === 'win32' && /\.(cmd|bat)$/i.test(command.exe);
  if (useCmd) {
    return { exe: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command.exe, ...command.args] };
  }
  return { exe: command.exe, args: command.args };
}

/**
 * Run a blocking step (install or build).
 *
 * @param {{exe:string,args:string[],display?:string}} command
 * @param {Object} opts
 * @param {string} opts.cwd
 * @param {Object} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {Object} [opts.deps]
 * @returns {{ ok:boolean, code:number|null, signal:string|null, output:string, command:string }}
 */
function runStep(command, opts = {}) {
  const deps = opts.deps || defaultDeps();
  const display = command.display || [command.exe, ...command.args].join(' ');
  const t = _spawnTarget(command, deps.platform);
  const res = deps.cp.spawnSync(t.exe, t.args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 0,
    windowsHide: true,
  });

  if (res.error) {
    const missing = res.error.code === 'ENOENT';
    return {
      ok: false,
      code: null,
      signal: null,
      output: (missing
        ? `命令未找到: ${command.exe}（请确认其已安装并在 PATH 中）`
        : String(res.error.message || res.error)).slice(0, MAX_CAPTURE),
      command: display,
    };
  }

  const output = `${res.stdout || ''}${res.stderr || ''}`.slice(-MAX_CAPTURE);
  return {
    ok: res.status === 0,
    code: res.status,
    signal: res.signal || null,
    output,
    command: display,
  };
}

/**
 * Launch the start command as a detached, log-redirected process.
 *
 * @param {{exe:string,args:string[],display?:string}} command
 * @param {Object} opts
 * @param {string} opts.cwd
 * @param {string} opts.logFile Absolute path for combined stdout/stderr.
 * @param {Object} [opts.env]
 * @param {Object} [opts.deps]
 * @returns {{ pid:number|null, logFile:string, command:string }}
 */
function launch(command, opts = {}) {
  const deps = opts.deps || defaultDeps();
  const display = command.display || [command.exe, ...command.args].join(' ');
  const logFile = opts.logFile;

  deps.fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = deps.fs.openSync(logFile, 'a');
  const errFd = deps.fs.openSync(logFile, 'a');

  const t = _spawnTarget(command, deps.platform);
  const child = deps.cp.spawn(t.exe, t.args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    detached: deps.platform !== 'win32', // own process group on Unix for clean kill
    stdio: ['ignore', out, errFd],
    windowsHide: true,
  });

  const pid = child.pid || null;
  if (child.unref) child.unref();
  // Close our copies of the fds; the child keeps its own.
  try { deps.fs.closeSync(out); } catch { /* noop */ }
  try { deps.fs.closeSync(errFd); } catch { /* noop */ }

  return { pid, logFile, command: display };
}

module.exports = {
  defaultDeps,
  runStep,
  launch,
  MAX_CAPTURE,
};
