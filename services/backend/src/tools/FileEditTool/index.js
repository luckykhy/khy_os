/**
 * FileEditTool — exact string replacement editing, aligned with Claude Code's Edit tool.
 *
 * Performs precise substring replacement in files. The old_string must be
 * unique in the file (unless replace_all is true) to prevent ambiguous edits.
 *
 * When exact match fails, a fuzzy fallback attempts to find the best match by:
 * 1. Stripping leading/trailing whitespace from each line
 * 2. Collapsing internal whitespace differences
 * 3. Ignoring trailing commas / semicolons
 * 4. Tab/Space normalization
 * 5. Blank line folding
 * This lets local models (which often retype code from memory) succeed on
 * semantically-identical edits without sacrificing safety.
 */
// [AI-弱模型·照抄] 高危写工具:先 Read 再 Edit,old_string 逐字照抄读到的原文(别猜,否则死循环撞
// "no match")。prompt() 末尾的 this.weakModelToolNote() 注入别删。改本工具照 weakModelGuidance 的
// 'tool-description' 位点(参数严格按 schema、一次一步),示范见 GrepTool。
const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');

// ── LSP diagnostics auto-inject ────────────────────────────────────
const _collectLspDiagnostics = require('../../utils/collectLspDiagnostics');

// ── Fuzzy matching helpers ───────────────────────────────────────────

/**
 * Normalize a string for fuzzy comparison: collapse whitespace, strip
 * trailing punctuation, lowercase. Used only for *matching*, never for
 * the actual replacement.
 */
function _normalize(s) {
  return String(s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[;,]+\s*$/gm, '')
    .trim();
}

/**
 * Simple Levenshtein distance (character-level). Only used on short
 * normalized strings (<2000 chars) so O(n*m) is acceptable.
 */
function _levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  // Limit to avoid expensive computation on large strings
  if (la > 2000 || lb > 2000) return Math.abs(la - lb);
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const curr = [i];
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[lb];
}

/**
 * Try to find the best fuzzy match for `needle` in `haystack`.
 * Returns { match, start, end, similarity } or null.
 *
 * Strategy: slide a window of ±20% needle-line-count over haystack lines,
 * compute normalized Levenshtein similarity, accept if ≥ 0.80.
 */
function _fuzzyFind(haystack, needle) {
  const hLines = haystack.split('\n');
  const nLines = needle.split('\n');
  const nNorm = _normalize(needle);
  if (!nNorm) return null;

  const windowMin = Math.max(1, Math.floor(nLines.length * 0.8));
  const windowMax = Math.ceil(nLines.length * 1.2);

  let best = null;
  for (let winSize = nLines.length; winSize >= windowMin && winSize <= windowMax; winSize += (winSize <= nLines.length ? -1 : 1)) {
    // Alternate: try exact line count first, then ±1, ±2, ...
    for (let i = 0; i <= hLines.length - winSize; i++) {
      const candidate = hLines.slice(i, i + winSize).join('\n');
      const cNorm = _normalize(candidate);
      if (!cNorm) continue;

      const dist = _levenshtein(nNorm, cNorm);
      const maxLen = Math.max(nNorm.length, cNorm.length);
      const sim = maxLen > 0 ? 1 - dist / maxLen : 1;

      if (sim >= 0.80 && (!best || sim > best.similarity)) {
        // Compute actual byte offsets in original haystack
        const startLine = i;
        const endLine = i + winSize;
        const before = hLines.slice(0, startLine).join('\n');
        const start = startLine === 0 ? 0 : before.length + 1; // +1 for the \n
        const matchStr = hLines.slice(startLine, endLine).join('\n');
        best = { match: matchStr, start, end: start + matchStr.length, similarity: sim };
      }
    }
    // If we already have a very good match, stop searching wider windows
    if (best && best.similarity >= 0.95) break;
  }

  return best;
}

// ── Tool definition ──────────────────────────────────────────────────

