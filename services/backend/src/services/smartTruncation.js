'use strict';

/**
 * smartTruncation.js — Per-Tool Noise Classification & Dual-Limit Truncation
 *
 * Aligned with DeepSeek-TUI's intelligent output trimming.
 * Instead of a single hard cut, applies per-tool noise profiles:
 *
 * - Soft limit: preferred max; exceeded content is noise-filtered first
 * - Hard limit: absolute max; anything beyond is dropped with summary
 *
 * Tool noise profiles classify which parts of output are signal vs noise:
 *   - grep/glob: file lists are signal, repetitive matches are noise
 *   - shellCommand: last N lines are signal, early build logs are noise
 *   - fileRead: all content is signal (never noise-filter)
 *   - testRunner: summary + failures are signal, passing tests are noise
 */

// ── Tool Noise Profiles ──────────────────────────────────────────────

/**
 * @typedef {object} NoiseProfile
 * @property {number} softLimit  - Preferred char limit before noise filtering
 * @property {number} hardLimit  - Absolute char limit (drop everything beyond)
 * @property {function} filter   - Noise filter: (text) => filteredText
 */

const PROFILES = {
  // Shell output: keep first few lines (command echo) + last N lines (result/errors)
  shellCommand: {
    softLimit: 12000,
    hardLimit: 50000,
    filter: _filterShellOutput,
  },
  shell_command: {
    softLimit: 12000,
    hardLimit: 50000,
    filter: _filterShellOutput,
  },

  // Grep/search: keep unique file matches, collapse repetitive content matches
  grep: {
    softLimit: 8000,
    hardLimit: 30000,
    filter: _filterSearchOutput,
  },
  Grep: {
    softLimit: 8000,
    hardLimit: 30000,
    filter: _filterSearchOutput,
  },

  // Glob: file lists are compact, rarely need filtering
  glob: {
    softLimit: 6000,
    hardLimit: 15000,
    filter: _filterFileList,
  },
  Glob: {
    softLimit: 6000,
    hardLimit: 15000,
    filter: _filterFileList,
  },

  // File read: signal-dense, use generous limits
  fileRead: {
    softLimit: 60000,
    hardLimit: 120000,
    filter: null, // never noise-filter file reads
  },
  FileRead: {
    softLimit: 60000,
    hardLimit: 120000,
    filter: null,
  },
  Read: {
    softLimit: 60000,
    hardLimit: 120000,
    filter: null,
  },

  // Test runners: keep summary + failures, collapse passing tests
  runTests: {
    softLimit: 10000,
    hardLimit: 40000,
    filter: _filterTestOutput,
  },
  run_tests: {
    softLimit: 10000,
    hardLimit: 40000,
    filter: _filterTestOutput,
  },

  // Build tools: keep errors/warnings + last section
  buildProject: {
    softLimit: 8000,
    hardLimit: 30000,
    filter: _filterBuildOutput,
  },
  build_project: {
    softLimit: 8000,
    hardLimit: 30000,
    filter: _filterBuildOutput,
  },

  // LSP: structured results, keep as-is
  LSP: {
    softLimit: 8000,
    hardLimit: 20000,
    filter: null,
  },

  // Write/edit: tiny results, no filtering needed
  writeFile: { softLimit: 2000, hardLimit: 5000, filter: null },
  editFile: { softLimit: 2000, hardLimit: 5000, filter: null },
  Write: { softLimit: 2000, hardLimit: 5000, filter: null },
  Edit: { softLimit: 2000, hardLimit: 5000, filter: null },
};

// Default profile for unknown tools
const DEFAULT_PROFILE = {
  softLimit: 15000,
  hardLimit: 50000,
  filter: null,
};

// ── Main API ─────────────────────────────────────────────────────────

/**
 * Apply smart truncation to a tool result.
 *
 * @param {string} toolName - Name of the tool that produced the output
 * @param {string} text     - Raw output text
 * @param {object} [opts]
 * @param {number} [opts.contextBudget]  - Total context tokens available (adjusts limits)
 * @param {boolean} [opts.isError=false] - Error outputs are never noise-filtered
 * @returns {{ text: string, truncated: boolean, strategy: string, originalLen: number }}
 */
