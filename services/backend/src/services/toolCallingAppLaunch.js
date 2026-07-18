'use strict';

/**
 * toolCalling 应用启动与检测子系统(从 toolCalling.js 上帝文件抽出)。
 *
 * 职责:GUI/交互式应用探测(_isGuiApplication)、已安装应用索引与别名匹配
 * (APP_ALIAS_MAP/_matchInstalledApp/hasInstalledAppMatch)、跨平台启动与验证
 * (_launchLinuxDesktopEntry/_spawnDetached/_verifyWindowsLaunch)、open-default 目标
 * 解析。全部应用缓存态(_guiAppCache/_installedAppsCache/_installedAppsCacheTime)私有于
 * 本叶子,仅经本模块函数读写;对宿主零回调(单向 host→leaf,无环)。
 *
 * **刻意非纯零 IO 叶子**:探测读 fs、spawn/execFileSync 启动进程、懒加载
 * platformUtils/terminalLaunchCommand/winAppPaths。放置为 toolCalling.js 的**同目录
 * 兄弟**以保迁移的 require 相对路径字节不变。宿主 open_app 处理器、_openFilesystemTarget
 * 及 module.exports 按**同名 re-import** 接回,调用点字节不变。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
// App Paths registry leaf (fail-soft): missing bundled copy must never crash.
let _winAppPaths; try { _winAppPaths = require('./winAppPaths'); } catch { _winAppPaths = null; }

// ── Interactive Application Detection ──────────────────────────────
// Detects whether a command is an interactive/GUI application that should
// be spawned detached (not blocking execSync). Works cross-platform.

// Cache: populated lazily on first call. Maps binary name → true/false.
let _guiAppCache = null;

// CLI tools that should NEVER be spawned detached (they expect piped I/O)
const _cliTools = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'file', 'stat',
  'pwd', 'which', 'echo', 'tree', 'du', 'df', 'date', 'whoami', 'hostname',
  'uname', 'env', 'printenv', 'sort', 'uniq', 'sed', 'awk', 'cut', 'tr',
  'tee', 'xargs', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'tar', 'gzip',
  'zip', 'unzip', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown',
  'ln', 'touch', 'diff', 'patch', 'git', 'npm', 'node', 'python', 'python3',
  'pip', 'pip3', 'docker', 'systemctl', 'journalctl', 'ps', 'top', 'htop',
  'kill', 'pkill', 'pgrep', 'mount', 'umount', 'fdisk', 'lsblk', 'ip',
  'ifconfig', 'ping', 'traceroute', 'nslookup', 'dig', 'netstat', 'ss',
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew', 'snap', 'flatpak',
  'dpkg', 'rpm', 'make', 'cmake', 'gcc', 'g++', 'cargo', 'go', 'javac',
  'java', 'mvn', 'gradle', 'bash', 'sh', 'zsh', 'fish', 'crontab', 'at',
  'systemctl', 'service', 'sudo', 'su', 'man', 'info', 'help',
]);

/**
 * Build the GUI app cache by scanning .desktop files (Linux) or known paths.
 * Returns a Set of binary names that are GUI/interactive applications.
 */
