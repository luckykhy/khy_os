/**
 * Print-mode output formatting — Claude Code SDK alignment.
 *
 * Mirrors `claude -p "<query>" --output-format <text|json|stream-json>` so that
 * khy's non-interactive print mode produces a machine-parseable contract usable
 * from scripts, pipelines and CI (the documented SDK automation surface).
 *
 *   text          plain reply text only (default — backward compatible)
 *   json          one structured `result` object with run metadata
 *   stream-json    NDJSON: init system msg → user msg → assistant msg → result
 *
 * Pure / leaf module: NO I/O, NO process access. The bin layer (`bin/khy.js`)
 * parses flags via {@link parsePrintFlags}, runs `chat()`, then renders the
 * payload via {@link render} and writes the returned string itself. This keeps
 * the formatting deterministic and unit-testable.
 *
 * Result schema follows the Claude Code contract verbatim:
 *   {
 *     "type": "result",
 *     "subtype": "success" | "error_max_turns" | "error_during_execution",
 *     "total_cost_usd": <number>,
 *     "is_error": <boolean>,
 *     "duration_ms": <number>,
 *     "duration_api_ms": <number>,
 *     "num_turns": <number>,
 *     "result": "<reply text>",
 *     "session_id": "<id>"
 *   }
 */

'use strict';

const VALID_FORMATS = ['text', 'json', 'stream-json'];
const DEFAULT_FORMAT = 'text';

/**
 * Parse print-mode flags out of an argv-style array.
 *
 * Recognised:
 *   --output-format <text|json|stream-json>
 *   --max-turns <n>              (positive integer; capped at 100 to match the loop)
 *   --system-prompt <text>       (override the static base system prompt)
 *   --append-system-prompt <text>(append extra guidance to the system prompt)
 *   --allowedTools <list>        (allowlist; only these tools are exposed)
 *   --disallowedTools <list>     (denylist; these tools are removed — wins)
 *   --continue, -c               (continue the most-recent persisted session)
 *   --resume <id>, -r <id>       (resume a specific persisted session by id)
 *   --output-schema <json|@file> (caller JSON Schema for StructuredOutput; bin layer
 *                                 resolves `@file` → exports KHY_OUTPUT_SCHEMA)
 *
 * Tool lists accept comma- and/or space-separated names, matching the Claude
 * Code SDK (e.g. `--allowedTools "Read,Write Bash"`). All flags (and their
 * values) are stripped from the returned `args` so the remaining tokens form the
 * prompt. Unknown `--output-format` values are reported via `error` instead of
 * throwing — the caller decides how to exit.
 *
 * `--continue`/`--resume` give the headless `-p` path Claude Code's cross-session
 * multi-turn contract: prior conversation history is hydrated into the chat path
 * before the new prompt runs. `--resume <id>` (explicit transcript) wins over a
 * bare `--continue` (most-recent) when both are present.
 *
 * @param {string[]} argv
 * @returns {{format:string, maxTurns:(number|null), systemPrompt:(string|null), appendSystemPrompt:(string|null), allowedTools:(string[]|null), disallowedTools:(string[]|null), continueSession:boolean, resumeSessionId:(string|null), outputSchema:(string|null), args:string[], error:(string|null)}}
 */
