/**
 * CLI Agent Runner — orchestrate parallel agent execution for complex tasks.
 *
 * Decomposes complex requests into sub-tasks, runs them in parallel
 * via specialized agents, and synthesizes results.
 *
 * Agent roles are configurable:
 *   ~/.khyquant/agent_roles.json — user override (platform data home)
 *   Built-in defaults: generic software-development agent templates
 *     (Claude/Codex-aligned). Domain-specific personas (e.g. quant trading
 *     analysts) belong to the corresponding upper-layer app, not this base.
 *
 * Concurrency: max 3 parallel, 200ms stagger to avoid rate limits.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeAgentRole } = require('./claudeCompat');
// Model-name SSOT: codex agent model ids flow from constants/models.js.
const { CODEX_AGENT_MODELS } = require('../constants/models');

let _toolRegistry; // lazy-load to avoid circular deps
function getToolRegistry() {
  if (!_toolRegistry) _toolRegistry = require('../tools');
  return _toolRegistry;
}

const MAX_CONCURRENT = 3;
const STAGGER_MS = 200;

// ── Agent Role Templates ──────────────────────────────────────────────

const DEFAULT_AGENT_ROLES = {
  // ── Generic fallback (domain-agnostic) ─────────────────────────────
  // `resolveRoleKey` returns 'general' when a role cannot be resolved, and
  // `decomposeTask` skips it during keyword matching (fallback-only). Keep it
  // domain-neutral — domain personas (e.g. quant analysts) live in the app layer.
  general: {
    name: 'General Assistant',
    systemPrompt:
      'You are a general-purpose assistant. Analyze the request from a holistic '
      + 'perspective and give a concise, professional answer.',
    keywords: [],
  },

  // ── Claude/Codex-style baseline aliases ────────────────────────────
  default: {
    name: 'Default Agent',
    systemPrompt:
      'You are a general-purpose autonomous coding agent. Solve tasks end-to-end with concise progress reporting.',
    keywords: ['default', 'agent default'],
    toolProfile: 'coding',
  },
  explorer: {
    name: 'Explorer Agent',
    systemPrompt:
      'You are an exploration agent. Search codebases quickly and report concrete findings with file paths.',
    keywords: ['explorer', 'code explorer'],
    toolProfile: 'minimal',
  },
  worker: {
    name: 'Worker Agent',
    systemPrompt:
      'You are a worker coding agent. Implement requested changes with edits and validation.',
    keywords: ['worker', 'coding worker'],
    toolProfile: 'coding',
  },

  // ── Generic software development agents ────────────────────────────
  explore: {
    name: 'Codebase Explorer',
    systemPrompt:
      'You are a fast codebase exploration agent. Search files with glob, search content with grep, read files with readFile. ' +
      'When the repository is unfamiliar, start with README or project manifests, then identify entry points and narrow the search. ' +
      'Stay strictly read-only. Avoid shell grep/find/cat loops when dedicated tools can answer directly. Be thorough but concise. Report file paths, key findings, search scope, result counts, and how you narrowed the search.',
    keywords: ['explore', 'find', 'search', 'where', 'how does', 'codebase', '查找', '搜索', '代码在哪', '哪里'],
    toolProfile: 'minimal',
  },
  planner: {
    name: 'Implementation Planner',
    systemPrompt:
      'You are a software architect agent. Read existing code to design implementation plans. ' +
      'Identify critical files, consider trade-offs, return step-by-step plans, and include a validation strategy. Do NOT write code.',
    keywords: ['plan', 'design', 'architect', 'how to implement', '计划', '设计', '架构', '怎么实现'],
    toolProfile: 'minimal',
  },
  coder: {
    name: 'Code Writer',
    systemPrompt:
      'You are a coding agent. Write clean, correct code following existing patterns. ' +
      'Read before modifying. Use absolute paths, use editFile for targeted changes, and use writeFile only for new files or intentional full rewrites. ' +
      'When editing, copy the exact old_string from the read result, prefer one focused edit at a time, and run tests after changes.',
    keywords: ['write', 'implement', 'fix', 'bug', 'code', 'refactor', '写代码', '实现', '修复', '重构'],
    toolProfile: 'coding',
  },
  reviewer: {
    name: 'Code Reviewer',
    systemPrompt:
      'You are a code review agent. Read changed files, analyze code quality, correctness, security, and performance. ' +
      'Provide specific feedback with file:line references.',
    keywords: ['review', 'check', 'audit', '审查', '检查', '代码审查'],
    toolProfile: 'minimal',
  },
  implement: {
    name: 'Implementer Agent',
    systemPrompt:
      'You are a precise implementation agent. Read relevant code first, then apply targeted edits with absolute paths. ' +
      'Use editFile for focused changes, writeFile only for new files or complete rewrites, copy exact old_string from the read result, and avoid placeholder TODO scaffolds. ' +
      'Define completion and choose the smallest sufficient scope before you edit. Prefer a single-file or single-function fix, do not refactor beyond scope, and do not mix the requested change with cleanup unless it is required for a safe completion. Keep task progress current for multi-step work, keep one major step active unless work is truly parallel, and record blockers explicitly. Use dedicated read/search/edit tools instead of shell equivalents when possible, and if a command fails, inspect stderr plus exit code before retrying. After 2-3 adjusted attempts on the same blocker, stop and report what you tried, what failed, the likely cause, and the next recovery option. Fix root causes rather than layering patches. Re-read or run the narrowest convincing syntax or test check after changes, then stop when the acceptance condition is met.',
    keywords: ['implement', 'implementer', 'apply change', '实现', '执行变更'],
    toolProfile: 'coding',
  },
  verify: {
    name: 'Verifier Agent',
    systemPrompt:
      'You are a verification agent. Run tests, linters, type checks, and builds to validate changes. ' +
      'Report pass/fail with exact error output, and if something cannot run, explain what you tried, the blocker, the likely cause, and the residual risk. Do NOT fix issues — only report findings.',
    keywords: ['verify', 'verifier', 'validate', 'test runner', '验证', '测试验收'],
    toolProfile: 'verification',
  },
  codex: {
    name: 'Codex Sub-Agent',
    systemPrompt:
      'You are a coding sub-agent routed via OpenAI Codex. Solve the assigned coding task end-to-end, ' +
      'use shell/file tools when needed, and return concise technical output.',
    keywords: ['codex', 'openai codex', ...CODEX_AGENT_MODELS],
    toolProfile: 'coding',
    preferredAdapter: 'codex',
  },
  claude: {
    name: 'Claude Sub-Agent',
    systemPrompt:
      'You are a coding sub-agent routed via Claude. Solve the assigned coding task end-to-end, ' +
      'use shell/file tools when needed, and return concise technical output.',
    keywords: ['claude', 'claude code', 'anthropic'],
    toolProfile: 'coding',
    preferredAdapter: 'claude',
  },

  // ── Claude-style built-in agent templates (compat aliases) ───────────
  'general-purpose': {
    name: 'General Purpose',
    systemPrompt:
      'You are a general-purpose autonomous coding agent. Solve tasks end-to-end with clear progress updates, ' +
      'call tools when needed, keep multi-step task tracking current, prefer dedicated tools over shell equivalents for file/search work, and provide concise technical summaries. Define completion and choose the smallest sufficient scope before broadening the work. Format simple results directly and complex ones with compact headings or flat bullets, put code in fenced markdown blocks, and add a Sources section for web-based facts. Keep carry-forward context focused on durable facts, decisions, blockers, and next steps instead of raw logs. Use the least privilege necessary, stay read-only on read-only tasks, redact secrets, and require explicit confirmation before irreversible or high-blast-radius actions. Delegate only independent sidecar work, assign clear ownership, and do not duplicate delegated work. After 2-3 adjusted attempts on the same blocker, stop and report the error, likely cause, and recovery path instead of looping.',
    keywords: ['general-purpose', 'general purpose', '通用代理', '综合执行'],
    toolProfile: 'coding',
  },
  Explore: {
    name: 'Explore',
    systemPrompt:
      'You are an exploration agent. Stay strictly read-only, search codebases quickly using glob/grep/read tools, start with README or project manifests when context is missing, avoid shell grep/find/cat loops when dedicated tools fit, and report concrete findings with file paths, search scope, and result counts.',
    keywords: ['explore', 'exploration', 'scan codebase', '代码探索', '仓库探索'],
    toolProfile: 'minimal',
  },
  Plan: {
    name: 'Plan',
    systemPrompt:
      'You are a planning agent. Break requests into executable, task-sized steps with explicit risks, dependencies, impacted files, validation strategy, and any work that can or cannot run in parallel.',
    keywords: ['plan', 'planning', 'execution plan', '制定计划', '任务拆解'],
    toolProfile: 'minimal',
  },
  verification: {
    name: 'Verification',
    systemPrompt:
      'You are a verification agent. Validate assumptions, run checks/tests where possible, and report pass/fail with evidence and residual risks for anything unverified.',
    keywords: ['verification', 'verify', 'validation', '检查验证', '验收'],
    toolProfile: 'minimal',
  },
  'claude-code-guide': {
    name: 'Claude Code Guide',
    systemPrompt:
      'You are a Claude Code workflow guide. Recommend tool-first execution patterns, permissions flow, and concise progress reporting.',
    keywords: ['claude-code-guide', 'claude code guide', 'claude workflow', 'claude 规范'],
    toolProfile: 'minimal',
  },
};

// Load custom agent roles from config file if available
function loadAgentRoles() {
  const customPath = path.join(os.homedir(), '.khyquant', 'agent_roles.json');
  try {
    if (fs.existsSync(customPath)) {
      const custom = JSON.parse(fs.readFileSync(customPath, 'utf-8'));
      // Merge: custom roles override defaults by key
      return { ...DEFAULT_AGENT_ROLES, ...custom };
    }
  } catch { /* fallback to defaults */ }
  return DEFAULT_AGENT_ROLES;
}

