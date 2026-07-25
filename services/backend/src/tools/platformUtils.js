/**
 * platformUtils — cross-platform helpers for tool execution.
 *
 * Consolidates platform-specific logic (DISPLAY detection, executable lookup,
 * shell escaping, grep availability) so individual tools stay platform-agnostic.
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Executable lookup ────────────────────────────────────────────────

let _rgAvailable = null;
let _grepAvailable = null;

/**
 * Cross-platform `which` / `where`.
 * Returns the resolved path on success, null on failure.
 */
function searchExecutable(name) {
  const isWin = process.platform === 'win32';
  try {
    const cmd = isWin ? 'where' : 'which';
    return execFileSync(cmd, [name], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

function isRgAvailable() {
  if (_rgAvailable === null) _rgAvailable = !!searchExecutable('rg');
  return _rgAvailable;
}

function isGrepAvailable() {
  if (_grepAvailable === null) _grepAvailable = !!searchExecutable('grep');
  return _grepAvailable;
}

// ── DISPLAY detection (Linux / X11) ─────────────────────────────────

/**
 * Auto-detect DISPLAY for X11 sessions on Linux.
 * Returns the DISPLAY string (e.g. ':0') or null.
 */
function getDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  if (process.platform !== 'linux') return null;
  // Check for X11 unix socket
  try {
    if (fs.existsSync('/tmp/.X11-unix/X0')) return ':0';
  } catch { /* ignore */ }
  // Check for Wayland
  if (process.env.WAYLAND_DISPLAY) return null; // Wayland doesn't use DISPLAY
  return null;
}

/**
 * Build environment suitable for spawning GUI applications.
 * Ensures DISPLAY is set on Linux if an X session is available.
 */
function buildGuiEnv(baseEnv) {
  const env = { ...(baseEnv || process.env) };
  if (process.platform === 'linux' && !env.DISPLAY) {
    const display = getDisplay();
    if (display) env.DISPLAY = display;
  }
  return env;
}

// ── Shell escaping ──────────────────────────────────────────────────

/**
 * Platform-aware shell argument escaping.
 * - bash: single-quote wrapping (POSIX)
 * - cmd: double-quote wrapping
 * - powershell: single-quote wrapping with doubled inner quotes
 *
 * @param {string} arg
 * @param {'bash'|'cmd'|'powershell'} [shell] - Override shell type (default: auto-detect)
 */
function shellEscape(arg, shell) {
  if (!arg) return "''";
  // Safe chars that need no quoting on any platform
  if (/^[a-zA-Z0-9._\-/\\:=@]+$/.test(arg)) return arg;
  const sh = shell || getShellConfiguration().shell;
  if (sh === 'powershell') {
    return "'" + arg.replace(/'/g, "''") + "'";
  }
  if (sh === 'cmd') {
    // cmd.exe quoting: escape inner " by doubling it.
    return '"' + String(arg).replace(/"/g, '""') + '"';
  }
  // POSIX single-quote escaping
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// ── GUI app detection ───────────────────────────────────────────────

const LINUX_GUI_APPS = new Set([
  'firefox', 'chromium', 'chrome', 'google-chrome', 'google-chrome-stable',
  'code', 'vscode', 'cursor', 'gedit', 'nautilus', 'thunar', 'dolphin',
  'evince', 'eog', 'vlc', 'mpv', 'gimp', 'inkscape', 'libreoffice',
  'xdg-open', 'wps', 'typora', 'okular', 'kate', 'mousepad',
  'obs', 'blender', 'kdenlive', 'krita', 'shotcut',
]);

const WINDOWS_GUI_APPS = new Set([
  'notepad', 'calc', 'mspaint', 'explorer', 'msedge', 'chrome',
  'firefox', 'code', 'cursor', 'winword', 'excel', 'powerpnt',
  'outlook', 'teams', 'slack', 'discord', 'spotify', 'vlc',
  'mstsc', 'control', 'taskmgr', 'regedit', 'devenv',
]);

/**
 * Check if a command base name is a known GUI application.
 */
function isGuiApp(baseName) {
  const name = String(baseName).toLowerCase().replace(/\.exe$/, '');
  if (process.platform === 'win32') return WINDOWS_GUI_APPS.has(name);
  return LINUX_GUI_APPS.has(name);
}

/**
 * Spawn a GUI application in detached mode, cross-platform.
 * Returns the spawned ChildProcess (already unref'd).
 */
function spawnGuiApp(command, args = [], options = {}) {
  const { spawn } = require('child_process');
  const isWin = process.platform === 'win32';
  const env = buildGuiEnv(options.env);

  let child;
  if (isWin) {
    // Windows: use COMSPEC/start for proper detach and consistent shell flags.
    child = spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', 'start', '', command, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } else {
    child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  }
  child.on('error', () => { /* GUI app spawn failure — non-critical */ });
  child.unref();
  return child;
}

// ── Pure-JS grep fallback ───────────────────────────────────────────

/**
 * Single source of truth for directories skipped during file scans/greps.
 * Reused by tools/grep.js and tools/GrepTool/index.js — add new ignore dirs
 * here only.
 * @type {string[]}
 */
const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', '.cache', 'coverage', '__pycache__'];

/**
 * Pure-JS grep implementation for platforms without grep/rg.
 * Walks directories recursively and matches file contents against a RegExp.
 *
 * @param {string} searchPath - Directory or file to search
 * @param {RegExp} regex - Pattern to match
 * @param {object} opts
 * @param {string} opts.mode - 'files_with_matches' | 'content' | 'count'
 * @param {string} [opts.glob] - Glob filter (e.g. '*.js')
 * @param {number} [opts.maxResults=50]
 * @param {string[]} [opts.excludeDirs] - Directories to skip
 * @returns {{ files?: string[], matches?: object[], counts?: object[], count?: number, total?: number }}
 */
function pureJsGrep(searchPath, regex, opts = {}) {
  const {
    mode = 'files_with_matches',
    glob: globPattern,
    maxResults = 50,
    excludeDirs = DEFAULT_EXCLUDE_DIRS,
  } = opts;

  const excludeSet = new Set(excludeDirs);
  const results = { files: [], matches: [], counts: [] };
  let totalCount = 0;
  let resultCount = 0;

  // Simple glob-to-regex conversion for --include filter
  let includeRe = null;
  if (globPattern) {
    const escaped = globPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    includeRe = new RegExp('^' + escaped + '$', 'i');
  }

  function shouldInclude(filePath) {
    if (!includeRe) return true;
    return includeRe.test(path.basename(filePath));
  }

  function walkDir(dir) {
    if (resultCount >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (resultCount >= maxResults) break;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!excludeSet.has(entry.name)) walkDir(fullPath);
        continue;
      }

      if (!entry.isFile() || !shouldInclude(fullPath)) continue;

      // Read file and match
      let content;
      try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }

      // Skip binary-looking files
      if (content.includes('\0')) continue;

      const lines = content.split('\n');
      let fileMatchCount = 0;
      const fileMatches = [];

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          fileMatchCount++;
          if (mode === 'content' && resultCount + fileMatches.length < maxResults) {
            fileMatches.push({ file: fullPath, line: i + 1, content: lines[i] });
          }
        }
      }

      if (fileMatchCount > 0) {
        if (mode === 'files_with_matches') {
          results.files.push(fullPath);
          resultCount++;
        } else if (mode === 'content') {
          results.matches.push(...fileMatches);
          resultCount += fileMatches.length;
        } else if (mode === 'count') {
          results.counts.push({ file: fullPath, count: fileMatchCount });
          totalCount += fileMatchCount;
          resultCount++;
        }
      }
    }
  }

  const stat = fs.statSync(searchPath);
  if (stat.isFile()) {
    // Single file search
    let content;
    try { content = fs.readFileSync(searchPath, 'utf-8'); } catch { return results; }
    const lines = content.split('\n');
    let fileMatchCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        fileMatchCount++;
        if (mode === 'content' && results.matches.length < maxResults) {
          results.matches.push({ file: searchPath, line: i + 1, content: lines[i] });
        }
      }
    }
    if (fileMatchCount > 0) {
      results.files.push(searchPath);
      results.counts.push({ file: searchPath, count: fileMatchCount });
      totalCount = fileMatchCount;
    }
  } else {
    walkDir(searchPath);
  }

  results.count = mode === 'files_with_matches' ? results.files.length : resultCount;
  results.total = totalCount;
  results.truncated = resultCount >= maxResults;
  return results;
}

