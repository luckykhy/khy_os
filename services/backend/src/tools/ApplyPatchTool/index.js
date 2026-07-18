/**
 * ApplyPatchTool — atomic multi-file unified diff patch application (G2).
 *
 * Accepts a unified diff (as produced by `git diff` or `diff -u`) and
 * applies it to one or more files atomically: either every hunk in every
 * file succeeds, or the entire operation is rolled back.
 *
 * Key features:
 *   - Multi-file, multi-hunk patches in a single tool call
 *   - Fuzzy context matching (±20 lines drift, 0.85 similarity)
 *   - Atomic commit: all files written or all restored from backup
 *   - Supports file creation (/dev/null source) and deletion
 */
'use strict';

// [AI-弱模型·照抄] 高危写工具:unified diff 原子应用(全成或全回滚);先 Read 目标文件再打补丁,
// context 行要对得上。prompt() 末尾的 this.weakModelToolNote() 注入别删;改本工具照 'tool-description' 位点。
const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');

// ── Diff Parser ─────────────────────────────────────────────────────

/**
 * Parse a unified diff into structured file entries.
 * @param {string} patch - Unified diff text
 * @returns {Array<{srcPath: string, dstPath: string, isNew: boolean, isDelete: boolean, hunks: Array}>}
 */
function parsePatch(patch) {
  const files = [];
  // Split on file boundaries: "--- a/..." lines
  const fileSections = patch.split(/^(?=--- )/m).filter(Boolean);

  for (const section of fileSections) {
    const headerMatch = section.match(
      /^--- (?:a\/)?(.+)\n\+\+\+ (?:b\/)?(.+)\n/m
    );
    if (!headerMatch) continue;

    const srcPath = headerMatch[1].trim();
    const dstPath = headerMatch[2].trim();
    const isNew = srcPath === '/dev/null' || srcPath === 'dev/null';
    const isDelete = dstPath === '/dev/null' || dstPath === 'dev/null';

    // Parse hunks
    const hunks = [];
    const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)\n([\s\S]*?)(?=^@@ |\Z)/gm;
    let m;
    const body = section.slice(headerMatch[0].length);
    // Reset regex for body scanning.
    // The terminator uses `(?![\s\S])` (absolute end-of-input) rather than `$`:
    // under the `m` flag `$` matches at every line-end, so the lazy `[\s\S]*?`
    // body capture stopped after the FIRST body line — truncating every
    // multi-line hunk to one line. `\n@@ ` / `\n--- ` still bound the body at
    // the next hunk / file; `(?![\s\S])` bounds the final hunk at true EOF.
    const bodyHunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)\n?([\s\S]*?)(?=\n@@ |\n--- |(?![\s\S]))/gm;
    while ((m = bodyHunkRegex.exec(body)) !== null) {
      const srcStart = parseInt(m[1], 10);
      const srcLen = m[2] != null ? parseInt(m[2], 10) : 1;
      const dstStart = parseInt(m[3], 10);
      const dstLen = m[4] != null ? parseInt(m[4], 10) : 1;
      const hunkHeader = m[5] || '';
      const hunkBody = m[6] || '';

      const lines = hunkBody.split('\n');
      // Remove trailing empty line from split
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

      const context = [];
      const removed = [];
      const added = [];

      for (const line of lines) {
        if (line.startsWith('-')) {
          removed.push(line.slice(1));
        } else if (line.startsWith('+')) {
          added.push(line.slice(1));
        } else if (line.startsWith(' ') || line === '') {
          context.push(line.startsWith(' ') ? line.slice(1) : line);
        }
        // Skip "\ No newline at end of file"
      }

      hunks.push({ srcStart, srcLen, dstStart, dstLen, hunkHeader, context, removed, added, rawLines: lines });
    }

    if (hunks.length > 0 || isNew || isDelete) {
      files.push({ srcPath, dstPath, isNew, isDelete, hunks });
    }
  }

  return files;
}

// ── Fuzzy Hunk Application ──────────────────────────────────────────

const MAX_DRIFT = 20;
const SIMILARITY_THRESHOLD = 0.85;

/**
 * Compute line similarity (Levenshtein-based, 0..1).
 */
