/**
 * Synchronized Output — 防止终端渲染撕裂
 *
 * 实现 "Synchronized Output" 协议 (DEC Private Mode 2026)：
 *   ESC[?2026h  — 开始同步帧（终端缓冲后续写入）
 *   ESC[?2026l  — 结束同步帧（终端一次性刷新）
 *
 * 支持终端：WezTerm, iTerm2, Kitty, foot, Contour, Windows Terminal (canary)
 * 不支持的终端会忽略这些序列（无副作用）。
 *
 * 用法：
 *   const { syncWrite, beginSync, endSync } = require('./syncOutput');
 *   syncWrite(() => {
 *     process.stdout.write(line1);
 *     process.stdout.write(line2);
 *   });
 *
 * 参考：Qwen Code synchronizedOutput.ts
 */
'use strict';

const BEGIN = '\x1b[?2026h';
const END   = '\x1b[?2026l';

let _enabled = null; // lazy detect

/**
 * Check if terminal likely supports Synchronized Output.
 * Conservative: only enable for known-good terminals.
 */
function isSupported() {
  if (_enabled !== null) return _enabled;

  // Non-TTY: no sync needed
  if (!process.stdout.isTTY) {
    _enabled = false;
    return false;
  }

  // Explicit override
  const envFlag = String(process.env.KHY_SYNC_OUTPUT || '').toLowerCase();
  if (envFlag === '0' || envFlag === 'false' || envFlag === 'off') {
    _enabled = false;
    return false;
  }
  if (envFlag === '1' || envFlag === 'true' || envFlag === 'on') {
    _enabled = true;
    return true;
  }

  // Auto-detect by TERM_PROGRAM / terminal signatures
  const term = String(process.env.TERM_PROGRAM || '').toLowerCase();
  const termExtra = String(process.env.TERMINAL_EMULATOR || '').toLowerCase();
  const wt = process.env.WT_SESSION; // Windows Terminal

  _enabled = (
    term.includes('wezterm') ||
    term.includes('iterm') ||
    term === 'kitty' ||
    term === 'foot' ||
    term === 'contour' ||
    termExtra.includes('jetbrains') ||
    !!wt
  );

  return _enabled;
}

/**
 * Write BEGIN sync frame marker.
 */
function beginSync() {
  if (isSupported()) {
    process.stdout.write(BEGIN);
  }
}

/**
 * Write END sync frame marker.
 */
function endSync() {
  if (isSupported()) {
    process.stdout.write(END);
  }
}

// ── Write coalescing ─────────────────────────────────────────────────────────
// On legacy Windows conhost, isSupported() is false so the DEC-2026 markers are
// never emitted — and historically syncWrite() then ran fn() with no batching at
// all, so a block of N console.log() calls became N separate synchronous
// WriteConsole() syscalls. That is the primary "Windows easily freezes" cause:
// each console write blocks, and rendering a panel / streamed text fires dozens.
//
// We fix it at the shared primitive: inside a syncWrite() frame we transparently
// capture every process.stdout.write (console.log routes through it) into one
// buffer and flush it as a SINGLE write on frame close. This makes the slow path
// O(1) syscalls regardless of terminal, and is a strict improvement on the fast
// path too. Nesting is reference-counted so only the outermost frame flushes.
let _coalesceDepth = 0;
let _coalesceChunks = null;
let _realStdoutWrite = null;

function _beginCoalesce() {
  if (_coalesceDepth === 0) {
    _coalesceChunks = [];
    // Store the EXACT original reference (no .bind) so the outermost restore puts
    // process.stdout.write back byte-identical — never shadowing another patcher.
    _realStdoutWrite = process.stdout.write;
    const real = _realStdoutWrite;
    // Capture writes; honor the (chunk, [encoding], [callback]) contract so any
    // caller-supplied completion callback still fires once we flush.
    process.stdout.write = function (chunk, encoding, callback) {
      const cb = typeof encoding === 'function' ? encoding : callback;
      try {
        _coalesceChunks.push(typeof chunk === 'string' ? chunk : chunk.toString(
          typeof encoding === 'string' ? encoding : undefined,
        ));
      } catch {
        // Non-stringifiable chunk: fall back to a direct passthrough write.
        return real.call(process.stdout, chunk, encoding, callback);
      }
      if (typeof cb === 'function') { try { cb(); } catch { /* ignore */ } }
      return true;
    };
  }
  _coalesceDepth += 1;
}

function _endCoalesce() {
  _coalesceDepth -= 1;
  if (_coalesceDepth > 0) return;
  // Outermost frame: restore the real write and flush everything at once.
  const restore = _realStdoutWrite;
  const chunks = _coalesceChunks;
  process.stdout.write = restore;
  _coalesceChunks = null;
  _realStdoutWrite = null;
  if (restore && chunks && chunks.length) {
    restore.call(process.stdout, chunks.join(''));
  }
}

/**
 * Execute a function inside a synchronized frame.
 *
 * Two layers of batching:
 *  1. DEC-2026 BEGIN/END markers (terminals that support it buffer + flush atomically).
 *  2. Always-on stdout coalescing — all writes inside `fn` are joined into a single
 *     process.stdout.write on close, even when the terminal ignores the markers.
 *
 * `fn` MUST be synchronous: writes are captured only for the duration of the call,
 * so any deferred/async write would land after the frame closes (unbatched).
 *
 * @param {Function} fn — sync function containing stdout writes
 */
function syncWrite(fn) {
  beginSync();
  _beginCoalesce();
  try {
    fn();
  } finally {
    _endCoalesce();
    endSync();
  }
}

module.exports = { isSupported, beginSync, endSync, syncWrite };
