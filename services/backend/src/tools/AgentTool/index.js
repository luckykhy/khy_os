/**
 * AgentTool — sub-agent spawning tool, aligned with Claude Code's Agent tool.
 *
 * Spawns independent sub-agents for parallel work. Supports multiple
 * subagent types: Explore (read-only codebase exploration), Plan
 * (structured planning), and general-purpose (full tool access).
 *
 * Delegates to the coordinator (when available) or runs a standalone
 * tool-use loop with direct AI chat.
 */
const { BaseTool } = require('../_baseTool');
const path = require('path');
const { normalizeAgentRole } = require('../../services/claudeCompat');
const { classifyAgentTool } = require('../../cli/agentTreeView');
// Model-name SSOT: lightweight cloud agent model ids flow from constants/models.js.
const { LIGHTWEIGHT_AGENT_MODELS } = require('../../constants/models');
// Role→tool-scope leaf (OPS-MAN-094): a read-only orchestration role (explore/
// verify/…) must lose the write tools (Edit/Write/NotebookEdit) even when no
// built-in agentDef supplies that denylist (e.g. SDK mode with built-in agents
// disabled → agentDef is null → the role's read-only intent would otherwise be
// silently lost). Gate KHY_ROLE_TOOL_SCOPE (default-on) inside the leaf.
const { mergeRoleScopeInto } = require('../../services/orchestrator/roleToolScope');

/**
 * Gate for enriching parallel-agent progress with the executing command line and
 * a directory-tree preview (默认开). KHY_AGENT_TREE_PREVIEW ∈ {0,false,off,no} →
 * omit the extra fields, so a fan-out renders byte-identically to before.
 */