const AGENT_ROLES = loadAgentRoles();

function resolveRoleKey(roleKey) {
  const raw = String(roleKey || '').trim();
  if (!raw) return 'general';
  if (AGENT_ROLES[raw]) return raw;

  const normalized = normalizeAgentRole(raw);
  if (AGENT_ROLES[normalized]) return normalized;

  if (/^general[-_\s]?purpose$/i.test(raw) && AGENT_ROLES['general-purpose']) return 'general-purpose';
  if (/^explore$/i.test(raw) && AGENT_ROLES.Explore) return 'Explore';
  if (/^plan$/i.test(raw) && AGENT_ROLES.Plan) return 'Plan';

  return AGENT_ROLES.general ? 'general' : Object.keys(AGENT_ROLES)[0];
}

/**
 * Decompose a complex task into sub-tasks for parallel agent execution.
 * Uses keyword matching from agent role definitions.
 * @param {string} description - user's request
 * @returns {Array<{role: string, name: string, task: string}>}
 */
function decomposeTask(description) {
  const subtasks = [];
  const lower = description.toLowerCase();

  // Match agents by their keywords
  for (const [roleKey, role] of Object.entries(AGENT_ROLES)) {
    if (roleKey === 'general') continue; // general is fallback only
    if (!role.keywords || role.keywords.length === 0) continue;

    const matched = role.keywords.some(kw => lower.includes(kw.toLowerCase()));
    if (matched) {
      const resolvedRole = resolveRoleKey(roleKey);
      const resolved = AGENT_ROLES[resolvedRole] || role;
      subtasks.push({ role: resolvedRole, name: resolved.name, task: description });
    }
  }

  // Auto-compose generic dev workflows when multiple dev roles match
  const devRoles = ['explore', 'planner', 'coder', 'reviewer'];
  const matchedDev = subtasks.filter(st => devRoles.includes(st.role));
  if (matchedDev.length >= 2) {
    // Complex dev task: ensure explore runs first (then coder/planner)
    const hasExplore = matchedDev.some(st => st.role === 'explore');
    if (!hasExplore) {
      const exploreRole = resolveRoleKey('explore');
      subtasks.unshift({ role: exploreRole, name: (AGENT_ROLES[exploreRole] || AGENT_ROLES.explore).name, task: description });
    }
    return _dedupeSubtasks(subtasks);
  }

  // If no specific agents matched, or if it's a comprehensive analysis, use default set.
  if (subtasks.length === 0 || /全面|综合|多角度|多智能体|complete|comprehensive/.test(lower)) {
    // Default to the generic software-development workflow (explore → plan →
    // code → review). Skip any role missing from the registry so a trimmed
    // role set never produces undefined entries.
    const defaultRoles = devRoles
      .map((key) => [key, AGENT_ROLES[key]])
      .filter(([, role]) => role);
    return defaultRoles.map(([key, role]) => ({
      role: key, name: role.name, task: description,
    }));
  }

  return _dedupeSubtasks(subtasks);
}