function _buildGuiAppCache() {
  const cache = new Set();

  if (process.platform === 'linux') {
    // Scan .desktop files — every GUI app on Linux registers one
    const desktopDirs = [
      '/usr/share/applications',
      '/usr/local/share/applications',
      path.join(os.homedir(), '.local/share/applications'),
      '/var/lib/flatpak/exports/share/applications',
      '/var/lib/snapd/desktop/applications',
    ];
    for (const dir of desktopDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.desktop'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
            // Extract Exec= line and get the binary name
            const execMatch = content.match(/^Exec\s*=\s*(.+)$/m);
            if (!execMatch) continue;
            // Exec line may have %f %u etc. args, env prefixes, or full paths
            let execCmd = execMatch[1].trim()
              .replace(/^env\s+\S+=\S+\s+/, '')  // strip env VAR=val prefix
              .replace(/%[fFuUdDnNickvm]/g, '')   // strip desktop entry codes
              .trim();
            const bin = path.basename(execCmd.split(/\s+/)[0]);
            if (bin) cache.add(bin);
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip inaccessible dirs */ }
    }
  } else if (process.platform === 'win32') {
    // On Windows, scan common app directories and Start Menu shortcuts
    const progDirs = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
    ].filter(Boolean);
    for (const dir of progDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        // Only scan top-level subdirectories (app names)
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          // Use the directory/exe name as a potential app name
          cache.add(entry.toLowerCase().replace(/\.exe$/i, ''));
        }
      } catch { /* skip */ }
    }
    // Also scan Start Menu for .lnk files (covers most installed apps)
    const startMenuDirs = [
      path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
    for (const dir of startMenuDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const walk = (d) => {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) { try { walk(path.join(d, entry.name)); } catch {} }
            else if (entry.name.endsWith('.lnk')) {
              cache.add(entry.name.replace(/\.lnk$/i, '').toLowerCase());
            }
          }
        };
        walk(dir);
      } catch { /* skip */ }
    }
  } else if (process.platform === 'darwin') {
    // macOS: scan /Applications
    try {
      const apps = fs.readdirSync('/Applications')
        .filter(f => f.endsWith('.app'))
        .map(f => f.replace(/\.app$/, '').toLowerCase());
      apps.forEach(a => cache.add(a));
    } catch { /* skip */ }
  }

  return cache;
}

/**
 * Determine if a command binary is an interactive/GUI application.
 * Uses multiple heuristics:
 *   1. Known CLI tool → false (never detach)
 *   2. In .desktop file cache → true
 *   3. Has a .desktop file by name → true
 *   4. `which` resolves it and it's not in system bin → likely app
 */
