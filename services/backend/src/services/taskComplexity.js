'use strict';

/**
 * Task complexity scoring and auto-decomposition — multi-dimensional
 * heuristics for determining if a user message represents a complex
 * multi-step task, plus planning prompt injection.
 *
 * Extracted from toolUseLoop.js (lines 5152-5365) as part of the
 * industrial-grade modularization (Phase 1D).
 *
 * Dependencies: none.
 */

// ── Complexity scoring ───────────────────────────────────────────────

/**
 * Determine if a user message represents a complex multi-step task.
 * Uses multi-dimensional heuristics instead of simple keyword matching:
 *   1. Length — longer messages tend to be multi-step
 *   2. Structure — numbered lists, bullet points, multiple sentences
 *   3. Scope — mentions multiple files, components, or actions
 *   4. Connectives — sequential/parallel intent markers (weighted, not binary)
 *   5. Compound connectives — English linking phrases
 *   6. Multi-domain references — distinct system domains
 *
 * @param {string} message
 * @returns {{ isComplex: boolean, score: number }}
 */
function isComplexTask(message) {
  if (!message) return { isComplex: false, score: 0 };

  let score = 0;

  // Dimension 1: Length (graduated scoring)
  if (message.length > 500) score += 3;
  else if (message.length > 300) score += 2;
  else if (message.length > 150) score += 1;

  // Dimension 2: Structure indicators
  const lines = message.split('\n').filter(l => l.trim());
  if (lines.length >= 4) score += 2;
  // Numbered lists or bullet points
  const listItems = lines.filter(l => /^\s*(\d+[.、)）]|[-*·•►▶])\s/.test(l));
  if (listItems.length >= 2) score += 2;
  // Multiple sentences (Chinese or English)
  const sentenceCount = (message.match(/[。！？.!?]/g) || []).length;
  if (sentenceCount >= 3) score += 1;

  // Dimension 3: Scope — mentions of multiple targets
  const filePatterns = (message.match(/\.\w{1,5}\b/g) || []).length; // .js, .py, .vue etc.
  if (filePatterns >= 2) score += 1;
  const pathPatterns = (message.match(/[/\\]\w+/g) || []).length;
  if (pathPatterns >= 3) score += 1;
  // Multiple action verbs
  const actionVerbs = (message.match(/(修改|创建|删除|添加|修复|重构|实现|fix|add|create|update|remove|refactor|implement)/gi) || []).length;
  if (actionVerbs >= 3) score += 2;
  else if (actionVerbs >= 2) score += 1;

  // Dimension 4: Sequential/parallel connectives (lighter weight than before)
  const connectives = (message.match(/(然后|接着|之后|首先|最后|同时|分别|再|还需要|还要|then|first|next|finally|after that|also)/gi) || []).length;
  if (connectives >= 2) score += 2;
  else if (connectives >= 1) score += 1;

  // Dimension 5: English compound connectives linking independent clauses
  const compoundConnectives = (message.match(/\b(and also|as well as|in addition|additionally|plus|moreover|furthermore)\b/gi) || []).length;
  if (compoundConnectives >= 1) score += 1;

  // Dimension 6: Multi-domain references (distinct system domains)
  const domainKeywords = {
    auth: /\b(auth|login|password|session|token|credential|oauth|jwt|permission|rbac)\b/i,
    database: /\b(database|db|sql|table|migration|schema|query|orm|sqlite|postgres|mysql)\b/i,
    logging: /\b(log|logging|audit|trace|monitor|observability|metrics|telemetry)\b/i,
    network: /\b(http|api|endpoint|route|proxy|cors|websocket|sse|fetch|request)\b/i,
    ui: /\b(ui|frontend|component|render|css|style|layout|button|form|dialog)\b/i,
    testing: /\b(test|spec|assert|mock|fixture|coverage|e2e|integration)\b/i,
  };
  const domainCount = Object.values(domainKeywords).filter(re => re.test(message)).length;
  if (domainCount >= 3) score += 2;
  else if (domainCount >= 2) score += 1;

  // Threshold: score >= 4 is considered complex
  return { isComplex: score >= 4, score };
}

/**
 * Determine if a complex task should trigger auto-decomposition hints.
 * Requires higher complexity score AND visible parallel structure.
 * @param {string} message
 * @param {number} score - complexity score from isComplexTask
 * @returns {boolean}
 */
function shouldAutoDecompose(message, score) {
  if (score < 6) return false;
  // Detect explicit parallel structure: multiple independent items, numbered lists, "and...and"
  const hasParallelStructure = /(\band\b.*\band\b)|(同时.*同时)|(\d+\.\s.*\n\s*\d+\.\s)|(分别|各自|并行|parallel)/i.test(message);
  // Multiple independent action targets (3+ distinct file types or modules)
  const targets = (message.match(/\.\w{1,5}\b/g) || []).length;
  return hasParallelStructure || targets >= 3;
}

// ── Planning prompt injection ────────────────────────────────────────

/**
 * Inject planning instruction into the user message so AI outputs
 * an execution plan alongside tool calls in the same response.
 * @param {string} message
 * @param {object} [opts]
 * @param {boolean} [opts.autoDecompose]
 * @returns {string}
 */