function _dedupeSubtasks(subtasks) {
  const out = [];
  const seen = new Set();
  for (const st of subtasks) {
    const roleKey = resolveRoleKey(st.role);
    if (seen.has(roleKey)) continue;
    seen.add(roleKey);
    const role = AGENT_ROLES[roleKey] || AGENT_ROLES.general;
    out.push({ ...st, role: roleKey, name: role?.name || st.name });
  }
  return out;
}

/**
 * Run multiple agents in parallel with staggered starts.
 * @param {Array<{role: string, name: string, task: string}>} subtasks
 * @param {object} opts - { ai (the ai module), onProgress(agentIndex, status, detail) }
 * @returns {Promise<Array<{role: string, name: string, status: string, result: string, toolCalls: number, tokens: number, elapsed: number}>>}
 */
async function runAgents(subtasks, opts = {}) {
  const { ai: aiModule, onProgress } = opts;
  const results = new Array(subtasks.length).fill(null);
  const preferredAdapterOverride = String(opts.preferredAdapter || '').trim();
  const preferredModelOverride = String(opts.preferredModel || opts.model || '').trim();

  // Initialize agent states
  const agentStates = subtasks.map((st, i) => ({
    role: st.role,
    name: st.name,
    status: 'pending',
    toolCalls: 0,
    tokens: 0,
    elapsed: 0,
    detail: '',
    result: '',
  }));

  // Report initial state
  if (onProgress) onProgress(agentStates);

  // Concurrency-limited parallel execution
  let running = 0;
  let nextIndex = 0;

  return new Promise((resolve) => {
    function tryStartNext() {
      while (running < MAX_CONCURRENT && nextIndex < subtasks.length) {
        const idx = nextIndex++;
        running++;

        // Stagger starts
        const delay = idx > 0 ? STAGGER_MS * idx : 0;
        setTimeout(() => executeAgent(idx), delay);
      }
    }

    async function executeAgent(idx) {
      const subtask = subtasks[idx];
      const resolvedRole = resolveRoleKey(subtask.role);
      const role = AGENT_ROLES[resolvedRole] || AGENT_ROLES.general;
      agentStates[idx].role = resolvedRole;

      agentStates[idx].status = 'running';
      agentStates[idx].detail = '分析中...';
      if (onProgress) onProgress(agentStates);

      const startTime = Date.now();
      try {
        // Build agent-specific prompt
        const agentPrompt = `${role.systemPrompt}\n\n用户请求: ${subtask.task}\n\n请简洁专业地给出你的分析（不超过 300 字）。`;

        // Get profile-filtered tool definitions for this agent
        const chatOpts = {
          _isFollowUp: true,
          effort: 'medium',
        };
        // Capability-aware adapter selection: infer requirements from task + role
        let capabilityAdapter = '';
        if (!preferredAdapterOverride && !subtask.preferredAdapter && !role.preferredAdapter) {
          try {
            const { getCapabilityRegistry } = require('./gateway/capabilityRegistry');
            const registry = getCapabilityRegistry();
            const reqs = registry.inferRequirements(subtask.task, resolvedRole);
            const ranked = registry.bestAdaptersFor(reqs, { onlyAvailable: false, limit: 1 });
            if (ranked.length > 0) capabilityAdapter = ranked[0].key;
          } catch { /* registry not available */ }
        }
        const subtaskPreferredAdapter = String(
          preferredAdapterOverride
          || subtask.preferredAdapter
          || role.preferredAdapter
          || capabilityAdapter
          || ''
        ).trim();
        const subtaskPreferredModel = String(
          preferredModelOverride
          || subtask.preferredModel
          || role.preferredModel
          || ''
        ).trim();
        if (subtaskPreferredAdapter) chatOpts.preferredAdapter = subtaskPreferredAdapter;
        if (subtaskPreferredModel) chatOpts.preferredModel = subtaskPreferredModel;
        // #4 工具发现:按子任务文本预激活延迟工具簇(与 worker/agentWorkerEntry 子代理路径
        // 同款),让该被用的能力(浏览器/编译/密钥配置…)在 profile 过滤 + defer 隐藏前提前揭示。
        // 并行分解路径此前是唯一「按 profile 过滤延迟工具却不预激活」的本地缺口:模型拿到精简
        // 定义后必须先 ToolSearch 才能发现能力,而关键词召回不稳。selectToolsToActivate 门控关/
        // 无命中/异常 → 返 [],此循环不执行,逐字节回退今日「不预激活」行为。加法式、幂等、绝不抛。
        try {
          const { selectToolsToActivate } = require('./toolClusterActivation');
          const names = selectToolsToActivate(subtask.task);
          for (const name of names) {
            try { await getToolRegistry().ensureTool(name); } catch { /* 单个揭示失败不影响其余 */ }
          }
        } catch { /* 叶子不可用 → 不预激活,回退今日 */ }
        if (role.toolProfile) {
          try {
            chatOpts.toolDefinitions = getToolRegistry().getDefinitions(role.toolProfile);
          } catch { /* fallback: no filtering */ }
        }

        const result = await aiModule.chat(agentPrompt, chatOpts);

        const elapsed = Date.now() - startTime;
        agentStates[idx].status = 'completed';
        agentStates[idx].detail = 'Done';
        agentStates[idx].result = result.reply || '';
        agentStates[idx].tokens = result.tokenUsage?.totalTokens || 0;
        agentStates[idx].elapsed = elapsed;
        agentStates[idx].toolCalls = (result.commands || []).length;
      } catch (err) {
        agentStates[idx].status = 'error';
        agentStates[idx].detail = err.message || 'Failed';
        agentStates[idx].elapsed = Date.now() - startTime;
      }

      if (onProgress) onProgress(agentStates);

      running--;
      tryStartNext();

      // Check if all done
      if (agentStates.every(a => a.status === 'completed' || a.status === 'error')) {
        resolve(agentStates);
      }
    }

    tryStartNext();
  });
}