function _isGuiApplication(cmdBin) {
  if (!cmdBin) return false;
  const bin = path.basename(cmdBin).toLowerCase();

  // Definitely a CLI tool
  if (_cliTools.has(bin)) return false;

  // Platform-specific GUI launchers
  if (bin === 'xdg-open') return true;
  if (bin === 'open' && process.platform === 'darwin') return true;
  if (bin === 'start' && process.platform === 'win32') return true;

  // Build cache once
  if (!_guiAppCache) {
    _guiAppCache = _buildGuiAppCache();
  }

  // Direct match in desktop file cache
  if (_guiAppCache.has(bin)) return true;

  // Check if a .desktop file exists for this binary name
  if (process.platform === 'linux') {
    const desktopDirs = [
      '/usr/share/applications',
      '/usr/local/share/applications',
      path.join(os.homedir(), '.local/share/applications'),
    ];
    for (const dir of desktopDirs) {
      try {
        if (fs.existsSync(path.join(dir, `${bin}.desktop`))) return true;
      } catch {}
    }
  }

  // Check if the binary is in an app-like path (not /usr/bin CLI tools)
  const { searchExecutable: _searchExec } = require('../tools/platformUtils');
  try {
    const resolved = _searchExec(bin);
    if (resolved) {
      // Binaries in /opt, /snap, ~/local/bin, AppImage paths are usually GUI apps
      if (/\/(opt|snap|flatpak|AppImage|\.local\/bin)\//.test(resolved)) return true;
      // Symlinks to /opt or snap are also GUI apps
      try {
        const real = fs.realpathSync(resolved);
        if (/\/(opt|snap|flatpak)\//.test(real)) return true;
      } catch {}
    }
  } catch { /* binary not found */ }

  return false;
}

// ── Installed App Index ────────────────────────────────────────────
// Scans .desktop files to build a searchable list of all installed GUI apps.
// Cached after first call; refresh by setting _installedAppsCache = null.
let _installedAppsCache = null;
let _installedAppsCacheTime = 0;
const APP_CACHE_TTL = 60000; // refresh every 60s

const APP_ALIAS_MAP = Object.freeze({
  // Browsers
  '火狐': 'firefox',
  '火狐浏览器': 'firefox',
  'firefox': 'firefox',
  'ff': 'firefox',
  '夸克': 'quark',
  '夸克浏览器': 'quark',
  'quark': 'quark',
  '谷歌浏览器': 'google-chrome',
  '谷歌': 'google-chrome',
  'chrome': 'google-chrome',
  'chromium': 'chromium',
  'edge': 'microsoft-edge',
  '微软浏览器': 'microsoft-edge',
  '浏览器': 'firefox',

  // IM / Collaboration
  '飞书': 'bytedance-feishu',
  'lark': 'bytedance-feishu',
  'feishu': 'bytedance-feishu',
  '微信': 'wechat',
  '企业微信': 'wxwork',
  'qq': 'qq',
  '钉钉': 'dingtalk',

  // System utilities
  '终端': 'gnome-terminal',
  '控制台': 'gnome-terminal',
  '文件管理器': 'nautilus',
  '文件': 'nautilus',

  // Category intents
  '图片编辑器': 'gimp',
  '图像编辑器': 'gimp',
  '照片编辑器': 'gimp',
  'image editor': 'gimp',
  'photo editor': 'gimp',
  'pdf编辑器': 'libreoffice',
  'pdf editor': 'libreoffice',

  // App stores (deterministic backstop so the gateway interceptor proceeds and
  // the installed-app matcher launches the local client, e.g. Huawei AppGallery
  // at C:\Program Files\Huawei\AppGallery\AppGallery.exe — never the website).
  '华为应用市场': 'appgallery',
  '应用市场': 'appgallery',
  'appgallery': 'appgallery',
  'app gallery': 'appgallery',
  'huawei appgallery': 'appgallery',
});

function _normalizeAppQuery(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、“”‘’"'`~!@#$%^&*()_+=|\\[\]{};:<>/?-]/g, '');
}

// 预归一化的别名对(Ch2「不要每轮重建可复用结构」）：_buildAppCandidates 旧实现每次调用都
// `Object.entries(APP_ALIAS_MAP)` 并对每个 key 现算 `_normalizeAppQuery(k)`(多次 regex replace)
// 及 `String(v).toLowerCase()`。APP_ALIAS_MAP 是 Object.freeze 的模块常量,_normalizeAppQuery 是纯
// 字符串函数→归一化结果与调用无关,构造一次即可。只读迭代、不 mutate,派生 keyNorm/valLower 逐字节
// 等价;插入顺序经 Object.entries→map 保持不变,故 candidates Set 的可观测顺序不变。
const _APP_ALIAS_NORM = Object.entries(APP_ALIAS_MAP).map(
  ([k, v]) => [_normalizeAppQuery(k), String(v).toLowerCase()],
);

function _buildAppCandidates(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];

  const normalized = _normalizeAppQuery(raw);
  const candidates = new Set();

  candidates.add(raw.toLowerCase());
  candidates.add(normalized);

  const directAlias = APP_ALIAS_MAP[raw] || APP_ALIAS_MAP[normalized];
  if (directAlias) candidates.add(String(directAlias).toLowerCase());

  for (const [keyNorm, valLower] of _APP_ALIAS_NORM) {
    if (normalized && (normalized === keyNorm || normalized.includes(keyNorm) || keyNorm.includes(normalized))) {
      candidates.add(valLower);
    }
  }

  return Array.from(candidates).filter(Boolean);
}

/**
 * 在已装应用索引中模糊匹配一个应用名,返回命中的 app 记录或 null。
 * **单一真源**:open_app handler 与 hasInstalledAppMatch(网关本地优先闸门)都调本函数,
 * 杜绝匹配逻辑被复制出第二份。
 * 优先级:exact bin/name > startsWith > includes > 中文名 nameCn includes > keywords/searchText。
 *
 * @param {string} rawName 用户给出的应用名(任意语言/大小写)
 * @returns {object|null} 命中的已装应用记录,或 null
 */
function _matchInstalledApp(rawName) {
  const name = String(rawName || '').trim();
  const appName = name.toLowerCase();
  const candidates = _buildAppCandidates(name);
  const apps = _getInstalledApps();

  let match = null;
  for (const candidate of candidates.length > 0 ? candidates : [appName]) {
    match = apps.find(a => a.bin === candidate || a.name.toLowerCase() === candidate);
    if (!match) match = apps.find(a => a.bin.startsWith(candidate) || a.name.toLowerCase().startsWith(candidate));
    if (!match) match = apps.find(a => a.bin.includes(candidate) || a.name.toLowerCase().includes(candidate));
    if (!match && name) match = apps.find(a => a.nameCn && a.nameCn.includes(name));
    if (!match) {
      match = apps.find(a =>
        a.keywords.some(k => k.includes(candidate))
        || candidate.split(/\s+/).every(w => a.searchText.includes(w))
      );
    }
    if (match) break;
  }
  return match || null;
}

/**
 * 本机是否装有与 rawName 匹配的应用。供网关 appLaunchInterceptor 的「本地优先」闸门用:
 * 即便不在 APP_ALIAS_MAP 白名单,只要本地确有此应用,也优先拦截走 open_app 启动本地 exe,
 * 而非放行让模型自行开网页。绝不抛(扫描异常 → false → 回退原 cascade)。
 *
 * @param {string} rawName
 * @returns {boolean}
 */
function hasInstalledAppMatch(rawName) {
  try { return !!_matchInstalledApp(rawName); } catch { return false; }
}

// 测试钩子:直接注入已装应用索引(绕过文件系统扫描)。仅供单测;传 null 复位为真实扫描。
function _primeInstalledAppsForTest(apps) {
  _installedAppsCache = Array.isArray(apps) ? apps : null;
  _installedAppsCacheTime = Date.now();
}

function _commandExists(bin) {
  if (!bin) return false;
  const { searchExecutable } = require('../tools/platformUtils');
  return !!searchExecutable(bin);
}

function _splitExecLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] || m[2] || m[3] || '');
  }
  return out.filter(Boolean);
}

