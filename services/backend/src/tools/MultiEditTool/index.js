/**
 * MultiEditTool — atomic multi-block string editing, aligned with Claude Code's MultiEdit tool.
 *
 * Applies a sequence of exact string replacements to a single file in one
 * operation. Edits are applied sequentially: each edit operates on the result
 * of the previous edit (not the original content). The operation is all-or-
 * nothing — if any edit fails (no match, ambiguous match, identical strings,
 * etc.) the file is left untouched and a structured error is returned. Only
 * when every edit succeeds is the final content written to disk with a single
 * atomic fs.writeFileSync.
 *
 * This mirrors CC's MultiEdit precisely:
 *  - Sequential cumulative application (edit N sees edit N-1's output).
 *  - old_string must be unique unless replace_all is set.
 *  - new_string must differ from old_string.
 *  - No partial writes: a failure anywhere aborts the whole batch.
 *
 * Reuses FileEditTool's shared machinery: _readTracker read-gate + staleness,
 * fileHistoryService snapshot (one snapshot of the original for /rollback), the
 * KHYQUANT_CWD/~ path-resolution convention, and LSP diagnostics injection.
 */
// [AI-弱模型·照抄] 高危写工具:edits 顺序作用于上一步结果、全成或全不改;先 Read 再改,old_string
// 逐字照抄。prompt() 末尾的 this.weakModelToolNote() 注入别删;改本工具照 'tool-description' 位点。
const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');

// ── LSP diagnostics auto-inject (mirrors FileEditTool) ─────────────
const _collectLspDiagnostics = require('../../utils/collectLspDiagnostics');