// ── Temp directory ──────────────────────────────────────────────────

function getTmpDir() {
  return process.env.TEMP || process.env.TMP || os.tmpdir();
}

// ── Session-scoped temp directory ──────────────────────────────────
//
// 仿照 Claude Code 的 /tmp/claude-{uid}/ 设计：
//   /tmp/khy-{uid}/{pid}/
//
// 销毁时机（三道防线，时机明确）：
//   1. 优雅退出（SIGTERM/SIGINT/SIGHUP/SIGBREAK/孤儿）— shutdown hook 删
//      （prefetch.js 注册 addShutdownHook('session-tmpdir', cleanupSessionTmpDir)）
//   2. 任意退出路径（含直接 process.exit()）— 下方 process.on('exit') 同步删，
//      堵住三击退出 / 代码内 process.exit() 不走 shutdown hook 的缺口
//   3. 硬杀兜底（kill -9 / SIGKILL 不触发任何钩子）— cleanupService.cleanOsTempFiles()
//      按 mtime 超 KHY_OS_TEMP_MAX_AGE_HOURS（默认 1h）整树删除 khy- 前缀残留
//
// - 每个 khy 进程拥有独立的会话临时目录
// - 目录权限 0o700，防止多用户环境下的信息泄露

let _sessionTmpDir = null;
let _exitHookRegistered = false;

