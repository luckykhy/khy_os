/**
 * Resource Guard — prevent terminal/computer freezing.
 *
 * Provides:
 *   - Watchdog timer for long-running operations
 *   - Memory usage monitoring with auto-GC
 *   - Infinite loop detection (CPU spin guard)
 *   - Network call timeouts
 *   - Graceful recovery from hangs
 *   - Child process resource limits (adaptive: container-aware, env-tunable)
 */
const os = require('os');
const { execSync } = require('child_process');
const fs = require('fs');

// ── Limits ──────────────────────────────────────────────────────────────
const MAX_HEAP_MB = parseInt(process.env.KHY_MAX_HEAP_MB, 10) || 512;
const WATCHDOG_TIMEOUT_MS = parseInt(process.env.KHY_WATCHDOG_MS, 10) || 120_000; // 2 min
const NETWORK_TIMEOUT_MS = 60_000;     // 1 min for network calls
const SHELL_TIMEOUT_MS = 30_000;       // 30s for shell commands
const SHELL_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB output buffer
const GC_CHECK_INTERVAL_MS = 30_000;   // Check memory every 30s
const GC_THRESHOLD_PERCENT = 80;       // Trigger GC at 80% of limit

let _watchdogTimer = null;
let _watchdogCallback = null;
let _gcTimer = null;
let _operationStack = [];

// ── Watchdog Timer ──────────────────────────────────────────────────────

/**
 * Start a watchdog timer for a named operation.
 * This uses an activity-aware (sliding) timeout: calling `.touch()` marks
 * progress and extends the deadline.
 *
 * @param {string} operationName
 * @param {number} [timeoutMs]
 * @param {function} [onTimeout] - Called if timeout fires
 * @returns {object} Guard handle with .done() / .touch() / .elapsed() methods
 */
function startWatchdog(operationName, timeoutMs = WATCHDOG_TIMEOUT_MS, onTimeout = null) {
  const startTime = Date.now();
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : WATCHDOG_TIMEOUT_MS;
  const pollMs = Math.max(250, Math.min(1000, Math.floor(safeTimeoutMs / 6)));
  const entry = {
    name: operationName,
    startTime,
    lastActivityAt: startTime,
    done: false,
    timedOut: false,
  };
  _operationStack.push(entry);

  const stopTimer = (timer) => {
    if (!timer) return;
    clearInterval(timer);
  };

  const timer = setInterval(() => {
    if (entry.done || entry.timedOut) return;
    const idleMs = Date.now() - entry.lastActivityAt;
    if (idleMs < safeTimeoutMs) return;

    entry.timedOut = true;
    stopTimer(timer);
    const idx = _operationStack.indexOf(entry);
    if (idx >= 0) _operationStack.splice(idx, 1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const msg = `[ResourceGuard] Operation "${operationName}" timed out after ${elapsed}s`;

    // Log warning
    try { console.error(`\n  ⚠ ${msg}\n`); } catch { /* ignore */ }

    if (onTimeout) {
      try { onTimeout(operationName, elapsed); } catch { /* ignore */ }
    }
  }, pollMs);

  timer.unref?.(); // Don't block process exit

  return {
    done() {
      entry.done = true;
      stopTimer(timer);
      const idx = _operationStack.indexOf(entry);
      if (idx >= 0) _operationStack.splice(idx, 1);
    },
    touch() {
      if (entry.done || entry.timedOut) return;
      entry.lastActivityAt = Date.now();
    },
    elapsed() {
      return Date.now() - startTime;
    },
  };
}

// ── Memory Monitor ──────────────────────────────────────────────────────

/**
 * Get current memory usage stats.
 */
function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    heapUsedMB: Math.round(usage.heapUsed / (1024 * 1024)),
    heapTotalMB: Math.round(usage.heapTotal / (1024 * 1024)),
    rssMB: Math.round(usage.rss / (1024 * 1024)),
    externalMB: Math.round((usage.external || 0) / (1024 * 1024)),
    limitMB: MAX_HEAP_MB,
    percentUsed: Math.round((usage.heapUsed / (MAX_HEAP_MB * 1024 * 1024)) * 100),
  };
}

/**
 * Check if memory is critically high and attempt GC.
 * @returns {boolean} true if memory was freed
 */
function checkMemoryPressure() {
  const mem = getMemoryUsage();

  if (mem.percentUsed > GC_THRESHOLD_PERCENT) {
    // Try to trigger GC if exposed
    if (global.gc) {
      global.gc();
      return true;
    }

    // Clear module caches for non-essential modules
    const expendable = [
      '../services/strategyRecommender',
      '../services/finlightNewsService',
    ];
    for (const mod of expendable) {
      try {
        const resolved = require.resolve(mod);
        if (require.cache[resolved]) {
          delete require.cache[resolved];
        }
      } catch { /* module not loaded */ }
    }

    return false;
  }

  return false;
}