function lineSimilarity(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const max = Math.max(la, lb);
  // Fast path for very different lengths
  if (Math.abs(la - lb) / max > 0.5) return 0;
  // Levenshtein distance
  const dp = Array.from({ length: la + 1 }, (_, i) => i);
  for (let j = 1; j <= lb; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= la; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[i], dp[i - 1]) + 1;
      prev = tmp;
    }
  }
  return 1 - dp[la] / max;
}

/**
 * Check if a block of source lines matches the hunk's expected context + removed lines.
 * @returns {number} similarity score (0..1)
 */
function blockSimilarity(sourceLines, startIdx, expected) {
  if (startIdx < 0 || startIdx + expected.length > sourceLines.length) return 0;
  let total = 0;
  for (let i = 0; i < expected.length; i++) {
    total += lineSimilarity(sourceLines[startIdx + i], expected[i]);
  }
  return expected.length > 0 ? total / expected.length : 1;
}

/**
 * Apply a single hunk to source lines with fuzzy matching.
 * @param {string[]} sourceLines - Mutable array of file lines
 * @param {object} hunk - Parsed hunk
 * @returns {{ applied: boolean, fuzzLevel: number, matchLine: number }}
 */
function applyHunk(sourceLines, hunk) {
  // Build the expected block: context lines before removals + removed lines
  const expected = [];
  for (const line of hunk.rawLines) {
    if (line.startsWith(' ') || line.startsWith('-')) {
      expected.push(line.slice(1));
    } else if (line === '') {
      expected.push('');
    }
    // '+' lines are not in source
  }

  if (expected.length === 0) {
    // Pure addition — insert at target line
    const insertAt = Math.min(hunk.srcStart - 1, sourceLines.length);
    sourceLines.splice(insertAt, 0, ...hunk.added);
    return { applied: true, fuzzLevel: 0, matchLine: insertAt + 1 };
  }

  // Try exact position first (0-indexed: srcStart - 1)
  const anchor = hunk.srcStart - 1;

  // Search with increasing drift
  for (let drift = 0; drift <= MAX_DRIFT; drift++) {
    for (const offset of drift === 0 ? [0] : [-drift, drift]) {
      const tryIdx = anchor + offset;
      if (tryIdx < 0 || tryIdx + expected.length > sourceLines.length) continue;

      const sim = blockSimilarity(sourceLines, tryIdx, expected);
      if (sim >= SIMILARITY_THRESHOLD) {
        // Replace the matched block with the hunk's "after" image: context ` `
        // lines AND added `+` lines in rawLines order (removed `-` lines drop
        // out). Splicing only `hunk.added` deleted every context line inside
        // the matched block — e.g. a 1-context/1-removed/2-added hunk replaced
        // 2 source lines with just the 2 added lines, destroying the context.
        const replacement = [];
        for (const line of hunk.rawLines) {
          if (line.startsWith(' ') || line.startsWith('+')) {
            replacement.push(line.slice(1));
          } else if (line === '') {
            replacement.push('');
          }
          // '-' (removed) and '\ No newline...' lines are omitted from the after image
        }
        sourceLines.splice(tryIdx, expected.length, ...replacement);
        return { applied: true, fuzzLevel: drift, matchLine: tryIdx + 1 };
      }
    }
  }

  return { applied: false, fuzzLevel: -1, matchLine: -1 };
}

// ── Tool Class ──────────────────────────────────────────────────────