/**
 * 获取当前会话的临时目录路径（不创建）。
 * 格式: /tmp/khy-{uid}/{pid}/
 */
function getSessionTmpDir() {
  if (_sessionTmpDir) return _sessionTmpDir;
  const base = getTmpDir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  const rootDir = path.join(base, `khy-${uid}`);
  _sessionTmpDir = path.join(rootDir, String(process.pid));
  return _sessionTmpDir;
}

/**
 * 确保会话临时目录存在。
 * 懒创建：首次调用时创建，之后直接返回路径。
 * 首次创建时注册一次性 process.on('exit') 同步清理钩子，确保任意退出路径
 * （包括代码内直接 process.exit()，它不走 shutdown hook）都能即时删除目录。
 */
function ensureSessionTmpDir() {
  const dir = getSessionTmpDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* already exists or permission issue */ }
  if (!_exitHookRegistered) {
    _exitHookRegistered = true;
    // 'exit' 在所有非 SIGKILL/非崩溃退出时触发（含 process.exit()）。回调内只能
    // 同步操作，rmSync 同步合法。与 shutdown hook 幂等共存（rmSync force 不会重复报错）。
    try { process.once('exit', () => { cleanupSessionTmpDir(); }); } catch { /* best effort */ }
  }
  return dir;
}

/**
 * 递归删除整个会话临时目录。
 * 用于 shutdown hook 和手动清理。
 */
function cleanupSessionTmpDir() {
  const dir = getSessionTmpDir();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
  // 尝试清理空的父目录 khy-{uid}/（如果已无其他会话目录）
  try {
    const parent = path.dirname(dir);
    const remaining = fs.readdirSync(parent);
    if (remaining.length === 0) {
      fs.rmdirSync(parent);
    }
  } catch { /* best effort */ }
}

// ── Platform constants ─────────────────────────────────────────────

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const NULL_DEVICE = isWin ? 'NUL' : '/dev/null';
const HOME_DIR = os.homedir();

