const { BaseTool } = require('../_baseTool');

/**
 * BackgroundAgentOutputTool — read a background sub-agent's result on demand.
 *
 * WHY THIS EXISTS (the real gap it fills):
 *   `AgentTool` with `run_in_background:true` starts a fire-and-forget sub-agent,
 *   registers it in `_backgroundAgents` (an in-process Map), and returns only an
 *   `agentId` plus the promise "result available via getBackgroundAgent()".
 *   But `getBackgroundAgent()` was NEVER exposed as a tool and has ZERO production
 *   call sites — the registry's only consumer was the one-shot auto-drain that
 *   emits a `<task_notification>` on completion. So if that single notification
 *   was missed (context compaction, long conversation, a user turn in between),
 *   the sub-agent's output was UNRECOVERABLE. There was no way to ask for it.
 *
 *   This mirrors `BashOutputTool` (which closed the identical hole for background
 *   shells) against khy's existing `_backgroundAgents` registry.
 *
 * Reads go through `AgentTool.getBackgroundAgent(id)` — the same SSOT the producer
 * writes and the drain reads — so NO producer change is needed. The drain only
 * marks entries `notified = true` in place (never deletes), so an on-demand read
 * still works after the auto-notification fired.
 *
 * HONEST BOUNDARY (deliberate): the registry is an in-process Map keyed by a
 * `bg-<ts>-<rand>` id. Results are therefore NOT available across a REPL/CLI
 * restart — the promise and the entry both die with the process. That is the
 * same boundary documented for background agents generally; cross-session
 * persistence would require re-architecting onto the detached-process model
 * (see [DESIGN-ARCH-130] §10 Q-2) and is explicitly out of scope here.
 *
 * WAITING MODEL: unlike `BashOutputTool` (which has no incremental signal and so
 * waits on a `deadline`), a background agent DOES have an activity signal — its
 * `status` flips to a terminal value exactly once. We implement an ACTIVITY-based
 * wait by polling the entry and resetting the timer only while the entry still
 * reports `running`, which is the compliant idle-timeout shape per RUNTIME-003.
 * We deliberately do NOT copy BashOutputTool's fixed `deadline` loop.
 *
 * Gate: KHY_BG_AGENT_OUTPUT_TOOL (default ON). Off → tool is not registered
 * (isEnabled() === false), a byte-identical fallback to today's behavior.
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function bgAgentOutputToolEnabled(env) {
  const e = env || process.env;
  const raw = String(e.KHY_BG_AGENT_OUTPUT_TOOL == null ? '' : e.KHY_BG_AGENT_OUTPUT_TOOL)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(raw);
}

// Poll cadence for the blocking wait. The registry is an in-memory Map, so
// there is no IO to shield — a short interval keeps the added latency low.
const POLL_INTERVAL_MS = 200;

class BackgroundAgentOutputTool extends BaseTool {
  static toolName = 'BackgroundAgentOutput';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['background_agent_output', 'get_agent_output', 'agent_output'];
  static searchHint = 'read background sub-agent result output';
  static shouldDefer = true;

  isReadOnly() {
    return true;
  }

  isConcurrencySafe() {
    return true;
  }

  isEnabled() {
    return bgAgentOutputToolEnabled(process.env);
  }

  prompt() {
    return `Retrieve the result of a background sub-agent started with run_in_background:true.
- Takes an agent_id parameter (the agentId returned when the agent was dispatched)
- Returns the agent's status, result, error, and subagent type
- Use block=true (default) to wait for the agent to finish
- Use block=false for a non-blocking check of the current status
- The result is only available while this session lives; it does not survive a restart
- Reading does not consume the result: the one-shot <task_notification> still fires independently`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The background agent id (agentId) to read the result from',
        },
        block: {
          type: 'boolean',
          description: 'Whether to wait for completion (default true)',
          default: true,
        },
        timeout: {
          type: 'number',
          description: 'Max wait time in ms (default 30000)',
          default: 30000,
          minimum: 0,
          maximum: 600000,
        },
      },
      required: ['agent_id'],
    };
  }

  async execute(params) {
    if (!bgAgentOutputToolEnabled(process.env)) {
      return { error: 'BackgroundAgentOutput is disabled (KHY_BG_AGENT_OUTPUT_TOOL=off).' };
    }

    const id = params && params.agent_id != null ? String(params.agent_id) : '';
    if (!id) {
      return { error: 'agent_id is required.' };
    }

    let getBackgroundAgent;
    try {
      ({ getBackgroundAgent } = require('../AgentTool'));
    } catch (e) {
      return { error: 'background agent registry unavailable: ' + ((e && e.message) || e) };
    }
    if (typeof getBackgroundAgent !== 'function') {
      return { error: 'background agent registry unavailable: getBackgroundAgent missing' };
    }

    const entry = getBackgroundAgent(id);
    if (!entry) {
      return { error: `Background agent ${id} not found` };
    }

    const block = params.block !== false;
    const timeoutMs = Math.max(0, Math.min(Number(params.timeout) || 30000, 600000));

    // Activity-based wait: only keep waiting while the entry still reports
    // `running`. The timer is bounded by `timeoutMs`, and each observation of a
    // non-running status ends the wait immediately. We never kill anything —
    // RUNTIME-003 governs letting a still-progressing task die, and here we
    // simply stop observing.
    if (block && entry.status === 'running' && timeoutMs > 0) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = getBackgroundAgent(id);
        if (!current || current.status !== 'running') {
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }

    const current = getBackgroundAgent(id) || entry;
    return {
      agent_id: id,
      status: current.status,
      subagent_type: current.subagentType || null,
      agent_role: current.role || null,
      result: current.result != null ? current.result : null,
      error: current.error != null ? current.error : null,
      started_at: current.startedAt || null,
    };
  }

  getActivityDescription(input) {
    return `读取后台智能体结果：${input && input.agent_id ? input.agent_id : ''}`;
  }
}

module.exports = BackgroundAgentOutputTool;
module.exports.bgAgentOutputToolEnabled = bgAgentOutputToolEnabled;
