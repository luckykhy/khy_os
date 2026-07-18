/**
 * Disk-backed task output — append-only log files for task stdout/stderr.
 *
 * Each task gets a dedicated output file at:
 *   <projectTmpDir>/tasks/<taskId>.output
 *
 * Design notes (from Claude Code's diskOutput.ts):
 *   - O_APPEND writes are atomic up to PIPE_BUF (4KB on Linux/macOS),
 *     so concurrent appends from the main thread and a watchdog are safe
 *     for typical line-buffered output.
 *   - A disk cap prevents runaway processes from filling the filesystem.
 *   - Reads support offset-based deltas so the UI can poll incrementally.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ──────────────────────────────────────────────────────────

/** Maximum output file size before truncation warning. */
const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const MAX_TASK_OUTPUT_DISPLAY = '5GB';

/** Default max bytes to read in a single tail/delta call. */
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024; // 8MB

// ── Output directory ───────────────────────────────────────────────────

let _taskOutputDir = null;

/**
 * Get the task output directory.
 *
 * Task logs can reach MAX_TASK_OUTPUT_BYTES (5GB), so they must stay OFF the
 * system drive when possible to avoid crashing the host. Resolution:
 *   1. KHY_TASK_OUTPUT_DIR (explicit override)
 *   2. storageRoots policy: largest-free non-system drive, else system default
 * preferCwd is false — bulk logs must not scatter into whatever directory the
 * user happens to be in. Session-stable once resolved.
 * @returns {string}
 */
function getTaskOutputDir() {
  if (!_taskOutputDir) {
    if (process.env.KHY_TASK_OUTPUT_DIR) {
      _taskOutputDir = process.env.KHY_TASK_OUTPUT_DIR;
    } else {
      try {
        const { resolveGeneratedFileDir } = require('../utils/storageRoots');
        _taskOutputDir = resolveGeneratedFileDir({ subdir: path.join('tmp', 'tasks'), preferCwd: false }).dir;
      } catch {
        _taskOutputDir = path.join(os.homedir(), '.khy', 'tmp', 'tasks');
      }
    }
  }
  return _taskOutputDir;
}

/**
 * Ensure the output directory exists. Idempotent.
 */