/**
 * Start periodic memory monitoring.
 */
function startMemoryMonitor() {
  if (_gcTimer) return;
  _gcTimer = setInterval(() => {
    try {
      const mem = getMemoryUsage();
      if (mem.percentUsed > 95) {
        console.error(`\n  ⚠ 内存使用过高: ${mem.heapUsedMB}/${mem.limitMB} MB (${mem.percentUsed}%)`);
        console.error('  建议: 减少并发操作或重启终端\n');
        checkMemoryPressure();
      }
    } catch { /* monitor must never crash */ }
  }, GC_CHECK_INTERVAL_MS);
  _gcTimer.unref();
}

function stopMemoryMonitor() {
  if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
}

// ── Container detection ────────────────────────────────────────────────

let _isContainerCached;
function _isContainer() {
  if (_isContainerCached !== undefined) return _isContainerCached;
  if (process.platform === 'win32') { _isContainerCached = false; return false; }
  try {
    if (fs.existsSync('/.dockerenv')) { _isContainerCached = true; return true; }
    const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
    _isContainerCached = cg.includes('docker') || cg.includes('kubepods') || cg.includes('containerd');
  } catch {
    _isContainerCached = false;
  }
  return _isContainerCached;
}

// ── Safe Shell Execution ────────────────────────────────────────────────

/**
 * Execute a shell command with resource limits.
 * Prevents: infinite loops, excessive output, excessive runtime, fork bombs.
 *
 * Resource limits are adaptive:
 *   - In containers (Docker/k8s): skip ulimit entirely (cgroup already enforces)
 *   - Environment overrides: KHY_ULIMIT_NPROC, KHY_ULIMIT_VMEM, KHY_ULIMIT_FD, KHY_ULIMIT_FSIZE
 *   - Defaults raised from 256→1024 child processes (256 was too strict for normal workflows)
 *
 * @param {string} command - Shell command to execute
 * @param {object} [opts]
 * @param {number} [opts.timeout] - Max execution time in ms
 * @param {number} [opts.maxBuffer] - Max output buffer in bytes
 * @param {string} [opts.cwd] - Working directory
 * @param {boolean} [opts.noLimits] - Skip ulimit wrapping entirely
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
function safeExec(command, opts = {}) {
  const timeout = opts.timeout || SHELL_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer || SHELL_MAX_BUFFER;
  const cwd = opts.cwd || process.cwd();

  // Build resource-limited command on Linux
  let wrappedCommand = command;
  if (process.platform !== 'win32' && !opts.noLimits) {
    // In containers, cgroup already enforces limits — skip ulimit to avoid
    // false "Resource temporarily unavailable" errors.
    if (_isContainer()) {
      wrappedCommand = `bash -c '${command.replace(/'/g, "'\\''")}'`;
    } else {
      // Tunable via environment; defaults are generous enough for normal dev workflows
      const nproc  = parseInt(process.env.KHY_ULIMIT_NPROC, 10)  || 1024;  // child processes (was 256)
      const vmemKB = parseInt(process.env.KHY_ULIMIT_VMEM, 10)   || 1048576; // 1GB virtual memory (was 512MB)
      const fd     = parseInt(process.env.KHY_ULIMIT_FD, 10)     || 512;   // file descriptors (was 256)
      const fsize  = parseInt(process.env.KHY_ULIMIT_FSIZE, 10)  || 204800; // 200MB max file size (was 100MB)
      const cpuSec = parseInt(process.env.KHY_ULIMIT_CPU, 10)    || 60;    // CPU seconds (was 30)

      const limits = [
        `ulimit -t ${cpuSec}`,
        `ulimit -v ${vmemKB}`,
        `ulimit -u ${nproc}`,
        `ulimit -f ${fsize}`,
        `ulimit -n ${fd}`,
      ].join(' 2>/dev/null; ');

      wrappedCommand = `bash -c '${limits}; ${command.replace(/'/g, "'\\''")}'`;
    }
  }

  try {
    const stdout = execSync(wrappedCommand, {
      encoding: 'utf-8',
      timeout,
      maxBuffer,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Ensure child is killed on timeout
      killSignal: 'SIGKILL',
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    if (err.killed) {
      return {
        stdout: (err.stdout || '').slice(0, 1000),
        stderr: `Command killed: exceeded ${timeout / 1000}s timeout or resource limit`,
        exitCode: 137,
      };
    }
    return {
      stdout: (err.stdout || '').slice(0, maxBuffer),
      stderr: (err.stderr || '').slice(0, 2000),
      exitCode: err.status || 1,
    };
  }
}

/**
 * Wrap a Promise with a timeout.
 * @param {Promise} promise
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [label] - Operation label for error message
 * @returns {Promise}
 */