async function _launchLinuxDesktopEntry(app = {}) {
  if (process.platform !== 'linux') {
    return { launched: false, reason: 'unsupported-platform' };
  }
  const desktopId = String(app.desktopId || '').trim();
  const desktopPath = String(app.desktopPath || '').trim();

  const launchers = [];
  if (desktopId && _commandExists('gtk-launch')) {
    launchers.push({ command: 'gtk-launch', args: [desktopId], hint: `gtk-launch ${desktopId}` });
  }
  if (desktopPath && _commandExists('gio')) {
    launchers.push({ command: 'gio', args: ['launch', desktopPath], hint: `gio launch ${desktopPath}` });
  }
  if (desktopPath && _commandExists('xdg-open')) {
    launchers.push({ command: 'xdg-open', args: [desktopPath], hint: `xdg-open ${desktopPath}` });
  }

  if (launchers.length === 0) {
    return { launched: false, reason: 'launcher-not-found' };
  }

  let lastError = null;
  for (const item of launchers) {
    try {
      await _spawnDetached(item.command, item.args, {
        env: { ...process.env },
      });
      return {
        launched: true,
        mode: 'desktop-entry',
        command: item.command,
        args: item.args,
        hint: item.hint,
      };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    launched: false,
    reason: 'all-launchers-failed',
    error: lastError,
  };
}

function _resolveWindowsShortcutTarget(linkPath) {
  if (process.platform !== 'win32') return '';
  const raw = String(linkPath || '').trim().replace(/^"+|"+$/g, '');
  if (!raw || !/\.lnk$/i.test(raw)) return '';

  const { execFileSync } = require('child_process');
  const psBin = _commandExists('pwsh') ? 'pwsh' : (_commandExists('powershell') ? 'powershell' : '');
  if (!psBin) return '';

  const escaped = raw.replace(/'/g, "''");
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$w = New-Object -ComObject WScript.Shell',
    `$s = $w.CreateShortcut('${escaped}')`,
    'if ($null -ne $s -and $s.TargetPath) { [Console]::Out.Write($s.TargetPath) }',
  ].join('; ');

  try {
    const stdout = execFileSync(psBin, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    return String(stdout || '').trim().replace(/^"+|"+$/g, '');
  } catch {
    return '';
  }
}

function _looksLikePowerShellCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return false;
  if (/^(?:powershell|pwsh)(?:\.exe)?\b/i.test(trimmed)) return false;
  if (/^(?:cmd|cmd\.exe)\b/i.test(trimmed)) return false;
  if (/^[A-Za-z]:\\/.test(trimmed) || /^\\\\/.test(trimmed)) return false;
  if (/^\.\.?[\\/]/.test(trimmed)) return false;
  if (/^[A-Za-z0-9_.-]+(?:\.exe|\.cmd|\.bat)?\b/.test(trimmed) && !/-[A-Za-z]/.test(trimmed)) return false;
  return /^(?:New|Get|Set|Remove|Copy|Move|Rename|Test|Resolve|Clear|Start|Stop|Restart|Enable|Disable|Add)-[A-Za-z]+/i
    .test(trimmed);
}

/**
 * Spawn an interactive agent inside a NEW terminal window using the per-platform
 * argv built by terminalLaunchCommand. Resolves to the child on success, or null
 * on any failure (so _spawnDetached can fall back to the historical launch).
 * The terminal launcher itself is detached + unref'd; we do NOT set stdio:'ignore'
 * on win32 `start`, which needs its own console handles to open the new window.
 */
async function _trySpawnInTerminal(spawn, built, options, env) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      const spawnOpts = { detached: true, env };
      if (options && options.cwd) spawnOpts.cwd = options.cwd;
      if (process.platform === 'win32') {
        if (built.windowsHide) spawnOpts.windowsHide = true;
      } else {
        spawnOpts.stdio = 'ignore';
      }
      child = spawn(built.command, built.args, spawnOpts);
    } catch {
      resolve(null);
      return;
    }
    child.once('error', () => { if (!settled) { settled = true; resolve(null); } });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch { /* noop */ }
      resolve(child);
    });
  });
}