// SSOT: Windows PowerShell binary candidates, tried in order. Prefer pwsh
// (PowerShell 7+, cross-platform) then fall back to the built-in
// powershell.exe. Frozen — copy with [...] before any in-place use.
const POWERSHELL_BINS = Object.freeze(['pwsh', 'powershell']);

// ── Platform type detection ───────────────────────────────────────

/**
 * Detect runtime platform: 'windows' | 'macos' | 'wsl' | 'linux' | 'unknown'.
 * WSL is detected by reading /proc/version for "microsoft" or "wsl".
 * Result is cached after first call.
 */
let _platformCache = null;
function getPlatform() {
  if (_platformCache) return _platformCache;
  if (isWin) { _platformCache = 'windows'; return _platformCache; }
  if (isMac) { _platformCache = 'macos'; return _platformCache; }
  if (process.platform === 'linux') {
    try {
      const pv = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      if (pv.includes('microsoft') || pv.includes('wsl')) {
        _platformCache = 'wsl';
        return _platformCache;
      }
    } catch { /* not WSL */ }
    _platformCache = 'linux';
    return _platformCache;
  }
  _platformCache = 'unknown';
  return _platformCache;
}

/**
 * Detect WSL version (1 or 2). Returns undefined on non-WSL.
 */
function getWslVersion() {
  if (getPlatform() !== 'wsl') return undefined;
  try {
    const pv = fs.readFileSync('/proc/version', 'utf8');
    const m = pv.match(/WSL(\d+)/i);
    if (m && m[1]) return m[1];
    if (pv.toLowerCase().includes('microsoft')) return '1';
  } catch { /* ignore */ }
  return undefined;
}

// ── Git Bash discovery (Windows) ──────────────────────────────────

let _gitBashCache = null;

/**
 * Find git-bash executable on Windows.
 * Priority: KHY_GIT_BASH_PATH env → PATH search → common install locations.
 * Returns path to bash.exe, or 'bash' as last-resort fallback.
 */
function findGitBashPath() {
  if (_gitBashCache) return _gitBashCache;
  if (!isWin) { _gitBashCache = 'bash'; return _gitBashCache; }

  // 1. Explicit override
  if (process.env.KHY_GIT_BASH_PATH) {
    try {
      if (fs.existsSync(process.env.KHY_GIT_BASH_PATH)) {
        _gitBashCache = process.env.KHY_GIT_BASH_PATH;
        return _gitBashCache;
      }
    } catch { /* fallthrough */ }
  }

  // 2. Search PATH
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'bash.exe');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      _gitBashCache = candidate;
      return _gitBashCache;
    } catch { /* next */ }
  }

  // 3. Common Git for Windows locations
  const commonPaths = [
    path.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe'),
    path.join('C:', 'Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join('C:', 'Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ];
  if (process.env.ProgramFiles) {
    commonPaths.push(path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    commonPaths.push(path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  }
  for (const p of commonPaths) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      _gitBashCache = p;
      return _gitBashCache;
    } catch { /* next */ }
  }

  _gitBashCache = 'bash';
  return _gitBashCache;
}

// ── Shell configuration (three-mode) ─────────────────────────────

/**
 * Determine shell type and configuration for the current platform.
 * Returns { executable, argsPrefix, shell } where shell is 'bash'|'powershell'|'cmd'.
 *
 * On Windows:
 *   - Git Bash / MSYS2 detected via MSYSTEM/TERM → bash
 *   - COMSPEC containing powershell/pwsh → PowerShell
 *   - Default → cmd.exe
 * On Unix: always bash.
 *
 * @param {object} [options]
 * @param {boolean} [options.login=false] - On Unix bash, use a login shell
 *   (`-lc`) so user PATH from ~/.bash_profile / ~/.profile (nvm, pyenv, brew,
 *   cargo, …) is sourced. Required by the shell-command tool path. Ignored on
 *   Windows (cmd/PowerShell have no equivalent login flag here).
 */
