'use strict';

/**
 * toolLoopDetector.js — 9-detector tool loop detection system.
 *
 * Ported from OpenClaw's tool-loop-detection.ts concept with KHY-specific tuning,
 * enhanced with Qwen Code-inspired detectors 6-8, plus shell intent detector 9.
 *
 * Detectors:
 *   1. genericRepeat     — Same tool+params hash appears repeatedly
 *   2. unknownToolRepeat — Model repeatedly calls non-existent tools
 *   3. noProgressStreak  — Same tool+params+result hash (output unchanged)
 *   4. pingPong          — Two tools alternate without progress
 *   5. circuitBreaker    — Global call count hard limit
 *   6. contentChanting   — AI output text loops (same fragment repeated)
 *   7. readFileLoop      — Excessive read-like tool calls (with cold-start gate)
 *   8. actionStagnation  — Same tool name repeatedly (regardless of params)
 *   9. shellIntentRepeat — Same shell command intent with different syntax
 *  10. pathIntentRepeat  — Same filesystem path accessed across different tools/syntax
 *  11. webRetrievalFailureStreak — Consecutive FAILED web fetches across different
 *      tools (the "death-grip" thrash); steers back to the optimal WebSearch path
 *
 * Severity levels: 'ok' → 'warning' → 'critical' → 'circuit_breaker'
 */

const { fnv1aHash } = require('./contextWasm');

// ── Defaults ────────────────────────────────────────────────────────

// Global runaway backstop. This is NOT the primary loop guard — the 10 other
// detectors catch genuine repetition (identical calls, no-progress, ping-pong,
// stagnation) at thresholds of 3–8. The circuit breaker only stops a process
// that keeps issuing *distinct* calls without ever converging, so it must sit
// well above the volume of a legitimate multi-step exploration. 12 was far too
// low: a normal codebase sweep easily makes 20–40 distinct read/glob/grep
// calls and would trip it mid-task. Env-overridable for unusually large tasks.
const _envCircuitBreaker = Number.parseInt(
  process.env.KHY_TOOL_CIRCUIT_BREAKER_THRESHOLD || '', 10,
);
const CIRCUIT_BREAKER_THRESHOLD =
  Number.isFinite(_envCircuitBreaker) && _envCircuitBreaker > 0
    ? _envCircuitBreaker
    : 50;

const DEFAULT_CONFIG = {
  historySize: 30,
  warningThreshold: 3,
  criticalThreshold: 8,
  circuitBreakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
  unknownToolThreshold: 3,
  noProgressWarning: 3,
  noProgressCritical: 5,
  pingPongThreshold: 4,
  // Detector 6: content chanting
  contentChunkSize: 50,
  contentChantThreshold: 8,
  contentMaxBuffer: 1000,
  // Detector 7: read-file loop
  readFileWindow: 15,
  readFileThreshold: 8,
  // Detector 8: action stagnation
  stagnationThreshold: 5,
  stagnationCriticalThreshold: 8,
  // Detector 9: shell intent repeat
  shellIntentWarning: 2,
  shellIntentCritical: 3,
  // Detector 10: path intent repeat (cross-tool same-path detection)
  pathIntentWarning: 2,
  pathIntentCritical: 3,
  // Detector 11: web-retrieval failure streak (cross-tool 死缠烂打)
  webFailWarning: 3,
  webFailCritical: 4,
};

// ── Read-like tool classification ───────────────────────────────────

const READ_LIKE_EXACT = new Set([
  'read_file', 'readfile', 'read_many_files', 'readmanyfiles',
  'list_directory', 'listdirectory', 'listdir',
]);

function _isReadLikeTool(name) {
  const norm = _normalizeName(name);
  if (READ_LIKE_EXACT.has(norm)) return true;
  // Prefix match: read_*, list_* (but not "review", "listener", etc.)
  const lower = String(name).toLowerCase();
  return lower.startsWith('read_') || lower.startsWith('list_');
}

// ── Shell tool classification & intent extraction ───────────────────

const SHELL_TOOLS = new Set([
  'shellcommand', 'bash', 'executecommand', 'runcommand', 'terminal', 'exec',
]);