function _treePreviewEnabled() {
  const v = String(process.env.KHY_AGENT_TREE_PREVIEW == null ? '' : process.env.KHY_AGENT_TREE_PREVIEW)
    .trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * The command/description a command tool is executing, for the live agent line
 * (执行命令). Empty for non-command tools — the tree falls back to the target.
 */
function _commandOf(name, params) {
  if (classifyAgentTool(name) !== 'command') return '';
  const p = params || {};
  return String(p.description || p.command || p.cmd || p.script || '').trim();
}

/**
 * CC 后端口径对齐:子代理完成时长走 Khy 已对齐 CC 的 `ccFormatDuration` SSOT
 * (cli/ccFormat.js,忠实移植 CC src/utils/format.ts:floor 取秒 → "3s"、"1m 30s"),
 * 取代各完成/失败/回退路径里自造的 `(ms/1000).toFixed(1)+'s'`("3.4s")——CC `AgentTool/UI.tsx`
 * 的 `Done (… formatDuration(totalDurationMs))` 用的正是这个格式器,Khy 别处(回合统计行/成本行,
 * 见 [[project_cc_format_ssot_alignment]])早已对齐它,唯独 AgentTool 仍各处自造、口径漂移。
 *   门控 KHY_AGENT_ELAPSED_CC(默认开):走 SSOT;关 / 异常 → 逐字节回退旧 `.toFixed(1)s`。
 * 纯函数、绝不抛(任何异常静默回退,绝不让子代理因时长格式化崩)。
 */
function _fmtElapsed(ms, env = process.env) {
  const n = Number(ms);
  const safe = Number.isFinite(n) ? n : 0;
  const v = String((env && env.KHY_AGENT_ELAPSED_CC) || '').trim().toLowerCase();
  const ccMode = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (ccMode) {
    try {
      const { ccFormatDuration } = require('../../cli/ccFormat');
      const s = ccFormatDuration(safe);
      if (s) return s;
    } catch { /* fall through to the legacy fixed-1-decimal seconds below */ }
  }
  return `${(safe / 1000).toFixed(1)}s`;
}

/**
 * Extract a bounded directory listing (目录树) from a listing tool's result so
 * the parallel tree can show what the agent explored. Returns null for non-
 * listing tools or empty/failed results. Accepts the common result shapes
 * (entries / files / matches) and normalises bare strings to {name,path,type}.
 */
function _listingEntriesOf(name, result) {
  if (!result || result.success === false) return null;
  if (classifyAgentTool(name) !== 'listing') return null;
  const raw = result.entries || result.files || result.matches || result.items || null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const norm = raw.slice(0, 40).map((e) => {
    if (typeof e === 'string') return { name: e, path: e, type: 'file' };
    if (!e || typeof e !== 'object') return null;
    const nm = e.name || e.path || e.file || '';
    if (!nm) return null;
    return {
      name: String(nm),
      path: String(e.path || nm),
      type: e.type || (e.isDirectory ? 'directory' : 'file'),
    };
  }).filter(Boolean);
  return norm.length ? norm : null;
}

// Background agent registry — tracks fire-and-forget agents for later result retrieval
const _backgroundAgents = new Map();

function getBackgroundAgent(id) {
  return _backgroundAgents.get(id) || null;
}

/**
 * s13: drain finished background agents as one-shot completion notifications.
 *
 * Returns terminal (completed/failed), not-yet-notified entries formatted as
 * notification descriptors and marks them notified in place. The tool-use loop
 * calls this each turn and injects the results as <task_notification> text into
 * the next model message — delivering on the "you will be automatically notified
 * when it completes" promise in the spawn prompt.
 *
 * @returns {Array<{ taskId: string, status: string, command: string, summary: string }>}
 */
function collectBackgroundResults() {
  const { drainCompletedBackgroundAgents } = require('../../services/query/taskNotification');
  return drainCompletedBackgroundAgents(_backgroundAgents);
}

// Recursion guard: every name under which this spawn tool is exposed. A spawned
// subagent receives the Agent/Task tool ONLY while below the nesting ceiling
// (so it may farm out its own chunk one more layer); at/over the ceiling these
// names are stripped from its tool set so the tree cannot grow past the cap.
// See buildSubagentDenylist for the depth-aware policy.
const AGENT_TOOL_NAMES = Object.freeze(['Agent', 'agent', 'spawn_worker', 'delegate', 'sub_agent', 'Task']);

// Maximum nesting depth for synchronous standalone subagents. Configurable so
// deployments can tighten/loosen the bound without code changes (zero-hardcode
// rule). depth 0 = top-level agent; a subagent at depth >= this ceiling is
// refused before it spawns. Defense-in-depth behind the tool-denylist above.
function _maxSubagentDepth() {
  const raw = parseInt(process.env.KHY_MAX_SUBAGENT_DEPTH || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

// Hardware-derived fan-out width for orchestrated subtasks. On weak machines the
// hardware profile sets KHY_ENABLE_MULTI_AGENT=false (force serial) and a low
// KHY_MAX_SUBAGENTS; on strong machines it widens. Both are populated by
// hardwareProfileService.applyLimits() and overridable by the user. A missing/
// invalid value falls back to "unbounded" (current behavior).
function _maxSubagentFanout() {
  if (String(process.env.KHY_ENABLE_MULTI_AGENT || '').toLowerCase() === 'false') {
    return 1; // serial execution on constrained hardware
  }
  const raw = parseInt(process.env.KHY_MAX_SUBAGENTS || '', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : Infinity;
}

// Run `worker(item)` over `items` with at most `limit` in flight at once,
// preserving input order in the result array. Mirrors Promise.allSettled's
// shape ({status,value}|{status,reason}) so callers are unchanged. limit=Infinity
// degrades to a plain concurrent fan-out.
async function _mapSettledLimited(items, limit, worker) {
  if (!Number.isFinite(limit) || limit >= items.length) {
    return Promise.allSettled(items.map(worker));
  }
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, runner));
  return results;
}


class AgentTool extends BaseTool {
  static toolName = 'Agent';
  static category = 'coordinator';
  static risk = 'medium';
  static aliases = ['agent', 'spawn_worker', 'delegate', 'sub_agent', 'Task'];
  static searchHint = 'spawn worker agent delegate task parallel explore research plan';
  static alwaysLoad = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return true; }

  // ── Recursion guard helpers (s06 parity) ──────────────────────────

  /**
   * Build the tool denylist for a spawned subagent: the agent definition's own
   * denylist, UNION the Agent/Task spawn-tool names ONLY when the child has
   * reached the nesting ceiling.
   *
   * Layered delegation (the teacher's design): the main agent owns strategy and
   * may delegate; a sub-agent BELOW the depth ceiling keeps the spawn tool so it
   * can break its own assigned chunk into independent pieces and farm them out
   * one more layer; a sub-agent AT/OVER the ceiling is a pure leaf executor and
   * loses the spawn tool so the tree cannot grow past the cap. The runtime depth
   * gate in execute() is the defense-in-depth backstop behind this denylist.
   *
   * @param {object|null} agentDef
   * @param {number} [childDepth] - nesting depth of the child being spawned
   *   (main=0, its child=1, grandchild=2). Omitted → treated as at-ceiling, so
   *   the spawn tool is stripped (safe default for any depth-unaware caller).
   * @param {number} [maxDepth] - the nesting ceiling (defaults to _maxSubagentDepth()).
   * @param {string} [role] - the orchestration role of the spawned agent. A
   *   read-only role (explore/verify/plan/research/audit/review) contributes the
   *   write-tool denylist (Edit/Write/NotebookEdit) via mergeRoleScopeInto, so
   *   the read-only intent survives even when agentDef carries no denylist.
   *   Omitted / gate-off / write role → no-op (byte-equivalent to before).
   * @returns {string[]}
   */
  static buildSubagentDenylist(agentDef, childDepth, maxDepth, role) {
    const ownDeny = Array.isArray(agentDef?.disallowedTools) ? agentDef.disallowedTools : [];
    // Fold in the role-derived read-only scope BEFORE the ceiling union. Guarded
    // so a leaf-load failure can never break spawning — degrade to ownDeny.
    let base = ownDeny;
    try {
      base = mergeRoleScopeInto(ownDeny, role);
    } catch (_e) {
      base = ownDeny;
    }
    const ceiling = Number.isFinite(maxDepth) ? maxDepth : _maxSubagentDepth();
    // Strip the spawn tool only when the child is at/over the ceiling. A child
    // below it may recurse one more layer. childDepth omitted → strip (safe).
    const atCeiling = !Number.isFinite(childDepth) || childDepth >= ceiling;
    return atCeiling
      ? Array.from(new Set([...base, ...AGENT_TOOL_NAMES]))
      : Array.from(new Set(base));
  }

  /**
   * Assemble a spawned sub-agent's system prompt: the layered-thinking scope
   * rule (SUBAGENT_EXECUTION_SCOPE — strategy stays with the main agent, execute
   * the self-contained chunk, recurse only within the cap) prepended to the
   * agent's own role prompt. Single injection seam so every sub-agent, whatever
   * its role/type, carries the same scope rule; the rule lives in constraints.js
   * (injected, never copy-pasted). Pure for testing.
   *
   * @param {string} rolePrompt - the agent definition's / role's own system prompt
   * @returns {string}
   */
  static buildSubagentSystemPrompt(rolePrompt) {
    let scope = '';
    try {
      ({ SUBAGENT_EXECUTION_SCOPE: scope } = require('../../agents/constraints'));
    } catch { /* constraints not available — fall back to role prompt alone */ }
    const role = typeof rolePrompt === 'string' ? rolePrompt : '';
    return scope ? `${scope}\n\n${role}` : role;
  }

  /** Nesting depth of the parent (0 when spawned from the top-level agent). */
  static parentDepthOf(context) {
    const d = context?._agentContext?.depth;
    return Number.isFinite(d) ? d : 0;
  }

  /** True when the parent is already at/over the nesting ceiling. */
  static isDepthExceeded(context) {
    return AgentTool.parentDepthOf(context) >= _maxSubagentDepth();
  }

  prompt() {
    return `Launch a sub-agent that has access to all tools to handle a task autonomously.

The sub-agent runs independently with its own tool-use loop. It receives only a compact summary of recent parent context (recent intent + file paths, or an explicit \`parent_context_summary\` you pass) — NOT the full conversation. You MUST still provide a detailed, self-contained prompt with all necessary context.

Strategy stays with you (the calling agent): YOU own the overall goal decomposition, architecture, and cross-cutting decisions. A sub-agent is a hands-on executor — hand it a self-contained chunk to carry out, not the whole problem to re-plan. A sub-agent MAY split its own assigned chunk and delegate one more layer, but recursion is hard-capped at 3 layers total (main + 2 nested); a sub-agent at the deepest layer cannot spawn further and must do that work itself. Sub-agents also run at reduced reasoning effort (no extended-thinking budget) — keep the deep thinking here.

Use this tool for:
- Parallel research across multiple files or directories
- Independent coding tasks that don't require parent context
- Complex file exploration and analysis
- Tasks that benefit from focused, autonomous execution

When NOT to use this tool:
- If you want to read a specific file path, use the Read tool directly
- If you are searching for a specific class/function definition, use the Glob or Grep tool directly
- If you are searching within 2-3 known files, use Read directly
- Simple, directed tasks that don't need autonomy

Subagent types:
- "Explore" — read-only codebase exploration. Searches files, reads code, and summarizes findings. Does NOT modify files.
- "Plan" — structured planning. Analyzes requirements and produces an execution plan.
- "implement" — precise implementation. Applies targeted code changes with minimal edits, then verifies.
- "verify" — validation only. Runs tests, linters, and builds. Reports pass/fail but does NOT fix issues.
- "verification" — alias of "verify". Use when you want the built-in verification specialist explicitly.
- "audit" — read-only adversarial critic. Reviews code/design and nitpicks: reports bugs, security holes, races, missing edge cases, spec violations, and smells, ranked by severity with evidence. Does NOT run builds or fix anything — use "verify" to run tests, "audit" to find problems by inspection.
- "fix" — surgical repair. Closes EXACTLY the CRITICAL/HIGH defects it is handed (typically audit findings) — root cause, minimal diff, verified — then stops. Does NOT refactor, rename, or expand scope. Pass it the findings with file:line. Pairs with "audit": audit finds, fix closes.
- "research" — read-only multi-source investigator. Answers open questions by combining the local codebase, the live web (WebFetch/WebSearch), and read-only repo history, cross-checking sources and synthesizing an answer with a "Sources:" list. Use it when the answer needs more than a local search — use "Explore" for a fast repo-only file/keyword search.
- "reading" — read-only deep-reading specialist. Reads the specified files/modules/documents in full and explains them faithfully (responsibilities, control/data flow, decisions, invariants, edge cases, traps) with file:line citations. Use it to comprehend given files — use "Explore" to locate where things live.
- "map" — read-only codebase cartographer. Produces a structural map (tech stack, entry points, build/run/test commands, top-level directory responsibilities, directory tree, module dependency graph, key symbols), aligned with the repo's .ai/MAP.md skeleton. Reads existing .ai/ seed docs as ground truth. Reports the map; does NOT write files.
- "general-purpose" — full tool access. Can read, write, edit, execute, and search.

Tips:
- Always include a short description (3-5 words) summarizing what the agent will do
- Provide specific file paths, function names, or patterns when possible
- Include ALL relevant context in the prompt — agents see only a compact context summary, not the full conversation history. For anything load-bearing, put it in the prompt or in \`parent_context_summary\`
- Launch multiple agents concurrently when tasks are independent, to maximize performance
- Keep immediate blocking work local. Use sub-agents for independent sidecar work, not for the very next step you are waiting on right now
- Explore is strictly read-only research. Do not ask it to write code, install packages, or mutate the project
- When delegating implementation or verification, assign explicit ownership: which files, modules, paths, or responsibility the agent owns, and whether it should write or only research
- Use the \`subtasks\` array only for truly independent subtasks. If one result depends on another, keep that sequencing in the main flow
- If a relevant agent is already running or already has the context you need, continue it with SendMessage instead of spawning a duplicate
- Background agents are for genuinely independent work. After launching one, continue other useful work instead of polling or idling
- The agent's result is not visible to the user — summarize it in your response`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Self-contained task description with all context the agent needs',
        },
        parent_context_summary: {
          type: 'string',
          description: 'Optional short summary of relevant parent-conversation context (recent intent, decisions, file paths) to give the sub-agent continuity. If omitted, a compact summary is auto-derived from the recent conversation. Keep the main `prompt` self-contained regardless.',
        },
        subagent_type: {
          type: 'string',
          enum: ['Explore', 'Plan', 'general-purpose', 'implement', 'verify', 'verification', 'audit', 'Audit', 'fix', 'Fix', 'research', 'Research', 'reading', 'Reading', 'map', 'Map', 'codex', 'Codex', 'claude', 'Claude', 'opencode', 'OpenCode'],
          description: 'Agent type: "Explore" read-only fast local search, "Plan" planning, "implement" targeted coding, "verify"/"verification" test and validate, "audit" read-only adversarial critic that nitpicks and reports problems by inspection, "fix" surgical repair agent that closes specific (typically audited) CRITICAL/HIGH defects and stops, "research" read-only multi-source investigator (code + web + docs) that synthesizes a sourced answer, "reading" read-only deep-comprehension agent that reads specified files/documents thoroughly and explains them, "map" read-only codebase cartographer that produces a structural map (tech stack, entry points, dependency graph, key symbols), "general-purpose" full tool access, "codex"/"claude"/"opencode" command a specific external code-editor CLI via its adapter channel',
        },
        adapter: {
          type: 'string',
          description: 'Preferred adapter override (e.g. codex, claude, opencode, relay_api)',
        },
        preferred_adapter: {
          type: 'string',
          description: 'Alias of adapter',
        },
        model: {
          type: 'string',
          description: 'Preferred model id for the sub-agent',
        },
        preferred_model: {
          type: 'string',
          description: 'Alias of model',
        },
        role: {
          type: 'string',
          description: 'Explicit role override (general/explore/planner/coder/reviewer/codex/claude)',
        },
        agent_type: {
          type: 'string',
          description: 'Alias of role/subagent_type',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in seconds (default: 120)',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run agent in background. Returns immediately with agent ID; result available via getBackgroundAgent().',
        },
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description: 'Run agent in an isolated git worktree. The worktree is cleaned up when the agent completes.',
        },
        subtasks: {
          type: 'array',
          description: 'Split into parallel sub-agents for independent subtasks. Each item runs as a separate agent; results are aggregated.',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Self-contained subtask description' },
              role: {
                type: 'string',
                enum: ['explore', 'implement', 'verify', 'audit', 'fix', 'research', 'reading', 'map', 'general', 'planner'],
                description: 'Subtask agent role (default: inherit from parent)',
              },
            },
            required: ['prompt'],
          },
        },
      },
      required: ['prompt'],
    };
  }

  getActivityDescription(input) {
    const type = input.subagent_type || 'general-purpose';
    const preview = (input.prompt || '').slice(0, 40);
    return `启动代理（${type}）：${preview}`;
  }

  getToolUseSummary(input) {
    return `代理：${(input.prompt || '').slice(0, 60)}`;
  }

  async execute(params, _context) {
    // Recursion guard (s06 parity): refuse to spawn when the parent is already
    // at the nesting ceiling. The tool-denylist below normally prevents a
    // subagent from ever seeing this tool, but a deeply-forked context (or a
    // user/project agent that re-enables it) is stopped here as a backstop.
    if (AgentTool.isDepthExceeded(_context)) {
      return {
        success: false,
        error: `Subagent nesting limit reached (depth ${AgentTool.parentDepthOf(_context)} ≥ ${_maxSubagentDepth()}). Complete this task directly instead of spawning another agent.`,
      };
    }

    const timeoutMs = (params.timeout || 120) * 1000;
    const requestedType = String(
      params.role
      || params.agent_type
      || params.subagent_type
      || 'general-purpose'
    ).trim();
    const subagentType = requestedType || 'general-purpose';

    // Map subagent_type to the internal role system
    const roleMap = {
      'Explore': 'explore',
      'explore': 'explore',
      'Plan': 'planner', // Plan agents analyze but don't modify
      'plan': 'planner',
      'general-purpose': 'general',
      'general': 'general',
      'implement': 'implement',
      'implementer': 'implement',
      'verify': 'verify',
      'verification': 'verify',
      'verifier': 'verify',
      'audit': 'audit',
      'Audit': 'audit',
      'auditor': 'audit',
      'critic': 'audit',
      'fix': 'fix',
      'Fix': 'fix',
      'fixer': 'fix',
      'repair': 'fix',
      'research': 'research',
      'Research': 'research',
      'researcher': 'research',
      'reading': 'reading',
      'Reading': 'reading',
      'reader': 'reading',
      'map': 'map',
      'Map': 'map',
      'cartographer': 'map',
      'codex': 'codex',
      'Codex': 'codex',
      'claude': 'claude',
      'Claude': 'claude',
      'opencode': 'opencode',
      'OpenCode': 'opencode',
      'Opencode': 'opencode',
    };
    let role = roleMap[subagentType] || normalizeAgentRole(subagentType) || 'general';
    let preferredAdapter = String(
      params.preferred_adapter
      || params.adapter
      || ''
    ).trim().toLowerCase();
    const _explicitAdapter = !!preferredAdapter;

    // ── Claude Code delegation (健壮探测 + 自动回退 + 透明上报) ──────────────────
    // Two triggers per design: (1) explicit — model set subagent_type:'claude';
    // (2) auto — no explicit adapter and the task heuristically suits Claude Code
    // (feature-flag gated, default off). Either way: if Claude Code is unavailable
    // or not chosen, we DON'T force it — we fall cleanly back to Khy's own best
    // adapter and record why. Never hard-fails on a missing `claude` CLI.
    let _delegationNote = null;
    try {
      const { decideClaudeDelegation } = require('./claudeDelegation');
      if (role === 'claude') {
        const d = decideClaudeDelegation({ prompt: params.prompt || '', role, explicitlyRequested: true });
        if (d.delegate) {
          preferredAdapter = 'claude';
          _delegationNote = { delegated: true, delegatedTo: 'claude-code', reason: d.reason, mode: d.mode };
        } else {
          // Unavailable: demote to a general Khy agent and let capability
          // auto-selection (below) pick the best AVAILABLE adapter.
          role = 'general';
          preferredAdapter = '';
          _delegationNote = { delegated: false, delegatedTo: null, reason: d.reason, mode: d.mode };
        }
      } else if (!_explicitAdapter && (role === 'general' || role === 'implement')) {
        const d = decideClaudeDelegation({ prompt: params.prompt || '', role, explicitlyRequested: false });
        if (d.delegate) {
          role = 'claude';
          preferredAdapter = 'claude';
          _delegationNote = { delegated: true, delegatedTo: 'claude-code', reason: d.reason, mode: d.mode };
        }
      }
    } catch { /* delegation decision is best-effort; fall through to normal routing */ }

    if (!preferredAdapter && role === 'codex') preferredAdapter = 'codex';
    if (!preferredAdapter && role === 'claude') preferredAdapter = 'claude';
    if (!preferredAdapter && role === 'opencode') preferredAdapter = 'opencode';
    // Capability-aware auto-selection when no explicit adapter is set
    if (!preferredAdapter) {
      try {
        const { getCapabilityRegistry } = require('../../services/gateway/capabilityRegistry');
        const registry = getCapabilityRegistry();
        const reqs = registry.inferRequirements(params.prompt || '', role);
        // B3 — soft re-ranking by runtime stats (rework rate + current load),
        // keyed by executor (adapter/role). Skill tags are applied only when the
        // caller supplies them, since built-in agent profiles declare none.
        let weighting = null;
        try {
          const agentStats = require('../../services/agentStatsService');
          const statsMap = {};
          for (const s of agentStats.list()) statsMap[s.type] = s;
          weighting = { stats: statsMap };
          if (Array.isArray(params.skills) && params.skills.length) {
            weighting.skills = params.skills;
          }
        } catch { /* stats ledger optional */ }
        const ranked = registry.bestAdaptersFor(reqs, { onlyAvailable: true, limit: 1, weighting });
        if (ranked.length > 0) preferredAdapter = ranked[0].key;
      } catch { /* registry not available */ }
    }
    const preferredModel = String(
      params.preferred_model
      || params.model
      || ''
    ).trim();

    // Extract progress callback from parent trace context (injected by REPL's AgentTreeController)
    const progressCallback = _context?.traceContext?.onAgentProgress || null;
    // Subagent permission bubbling: forward the host approval channel into the child loop
    const onControlRequest = _context?.traceContext?.onControlRequest || null;

    // Surface the delegation decision in the agent tree (transparent reporting).
    if (_delegationNote && progressCallback) {
      try {
        progressCallback({
          type: 'delegation',
          delegated: _delegationNote.delegated,
          delegatedTo: _delegationNote.delegatedTo,
          reason: _delegationNote.reason,
          mode: _delegationNote.mode,
        });
      } catch { /* progress is best-effort */ }
    }

    // GAP 5: Worktree isolation — run agent in a dedicated git worktree
    let worktreeInfo = null;
    let savedCwd = null;
    if (params.isolation === 'worktree') {
      try {
        const { createWorktree } = require('../../services/worktreeManager');
        worktreeInfo = createWorktree({ name: `agent-${Date.now()}` });
        savedCwd = process.env.KHYQUANT_CWD;
        process.env.KHYQUANT_CWD = worktreeInfo.path;
      } catch { /* worktree not available, continue without isolation */ }
    }

    // GAP 4: Background agent execution — fire-and-forget, return immediately
    if (params.run_in_background) {
      const agentId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const bgPromise = this._runStandaloneAgent(
        params.prompt, role, subagentType, timeoutMs, _context,
        { preferredAdapter, preferredModel, progressCallback, onControlRequest, delegation: _delegationNote, parentContextSummary: params.parent_context_summary }
      ).finally(() => {
        // Cleanup worktree when background agent finishes
        if (worktreeInfo) {
          if (savedCwd !== undefined) process.env.KHYQUANT_CWD = savedCwd;
          try {
            const { removeWorktree } = require('../../services/worktreeManager');
            removeWorktree(worktreeInfo.path, { force: true });
          } catch { /* best effort */ }
        }
      });
      _backgroundAgents.set(agentId, { promise: bgPromise, status: 'running', startedAt: Date.now(), subagentType, role });
      bgPromise.then(result => {
        const entry = _backgroundAgents.get(agentId);
        if (entry) { entry.status = 'completed'; entry.result = result; }
      }).catch(err => {
        const entry = _backgroundAgents.get(agentId);
        if (entry) { entry.status = 'failed'; entry.error = err.message; }
      });
      return {
        success: true,
        agentId,
        status: 'running',
        subagent_type: subagentType,
        role,
        ...(_delegationNote || {}),
        message: `Background agent ${agentId} (${subagentType}) started.`,
      };
    }

    // Synchronous execution — cleanup worktree in finally
    try {
      // Try coordinator mode first
      try {
        const { isCoordinatorMode } = require('../../coordinator/coordinatorMode');
        if (isCoordinatorMode()) {
          const { spawnWorker } = require('../../coordinator/workerAgent');
          const worker = await spawnWorker(params.prompt, {
            role,
            timeout: timeoutMs,
            preferredAdapter,
            preferredModel,
            parentContext: _context?._agentContext || null,
          });
          return {
            success: true,
            workerId: worker.id,
            subagent_type: subagentType,
            role: worker.role,
            preferredAdapter: worker.preferredAdapter || preferredAdapter || null,
            preferredModel: worker.preferredModel || preferredModel || null,
            status: worker.status,
            output: worker.result || worker.message,
            ...(_delegationNote || {}),
            message: `Worker ${worker.id} completed as ${subagentType}.`,
          };
        }
      } catch { /* coordinator not available, use standalone mode */ }

      // Orchestrated mode: parallel subtasks via SubAgentOrchestrator
      if (params.subtasks && Array.isArray(params.subtasks) && params.subtasks.length > 0) {
        return await this._runOrchestrated(params, role, subagentType, timeoutMs, _context, {
          preferredAdapter, preferredModel, progressCallback, onControlRequest, delegation: _delegationNote,
        });
      }

      // Standalone mode: run a mini tool-use loop with direct AI chat
      return await this._runStandaloneAgent(
        params.prompt,
        role,
        subagentType,
        timeoutMs,
        _context,
        { preferredAdapter, preferredModel, progressCallback, onControlRequest, delegation: _delegationNote, parentContextSummary: params.parent_context_summary }
      );
    } finally {
      // Cleanup worktree after synchronous execution
      if (worktreeInfo) {
        if (savedCwd !== undefined) process.env.KHYQUANT_CWD = savedCwd;
        try {
          const { removeWorktree } = require('../../services/worktreeManager');
          removeWorktree(worktreeInfo.path, { force: true });
        } catch { /* best effort */ }
      }
    }
  }

  async _runStandaloneAgent(prompt, role, subagentType, timeoutMs, parentContext, route = {}) {
    const startTime = Date.now();
    const preferredAdapter = String(route.preferredAdapter || '').trim();
    const preferredModel = String(route.preferredModel || '').trim();
    const progressCallback = route.progressCallback || null;
    const onControlRequest = route.onControlRequest || null;
    // Transparent reporting: surface whether/why this run was delegated to Claude Code.
    const _delegation = route.delegation || null;
    // Flattened transparency fields, spread into every return object below.
    const _delegationFields = _delegation
      ? { delegated: _delegation.delegated, delegatedTo: _delegation.delegatedTo, delegationReason: _delegation.reason }
      : {};

    // Load matching built-in agent definition (Explore, Plan, etc.)
    let agentDef = null;
    try {
      const { getBuiltInAgents } = require('../../agents/builtInAgents');
      const roleToType = { explore: 'Explore', planner: 'Plan', general: 'general-purpose', verify: 'verification', audit: 'audit', fix: 'fix', research: 'research', reading: 'reading', map: 'map' };
      const agentType = roleToType[role] || subagentType;
      agentDef = getBuiltInAgents({ enableVerification: true, enableAudit: true, enableFix: true }).find(a => a.agentType === agentType) || null;
    } catch { /* built-in agents not available */ }

    // Depth of the child being spawned: main=0, its child=1, grandchild=2.
    // Drives layered delegation — a child below the ceiling keeps the spawn
    // tool (may farm out one more layer); a child at/over it becomes a pure
    // leaf executor.
    const childDepth = AgentTool.parentDepthOf(parentContext) + 1;

    // Create per-agent AgentContext for isolated state
    let agentCtx = null;
    try {
      const { AgentContext } = require('../../services/agentContext');
      const parentCtx = parentContext?._agentContext;
      const ctxOpts = {
        role,
        toolFilter: (role === 'explore' || role === 'planner' || role === 'audit' || role === 'research' || role === 'reading' || role === 'map') ? 'explore' : null,
        // Recursion guard: a subagent keeps the Agent/Task tool only while below
        // the nesting ceiling, so it may break its own chunk into independent
        // pieces and farm one more layer out; at/over the ceiling the spawn tool
        // is stripped so the tree cannot grow past the cap. Union the agent
        // definition's own denylist in. See buildSubagentDenylist. The role is
        // passed so a read-only role (verify/explore/…) also sheds the write
        // tools even when agentDef carries no denylist (OPS-MAN-094).
        disallowedTools: AgentTool.buildSubagentDenylist(agentDef, childDepth, undefined, role),
      };
      agentCtx = parentCtx
        ? parentCtx.fork(ctxOpts)
        : new AgentContext(ctxOpts);
    } catch { /* agentContext not available */ }

    // Use rich system prompt from agent definition if available, fallback to role hints
    const roleHints = {
      explore: 'You are a codebase exploration agent. Search files, read code, and summarize findings. Do NOT modify files.',
      reviewer: 'You are a planning agent. Analyze requirements, explore the codebase, and produce a structured execution plan. Do NOT modify files.',
      audit: 'You are a read-only audit agent. Adversarially review the code/design and find problems — bugs, security holes, races, missing edge cases, spec violations, and smells. Report findings ranked by severity with file:line evidence. Do NOT edit, run builds, or fix anything; you only find and report.',
      fix: 'You are a surgical fix agent. Close EXACTLY the CRITICAL/HIGH defects you were handed (typically from an audit) — root cause, minimal diff, verified — then stop. Do NOT refactor, rename, or expand scope, and do NOT rubber-stamp (a comment or swallowed error is not a fix). End with the FIX: summary line.',
      research: 'You are a read-only research agent. Investigate the question across the local codebase (Glob/Grep/Read), the live web (WebFetch/WebSearch), and read-only repo history — cross-check sources, mark confidence honestly, and synthesize a grounded answer. End with a "Sources:" list of the URLs you used. Do NOT edit, install, or run state-changing commands.',
      reading: 'You are a read-only reading agent. Read the specified files/documents in full and explain them faithfully — responsibilities, control/data flow, key decisions, invariants, edge cases, and traps — grounded in file:line citations. Use Glob/Grep only to locate what to read. Explain only what you actually read; never invent behavior. Do NOT edit files.',
      map: 'You are a read-only codebase cartographer. Produce a structural map — tech stack, entry points, build/run/test commands, top-level directory responsibilities, a pruned directory tree, the module dependency graph, and key symbols. Read .ai/MAP.md and .ai/CONTEXT.yaml as ground truth when present. Report the map as your final message; do NOT write any file.',
      general: 'You are a general-purpose agent. Use available tools to complete the task efficiently.',
    };
    const rolePrompt = (agentDef && typeof agentDef.getSystemPrompt === 'function')
      ? agentDef.getSystemPrompt()
      : (roleHints[role] || roleHints.general);

    try {
      const toolUseLoop = require('../../services/toolUseLoop');

      if (toolUseLoop.isEnabled()) {
        const ai = require('../../cli/ai');
        // P0.3 父上下文摘要:缓解子代理「看不见父对话」的隔离问题。显式 parent_context_summary
        // 优先,否则从父对话历史(经 toolCalling 透传到 parentContext.parentConversation)确定性
        // 派生。判定全在纯叶子 subagentContextSummary;门控关 → 空串 = 不注入(字节回退)。
        let _parentSummaryBlock = '';
        try {
          const subSummary = require('../../services/subagentContextSummary');
          _parentSummaryBlock = subSummary.resolveSummary(
            route.parentContextSummary,
            parentContext?.parentConversation || null,
            {},
            process.env,
          );
        } catch { /* fail-soft: no parent summary */ }
        const agentPrompt = _parentSummaryBlock
          ? `[Agent Task — Type: ${subagentType}]\n${AgentTool.buildSubagentSystemPrompt(rolePrompt)}\n\n${_parentSummaryBlock}\n\nTask:\n${prompt}`
          : `[Agent Task — Type: ${subagentType}]\n${AgentTool.buildSubagentSystemPrompt(rolePrompt)}\n\nTask:\n${prompt}`;
        const toolLog = [];

        // Resolve effective model with fallback cascade:
        //   explicit param > agent definition > cloud lightweight > local models > main model
        // If a model is not available, the chat call fails and we retry the next candidate.
        const agentDefModel = (agentDef?.model && agentDef.model !== 'inherit')
          ? agentDef.model : '';
        const effectiveModel = preferredModel || agentDefModel;

        // Auto-select an AVAILABLE model for alias-driven sub-agents (Explore/khyGuide
        // pin a bare tier alias like 'haiku'). Instead of blindly shipping that alias —
        // which a relay_api/api provider rejects as an invalid model id — consult the
        // active channel's actually-available model list and let the candidate builder
        // pick a confirmed-available lightweight one. Fail-soft: any error → null →
        // byte-identical legacy behavior (blind cloud-lightweight list).
        let _availableModels = null;
        try {
          const _sel = require('../../services/subAgentModelSelect');
          if (_sel.isEnabled() && agentDefModel && !preferredModel) {
            const _gw = require('../../services/gateway/aiGateway');
            const _activeKey = (_gw && typeof _gw._resolveActiveChannelKey === 'function')
              ? _gw._resolveActiveChannelKey() : null;
            if (_activeKey && typeof _gw.listModels === 'function') {
              _availableModels = await _gw.listModels(_activeKey); // cached (5-min TTL)
            }
          }
        } catch { _availableModels = null; }

        // Build fallback list: [preferred, cloud alternatives, local, '' (main model)]
        const modelCandidates = _buildModelCandidates(effectiveModel, preferredModel, agentDefModel, _availableModels);

        let _currentModelIdx = 0;
        // Sub-agent prose streaming (对齐 Claude Code): coalesce the child's text
        // deltas into a one-line preview and forward it to the parent tree as
        // `agent_text` events. Gate KHY_SUBAGENT_TEXT_STREAM (default-on); when off,
        // _onTextDelta is a no-op and zero agent_text events are emitted (字节回退到
        // 只流 status). All coalescing rules live in the pure leaf — never inline.
        const _subAgentTextStream = (() => {
          try { return require('../../services/subAgentTextStream'); } catch { return null; }
        })();
        let _textBuf = '';
        let _lastTextPreview = '';
        const _onTextDelta = (chunk) => {
          if (!progressCallback || !_subAgentTextStream || !_subAgentTextStream.isEnabled()) return;
          try {
            const delta = _subAgentTextStream.textFromChunk(chunk);
            if (!delta) return;
            _textBuf = _subAgentTextStream.appendDelta(_textBuf, delta);
            const preview = _subAgentTextStream.previewLine(_textBuf);
            if (preview && preview !== _lastTextPreview) {
              _lastTextPreview = preview;
              progressCallback(_subAgentTextStream.buildAgentTextEvent(preview));
            }
          } catch { /* prose preview is cosmetic; never disturb the sub-agent */ }
        };
        const _chatWithFallback = async (message, chatOpts = {}) => {
          const candidate = modelCandidates[_currentModelIdx];
          // Chain any caller-supplied onChunk so we observe text deltas without
          // stealing the channel (sub-agent path previously omitted onChunk).
          const _priorOnChunk = typeof chatOpts.onChunk === 'function' ? chatOpts.onChunk : null;
          const _chainedOnChunk = (chunk) => {
            _onTextDelta(chunk);
            if (_priorOnChunk) { try { _priorOnChunk(chunk); } catch { /* caller's sink */ } }
          };
          try {
            return await ai.chat(message, {
              ...chatOpts,
              onChunk: _chainedOnChunk,
              disableNaturalToolLoop: true,
              // Thinking stays with the main agent: flag this as a sub-agent and
              // default its reasoning effort to 'medium' (no 'max'/extended
              // thinking budget). chat() clamps 'max'→'high' for sub-agents
              // unless KHY_SUBAGENT_ALLOW_THINKING=1. A caller-supplied effort in
              // chatOpts still wins, but is clamped the same way downstream.
              _isSubagent: true,
              effort: chatOpts.effort || 'medium',
              ...(candidate.adapter ? { preferredAdapter: candidate.adapter } : (preferredAdapter ? { preferredAdapter } : {})),
              ...(candidate.model ? { preferredModel: candidate.model } : {}),
              _agentContext: agentCtx,
            });
          } catch (chatErr) {
            // If this candidate failed and we have more, try next
            if (_currentModelIdx < modelCandidates.length - 1) {
              _currentModelIdx++;
              const next = modelCandidates[_currentModelIdx];
              const nextLabel = next.label || next.model || '(main model)';
              if (progressCallback) {
                progressCallback({
                  type: 'model_fallback',
                  from: candidate.label || candidate.model || '(default)',
                  to: nextLabel,
                  reason: chatErr.message,
                });
              }
              return _chatWithFallback(message, chatOpts);
            }
            throw chatErr;
          }
        };

        const _treePreview = _treePreviewEnabled();
        const result = await Promise.race([
          toolUseLoop.runToolUseLoop(agentPrompt, {
            chat: _chatWithFallback,
            // Sub-agent marker — must live under chatOpts, which is what the loop
            // spreads into effectiveChatOpts and reads `_isSubagent` from. This
            // restores the main-loop-only gates (e.g. the proactive-collaboration
            // fan-out, gated on !_isSubagent) so a sub-agent's recursion only
            // happens via the explicit, depth-bounded Agent tool — never
            // auto-fanned-out.
            chatOpts: { _isSubagent: true },
            // Subagent permission bubbling: child shell approvals reach the host channel
            onControlRequest,
            // D1: Subagent-type-based budget differentiation
            // Explore/Plan are typically shorter; general/implement need more iterations
            maxIterations: ({ explore: 12, planner: 6, verify: 6, audit: 12, fix: 15, general: 15, implement: 15, codex: 15, claude: 15, opencode: 15 })[role] || 8,
            onToolCall: (name, _params, iteration) => {
              toolLog.push({ tool: name, iteration, status: 'started', target: _params?.file_path || _params?.path || _params?.pattern || '' });
              if (progressCallback) {
                const evt = { type: 'tool_start', tool: name, target: _params?.file_path || _params?.path || _params?.pattern || '' };
                // 执行命令: forward the command line so a Bash row reads what it runs.
                if (_treePreview) { const cmd = _commandOf(name, _params); if (cmd) evt.command = cmd; }
                progressCallback(evt);
              }
            },
            onToolResult: (name, _params, result, _iteration, elapsed) => {
              const last = toolLog.find(t => t.tool === name && t.status === 'started');
              if (last) {
                last.status = result?.success ? 'success' : 'error';
                last.elapsed = elapsed;
              }
              if (progressCallback) {
                const evt = { type: 'tool_end', tool: name, success: !!result?.success, elapsed };
                // 目录树: forward a bounded listing so the tree shows what was explored.
                if (_treePreview) { const entries = _listingEntriesOf(name, result); if (entries) evt.entries = entries; }
                progressCallback(evt);
              }
            },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Agent timed out')), timeoutMs)
          ),
        ]);

        const elapsed = Date.now() - startTime;
        if (progressCallback) {
          progressCallback({ type: 'done', success: true, toolCalls: toolLog.length, elapsed });
        }

        // Extract structured metadata from the tool log
        const filesModified = [...new Set(
          toolLog
            .filter(t => /edit|write|scaffold|apply_patch/i.test(t.tool) && t.status === 'success')
            .map(t => t.target)
            .filter(Boolean)
        )];
        const planCompletion = result.executionPlan
          ? { total: result.executionPlan.steps.length, completed: result.executionPlan.steps.filter(s => s.status === 'completed').length }
          : null;

        return {
          success: true,
          subagent_type: subagentType,
          role,
          output: result.finalResponse || '',
          iterations: result.iterations,
          toolCalls: toolLog.length,
          toolCallLog: toolLog,
          filesModified,
          planCompletion,
          ..._delegationFields,
          elapsed: _fmtElapsed(elapsed),
          message: `Agent (${subagentType}) completed in ${_fmtElapsed(elapsed)} with ${toolLog.length} tool uses.`,
        };
      }

      // Fallback: simple single-shot AI chat (no tool loop)
      const ai = require('../../cli/ai');
      const result = await ai.chat(`[Agent Task — ${subagentType}] ${prompt}`, {
        disableNaturalToolLoop: false,
        ...(preferredAdapter ? { preferredAdapter } : {}),
        ...(preferredModel ? { preferredModel } : {}),
      });
      const elapsed = Date.now() - startTime;
      return {
        success: true,
        subagent_type: subagentType,
        role,
        preferredAdapter: preferredAdapter || null,
        preferredModel: preferredModel || null,
        output: result.reply || '',
        iterations: 1,
        toolCalls: 0,
        ..._delegationFields,
        elapsed: _fmtElapsed(elapsed),
        message: `Agent (${subagentType}) completed in ${_fmtElapsed(elapsed)}.`,
      };
    } catch (err) {
      // For explore-type agents, try local heuristic search as last resort
      if (role === 'explore') {
        const localResult = await _localExploreFallback(prompt, progressCallback);
        if (localResult) {
          const elapsed = Date.now() - startTime;
          if (progressCallback) {
            progressCallback({ type: 'done', success: true, toolCalls: 0, elapsed, fallback: 'local-search' });
          }
          return {
            success: true,
            subagent_type: subagentType,
            role,
            output: localResult,
            iterations: 0,
            toolCalls: 0,
            ..._delegationFields,
            elapsed: _fmtElapsed(elapsed),
            message: `Agent (${subagentType}) used local search fallback in ${_fmtElapsed(elapsed)} (all models unavailable).`,
          };
        }
      }

      const elapsed = Date.now() - startTime;
      if (progressCallback) {
        progressCallback({ type: 'done', success: false, error: err.message, elapsed });
      }
      return {
        success: false,
        subagent_type: subagentType,
        role,
        preferredAdapter: preferredAdapter || null,
        preferredModel: preferredModel || null,
        error: err.message,
        ..._delegationFields,
        elapsed: _fmtElapsed(elapsed),
        message: `Agent (${subagentType}) failed after ${_fmtElapsed(elapsed)}: ${err.message}`,
      };
    }
  }

  // ── Orchestrated execution ──────────────────────────────────────

  /** Lazy-load a SubAgentOrchestrator singleton scoped to this AgentTool instance. */
  _getOrchestrator() {
    if (!this._orchestrator) {
      const { SubAgentOrchestrator } = require('../../services/subAgentOrchestrator');
      this._orchestrator = new SubAgentOrchestrator({
        // Single source for the nesting ceiling — same bound the denylist and
        // execute() depth gate use, so the orchestrator never drifts from them.
        maxDepth: _maxSubagentDepth(),
        maxChildren: 5,
        maxTotalAgents: 15,
        agentTimeoutMs: 300_000,
        executeFn: (agent) => this._executeOrchestratedAgent(agent),
      });
    }
    return this._orchestrator;
  }

  /**
   * Bridge between SubAgentOrchestrator's agent session and _runStandaloneAgent.
   * Called by the orchestrator's executeFn for each agent node.
   */
  async _executeOrchestratedAgent(agent) {
    const role = agent.context?.role || 'general';
    const subagentType = agent.context?.subagentType || 'general-purpose';
    const timeoutMs = agent.context?.timeoutMs || 120_000;
    const parentContext = agent.context?.parentContext || null;
    const route = agent.context?.route || {};

    // B3 — load/rework ledger keyed by the executor driving this subtask. The
    // active counter is inc'd here and dec'd on EVERY exit path (success, model
    // failure, local fallback, exception) so it can never leak.
    const executor = agent.executor || route.adapter || role;
    let agentStats = null;
    try { agentStats = require('../../services/agentStatsService'); } catch { /* optional */ }
    if (agentStats) { try { agentStats.incActive(executor); } catch { /* best-effort */ } }

    try {
      const result = await this._runStandaloneAgent(
        agent.task, role, subagentType, timeoutMs, parentContext, route
      );

      // If the model-based execution failed, try local mode fallback
      let reworked = result.success === false;
      if (!result.success) {
        const localResult = await _localModeFallback(agent.task, role, route.progressCallback);
        if (localResult) {
          if (agentStats) { try { agentStats.recordResult(executor, { reworked: true }); } catch { /* */ } }
          return localResult;
        }
      }

      if (agentStats) { try { agentStats.recordResult(executor, { reworked }); } catch { /* */ } }

      // Return structured result for aggregation
      return {
        text: result.output || '',
        toolCalls: result.toolCalls || 0,
        iterations: result.iterations || 0,
        elapsed: result.elapsed || '0s',
        success: result.success !== false,
        error: result.error || null,
        filesModified: result.filesModified || [],
      };
    } catch (err) {
      if (agentStats) { try { agentStats.recordResult(executor, { reworked: true }); } catch { /* */ } }
      throw err;
    } finally {
      if (agentStats) { try { agentStats.decActive(executor); } catch { /* */ } }
    }
  }

  /**
   * Run multiple subtasks in parallel via SubAgentOrchestrator.
   * Each subtask becomes a child agent; all execute concurrently.
   * Results are aggregated and returned as a formatted summary.
   */
  async _runOrchestrated(params, parentRole, subagentType, timeoutMs, parentContext, route = {}) {
    const startTime = Date.now();
    const startedAt = new Date().toISOString();
    const progressCallback = route.progressCallback || null;
    const orch = this._getOrchestrator();
    // B2 — orchestration mode: hardened (auditable SOP) | flexible (AI fan-out).
    // Default flexible to preserve current behavior. Per-subtask stepType may
    // override the run-level mode.
    const orchMode = (params.mode === 'hardened' || params.mode === 'mixed') ? params.mode : 'flexible';

    if (progressCallback) {
      progressCallback({ type: 'orchestrated_start', subtaskCount: params.subtasks.length, mode: orchMode });
    }

    // B2 — hardened SOP path: drive subtasks strictly in declared order through
    // the flowsEngine state machine instead of the concurrent fan-out. Flexible
    // (and mixed) runs keep the existing SubAgentOrchestrator path below.
    if (orchMode === 'hardened') {
      return await this._runHardenedFlow(
        params, parentRole, subagentType, timeoutMs, parentContext, route,
        { startTime, startedAt, orchMode }
      );
    }

    // Spawn root agent (coordinator — does not execute a task itself)
    const root = orch.spawnRoot({
      name: 'task-coordinator',
      task: params.prompt,
      role: parentRole,
    });
    // Transition root to RUNNING so children can be forked
    root.state = 'running';

    // Forward the orchestrator's lifecycle events to the UI progress channel so a
    // front-end (the ink TUI agent tree) can render one live branch per subtask.
    // We subscribe to the orchestrator's EXISTING EventEmitter — no new
    // orchestration logic — and detach once the children finish. Friendly labels
    // come from each subtask's role/name (the raw event name is just "subtask-N").
    // The coordinator root is skipped: the tree shows the worker subtasks only.
    let _detachOrchListeners = () => {};
    if (progressCallback && typeof orch.on === 'function') {
      const labelFor = (ev) => {
        const m = /subtask-(\d+)/.exec(ev && ev.name ? String(ev.name) : '');
        if (m) {
          const st = params.subtasks[Number(m[1]) - 1];
          if (st) return (st.role && String(st.role).trim()) || st.name || `子任务${m[1]}`;
        }
        return (ev && ev.name) || 'agent';
      };
      const fwd = (type) => (ev) => {
        if (!ev || ev.name === 'task-coordinator') return; // skip the root coordinator
        try {
          progressCallback({
            type,
            agentId: ev.agentId,
            name: labelFor(ev),
            depth: ev.depth,
            parentId: ev.parentId,
            error: ev.error && (ev.error.message || String(ev.error)),
          });
        } catch { /* progress is best-effort */ }
      };
      const handlers = {
        'agent:spawned': fwd('agent_spawned'),
        'agent:started': fwd('agent_started'),
        'agent:completed': fwd('agent_completed'),
        'agent:failed': fwd('agent_failed'),
        'agent:killed': fwd('agent_failed'),
      };
      for (const [evt, h] of Object.entries(handlers)) orch.on(evt, h);
      _detachOrchListeners = () => {
        for (const [evt, h] of Object.entries(handlers)) {
          try { orch.removeListener(evt, h); } catch { /* ignore */ }
        }
      };
    }

    // Fork child agents for each subtask
    for (let i = 0; i < params.subtasks.length; i++) {
      const st = params.subtasks[i];
      const childRole = st.role || parentRole;
      const roleToType = { explore: 'Explore', planner: 'Plan', general: 'general-purpose', implement: 'implement', verify: 'verify', audit: 'audit', fix: 'fix', research: 'research', reading: 'reading', map: 'map' };
      // B1/B2 — record executor (adapter/role driving the subtask) + stepType
      // (per-subtask override, else the run-level mode) for the rollup receipt.
      const stepType = st.stepType
        || (orchMode === 'hardened' ? 'hardened' : (orchMode === 'mixed' ? 'flexible' : 'flexible'));
      const executor = st.executor || route.adapter || childRole;
      orch.fork(root.id, {
        name: `subtask-${i + 1}`,
        task: st.prompt,
        role: childRole,
        executor,
        stepType,
        context: {
          role: childRole,
          subagentType: roleToType[childRole] || subagentType,
          timeoutMs,
          parentContext,
          route,
        },
      });
    }

    // Execute children with a hardware-derived fan-out width. Strong machines
    // run them all at once (limit=Infinity); weak machines cap the number in
    // flight, and KHY_ENABLE_MULTI_AGENT=false forces strictly serial execution.
    const fanout = _maxSubagentFanout();
    if (progressCallback && fanout !== Infinity) {
      progressCallback({ type: 'orchestrated_fanout', limit: fanout, total: root.childIds.length });
    }
    const childResults = await _mapSettledLimited(
      root.childIds, fanout, (id) => orch.execute(id)
    );

    // Mark root as completed
    root.state = 'completed';
    root.completedAt = Date.now();

    // Children are done — detach the orchestrator listeners (cleanup() below
    // tears the agents down regardless, but this releases the closures promptly).
    _detachOrchListeners();

    // B1 — orchestration rollup receipt: summarize the tree BEFORE cleanup
    // deletes the agents, then persist a single auditable receipt for the run.
    let orchReceipt = null;
    try {
      const summary = orch.summarize(root.id);
      orchReceipt = require('../../services/receiptService').saveOrchestrationReceipt({
        sessionId: route.sessionId || parentContext?.sessionId,
        goal: params.prompt,
        mode: orchMode,
        summary,
        startedAt,
      });
    } catch { /* rollup receipt is non-critical to the run */ }

    // Aggregate results
    const aggregated = orch.aggregateResults(root.id);
    const formatted = _formatAggregatedResult(aggregated);

    const elapsed = Date.now() - startTime;
    const successCount = childResults.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    const failCount = params.subtasks.length - successCount;

    if (progressCallback) {
      progressCallback({
        type: 'orchestrated_done',
        success: failCount === 0,
        subtaskCount: params.subtasks.length,
        successCount,
        failCount,
        elapsed,
      });
    }

    // Cleanup completed agents
    orch.cleanup();

    return {
      success: failCount === 0,
      subagent_type: subagentType,
      role: parentRole,
      output: formatted,
      subtaskResults: aggregated,
      subtaskCount: params.subtasks.length,
      successCount,
      failCount,
      mode: orchMode,
      orchestrationReceiptId: orchReceipt ? orchReceipt.id : null,
      elapsed: _fmtElapsed(elapsed),
      message: `Orchestrated ${params.subtasks.length} subtasks in ${_fmtElapsed(elapsed)} (${successCount} succeeded, ${failCount} failed).`,
    };
  }

  /**
   * B2 — hardened SOP orchestration. Drives subtasks strictly in declared order
   * through orchestrationFlow (flowsEngine), records an auditable step history,
   * and persists the same B1 rollup receipt as the flexible path. A human-gate
   * subtask parks the flow in WAITING; the run reports the pause rather than
   * inventing a new interruption channel.
   */
  async _runHardenedFlow(params, parentRole, subagentType, timeoutMs, parentContext, route, ctx) {
    const { startTime, startedAt, orchMode } = ctx;
    const progressCallback = route.progressCallback || null;
    const { runHardenedFlow } = require('../../services/orchestrationFlow');

    const executeSubtask = async (subtask, index) => {
      const childRole = subtask.role || parentRole;
      const roleToType = { explore: 'Explore', planner: 'Plan', general: 'general-purpose', implement: 'implement', verify: 'verify', audit: 'audit', fix: 'fix', research: 'research', reading: 'reading', map: 'map' };
      if (progressCallback) {
        progressCallback({ type: 'orchestrated_step', index, total: params.subtasks.length, name: subtask.name || `subtask-${index + 1}` });
      }
      // B3 — same load/rework ledger as the flexible path, keyed by executor.
      const executor = subtask.executor || route.adapter || childRole;
      let agentStats = null;
      try { agentStats = require('../../services/agentStatsService'); } catch { /* optional */ }
      if (agentStats) { try { agentStats.incActive(executor); } catch { /* */ } }
      try {
        const result = await this._runStandaloneAgent(
          subtask.prompt, childRole, roleToType[childRole] || subagentType,
          timeoutMs, parentContext, route
        );
        let reworked = result.success === false;
        if (!result.success) {
          const localResult = await _localModeFallback(subtask.prompt, childRole, route.progressCallback);
          if (localResult) {
            if (agentStats) { try { agentStats.recordResult(executor, { reworked: true }); } catch { /* */ } }
            return localResult;
          }
        }
        if (agentStats) { try { agentStats.recordResult(executor, { reworked }); } catch { /* */ } }
        return {
          text: result.output || '',
          toolCalls: result.toolCalls || 0,
          elapsed: result.elapsed || '0s',
          success: result.success !== false,
          error: result.error || null,
          filesModified: result.filesModified || [],
        };
      } catch (err) {
        if (agentStats) { try { agentStats.recordResult(executor, { reworked: true }); } catch { /* */ } }
        throw err;
      } finally {
        if (agentStats) { try { agentStats.decActive(executor); } catch { /* */ } }
      }
    };

    const flow = await runHardenedFlow({
      subtasks: params.subtasks,
      executeSubtask,
      mode: orchMode,
    });

    // Persist the B1 rollup receipt from the flow summary (same shape as the
    // SubAgentOrchestrator path) so both modes are auditable identically.
    let orchReceipt = null;
    try {
      orchReceipt = require('../../services/receiptService').saveOrchestrationReceipt({
        sessionId: route.sessionId || parentContext?.sessionId,
        goal: params.prompt,
        mode: orchMode,
        summary: flow.summary,
        startedAt,
      });
    } catch { /* rollup receipt is non-critical to the run */ }

    // Shape the flow results into the same aggregated form _formatAggregatedResult expects.
    const aggregated = flow.results.map((r, i) => ({
      agentId: `step-${i}`,
      name: (params.subtasks[i] && params.subtasks[i].name) || `subtask-${i + 1}`,
      depth: 1,
      result: r,
    })).filter(e => e.result);
    const formatted = _formatAggregatedResult(aggregated);

    const elapsed = Date.now() - startTime;
    const successCount = flow.summary.successCount;
    const failCount = flow.summary.failCount;

    if (progressCallback) {
      progressCallback({
        type: 'orchestrated_done',
        success: failCount === 0 && !flow.waiting,
        subtaskCount: params.subtasks.length,
        successCount,
        failCount,
        waiting: flow.waiting,
        elapsed,
      });
    }

    return {
      success: failCount === 0 && !flow.waiting,
      subagent_type: subagentType,
      role: parentRole,
      output: formatted,
      subtaskResults: aggregated,
      subtaskCount: params.subtasks.length,
      successCount,
      failCount,
      mode: orchMode,
      waiting: flow.waiting,
      flowState: flow.state,
      orchestrationReceiptId: orchReceipt ? orchReceipt.id : null,
      elapsed: _fmtElapsed(elapsed),
      message: flow.waiting
        ? `Hardened SOP paused at a human-gate after ${successCount}/${params.subtasks.length} steps.`
        : `Ran ${params.subtasks.length} subtasks as a hardened SOP in ${_fmtElapsed(elapsed)} (${successCount} succeeded, ${failCount} failed).`,
    };
  }
}