async function _spawnDetached(command, args = [], options = {}) {
  const { spawn } = require('child_process');
  const { buildGuiEnv } = require('../tools/platformUtils');
  // Ensure GUI env (DISPLAY etc.) is set for graphical applications
  const env = options.env ? buildGuiEnv(options.env) : buildGuiEnv();
  const isWin = process.platform === 'win32';

  // Interactive TUI agents (opencode/claude/codex/…) must run in a REAL terminal
  // window — launching them hidden/detached leaves them with no console to render
  // or read input ("让 khy 启动 opencode 却不新开终端"). Route known interactive
  // agents (conservative allow-list) through a new-terminal spawn. Gate
  // KHY_TERMINAL_LAUNCH (default on). Fail-soft: if the terminal spawn errors
  // (e.g. no terminal emulator), fall through to the historical detached launch
  // so we never regress an app launch into an outright failure.
  let _termLeaf = null;
  try { _termLeaf = require('./terminalLaunchCommand'); } catch { _termLeaf = null; }
  const _wantTerminal = !!(_termLeaf
    && _termLeaf.isEnabled(env)
    && (options.interactive === true || _termLeaf.isInteractiveTerminalApp(command, env)));
  if (_wantTerminal) {
    const built = _termLeaf.buildTerminalLaunchArgv({ target: command, args, platform: process.platform, env });
    if (built && built.command) {
      const termChild = await _trySpawnInTerminal(spawn, built, options, env);
      if (termChild) return termChild;
      // terminal spawn failed → fall through to historical detached launch below
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      if (isWin) {
        const target = String(command || '').trim().replace(/^"+|"+$/g, '');
        const targetBase = path.basename(target).toLowerCase();
        const normalizedArgs = Array.isArray(args) ? args.map(a => String(a)) : [];
        const spawnOptions = {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          ...options,
          env,
        };

        if (targetBase === 'explorer' || targetBase === 'explorer.exe') {
          child = spawn('explorer.exe', normalizedArgs, spawnOptions);
        } else if (/\.(lnk|url)$/i.test(target)) {
          child = spawn('explorer.exe', [target, ...normalizedArgs], spawnOptions);
        } else if (/\.msi$/i.test(target)) {
          child = spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', 'start', '', target, ...normalizedArgs], spawnOptions);
        } else {
          child = spawn(target, normalizedArgs, spawnOptions);
        }
      } else {
        child = spawn(command, args, {
          detached: true,
          stdio: 'ignore',
          ...options,
          env,
        });
      }
    } catch (err) {
      reject(err);
      return;
    }
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch { /* noop */ }
      resolve(child);
    });
  });
}