function getShellConfiguration(options = {}) {
  const login = !!(options && options.login);

  // Explicit KHY_SHELL override (gated by shellChainStyle) — lets a user whose
  // interactive shell differs from auto-detection force the shell khy actually
  // spawns, so tool-call chaining syntax matches the prompt guidance. fail-soft:
  // any error / gate-off / unknown token → fall through to auto-detection below.
  try {
    const forced = require('../constants/shellChainStyle').parseExecOverride(process.env);
    // powershell / pwsh / cmd are Windows-native shells — only honor them on
    // Windows so a stray override on a POSIX host can't make khy spawn a
    // nonexistent cmd.exe / powershell.exe. bash/sh carry their own existence
    // checks below.
    if (isWin && forced === 'powershell') {
      return {
        executable: process.env.COMSPEC && process.env.COMSPEC.toLowerCase().endsWith('powershell.exe')
          ? process.env.COMSPEC : 'powershell.exe',
        argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'],
        shell: 'powershell',
      };
    }
    if (isWin && forced === 'pwsh') {
      return {
        executable: 'pwsh',
        argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'],
        shell: 'powershell',
      };
    }
    if (isWin && forced === 'cmd') {
      return {
        executable: process.env.COMSPEC || 'cmd.exe',
        argsPrefix: ['/d', '/s', '/c'],
        shell: 'cmd',
      };
    }
    if (forced === 'bash') {
      const bashPath = isWin ? findGitBashPath() : (fs.existsSync('/bin/bash') ? '/bin/bash' : null);
      if (bashPath) {
        return { executable: bashPath, argsPrefix: (login && !isWin) ? ['-lc'] : ['-c'], shell: 'bash' };
      }
    }
    if (forced === 'sh' && !isWin && fs.existsSync('/bin/sh')) {
      return { executable: '/bin/sh', argsPrefix: ['-c'], shell: 'sh' };
    }
  } catch { /* fall through to auto-detection */ }

  if (isWin) {
    // Detect Git Bash / MSYS2 environment
    const msystem = process.env.MSYSTEM || '';
    const term = process.env.TERM || '';
    const isGitBashEnv = msystem.startsWith('MINGW') || msystem.startsWith('MSYS')
      || term.includes('msys') || term.includes('cygwin');
    if (isGitBashEnv) {
      return { executable: findGitBashPath(), argsPrefix: ['-c'], shell: 'bash' };
    }

    const comSpec = (process.env.COMSPEC || 'cmd.exe').toLowerCase();
    if (comSpec.endsWith('powershell.exe') || comSpec.endsWith('pwsh.exe')) {
      return {
        executable: process.env.COMSPEC || 'powershell.exe',
        argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'],
        shell: 'powershell',
      };
    }

    return {
      executable: process.env.COMSPEC || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c'],
      shell: 'cmd',
    };
  }

  // Unix: prefer bash for richer features and login-shell PATH sourcing, but
  // fall back gracefully on minimal systems (Alpine/busybox, NixOS, distroless)
  // where /bin/bash does not exist. $SHELL → /bin/sh keeps the tool working.
  if (fs.existsSync('/bin/bash')) {
    return { executable: '/bin/bash', argsPrefix: login ? ['-lc'] : ['-c'], shell: 'bash' };
  }
  const envShell = process.env.SHELL;
  if (envShell && envShell !== '/bin/bash' && fs.existsSync(envShell)) {
    const isBash = envShell.endsWith('/bash');
    return {
      executable: envShell,
      argsPrefix: (login && isBash) ? ['-lc'] : ['-c'],
      shell: isBash ? 'bash' : 'sh',
    };
  }
  // Last resort: POSIX sh is guaranteed present. Drop the login flag since
  // dash/busybox login semantics are unreliable.
  return { executable: '/bin/sh', argsPrefix: ['-c'], shell: 'sh' };
}

// ── Windows PATH normalization ────────────────────────────────────

