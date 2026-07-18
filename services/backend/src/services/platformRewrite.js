'use strict';

/**
 * Platform command rewriting — Unix ↔ Windows ↔ macOS command translation.
 *
 * Extracted from toolUseLoop.js (lines 4406-4507) as part of the
 * industrial-grade modularization (Phase 1A).
 * Phase R2-5A: Added macOS-specific command aliases.
 *
 * Dependencies: none (only uses process.platform).
 */

// ── Lookup tables ────────────────────────────────────────────────────

// macOS-specific: Linux desktop commands → macOS equivalents
const _LINUX_TO_MACOS = {
  'xdg-open': 'open',
  'xclip': 'pbcopy',
  'xsel': 'pbcopy',
  'xdg-mime': 'mdls',
  'nautilus': 'open',
  'nemo': 'open',
  'dolphin': 'open',
  'thunar': 'open',
  'xdg-settings': 'defaults',
  'xrandr': 'system_profiler SPDisplaysDataType',
  'apt': 'brew',
  'apt-get': 'brew',
  'yum': 'brew',
  'dnf': 'brew',
  'pacman': 'brew',
  'systemctl': 'launchctl',
  'journalctl': 'log show',
};

const _UNIX_TO_WIN = {
  ls: 'dir', cat: 'type', cp: 'copy', mv: 'move', rm: 'del',
  grep: 'findstr', touch: 'type nul >', which: 'where', pwd: 'cd',
  clear: 'cls', head: 'powershell -NoProfile -c "Get-Content"',
  tail: 'powershell -NoProfile -c "Get-Content ... -Tail"',
  chmod: '(no equivalent)', chown: '(no equivalent)',
  ps: 'tasklist', kill: 'taskkill', df: 'powershell -NoProfile -c "Get-CimInstance Win32_LogicalDisk"',
  uname: 'ver', find: 'dir /s /b',
};

const _WIN_TO_UNIX = {
  dir: 'ls', type: 'cat', copy: 'cp', move: 'mv', del: 'rm',
  findstr: 'grep', where: 'which', cls: 'clear',
  tasklist: 'ps aux', taskkill: 'kill', ver: 'uname -a',
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Proactive platform command rewriting — called BEFORE execution.
 * Uses shellCommand.js _patchWinCommand on Windows;
 * on Linux, rewrites common Windows commands to Unix equivalents.
 * Returns the (possibly rewritten) command string.
 */
function proactivePlatformRewrite(command) {
  if (!command || typeof command !== 'string') return command;
  const isWin = process.platform === 'win32';

  if (isWin) {
    // shellCommand.js _patchWinCommand already handles Win patching at execution time.
    // Here we only patch path-level issues that may confuse the safety validator.
    let patched = command;
    // ~/path → %USERPROFILE%\path
    patched = patched.replace(/(?<=^|\s)~\//g, '%USERPROFILE%\\');
    // /dev/null → NUL
    patched = patched.replace(/\/dev\/null/g, 'NUL');
    return patched;
  }

  // macOS: rewrite Linux-desktop commands to macOS equivalents
  if (process.platform === 'darwin') {
    const base = command.trim().split(/[\s|;&]/)[0].toLowerCase();
    const macCmd = _LINUX_TO_MACOS[base];
    if (macCmd) {
      command = command.replace(new RegExp(`^${base}\\b`, 'm'), macCmd);
    }
  }

  // Linux/macOS: rewrite Windows commands to Unix
  let patched = command;

  // dir → ls (at start of command or after &&)
  patched = patched.replace(/^dir\b/m, 'ls');
  patched = patched.replace(/(?<=&&\s*)dir\b/g, 'ls');
  // dir /s /b pattern → find . -name "pattern"
  patched = patched.replace(/\bdir\s+\/s\s+\/b\s+(\S+)/g, 'find . -name "$1"');
  // type file → cat file
  patched = patched.replace(/^type\s+/m, 'cat ');
  patched = patched.replace(/(?<=&&\s*)type\s+/g, 'cat ');
  // copy src dst → cp src dst
  patched = patched.replace(/\bcopy\s+/g, 'cp ');
  // move src dst → mv src dst
  patched = patched.replace(/\bmove\s+/g, 'mv ');
  // del file → rm file
  patched = patched.replace(/\bdel\s+/g, 'rm ');
  // rmdir /s /q dir → rm -rf dir
  patched = patched.replace(/\brmdir\s+\/s\s+\/q\s+/g, 'rm -rf ');
  // findstr → grep
  patched = patched.replace(/\bfindstr\s+\/s\s+/g, 'grep -r ');
  patched = patched.replace(/\bfindstr\s+\/i\s+/g, 'grep -i ');
  patched = patched.replace(/\bfindstr\s+/g, 'grep ');
  // where cmd → which cmd
  patched = patched.replace(/\bwhere\s+/g, 'which ');
  // cls → clear
  patched = patched.replace(/\bcls\b/g, 'clear');
  // tasklist → ps aux
  patched = patched.replace(/\btasklist\b/g, 'ps aux');
  // taskkill /F /PID N → kill -9 N
  patched = patched.replace(/\btaskkill\s+\/F\s+\/PID\s+(\d+)/g, 'kill -9 $1');
  patched = patched.replace(/\btaskkill\s+\/PID\s+(\d+)/g, 'kill $1');
  // %USERPROFILE% → ~, %VAR% → $VAR
  patched = patched.replace(/%USERPROFILE%/g, '~');
  patched = patched.replace(/%([A-Za-z_]\w*)%/g, '$$$1');
  // Backslash paths → forward slash (heuristic: only when it looks like a path)
  patched = patched.replace(/([A-Za-z]):\\(?=[A-Za-z])/g, '/$1/');
  // 2>NUL → 2>/dev/null
  patched = patched.replace(/2>\s*NUL\b/gi, '2>/dev/null');
  patched = patched.replace(/>\s*NUL\b/gi, '>/dev/null');
  // cmd.exe /c → remove wrapper
  patched = patched.replace(/^(?:cmd\.exe|cmd)\s+\/[cCdDsS]+\s+/m, '');

  return patched;
}

function getWindowsCommandHint(command) {
  if (!command) return null;
  const base = command.trim().split(/[\s/\\|;&]/)[0].toLowerCase();
  const winCmd = _UNIX_TO_WIN[base];
  if (!winCmd) return null;
  const hasHome = /~[/\\]/.test(command);
  const pathHint = hasHome ? '，将 ~ 替换为 %USERPROFILE%' : '';
  return `当前系统是 Windows，"${base}" 不可用。请改用 "${winCmd}"${pathHint}。`;
}

function getLinuxCommandHint(command) {
  if (!command) return null;
  const base = command.trim().split(/[\s/\\|;&]/)[0].toLowerCase();
  const unixCmd = _WIN_TO_UNIX[base];
  if (!unixCmd) return null;
  return `当前系统是 Linux/macOS，"${base}" 不可用。请改用 "${unixCmd}"。`;
}

function getMacOSCommandHint(command) {
  if (!command) return null;
  const base = command.trim().split(/[\s/\\|;&]/)[0].toLowerCase();
  const macCmd = _LINUX_TO_MACOS[base];
  if (!macCmd) return null;
  return `当前系统是 macOS，"${base}" 不可用。请改用 "${macCmd}"。`;
}

module.exports = {
  proactivePlatformRewrite,
  getWindowsCommandHint,
  getLinuxCommandHint,
  getMacOSCommandHint,
  _UNIX_TO_WIN,
  _WIN_TO_UNIX,
  _LINUX_TO_MACOS,
};