function _inferWindowsImageName(command) {
  let raw = String(command || '').trim().replace(/^"+|"+$/g, '');
  if (!raw) return '';
  if (/\.lnk$/i.test(raw)) {
    const target = _resolveWindowsShortcutTarget(raw);
    if (target) raw = target;
  }
  const base = path.basename(raw).toLowerCase();
  if (!base || base === 'explorer' || base === 'explorer.exe') return '';
  if (/\.(lnk|url|msi|cmd|bat|ps1|vbs|js)$/i.test(base)) return '';
  if (base.endsWith('.exe')) return base;
  if (/^[a-z0-9_.-]+$/i.test(base)) return `${base}.exe`;
  return '';
}

function _formatLaunchOutput(displayName, execHint, verification) {
  if (verification && verification.verified) {
    return `已启动并验证: ${displayName} (${execHint})`;
  }
  if (!verification) {
    return `已发送启动请求: ${displayName} (${execHint})（未验证）`;
  }
  if (verification.mode === 'unverifiable') {
    return `已发送启动请求: ${displayName} (${execHint})（未验证：无法识别目标进程）`;
  }
  if (verification.reason === 'no-new-process-detected' && verification.imageName) {
    return `已发送启动请求: ${displayName} (${execHint})（未验证：未检测到新进程 ${verification.imageName}）`;
  }
  return `已发送启动请求: ${displayName} (${execHint})（未验证）`;
}

function _getWindowsProcessPids(imageName) {
  const { execFileSync } = require('child_process');
  const out = new Set();
  if (!imageName) return out;
  try {
    const stdout = execFileSync('tasklist', [
      '/FI',
      `IMAGENAME eq ${imageName}`,
      '/FO',
      'CSV',
      '/NH',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
    });
    const lines = String(stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.startsWith('"')) continue;
      const m = line.match(/^"[^"]*","([^"]+)",/);
      if (!m) continue;
      const pid = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(pid) && pid > 0) out.add(pid);
    }
  } catch {
    return out;
  }
  return out;
}

async function _verifyWindowsLaunch(command, beforePids = new Set(), timeoutMs = 2000, opts = {}) {
  const imageName = String(opts.imageName || '').trim() || _inferWindowsImageName(command);
  if (!imageName) {
    return {
      verified: false,
      mode: 'unverifiable',
      reason: 'process-name-unknown',
    };
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const afterPids = _getWindowsProcessPids(imageName);
    for (const pid of afterPids) {
      if (!beforePids.has(pid)) {
        return {
          verified: true,
          mode: 'process-diff',
          imageName,
          pid,
        };
      }
    }
  }

  return {
    verified: false,
    mode: 'process-diff',
    imageName,
    reason: 'no-new-process-detected',
  };
}

/**
 * Detect shell commands that are probing for an app rather than doing real work.
 * Examples: `which feishu`, `command -v lark`, `nohup feishu &`, `pgrep -i feishu`
 */
function _looksLikeShellAppProbe(command) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return false;
  return /\b(which|whereis|command\s+-v|type\s+-p|nohup|xdg-open|gtk-launch|gio\s+launch)\b/.test(cmd)
    || /\b(pgrep|pidof)\b/.test(cmd)
    || /\bps\s+aux\b.*\bgrep\b/.test(cmd);
}

/**
 * Extract the likely app target from a shell probe command.
 * "which feishu" → "feishu", "nohup lark &" → "lark", "xdg-open https://..." → null
 */