class ApplyPatchTool extends BaseTool {
  static toolName = 'apply_patch';
  static category = 'filesystem';
  static risk = 'high';
  static aliases = ['applyPatch', 'patch'];
  static searchHint = 'apply unified diff patch multi-file atomic';
  static alwaysLoad = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Apply a unified diff patch to one or more files atomically.

All hunks across all files must succeed or the entire operation is rolled back.
Use standard unified diff format (as produced by "git diff" or "diff -u").

Supports:
- Multi-file patches in a single call
- File creation (--- /dev/null)
- Fuzzy context matching (tolerates minor drift)

Example patch format:
--- a/src/foo.js
+++ b/src/foo.js
@@ -10,3 +10,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 module.exports = { x, y };` + this.weakModelToolNote();
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: 'Unified diff format patch text (supports multiple files)',
        },
      },
      required: ['patch'],
    };
  }

  async execute(params) {
    const { patch } = params;
    if (!patch || typeof patch !== 'string') {
      return { success: false, error: 'Missing or invalid patch parameter' };
    }

    const root = process.env.KHYQUANT_CWD || process.cwd();
    const files = parsePatch(patch);

    if (files.length === 0) {
      return { success: false, error: 'No valid file entries found in patch' };
    }

    // ── Phase 1: Read and backup all files ───────────────────────────
    const backups = new Map(); // absPath → original content (null if file didn't exist)
    const results = [];

    for (const file of files) {
      const filePath = file.isDelete ? file.srcPath : file.dstPath;
      const abs = path.resolve(root, filePath);

      if (file.isNew) {
        backups.set(abs, null);
        continue;
      }

      try {
        const content = fs.readFileSync(abs, 'utf-8');
        backups.set(abs, content);
      } catch (err) {
        return {
          success: false,
          error: `Cannot read file for patching: ${filePath} — ${err.message}`,
          files: results,
        };
      }
    }

    // Pre-patch snapshots for /rollback recovery
    try {
      const fh = require('../../services/fileHistoryService');
      for (const [abs, content] of backups) {
        if (content !== null) {
          fh.takeSnapshot(abs, { reason: 'ApplyPatchTool', content });
        }
      }
    } catch { /* non-critical */ }

    // ── Phase 2: Apply hunks per file ────────────────────────────────
    const modified = new Map(); // absPath → new content

    for (const file of files) {
      const filePath = file.isDelete ? file.srcPath : file.dstPath;
      const abs = path.resolve(root, filePath);

      if (file.isDelete) {
        modified.set(abs, null); // marker for deletion
        results.push({ path: filePath, action: 'delete', hunksApplied: 0, fuzzLevel: 0 });
        continue;
      }

      if (file.isNew) {
        // Construct new file from added lines
        const content = file.hunks.flatMap(h => h.added).join('\n') + '\n';
        modified.set(abs, content);
        results.push({ path: filePath, action: 'create', hunksApplied: file.hunks.length, fuzzLevel: 0 });
        continue;
      }

      const original = backups.get(abs) || '';
      const lines = original.split('\n');
      let maxFuzz = 0;
      let allApplied = true;

      // Apply hunks in reverse order (bottom-up) to preserve line numbers
      const sortedHunks = [...file.hunks].sort((a, b) => b.srcStart - a.srcStart);
      for (const hunk of sortedHunks) {
        const { applied, fuzzLevel } = applyHunk(lines, hunk);
        if (!applied) {
          allApplied = false;
          results.push({
            path: filePath,
            action: 'error',
            error: `Hunk at line ${hunk.srcStart} failed to apply (no context match within ±${MAX_DRIFT} lines)`,
          });
          break;
        }
        maxFuzz = Math.max(maxFuzz, fuzzLevel);
      }

      if (!allApplied) {
        // Rollback — don't write anything
        return {
          success: false,
          error: `Patch failed on ${filePath} — all changes rolled back`,
          files: results,
        };
      }

      modified.set(abs, lines.join('\n'));
      results.push({
        path: filePath,
        action: 'modify',
        hunksApplied: file.hunks.length,
        fuzzLevel: maxFuzz,
      });
    }

    // ── Phase 3: Atomic write ────────────────────────────────────────
    const written = [];
    try {
      for (const [abs, content] of modified) {
        if (content === null) {
          // Delete file
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } else {
          // Ensure directory exists for new files
          const dir = path.dirname(abs);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(abs, content, 'utf-8');
        }
        written.push(abs);
      }
    } catch (err) {
      // Rollback: restore all written files from backup
      for (const abs of written) {
        try {
          const backup = backups.get(abs);
          if (backup === null || backup === undefined) {
            // File was new — remove it
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
          } else {
            fs.writeFileSync(abs, backup, 'utf-8');
          }
        } catch { /* best-effort rollback */ }
      }
      return {
        success: false,
        error: `Write failed: ${err.message} — all changes rolled back`,
        files: results,
      };
    }

    return {
      success: true,
      message: `Patch applied: ${results.filter(r => r.action !== 'error').length} file(s) modified`,
      files: results,
    };
  }
}

module.exports = ApplyPatchTool;
// Internal helpers exposed for unit testing (pure functions; no runtime consumer
// reaches through __test__).
module.exports.__test__ = { parsePatch, applyHunk };