function ensureOutputDir() {
  const dir = getTaskOutputDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get the output file path for a given task ID.
 * @param {string} taskId
 * @returns {string}
 */
function getTaskOutputPath(taskId) {
  return path.join(getTaskOutputDir(), `${taskId}.output`);
}

// ── Write operations ───────────────────────────────────────────────────

/** Track total bytes written per task to enforce disk cap. */
const _bytesWritten = new Map();

/**
 * Append content to a task's output file.
 *
 * Creates the file on first write. Enforces the disk cap — once exceeded,
 * further writes are silently dropped and a truncation marker is appended.
 *
 * @param {string} taskId
 * @param {string} content
 */
function writeTaskOutput(taskId, content) {
  if (!content) return;

  const written = _bytesWritten.get(taskId) || 0;
  if (written > MAX_TASK_OUTPUT_BYTES) return; // already capped

  const newTotal = written + Buffer.byteLength(content, 'utf-8');

  try {
    ensureOutputDir();
    const outputPath = getTaskOutputPath(taskId);

    if (newTotal > MAX_TASK_OUTPUT_BYTES) {
      // Write truncation marker and stop
      fs.appendFileSync(outputPath,
        `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_DISPLAY} disk cap]\n`,
        'utf-8');
      _bytesWritten.set(taskId, newTotal);
      return;
    }

    fs.appendFileSync(outputPath, content, 'utf-8');
    _bytesWritten.set(taskId, newTotal);
  } catch (err) {
    // Best-effort — log and continue
    if (process.env.KHY_DEBUG) {
      console.error(`[diskOutput] write failed for ${taskId}:`, err.message);
    }
  }
}

/**
 * Async version of writeTaskOutput for larger payloads.
 * @param {string} taskId
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeTaskOutputAsync(taskId, content) {
  if (!content) return;

  const written = _bytesWritten.get(taskId) || 0;
  if (written > MAX_TASK_OUTPUT_BYTES) return;

  const newTotal = written + Buffer.byteLength(content, 'utf-8');

  try {
    ensureOutputDir();
    const outputPath = getTaskOutputPath(taskId);

    if (newTotal > MAX_TASK_OUTPUT_BYTES) {
      await fs.promises.appendFile(outputPath,
        `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_DISPLAY} disk cap]\n`,
        'utf-8');
      _bytesWritten.set(taskId, newTotal);
      return;
    }

    await fs.promises.appendFile(outputPath, content, 'utf-8');
    _bytesWritten.set(taskId, newTotal);
  } catch (err) {
    if (process.env.KHY_DEBUG) {
      console.error(`[diskOutput] async write failed for ${taskId}:`, err.message);
    }
  }
}

// ── Read operations ────────────────────────────────────────────────────

/**
 * Read task output from a given byte offset.
 *
 * Returns only the delta since the last read — callers track their own
 * offset to avoid re-reading the entire file on each poll.
 *
 * @param {string} taskId
 * @param {number} [fromOffset=0] - Byte offset to start reading from
 * @param {number} [maxBytes]     - Maximum bytes to read
 * @returns {{ content: string, newOffset: number }}
 */
function readTaskOutput(taskId, fromOffset = 0, maxBytes = DEFAULT_MAX_READ_BYTES) {
  try {
    const outputPath = getTaskOutputPath(taskId);
    if (!fs.existsSync(outputPath)) {
      return { content: '', newOffset: fromOffset };
    }

    const stat = fs.statSync(outputPath);
    if (stat.size <= fromOffset) {
      return { content: '', newOffset: fromOffset };
    }

    const readLength = Math.min(stat.size - fromOffset, maxBytes);
    const buffer = Buffer.alloc(readLength);
    const fd = fs.openSync(outputPath, 'r');

    try {
      const bytesRead = fs.readSync(fd, buffer, 0, readLength, fromOffset);
      return {
        content: buffer.slice(0, bytesRead).toString('utf-8'),
        newOffset: fromOffset + bytesRead,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { content: '', newOffset: fromOffset };
    }
    if (process.env.KHY_DEBUG) {
      console.error(`[diskOutput] read failed for ${taskId}:`, err.message);
    }
    return { content: '', newOffset: fromOffset };
  }
}

/**
 * Read the tail of a task's output file.
 *
 * @param {string} taskId
 * @param {number} [maxBytes] - Maximum bytes to return from the end
 * @returns {{ content: string, bytesTotal: number, bytesRead: number }}
 */
function tailTaskOutput(taskId, maxBytes = DEFAULT_MAX_READ_BYTES) {
  try {
    const outputPath = getTaskOutputPath(taskId);
    if (!fs.existsSync(outputPath)) {
      return { content: '', bytesTotal: 0, bytesRead: 0 };
    }

    const stat = fs.statSync(outputPath);
    const bytesTotal = stat.size;

    if (bytesTotal === 0) {
      return { content: '', bytesTotal: 0, bytesRead: 0 };
    }

    const readStart = Math.max(0, bytesTotal - maxBytes);
    const readLength = bytesTotal - readStart;
    const buffer = Buffer.alloc(readLength);
    const fd = fs.openSync(outputPath, 'r');

    try {
      const bytesRead = fs.readSync(fd, buffer, 0, readLength, readStart);
      let content = buffer.slice(0, bytesRead).toString('utf-8');

      if (bytesTotal > bytesRead) {
        const omittedKB = Math.round((bytesTotal - bytesRead) / 1024);
        content = `[${omittedKB}KB of earlier output omitted]\n${content}`;
      }

      return { content, bytesTotal, bytesRead };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { content: '', bytesTotal: 0, bytesRead: 0 };
    }
    if (process.env.KHY_DEBUG) {
      console.error(`[diskOutput] tail failed for ${taskId}:`, err.message);
    }
    return { content: '', bytesTotal: 0, bytesRead: 0 };
  }
}

/**
 * Get current size of a task's output file.
 * @param {string} taskId
 * @returns {number}
 */
function getTaskOutputSize(taskId) {
  try {
    const outputPath = getTaskOutputPath(taskId);
    if (!fs.existsSync(outputPath)) return 0;
    return fs.statSync(outputPath).size;
  } catch {
    return 0;
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────

/**
 * Initialize an empty output file for a new task.
 * @param {string} taskId
 * @returns {string} The output file path
 */
function initTaskOutput(taskId) {
  ensureOutputDir();
  const outputPath = getTaskOutputPath(taskId);
  fs.writeFileSync(outputPath, '', 'utf-8');
  _bytesWritten.set(taskId, 0);
  return outputPath;
}

/**
 * Clean up a task's output file and tracking state.
 * @param {string} taskId
 */
function cleanupTaskOutput(taskId) {
  _bytesWritten.delete(taskId);
  try {
    const outputPath = getTaskOutputPath(taskId);
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && process.env.KHY_DEBUG) {
      console.error(`[diskOutput] cleanup failed for ${taskId}:`, err.message);
    }
  }
}

/**
 * Reset the output directory path (for testing).
 */
function _resetOutputDir() {
  _taskOutputDir = null;
  _bytesWritten.clear();
}

module.exports = {
  MAX_TASK_OUTPUT_BYTES,
  MAX_TASK_OUTPUT_DISPLAY,
  DEFAULT_MAX_READ_BYTES,
  getTaskOutputDir,
  getTaskOutputPath,
  writeTaskOutput,
  writeTaskOutputAsync,
  readTaskOutput,
  tailTaskOutput,
  getTaskOutputSize,
  initTaskOutput,
  cleanupTaskOutput,
  _resetOutputDir,
};
