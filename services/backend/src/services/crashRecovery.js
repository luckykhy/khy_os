'use strict';

/**
 * crashRecovery.js — Unhandled rejection & exception recovery.
 *
 * Ported from OpenClaw's unhandled-rejections.ts.
 * Prevents CLI crashes from transient errors:
 *   - Network errors (ECONNRESET, ENOTFOUND, socket hang up, etc.)
 *   - SQLite errors (SQLITE_BUSY, database locked, etc.)
 *   - File watcher errors (ENOSPC + inotify)
 *   - AbortError (expected during shutdown)
 *
 * Decision tree:
 *   1. Custom handler returns true → suppress
 *   2. AbortError → warn, continue
 *   3. Fatal/config error → crash immediately
 *   4. Transient error → warn, continue
 *   5. Unknown → crash
 */

const { formatErrorMessage, formatUncaughtError, collectErrorCandidates, extractErrorCode } = require('./errorClassifier');

// ── Error Classification Constants ─────────────────────────────────

const FATAL_ERROR_CODES = new Set([
  'ERR_OUT_OF_MEMORY',
  'ERR_SCRIPT_EXECUTION_TIMEOUT',
  'ERR_WORKER_OUT_OF_MEMORY',
  'ERR_WORKER_UNCAUGHT_EXCEPTION',
  'ERR_WORKER_INITIALIZATION_FAILED',
]);

const CONFIG_ERROR_CODES = new Set([
  'INVALID_CONFIG',
  'MISSING_API_KEY',
  'MISSING_CREDENTIALS',
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_DNS_RESOLVE_FAILED', 'UND_ERR_CONNECT',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PROTOCOL_RETURNED_AN_ERROR',
]);

const TRANSIENT_NETWORK_NAMES = new Set([
  'AbortError', 'ConnectTimeoutError', 'HeadersTimeoutError',
  'BodyTimeoutError', 'TimeoutError',
]);

const TRANSIENT_NETWORK_SNIPPETS = [
  'getaddrinfo', 'socket hang up', 'network error', 'network is unreachable',
  'temporary failure in name resolution', 'upstream connect error',
  'disconnect/reset before headers', 'tlsv1 alert', 'ssl routines',
  'packet length too long', 'write eproto',
  'client network socket disconnected before secure tls connection was established',
];

const TRANSIENT_SQLITE_CODES = new Set([
  'SQLITE_BUSY', 'SQLITE_CANTOPEN', 'SQLITE_IOERR', 'SQLITE_LOCKED',
]);

const TRANSIENT_SQLITE_ERRCODES = new Set([5, 6, 10, 14]);

const TRANSIENT_SQLITE_SNIPPETS = [
  'unable to open database file', 'database is locked',
  'database table is locked', 'disk i/o error',
];

const BENIGN_CODES = new Set(['EPIPE', 'EIO']);

const BENIGN_EXCEPTION_CODES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND',
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_DNS_RESOLVE_FAILED', 'UND_ERR_CONNECT',
]);

// ── Transient Error Detection ──────────────────────────────────────

/**
 * Check if an error is a transient network error (safe to suppress).
 */
function isTransientNetworkError(err) {
  const candidates = collectErrorCandidates(err);
  for (const c of candidates) {
    const code = extractErrorCode(c);
    if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;

    const name = c?.name;
    if (typeof name === 'string' && TRANSIENT_NETWORK_NAMES.has(name)) return true;

    const msg = String(c?.message || '').toLowerCase();
    if (msg === 'fetch failed' || msg.endsWith(': fetch failed')) return true;
    for (const snippet of TRANSIENT_NETWORK_SNIPPETS) {
      if (msg.includes(snippet)) return true;
    }
  }
  return false;
}

/**
 * Check if an error is a transient SQLite error.
 */
function isTransientSqliteError(err) {
  const candidates = collectErrorCandidates(err);
  for (const c of candidates) {
    const code = extractErrorCode(c);
    if (code && TRANSIENT_SQLITE_CODES.has(code)) return true;
    if (typeof code === 'string' && code.startsWith('SQLITE_')) return true;

    // Check numeric errcode
    if (c && typeof c === 'object' && typeof c.errcode === 'number') {
      if (TRANSIENT_SQLITE_ERRCODES.has(c.errcode)) return true;
    }

    const msg = String(c?.message || '').toLowerCase();
    for (const snippet of TRANSIENT_SQLITE_SNIPPETS) {
      if (msg.includes(snippet)) return true;
    }
  }
  return false;
}

/**
 * Check if an error is a transient file watcher error.
 * Requires ENOSPC + inotify/watcher signal.
 */
function isTransientFileWatchError(err) {
  const candidates = collectErrorCandidates(err);
  for (const c of candidates) {
    const code = extractErrorCode(c);
    const msg = String(c?.message || '').toLowerCase();

    if (code === 'ENOSPC') {
      const watchSignals = ['inotify', 'watcher', 'file watcher', 'watch limit', 'max watches'];
      for (const sig of watchSignals) {
        if (msg.includes(sig)) return true;
      }
    }
    // Exhaustion messages
    if (msg.includes('inotify watches') || msg.includes('system limit for number of file watchers')) {
      return true;
    }
  }
  return false;
}

/**
 * Check if error is any kind of transient error (safe to suppress).
 */
function isTransientError(err) {
  return isTransientNetworkError(err) || isTransientSqliteError(err) || isTransientFileWatchError(err);
}

/**
 * Check if error is an AbortError (expected during shutdown).
 */
function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError') return true;
  if (err.message === 'This operation was aborted') return true;
  return false;
}

/**
 * Check if an uncaught exception is benign (safe to suppress).
 */
