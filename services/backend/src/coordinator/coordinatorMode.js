/**
 * Coordinator Mode — multi-agent orchestration where the main AI
 * becomes a pure commander with only 3 tools: Agent, SendMessage, Shutdown.
 *
 * Workers run independently with full tool sets. The coordinator must
 * synthesize findings before delegating — no "delegation dumping".
 *
 * Ported from Claude Code's coordinator/coordinatorMode.ts.
 */
'use strict';

// ── Mode Control ───────────────────────────────────────────────────

/**
 * Check if coordinator mode is active.
 * @returns {boolean}
 */
function isCoordinatorMode() {
  const env = process.env.KHY_COORDINATOR_MODE;
  return env === 'true' || env === '1';
}

/**
 * Activate coordinator mode.
 */
function activateCoordinatorMode() {
  process.env.KHY_COORDINATOR_MODE = 'true';
}

/**
 * Deactivate coordinator mode.
 */
function deactivateCoordinatorMode() {
  process.env.KHY_COORDINATOR_MODE = 'false';
}

// ── Allowed Tools ──────────────────────────────────────────────────

const COORDINATOR_ALLOWED_TOOLS = new Set([
  'agent', 'sendMessage', 'shutdown',
]);

/**
 * Check if a tool is allowed for the coordinator.
 * @param {string} toolName
 * @returns {boolean}
 */
function isCoordinatorTool(toolName) {
  return COORDINATOR_ALLOWED_TOOLS.has(toolName);
}

// ── System Prompt ──────────────────────────────────────────────────

/**
 * Get the coordinator-specific system prompt.
 * @returns {string}
 */
function getCoordinatorSystemPrompt() {
  return `# Coordinator Mode

You are operating in Coordinator mode. You are a **pure orchestrator** — you do NOT execute code, read files, or run commands directly. Instead, you manage Workers who do the actual work.

## Your Tools (ONLY these 3)

1. **Agent** — Spawn a worker to perform a task
   \`Agent({ prompt: "detailed task description", subagent_type: "worker" })\`

2. **SendMessage** — Send follow-up instructions to a running worker
   \`SendMessage({ to: "worker-id", message: "additional instructions" })\`

3. **Shutdown** — Stop a running worker
   \`Shutdown({ worker_id: "worker-id" })\`

## Core Rules

### 1. No Delegation Dumping
**Never** write vague prompts like "based on your findings" or "look into this issue."
Each worker prompt MUST be self-contained with:
- Exact file paths and line numbers when known
- Specific changes to make
- Clear success criteria

### 2. Synthesize Before Delegating
When a research worker returns findings, YOU must understand and synthesize them before sending instructions to an implementation worker. Don't relay raw findings.

### 3. Maximize Parallelism
Launch independent workers concurrently. Only serialize when tasks have dependencies.

### 4. Task Workflow
1. **Research** → Send explorers to understand the problem
2. **Synthesis** → YOU analyze findings and design the solution
3. **Implementation** → Send coders with precise instructions
4. **Verification** → Send a reviewer to check the work

### 5. Worker Context
Workers CANNOT see your conversation history. Every prompt must include ALL context needed.

### 6. Status Tracking
Track worker status. When workers complete, acknowledge their results before proceeding.
`;
}

module.exports = {
  isCoordinatorMode,
  activateCoordinatorMode,
  deactivateCoordinatorMode,
  isCoordinatorTool,
  getCoordinatorSystemPrompt,
  COORDINATOR_ALLOWED_TOOLS,
};
