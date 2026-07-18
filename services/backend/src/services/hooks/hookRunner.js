/**
 * Hook Runner — executes hook commands as child processes.
 *
 * Each hook receives context as JSON on stdin and can:
 *   - Exit 0: allow (pass through)
 *   - Exit 2: block (prevent the action)
 *   - Emit JSON on stdout: modify the context
 */
const { spawn } = require('child_process');
const { platformShell, safeKill } = require('../../tools/platformUtils');

/**
 * Per-event whitelist of fields a COMMAND hook may merge into the loop context.
 *
 * Command hooks are user-configured child processes whose stdout is parsed as
 * arbitrary JSON — an untrusted surface. Without this gate, a command hook
 * returning e.g. {"iteration": 999} or {"toolName": "x"} could silently clobber
 * the loop's internal control fields and break later pattern-matched hooks.
 *
 * Function hooks are in-process trusted code (built-in guards + programmatic
 * registrations) and are intentionally NOT filtered here — they may carry
 * bespoke fields (see hook-lifecycle tests groups 7 & 10).
 *
 * Mirrors Claude Code's restricted HookResult fields (updatedInput /
 * additionalContext / preventContinuation) rather than a free-form merge.
 */
const CMD_HOOK_ALLOWED_FIELDS = {
  PreToolUse: ['params'],
  PostToolUse: ['result', 'preventContinuation', 'stopReason', 'additionalContext'],
  PrePrompt: ['prompt', 'additionalContext'],
  PostResponse: ['additionalContext'],
  PreCompact: ['additionalContext'],
  PostCompact: ['additionalContext'],
  Stop: ['stopReason'],
  SubAgentStart: [],
  SubAgentEnd: [],
};

/**
 * Filter a command hook's parsed JSON output down to the fields allowed for its
 * event. Dropped fields are reported on `_dropped` so the runner can warn.
 * @param {string} event
 * @param {Object} output - Parsed stdout JSON from a command hook
 * @returns {{ filtered: Object, dropped: string[] }}
 */
function filterCommandOutput(event, output) {
  if (!output || typeof output !== 'object') return { filtered: output, dropped: [] };
  const allowed = CMD_HOOK_ALLOWED_FIELDS[event];
  // Unknown event (should not happen — registry validates): pass through untouched.
  if (!allowed) return { filtered: output, dropped: [] };
  const filtered = {};
  const dropped = [];
  for (const key of Object.keys(output)) {
    if (allowed.includes(key)) filtered[key] = output[key];
    else dropped.push(key);
  }
  return { filtered, dropped };
}

/**
 * Run a single hook (command-based or function-based).
 * @param {Object} hook - Hook definition from registry
 * @param {Object} context - Event context (toolName, args, prompt, etc.)
 * @returns {Promise<{action: 'allow'|'block'|'modify', output?: Object, error?: string}>}
 */
async function runHook(hook, context) {
  // Function-based hooks: call directly
  if (hook.type === 'function' && typeof hook.handler === 'function') {
    return _runFunctionHook(hook, context);
  }

  // Command-based hooks: spawn child process
  return _runCommandHook(hook, context);
}

/**
 * Execute a function-based hook.
 * @private
 */
