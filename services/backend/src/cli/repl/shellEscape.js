'use strict';

/**
 * `!` shell escape cluster extracted from replSession.js (T-020 B4a).
 *
 * Owns, verbatim from the former startRepl() closure:
 *   - pending-escape queue state (fully encapsulated — the closure had zero
 *     external references to it; callers only touch the three functions)
 *   - runShellEscape: `!<cmd>` executes through the single cross-platform
 *     shell tool (Windows UTF-8 / idle-timeout / truncation included) so the
 *     output the AI sees matches what a tool call would get
 *   - enqueueShellEscapeContext / drainShellEscapeContext: queue → tagged
 *     context block consumed once per turn, capped by KHY_SHELL_ESCAPE_CTX_MAX
 *
 * The human-typed command bypasses tool approval by definition (the user typed
 * it), but flows through the same shell tool as AI-driven calls.
 *
 * deps.formatShellEscapeContext arrives pre-injected (setReplSessionDeps runs
 * at host load, before startRepl is ever invoked).
 */

function createShellEscape({ c, formatShellEscapeContext }) {
  const pending = []; // queued {command, body, code} → injected as leading context next turn
  const CTX_MAX = parseInt(process.env.KHY_SHELL_ESCAPE_CTX_MAX || '8000', 10) || 8000;

  async function _runShellEscape(command) {
    console.log(c.hex('#FF8C42').bold(`! ${command}`));
    let result;
    try {
      const shellTool = require('../../tools/shellCommand');
      result = await shellTool.execute({ command }, {});
    } catch (err) {
      result = { success: false, error: err && err.message ? err.message : String(err) };
    }
    const body = String((result && (result.output || result.error)) || '').replace(/\s+$/, '');
    const code =
      result && Number.isFinite(result.exitCode)
        ? result.exitCode
        : result && result.success
          ? 0
          : 1;
    if (body) {
      console.log(body);
    } else {
      console.log(c.dim('(无输出)'));
    }
    if (!result || !result.success) {
      console.log(c.hex('#FF6B6B')(`  └ 退出码 ${code}`));
    }
    return { command, body: body || '(无输出)', code, success: !!(result && result.success) };
  }

  function _enqueueShellEscapeContext(rec) {
    if (rec && rec.command) {
      pending.push(rec);
    }
  }

  // Drain queued escapes into a single tagged context block (consumed once per
  // turn). Returns '' when nothing is queued. Total size is capped so a chatty
  // command (`!find /`) cannot blow the context budget.
  function _drainShellEscapeContext() {
    const block = formatShellEscapeContext(pending, CTX_MAX);
    pending.length = 0;
    return block;
  }

  return { _runShellEscape, _enqueueShellEscapeContext, _drainShellEscapeContext };
}

module.exports = { createShellEscape };