function isBenignUncaughtException(err) {
  const code = extractErrorCode(err);
  if (code && BENIGN_CODES.has(code)) return true;
  if (code && BENIGN_EXCEPTION_CODES.has(code)) return true;
  return false;
}

// ── Handler Registry ───────────────────────────────────────────────

// Use Symbol for cross-module handler sharing
const REJECTION_HANDLERS_KEY = Symbol.for('khy.unhandledRejection.handlers');
const EXCEPTION_HANDLERS_KEY = Symbol.for('khy.uncaughtException.handlers');

if (!globalThis[REJECTION_HANDLERS_KEY]) globalThis[REJECTION_HANDLERS_KEY] = new Set();
if (!globalThis[EXCEPTION_HANDLERS_KEY]) globalThis[EXCEPTION_HANDLERS_KEY] = new Set();

/**
 * Register a custom unhandled rejection handler.
 * Handler returns true to suppress the rejection.
 *
 * @param {(reason: unknown) => boolean} handler
 * @returns {() => void} Unregister function
 */
function registerRejectionHandler(handler) {
  globalThis[REJECTION_HANDLERS_KEY].add(handler);
  return () => globalThis[REJECTION_HANDLERS_KEY].delete(handler);
}

/**
 * Register a custom uncaught exception handler.
 */
function registerExceptionHandler(handler) {
  globalThis[EXCEPTION_HANDLERS_KEY].add(handler);
  return () => globalThis[EXCEPTION_HANDLERS_KEY].delete(handler);
}

function _isHandledBy(handlers, error) {
  for (const handler of handlers) {
    try {
      if (handler(error) === true) return true;
    } catch (e) {
      console.error('[CrashRecovery] Handler threw:', e);
    }
  }
  return false;
}

// ── Installation ───────────────────────────────────────────────────

let _installed = false;

/**
 * Install global unhandled rejection and uncaught exception handlers.
 * Call once at application startup.
 *
 * @param {object} [opts]
 * @param {object} [opts.logger] - Logger with .warn(), .error(), .fatal() methods
 * @param {function} [opts.onFatal] - Called before exit(1) for cleanup
 */
function install(opts = {}) {
  if (_installed) return;
  _installed = true;

  const logger = opts.logger || console;
  const onFatal = opts.onFatal || (() => {});

  process.on('unhandledRejection', (reason) => {
    // 1. Custom handler suppresses
    if (_isHandledBy(globalThis[REJECTION_HANDLERS_KEY], reason)) return;

    // 2. AbortError — expected during shutdown
    if (isAbortError(reason)) {
      logger.warn('[CrashRecovery] AbortError suppressed (expected during shutdown)');
      return;
    }

    const code = extractErrorCode(reason);

    // 3. Fatal — crash immediately
    if (code && FATAL_ERROR_CODES.has(code)) {
      logger.error(`[CrashRecovery] FATAL: ${formatUncaughtError(reason)}`);
      try { onFatal(reason); } catch {}
      process.exit(1);
      return;
    }

    // 4. Config error — crash with guidance
    if (code && CONFIG_ERROR_CODES.has(code)) {
      logger.error(`[CrashRecovery] CONFIG ERROR: ${formatErrorMessage(reason)}`);
      _logRemediation(logger, reason, '配置错误');
      try { onFatal(reason); } catch {}
      process.exit(1);
      return;
    }

    // 5. Transient — warn and continue
    if (isTransientError(reason)) {
      logger.warn(`[CrashRecovery] Transient error suppressed: ${formatErrorMessage(reason)}`);
      return;
    }

    // 6. Unknown — crash
    logger.error(`[CrashRecovery] Unhandled rejection: ${formatUncaughtError(reason)}`);
    _logRemediation(logger, reason, '未处理的 Promise 拒绝');
    try { onFatal(reason); } catch {}
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    // Custom handler
    if (_isHandledBy(globalThis[EXCEPTION_HANDLERS_KEY], error)) return;

    // Benign
    if (isBenignUncaughtException(error)) {
      logger.warn(`[CrashRecovery] Benign exception suppressed: ${formatErrorMessage(error)}`);
      return;
    }

    // Fatal
    const code = extractErrorCode(error);
    if (code && FATAL_ERROR_CODES.has(code)) {
      logger.error(`[CrashRecovery] FATAL EXCEPTION: ${formatUncaughtError(error)}`);
      try { onFatal(error); } catch {}
      process.exit(1);
      return;
    }

    // Transient
    if (isTransientError(error)) {
      logger.warn(`[CrashRecovery] Transient exception suppressed: ${formatErrorMessage(error)}`);
      return;
    }

    // Unknown
    logger.error(`[CrashRecovery] Uncaught exception: ${formatUncaughtError(error)}`);
    _logRemediation(logger, error, '未捕获异常');
    try { onFatal(error); } catch {}
    process.exit(1);
  });
}

/**
 * 崩溃前打印「怎么解决」——honor "crash with guidance"。
 * 复用 cliErrorDescriptor 的修复映射；任何失败都静默降级，绝不在崩溃路径上再抛异常。
 */
function _logRemediation(logger, err, contextLabel) {
  try {
    const { describeCliError } = require('./cliErrorDescriptor');
    const desc = describeCliError(err, { context: contextLabel });
    (desc.suggestions || []).forEach((s, i) => {
      logger.error(`[CrashRecovery] fix[${i + 1}]: ${s}`);
    });
  } catch { /* 兜底建议不可用时静默——主错误已记录 */ }
}

module.exports = {
  install,
  isTransientNetworkError,
  isTransientSqliteError,
  isTransientFileWatchError,
  isTransientError,
  isAbortError,
  isBenignUncaughtException,
  registerRejectionHandler,
  registerExceptionHandler,
  FATAL_ERROR_CODES,
  CONFIG_ERROR_CODES,
  TRANSIENT_NETWORK_CODES,
};
