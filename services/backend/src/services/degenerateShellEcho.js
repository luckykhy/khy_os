'use strict';

// degenerateShellEcho — drop no-op "echo of prose" shell dispatches before they
// run.
//
// Observed failure (real transcript, a "讲个笑话" turn): the model dispatched
//   shell_command { command: 'echo "好的，给你讲个笑话："' }
// three times. A bare `echo` of a natural-language sentence — no redirection,
// pipe, chaining, or substitution — has NO side effect and yields NO information
// the model didn't already write; it just reprints its own prose. Running it is
// pointless, and re-dispatching the identical call is what tripped the
// ToolCallGuardrail ("identical result 2 times — blocking to prevent loop") and
// burned 2m33s on a text-only task.
//
// This leaf filters such calls out of the toolCalls array pre-dispatch. When it
// removes the only call, the loop sees zero tool calls and delivers the model's
// text reply directly — exactly the right outcome for a conversational turn.
//
// PURE LEAF: no requires, env-gated, fail-soft, unit-testable. It NEVER touches
// an echo with any shell operator (`>`, `>>`, `<`, `|`, `&`, `;`, `$(`, `${`,
// `$VAR`, backtick, or a backslash escape) — those echoes have real purpose
// (write a file, feed a pipe, expand a variable) and are always kept.
//
// Env gate (default ON, `0/false/off/no` disables — byte-reverts):
//   KHY_DROP_DEGENERATE_ECHO

function _flagEnabled(rawValue, defaultValue = true) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return defaultValue;
  const v = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(v)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(v)) return false;
  return defaultValue;
}

function degenerateEchoFilterEnabled(env = process.env) {
  return _flagEnabled(env && env.KHY_DROP_DEGENERATE_ECHO, true);
}

const _SHELL_NAMES = new Set(['shell_command', 'shellcommand', 'bash', 'shell', 'command']);
function _isShellCall(call) {
  if (!call || typeof call !== 'object') return false;
  const name = String(call.name || '').toLowerCase().replace(/[\s_-]/g, '');
  return _SHELL_NAMES.has(name);
}
function _commandOf(call) {
  const p = call && call.params;
  if (!p || typeof p !== 'object') return '';
  return String(p.command ?? p.cmd ?? '').trim();
}

// Any of these gives an echo a real effect or an information purpose → keep it.
//   > >> <   redirection (writes/reads a file)
//   |        pipe (feeds another command)
//   & ; &&|| command chaining / backgrounding
//   $( ) ` ${} $VAR   substitution / variable expansion (dynamic content)
//   \        an escape sequence (echo -e "a\nb"), or a path — treat as meaningful
const _MEANINGFUL_OP_RE = /[>|<&;`\\]|\$\(|\$\{|\$[A-Za-z_]/;

// Strip a leading `echo` plus any run of its flags (-e -n -E, combined or not).
const _ECHO_HEAD_RE = /^echo(?:\s+-[eEn]+)*\s*/i;

/**
 * A command is a degenerate prose-echo when it is a single `echo` of a
 * natural-language payload with no shell operators. "Prose" is signalled by CJK
 * characters or by whitespace inside the payload (a multi-word sentence). A bare
 * single-token echo like `echo done` is NOT degenerate here (kept conservatively
 * — some scripts use it as a sentinel marker).
 */
function isDegenerateProseEcho(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (!/^echo\b/i.test(cmd)) return false;
  if (_MEANINGFUL_OP_RE.test(cmd)) return false;
  let payload = cmd.replace(_ECHO_HEAD_RE, '').trim();
  if (!payload) return false; // `echo` with no args — not our case, leave it
  // Strip one layer of surrounding matched quotes.
  if ((payload.startsWith('"') && payload.endsWith('"') && payload.length >= 2)
    || (payload.startsWith("'") && payload.endsWith("'") && payload.length >= 2)) {
    payload = payload.slice(1, -1);
  }
  if (!payload.trim()) return false;
  const hasCjk = /[一-鿿　-〿＀-￯]/.test(payload);
  const hasSpace = /\s/.test(payload.trim());
  return hasCjk || hasSpace;
}

// Whole-command no-ops the model sometimes dispatches on a text turn — each has
// NO side effect and produces NO information, so running it only burns a turn:
//   true   the true builtin: always exits 0, prints nothing
//   :      the shell null command: same as true
//   cat    bare `cat` with NO args reads stdin and BLOCKS forever (a hang, not a
//          read) — dropping it also avoids a wedged tool call
// Case-sensitive exact token match (shell builtins are lowercase). Anything with
// a shell operator is kept by the shared bail-out — `true > f` truncates a file,
// `cat << EOF` is a heredoc, `true && ls` chains — those carry real purpose.
const _BARE_NO_OP_COMMANDS = new Set(['true', ':', 'cat']);
function _isBareNoOpCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (_MEANINGFUL_OP_RE.test(cmd)) return false; // has real effect → keep
  return _BARE_NO_OP_COMMANDS.has(cmd); // exact whole command, no args
}

/**
 * The union predicate both dispatch layers consume: a command is a degenerate
 * no-op when it is a prose echo OR a bare whole-command no-op (`true`/`:`/`cat`).
 */
function isDegenerateNoOp(command) {
  return isDegenerateProseEcho(command) || _isBareNoOpCommand(command);
}

/**
 * Return a NEW array with degenerate prose-echo shell calls removed. Also
 * returns how many were dropped (for optional logging). Fail-soft: on any error,
 * or when the gate is off, the original array is returned unchanged (byte
 * revert).
 */
function filterDegenerateEchoCalls(toolCalls, env = process.env) {
  if (!Array.isArray(toolCalls)) return { toolCalls, dropped: 0 };
  if (!degenerateEchoFilterEnabled(env)) return { toolCalls, dropped: 0 };
  try {
    let dropped = 0;
    const kept = toolCalls.filter((call) => {
      if (!_isShellCall(call)) return true;
      if (isDegenerateNoOp(_commandOf(call))) {
        dropped += 1;
        return false;
      }
      return true;
    });
    if (dropped === 0) return { toolCalls, dropped: 0 };
    return { toolCalls: kept, dropped };
  } catch {
    return { toolCalls, dropped: 0 };
  }
}

module.exports = {
  filterDegenerateEchoCalls,
  isDegenerateProseEcho,
  isDegenerateNoOp,
  degenerateEchoFilterEnabled,
};