// ── Result aggregation ──────────────────────────────────────────────

/**
 * Format aggregated sub-agent results into a readable summary.
 * @param {Array<{agentId, name, depth, result}>} aggregated
 * @returns {string}
 */
function _formatAggregatedResult(aggregated) {
  if (!aggregated || aggregated.length === 0) return '(no subtask results)';

  const sections = [];
  for (const entry of aggregated) {
    const { name, result } = entry;
    if (!result) continue;
    const header = `### ${name}`;
    const status = result.success !== false ? 'Completed' : `Failed: ${result.error || 'unknown'}`;
    const body = result.text || '(no output)';
    const meta = [];
    if (result.toolCalls) meta.push(`Tool calls: ${result.toolCalls}`);
    if (result.elapsed) meta.push(`Time: ${result.elapsed}`);
    sections.push(`${header}\n**Status**: ${status}\n${body}${meta.length ? '\n_' + meta.join(' | ') + '_' : ''}`);
  }

  return `## Subtask Results\n\n${sections.join('\n\n---\n\n')}`;
}

// ── Model candidate builder ──────────────────────────────────────────

/**
 * Build an ordered list of model candidates for sub-agent fallback.
 * Cascade: explicit > agent definition > cloud lightweight > local > main model.
 *
 * Each candidate is { model, adapter?, label }:
 *   model   — preferredModel value ('' = gateway default / main model)
 *   adapter — override preferredAdapter for this candidate (e.g. 'ollama')
 *   label   — human-readable name for progress reporting
 */