function _isShellTool(name) {
  return SHELL_TOOLS.has(_normalizeName(name));
}

// ── Filesystem tool classification & path intent extraction ─────────

const FS_TOOLS = new Set([
  'ls', 'listdirectory', 'listdir', 'readfile', 'readmanyfiles',
  'glob', 'searchfiles', 'searchfile', 'findfile', 'findfiles',
  'writefile', 'editfile', 'createfile',
]);

function _isFsTool(name) {
  return FS_TOOLS.has(_normalizeName(name));
}

// ── Web-retrieval tool classification (Detector 11) ─────────────────
// 网络获取家族：搜索 / 抓取 / 浏览器，外加 shell 里的网络命令（curl/wget）。
// 这些工具语义同质——都为"从网络取回内容"——但工具名/参数各异，会逃过
// genericRepeat / actionStagnation / shellIntent / pathIntent 全部既有探测器。
// 「死缠烂打」正是在它们之间反复横跳（WebFetch→curl→WebSearch→browser）。
const WEB_TOOLS = new Set([
  'webfetch', 'webfetchtool', 'fetchurl', 'curl',
  'websearch', 'websearchtool', 'searchweb',
  'webbrowser', 'webbrowsertool', 'browser',
  'datafetch', 'httprequest', 'wget',
]);

function _isWebTool(name) {
  if (WEB_TOOLS.has(_normalizeName(name))) return true;
  // shell 工具携带 curl/wget 命令时也算网络获取（在 recordCall 里按 command 判定）
  return false;
}

// 关键词搜索类工具（与 WEB_TOOLS 的 URL 抓取区分开）。这些工具吃的是
// 自然语言查询串而非 URL，所以去重要按「关键词集合」而非路径/URL 归一。
// 故意收窄：只认明确的网络搜索工具名，不收 bare "search"（可能是代码检索 grep/glob）。
const SEARCH_TOOLS = new Set([
  'websearch', 'websearchtool', 'searchweb', 'webquery', 'searchengine',
]);

function _isSearchTool(name) {
  return SEARCH_TOOLS.has(_normalizeName(name));
}

/** shell 命令是否本质上是一次网络获取（curl/wget/Invoke-WebRequest 等）。*/
function _shellCommandIsWebFetch(command) {
  if (!command || typeof command !== 'string') return false;
  return /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|http\s+(get|post)|lynx|links|w3m)\b/i.test(command);
}

/**
 * Extract a normalized path from any filesystem tool's params.
 * Works for LS, read_file, write_file, glob, etc.
 *
 * @param {string} toolName
 * @param {object} params
 * @returns {string|null} normalized path or null
 */
function extractPathIntent(toolName, params) {
  if (!params || typeof params !== 'object') return null;

  // Extract raw path from various param field names
  const rawPath = params.path || params.file_path || params.filePath
    || params.dir || params.directory || params.folder
    || params.pattern || params.glob_pattern
    || null;

  if (!rawPath || typeof rawPath !== 'string') return null;

  return _normalizePath(rawPath);
}

/**
 * Normalize a filesystem path, stripping platform-specific prefixes.
 * Same logic as extractShellIntent's target normalization.
 *
 * @param {string} rawPath
 * @returns {string} normalized path
 */