function parsePrintFlags(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  let format = DEFAULT_FORMAT;
  let maxTurns = null;
  let systemPrompt = null;
  let appendSystemPrompt = null;
  let allowedTools = null;
  let disallowedTools = null;
  let continueSession = false;
  let resumeSessionId = null;
  let outputSchema = null;
  let error = null;

  // Split a tool-list flag value on commas and/or whitespace, dropping empties.
  const parseToolList = (val) => String(val).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

  const out = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--output-format') {
      const val = args[i + 1];
      if (val === undefined) {
        error = 'flag --output-format requires a value (text|json|stream-json)';
        break;
      }
      if (!VALID_FORMATS.includes(val)) {
        error = `invalid --output-format "${val}" (expected text|json|stream-json)`;
        break;
      }
      format = val;
      i++; // consume value
      continue;
    }
    if (tok && tok.startsWith('--output-format=')) {
      const val = tok.slice('--output-format='.length);
      if (!VALID_FORMATS.includes(val)) {
        error = `invalid --output-format "${val}" (expected text|json|stream-json)`;
        break;
      }
      format = val;
      continue;
    }
    if (tok === '--max-turns') {
      const val = args[i + 1];
      const n = Number.parseInt(val, 10);
      if (!Number.isFinite(n) || n < 1) {
        error = 'flag --max-turns requires a positive integer';
        break;
      }
      maxTurns = Math.min(100, n);
      i++; // consume value
      continue;
    }
    if (tok && tok.startsWith('--max-turns=')) {
      const n = Number.parseInt(tok.slice('--max-turns='.length), 10);
      if (!Number.isFinite(n) || n < 1) {
        error = 'flag --max-turns requires a positive integer';
        break;
      }
      maxTurns = Math.min(100, n);
      continue;
    }
    if (tok === '--system-prompt') {
      if (args[i + 1] === undefined) { error = 'flag --system-prompt requires a value'; break; }
      systemPrompt = args[++i];
      continue;
    }
    if (tok && tok.startsWith('--system-prompt=')) {
      systemPrompt = tok.slice('--system-prompt='.length);
      continue;
    }
    if (tok === '--append-system-prompt') {
      if (args[i + 1] === undefined) { error = 'flag --append-system-prompt requires a value'; break; }
      appendSystemPrompt = args[++i];
      continue;
    }
    if (tok && tok.startsWith('--append-system-prompt=')) {
      appendSystemPrompt = tok.slice('--append-system-prompt='.length);
      continue;
    }
    if (tok === '--allowedTools' || tok === '--allowed-tools') {
      if (args[i + 1] === undefined) { error = 'flag --allowedTools requires a value'; break; }
      allowedTools = parseToolList(args[++i]);
      continue;
    }
    if (tok && (tok.startsWith('--allowedTools=') || tok.startsWith('--allowed-tools='))) {
      allowedTools = parseToolList(tok.slice(tok.indexOf('=') + 1));
      continue;
    }
    if (tok === '--disallowedTools' || tok === '--disallowed-tools') {
      if (args[i + 1] === undefined) { error = 'flag --disallowedTools requires a value'; break; }
      disallowedTools = parseToolList(args[++i]);
      continue;
    }
    if (tok && (tok.startsWith('--disallowedTools=') || tok.startsWith('--disallowed-tools='))) {
      disallowedTools = parseToolList(tok.slice(tok.indexOf('=') + 1));
      continue;
    }
    if (tok === '--continue' || tok === '-c') {
      continueSession = true;
      continue;
    }
    if (tok === '--resume' || tok === '-r') {
      const val = args[i + 1];
      if (val === undefined) { error = 'flag --resume requires a session id'; break; }
      resumeSessionId = String(val);
      i++; // consume value
      continue;
    }
    if (tok && tok.startsWith('--resume=')) {
      const val = tok.slice('--resume='.length);
      if (!val) { error = 'flag --resume requires a session id'; break; }
      resumeSessionId = val;
      continue;
    }
    // --output-schema <json|@file>: caller-supplied JSON Schema for StructuredOutput.
    // Leaf stays IO-free — the raw value (inline JSON or `@path`) is returned verbatim;
    // the bin layer resolves `@file` and exports it as KHY_OUTPUT_SCHEMA for the tool.
    if (tok === '--output-schema') {
      if (args[i + 1] === undefined) { error = 'flag --output-schema requires a value (inline JSON or @file)'; break; }
      outputSchema = String(args[++i]);
      continue;
    }
    if (tok && tok.startsWith('--output-schema=')) {
      outputSchema = tok.slice('--output-schema='.length);
      continue;
    }
    out.push(tok);
  }

  return { format, maxTurns, systemPrompt, appendSystemPrompt, allowedTools, disallowedTools, continueSession, resumeSessionId, outputSchema, args: out, error };
}

/**
 * Best-effort USD cost extraction. khy runs predominantly free / local / BYO-key
 * providers, so cost is usually unknown → 0. Honour an explicit cost field when a
 * gateway adapter happens to provide one.
 * @param {object|null} tokenUsage
 * @returns {number}
 */
