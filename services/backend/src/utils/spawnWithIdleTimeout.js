/**
 * Spawn a child process with an activity-aware idle timeout.
 *
 * Unlike a hard wall-clock timeout that kills regardless of progress,
 * this helper resets its timer every time the child produces stdout or
 * stderr output. The child is only killed when it goes silent for
 * `idleMs` milliseconds — meaning it truly stalled.
 *
 * Rule 3 compliant: activity-based timeout, not hard deadline.
 */
'use strict';

const { spawn } = require('child_process');
const iconv = require('iconv-lite');
const { safeKill } = require('../tools/platformUtils');
const { getSystemEncoding } = require('./systemEncoding');

/**
 * Patterns that strongly indicate a child process has stopped to wait for
 * interactive keyboard input. In a non-interactive (headless) agent context
 * such a process will never receive an answer, so it would otherwise look like
 * a generic idle stall. Detecting it lets us emit a precise, actionable reason
 * instead of a silent "no output" kill.
 *
 * All patterns are anchored to the trailing text, where a prompt naturally sits.
 */
const INTERACTIVE_PROMPT_PATTERNS = [
  /\([yY]\s*\/\s*[nN]\)\s*[:?]?\s*$/, // (y/n)
  /\[[yY]\s*\/\s*[nN]\]\s*[:?]?\s*$/, // [Y/n]
  /\(?\s*yes\s*\/\s*no\s*\)?\s*[:?]?\s*$/i, // (yes/no)? / yes/no:
  /\b(?:password|passphrase)\b\s*[:：]\s*$/i,
  /\bare you sure\b/i,
  /\b(?:do you want to|would you like to)\b[^?]*\?\s*$/i,
  /\boverwrite\b[^?]*\?\s*$/i,
  /\bpress (?:any key|enter|return)\b/i,
  /\b(?:enter|type)\b[^.]*\bto continue\b/i,
  /\bproceed\b[^?]*\?\s*$/i,
  /\bcontinue\b\s*\?\s*$/i,
];

/**
 * Heuristically decide whether the recent output tail is an interactive prompt.
 * @param {string} text - recent stdout/stderr tail
 * @returns {boolean}
 */
function detectInteractivePrompt(text) {
  if (!text) return false;
  const tail = String(text).slice(-300);
  const lines = tail.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lastLine = lines.length ? lines[lines.length - 1] : tail;
  return INTERACTIVE_PROMPT_PATTERNS.some((re) => re.test(lastLine) || re.test(tail));
}

/**
 * Conservative OEM code-page candidates, tried in order when the system encoding
 * is undetectable (chcp probe failed → null) or was self-blinded to UTF-8 by our
 * own `chcp 65001` force. Covers the common East-Asian/Cyrillic OEM pages where
 * cmd built-ins (dir/ver/…) emit raw OEM bytes that UTF-8 cannot decode. Ordered
 * by global prevalence; the actual pick is whichever yields the FEWEST U+FFFD, so
 * order only breaks exact ties.
 */
const _OEM_FALLBACK_CANDIDATES = ['gbk', 'big5', 'shift_jis', 'cp949', 'cp866', 'cp1252'];

/**
 * Smart-decode Windows child output when the caller forced UTF-8 but that force
 * may not have taken effect.
 *
 * `_forceWindowsUtf8` prepends `chcp 65001` and declares outputEncoding:'utf-8',
 * but chcp does NOT reliably transcode the piped output of cmd built-ins such as
 * `dir` — those bytes stay in the OEM code page (GBK/CP936 on Chinese Windows).
 * Decoding them as UTF-8 yields U+FFFD mojibake (the user's「乱码」, e.g.
 * "������ D �еľ��� Data"), which hides real paths/errors from the agent.
 *
 * Strategy (zero-loss, conservative): decode the raw bytes as UTF-8 first; if the
 * result has no U+FFFD it WAS valid UTF-8 → return as-is (the common, fast case).
 * Only when replacement chars appear do we fall back. The fallback tries, in
 * order: (1) the explicitly-detected OEM page if any; (2) a conservative candidate
 * set — needed because forcing `chcp 65001` makes getSystemEncoding() report
 * 'utf-8' (self-blinding) or the probe may fail outright (null), in either case
 * leaving us no single OEM page to trust. We keep the decode with the FEWEST
 * U+FFFD and only if it strictly beats the UTF-8 reading, so a genuinely-UTF-8
 * stream is never corrupted by a misapplied OEM decode.
 *
 * @param {Buffer} buf
 * @param {string} [oemEncoding] — OEM code page to try FIRST (defaults to the
 *   detected system encoding; injectable so the fallback can be unit-tested off-Windows).
 * @returns {string}
 */