function injectPlanningPrompt(message, opts = {}) {
  const planInst = [
    '[System: This task has multiple steps.',
    'Before starting, briefly outline your approach (2-5 numbered steps with specific file/function names).',
    'Wrap it in <execution_plan> tags. Then immediately begin the first step.',
    'Steps that can run in parallel should share a parallel_group label, e.g. "2. [read] Read config ← parallel_group: A".',
    'Between steps, provide a brief status update. Do NOT just silently chain tool calls.]',
  ].join(' ');

  // When auto-decompose is triggered, encourage Agent subtasks for parallel work
  if (opts.autoDecompose) {
    const decomposeHint = '\n[System: This task contains independent parts. If subtasks are independent and can benefit from parallel execution, use the Agent tool with a `subtasks` array to run them concurrently.]';
    return `${planInst}${decomposeHint}\n\n${message}`;
  }

  return `${planInst}\n\n${message}`;
}

// ── Execution plan parsing ───────────────────────────────────────────

/**
 * Parse an execution plan from AI response text.
 * @param {string} text - AI response
 * @returns {{steps: Array<{id: number, description: string, toolHint: string, status: string, parallelGroup: string|null}>} | null}
 */
function parseExecutionPlan(text) {
  if (!text) return null;
  const match = text.match(/<execution_plan>([\s\S]*?)<\/execution_plan>/);
  if (!match) return null;

  const planText = match[1].trim();
  const lines = planText.split('\n').filter(l => l.trim());
  const steps = [];

  for (const line of lines) {
    // Match patterns like: "1. [P0] [shell_command] Run git status" or "1. Check the file"
    // Optional parallel_group suffix: "← parallel_group: A" or "(parallel_group: B)"
    const stepMatch = line.match(/^\s*(\d+)\.\s*(.+)/);
    if (stepMatch) {
      const id = parseInt(stepMatch[1], 10);
      let rest = stepMatch[2].trim();
      let parallelGroup = null;

      // 优先级标号(goal 2026-06-25):抽出步骤头部任意位置的 [P0]/[P1]… 标签,单独
      // 成字段而非误当 toolHint。结构性提取、零依赖,开关关时不出现也无害。
      let priority = '';
      const prMatch = rest.match(/\[\s*(P\d)\s*\]/i);
      if (prMatch) {
        priority = prMatch[1].toUpperCase();
        rest = (rest.slice(0, prMatch.index) + rest.slice(prMatch.index + prMatch[0].length)).trim();
      }

      // Optional leading toolHint bracket, e.g. "[shell_command]".
      let toolHint = '';
      const thMatch = rest.match(/^\[([^\]]*)\]\s*/);
      if (thMatch) { toolHint = thMatch[1]; rest = rest.slice(thMatch[0].length).trim(); }
      let description = rest;

      // Extract parallel_group marker
      const pgMatch = description.match(/[←←]\s*parallel_group:\s*(\w+)\s*$/i)
        || description.match(/\(parallel_group:\s*(\w+)\)\s*$/i);
      if (pgMatch) {
        parallelGroup = pgMatch[1].toUpperCase();
        description = description.slice(0, description.indexOf(pgMatch[0])).trim();
      }

      steps.push({
        id,
        toolHint,
        priority,
        description,
        status: 'pending',
        parallelGroup,
      });
    }
  }

  return steps.length > 0 ? { steps } : null;
}

/**
 * Match a tool call to the most likely plan step.
 * Uses tool name matching and sequential advancement.
 * @param {string} toolName
 * @param {object} params
 * @param {object} plan - { steps: [...] }
 * @param {number} currentStep - Current plan step index
 * @returns {number} Matched step index, or -1 if no match
 */
function matchToolCallToStep(toolName, params, plan, currentStep) {
  if (!plan || !plan.steps || plan.steps.length === 0) return -1;

  // Helper: check if a step matches the tool call
  const _stepMatchesTool = (step) => {
    if (step.toolHint && toolName.includes(step.toolHint.replace(/_/g, ''))) return true;
    const desc = step.description.toLowerCase();
    const normalizedTool = toolName.replace(/_/g, ' ').toLowerCase();
    return desc.includes(normalizedTool) || desc.includes(toolName);
  };

  // Try matching current step first (sequential advancement)
  if (currentStep < plan.steps.length) {
    const step = plan.steps[currentStep];
    if (step.status !== 'completed') {
      if (_stepMatchesTool(step)) return currentStep;
      // Default: advance sequentially
      return currentStep;
    }
  }

  // If current step is in a parallel group, search within the same group first
  const currentGroup = (currentStep < plan.steps.length)
    ? plan.steps[currentStep].parallelGroup : null;
  if (currentGroup) {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.parallelGroup === currentGroup && step.status !== 'completed') {
        if (_stepMatchesTool(step)) return i;
      }
    }
    // Any pending step in the same group
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.parallelGroup === currentGroup && step.status !== 'completed') return i;
    }
  }

  // Look ahead for a matching step (any group)
  for (let i = currentStep + 1; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.status === 'completed') continue;
    if (_stepMatchesTool(step)) return i;
  }

  return -1;
}

module.exports = {
  isComplexTask,
  shouldAutoDecompose,
  injectPlanningPrompt,
  parseExecutionPlan,
  matchToolCallToStep,
};