function _buildModelCandidates(effectiveModel, userModel, agentDefModel, availableModels = null) {
  const candidates = [];
  const seen = new Set();
  const add = (model, adapter, label) => {
    const key = `${adapter || ''}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ model, adapter: adapter || null, label });
  };

  // 1. User-specified model (highest priority)
  if (effectiveModel) {
    add(effectiveModel, null, effectiveModel);
  }

  // 2. Cloud lightweight alternatives (only when agent definition sets model, not user override)
  if (agentDefModel && !userModel) {
    // When the active channel's available models are known, pick confirmed-available
    // ones (lightest-first, by tier fit) instead of the blind hardcoded list — so an
    // alias like 'haiku' resolves to a model the provider actually serves. Fail-soft:
    // null/empty → unchanged blind list (byte-identical legacy behavior).
    let injected = null;
    if (availableModels) {
      try {
        const _sel = require('../../services/subAgentModelSelect');
        const ids = _sel.selectAvailableModels(effectiveModel || agentDefModel, availableModels, { max: 3 });
        if (Array.isArray(ids) && ids.length) injected = ids.map((id) => ({ model: id, label: id }));
      } catch { injected = null; }
    }
    const cloudLightweight = injected || [
      { model: 'haiku', label: 'haiku' },
      { model: LIGHTWEIGHT_AGENT_MODELS[0], label: LIGHTWEIGHT_AGENT_MODELS[0] },
      { model: 'flash', label: 'gemini-flash' },
      { model: LIGHTWEIGHT_AGENT_MODELS[1], label: LIGHTWEIGHT_AGENT_MODELS[1] },
    ];
    for (const c of cloudLightweight) add(c.model, null, c.label);
  }

  // 3. Local models — detect available ollama/localLLM and add as candidates
  if (!userModel) {
    try {
      const ollamaAdapter = require('../../services/gateway/adapters/ollamaAdapter');
      if (ollamaAdapter.detect()) {
        const ollamaModels = ollamaAdapter.getModels?.() || [];
        // Prefer small/fast models for sub-agent work
        const smallFirst = [...ollamaModels].sort((a, b) => {
          const aSmall = /qwen.*0\.5|qwen.*1\.5|qwen.*3b|phi|gemma.*2b|llama.*3\.2|deepseek.*lite|coder.*1b/i.test(a) ? 0 : 1;
          const bSmall = /qwen.*0\.5|qwen.*1\.5|qwen.*3b|phi|gemma.*2b|llama.*3\.2|deepseek.*lite|coder.*1b/i.test(b) ? 0 : 1;
          return aSmall - bSmall;
        });
        // Add up to 2 local model candidates
        for (const m of smallFirst.slice(0, 2)) {
          add(m, 'ollama', `ollama:${m}`);
        }
      }
    } catch { /* ollama not available */ }

    try {
      const localLLMAdapter = require('../../services/gateway/adapters/localLLMAdapter');
      if (localLLMAdapter.detect()) {
        add('', 'localLLM', 'local-gguf');
      }
    } catch { /* localLLM not available */ }
  }

  // 4. Main model (gateway default) — ultimate fallback
  add('', null, '(main model)');

  return candidates;
}

/**
 * Local-mode fallback for any role: when all models fail,
 * attempt a heuristic alternative based on the agent's role.
 *
 * @param {string} prompt - Task description
 * @param {string} role - Agent role (explore/implement/verify/general)
 * @param {function} [progressCallback]
 * @returns {Promise<object|null>} Structured result or null if no fallback available
 */
async function _localModeFallback(prompt, role, progressCallback) {
  if (progressCallback) {
    progressCallback({ type: 'local_fallback', role, reason: 'model unavailable' });
  }

  switch (role) {
    case 'explore':
      // Heuristic file search (no LLM)
      return _localExploreFallback(prompt, progressCallback).then(text =>
        text ? { text, success: true, toolCalls: 0, iterations: 0, elapsed: '0s', error: null } : null
      );

    case 'verify': {
      // Try running common test commands
      try {
        const { execSync } = require('child_process');
        const _execCompat = require('../_execCompat');
        const cwd = process.env.KHYQUANT_CWD || process.cwd();
        const fs = require('fs');
        let cmd = null;
        if (fs.existsSync(require('path').join(cwd, 'package.json'))) cmd = 'npm test --if-present 2>&1';
        else if (fs.existsSync(require('path').join(cwd, 'Cargo.toml'))) cmd = 'cargo test 2>&1';
        else if (fs.existsSync(require('path').join(cwd, 'Makefile'))) cmd = 'make test 2>&1';
        if (!cmd) return null;
        // 非阻塞 exec 垫片(门控 KHY_EXEC_NONBLOCKING 默认开):测试可能久,同步 execSync 期间
        // 冻结事件循环(spinner 停 / ESC 死);换异步 exec 后事件循环照转;OFF 逐字节回退。
        const _opts = { cwd, timeout: 60_000, encoding: 'utf-8', maxBuffer: 1024 * 512 };
        const output = _execCompat.isNonBlockingExecEnabled(process.env)
          ? await _execCompat.execAsync(cmd, _opts)
          : execSync(cmd, _opts);
        return { text: `[本地测试结果]\n${output.slice(0, 2000)}`, success: true, toolCalls: 1, iterations: 1, elapsed: '0s', error: null };
      } catch (e) {
        const stderr = e.stderr ? String(e.stderr).slice(0, 1000) : e.message;
        return { text: `[测试失败]\n${stderr}`, success: false, toolCalls: 1, iterations: 1, elapsed: '0s', error: stderr.slice(0, 200) };
      }
    }

    case 'implement':
      // Cannot safely auto-modify code without a model
      return {
        text: '此子任务需要代码修改，但当前无可用模型。请手动执行或确保至少一个 AI 模型可用。',
        success: false,
        toolCalls: 0,
        iterations: 0,
        elapsed: '0s',
        error: 'no_model_for_implement',
      };

    case 'general':
    default:
      // Fall back to explore-style search for information gathering
      return _localExploreFallback(prompt, progressCallback).then(text =>
        text ? { text, success: true, toolCalls: 0, iterations: 0, elapsed: '0s', error: null } : null
      );
  }
}

/**
 * Local-mode explore fallback: when all models fail for an explore-type agent,
 * run exploreTool directly (heuristic search, no LLM needed).
 * Returns a result shaped like a sub-agent response.
 */
async function _localExploreFallback(prompt, progressCallback) {
  try {
    const exploreTool = require('../exploreTool');
    if (progressCallback) {
      progressCallback({ type: 'model_fallback', from: '(all models)', to: 'local-search', reason: 'all model candidates exhausted' });
    }
    const result = await exploreTool.execute({ query: prompt, max_results: 15 });
    if (!result?.success) return null;
    const d = result.data || {};
    const parts = [];
    if (d.files_found?.length > 0) {
      parts.push(`Found ${d.files_found.length} relevant files:\n${d.files_found.map(f => `  - ${f}`).join('\n')}`);
    }
    if (d.content_matches?.length > 0) {
      parts.push(`${d.content_matches.length} content matches.`);
    }
    if (d.file_previews?.length > 0) {
      for (const fp of d.file_previews) {
        if (fp.preview && !fp.preview.startsWith('[')) {
          parts.push(`--- ${fp.path} (${fp.lines || '?'} lines) ---\n${fp.preview}`);
        }
      }
    }
    return parts.join('\n\n') || null;
  } catch {
    return null;
  }
}

module.exports = new AgentTool();
module.exports.AgentTool = AgentTool;
module.exports.getBackgroundAgent = getBackgroundAgent;
module.exports.collectBackgroundResults = collectBackgroundResults;
module.exports.AGENT_TOOL_NAMES = AGENT_TOOL_NAMES;
// Exposed for unit tests — hardware-derived fan-out width and the bounded mapper.
module.exports._maxSubagentFanout = _maxSubagentFanout;
module.exports._mapSettledLimited = _mapSettledLimited;
module.exports._fmtElapsed = _fmtElapsed;
