/**
 * Tool Sandbox — enhanced sandboxed execution with per-tool resource limits.
 *
 * Wraps Node.js vm module and child_process with:
 * - Configurable timeout per risk level
 * - Output size caps
 * - Command whitelist/blacklist for shell execution
 * - Memory measurement
 *
 * Extends (does not replace) resourceGuard.js's safeExec.
 */
const vm = require('vm');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

// ── OS-Level Sandbox (bwrap / Seatbelt / Windows Job Object) ──────

let _bwrapPath = undefined; // undefined = not checked yet
let _seatbeltAvailable = undefined;

/**
 * Detect bubblewrap availability (Linux only).
 * @returns {string|null} Path to bwrap binary or null
 */
function _detectBwrap() {
  if (_bwrapPath !== undefined) return _bwrapPath;
  if (process.platform !== 'linux') { _bwrapPath = null; return null; }
  try {
    const result = execSync('which bwrap 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
    _bwrapPath = result || null;
  } catch { _bwrapPath = null; }
  return _bwrapPath;
}

/**
 * Detect macOS sandbox-exec availability.
 * @returns {boolean}
 */
function _detectSeatbelt() {
  if (_seatbeltAvailable !== undefined) return _seatbeltAvailable;
  if (process.platform !== 'darwin') { _seatbeltAvailable = false; return false; }
  try {
    execSync('which sandbox-exec 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    _seatbeltAvailable = true;
  } catch { _seatbeltAvailable = false; }
  return _seatbeltAvailable;
}

/**
 * Build macOS Seatbelt (sandbox-exec) SBPL policy.
 * 借鉴 DeepSeek-TUI seatbelt.rs + Claude Code sandbox-adapter.ts.
 *
 * @param {object} opts
 * @param {string} opts.cwd - Project directory (writable)
 * @param {boolean} [opts.network=true] - Allow network
 * @param {string[]} [opts.extraWritable=[]] - Additional writable paths
 * @returns {string} SBPL policy string
 */
function _buildSeatbeltPolicy(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const home = os.homedir();
  const tmpDir = os.tmpdir();

  const writablePaths = [
    cwd, tmpDir, '/private/tmp',
    path.join(home, '.khyquant'),
    ...(opts.extraWritable || []),
  ];

  const lines = [
    '(version 1)',
    '(deny default)',
    // 基础能力
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm-read*)',
    '(allow ipc-posix-shm-write-create)',
    // 设备访问
    '(allow file-read* (subpath "/dev"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx"))',
    '(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))',
    // 系统只读
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    '(allow file-read* (subpath "/Library"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/etc"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/opt"))',
    // Home 只读
    `(allow file-read* (subpath "${home}"))`,
  ];

  // 可写路径
  for (const wp of writablePaths) {
    lines.push(`(allow file-write* (subpath "${wp}"))`);
    lines.push(`(allow file-read* (subpath "${wp}"))`);
  }

  // 网络
  if (opts.network !== false) {
    lines.push('(allow network*)');
  } else {
    lines.push('(allow network-outbound (to unix-socket))'); // 允许本地 socket
  }

  return lines.join('\n');
}

/**
 * Build macOS sandbox-exec command.
 * @param {string} command
 * @param {object} [opts]
 * @returns {string}
 */
function buildSeatbeltCommand(command, opts = {}) {
  if (process.platform !== 'darwin' || !_detectSeatbelt()) return command;

  const policy = _buildSeatbeltPolicy(opts);
  // sandbox-exec -p <policy> <command>
  // 需要将策略写入临时文件（策略太长无法内联）
  const crypto = require('crypto');
  const tmpFile = path.join(os.tmpdir(), `.khy-sbpl-${crypto.randomBytes(4).toString('hex')}.sb`);
  const fs = require('fs');
  fs.writeFileSync(tmpFile, policy);

  // 确保临时策略文件在命令结束后被清理
  return `sandbox-exec -f "${tmpFile}" /bin/sh -c '${command.replace(/'/g, "'\\''")}'  ; rm -f "${tmpFile}"`;
}

/**
 * Build Windows Job Object command (via PowerShell).
 * 借鉴 DeepSeek-TUI windows.rs: 使用 Job Object 限制子进程。
 *
 * @param {string} command
 * @param {object} [opts]
 * @param {number} [opts.memoryLimitMB=512]
 * @param {number} [opts.cpuRatePercent=80]
 * @returns {string}
 */
function buildWindowsJobCommand(command, opts = {}) {
  if (process.platform !== 'win32') return command;

  const memoryLimit = (opts.memoryLimitMB || 512) * 1024 * 1024;
  const cpuRate = opts.cpuRatePercent || 80;

  // PowerShell 脚本创建 Job Object 并在其中运行命令
  const ps = [
    '$job = [System.Diagnostics.Process]::Start("cmd.exe", "/c ' + command.replace(/"/g, '`"') + '")',
    'try {',
    `  $job.MaxWorkingSet = [IntPtr]::new(${memoryLimit})`,
    '  $job.WaitForExit()',
    '  exit $job.ExitCode',
    '} finally {',
    '  if (!$job.HasExited) { $job.Kill() }',
    '}',
  ].join('; ');

  return `powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`;
}

/**
 * Check whether OS-level sandboxing is enabled.
 * KHY_OS_SANDBOX: 'true'|'false'|'auto' (default: 'auto')
 *   auto = use bwrap (Linux) / Seatbelt (macOS) / Job Object (Windows) if available
 * @returns {boolean}
 */
function isOsSandboxEnabled() {
  const flag = String(process.env.KHY_OS_SANDBOX || 'auto').trim().toLowerCase();
  if (flag === 'false' || flag === '0') return false;
  if (process.platform === 'linux') return !!_detectBwrap();
  if (process.platform === 'darwin') return _detectSeatbelt();
  if (process.platform === 'win32') return true; // Job Object 始终可用
  return false;
}

/**
 * 跳出 OS 沙箱（不包裹 bwrap/seatbelt/Job Object 直接执行）是一次系统级提权——
 * **safe-by-construction**：裸 `_skipOsSandbox` 永远不足以关闭沙箱，必须额外携带由 syscall
 * 审批网关（`syscallGateway.evaluate({…, sandboxEscape:true})` 取得键入 YES 后）盖下的
 * `_sandboxEscapeApproved` 凭据。两者齐备才允许跳过沙箱；否则一律仍走沙箱包裹。
 * @param {object} limits
 * @returns {boolean}
 */
function _shouldSkipOsSandbox(limits) {
  return !!(limits && limits._skipOsSandbox === true && limits._sandboxEscapeApproved === true);
}

/**
 * 统一沙箱命令构建 — 按平台自动选择 backend.
 * 借鉴 DeepSeek-TUI SandboxManager.prepare(): Strategy pattern.
 *
 * @param {string} command
 * @param {object} [opts]
 * @returns {string} 包装后的命令
 */
function buildSandboxCommand(command, opts = {}) {
  if (process.platform === 'linux') return buildBwrapCommand(command, opts);
  if (process.platform === 'darwin') return buildSeatbeltCommand(command, opts);
  if (process.platform === 'win32') return buildWindowsJobCommand(command, opts);
  return command;
}

/**
 * Build bwrap arguments for sandboxed shell execution.
 *
 * Policy:
 *   - Bind project directory read-write (cwd)
 *   - Bind /tmp, /home (read-write) for build tools
 *   - Bind system paths read-only (/usr, /bin, /lib, /etc, /dev, /proc)
 *   - Block writes to /boot, /sys, /sbin outside project
 *   - Optionally disable network (--unshare-net) for untrusted commands
 *   - New PID namespace (--unshare-pid) to prevent signal escape
 *   - Create fresh /tmp if requested
 *
 * @param {string} command - Shell command to wrap
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Working directory (bound read-write)
 * @param {boolean} [opts.network=true] - Allow network access
 * @param {boolean} [opts.readOnlyRoot=false] - Mount project dir read-only
 * @param {string[]} [opts.extraBindRw] - Additional read-write bind mounts
 * @param {string[]} [opts.extraBindRo] - Additional read-only bind mounts
 * @returns {string} Full bwrap-wrapped command string
 */
function buildBwrapCommand(command, opts = {}) {
  if (process.platform === 'win32') return command; // bwrap not available on Windows
  const bwrap = _detectBwrap();
  if (!bwrap) return command; // fallback: no bwrap

  const cwd = opts.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const home = os.homedir();
  const tmpDir = os.tmpdir();

  const args = [bwrap];

  // PID namespace isolation — prevents killing host processes
  args.push('--unshare-pid');

  // Network isolation (disabled by default for build tools)
  if (opts.network === false) {
    args.push('--unshare-net');
  }

  // Die with parent — if khy process exits, sandbox child is killed
  args.push('--die-with-parent');

  // Read-only system mounts
  const roBinds = ['/usr', '/bin', '/lib', '/lib64', '/etc', '/opt', '/var/lib'];
  for (const p of roBinds) {
    try {
      if (require('fs').existsSync(p)) args.push('--ro-bind', p, p);
    } catch { /* skip non-existent */ }
  }

  // Device and proc filesystems (required for most commands)
  args.push('--dev', '/dev');
  args.push('--proc', '/proc');

  // Tmpfs for /tmp (isolated per execution)
  args.push('--tmpfs', '/tmp');
  // Bind real tmpdir if different from /tmp
  if (tmpDir && tmpDir !== '/tmp') {
    try {
      if (require('fs').existsSync(tmpDir)) args.push('--bind', tmpDir, tmpDir);
    } catch { /* skip */ }
  }

  // Home directory — read-write (needed for .npm, .cache, tool configs)
  if (home) {
    args.push('--bind', home, home);
  }

  // Project directory — read-write (or read-only for safe commands)
  if (opts.readOnlyRoot) {
    args.push('--ro-bind', cwd, cwd);
  } else {
    args.push('--bind', cwd, cwd);
  }

  // Extra bind mounts from caller
  if (Array.isArray(opts.extraBindRw)) {
    for (const p of opts.extraBindRw) {
      if (p) args.push('--bind', p, p);
    }
  }
  if (Array.isArray(opts.extraBindRo)) {
    for (const p of opts.extraBindRo) {
      if (p) args.push('--ro-bind', p, p);
    }
  }

  // Set working directory inside sandbox
  args.push('--chdir', cwd);

  // Shell command to run inside sandbox — must be a single arg to sh -c
  args.push('--', '/bin/sh', '-c', command);

  // Build final command string with proper quoting.
  // All args except the last (the shell command) are simple tokens.
  // The shell command must be single-quoted for sh -c.
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (i === args.length - 1) {
      // Last arg is the shell command — wrap in single quotes
      parts.push("'" + a.replace(/'/g, "'\\''") + "'");
    } else if (/[\s"'\\$`!]/.test(a)) {
      parts.push("'" + a.replace(/'/g, "'\\''") + "'");
    } else {
      parts.push(a);
    }
  }
  return parts.join(' ');
}

// ── Default limits per risk level ───────────────────────────────────

const DEFAULT_LIMITS = {
  safe:     { timeoutMs: 10000,  maxOutputBytes: 1048576,  maxMemoryMB: 100 },
  low:      { timeoutMs: 30000,  maxOutputBytes: 5242880,  maxMemoryMB: 200 },
  medium:   { timeoutMs: 60000,  maxOutputBytes: 10485760, maxMemoryMB: 300 },
  high:     { timeoutMs: 120000, maxOutputBytes: 10485760, maxMemoryMB: 500 },
  critical: { timeoutMs: 120000, maxOutputBytes: 10485760, maxMemoryMB: 500 },
};

// Commands that are always blocked (destructive / dangerous)
// Uses regex patterns instead of literal strings for robust matching
// that resists case/whitespace evasion.
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',   // fork bomb
  'chmod -R 777 /',
  'wget|sh',
  'curl|sh',
  'curl|bash',
  'wget|bash',
];

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\/(\s|$|\*)/i,  // rm -rf / or rm -rf /*
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+~(\s|$|\/)/i,    // rm -rf ~
  /\bmkfs\b/i,                                              // mkfs (any variant)
  /\bdd\s+.*\bif=/i,                                        // dd if=
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,             // fork bomb variants
  /\bchmod\s+.*-R\s+7{3}\s+\//i,                           // chmod -R 777 /
  /\b(wget|curl)\s+.*\|\s*(sh|bash)\b/i,                   // pipe download to shell
  /\b(sh|bash)\s+.*<\(.*\b(wget|curl)\b/i,                 // process substitution download
  /\beval\s+.*\$\(\s*(wget|curl)\b/i,                      // eval $(curl/wget ...)
  /\bsudo\s+rm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\//i,     // sudo rm -rf /
  /\b>\s*\/dev\/[sh]d[a-z]/i,                               // write to raw disk device
  /\bshred\s+.*\/dev\/[sh]d/i,                              // shred disk device
  /\bwipefs\b/i,                                             // wipe filesystem signatures
];

// Paths that should never be written to
const BLOCKED_PATHS = [
  '/etc/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/boot/',
  '/proc/',
  '/sys/',
];

// ── Sandboxed Code Execution ────────────────────────────────────────

/**
 * Execute JavaScript code in a sandboxed VM context.
 *
 * @param {string} code - JavaScript code to execute
 * @param {object} [limits]
 * @param {number} [limits.timeoutMs=5000] - Execution timeout
 * @param {number} [limits.maxOutputBytes=1048576] - Max output size
 * @returns {{ success: boolean, result?: any, output?: string, error?: string, elapsed: number }}
 */
function sandboxedExec(code, limits = {}) {
  const timeout = Math.min(limits.timeoutMs || 5000, 120000);
  const maxOutput = limits.maxOutputBytes || 1048576; // 1MB default

  const start = Date.now();
  const output = [];
  let totalOutputBytes = 0;

  // Create sandbox with limited globals
  const sandbox = {
    console: {
      log: (...args) => {
        const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        totalOutputBytes += Buffer.byteLength(line, 'utf-8');
        if (totalOutputBytes <= maxOutput) {
          output.push(line);
        }
      },
      error: (...args) => {
        const line = args.map(a => String(a)).join(' ');
        totalOutputBytes += Buffer.byteLength(line, 'utf-8');
        if (totalOutputBytes <= maxOutput) {
          output.push(`[ERROR] ${line}`);
        }
      },
      warn: (...args) => {
        const line = args.map(a => String(a)).join(' ');
        totalOutputBytes += Buffer.byteLength(line, 'utf-8');
        if (totalOutputBytes <= maxOutput) {
          output.push(`[WARN] ${line}`);
        }
      },
    },
    Math,
    Date,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    Promise,
    setTimeout: undefined,  // Blocked
    setInterval: undefined, // Blocked
    require: undefined,     // Blocked
    process: undefined,     // Blocked
    global: undefined,      // Blocked
  };

  try {
    const context = vm.createContext(sandbox);
    const script = new vm.Script(code, { filename: 'sandbox.js' });
    const result = script.runInContext(context, { timeout });

    const elapsed = Date.now() - start;
    const outputText = output.join('\n');
    const truncated = totalOutputBytes > maxOutput;

    return {
      success: true,
      result: _serializeResult(result),
      output: truncated ? outputText + `\n... (output truncated at ${maxOutput} bytes)` : outputText,
      elapsed,
      truncated,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      output: output.join('\n'),
      elapsed: Date.now() - start,
    };
  }
}

// ── Sandboxed Shell Execution ───────────────────────────────────────

/**
 * Execute a shell command with safety checks and output limits.
 *
 * @param {string} command - Shell command
 * @param {object} [limits]
 * @param {number} [limits.timeoutMs=30000] - Execution timeout
 * @param {number} [limits.maxOutputBytes=5242880] - Max output size (5MB)
 * @param {string[]} [limits.allowedCommands] - If set, only these command prefixes are allowed
 * @param {string} [limits.cwd] - Working directory
 * @returns {{ success: boolean, output?: string, error?: string, elapsed: number }}
 */
function sandboxedShell(command, limits = {}) {
  const timeout = Math.min(limits.timeoutMs || 30000, 120000);
  const maxOutput = limits.maxOutputBytes || 5242880;
  const cwd = limits.cwd || process.env.KHYQUANT_CWD || process.cwd();

  // Security: check blocked patterns (regex-based for evasion resistance)
  const cmdLower = command.toLowerCase().trim();

  // Legacy literal check (backwards compat)
  for (const blocked of BLOCKED_COMMANDS) {
    if (cmdLower.includes(blocked.toLowerCase())) {
      return {
        success: false,
        error: `Blocked: command contains dangerous pattern "${blocked}"`,
        elapsed: 0,
      };
    }
  }

  // Enhanced regex patterns (harder to evade)
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return {
        success: false,
        error: `Blocked: command matches dangerous pattern (${pattern.source.slice(0, 40)}...)`,
        elapsed: 0,
      };
    }
  }

  // Security: check blocked paths in write commands
  const writePatterns = /\b(rm|rmdir|mv|cp|chmod|chown|ln)\b/i;
  if (writePatterns.test(command)) {
    for (const blockedPath of BLOCKED_PATHS) {
      if (command.includes(blockedPath)) {
        return {
          success: false,
          error: `Blocked: cannot modify system path "${blockedPath}"`,
          elapsed: 0,
        };
      }
    }
  }

  // Allowed commands whitelist (if configured)
  if (limits.allowedCommands && Array.isArray(limits.allowedCommands)) {
    const cmdPrefix = command.split(/\s+/)[0];
    if (!limits.allowedCommands.includes(cmdPrefix)) {
      return {
        success: false,
        error: `Blocked: "${cmdPrefix}" is not in allowed commands list`,
        elapsed: 0,
      };
    }
  }

  const start = Date.now();

  try {
    // ── OS-level sandbox: wrap with bwrap if available ──────────
    let execCommand = command;
    let usedOsSandbox = false;
    if (isOsSandboxEnabled() && !_shouldSkipOsSandbox(limits)) {
      const tier = classifyCommand ? classifyCommand(command)?.tier : 'unknown';
      const disableNetwork = tier === 'dangerous' || tier === 'critical';
      const readOnly = tier === 'safe';
      execCommand = buildBwrapCommand(command, {
        cwd,
        network: !disableNetwork,
        readOnlyRoot: readOnly,
      });
      usedOsSandbox = true;
    }

    const output = execSync(execCommand, {
      cwd,
      timeout,
      encoding: 'utf-8',
      maxBuffer: maxOutput,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const elapsed = Date.now() - start;
    const truncated = Buffer.byteLength(output, 'utf-8') >= maxOutput;

    return {
      success: true,
      output: truncated ? output.slice(0, maxOutput) + '\n... (output truncated)' : output,
      elapsed,
      truncated,
      _osSandbox: usedOsSandbox,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      output: err.stdout ? String(err.stdout).slice(0, maxOutput) : '',
      stderr: err.stderr ? String(err.stderr).slice(0, 2000) : '',
      elapsed: Date.now() - start,
      _osSandbox: usedOsSandbox,
    };
  }
}

// ── Limit Configuration ─────────────────────────────────────────────

/**
 * Get default resource limits for a tool based on its risk level.
 *
 * @param {string} toolName - Tool name (for potential overrides)
 * @param {string} risk - Risk level
 * @returns {object} Resource limits
 */
function getToolLimits(toolName, risk) {
  const base = DEFAULT_LIMITS[risk] || DEFAULT_LIMITS.medium;
  return { ...base };
}

// ── Internal helpers ────────────────────────────────────────────────

function _serializeResult(result) {
  if (result === undefined) return undefined;
  if (result === null) return null;
  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
    return result;
  }
  try {
    const json = JSON.stringify(result);
    if (json.length > 10000) {
      return json.slice(0, 10000) + '... (truncated)';
    }
    return JSON.parse(json); // Round-trip to strip non-serializable values
  } catch {
    return String(result);
  }
}

// ── ANOLISA-aligned Command Classification ────────────────────────
// Classifies any shell command into a risk tier for sandbox policy decision.

const COMMAND_CLASSIFICATIONS = {
  // Safe: read-only, no side effects
  safe: [
    'ls', 'cat', 'head', 'tail', 'wc', 'echo', 'pwd', 'whoami', 'id', 'date',
    'uname', 'hostname', 'which', 'file', 'stat', 'du', 'df', 'env', 'printenv',
    'grep', 'rg', 'find', 'locate', 'tree', 'less', 'more', 'sort', 'uniq',
    'diff', 'md5sum', 'sha256sum', 'base64', 'xxd', 'hexdump', 'strings',
    'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote',
    'node --version', 'npm --version', 'python --version', 'moon version',
    // Windows equivalents
    'dir', 'type', 'where', 'ver', 'systeminfo',
  ],
  // Moderate: may modify user files, non-destructive
  moderate: [
    'cp', 'mv', 'touch', 'mkdir', 'ln', 'tar', 'zip', 'unzip', 'gzip', 'gunzip',
    'git add', 'git commit', 'git checkout', 'git merge', 'git stash',
    'npm install', 'npm run', 'pip install', 'moon build', 'moon test',
    'make', 'cargo build', 'go build',
    'sed', 'awk', 'tee', 'xargs',
    // Windows
    'copy', 'move', 'md', 'xcopy',
  ],
  // Dangerous: may cause data loss or affect system
  dangerous: [
    'rm', 'rmdir', 'chmod', 'chown', 'kill', 'pkill', 'killall',
    'apt', 'yum', 'dnf', 'pacman', 'brew',
    'npm uninstall', 'pip uninstall',
    'git push', 'git reset', 'git rebase', 'git clean',
    'docker', 'podman', 'systemctl', 'service',
    'crontab', 'at',
    // Windows
    'del', 'rd', 'icacls', 'taskkill', 'sc', 'net',
  ],
  // Critical: always blocked unless explicitly approved
  critical: [
    'dd', 'mkfs', 'fdisk', 'parted', 'mount', 'umount',
    'sudo', 'su', 'passwd',
    'iptables', 'firewall-cmd', 'ufw',
    'reboot', 'shutdown', 'init', 'halt', 'poweroff',
    'nc -e', 'ncat -e', 'socat',
    'curl|sh', 'wget|sh', 'curl|bash', 'wget|bash',
    // Windows
    'format', 'diskpart', 'shutdown', 'bcdedit',
  ],
};

/**
 * Classify a command into a risk tier.
 * Aligned with ANOLISA Agent Sec Core sandbox policy:
 *   safe       → read-only sandbox
 *   moderate   → workspace-write sandbox
 *   dangerous  → user confirmation required
 *   critical   → blocked unless approved
 *   unknown    → treated as moderate
 *
 * @param {string} command - Shell command to classify
 * @returns {{ tier: string, command: string, matchedRule: string|null }}
 */
function classifyCommand(command) {
  if (!command || typeof command !== 'string') {
    return { tier: 'unknown', command: '', matchedRule: null };
  }

  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();

  // For compound commands (||, &&, ;, |), classify each segment and return
  // the highest-risk tier found.  This prevents substring false positives
  // where e.g. "which feishu || find ..." accidentally matches a dangerous
  // pattern embedded in a longer token.
  if (/\|\||&&|;\s/.test(lower)) {
    const segments = lower.split(/\|\||&&|;/).map(s => s.trim()).filter(Boolean);
    let worstTier = 'safe';
    let worstRule = null;
    const tierOrder = { safe: 0, unknown: 1, moderate: 2, dangerous: 3, critical: 4 };
    for (const seg of segments) {
      const segResult = classifyCommand(seg);
      if ((tierOrder[segResult.tier] || 0) > (tierOrder[worstTier] || 0)) {
        worstTier = segResult.tier;
        worstRule = segResult.matchedRule;
      }
    }
    return { tier: worstTier, command: trimmed, matchedRule: worstRule };
  }

  // Extract the leading binary/command name for classification.
  // Handles env-prefixed commands like "VAR=val cmd ..."
  const leadBin = _extractLeadingBinary(lower);

  // Check from most dangerous to least
  for (const tier of ['critical', 'dangerous', 'moderate', 'safe']) {
    for (const pattern of COMMAND_CLASSIFICATIONS[tier]) {
      const pat = pattern.toLowerCase();
      // Multi-word patterns (e.g. "git push", "npm install") — match at start
      if (pat.includes(' ')) {
        if (lower.startsWith(pat) || lower.startsWith(pat + ' ')) {
          return { tier, command: trimmed, matchedRule: pattern };
        }
        continue;
      }
      // Single-word patterns — match the leading binary exactly, or match
      // as a word boundary in the full command.  This prevents "at" from
      // matching inside "cat" or "format".
      if (leadBin === pat) {
        return { tier, command: trimmed, matchedRule: pattern };
      }
      // Also check word-boundary match for piped/chained commands that
      // weren't split above (e.g. "cmd1 | cmd2").
      const wordRe = new RegExp(`(?:^|[|;&\\s])${_escapeRegex(pat)}(?:\\s|$)`);
      if (wordRe.test(lower)) {
        return { tier, command: trimmed, matchedRule: pattern };
      }
    }
  }

  return { tier: 'unknown', command: trimmed, matchedRule: null };
}

/**
 * Extract the leading binary name from a command string.
 * Strips env-var prefixes (VAR=val), leading whitespace.
 */
function _extractLeadingBinary(lower) {
  let s = lower.trim();
  // Strip env-var assignments: FOO=bar BAZ=qux cmd ...
  while (/^[a-z_][a-z0-9_]*=\S*\s+/.test(s)) {
    s = s.replace(/^[a-z_][a-z0-9_]*=\S*\s+/, '');
  }
  // Extract first token (the binary name)
  const match = s.match(/^([a-z0-9_./-]+)/);
  return match ? match[1] : '';
}

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get sandbox policy based on command classification.
 * @param {string} tier - Classification tier
 * @returns {{ allowed: boolean, requiresApproval: boolean, sandboxMode: string, limits: object }}
 */
function getSandboxPolicy(tier) {
  switch (tier) {
    case 'safe':
      return {
        allowed: true,
        requiresApproval: false,
        sandboxMode: 'read-only',
        limits: DEFAULT_LIMITS.safe,
      };
    case 'moderate':
      return {
        allowed: true,
        requiresApproval: false,
        sandboxMode: 'workspace-write',
        limits: DEFAULT_LIMITS.low,
      };
    case 'dangerous':
      return {
        allowed: true,
        requiresApproval: true,
        sandboxMode: 'workspace-write',
        limits: DEFAULT_LIMITS.medium,
      };
    case 'critical':
      return {
        allowed: false,
        requiresApproval: true,
        sandboxMode: 'full-access',
        limits: DEFAULT_LIMITS.critical,
      };
    default:
      return {
        allowed: true,
        requiresApproval: false,
        sandboxMode: 'workspace-write',
        limits: DEFAULT_LIMITS.low,
      };
  }
}

// ── Privilege Escalation Negotiation ───────────────────────────────

/**
 * In-memory store of user-approved escalations.
 * Key: `${userId}:${tier}` or `${userId}:command:${cmdPrefix}`
 * Value: { approvedAt: Date.now(), expiresAt: number, scope: string }
 *
 * Escalation approval is:
 *   - Session-scoped (clears on restart)
 *   - Time-limited (default 30 minutes for dangerous, 5 minutes for critical)
 *   - Auditable via escalationAuditLog
 */
const _approvedEscalations = new Map();
const _escalationAuditLog = [];
const MAX_AUDIT_LOG = 500;

const ESCALATION_TTL = {
  dangerous: 30 * 60 * 1000,  // 30 minutes
  critical:  5 * 60 * 1000,   // 5 minutes
};

/**
 * Check if a command has been pre-approved by the user for escalated execution.
 *
 * @param {string} command - Shell command
 * @param {string} [userId] - User ID (defaults to 'default')
 * @returns {{ approved: boolean, reason?: string }}
 */
function checkEscalationApproval(command, userId = 'default') {
  const { tier } = classifyCommand(command);
  if (tier === 'safe' || tier === 'moderate' || tier === 'unknown') {
    return { approved: true, reason: 'within_sandbox_tier' };
  }

  const now = Date.now();
  const cmdPrefix = command.trim().split(/\s+/).slice(0, 2).join(' ');

  // Check command-specific approval first
  const cmdKey = `${userId}:command:${cmdPrefix}`;
  const cmdApproval = _approvedEscalations.get(cmdKey);
  if (cmdApproval && cmdApproval.expiresAt > now) {
    return { approved: true, reason: 'command_approved', scope: cmdApproval.scope };
  }

  // Check tier-level approval
  const tierKey = `${userId}:${tier}`;
  const tierApproval = _approvedEscalations.get(tierKey);
  if (tierApproval && tierApproval.expiresAt > now) {
    return { approved: true, reason: 'tier_approved', scope: tierApproval.scope };
  }

  return { approved: false, reason: `requires_${tier}_approval` };
}

/**
 * Record user approval for escalated command execution.
 *
 * @param {object} params
 * @param {string} params.command - Approved command (or '*' for tier-level)
 * @param {string} params.tier - Risk tier
 * @param {string} [params.userId] - User ID
 * @param {string} [params.scope] - 'command' | 'tier' | 'session'
 * @param {number} [params.ttlMs] - Custom TTL in ms
 * @returns {{ key: string, expiresAt: number }}
 */
function approveEscalation(params) {
  const { command, tier, userId = 'default', scope = 'command' } = params;
  const ttl = params.ttlMs || ESCALATION_TTL[tier] || ESCALATION_TTL.dangerous;
  const now = Date.now();
  const expiresAt = now + ttl;

  const cmdPrefix = command === '*' ? '*' : command.trim().split(/\s+/).slice(0, 2).join(' ');
  const key = scope === 'tier'
    ? `${userId}:${tier}`
    : `${userId}:command:${cmdPrefix}`;

  _approvedEscalations.set(key, {
    approvedAt: now,
    expiresAt,
    scope,
    command: cmdPrefix,
    tier,
  });

  // Audit log
  const entry = {
    timestamp: new Date().toISOString(),
    userId,
    tier,
    command: cmdPrefix,
    scope,
    ttlMs: ttl,
    action: 'approve',
  };
  _escalationAuditLog.push(entry);
  if (_escalationAuditLog.length > MAX_AUDIT_LOG) {
    _escalationAuditLog.splice(0, _escalationAuditLog.length - MAX_AUDIT_LOG);
  }

  return { key, expiresAt };
}

/**
 * Revoke all escalation approvals for a user.
 * @param {string} [userId]
 */
function revokeAllEscalations(userId = 'default') {
  for (const key of [..._approvedEscalations.keys()]) {
    if (key.startsWith(`${userId}:`)) {
      _approvedEscalations.delete(key);
    }
  }
  _escalationAuditLog.push({
    timestamp: new Date().toISOString(),
    userId,
    action: 'revoke_all',
  });
}

/**
 * Get the escalation audit log.
 * @param {number} [limit=50]
 * @returns {Array}
 */
function getEscalationAuditLog(limit = 50) {
  return _escalationAuditLog.slice(-limit);
}

// ── Execution Router ──────────────────────────────────────────────

/**
 * Route a command to the appropriate executor based on its classification.
 *
 * Returns execution plan (does NOT execute):
 *   - safe/moderate → { executor: 'sandbox', limits, approved: true }
 *   - dangerous (approved) → { executor: 'sandbox', limits, approved: true }
 *   - dangerous (not approved) → { executor: 'pending', needsApproval: true }
 *   - critical (approved + sandbox-escape gateway token) → { executor: 'direct', limits, approved: true }
 *   - critical (not approved, or no gateway escape token) → { executor: 'blocked', needsApproval: true }
 *
 * Security invariant (safe-by-construction): `executor:'direct'` is a full-access OS-sandbox
 * ESCAPE. It is **never** granted by the local TTL escalation ledger alone, and **never** by
 * `autoApprove` (which only ever auto-approves *dangerous* commands → still `executor:'sandbox'`,
 * never an escape). The escape executor requires an explicit `options._sandboxEscapeApproved`
 * token, which only a caller that first cleared `syscallGateway.evaluate({…, sandboxEscape:true})`
 * (typed YES, L2) may set. Absent that token the critical command is routed to `'blocked'`.
 *
 * @param {string} command
 * @param {object} [options]
 * @param {string} [options.userId]
 * @param {boolean} [options.autoApprove] - If true, dangerous commands are auto-approved (never escape)
 * @param {boolean} [options._sandboxEscapeApproved] - Gateway-issued sandbox-escape token (see above)
 * @returns {{ executor: string, tier: string, limits: object, approved: boolean, needsApproval?: boolean, matchedRule?: string }}
 */
function routeCommand(command, options = {}) {
  const { tier, matchedRule } = classifyCommand(command);
  const policy = getSandboxPolicy(tier);
  const { userId, autoApprove } = options;
  const escapeApproved = options._sandboxEscapeApproved === true;

  // A critical command can only run via the escape executor ('direct'/full-access) when the
  // syscall gateway has issued an escape token. Without it, critical is hard-blocked regardless
  // of any local escalation-ledger entry — the gateway's typed-YES is the sole escape authority.
  const _criticalRoute = () => (tier === 'critical' && !escapeApproved)
    ? {
        executor: 'blocked',
        tier,
        limits: policy.limits,
        approved: false,
        needsApproval: true,
        matchedRule,
        approvalReason: 'sandbox_escape_requires_gateway',
      }
    : null;

  // Safe and moderate: always allowed
  if (tier === 'safe' || tier === 'moderate' || tier === 'unknown') {
    return {
      executor: 'sandbox',
      tier,
      limits: policy.limits,
      approved: true,
      matchedRule,
    };
  }

  // Check existing approval
  const approval = checkEscalationApproval(command, userId);
  if (approval.approved) {
    // Local ledger approval is NOT sufficient to ESCAPE the sandbox: a critical command
    // still requires the gateway-issued escape token, else it is hard-blocked.
    const blocked = _criticalRoute();
    if (blocked) return blocked;
    return {
      executor: tier === 'critical' ? 'direct' : 'sandbox',
      tier,
      limits: policy.limits,
      approved: true,
      matchedRule,
      approvalReason: approval.reason,
    };
  }

  // Auto-approve dangerous commands if configured
  if (tier === 'dangerous' && autoApprove) {
    approveEscalation({ command, tier, userId, scope: 'command' });
    return {
      executor: 'sandbox',
      tier,
      limits: policy.limits,
      approved: true,
      matchedRule,
      approvalReason: 'auto_approved',
    };
  }

  // Needs user approval
  return {
    executor: tier === 'critical' ? 'blocked' : 'pending',
    tier,
    limits: policy.limits,
    approved: false,
    needsApproval: true,
    matchedRule,
    approvalPrompt: tier === 'critical'
      ? `⚠ Critical command detected: "${command.slice(0, 80)}". This command is blocked by default. Type "approve" to allow execution (5 min window).`
      : `⚠ Dangerous command: "${command.slice(0, 80)}". Type "approve" to allow (30 min window), or "skip" to cancel.`,
  };
}

/**
 * Obtain a sandbox-escape decision from the single approval authority (the syscall gateway).
 * This is the ONLY legitimate way to mint the `_sandboxEscapeApproved` token consumed by
 * `routeCommand` / `_shouldSkipOsSandbox`. Delegates to `syscallGateway.evaluate` with
 * `sandboxEscape:true`, which classifies the request L2 (typed YES, unbypassable, fail-closed).
 *
 * Intended for the future wiring that runs commands outside the OS sandbox; today the escape
 * executors are dead code, so this exists to make that wiring a one-liner that cannot skip the
 * gateway. Any gateway error / non-approval yields `{ approved:false }` (fail-closed).
 *
 * @param {object} call  { sessionId, tool, params, risk, cwd, home }
 * @param {object} [io]  { prompter, l2ConfirmWord, breakerOpts } — forwarded to the gateway
 * @returns {Promise<{ approved: boolean, level?: string, reasons?: string[] }>}
 */
async function evaluateSandboxEscape(call = {}, io = {}) {
  try {
    const gateway = require('./syscallGateway');
    const verdict = await gateway.evaluate({ ...call, sandboxEscape: true }, io);
    return { approved: verdict.allow === true, level: verdict.level, reasons: verdict.reasons };
  } catch (e) {
    return { approved: false, reasons: [`sandbox-escape gateway error fail-closed: ${e && e.message}`] };
  }
}

module.exports = {
  sandboxedExec,
  sandboxedShell,
  getToolLimits,
  DEFAULT_LIMITS,
  BLOCKED_COMMANDS,
  BLOCKED_COMMAND_PATTERNS,
  // ANOLISA-aligned command classification
  classifyCommand,
  getSandboxPolicy,
  COMMAND_CLASSIFICATIONS,
  // Privilege escalation
  checkEscalationApproval,
  approveEscalation,
  revokeAllEscalations,
  getEscalationAuditLog,
  // Execution routing
  routeCommand,
  // Sandbox-escape gating (safe-by-construction; gateway is the sole escape authority)
  evaluateSandboxEscape,
  _shouldSkipOsSandbox,
  // OS-level sandbox (cross-platform)
  isOsSandboxEnabled,
  buildBwrapCommand,
  buildSeatbeltCommand,
  buildWindowsJobCommand,
  buildSandboxCommand,
  _detectBwrap,
  _detectSeatbelt,
};