function truncate(toolName, text, opts = {}) {
  if (!text || typeof text !== 'string') {
    return { text: text || '', truncated: false, strategy: 'none', originalLen: 0 };
  }

  const originalLen = text.length;
  const profile = PROFILES[toolName] || DEFAULT_PROFILE;

  // Scale limits based on context budget if provided
  // Use log-based curve instead of linear: gentler for small models, less generous for very large.
  // Reference point: 65536 → scale=1.0; 8192 → ~0.69; 200000 → ~1.40; 1M → ~1.76
  let { softLimit, hardLimit, filter } = profile;
  if (opts.contextBudget) {
    const ratio = opts.contextBudget / 65536;
    const scale = Math.min(2, Math.max(0.5, Math.log2(ratio + 1)));
    softLimit = Math.floor(softLimit * scale);
    hardLimit = Math.floor(hardLimit * scale);
  }

  // Error outputs: never noise-filter, just hard-limit
  if (opts.isError) {
    filter = null;
  }

  // Case 1: Under soft limit — return as-is
  if (text.length <= softLimit) {
    return { text, truncated: false, strategy: 'none', originalLen };
  }

  // Case 2: Between soft and hard — apply noise filter if available
  if (text.length <= hardLimit && filter) {
    const filtered = filter(text, softLimit);
    if (filtered.length <= softLimit) {
      return {
        text: filtered,
        truncated: true,
        strategy: 'noise_filtered',
        originalLen,
      };
    }
    // Filter didn't shrink enough, fall through to hard truncation
  }

  // Case 3: Apply noise filter first, then hard truncate
  let working = text;
  if (filter && !opts.isError) {
    working = filter(text, softLimit);
  }

  if (working.length <= hardLimit) {
    return {
      text: working,
      truncated: working.length < originalLen,
      strategy: filter ? 'noise_filtered' : 'none',
      originalLen,
    };
  }

  // Hard truncation with head+tail strategy
  const headSize = Math.floor(hardLimit * 0.7);
  const tailSize = hardLimit - headSize - 100; // 100 chars for separator
  const head = working.slice(0, _findNewlineBefore(working, headSize));
  const tail = working.slice(_findNewlineAfter(working, working.length - tailSize));
  const omitted = originalLen - head.length - tail.length;

  return {
    text: `${head}\n\n... [${omitted} chars omitted — showing first and last sections]\n\n${tail}`,
    truncated: true,
    strategy: 'head_tail',
    originalLen,
  };
}

/**
 * Get the noise profile for a tool.
 * @param {string} toolName
 * @returns {NoiseProfile}
 */
function getProfile(toolName) {
  return PROFILES[toolName] || DEFAULT_PROFILE;
}

/**
 * Register a custom noise profile for a tool.
 * @param {string} toolName
 * @param {NoiseProfile} profile
 */
function registerProfile(toolName, profile) {
  if (toolName && profile && typeof profile.softLimit === 'number') {
    PROFILES[toolName] = profile;
  }
}

// ── Noise Filters ────────────────────────────────────────────────────

/**
 * Shell output: keep first 5 lines (command context) + last N lines (results).
 * Middle section (verbose build logs, progress bars) is noise.
 */
function _filterShellOutput(text, targetLen) {
  const lines = text.split('\n');
  if (lines.length <= 30) return text;

  const headLines = 5;
  const head = lines.slice(0, headLines);

  // Keep lines with errors/warnings/important markers
  const importantMiddle = [];
  for (let i = headLines; i < lines.length - 20; i++) {
    if (_isImportantLine(lines[i])) {
      importantMiddle.push(lines[i]);
    }
  }

  // Keep last 20 lines (results/summary)
  const tail = lines.slice(-20);

  const middleOmitted = lines.length - headLines - importantMiddle.length - tail.length;
  const parts = [
    ...head,
    ...(middleOmitted > 0 ? [`... [${middleOmitted} lines of build/progress output omitted]`] : []),
    ...importantMiddle,
    ...tail,
  ];

  const result = parts.join('\n');
  return result.length <= targetLen ? result : result.slice(0, targetLen);
}

/**
 * Search output: deduplicate file paths, collapse repetitive matches.
 */
