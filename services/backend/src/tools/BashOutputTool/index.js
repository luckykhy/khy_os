const { BaseTool } = require('../_baseTool');

/**
 * BashOutputTool — read the output of a background shell command on demand.
 *
 * WHY THIS EXISTS (the real gap it fills):
 *   shellCommand's `run_in_background:true` starts a fire-and-forget shell and
 *   registers it in backgroundShellRegistry, returning only a `backgroundTaskId`
 *   and "已在后台启动命令…". The registry was WRITE-ONLY from the model's view —
 *   its ONLY consumer was the auto-drain that emits a one-shot <task_notification>
 *   when the shell finishes. There was NO way to ASK for a specific background
 *   shell's output on demand (the "started a bg shell, now let me read it" hole).
 *   This mirrors Claude Code's BashOutput tool against khy's existing registry.
 *
 * Reads go through backgroundShellRegistry.backgroundShells (the same SSOT the
 * producer writes and the drain reads), so no producer change is needed. The
 * drain only marks entries `notified=true` in place (never deletes), so an
 * on-demand read still works after the auto-notification fired.
 *
 * HONEST BOUNDARY (deliberate): khy background shells do NOT stream incrementally
 * — an entry's output is populated as a whole in `result.output` only once the
 * shell reaches a terminal state (completed/failed). So while running there is no
 * partial output to return, and block-mode simply waits for completion up to the
 * timeout (no activity-based idle reset, because there is no incremental signal).
 *
 * Gate: KHY_BASH_OUTPUT_TOOL (default ON). Off → tool is not registered
 * (isEnabled() === false), a byte-identical fallback to today's behavior.
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function bashOutputToolEnabled(env) {
  const e = env || process.env;
  const raw = String(e.KHY_BASH_OUTPUT_TOOL == null ? '' : e.KHY_BASH_OUTPUT_TOOL).trim().toLowerCase();
  return !OFF_VALUES.includes(raw);
}

class BashOutputTool extends BaseTool {
  static toolName = 'BashOutput';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['bash_output', 'get_bash_output', 'shell_output'];
  static searchHint = 'read background shell command output result';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }
  isEnabled() { return bashOutputToolEnabled(process.env); }

  prompt() {
    return `Retrieve output from a running or completed background shell command.
- Takes a bash_id parameter (the backgroundTaskId returned when the shell was started with run_in_background:true)
- Returns the shell's output, exit code, and status
- Use block=true (default) to wait for the command to finish
- Use block=false for a non-blocking check of the current status
- Output is available once the command finishes; while running there is no partial output`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        bash_id: { type: 'string', description: 'The background shell id (backgroundTaskId) to read output from' },
        block: { type: 'boolean', description: 'Whether to wait for completion (default true)', default: true },
        timeout: { type: 'number', description: 'Max wait time in ms (default 30000)', default: 30000, minimum: 0, maximum: 600000 },
      },
      required: ['bash_id'],
    };
  }

  async execute(params) {
    if (!bashOutputToolEnabled(process.env)) {
      return { error: 'BashOutput is disabled (KHY_BASH_OUTPUT_TOOL=off).' };
    }

    const id = params && params.bash_id != null ? String(params.bash_id) : '';
    if (!id) return { error: 'bash_id is required.' };

    let registry;
    try {
      registry = require('../backgroundShellRegistry').backgroundShells;
    } catch (e) {
      return { error: 'background shell registry unavailable: ' + ((e && e.message) || e) };
    }

    const entry = registry.get(id);
    if (!entry) return { error: `Background shell ${id} not found` };

    const block = params.block !== false;
    const timeoutMs = Math.max(0, Math.min(Number(params.timeout) || 30000, 600000));

    // Block-mode: wait for a terminal state (no incremental output to reset on).
    if (block && entry.status === 'running' && timeoutMs > 0) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = registry.get(id);
        if (!current || current.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const current = registry.get(id) || entry;
    const result = current.result && typeof current.result === 'object' ? current.result : null;
    return {
      bash_id: id,
      status: current.status,
      command: current.command || null,
      output: result && result.output != null ? result.output : null,
      exitCode: result && result.exitCode != null ? result.exitCode : null,
      error: current.error != null ? current.error : null,
    };
  }

  getActivityDescription(input) { return `读取后台命令输出：${input && input.bash_id ? input.bash_id : ''}`; }
}

module.exports = BashOutputTool;
module.exports.bashOutputToolEnabled = bashOutputToolEnabled;