async function _runFunctionHook(hook, context) {
  let timer = null;
  try {
    const result = await Promise.race([
      Promise.resolve(hook.handler(context)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Hook function timed out')), hook.timeout || 10000);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);

    // Normalize return value
    if (!result || typeof result !== 'object') {
      return { action: 'allow' };
    }
    if (result.action === 'block') {
      // Preserve a guard's approval metadata so a soft block can be lifted by an
      // explicit user approval downstream. Without this, only `reason` survives
      // and an approvable block is indistinguishable from a hard security block.
      return {
        action: 'block',
        error: result.reason || 'Blocked by function hook',
        approvable: !!result.approvable,
        source: result.source,
      };
    }
    if (result.action === 'modify') {
      const { action, ...overrides } = result;
      return { action: 'modify', output: overrides };
    }
    return { action: result.action || 'allow', output: result };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { action: 'allow', error: err.message };
  }
}

/**
 * Execute a command-based hook via child process.
 * @private
 */
async function _runCommandHook(hook, context) {
  const HOOK_MAX_BUFFER = 512 * 1024; // 512 KB max per stream
  const hookTimeoutMs = hook.timeout || 10000;
  return new Promise((resolve) => {
    const sh = platformShell(hook.command);
    const child = spawn(sh.cmd, sh.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOOK_EVENT: hook.event },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      resolve(result);
    };

    // Manual timeout — spawn()'s `timeout` option is unreliable
    let killTimer = setTimeout(() => {
      if (settled) return;
      try { safeKill(child, 'SIGKILL', 0); } catch { /* ignore */ }
      finish({ action: 'allow', error: `Hook timed out after ${hookTimeoutMs}ms` });
    }, hookTimeoutMs);
    killTimer.unref?.();

    child.stdout.on('data', d => {
      if (stdout.length < HOOK_MAX_BUFFER) stdout += d;
    });
    child.stderr.on('data', d => {
      if (stderr.length < HOOK_MAX_BUFFER) stderr += d;
    });

    child.on('error', (err) => {
      finish({ action: 'allow', error: err.message });
    });

    child.on('close', (code) => {
      if (code === 2) {
        return finish({ action: 'block', error: stderr.trim() || 'Blocked by hook' });
      }

      let output;
      if (stdout.trim()) {
        try {
          output = JSON.parse(stdout.trim());
        } catch { /* not JSON, ignore */ }
      }

      // Contain untrusted command-hook JSON: only event-whitelisted fields may
      // reach the loop context. Dropped fields are surfaced as a warning.
      let dropWarning;
      if (output) {
        const { filtered, dropped } = filterCommandOutput(hook.event, output);
        output = filtered;
        if (dropped.length > 0) {
          dropWarning = `Command hook for ${hook.event} attempted to set disallowed field(s): ${dropped.join(', ')}`;
          console.warn(`[HookRunner] ${dropWarning}`);
        }
      }

      finish({
        action: (output && Object.keys(output).length > 0) ? 'modify' : 'allow',
        output,
        error: code !== 0 ? (stderr.trim() || `Hook exited with code ${code}`) : dropWarning,
      });
    });

    // Send context as JSON on stdin
    try {
      child.stdin.write(JSON.stringify(context));
      child.stdin.end();
    } catch { /* broken pipe is fine */ }
  });
}

// ── Hook Execution Telemetry ──────────────────────────────────────

const _hookMetrics = []; // [{hookSource, event, durationMs, action, error?}]
const HOOK_METRICS_MAX = 500;

/**
 * Fault-isolated hook runner — wraps runHook to guarantee:
 *   1. No thrown error propagates
 *   2. Malformed results are normalized to { action: 'allow' }
 *   3. Execution timing is recorded for telemetry
 * @param {Object} hook - Hook definition
 * @param {Object} context - Event context
 * @returns {Promise<{action: 'allow'|'block'|'modify', output?: Object, error?: string}>}
 */
async function safeRunHook(hook, context) {
  const start = Date.now();
  try {
    const result = await runHook(hook, context);
    const duration = Date.now() - start;
    _hookMetrics.push({ hookSource: hook.source || hook.command || 'unknown', event: hook._event || hook.event, durationMs: duration, action: result?.action || 'allow' });
    if (_hookMetrics.length > HOOK_METRICS_MAX) _hookMetrics.splice(0, _hookMetrics.length - HOOK_METRICS_MAX);
    if (!result || typeof result.action !== 'string') {
      return { action: 'allow', error: 'Hook returned invalid result' };
    }
    return result;
  } catch (err) {
    const duration = Date.now() - start;
    _hookMetrics.push({ hookSource: hook.source || hook.command || 'unknown', event: hook._event || hook.event, durationMs: duration, action: 'allow', error: err.message });
    if (_hookMetrics.length > HOOK_METRICS_MAX) _hookMetrics.splice(0, _hookMetrics.length - HOOK_METRICS_MAX);
    return { action: 'allow', error: `Hook crash: ${err.message}` };
  }
}

/**
 * Get hook execution metrics for telemetry/observability.
 * @returns {Array<{hookSource: string, event: string, durationMs: number, action: string, error?: string}>}
 */
function getHookMetrics() {
  return [..._hookMetrics];
}

/**
 * Run all hooks for an event sequentially.
 * Returns the final context (potentially modified) and whether to proceed.
 */
async function runHooks(hooks, context) {
  let ctx = { ...context };

  for (const hook of hooks) {
    const result = await safeRunHook(hook, ctx);

    if (result.action === 'block') {
      // Carry the guard's approval metadata to the caller. A truthy `approvable`
      // means an interactive host may turn this block into a user-approval prompt
      // (soft guard); absent/false keeps it a hard, unbypassable block.
      return {
        blocked: true,
        reason: result.error,
        approvable: !!result.approvable,
        source: result.source,
        context: ctx,
      };
    }

    if (result.action === 'modify' && result.output) {
      ctx = { ...ctx, ...result.output };
    }
  }

  return { blocked: false, context: ctx };
}

module.exports = { runHook, safeRunHook, runHooks, getHookMetrics, filterCommandOutput, CMD_HOOK_ALLOWED_FIELDS, _hookMetrics };