/**
 * Normalize PATH-like env vars on Windows. Merges case-variant keys
 * (PATH, Path, path) into a single canonical 'PATH' with deduped entries.
 * No-op on non-Windows.
 *
 * @param {object} env - Environment object (e.g. process.env)
 * @returns {object} Normalized env (new object, original not mutated)
 */
function normalizePathEnvForWindows(env) {
  if (!isWin) return env;
  const out = { ...env };
  const pathKeys = Object.keys(out).filter(k => k.toLowerCase() === 'path');
  if (pathKeys.length <= 1) return out;

  // Merge all values, dedup
  const seen = new Set();
  const merged = [];
  // Prefer uppercase PATH first
  const ordered = pathKeys.sort((a, b) => (a === 'PATH' ? -1 : b === 'PATH' ? 1 : a.localeCompare(b)));
  for (const key of ordered) {
    const val = out[key];
    if (!val) continue;
    for (const entry of val.split(';')) {
      if (!seen.has(entry)) { seen.add(entry); merged.push(entry); }
    }
  }

  // Remove all variants, set canonical PATH
  for (const key of pathKeys) { if (key !== 'PATH') delete out[key]; }
  out.PATH = merged.join(';');
  return out;
}

// ── Platform shell ─────────────────────────────────────────────────

/**
 * Return { cmd, args } for running a shell command string.
 * Unix: sh -c "command"
 * Windows: COMSPEC /d /s /c "command"
 */
function platformShell(command) {
  if (isWin) return { cmd: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  return { cmd: 'sh', args: ['-c', command] };
}

/**
 * Return the default interactive shell path.
 */
function defaultShell() {
  if (isWin) return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/sh';
}

// ── Process management ─────────────────────────────────────────────

/**
 * Kill a child process tree, cross-platform, with SIGTERM→SIGKILL escalation.
 * On Unix: kill the process group if possible, then escalate to SIGKILL after timeout.
 * On Windows: use taskkill /T /F /PID.
 * @param {number|ChildProcess} childOrPid
 * @param {string} [signal='SIGTERM']
 * @param {number} [escalateMs=3000] - Time before SIGKILL escalation (0 = no escalation)
 */
function safeKill(childOrPid, signal = 'SIGTERM', escalateMs = 3000) {
  const pid = typeof childOrPid === 'number' ? childOrPid : childOrPid?.pid;
  if (!pid) return;

  if (isWin) {
    // taskkill /T terminates the process tree
    try {
      require('child_process').execSync(`taskkill /T /F /PID ${pid}`, {
        stdio: 'ignore', timeout: 5000, windowsHide: true,
      });
    } catch {
      // Process may have already exited
      try {
        if (typeof childOrPid === 'object' && typeof childOrPid.kill === 'function') {
          childOrPid.kill();
        } else {
          process.kill(pid);
        }
      } catch { /* already dead */ }
    }
    return;
  }

  // Unix: try process group kill first
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      if (typeof childOrPid === 'object' && typeof childOrPid.kill === 'function') {
        childOrPid.kill(signal);
      } else {
        process.kill(pid, signal);
      }
    } catch { /* already dead */ }
  }

  // Escalate to SIGKILL after timeout if process is still alive
  if (escalateMs > 0 && signal !== 'SIGKILL') {
    setTimeout(() => {
      try {
        process.kill(pid, 0); // Check if still alive (throws if dead)
        try { process.kill(-pid, 'SIGKILL'); } catch {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        }
      } catch { /* already dead, no escalation needed */ }
    }, escalateMs).unref();
  }
}

/**
 * Send a signal to a child process, cross-platform.
 * On Windows SIGTERM/SIGKILL just terminate the process (Node built-in).
 * This is for single process, not tree kill.
 */
function safeSignal(childOrPid, signal = 'SIGTERM') {
  const pid = typeof childOrPid === 'number' ? childOrPid : childOrPid?.pid;
  if (!pid) return;
  try {
    if (typeof childOrPid === 'object' && typeof childOrPid.kill === 'function') {
      childOrPid.kill(signal);
    } else {
      process.kill(pid, signal);
    }
  } catch { /* already dead */ }
}