function _normalizePath(rawPath) {
  return rawPath
    .replace(/^['"`]+|['"`]+$/g, '')                 // strip quotes
    .replace(/^~[/\\]?/i, '')                        // ~ → empty
    .replace(/^\/c\/Users\/[^/]+\/?/i, '')           // /c/Users/xxx/ → empty (Git Bash)
    .replace(/^[A-Z]:\\Users\\[^\\]+\\?/i, '')       // C:\Users\xxx\ → empty (Windows)
    .replace(/^%USERPROFILE%[/\\]?/i, '')            // %USERPROFILE% → empty
    .replace(/^\/home\/[^/]+\/?/i, '')               // /home/xxx/ → empty (Linux)
    .replace(/[/\\]+/g, '/')                         // normalize slashes
    .replace(/\/+$/, '')                             // strip trailing slash
    .trim()
    .toLowerCase();
}

/**
 * Extract a normalized "intent fingerprint" from a shell command.
 * Maps syntactically different but semantically identical commands to the same key.
 *
 * Examples that all map to "ls:desktop/":
 *   ls ~/Desktop/
 *   ls /c/Users/25789/Desktop/
 *   ls C:\Users\25789\Desktop
 *   ls ~/Desktop/ 2>/dev/null || ls /c/Users/25789/Desktop/ 2>/dev/null
 *
 * @param {string} command
 * @returns {string|null}
 */
function extractShellIntent(command) {
  if (!command || typeof command !== 'string') return null;
  const cmd = command.trim();
  if (!cmd) return null;

  // 1. Extract base command (first word, strip path prefix)
  const baseCmd = cmd.split(/[\s|;&]/)[0].replace(/^.*[/\\]/, '').toLowerCase();
  if (!baseCmd) return null;

  // 2. Extract target path, normalize away platform differences
  const target = cmd
    .replace(/^[^\s]+\s*/, '')                      // strip command itself
    .replace(/\s*2>\s*[^\s]*/g, '')                  // strip redirections (2>/dev/null, 2>NUL)
    .replace(/\s*\|\|.*$/g, '')                      // strip || fallback chains
    .replace(/\s*&&.*$/g, '')                        // strip && chains
    .replace(/\s*\|.*$/g, '')                        // strip pipe chains
    .replace(/^['"`]+|['"`]+$/g, '')                 // strip surrounding quotes
    .replace(/^~[/\\]?/i, '')                        // ~ → empty
    .replace(/^\/c\/Users\/[^/]+\/?/i, '')           // /c/Users/xxx/ → empty (Git Bash style)
    .replace(/^[A-Z]:\\Users\\[^\\]+\\?/i, '')       // C:\Users\xxx\ → empty (Windows native)
    .replace(/^%USERPROFILE%[/\\]?/i, '')            // %USERPROFILE%\ → empty
    .replace(/^\/home\/[^/]+\/?/i, '')               // /home/xxx/ → empty (Linux)
    .replace(/[/\\]+/g, '/')                         // normalize all slashes
    .replace(/\/+$/, '')                             // strip trailing slash
    .trim()
    .toLowerCase();

  return `${baseCmd}:${target}`;
}

// Function words stripped before computing a search-intent signature, so that
// surface reformulations ("weather in Tokyo today" vs "today's Tokyo weather")
// collapse to the same keyword set while genuinely different searches do not.
// Kept deliberately small/generic — only words that carry no search selectivity.
const SEARCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'was', 'were', 'be', 'as', 'by', 'at', 'with', 'that', 'this', 'it', 'from',
  'how', 'what', 'when', 'where', 'why', 'who', 'which', 'do', 'does', 'did',
  'can', 'could', 'i', 'me', 'my', 'please', 'find', 'search', 'about',
  'latest', 'current', 'now', 'today', 's',
]);

/**
 * Extract a normalized, order-independent "search intent" signature from a
 * search tool's params. Two queries map to the same signature only when their
 * meaningful keyword SETS are identical, so reformulations of the same search
 * dedup while distinct searches (different keywords) never collide.
 *
 * Deliberately conservative — punctuation/stopwords stripped, remaining tokens
 * de-duplicated and sorted. Returns null when no meaningful keyword survives
 * (so an empty/stopword-only query is never treated as a repeat).
 *
 * @param {object} params
 * @returns {string|null} space-joined sorted keyword set, or null
 */
function extractSearchIntent(params) {
  if (!params || typeof params !== 'object') return null;
  const raw = params.query || params.q || params.search
    || params.keyword || params.keywords || params.text || null;
  if (!raw || typeof raw !== 'string') return null;

  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')   // strip punctuation, keep unicode letters/digits
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !SEARCH_STOPWORDS.has(t));

  if (tokens.length === 0) return null;

  // Order-independent: unique keyword set, sorted, joined.
  return Array.from(new Set(tokens)).sort().join(' ');
}

// ── Structural content filters (for chanting false-positive prevention) ──

const STRUCTURAL_PATTERNS = [
  /```/,                           // code fence
  /(^|\n)\s*(\|.*\||[|+-]{3,})/,  // table
  /(^|\n)\s*[*\-+]\s/,            // unordered list
  /(^|\n)\s*\d+\.\s/,             // ordered list
  /(^|\n)#+\s/,                   // heading
  /(^|\n)>\s/,                    // blockquote
];

// ── Name normalization (consistent with repl.js _formatToolResult) ───

function _normalizeName(name) {
  // Normalize aggressively so variants like:
  //   shell_command / shell-command / shellCommand / shell_command(...)
  // map to the same token and avoid false "unknown tool" loops.
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Stable hash helper ──────────────────────────────────────────────

function stableStringify(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => `${k}:${stableStringify(obj[k])}`).join(',') + '}';
}

function hashCall(toolName, params) {
  return fnv1aHash(`${toolName}|${stableStringify(params)}`);
}

// Public, stable signature for a (toolName, params) pair — a thin wrapper over
// the private hashCall so EXTERNAL callers (the cross-turn dedup guard in
// toolUseLoop + its TUI/REPL signature harvesters) compute byte-identical-intent
// keys with the SAME logic the in-turn detector uses. stableStringify is
// key-order independent, so reordered params still collapse to one signature.
function toolCallSignature(toolName, params) {
  return hashCall(String(toolName || ''), params);
}

function hashResult(result) {
  if (!result) return '0';
  const key = result.success
    ? (result.output || result.content || result.result || 'ok')
    : (result.error || 'fail');
  return fnv1aHash(typeof key === 'string' ? key : stableStringify(key));
}

// ── Detector class ──────────────────────────────────────────────────

class ToolLoopDetector {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.history = [];       // ToolCallRecord[]
    this.totalCalls = 0;
    this.unknownToolCount = 0;

    // Track registered tool names for unknown-tool detection
    this._knownTools = new Set();

    // Detector 6: content chanting
    this._contentBuffer = '';
    this._contentHashes = new Map();  // hash → position[]
    this._contentLastIdx = 0;
    this._inCodeBlock = false;

    // Detector 7: read-file loop
    this._recentToolNames = [];
    this._hasSeenNonReadTool = false;

    // Detector 8: action stagnation
    this._lastToolName = null;
    this._sameNameStreak = 0;
  }

  /**
   * Register known tool names so we can detect unknown tool calls.
   * @param {Iterable<string>} names
   */
  registerTools(names) {
    for (const n of names) {
      this._knownTools.add(n);
      this._knownTools.add(_normalizeName(n));
    }
  }

  /**
   * Record a tool call (before execution).
   * @param {string} toolName
   * @param {object} params
   */
  recordCall(toolName, params) {
    const callHash = hashCall(toolName, params);
    const isUnknown = this._knownTools.size > 0
      && !this._knownTools.has(toolName)
      && !this._knownTools.has(_normalizeName(toolName));

    this.history.push({
      toolName,
      callHash,
      resultHash: null,
      isUnknown,
      _shellIntent: _isShellTool(toolName) ? extractShellIntent((params || {}).command || (params || {}).cmd) : null,
      _pathIntent: _isFsTool(toolName) ? extractPathIntent(toolName, params) : null,
      // Detector 11: web-retrieval thrash — flag any call that fetches the web,
      // whether a dedicated web tool or a shell command wrapping curl/wget/iwr.
      _isWeb: _isWebTool(toolName)
        || (_isShellTool(toolName) && _shellCommandIsWebFetch((params || {}).command || (params || {}).cmd)),
      _failed: null,  // set in recordOutcome once execution result is known
      timestamp: Date.now(),
    });

    this.totalCalls++;
    if (isUnknown) this.unknownToolCount++;

    // Update detector 7 (read-file loop) state
    this._recentToolNames.push(toolName);
    while (this._recentToolNames.length > this.config.readFileWindow) {
      this._recentToolNames.shift();
    }
    if (!this._hasSeenNonReadTool && !_isReadLikeTool(toolName)) {
      this._hasSeenNonReadTool = true;
    }

    // Update detector 8 (action stagnation) state
    const normName = _normalizeName(toolName);
    if (normName === _normalizeName(this._lastToolName || '')) {
      this._sameNameStreak++;
    } else {
      this._lastToolName = toolName;
      this._sameNameStreak = 1;
    }

    // Reset content tracking on tool call (AI producing tool calls, not text)
    this._contentBuffer = '';
    this._contentHashes.clear();
    this._contentLastIdx = 0;

    // Keep history bounded
    while (this.history.length > this.config.historySize) {
      const removed = this.history.shift();
      if (removed.isUnknown) this.unknownToolCount--;
    }
  }

  /**
   * Record tool execution outcome (after execution).
   * @param {string} toolName
   * @param {object} params
   * @param {object} result
   */
  recordOutcome(toolName, params, result) {
    const callHash = hashCall(toolName, params);
    const rHash = hashResult(result);

    // Find the most recent matching call record and attach the result hash
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].callHash === callHash && this.history[i].resultHash === null) {
        this.history[i].resultHash = rHash;
        // Detector 11: mark web-retrieval failures so the thrash detector can
        // count consecutive failed fetches across different tools.
        this.history[i]._failed = !(result && result.success === true);
        break;
      }
    }
  }

  /**
   * Check all 8 detectors before executing a tool call.
   * @param {string} toolName
   * @param {object} params
   * @returns {{ stuck: boolean, level: string, detector: string, message: string }}
   */
  check(toolName, params) {
    const results = [
      this._checkCircuitBreaker(),
      this._checkGenericRepeat(toolName, params),
      this._checkUnknownTool(toolName),
      this._checkNoProgress(toolName, params),
      this._checkPingPong(toolName),
      this._checkContentChanting(),
      this._checkReadFileLoop(),
      this._checkActionStagnation(),
      this._checkShellIntentRepeat(toolName, params),
      this._checkPathIntentRepeat(toolName, params),
      this._checkWebRetrievalFailureStreak(toolName, params),
    ];

    // Return the most severe detection
    const SEVERITY = { ok: 0, warning: 1, critical: 2, circuit_breaker: 3 };
    let worst = { stuck: false, level: 'ok', detector: 'none', message: '' };

    for (const r of results) {
      if (SEVERITY[r.level] > SEVERITY[worst.level]) {
        worst = r;
      }
    }

    return worst;
  }

  /**
   * Reset all state.
   */
  reset() {
    this.history = [];
    this.totalCalls = 0;
    this.unknownToolCount = 0;
    // Detector 6
    this._contentBuffer = '';
    this._contentHashes.clear();
    this._contentLastIdx = 0;
    this._inCodeBlock = false;
    // Detector 7
    this._recentToolNames = [];
    this._hasSeenNonReadTool = false;
    // Detector 8
    this._lastToolName = null;
    this._sameNameStreak = 0;
  }

  // ── Individual detectors ──────────────────────────────────────────

  _checkCircuitBreaker() {
    if (this.totalCalls >= this.config.circuitBreakerThreshold) {
      return {
        stuck: true,
        level: 'circuit_breaker',
        detector: 'circuitBreaker',
        message: `Circuit breaker tripped: ${this.totalCalls} total tool calls (limit: ${this.config.circuitBreakerThreshold}).`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'circuitBreaker', message: '' };
  }

  _checkGenericRepeat(toolName, params) {
    const callHash = hashCall(toolName, params);
    let count = 0;
    for (const rec of this.history) {
      if (rec.callHash === callHash) count++;
    }

    if (count >= this.config.criticalThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'genericRepeat',
        message: `Tool "${toolName}" called ${count} times with identical params (critical threshold: ${this.config.criticalThreshold}).`,
      };
    }
    if (count >= this.config.warningThreshold) {
      return {
        stuck: false,
        level: 'warning',
        detector: 'genericRepeat',
        message: `Tool "${toolName}" called ${count} times with identical params. Consider a different approach.`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'genericRepeat', message: '' };
  }

  _checkUnknownTool(toolName) {
    if (this._knownTools.size === 0) {
      return { stuck: false, level: 'ok', detector: 'unknownTool', message: '' };
    }
    if (this._knownTools.has(toolName) || this._knownTools.has(_normalizeName(toolName))) {
      return { stuck: false, level: 'ok', detector: 'unknownTool', message: '' };
    }
    if (this.unknownToolCount >= this.config.unknownToolThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'unknownTool',
        message: `Model has called ${this.unknownToolCount} unknown tools. Latest: "${toolName}".`,
      };
    }
    return {
      stuck: false,
      level: 'warning',
      detector: 'unknownTool',
      message: `Unknown tool "${toolName}". ${this.unknownToolCount} unknown calls so far.`,
    };
  }

  _checkNoProgress(toolName, params) {
    const callHash = hashCall(toolName, params);

    // Count consecutive entries with same call+result hash at the tail
    let streak = 0;
    let lastResultHash = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const rec = this.history[i];
      if (rec.callHash !== callHash) break;
      if (rec.resultHash === null) continue; // not yet resolved

      if (lastResultHash === null) {
        lastResultHash = rec.resultHash;
        streak = 1;
      } else if (rec.resultHash === lastResultHash) {
        streak++;
      } else {
        break;
      }
    }

    if (streak >= this.config.noProgressCritical) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'noProgress',
        message: `No progress: "${toolName}" returned identical results ${streak} times.`,
      };
    }
    if (streak >= this.config.noProgressWarning) {
      return {
        stuck: false,
        level: 'warning',
        detector: 'noProgress',
        message: `"${toolName}" returned the same result ${streak} times. Try a different approach.`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'noProgress', message: '' };
  }

  _checkPingPong(toolName) {
    if (this.history.length < 4) {
      return { stuck: false, level: 'ok', detector: 'pingPong', message: '' };
    }

    // Look for A→B→A→B pattern at the tail
    const tail = this.history.slice(-this.config.pingPongThreshold * 2);
    if (tail.length < 4) {
      return { stuck: false, level: 'ok', detector: 'pingPong', message: '' };
    }

    const toolA = tail[tail.length - 2]?.toolName;
    const toolB = tail[tail.length - 1]?.toolName;

    if (!toolA || !toolB || toolA === toolB) {
      return { stuck: false, level: 'ok', detector: 'pingPong', message: '' };
    }

    let pingPongCount = 0;
    for (let i = tail.length - 1; i >= 1; i -= 2) {
      if (tail[i].toolName === toolB && tail[i - 1].toolName === toolA) {
        pingPongCount++;
      } else {
        break;
      }
    }

    if (pingPongCount >= this.config.pingPongThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'pingPong',
        message: `Ping-pong detected: "${toolA}" ↔ "${toolB}" alternating ${pingPongCount} times.`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'pingPong', message: '' };
  }

  // ── Detector 6: Content Chanting ───────────────────────────────────

  /**
   * Feed AI output text for chanting detection.
   * Call this with each text chunk from the AI response.
   * @param {string} text
   */
  feedContent(text) {
    if (!text || typeof text !== 'string') return;

    // Check for code fence toggle
    const fenceCount = (text.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) this._inCodeBlock = !this._inCodeBlock;

    // Skip structural content that would cause false positives
    if (this._inCodeBlock) return;
    for (const pat of STRUCTURAL_PATTERNS) {
      if (pat.test(text)) return;
    }

    // Accumulate buffer
    this._contentBuffer += text;

    // Cap buffer size — truncate from the front
    const maxBuf = this.config.contentMaxBuffer;
    if (this._contentBuffer.length > maxBuf) {
      const excess = this._contentBuffer.length - maxBuf;
      this._contentBuffer = this._contentBuffer.slice(excess);
      // Adjust all stored positions
      for (const [hash, positions] of this._contentHashes) {
        const adjusted = positions.map(p => p - excess).filter(p => p >= 0);
        if (adjusted.length === 0) {
          this._contentHashes.delete(hash);
        } else {
          this._contentHashes.set(hash, adjusted);
        }
      }
      this._contentLastIdx = Math.max(0, this._contentLastIdx - excess);
    }

    // Analyze new region: slide 1-char at a time, hash 50-char chunks
    const chunkSize = this.config.contentChunkSize;
    const buf = this._contentBuffer;

    while (this._contentLastIdx + chunkSize <= buf.length) {
      const slice = buf.slice(this._contentLastIdx, this._contentLastIdx + chunkSize);
      const hash = fnv1aHash(slice);

      if (!this._contentHashes.has(hash)) {
        this._contentHashes.set(hash, []);
      }
      this._contentHashes.get(hash).push(this._contentLastIdx);

      this._contentLastIdx++;
    }
  }

  _checkContentChanting() {
    const threshold = this.config.contentChantThreshold;
    const chunkSize = this.config.contentChunkSize;
    const maxAvgDist = chunkSize * 1.5;

    for (const [, positions] of this._contentHashes) {
      if (positions.length < threshold) continue;

      // Check average distance of last N positions
      const recent = positions.slice(-threshold);
      const first = recent[0];
      const last = recent[recent.length - 1];
      const avgDist = (last - first) / (recent.length - 1);

      if (avgDist <= maxAvgDist) {
        return {
          stuck: true,
          level: 'critical',
          detector: 'contentChanting',
          message: `Content chanting detected: same ${chunkSize}-char fragment repeated ${positions.length} times with avg distance ${Math.round(avgDist)} chars.`,
        };
      }
    }
    return { stuck: false, level: 'ok', detector: 'contentChanting', message: '' };
  }

  // ── Detector 7: Read-File Loop ────────────────────────────────────

  _checkReadFileLoop() {
    // Cold-start gate: don't trigger until we've seen at least one non-read tool
    if (!this._hasSeenNonReadTool) {
      return { stuck: false, level: 'ok', detector: 'readFileLoop', message: '' };
    }

    const window = this._recentToolNames;
    if (window.length < this.config.readFileThreshold) {
      return { stuck: false, level: 'ok', detector: 'readFileLoop', message: '' };
    }

    const readCount = window.filter(n => _isReadLikeTool(n)).length;
    if (readCount >= this.config.readFileThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'readFileLoop',
        message: `Read-file loop: ${readCount} of last ${window.length} tool calls are read-like. Take action instead of just reading.`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'readFileLoop', message: '' };
  }

  // ── Detector 8: Action Stagnation ─────────────────────────────────

  _checkActionStagnation() {
    const critThreshold = this.config.stagnationCriticalThreshold || 8;
    if (this._sameNameStreak >= critThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'actionStagnation',
        message: `Action stagnation: tool "${this._lastToolName}" called ${this._sameNameStreak} times consecutively (critical threshold: ${critThreshold}). Execution blocked.`,
      };
    }
    if (this._sameNameStreak >= this.config.stagnationThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'actionStagnation',
        message: `Action stagnation: tool "${this._lastToolName}" called ${this._sameNameStreak} times consecutively. Try a different tool.`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'actionStagnation', message: '' };
  }

  // ── Detector 9: Shell Intent Repeat ─────────────────────────────────

  _checkShellIntentRepeat(toolName, params) {
    if (!_isShellTool(toolName)) {
      return { stuck: false, level: 'ok', detector: 'shellIntentRepeat', message: '' };
    }

    const intent = extractShellIntent((params || {}).command || (params || {}).cmd);
    if (!intent) {
      return { stuck: false, level: 'ok', detector: 'shellIntentRepeat', message: '' };
    }

    // Count consecutive same-intent shell calls from the tail
    let streak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]._shellIntent === intent) {
        streak++;
      } else {
        break;
      }
    }

    const criticalThreshold = this.config.shellIntentCritical || 3;
    const warningThreshold = this.config.shellIntentWarning || 2;

    if (streak >= criticalThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'shellIntentRepeat',
        message: `Shell intent loop: "${intent}" attempted ${streak} times with different syntax. The command is not working — try a completely different approach.`,
      };
    }
    if (streak >= warningThreshold) {
      return {
        stuck: false,
        level: 'warning',
        detector: 'shellIntentRepeat',
        message: `Shell command "${intent}" tried ${streak} times with variant syntax. Consider a different approach.`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'shellIntentRepeat', message: '' };
  }

  // ── Detector 10: Path Intent Repeat (cross-tool same-path) ─────────

  _checkPathIntentRepeat(toolName, params) {
    // Also apply to shell tools: extract target path from shell command
    let pathIntent = null;
    if (_isFsTool(toolName)) {
      pathIntent = extractPathIntent(toolName, params);
    } else if (_isShellTool(toolName)) {
      // For shell tools, extract the target from shell command intent
      const si = extractShellIntent((params || {}).command || (params || {}).cmd);
      // shellIntent format is "baseCmd:target" — extract the target part
      if (si) {
        const colonIdx = si.indexOf(':');
        pathIntent = colonIdx >= 0 ? si.slice(colonIdx + 1) : null;
      }
    }

    if (!pathIntent) {
      return { stuck: false, level: 'ok', detector: 'pathIntentRepeat', message: '' };
    }

    // Count how many recent calls targeted the same normalized path
    // (across ALL tool types — LS, shell ls, read_file, glob, etc.)
    let streak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const rec = this.history[i];
      let recPath = rec._pathIntent;
      // Also check shell intent for shell tools in history
      if (!recPath && rec._shellIntent) {
        const ci = rec._shellIntent.indexOf(':');
        recPath = ci >= 0 ? rec._shellIntent.slice(ci + 1) : null;
      }
      if (recPath === pathIntent) {
        streak++;
      } else {
        break;
      }
    }

    const criticalThreshold = this.config.pathIntentCritical || 3;
    const warningThreshold = this.config.pathIntentWarning || 2;

    if (streak >= criticalThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'pathIntentRepeat',
        message: `Path intent loop: "${pathIntent}" accessed ${streak} times with different tools/syntax. This path has been checked — try a different approach or path.`,
      };
    }
    if (streak >= warningThreshold) {
      return {
        stuck: false,
        level: 'warning',
        detector: 'pathIntentRepeat',
        message: `Path "${pathIntent}" accessed ${streak} times. Consider a different approach.`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'pathIntentRepeat', message: '' };
  }

  // ── Detector 11: Web-Retrieval Failure Streak (cross-tool 死缠烂打) ──
  //
  // Catches the "death-grip" pattern where the agent thrashes across many
  // web-fetch tools (WebFetch → curl → WebSearch → browser → …) after each
  // one fails, instead of stepping back to the optimal approach. Unlike the
  // intent/path detectors, this is FAILURE-GATED: it only fires on consecutive
  // FAILED web retrievals, so a legitimate search→fetch progression that makes
  // progress never trips it.
  _checkWebRetrievalFailureStreak(toolName, params) {
    const isWeb = _isWebTool(toolName)
      || (_isShellTool(toolName) && _shellCommandIsWebFetch((params || {}).command || (params || {}).cmd));
    if (!isWeb) {
      return { stuck: false, level: 'ok', detector: 'webRetrievalFailureStreak', message: '' };
    }

    // Count consecutive FAILED web-retrieval calls from the tail of history.
    // Only records with a known outcome (_failed === true) extend the streak;
    // a successful fetch (_failed === false) breaks it. Records still pending
    // an outcome (_failed === null) or non-web records are skipped, not counted
    // as a break — the current (not-yet-executed) call is the next attempt.
    let streak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const rec = this.history[i];
      if (!rec._isWeb) continue;
      if (rec._failed === true) {
        streak++;
      } else if (rec._failed === false) {
        break;  // a web fetch succeeded — not thrashing
      }
      // _failed === null (pending): skip without breaking
    }

    const criticalThreshold = this.config.webFailCritical || 4;
    const warningThreshold = this.config.webFailWarning || 3;

    if (streak >= criticalThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'webRetrievalFailureStreak',
        message: `Web-retrieval loop: ${streak} consecutive fetch attempts failed across different tools. Stop trying fetch variants — use the universal web search (WebSearch) as the optimal path, or report a structured failure if the resource is unreachable.`,
      };
    }
    if (streak >= warningThreshold) {
      return {
        stuck: false,
        level: 'warning',
        detector: 'webRetrievalFailureStreak',
        message: `${streak} web fetches failed in a row. Switch to the optimal approach (WebSearch) instead of trying more fetch variants.`,
      };
    }
    return { stuck: false, level: 'ok', detector: 'webRetrievalFailureStreak', message: '' };
  }
}

module.exports = { ToolLoopDetector, DEFAULT_CONFIG, toolCallSignature, extractShellIntent, extractPathIntent, extractSearchIntent, _isShellTool, _isFsTool, _isWebTool, _isSearchTool, _shellCommandIsWebFetch, _normalizePath };