function _filterSearchOutput(text, targetLen) {
  const lines = text.split('\n');
  if (lines.length <= 50) return text;

  // Track seen file prefixes to collapse repetitive matches
  const seenFiles = new Map();
  const filtered = [];

  for (const line of lines) {
    // Extract file path from grep-style output (file:line:content)
    // 门控 KHY_GREP_WIN_DRIVE_DEDUP(默认开):Windows `C:\…:1:content` 行取盘符冒号之后的
    // 分隔冒号,避免所有盘符路径塌进同一个 "C" 桶而丢弃大量匹配。门关/异常 → null → 回退
    // legacy `line.indexOf(':')`(逐字节等价)。
    let colonIdx;
    try {
      const idx = require('./grepWindowsDriveKey').resolveGrepSeparatorIndex(line, process.env);
      colonIdx = (idx == null) ? line.indexOf(':') : idx;
    } catch {
      colonIdx = line.indexOf(':');
    }
    if (colonIdx > 0 && colonIdx < 200) {
      const file = line.slice(0, colonIdx);
      const count = seenFiles.get(file) || 0;
      seenFiles.set(file, count + 1);

      // Keep first 3 matches per file, then summarize
      if (count < 3) {
        filtered.push(line);
      } else if (count === 3) {
        filtered.push(`  ... (more matches in ${file})`);
      }
      // count > 3: skip
    } else {
      filtered.push(line);
    }
  }

  const result = filtered.join('\n');
  return result.length <= targetLen ? result : result.slice(0, targetLen);
}

/**
 * File list: just truncate long lists with count.
 */
function _filterFileList(text, targetLen) {
  const lines = text.split('\n');
  if (text.length <= targetLen) return text;

  const keepLines = Math.floor(targetLen / 60); // avg 60 chars per path
  const kept = lines.slice(0, keepLines);
  const omitted = lines.length - keepLines;
  if (omitted > 0) {
    kept.push(`... and ${omitted} more files`);
  }
  return kept.join('\n');
}

/**
 * Test output: keep summary section + failed test details, drop passing tests.
 */
function _filterTestOutput(text, targetLen) {
  const lines = text.split('\n');
  const result = [];
  let inFailure = false;
  let passingCount = 0;

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Always keep failure blocks
    if (/\b(fail|error|assert|expect|throw)\b/i.test(line) ||
        /^\s*(✕|✗|×|FAIL|ERROR|AssertionError)/i.test(line)) {
      inFailure = true;
    }

    // Always keep summary lines
    if (/\b(test suites?|tests?\s+passed|tests?\s+failed|total|duration|coverage)\b/i.test(line) ||
        /^(Tests|Suites|Time|Snapshots):/.test(line.trim())) {
      result.push(line);
      inFailure = false;
      continue;
    }

    if (inFailure) {
      result.push(line);
      // End of failure block on empty line after content
      if (line.trim() === '' && result.length > 2) {
        inFailure = false;
      }
      continue;
    }

    // Track passing tests but don't include them
    if (/\b(✓|✔|pass|PASS)\b/i.test(line)) {
      passingCount++;
      continue;
    }

    // Keep other lines (headers, separators)
    result.push(line);
  }

  if (passingCount > 0) {
    result.push(`[${passingCount} passing tests omitted for brevity]`);
  }

  const output = result.join('\n');
  return output.length <= targetLen ? output : output.slice(0, targetLen);
}

/**
 * Build output: keep errors/warnings + final summary.
 */
function _filterBuildOutput(text, targetLen) {
  const lines = text.split('\n');
  const important = [];
  let normalCount = 0;

  for (const line of lines) {
    if (_isImportantLine(line)) {
      important.push(line);
    } else {
      normalCount++;
    }
  }

  // Always include last 10 lines (build summary)
  const tail = lines.slice(-10);
  const parts = [
    ...important,
    ...(normalCount > 0 ? [`[${normalCount} informational lines omitted]`] : []),
    '---',
    ...tail,
  ];

  const output = parts.join('\n');
  return output.length <= targetLen ? output : output.slice(0, targetLen);
}

// ── Helpers ──────────────────────────────────────────────────────────

function _isImportantLine(line) {
  if (!line || typeof line !== 'string') return false;
  return /\b(error|warn(ing)?|fail(ed|ure)?|panic|fatal|exception|cannot|undefined|ENOENT|EACCES|EPERM|ENOTFOUND|TypeError|SyntaxError|ReferenceError)\b/i.test(line);
}

function _findNewlineBefore(text, pos) {
  const idx = text.lastIndexOf('\n', pos);
  return idx > pos * 0.5 ? idx : pos;
}

function _findNewlineAfter(text, pos) {
  const idx = text.indexOf('\n', pos);
  return idx > 0 ? idx : pos;
}

module.exports = {
  truncate,
  getProfile,
  registerProfile,
  PROFILES,
  DEFAULT_PROFILE,
};