// ── Symlink / junction ─────────────────────────────────────────────

/**
 * Create a symlink; on Windows fall back to junction (no admin needed)
 * for directories, or hard link for files if symlink fails.
 */
function safeMklink(target, linkPath) {
  const resolved = path.resolve(target);
  try {
    // Try native symlink first
    const isDir = fs.statSync(resolved).isDirectory();
    fs.symlinkSync(resolved, linkPath, isDir ? 'junction' : 'file');
  } catch (e1) {
    if (!isWin) throw e1;
    // Windows fallback: junction for dirs, copy for files
    try {
      if (fs.statSync(resolved).isDirectory()) {
        fs.symlinkSync(resolved, linkPath, 'junction');
      } else {
        fs.copyFileSync(resolved, linkPath);
      }
    } catch (e2) {
      throw new Error(`Failed to create link ${linkPath} → ${target}: ${e2.message}`);
    }
  }
}

// ── chmod wrapper ──────────────────────────────────────────────────

/**
 * Set file permissions; silently ignored on Windows where chmod is
 * ineffective on NTFS.
 */
function safeChmod(filePath, mode) {
  if (isWin) return;
  try {
    fs.chmodSync(filePath, mode);
  } catch { /* non-fatal */ }
}

// ── Open URL / file in default application ─────────────────────────

/**
 * Open a URL or file with the platform default handler.
 * Returns the spawned ChildProcess (detached+unref'd).
 */
function openDefault(target) {
  const { spawn } = require('child_process');
  const safeTarget = String(target || '').trim();
  if (!safeTarget) throw new Error('openDefault target is required');
  let child;
  if (isWin) {
    // Use cmd.exe `start` with the safe flags (/d /s /c). The whole `start`
    // invocation is one argv element so the double-quoted URL survives as a
    // single token — that quoting neutralises `&` (and other) metacharacters
    // the URL may carry. `""` is start's window-title placeholder.
    const cmdPath = process.env.COMSPEC || 'cmd.exe';
    const quotedTarget = `"${safeTarget.replace(/"/g, '""')}"`;
    child = spawn(cmdPath, ['/d', '/s', '/c', `start "" ${quotedTarget}`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
  } else if (process.platform === 'darwin') {
    child = spawn('open', [safeTarget], { detached: true, stdio: 'ignore' });
  } else if (getPlatform() === 'wsl') {
    // WSL: use wslview (from wslu package) or fall back to cmd.exe via
    // /mnt/c/Windows/system32/cmd.exe to open in the Windows browser.
    if (searchExecutable('wslview')) {
      child = spawn('wslview', [safeTarget], { detached: true, stdio: 'ignore' });
    } else {
      // Fallback: invoke cmd.exe directly through the WSL interop layer.
      const cmdPath = searchExecutable('cmd.exe')
        || '/mnt/c/Windows/system32/cmd.exe';
      const quotedTarget = `"${safeTarget.replace(/"/g, '""')}"`;
      child = spawn(cmdPath, ['/d', '/s', '/c', `start "" ${quotedTarget}`], {
        detached: true, stdio: 'ignore',
      });
    }
  } else {
    // Linux: xdg-open → sensible-browser → fallback
    const opener = searchExecutable('xdg-open') ? 'xdg-open'
      : searchExecutable('sensible-browser') ? 'sensible-browser'
      : 'xdg-open';
    child = spawn(opener, [safeTarget], {
      detached: true, stdio: 'ignore', env: buildGuiEnv(),
    });
  }
  child.unref();
  return child;
}

// ── Docker / container detection ───────────────────────────────────

/**
 * Detect if running inside a Docker/container environment.
 */
function isContainer() {
  if (isWin) return false;
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('kubepods') || cgroup.includes('containerd');
  } catch {
    return false;
  }
}

// ── Legacy Windows Terminal detection ─────────────────────────────────

/**
 * Detect "legacy" Windows terminal (CMD/PowerShell without Windows Terminal).
 * Modern terminals (Windows Terminal, VS Code, ConEmu, Alacritty, WezTerm)
 * support full Unicode + VT sequences; legacy CMD/conhost does not.
 * Returns false on non-Windows or when running inside a modern terminal.
 */
let _legacyWinCache = null;
function isLegacyWinTerminal() {
  if (_legacyWinCache !== null) return _legacyWinCache;
  if (!isWin) { _legacyWinCache = false; return false; }
  const env = process.env;
  const isModern = !!(
    env.WT_SESSION ||                                     // Windows Terminal
    (env.TERM_PROGRAM && env.TERM_PROGRAM !== 'cmd') ||   // VS Code, iTerm2 等
    env.ConEmuPID ||                                      // ConEmu / Cmder
    env.ALACRITTY_LOG ||                                  // Alacritty
    env.KITTY_PID ||                                      // Kitty
    env.WEZTERM_PANE                                      // WezTerm
  );
  _legacyWinCache = !isModern;
  return _legacyWinCache;
}

/**
 * Detect mintty terminal (Git Bash / MSYS2 / Cygwin console on Windows).
 * Mintty uses MSYS PTY with different escape sequence support.
 */
function isMintty() {
  if (!isWin) return false;
  const env = process.env;
  return !!(env.TERM_PROGRAM === 'mintty' || (env.MSYSTEM && env.TERM && env.TERM.includes('xterm')));
}

/**
 * Detect if the current terminal supports modern VT sequences.
 * Returns true for all Unix terminals and modern Windows terminals
 * (Windows Terminal, VS Code, ConEmu, Alacritty, WezTerm, Kitty, mintty).
 */
function isModernWinTerminal() {
  if (!isWin) return true;
  return !isLegacyWinTerminal() || isMintty();
}

// ── Windows file-lock retry ────────────────────────────────────────

/**
 * Retry a synchronous function that may fail with EBUSY/EPERM on Windows.
 * On non-Windows, calls fn once without retry.
 */
function retryOnBusy(fn, retries = 3, delayMs = 100) {
  if (!isWin) return fn();
  for (let i = 0; ; i++) {
    try { return fn(); } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && i < retries) {
        const end = Date.now() + delayMs * (1 << i);
        while (Date.now() < end) { /* spin */ }
        continue;
      }
      throw err;
    }
  }
}

