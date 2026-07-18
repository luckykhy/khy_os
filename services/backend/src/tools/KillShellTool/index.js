const { BaseTool } = require('../_baseTool');

/**
 * KillShellTool — terminate a still-running background shell command by id.
 *
 * WHY THIS EXISTS (the real gap it fills — sibling to BashOutput):
 *   shellCommand's `run_in_background:true` starts a fire-and-forget shell and
 *   registers it in backgroundShellRegistry. 刀89 (BashOutput) exposed the READ
 *   side of that half-wired substrate; this exposes the KILL side. Before this,
 *   a background command that hangs or is no longer wanted could only be waited
 *   out (idle-timeout) — there was NO way to ASK for it to be terminated on
 *   demand. This mirrors Claude Code's KillBash/KillShell tool.
 *
 *   The kill is possible because the producer now retains the child handle on the
 *   registry entry (entry.child / entry.pid, via spawnWithIdleTimeout's additive
 *   onChild hook). We terminate via platformUtils.safeKill (process-tree kill with
 *   graceful fallback). The child's own 'close' handler then settles the entry to
 *   'failed'/'completed' and populates whatever partial output was captured — so a
 *   subsequent BashOutput read reflects the termination honestly.
 *
 * HONEST BOUNDARY (deliberate): we do not fabricate a terminal state here — we
 * send the kill and report that it was requested; the entry's final status/output
 * settle through the existing close path. If the shell is already terminal there
 * is nothing to kill (reported as such). If the entry predates this build and has
 * no retained handle, we say so rather than pretend success.
 *
 * Gate: KHY_KILL_SHELL_TOOL (default ON). Off → tool is not registered
 * (isEnabled() === false), a byte-identical fallback to today's behavior.
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function killShellToolEnabled(env) {
  const e = env || process.env;
  const raw = String(e.KHY_KILL_SHELL_TOOL == null ? '' : e.KHY_KILL_SHELL_TOOL).trim().toLowerCase();
  return !OFF_VALUES.includes(raw);
}

class KillShellTool extends BaseTool {
  static toolName = 'KillShell';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['kill_shell', 'kill_bash', 'kill_background_shell'];
  static searchHint = 'terminate a running background shell command';
  static shouldDefer = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return true; }
  isEnabled() { return killShellToolEnabled(process.env); }

  prompt() {
    return `Terminate a still-running background shell command.
- Takes a bash_id parameter (the backgroundTaskId returned when the shell was started with run_in_background:true)
- Sends a kill to the running command; its final output can then be read with BashOutput
- If the command has already finished there is nothing to terminate`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        bash_id: { type: 'string', description: 'The background shell id (backgroundTaskId) to terminate' },
      },
      required: ['bash_id'],
    };
  }

  async execute(params) {
    if (!killShellToolEnabled(process.env)) {
      return { success: false, error: 'KillShell is disabled (KHY_KILL_SHELL_TOOL=off).' };
    }

    const id = params && params.bash_id != null ? String(params.bash_id) : '';
    if (!id) return { success: false, error: 'bash_id is required.' };

    let registry;
    try {
      registry = require('../backgroundShellRegistry').backgroundShells;
    } catch (e) {
      return { success: false, error: 'background shell registry unavailable: ' + ((e && e.message) || e) };
    }

    const entry = registry.get(id);
    if (!entry) return { success: false, error: `Background shell ${id} not found` };

    if (entry.status !== 'running') {
      return {
        success: false,
        bash_id: id,
        status: entry.status,
        message: `后台命令已结束（${entry.status}），无需终止。`,
      };
    }

    const handle = entry.child || entry.pid;
    if (!handle) {
      return {
        success: false,
        bash_id: id,
        status: 'running',
        error: '该后台命令没有可终止的句柄（可能来自旧版本，未保留子进程引用）。',
      };
    }

    try {
      require('../platformUtils').safeKill(handle);
    } catch (e) {
      return { success: false, bash_id: id, error: '终止失败：' + ((e && e.message) || e) };
    }

    entry.killRequested = true;
    return {
      success: true,
      bash_id: id,
      command: entry.command || null,
      message: '已发送终止信号；可用 BashOutput 读取其最终输出。',
    };
  }

  getActivityDescription(input) { return `终止后台命令：${input && input.bash_id ? input.bash_id : ''}`; }
}

module.exports = KillShellTool;
module.exports.killShellToolEnabled = killShellToolEnabled;