function smartDecodeWinOutput(buf, oemEncoding) {
  if (!buf || !buf.length) return '';
  const asUtf8 = buf.toString('utf8');
  if (!asUtf8.includes('�')) return asUtf8; // genuinely UTF-8 → unchanged
  const utf8Bad = (asUtf8.match(/�/g) || []).length;

  // Build the ordered candidate list: the explicitly-detected page first (if it
  // is a real OEM page, not utf-8), then the conservative fallback set. Dedupe
  // while preserving order so an explicit hint is tried before the generic set.
  const detected = oemEncoding || getSystemEncoding();
  const ordered = [];
  const seen = new Set();
  for (const enc of [detected, ..._OEM_FALLBACK_CANDIDATES]) {
    if (!enc) continue;
    const low = String(enc).toLowerCase();
    if (low === 'utf-8' || low === 'utf8' || seen.has(low)) continue;
    seen.add(low);
    ordered.push(low);
  }

  let best = asUtf8;
  let bestBad = utf8Bad;
  for (const enc of ordered) {
    try {
      if (!iconv.encodingExists(enc)) continue;
      const decoded = iconv.decode(buf, enc);
      const bad = (decoded.match(/�/g) || []).length;
      if (bad < bestBad) { best = decoded; bestBad = bad; }
      if (bestBad === 0) break; // perfect decode — stop early
    } catch { /* try next candidate */ }
  }
  return best;
}