function withTimeout(promise, ms, label = 'Operation') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    timer.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Wrap an async function so it can't run forever.
 * Returns a new function that automatically aborts after timeoutMs.
 */
function timeoutWrap(fn, timeoutMs = WATCHDOG_TIMEOUT_MS, label = '') {
  return async function (...args) {
    return withTimeout(fn(...args), timeoutMs, label || fn.name || 'async operation');
  };
}

// ── Active Operation Tracking ───────────────────────────────────────────

/**
 * Get list of currently active (in-progress) operations.
 */
function getActiveOperations() {
  return _operationStack
    .filter(op => !op.done)
    .map(op => ({
      name: op.name,
      elapsedMs: Date.now() - op.startTime,
      idleMs: Math.max(0, Date.now() - (op.lastActivityAt || op.startTime)),
      elapsedStr: `${((Date.now() - op.startTime) / 1000).toFixed(1)}s`,
    }));
}

/**
 * Cancel all active watchdogs (for graceful shutdown).
 */
function cancelAll() {
  for (const op of _operationStack) op.done = true;
  _operationStack = [];
  stopMemoryMonitor();
}

// ── System Resource Check ───────────────────────────────────────────────

/**
 * Quick system health check: RAM, CPU load, disk space.
 */
function systemHealthCheck() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const loadPercent = Math.round((loadAvg[0] / cpuCount) * 100);

  const warnings = [];

  if (memPercent > 90) {
    warnings.push(`系统内存使用过高: ${memPercent}% (${Math.round(freeMem / (1024 * 1024))} MB 可用)`);
  }
  if (loadPercent > 80) {
    warnings.push(`CPU 负载过高: ${loadPercent}% (1min avg: ${loadAvg[0].toFixed(1)})`);
  }

  // Check disk space (Linux/Mac only; skip on Windows)
  if (process.platform !== 'win32') {
    try {
      const df = execSync('df -h / 2>/dev/null | tail -1', { encoding: 'utf-8', timeout: 3000 });
      const parts = df.trim().split(/\s+/);
      const usePercent = parseInt(parts[4]) || 0;
      if (usePercent > 90) {
        warnings.push(`磁盘空间不足: 已用 ${usePercent}% (${parts[3]} 可用)`);
      }
    } catch { /* ignore */ }
  }

  return {
    healthy: warnings.length === 0,
    memPercent,
    loadPercent,
    warnings,
  };
}

// ── Process isolation limits ────────────────────────────────────────────

/**
 * Role-based default heap limits (MB) for forked agent processes.
 * @type {Record<string, number>}
 */
const ROLE_HEAP_DEFAULTS = {
  explore:  128,
  reviewer: 128,
  coder:    256,
  general:  256,
};

/**
 * Build `execArgv` and `env` options for `child_process.fork()` to enforce
 * per-process resource limits on a forked agent.
 *
 * @param {object} [opts]
 * @param {string} [opts.role='general'] - Agent role (used for default heap sizing)
 * @param {number} [opts.maxHeapMB] - Override max old-space heap (MB)
 * @param {number} [opts.threadPoolSize] - UV_THREADPOOL_SIZE for the child
 * @returns {{ execArgv: string[], env: Record<string, string> }}
 */
function createProcessLimits(opts = {}) {
  const role = String(opts.role || 'general').toLowerCase();
  const heap = opts.maxHeapMB || ROLE_HEAP_DEFAULTS[role] || 256;
  const threads = opts.threadPoolSize || 2;

  const execArgv = [
    `--max-old-space-size=${heap}`,
  ];

  const env = {
    ...process.env,
    UV_THREADPOOL_SIZE: String(threads),
    KHY_AGENT_ROLE: role,
    KHY_AGENT_HEAP_MB: String(heap),
  };

  return { execArgv, env };
}

module.exports = {
  // Watchdog
  startWatchdog,
  getActiveOperations,
  cancelAll,

  // Memory
  getMemoryUsage,
  checkMemoryPressure,
  startMemoryMonitor,
  stopMemoryMonitor,

  // Safe execution
  safeExec,
  withTimeout,
  timeoutWrap,

  // System health
  systemHealthCheck,

  // Process isolation
  createProcessLimits,

  // Constants
  WATCHDOG_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  SHELL_TIMEOUT_MS,
  SHELL_MAX_BUFFER,
};