function extractCostUsd(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return 0;
  const candidates = [tokenUsage.costUsd, tokenUsage.totalCostUsd, tokenUsage.total_cost_usd, tokenUsage.cost];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * Decide the result subtype following the Claude Code contract.
 * @param {{errorType:string, maxTurnsHit:boolean}} ctx
 * @returns {'success'|'error_max_turns'|'error_during_execution'}
 */
function deriveSubtype({ errorType, maxTurnsHit }) {
  if (maxTurnsHit) return 'error_max_turns';
  if (errorType) return 'error_during_execution';
  return 'success';
}

/**
 * Was the run terminated by the max-turns / max-iterations safety limit?
 * @param {object} chatResult
 * @param {(number|null)} maxTurns
 * @returns {boolean}
 */
function detectMaxTurnsHit(chatResult, maxTurns) {
  // Authoritative loop signal wins. runToolUseLoop returns { maxIterationsReached:true } when it
  // hits its *internal* cap (e.g. 10) — but a default run passes no --max-turns, so the maxTurns
  // short-circuit below would miss it and report "success". The bin layer sets an explicit
  // `maxTurnsHit` on the result (only when KHY_HEADLESS_EXIT_ON_LIMIT is on) so this surface can
  // honour it independently of ctx.maxTurns. Field absent → byte-identical to prior behaviour.
  if (chatResult && chatResult.maxTurnsHit === true) return true;
  if (!maxTurns) return false;
  const stop = String((chatResult && chatResult.stopReason) || '').toLowerCase();
  if (/max[_-]?(iter|turn)/.test(stop)) return true;
  const turns = countTurns(chatResult);
  return turns >= maxTurns;
}

/**
 * Resolve the process exit code for a print-mode run (pure — the bin layer calls process.exit).
 *   errorType present              → 2  (hard failure during execution; existing behaviour)
 *   stopped by iteration/turn limit → 3  (incomplete-but-not-error; retryable) — ONLY when
 *                                        opts.limitExitEnabled (KHY_HEADLESS_EXIT_ON_LIMIT)
 *   otherwise                      → 0  (clean success)
 *
 * Default (limitExitEnabled falsy) is byte-identical to the prior `errorType ? 2 : 0` rule, so a
 * limit-stopped run keeps exiting 0 unless the caller opts in. Distinct code 3 lets scripts tell a
 * retryable "ran out of steps" apart from a hard error (2).
 * @param {object} chatResult
 * @param {{limitExitEnabled?:boolean}} [opts]
 * @returns {0|2|3}
 */
function resolveExitCode(chatResult, opts = {}) {
  const r = chatResult || {};
  if (r.errorType) return 2;
  if (opts && opts.limitExitEnabled) {
    if (r.maxIterationsReached === true || r.maxTurnsHit === true || r.stoppedByLimit === true) return 3;
  }
  return 0;
}

/**
 * Number of agent turns: one trailing model turn plus each tool round.
 * @param {object} chatResult
 * @returns {number}
 */
function countTurns(chatResult) {
  const log = chatResult && chatResult.toolCallLog;
  const toolRounds = Array.isArray(log) ? log.length : 0;
  return toolRounds + 1;
}

/**
 * Build the terminal `result` message.
 * @param {object} chatResult  return value of ai.chat()
 * @param {object} [ctx]       { sessionId, maxTurns, apiMs }
 * @returns {object}
 */
function buildResultMessage(chatResult, ctx = {}) {
  const r = chatResult || {};
  const errorType = r.errorType ? String(r.errorType) : '';
  const maxTurnsHit = detectMaxTurnsHit(r, ctx.maxTurns);
  const durationMs = Number.isFinite(r.elapsed) ? r.elapsed : (Number.isFinite(ctx.durationMs) ? ctx.durationMs : 0);
  return {
    type: 'result',
    subtype: deriveSubtype({ errorType, maxTurnsHit }),
    total_cost_usd: extractCostUsd(r.tokenUsage),
    is_error: !!errorType || maxTurnsHit,
    duration_ms: durationMs,
    duration_api_ms: Number.isFinite(ctx.apiMs) ? ctx.apiMs : durationMs,
    num_turns: countTurns(r),
    result: String(r.reply == null ? '' : r.reply),
    session_id: String(ctx.sessionId || ''),
  };
}

/**
 * Build the leading `system/init` message for stream-json.
 * @param {object} [ctx] { sessionId, cwd, tools, model, permissionMode }
 * @returns {object}
 */
function buildInitMessage(ctx = {}) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: String(ctx.sessionId || ''),
    cwd: String(ctx.cwd || ''),
    tools: Array.isArray(ctx.tools) ? ctx.tools : [],
    mcp_servers: Array.isArray(ctx.mcpServers) ? ctx.mcpServers : [],
    model: String(ctx.model || ''),
    permissionMode: ctx.permissionMode || 'default',
  };
}

/**
 * Render the chat result for a given output format.
 * Returns the full string to write to stdout (no trailing newline added for
 * `text`; the caller appends one to match prior behaviour).
 *
 * @param {string} format  'text' | 'json' | 'stream-json'
 * @param {object} chatResult
 * @param {object} [ctx]    { sessionId, cwd, tools, model, prompt, maxTurns }
 * @returns {string}
 */
function render(format, chatResult, ctx = {}) {
  const r = chatResult || {};
  if (format === 'json') {
    return JSON.stringify(buildResultMessage(r, ctx));
  }
  if (format === 'stream-json') {
    const lines = [
      JSON.stringify(buildInitMessage(ctx)),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: String(ctx.prompt || '') },
        session_id: String(ctx.sessionId || ''),
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: String(r.reply == null ? '' : r.reply) },
        session_id: String(ctx.sessionId || ''),
      }),
      JSON.stringify(buildResultMessage(r, ctx)),
    ];
    return lines.join('\n');
  }
  // default: text
  return String(r.reply == null ? '' : r.reply);
}

module.exports = {
  VALID_FORMATS,
  DEFAULT_FORMAT,
  parsePrintFlags,
  extractCostUsd,
  deriveSubtype,
  detectMaxTurnsHit,
  resolveExitCode,
  countTurns,
  buildResultMessage,
  buildInitMessage,
  render,
};