/**
 * @param {string} command  — executable path
 * @param {string[]} args   — arguments
 * @param {object} opts
 * @param {number}  opts.idleMs       — idle threshold in ms (default 10000)
 * @param {object}  [opts.spawnOpts]  — options forwarded to child_process.spawn
 * @param {string}  [opts.label]      — human-readable label for timeout message
 * @param {number}  [opts.maxOutputBytes] — max bytes to keep for stdout/stderr each
 * @param {string}  [opts.outputEncoding] — force the decoding of child stdout/stderr
 *   to this encoding instead of auto-detecting the Windows system code page. Pass
 *   'utf-8' when the caller has forced the child console to UTF-8 (e.g. `chcp 65001`),
 *   so the auto-detected GBK/OEM decoder is not applied to bytes that are already UTF-8.
 * @param {Function} [opts.onActivity] — called on productive events
 * @param {Function} [opts.onStdoutChunk] — called on stdout chunk
 * @param {Function} [opts.onStderrChunk] — called on stderr chunk
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function spawnWithIdleTimeout(command, args, opts = {}) {
  const {
    idleMs = 10000,
    spawnOpts = {},
    label = 'child process',
    maxOutputBytes = null,
    outputEncoding = null,
    onActivity = null,
    onStdoutChunk = null,
    onStderrChunk = null,
    onChild = null,
  } = opts;

  // cmd.exe quoting fix (single source for every shell tool). When the
  // executable is cmd.exe, callers pass one pre-quoted command string as the
  // last arg (e.g. `mkdir "D:\path\to\dir"`). libuv would re-escape the embedded
  // double-quotes MSVCRT-style (`\"`), but cmd.exe does not understand `\"` — the
  // path then arrives as `\"D:\path\"`, whose literal `"` is an illegal filename
  // char → exit 1 "文件名、目录名或卷标语法不正确" (ERROR_INVALID_NAME). Passing the
  // arguments verbatim lets cmd.exe parse its own quotes correctly. PowerShell and
  // (MSYS) bash both decode libuv's `\"` fine, so this is scoped to cmd.exe only.
  const effectiveSpawnOpts = (() => {
    if (process.platform !== 'win32') return spawnOpts;
    if (Object.prototype.hasOwnProperty.call(spawnOpts, 'windowsVerbatimArguments')) return spawnOpts;
    const exe = String(command || '').toLowerCase().replace(/\\/g, '/');
    const base = exe.slice(exe.lastIndexOf('/') + 1);
    if (base === 'cmd.exe' || base === 'cmd') {
      return { ...spawnOpts, windowsVerbatimArguments: true };
    }
    return spawnOpts;
  })();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, effectiveSpawnOpts);
    } catch (err) {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`));
      return;
    }

    // Expose the freshly-spawned child to the caller (additive, opt-in). Lets a
    // background dispatcher retain a killable handle in its registry so a later
    // KillShell can terminate a still-running background command. Default null →
    // zero behavior change for every existing caller. Never allowed to throw.
    if (typeof onChild === 'function') {
      try { onChild(child); } catch { /* non-critical: caller bookkeeping */ }
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let idleTimer = null;
    let recentTail = '';
    const outputLimit = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
      ? Math.floor(maxOutputBytes)
      : null;

    // Windows non-UTF-8 consoles (e.g. GBK/CP936 on Chinese Windows) emit
    // command output and error text in the OEM code page. Decoding those bytes
    // as UTF-8 produces mojibake, which hides real errors (such as
    // "系统找不到指定的路径。") from the agent and prevents self-correction.
    // Detect the active code page once and stream-decode via iconv-lite, which
    // correctly handles multibyte characters split across chunk boundaries.
    // Unix, Windows-UTF8 (chcp 65001), and detection failure all keep the
    // original utf8 fast path unchanged (zero regression).
    // An explicit `outputEncoding` (caller forced the child to a known code page,
    // e.g. UTF-8 via `chcp 65001`) wins over runtime detection — deterministic and
    // immune to a mis-detected system code page. Otherwise auto-detect on Windows.
    const sysEnc = outputEncoding || (process.platform === 'win32' ? getSystemEncoding() : null);
    const useIconv = !!sysEnc && sysEnc !== 'utf-8' && sysEnc !== 'utf8'
      && iconv.encodingExists(sysEnc);
    const stdoutDecoder = useIconv ? iconv.getDecoder(sysEnc) : null;
    const stderrDecoder = useIconv ? iconv.getDecoder(sysEnc) : null;

    // Windows「强制 UTF-8 但不可信」修复：当 outputEncoding 被强制为 utf-8（_forceWindowsUtf8
    // 已 prepend `chcp 65001`）时，chcp 对 dir 等内建命令的管道输出并不可靠 → 字节仍是
    // GBK/OEM，被当 utf-8 解码就成 U+FFFD 乱码。这种情况下累积**原始字节**，到 close 智能解码
    // （先试 UTF-8，含替换符即回落系统 OEM 代码页）。仅此路径启用，其它路径字节级零改动。
    const smartWinUtf8 = process.platform === 'win32'
      && (outputEncoding === 'utf-8' || outputEncoding === 'utf8');
    const rawStdout = [];
    const rawStderr = [];
    let rawStdoutBytes = 0;
    let rawStderrBytes = 0;

    const appendCapped = (current, chunk, meta) => {
      const text = String(chunk || '');
      const buf = Buffer.from(text, 'utf8');
      if (!outputLimit) {
        meta.bytes += buf.length;
        return current + text;
      }
      if (meta.bytes >= outputLimit) {
        meta.truncated = true;
        return current;
      }
      const remaining = outputLimit - meta.bytes;
      if (buf.length <= remaining) {
        meta.bytes += buf.length;
        return current + text;
      }
      meta.bytes += remaining;
      meta.truncated = true;
      return current + buf.slice(0, remaining).toString('utf8');
    };

    const resetIdle = () => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const interactive = detectInteractivePrompt(recentTail);
        try { safeKill(child); } catch { /* already dead */ }
        if (typeof onActivity === 'function') {
          try { onActivity({ phase: 'idle_timeout', interactive, label }); } catch { /* non-critical */ }
        }
        const err = interactive
          ? new Error(
            `${label} 疑似等待交互输入（${idleMs / 1000}s 内无输出，且末尾检测到交互提示），` +
            `已终止：当前为非交互环境，无法应答。请改用非交互参数（如 -y/--yes/--non-interactive）后重试。`
          )
          : new Error(`${label} 空闲超时（${idleMs / 1000}s 内无输出），已终止`);
        err.interactive = interactive;
        err.idleTimeout = true;
        reject(err);
      }, idleMs);
    };

    // Start the idle clock
    resetIdle();
    if (typeof onActivity === 'function') {
      try { onActivity({ phase: 'spawn', label }); } catch { /* non-critical */ }
    }

    const stdoutMeta = {
      get bytes() { return stdoutBytes; },
      set bytes(v) { stdoutBytes = v; },
      get truncated() { return stdoutTruncated; },
      set truncated(v) { stdoutTruncated = v; },
    };
    const stderrMeta = {
      get bytes() { return stderrBytes; },
      set bytes(v) { stderrBytes = v; },
      get truncated() { return stderrTruncated; },
      set truncated(v) { stderrTruncated = v; },
    };

    // Unified data handler for both streams. When a decoder is present (Windows
    // non-UTF-8 path) the raw Buffer is stream-decoded first; otherwise the
    // stream has setEncoding('utf8') and `d` is already a string. Everything
    // downstream (capping, idle reset, chunk/activity callbacks) operates on the
    // decoded text so it is identical across both paths.
    const makeDataHandler = (decoder, meta, getAcc, setAcc, onChunk, phase, rawSink) => (d) => {
      // smartWinUtf8: stash the untouched bytes (capped) for a trustworthy decode at
      // close; the live text below stays best-effort utf8 for streaming/idle/tail.
      if (rawSink && Buffer.isBuffer(d)) rawSink(d);
      const text = decoder ? decoder.write(d) : String(d || '');
      if (text) {
        setAcc(appendCapped(getAcc(), text, meta));
        recentTail = (recentTail + text).slice(-500);
      }
      resetIdle();
      if (typeof onChunk === 'function') {
        try { onChunk(text); } catch { /* non-critical */ }
      }
      if (typeof onActivity === 'function') {
        try { onActivity({ phase, bytes: Buffer.byteLength(text, 'utf8'), label }); } catch { /* non-critical */ }
      }
    };

    // Raw-byte sink (smartWinUtf8 only): copy + cap to mirror the text cap, so the
    // final OEM/utf8 decision sees the same bounded byte window.
    const makeRawSink = (arr, getBytes, setBytes) => (buf) => {
      if (!smartWinUtf8) return;
      let chunk = buf;
      if (outputLimit) {
        if (getBytes() >= outputLimit) return;
        const remaining = outputLimit - getBytes();
        if (chunk.length > remaining) chunk = chunk.slice(0, remaining);
      }
      arr.push(Buffer.from(chunk)); // copy: the stream may reuse its buffer
      setBytes(getBytes() + chunk.length);
    };

    if (child.stdout) {
      if (!useIconv && !smartWinUtf8) child.stdout.setEncoding('utf8');
      child.stdout.on('data', makeDataHandler(
        stdoutDecoder, stdoutMeta,
        () => stdout, (v) => { stdout = v; },
        onStdoutChunk, 'stdout',
        makeRawSink(rawStdout, () => rawStdoutBytes, (v) => { rawStdoutBytes = v; }),
      ));
    }

    if (child.stderr) {
      if (!useIconv && !smartWinUtf8) child.stderr.setEncoding('utf8');
      child.stderr.on('data', makeDataHandler(
        stderrDecoder, stderrMeta,
        () => stderr, (v) => { stderr = v; },
        onStderrChunk, 'stderr',
        makeRawSink(rawStderr, () => rawStderrBytes, (v) => { rawStderrBytes = v; }),
      ));
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      reject(new Error(`${label} error: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      // Flush bytes buffered by the streaming decoders (trailing partial
      // multibyte sequences) before finalizing output.
      if (stdoutDecoder) {
        const tail = stdoutDecoder.end();
        if (tail) stdout = appendCapped(stdout, tail, stdoutMeta);
      }
      if (stderrDecoder) {
        const tail = stderrDecoder.end();
        if (tail) stderr = appendCapped(stderr, tail, stderrMeta);
      }
      // smartWinUtf8: the live `stdout`/`stderr` above are best-effort utf8 (may hold
      // U+FFFD). Replace them with a trustworthy decode of the captured raw bytes
      // (UTF-8, else OEM code page). Truncation flags carried from the byte cap so the
      // existing "[stdout truncated]" suffix below still applies.
      if (smartWinUtf8) {
        stdout = smartDecodeWinOutput(Buffer.concat(rawStdout));
        stderr = smartDecodeWinOutput(Buffer.concat(rawStderr));
        if (outputLimit) {
          if (rawStdoutBytes >= outputLimit) stdoutTruncated = true;
          if (rawStderrBytes >= outputLimit) stderrTruncated = true;
        }
      }
      if (typeof onActivity === 'function') {
        try { onActivity({ phase: 'close', code, label }); } catch { /* non-critical */ }
      }
      if (outputLimit) {
        if (stdoutTruncated) stdout += '\n... [stdout truncated]';
        if (stderrTruncated) stderr += '\n... [stderr truncated]';
      }
      resolve({ stdout, stderr, code });
    });
  });
}

module.exports = { spawnWithIdleTimeout, detectInteractivePrompt, smartDecodeWinOutput, INTERACTIVE_PROMPT_PATTERNS };