class MultiEditTool extends BaseTool {
  static toolName = 'MultiEdit';
  static category = 'filesystem';
  static risk = 'medium';
  static aliases = ['multiEdit', 'multi_edit'];
  static searchHint = 'edit multiple blocks atomically in one file';
  static alwaysLoad = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `This is a tool for making multiple edits to a single file in one operation. It is built on top of the Edit tool and allows you to perform multiple find-and-replace operations efficiently. Prefer this tool over the Edit tool when you need to make multiple edits to the same file.

Before using this tool:
1. Use the Read tool to understand the file's contents and context. This tool will error if you attempt an edit without reading the file first.
2. Verify the directory path is correct.

To make multiple edits, provide:
1. file_path: The absolute path to the file to modify (required)
2. edits: An array of edit operations to perform, where each edit contains:
   - old_string: The text to replace (must match the file contents exactly, including all whitespace and indentation)
   - new_string: The edited text to replace the old_string
   - replace_all: Replace all occurrences of old_string. This parameter is optional and defaults to false.

IMPORTANT:
- All edits are applied in sequence, in the order they are provided.
- Each edit operates on the result of the previous edit.
- All edits must be valid for the operation to succeed — if any edit fails, none will be applied.
- This tool is the preferred way to edit a file when you want to make many changes at once.

CRITICAL REQUIREMENTS:
1. All edits follow the same requirements as the single Edit tool.
2. The edits are atomic — either all succeed, or none are applied.
3. Plan your edits carefully to avoid conflicts between sequential operations.

WARNING:
- The tool will fail if old_string does not match the (current, post-previous-edit) file contents exactly.
- The tool will fail if old_string and new_string are the same.
- Since edits are applied in sequence, ensure that earlier edits do not affect the text that later edits are trying to find.

When making edits:
- Ensure all edits result in idiomatic, correct code.
- Do not leave the code in a broken state.
- Use replace_all for renaming a variable across the file.` + this.weakModelToolNote();
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to modify',
        },
        edits: {
          type: 'array',
          description: 'Array of edit operations to perform sequentially on the file. Each edit is applied to the result of the previous edit.',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description: 'The text to replace (must be unique within the current file contents unless replace_all is true)',
              },
              new_string: {
                type: 'string',
                description: 'The text to replace it with (must be different from old_string)',
              },
              replace_all: {
                type: 'boolean',
                description: 'Replace all occurrences of old_string (default false)',
              },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['file_path', 'edits'],
    };
  }

  getActivityDescription(input) {
    const file = input.file_path ? path.basename(input.file_path) : 'file';
    const n = Array.isArray(input.edits) ? input.edits.length : 0;
    return `批量编辑文件：${file}（${n} 处）`;
  }

  getToolUseSummary(input) {
    if (!input.file_path) return null;
    const n = Array.isArray(input.edits) ? input.edits.length : 0;
    return `批量编辑 ${path.basename(input.file_path)}：${n} 处改动`;
  }

  async execute(params, _context) {
    const { file_path, edits } = params;

    if (!Array.isArray(edits) || edits.length === 0) {
      return { success: false, error: 'edits must be a non-empty array of { old_string, new_string, replace_all? }.' };
    }

    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      let rawPath = file_path;
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        return { success: false, error: 'file_path is required.' };
      }
      if (rawPath.startsWith('~')) {
        rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      }
      const absPath = path.resolve(cwd, rawPath);

      if (!fs.existsSync(absPath)) {
        return { success: false, error: `File not found: ${absPath}` };
      }

      // ── Read-gate + staleness guard (mirrors FileEditTool) ──────────
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

      // Pre-edit diagnostics baseline (CC beforeFileEdited 口径,门控 KHY_POST_EDIT_DIAGNOSTICS)。
      try {
        require('../../services/postEditDiagnostics').captureBaseline(absPath, cwd);
      } catch { /* diagnostics baseline is best-effort; never blocks the edit */ }

      // ── Apply every edit in-memory, all-or-nothing ──────────────────
      let working = original;
      let totalReplacements = 0;
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i] || {};
        const { old_string, new_string, replace_all } = edit;

        if (typeof old_string !== 'string' || typeof new_string !== 'string') {
          return { success: false, error: `Edit #${i + 1}: old_string and new_string must both be strings.` };
        }
        if (old_string === new_string) {
          return { success: false, error: `Edit #${i + 1}: old_string and new_string are identical — nothing to change.` };
        }

        // Count NON-OVERLAPPING occurrences in the CURRENT working buffer — this
        // must match the split().join() replace-all below, which is non-overlapping.
        // Stepping the cursor by 1 counted OVERLAPPING matches, over-reporting
        // occurrences (and totalReplacements) for self-overlapping needles ("--",
        // "\n\n", ...). Step by old_string.length instead.
        let count = 0;
        let idx = working.indexOf(old_string);
        while (idx !== -1) {
          count++;
          if (old_string.length === 0) break; // guard against empty-string infinite loop
          idx = working.indexOf(old_string, idx + old_string.length);
        }

        if (count === 0) {
          return {
            success: false,
            error: `Edit #${i + 1}: old_string not found in the file (after applying ${i} earlier edit${i === 1 ? '' : 's'}). Ensure the text matches exactly — including whitespace and indentation — and that an earlier edit did not already alter it.`,
            failedEditIndex: i,
          };
        }
        if (count > 1 && !replace_all) {
          return {
            success: false,
            error: `Edit #${i + 1}: old_string appears ${count} times. Provide more surrounding context to make it unique, or set replace_all: true.`,
            failedEditIndex: i,
            occurrences: count,
          };
        }

        if (replace_all) {
          working = working.split(old_string).join(new_string);
          totalReplacements += count;
        } else {
          const pos = working.indexOf(old_string);
          working = working.slice(0, pos) + new_string + working.slice(pos + old_string.length);
          totalReplacements += 1;
        }
      }

      if (working === original) {
        return { success: false, error: 'No effective change — the resulting content is identical to the original.' };
      }

      // ── Snapshot the ORIGINAL once, then atomic single write ────────
      try {
        const fh = require('../../services/fileHistoryService');
        fh.takeSnapshot(absPath, { reason: 'MultiEditTool', content: original });
      } catch { /* non-critical */ }

      fs.writeFileSync(absPath, working, 'utf-8');
      tracker.markRead(absPath);

      const result = {
        success: true,
        file: absPath,
        edits: edits.length,
        replacements: totalReplacements,
        message: `Applied ${edits.length} edit${edits.length > 1 ? 's' : ''} (${totalReplacements} replacement${totalReplacements > 1 ? 's' : ''}) to ${path.basename(absPath)}`,
      };
      const diags = _collectLspDiagnostics(absPath);
      if (diags) result._lspDiagnostics = diags;
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = new MultiEditTool();
module.exports.MultiEditTool = MultiEditTool;
