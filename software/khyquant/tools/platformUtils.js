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
    excludeDirs = ['node_modules', '.git', 'dist', 'build', '.cache', 'coverage', '__pycache__'],
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
// - 每个 khy 进程拥有独立的会话临时目录
// - 进程退出时通过 shutdown hook 自动清理
// - 异常退出的遗留目录由 cleanupService.cleanOsTempFiles() 兜底（前缀 khy-）
// - 目录权限 0o700，防止多用户环境下的信息泄露

let _sessionTmpDir = null;

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
 */
function ensureSessionTmpDir() {
  const dir = getSessionTmpDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* already exists or permission issue */ }
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
 */
function getShellConfiguration() {
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

  return { executable: 'bash', argsPrefix: ['-c'], shell: 'bash' };
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
    // Use PowerShell Start-Process to avoid cmd.exe '&' metacharacter issues.
    // cmd.exe /c start "" "url" breaks when URLs contain '&' query params
    // even with quoting, because /s strips outer quotes.
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process '${safeTarget.replace(/'/g, "''")}'`,
    ], {
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
  // Detached openers still emit 'error' on spawn failure (e.g. ENOENT when the
  // opener binary is missing); without a handler that event is unhandled and
  // crashes the host process. Swallow it — the caller only fire-and-forgets.
  child.on('error', (err) => {
    try { console.error('[openDefault] failed to launch opener:', err.message); } catch { /* ignore */ }
  });
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
  // Environment
  isContainer,
  isLegacyWinTerminal,
  // Sets
  LINUX_GUI_APPS,
  WINDOWS_GUI_APPS,
  // Windows file-lock retry
  retryOnBusy,
  retryOnBusyAsync,
};