/**
 * Async version of retryOnBusy.
 */
async function retryOnBusyAsync(fn, retries = 3, delayMs = 100) {
  if (!isWin) return fn();
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && i < retries) {
        await new Promise(r => setTimeout(r, delayMs * (1 << i)));
        continue;
      }
      throw err;
    }
  }
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  // Platform constants
  isWin,
  isMac,
  NULL_DEVICE,
  HOME_DIR,
  POWERSHELL_BINS,
  // Platform detection
  getPlatform,
  getWslVersion,
  // Executable lookup
  searchExecutable,
  isRgAvailable,
  isGrepAvailable,
  // Git Bash
  findGitBashPath,
  // Shell configuration
  getShellConfiguration,
  normalizePathEnvForWindows,
  // GUI / display
  getDisplay,
  buildGuiEnv,
  isGuiApp,
  spawnGuiApp,
  openDefault,
  // Shell
  shellEscape,
  platformShell,
  defaultShell,
  // Process management
  safeKill,
  safeSignal,
  // Filesystem
  safeMklink,
  safeChmod,
  getTmpDir,
  getSessionTmpDir,
  ensureSessionTmpDir,
  cleanupSessionTmpDir,
  // Search
  pureJsGrep,
  DEFAULT_EXCLUDE_DIRS,
  // Environment
  isContainer,
  isLegacyWinTerminal,
  isMintty,
  isModernWinTerminal,
  // Sets
  LINUX_GUI_APPS,
  WINDOWS_GUI_APPS,
  // Windows file-lock retry
  retryOnBusy,
  retryOnBusyAsync,
};