class FileEditTool extends BaseTool {
  static toolName = 'Edit';
  static category = 'filesystem';
  static risk = 'medium';
  static aliases = ['editFile', 'edit_file', 'replace'];
  static searchHint = 'edit modify replace text in file';
  static alwaysLoad = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Performs exact string replacements in files.

Usage:
- You must use the Read tool at least once before editing a file. This tool will error if you attempt an edit without reading the file.
- The file_path must be an absolute path.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Choose the smallest sufficient edit. Prefer changing the narrowest region that satisfies the task instead of rewriting broader blocks or whole files.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Copy old_string verbatim from the Read result. Preserve whitespace, indentation, and line breaks exactly.
- Prefer one focused replacement per call. If you need to change multiple unrelated regions, do multiple Edit calls instead of one oversized replacement.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Only add comments where the logic isn't self-evident. Don't add docstrings, comments, or type annotations to code you didn't change.
- Don't add features, refactor code, or make "improvements" beyond what was asked.
- Do not combine a requested fix with unrelated cleanup or cosmetic rewrites unless the task cannot be completed safely without them.` + this.weakModelToolNote();
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to modify',
        },
        old_string: {
          type: 'string',
          description: 'The text to replace (must be unique in the file unless replace_all is true)',
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with (must be different from old_string)',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences of old_string (default false)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview the edit without writing to disk (default false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    };
  }

  getActivityDescription(input) {
    const file = input.file_path ? path.basename(input.file_path) : 'file';
    return `编辑文件：${file}`;
  }

  getToolUseSummary(input) {
    if (!input.file_path) return null;
    const short = input.old_string
      ? input.old_string.slice(0, 40).replace(/\n/g, '\\n')
      : '';
    return `编辑 ${path.basename(input.file_path)}：\"${short}\"`;
  }

  async execute(params, _context) {
    const { file_path, old_string, new_string, replace_all, dry_run } = params;

    if (old_string === new_string) {
      return { success: false, error: 'old_string and new_string are identical — nothing to change.' };
    }

    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      let rawPath = file_path;
      if (rawPath.startsWith('~')) {
        rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      }
      const absPath = path.resolve(cwd, rawPath);

      if (!fs.existsSync(absPath)) {
        return { success: false, error: `File not found: ${absPath}` };
      }

      // ── 时间戳防覆盖守护（对标 CC readFileState）──────────────────
      const tracker = require('../_readTracker');
      if (!tracker.hasRead(absPath)) {
        return {
          success: false,
          error: 'You must Read this file before editing it. Use the Read tool first to see the current content.',
        };
      }
      const staleCheck = tracker.isStale(absPath);
      if (staleCheck.stale) {
        return { success: false, error: staleCheck.reason };
      }

      const original = fs.readFileSync(absPath, 'utf-8');

      // Pre-edit snapshot for /rollback recovery
      try {
        const fh = require('../../services/fileHistoryService');
        fh.takeSnapshot(absPath, { reason: 'FileEditTool', content: original });
      } catch { /* non-critical */ }

      // Pre-edit diagnostics baseline (CC beforeFileEdited 口径,门控 KHY_POST_EDIT_DIAGNOSTICS)。
      // 在写盘前(此刻磁盘仍是编辑前内容)给文件的语法诊断打基线,编辑后由 toolUseLoop 求「新增」。
      try {
        require('../../services/postEditDiagnostics').captureBaseline(absPath, cwd);
      } catch { /* diagnostics baseline is best-effort; never blocks the edit */ }

      // Count NON-OVERLAPPING occurrences — this must match the split().join()
      // replace below, which is non-overlapping. Stepping the cursor by 1 counted
      // OVERLAPPING matches, so a self-overlapping needle (e.g. "--" in "------",
      // "\n\n" across a blank-line run) reported more occurrences than were actually
      // replaced, and mis-reported "appears N times" when refusing a non-unique edit.
      // Step by old_string.length so `count` equals original.split(old_string).length-1.
      let count = 0;
      let idx = original.indexOf(old_string);
      while (idx !== -1) {
        count++;
        if (old_string.length === 0) break; // guard against empty-string infinite loop
        idx = original.indexOf(old_string, idx + old_string.length);
      }

      // ── Exact match path ───────────────────────────────────────────
      if (count > 0) {
        if (count > 1 && !replace_all) {
          return {
            success: false,
            error: `old_string appears ${count} times in the file. Provide more surrounding context to make it unique, or set replace_all: true to replace all occurrences.`,
            occurrences: count,
          };
        }

        let updated;
        if (replace_all) {
          updated = original.split(old_string).join(new_string);
        } else {
          const pos = original.indexOf(old_string);
          updated = original.slice(0, pos) + new_string + original.slice(pos + old_string.length);
        }

        const replacements = replace_all ? count : 1;
        if (dry_run) {
          return {
            success: true,
            file: absPath,
            replacements,
            dryRun: true,
            message: `[dry-run] Would replace ${replacements} occurrence${replacements > 1 ? 's' : ''} in ${path.basename(absPath)}`,
          };
        }
        fs.writeFileSync(absPath, updated, 'utf-8');
        // 刷新 readState 时间戳 — 防止连续编辑触发误报
        tracker.markRead(absPath);
        const result = {
          success: true,
          file: absPath,
          replacements,
          message: `Replaced ${replacements} occurrence${replacements > 1 ? 's' : ''} in ${path.basename(absPath)}`,
        };
        const diags = _collectLspDiagnostics(absPath);
        if (diags) result._lspDiagnostics = diags;
        return result;
      }

      // ── Fuzzy match fallback ───────────────────────────────────────
      // Only attempt fuzzy match when:
      //  - old_string is multi-line OR long enough to be meaningful (>20 chars)
      //  - replace_all is not set (fuzzy + replace_all is too risky)
      const isFuzzyCandidate = !replace_all && (old_string.includes('\n') || old_string.length > 20);
      if (isFuzzyCandidate) {
        const fuzzy = _fuzzyFind(original, old_string);
        if (fuzzy && fuzzy.similarity >= 0.80) {
          const updated = original.slice(0, fuzzy.start) + new_string + original.slice(fuzzy.end);
          const pct = Math.round(fuzzy.similarity * 100);
          if (dry_run) {
            return {
              success: true,
              file: absPath,
              replacements: 1,
              dryRun: true,
              fuzzyMatch: true,
              similarity: pct,
              matchedText: fuzzy.match.length > 200 ? fuzzy.match.slice(0, 200) + '...' : fuzzy.match,
              message: `[dry-run] Would fuzzy-replace in ${path.basename(absPath)} (${pct}% similarity)`,
            };
          }
          fs.writeFileSync(absPath, updated, 'utf-8');
          tracker.markRead(absPath);
          const fuzzyResult = {
            success: true,
            file: absPath,
            replacements: 1,
            fuzzyMatch: true,
            similarity: pct,
            matchedText: fuzzy.match.length > 200
              ? fuzzy.match.slice(0, 200) + '...'
              : fuzzy.match,
            message: `Fuzzy-matched and replaced in ${path.basename(absPath)} (${pct}% similarity). Matched text: "${fuzzy.match.length > 80 ? fuzzy.match.slice(0, 80) + '...' : fuzzy.match}"`,
          };
          const diags = _collectLspDiagnostics(absPath);
          if (diags) fuzzyResult._lspDiagnostics = diags;
          return fuzzyResult;
        }
      }

      // ── No match at all ────────────────────────────────────────────
      const preview = original.split('\n').slice(0, 10).join('\n');
      return {
        success: false,
        error: `old_string not found in ${path.basename(absPath)}. Ensure the text matches exactly (including whitespace and indentation). Use Read tool to see the current file content.`,
        preview: preview.length > 500 ? preview.slice(0, 500) + '...' : preview,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = new FileEditTool();
module.exports.FileEditTool = FileEditTool;