function _extractAppTargetFromCommand(command) {
  const cmd = String(command || '').trim();
  // "which X" / "whereis X" / "command -v X" / "type -p X"
  let m = cmd.match(/\b(?:which|whereis|command\s+-v|type\s+-p)\s+(\S+)/i);
  if (m) return m[1];
  // "nohup X ..." / "nohup X &"
  m = cmd.match(/\bnohup\s+(\S+)/i);
  if (m) return m[1];
  // "gtk-launch X" / "gio launch X"
  m = cmd.match(/\b(?:gtk-launch|gio\s+launch)\s+(\S+)/i);
  if (m) return m[1].replace(/\.desktop$/, '');
  // Direct binary invocation (single word or word + args)
  const parts = cmd.split(/\s+/);
  if (parts.length <= 3 && !/[|><;&$`]/.test(cmd)) {
    return parts[0];
  }
  return null;
}

function _hasGraphicalSession() {
  if (process.platform !== 'linux') return true;
  const { getDisplay } = require('../tools/platformUtils');
  const display = getDisplay();
  const wayland = String(process.env.WAYLAND_DISPLAY || '').trim();
  return !!(display || wayland);
}

// Executable suffixes that must stay on the application-launch path (NOT routed
// to the system default handler). A `.exe`/`.bat`/… is something to *run*, not a
// document to "open with the default program".
const _OPEN_DEFAULT_EXECUTABLE_EXT = new Set([
  '.exe', '.app', '.com', '.bat', '.cmd', '.msi', '.lnk',
]);

/**
 * Decide whether an `open_app` target is really a URL or an existing file that
 * should be handed to the OS default handler (browser / viewer) instead of being
 * matched against installed applications.
 *
 * Why: the model frequently calls `open_app` to "open a webpage / a .html file"
 * (user complaint: 「为什么打开网页却用 open_app」). open_app's fuzzy app matcher
 * then treats the URL / path as an app name and fails "Application not found".
 * Routing these to `platformUtils.openDefault` turns the mis-use into supported
 * behavior and makes the result correct regardless of which tool the model picks.
 *
 * Returns the resolved target string when it should be delegated to openDefault,
 * or null to fall through to the existing application-match logic (zero
 * regression for genuine app names like "docker" / "火狐").
 *
 * @param {string} rawName  the user-supplied `name` parameter (already trimmed)
 * @param {string} [cwd]    base directory for resolving relative file paths
 * @returns {string|null}
 */
function _resolveOpenDefaultTarget(rawName, cwd) {
  const raw = String(rawName || '').trim();
  if (!raw) return null;
  // 1) Explicit URL scheme → delegate verbatim (http/https/file).
  if (/^(?:https?|file):\/\//i.test(raw)) return raw;
  // 2) A bare executable name/suffix stays on the app-launch path.
  let ext = '';
  try { ext = path.extname(raw).toLowerCase(); } catch { ext = ''; }
  if (_OPEN_DEFAULT_EXECUTABLE_EXT.has(ext)) return null;
  // 3) An existing file/path (relative or absolute) → open with default handler.
  //    Covers .html / .pdf / images / documents the model wants to "open".
  try {
    const base = cwd || process.cwd();
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(base, raw);
    if (fs.existsSync(resolved)) return resolved;
  } catch { /* not a usable path — fall through */ }
  // Neither a URL nor an existing file: a real app name — let the matcher run.
  return null;
}

function _getInstalledApps() {
  const now = Date.now();
  if (_installedAppsCache && (now - _installedAppsCacheTime) < APP_CACHE_TTL) {
    return _installedAppsCache;
  }

  const apps = [];

  if (process.platform === 'linux') {
    const desktopDirs = [
      '/usr/share/applications',
      '/usr/local/share/applications',
      path.join(os.homedir(), '.local/share/applications'),
      '/var/lib/flatpak/exports/share/applications',
      '/var/lib/snapd/desktop/applications',
    ];

    for (const dir of desktopDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.desktop'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
            // Skip entries that are truly hidden services (Type=Service, OnlyShowIn=...)
            if (/^Type\s*=\s*Service/mi.test(content)) continue;

            const nameMatch = content.match(/^Name\s*=\s*(.+)$/m);
            const nameCnMatch = content.match(/^Name\[zh_CN\]\s*=\s*(.+)$/m);
            const execMatch = content.match(/^Exec\s*=\s*(.+)$/m);
            const keywordsMatch = content.match(/^Keywords\s*=\s*(.+)$/m);
            const commentMatch = content.match(/^Comment\s*=\s*(.+)$/m);
            const commentCnMatch = content.match(/^Comment\[zh_CN\]\s*=\s*(.+)$/m);

            if (!execMatch) continue;

            let execCmd = execMatch[1].trim()
              .replace(/%[fFuUdDnNickvm]/g, '')  // strip desktop entry field codes
              .replace(/^env\s+\S+=\S+\s+/g, '') // strip env prefixes
              .trim();
            const bin = path.basename(execCmd.split(/\s+/)[0]);
            const name = (nameMatch ? nameMatch[1].trim() : bin);
            const nameCn = nameCnMatch ? nameCnMatch[1].trim() : '';
            const keywords = keywordsMatch
              ? keywordsMatch[1].split(';').map(k => k.trim().toLowerCase()).filter(Boolean)
              : [];
            const comment = commentMatch ? commentMatch[1].trim() : '';
            const commentCn = commentCnMatch ? commentCnMatch[1].trim() : '';

            // Build combined search text for fuzzy matching
            const searchText = [name, nameCn, bin, comment, commentCn, ...keywords, file.replace('.desktop', '')]
              .join(' ').toLowerCase();

            apps.push({
              name,
              nameCn,
              bin,
              exec: execCmd,
              keywords,
              searchText,
              file,
              desktopId: file.replace(/\.desktop$/i, ''),
              desktopPath: path.join(dir, file),
            });
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip inaccessible dir */ }
    }
  } else if (process.platform === 'win32') {
    // Windows: scan Start Menu shortcuts
    const startMenuDirs = [
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
    for (const dir of startMenuDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const walk = (d) => {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) { try { walk(path.join(d, entry.name)); } catch {} }
            else if (entry.name.endsWith('.lnk') || entry.name.endsWith('.url')) {
              const name = entry.name.replace(/\.(lnk|url)$/i, '');
              apps.push({ name, nameCn: '', bin: name.toLowerCase(), exec: path.join(d, entry.name), keywords: [], searchText: name.toLowerCase(), file: entry.name });
            }
          }
        };
        walk(dir);
      } catch { /* skip */ }
    }
    // Second discovery source: the Windows "App Paths" registry — the
    // authoritative SSOT for "where is <exe> installed", covering apps that
    // register no Start-Menu shortcut (e.g. installed to a non-default drive).
    // IO lives here (thin shell); parsing is the winAppPaths pure leaf.
    // Gate KHY_APP_PATHS_REGISTRY (default on) → off falls back byte-identically
    // to the Start-Menu-only scan above. Start-Menu records win on `bin`
    // collision; App Paths only fills the gaps.
    if (_winAppPaths && _winAppPaths.isEnabled(process.env)) {
      try {
        const { execFileSync } = require('child_process');
        const seen = new Set(apps.map(a => String(a.bin || '').toLowerCase()));
        const roots = [
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
          'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
        ];
        for (const root of roots) {
          let stdout = '';
          try {
            stdout = execFileSync('reg', ['query', root, '/s'], {
              encoding: 'utf8',
              windowsHide: true,
              timeout: 4000,
            });
          } catch { continue; /* key absent or reg unavailable — best-effort */ }
          for (const rec of _winAppPaths.buildAppPathRecords(stdout)) {
            const key = String(rec.bin || '').toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            apps.push(rec);
          }
        }
      } catch { /* best-effort: never let discovery crash the tool layer */ }
    }
  } else if (process.platform === 'darwin') {
    try {
      const macApps = fs.readdirSync('/Applications').filter(f => f.endsWith('.app'));
      for (const app of macApps) {
        const name = app.replace('.app', '');
        apps.push({ name, nameCn: '', bin: name.toLowerCase(), exec: `open -a "${name}"`, keywords: [], searchText: name.toLowerCase(), file: app });
      }
    } catch { /* skip */ }
  }

  _installedAppsCache = apps;
  _installedAppsCacheTime = now;
  return apps;
}

module.exports = {
  _buildGuiAppCache, _isGuiApplication,
  APP_ALIAS_MAP, _normalizeAppQuery, _buildAppCandidates, _matchInstalledApp,
  hasInstalledAppMatch, _primeInstalledAppsForTest, _commandExists, _splitExecLine,
  _launchLinuxDesktopEntry, _resolveWindowsShortcutTarget, _looksLikePowerShellCommand,
  _trySpawnInTerminal, _spawnDetached, _inferWindowsImageName, _formatLaunchOutput,
  _getWindowsProcessPids, _verifyWindowsLaunch, _looksLikeShellAppProbe,
  _extractAppTargetFromCommand, _hasGraphicalSession, _resolveOpenDefaultTarget,
  _getInstalledApps,
};
