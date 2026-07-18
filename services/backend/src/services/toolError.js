/**
 * ToolError — Standardized error model for tool execution failures.
 *
 * Provides structured error codes, recovery hints, and formatted output
 * for both human display and AI model consumption.
 *
 * Usage:
 *   const { ToolError, ERROR_CODES } = require('./toolError');
 *   throw new ToolError('TIMEOUT', 'Command timed out after 30s', {
 *     hint: 'Try a shorter command or increase timeout',
 *     retryable: true,
 *   });
 */

// ── Error Code Enum ────────────────────────────────────────────────

const ERROR_CODES = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TIMEOUT: 'TIMEOUT',
  INVALID_ARGS: 'INVALID_ARGS',
  TOOL_UNAVAILABLE: 'TOOL_UNAVAILABLE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  // A required external dependency (binary / package / browser) is missing.
  // Distinct from RESOURCE_NOT_FOUND so the agent loop can route it into the
  // interactive dependency self-healing flow instead of treating it as a plain
  // "file not found".
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
};

// Default recovery hints per error code
const DEFAULT_HINTS = {
  PERMISSION_DENIED: 'Approve the tool in the permission dialog or use --dangerous mode',
  TIMEOUT: 'Try a shorter-running operation or increase the timeout limit',
  INVALID_ARGS: 'Check parameter types and required fields against the tool schema',
  TOOL_UNAVAILABLE: 'Ensure the tool is registered and available in the current environment',
  NETWORK_ERROR: 'Check network connectivity; the operation can be retried',
  EXECUTION_ERROR: 'Review the error details and try a different approach',
  RESOURCE_NOT_FOUND: 'Verify the path/identifier exists before accessing it',
  MISSING_DEPENDENCY: 'A required dependency is not installed; confirm the install to self-heal, or install it manually',
};

// ── ToolError Class ────────────────────────────────────────────────

class ToolError extends Error {
  /**
   * @param {string} code - Error code from ERROR_CODES
   * @param {string} message - Human-readable error message
   * @param {object} [options]
   * @param {boolean} [options.recoverable=true] - Whether AI should try alternative approach
   * @param {string} [options.hint] - Recovery suggestion (defaults per code)
   * @param {boolean} [options.retryable=false] - Whether same call could succeed on retry
   * @param {Error} [options.originalError] - Wrapped original error
   * @param {object} [options.details] - Structured machine-readable context
   *   (e.g. { errno, syscall, path, exitCode }). Surfaced in toStructuredResult()
   *   as `error.details` ONLY when present, so the structured shape stays
   *   byte-identical for callers that never set it.
   */
  constructor(code, message, { recoverable = true, hint = '', retryable = false, originalError = null, details = null } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = ERROR_CODES[code] || ERROR_CODES.EXECUTION_ERROR;
    this.recoverable = recoverable;
    this.hint = hint || DEFAULT_HINTS[this.code] || '';
    this.retryable = retryable;
    this.originalError = originalError;
    this.details = details && typeof details === 'object' ? details : null;

    // Capture clean stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ToolError);
    }
  }

  /**
   * Convert to structured result object for tool execution pipeline.
   * @returns {{ success: false, error: { code, message, hint, recoverable, retryable, details? } }}
   */
  toStructuredResult() {
    const error = {
      code: this.code,
      message: this.message,
      hint: this.hint,
      recoverable: this.recoverable,
      retryable: this.retryable,
    };
    // Additive: only surface `details` when populated so the shape stays
    // byte-identical for the (overwhelming majority of) callers that don't set it.
    if (this.details != null) error.details = this.details;
    return { success: false, error };
  }

  /**
   * Format for AI model context — gives the model structured info to auto-recover.
   * @returns {string}
   */
  toAIContext() {
    const lines = [`[ERROR:${this.code}] ${this.message}`];
    if (this.hint) lines.push(`Hint: ${this.hint}`);
    lines.push(`Retryable: ${this.retryable ? 'yes' : 'no'}`);
    return lines.join('\n');
  }

  /**
   * Wrap a plain Error as an EXECUTION_ERROR ToolError.
   * Preserves original message and stack.
   * @param {Error} err
   * @param {object} [options] - Override hint/retryable
   * @returns {ToolError}
   */
  static fromGenericError(err, options = {}) {
    const code = _inferCodeFromError(err);
    return new ToolError(code, err.message || 'Unknown error', {
      recoverable: true,
      retryable: code === 'TIMEOUT' || code === 'NETWORK_ERROR',
      hint: options.hint || DEFAULT_HINTS[code] || '',
      originalError: err,
      details: options.details !== undefined ? options.details : _extractErrorDetails(err),
      ...options,
    });
  }

  /**
   * Type guard to check if an error is a ToolError instance.
   * @param {*} err
   * @returns {boolean}
   */
  static isToolError(err) {
    return err instanceof ToolError || !!(err && err.name === 'ToolError' && err.code in ERROR_CODES);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Attempt to infer a more specific error code from a generic Error.
 * @param {Error} err
 * @returns {string} ERROR_CODES key
 */
function _inferCodeFromError(err) {
  const msg = (err.message || '').toLowerCase();

  if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT' || msg.includes('timeout') || msg.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || msg.includes('network') || msg.includes('fetch failed')) {
    return 'NETWORK_ERROR';
  }
  // Missing dependency — only when the text explicitly points at an install
  // action. Kept narrow on purpose so a plain "File not found" (ENOENT) still
  // maps to RESOURCE_NOT_FOUND below (no regression).
  if (
    /\b(pip|npm|brew|apt-get|winget|rustup)\s+install\b/i.test(msg) ||
    /\bnpm i+\s+\w/i.test(msg) ||
    msg.includes('not installed') ||
    msg.includes('install with') ||
    /\binstall (puppeteer|playwright|ffmpeg|whisper|sox|python|torch)\b/i.test(msg)
  ) {
    return 'MISSING_DEPENDENCY';
  }
  if (err.code === 'ENOENT' || msg.includes('not found') || msg.includes('no such file')) {
    return 'RESOURCE_NOT_FOUND';
  }
  if (err.code === 'EACCES' || err.code === 'EPERM' || msg.includes('permission denied')) {
    return 'PERMISSION_DENIED';
  }
  if (msg.includes('invalid') || msg.includes('required') || msg.includes('missing parameter')) {
    return 'INVALID_ARGS';
  }

  return 'EXECUTION_ERROR';
}

/**
 * Extract structured, machine-readable fields from a generic Error so the
 * agent gets actionable context (not just a string). Pure: never throws,
 * returns null when there is nothing structured to report.
 * @param {Error} err
 * @returns {object|null}
 */
function _extractErrorDetails(err) {
  if (!err || typeof err !== 'object') return null;
  const details = {};
  for (const key of ['code', 'errno', 'syscall', 'path', 'exitCode', 'signal']) {
    if (err[key] !== undefined && err[key] !== null) details[key] = err[key];
  }
  if (err.name && err.name !== 'Error' && err.name !== 'ToolError') details.errorName = err.name;
  return Object.keys(details).length > 0 ? details : null;
}

// ── Exports ────────────────────────────────────────────────────────

module.exports = {
  ToolError,
  ERROR_CODES,
  DEFAULT_HINTS,
};