/**
 * Synthesize results from multiple agents into a unified response.
 * @param {Array<{name: string, result: string}>} agentResults
 * @param {string} originalRequest - the user's original request
 * @param {object} aiModule - the ai module
 * @returns {string} synthesized response
 */
async function synthesizeResults(agentResults, originalRequest, aiModule) {
  const validResults = agentResults.filter(r => r.status === 'completed' && r.result);

  if (validResults.length === 0) {
    // 主动协助 + 被动兜底（goal 2026-06-25）：不直接抛笼统套话，先抢救各子代理的
    // 失败原因 / 空产出，给出「哪个代理失败、为何失败、下一步建议」的诚实说明；
    // 确无任何信息可呈现时才回落套话。
    try {
      const _salvaged = require('./query/activeAssist').composeAgentAllFailedFallback(agentResults);
      if (_salvaged) return _salvaged;
    } catch { /* fail-soft：抢救出错绝不阻断兜底 */ }
    return '所有智能体均未能返回有效结果，请稍后重试。';
  }

  if (validResults.length === 1) {
    return validResults[0].result;
  }

  // Build synthesis prompt
  const agentOutputs = validResults.map(r =>
    `### ${r.name}\n${r.result}`
  ).join('\n\n');

  // 截断原始请求防止上下文爆炸（各子代理已独立处理完整内容）
  const MAX_ORIGINAL_LEN = 800;
  const truncatedRequest = originalRequest.length > MAX_ORIGINAL_LEN
    ? originalRequest.slice(0, MAX_ORIGINAL_LEN) + '\n...(内容已截断，完整内容已由各分析师独立处理)'
    : originalRequest;

  const synthesisPrompt = `以下是多个专业子代理对同一任务的独立处理结果。请综合各方输出，给出一个全面、平衡的最终结论。

原始任务: ${truncatedRequest}

${agentOutputs}

请输出:
1. 综合分析（整合各方观点，标注一致性和分歧点）
2. 核心结论
3. 后续建议`;

  // 合成请求作为正常 user 消息发送，不用 _isFollowUp（会被标记为 role:'tool' 触发反注入误判）
  const result = await aiModule.chat(synthesisPrompt, { _isSynthesis: true });
  return result.reply || agentOutputs;
}

/**
 * Check if a request should trigger multi-agent mode.
 * @param {string} input
 * @returns {boolean}
 */
function shouldUseMultiAgent(input) {
  return /多智能体|全面分析|多角度|综合分析|complete analysis|multi.?agent/i.test(input);
}

function listAgentTemplates() {
  return Object.entries(AGENT_ROLES).map(([key, role]) => ({
    key,
    name: role.name,
    toolProfile: role.toolProfile || 'full',
    keywordCount: Array.isArray(role.keywords) ? role.keywords.length : 0,
  }));
}

module.exports = {
  decomposeTask,
  runAgents,
  synthesizeResults,
  shouldUseMultiAgent,
  resolveRoleKey,
  listAgentTemplates,
  AGENT_ROLES,
  MAX_CONCURRENT,
};
