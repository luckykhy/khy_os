'use strict';

/**
 * smallModelPromptTemplates.js — Four-phase prompt templates for the
 * small-model (T2/T3) structured pipeline.
 *
 * Weak models drift when given open-ended agentic loops. This module supplies
 * phase-scoped instructions that force a plan → step → self-check → summary
 * cadence, plus few-shot tool-call examples per task type.
 *
 * Phases:
 *   PHASE_PLANNING       — emit an <execution_plan> (format compatible with
 *                          services/taskComplexity.js parseExecutionPlan():
 *                          numbered steps, optional [toolHint] bracket,
 *                          optional "← parallel_group: X" suffix)
 *   PHASE_STEP_EXECUTION — focus on the current step only, one tool call
 *   PHASE_SELF_CHECK     — compare step result vs plan expectation
 *   PHASE_SUMMARY        — done / key findings / remaining items
 *
 * Tier behavior: 'T3' gets ultra-compact templates (each ≤
 * T3_TEMPLATE_MAX_CHARS chars) to protect tiny context windows; every other
 * tier (or no tier) gets the standard template.
 *
 * Instruction text is Chinese (project user-facing language); code comments
 * are English (AGENTS.md).
 *
 * Pure leaf module: zero requires, zero IO, deterministic, never throws.
 * Tier names mirror services/modelTier.js (T3 = weak).
 *
 * @module services/smallModelPromptTemplates
 */

// ── Constants ────────────────────────────────────────────────────────────────

// Canonical phase identifiers (also the accepted `phase` argument values).
const PHASES = Object.freeze([
  'PHASE_PLANNING',
  'PHASE_STEP_EXECUTION',
  'PHASE_SELF_CHECK',
  'PHASE_SUMMARY',
]);

// Supported task types; unknown types normalize to 'general'.
const TASK_TYPES = Object.freeze(['code', 'analysis', 'dataFetch', 'general']);

// Hard cap for every T3 template (chars). Exported so tests can assert it;
// the ONLY place this number exists (zero-hardcoding rule).
const T3_TEMPLATE_MAX_CHARS = 400;

// Per-task-type tool hints. Names are real project tool names — see
// tools/toolProfile.js PROFILES (minimal/coding/analysis).
const TASK_TYPE_TOOL_HINTS = Object.freeze({
  code: 'readFile、grep、glob、editFile、shellCommand',
  analysis: 'readFile、grep、search、backtest',
  dataFetch: 'dataFetch、webSearch、readFile',
  general: 'readFile、grep、glob、shellCommand',
});

// ── Internal helpers (never throw) ──────────────────────────────────────────

/**
 * Normalize a task type to one of TASK_TYPES ('general' fallback).
 * @param {string} taskType
 * @returns {string}
 */
function _normalizeTaskType(taskType) {
  return TASK_TYPES.includes(taskType) ? taskType : 'general';
}

/**
 * True when the tier should receive the ultra-compact template family.
 * @param {string} tier - 'T0'|'T1'|'T2'|'T3'
 * @returns {boolean}
 */
function _isCompactTier(tier) {
  return tier === 'T3';
}

/**
 * Extract the current step (object) and position from a plan state.
 * Accepts { steps, currentStep } where currentStep is a 0-based index —
 * the same shape toolUseLoop keeps after parseExecutionPlan().
 * @param {object} planState
 * @returns {{ step: object|null, index: number, total: number }}
 */
function _currentStepInfo(planState) {
  const steps = planState && Array.isArray(planState.steps) ? planState.steps : [];
  const rawIndex = planState && Number.isInteger(planState.currentStep) ? planState.currentStep : 0;
  const index = rawIndex >= 0 && rawIndex < steps.length ? rawIndex : 0;
  return { step: steps.length > 0 ? steps[index] : null, index, total: steps.length };
}

/**
 * Render one plan step as "第 N/M 步：desc（建议工具：hint）".
 * @param {object|null} step
 * @param {number} index - 0-based
 * @param {number} total
 * @returns {string} Empty string when no step is available
 */
function _describeStep(step, index, total) {
  if (!step) {
    return '';
  }
  const desc = String(step.description || '').trim();
  const hint = String(step.toolHint || '').trim();
  const position = total > 0 ? `第 ${index + 1}/${total} 步` : '当前步骤';
  return hint ? `${position}：${desc}（建议工具：${hint}）` : `${position}：${desc}`;
}

// ── Phase template builders ──────────────────────────────────────────────────

/**
 * Standard planning instruction (T2 and above / no tier).
 * @param {string} taskType - normalized
 * @returns {string}
 */
function _planningStandard(taskType) {
  const hints = TASK_TYPE_TOOL_HINTS[taskType];
  return [
    '[系统] 这是一个多步骤任务。开始前请先输出执行计划：',
    '用 <execution_plan> 标签包裹 2-5 个编号步骤，每步一行；',
    '可在步骤描述前用方括号标注建议工具（如 [readFile]），',
    '可并行的步骤在行尾加 "← parallel_group: A" 标记。',
    `本任务常用工具：${hints}。`,
    '输出计划后立即开始执行第 1 步；每步只调用一个工具，收到结果后简要汇报再继续。',
  ].join('');
}

/**
 * Compact T3 planning instruction with a concrete format example.
 * The embedded example itself parses with taskComplexity.parseExecutionPlan().
 * @param {string} taskType - normalized
 * @returns {string}
 */
function _planningT3(taskType) {
  const hints = TASK_TYPE_TOOL_HINTS[taskType];
  // 「小步执行」行:弱模型最容易在长输出/多步任务上一次吞太多 → 截断或跑偏
  // (2026-09 会话 2deaa521)。明确要求每步小交付、长内容先骨架后逐段补全。
  // T3 模板须保持 ≤ T3_TEMPLATE_MAX_CHARS。
  return [
    `[系统] 先输出执行计划再动手。可用工具：${hints}。格式示例：`,
    '<execution_plan>',
    '1. [readFile] 读取目标文件',
    '2. [grep] 查找相关引用 ← parallel_group: A',
    '3. 完成修改并验证',
    '</execution_plan>',
    '小步执行：每步只做一个可独立完成的小交付；长内容先写骨架，再逐段补全，不要一次输出全部。',
    '计划后立即执行第 1 步：只调用一个工具，等结果返回再继续。',
  ].join('\n');
}

/**
 * Standard single-step execution instruction.
 * @param {object} planState
 * @returns {string}
 */
function _stepExecutionStandard(planState) {
  const { step, index, total } = _currentStepInfo(planState);
  const stepLine = _describeStep(step, index, total);
  return [
    '[系统] 现在只执行计划中的当前步骤，不要跳步、不要合并步骤。',
    stepLine ? `${stepLine}。` : '',
    '本轮只调用一个工具；收到工具结果后，用一两句话报告本步做了什么、结果如何，再进入下一步。',
    '如果当前步骤不再必要，说明原因并跳到下一步，不要静默改变计划。',
  ]
    .filter(Boolean)
    .join('');
}

/**
 * Compact T3 single-step execution instruction.
 * @param {object} planState
 * @returns {string}
 */
function _stepExecutionT3(planState) {
  const { step, index, total } = _currentStepInfo(planState);
  const stepLine = _describeStep(step, index, total);
  return [
    '[系统] 只做当前这一步。',
    stepLine ? `${stepLine}。` : '',
    '只调用一个工具，拿到结果后用一句话汇报，再进下一步。不要跳步。',
  ]
    .filter(Boolean)
    .join('');
}

/**
 * Standard self-check checklist.
 * @param {object} planState
 * @returns {string}
 */
function _selfCheckStandard(planState) {
  const { step, index, total } = _currentStepInfo(planState);
  const stepLine = _describeStep(step, index, total);
  return [
    '[系统] 在继续之前，请自检刚完成的步骤：',
    stepLine ? `（对照计划：${stepLine}）` : '',
    '1）本步实际结果与计划预期是否一致？若有差异，说明差异是什么；',
    '2）工具输出中是否包含 error、failed、异常堆栈等失败标记？',
    '3）若失败：判断是参数问题（修正参数重试同一工具）还是方向问题（说明原因并调整计划）；',
    '4）若成功：一句话确认后进入下一步。自检结论请显式写出，不要跳过。',
  ]
    .filter(Boolean)
    .join('');
}

/**
 * Compact T3 self-check checklist.
 * @returns {string}
 */
function _selfCheckT3() {
  return [
    '[系统] 自检刚才这一步：',
    '1）结果和计划预期一致吗？',
    '2）输出里有 error/failed 等失败标记吗？',
    '3）失败则修正参数重试一次；成功则一句话确认后进下一步。',
  ].join('');
}

/**
 * Standard summary instruction.
 * @param {object} planState
 * @returns {string}
 */
function _summaryStandard(planState) {
  const steps = planState && Array.isArray(planState.steps) ? planState.steps : [];
  const doneCount = steps.filter((s) => s && s.status === 'completed').length;
  const progressLine =
    steps.length > 0 ? `计划共 ${steps.length} 步，已完成 ${doneCount} 步。` : '';
  return [
    '[系统] 所有步骤已执行完毕（或无法继续），请输出最终汇总：',
    progressLine,
    '1）完成了什么：逐条列出实际完成的改动或产出（带文件名/命令等具体信息）；',
    '2）关键发现：执行过程中发现的重要事实或问题；',
    '3）未完成项：哪些步骤没有完成、原因是什么、建议下一步怎么做。',
    '汇总要基于真实执行结果，不要声称未验证过的效果。',
    '禁止虚构：汇总中点名的每个工具/步骤必须在本轮真实执行过，没调用过的工具不得写成已完成。',
  ]
    .filter(Boolean)
    .join('');
}

/**
 * Compact T3 summary instruction.
 * @returns {string}
 */
function _summaryT3() {
  // 「分三条」曾被弱模型执行成「列出三个已完成任务」(2026-09 会话 2deaa521:为凑满
  // 三条虚构了从未执行的 dataFetch 任务)。这里把「三」明确锚定为三段格式而非任务数,
  // 并显式禁止虚构;T3 模板须保持 ≤ T3_TEMPLATE_MAX_CHARS。
  return [
    '[系统] 任务结束。汇总按固定三段输出（「三段」是格式，不是三个任务）：',
    '① 完成了什么——只列本轮真实调用工具做过的事，带文件名等具体信息；',
    '② 关键发现——执行中确认的事实；',
    '③ 未完成项及原因——没做的如实写。',
    '禁止虚构：没调用过的工具、没执行过的步骤一律不得写成已完成；示例与计划不算完成。',
  ].join('');
}

// ── Few-shot examples ────────────────────────────────────────────────────────
// Each example is a 4-message round trip demonstrating one correct tool call
// AND the follow-up result handling:
//   user(task) → assistant(tool call) → user(tool result) → assistant(handling)
// Tool names are real project tools (tools/toolProfile.js). The <tool_call>
// JSON block is the canonical text demonstration form; the pipeline consumer
// (tasks #4/#5) may re-render it into the provider's native tool-call format.

/**
 * Build one 4-message example.
 * @param {string} task - User task text
 * @param {string} thought - Assistant's one-line intent before the call
 * @param {string} tool - Real tool name
 * @param {object} args - Tool arguments
 * @param {string} result - Simulated tool result text
 * @param {string} handling - Assistant's result-handling demonstration
 * @returns {Array<{role: string, content: string}>}
 */
function _example(task, thought, tool, args, result, handling) {
  const call = `${thought}\n<tool_call>\n${JSON.stringify({ name: tool, arguments: args })}\n</tool_call>`;
  return [
    { role: 'user', content: task },
    { role: 'assistant', content: call },
    { role: 'user', content: `[工具结果] ${result}` },
    { role: 'assistant', content: handling },
  ];
}

const FEW_SHOT_EXAMPLES = Object.freeze({
  code: [
    _example(
      '把 src/utils/date.js 里的 formatDate 函数改成支持时区参数',
      '我先读取目标文件，确认 formatDate 的当前实现。',
      'readFile',
      { path: 'src/utils/date.js' },
      'readFile 成功：文件共 42 行，formatDate(date) 定义在第 12-20 行，目前只接收一个参数。',
      '读取成功，无失败标记。本步结论：formatDate 定义在第 12-20 行，需要新增 timeZone 参数。与计划预期一致，下一步用 editFile 修改该函数签名与实现。'
    ),
    _example(
      '项目里哪些地方调用了 parseConfig？把入口文件里的调用处列出来',
      '我用 grep 在代码里搜索 parseConfig 的调用位置。',
      'grep',
      { pattern: 'parseConfig\\(', path: 'src' },
      'grep 找到 3 处匹配：src/index.js:8、src/cli.js:22、src/server.js:15。',
      '搜索成功，共 3 处调用。本步结论：入口文件 src/index.js 第 8 行有一处调用。与计划一致，下一步用 readFile 查看 src/index.js 第 8 行附近的上下文再汇报。'
    ),
  ],
  analysis: [
    _example(
      '分析当前回测策略的配置文件，找出收益率相关参数',
      '我先读取策略配置文件，定位收益率相关字段。',
      'readFile',
      { path: 'config/strategy.json' },
      'readFile 成功：配置包含 targetReturn: 0.15、stopLoss: 0.05、rebalanceDays: 30 等字段。',
      '读取成功。本步结论：收益率相关参数为 targetReturn（目标收益 15%）与 stopLoss（止损 5%）。与计划预期一致，下一步可用 backtest 验证这组参数的历史表现。'
    ),
    _example(
      '统计 services 目录下有多少个模块引用了 modelTier',
      '我用 grep 统计 services 目录中对 modelTier 的引用。',
      'grep',
      { pattern: "require\\('.*modelTier'\\)", path: 'services' },
      'grep 找到 5 处匹配，分布在 4 个不同文件中。',
      '搜索成功。本步结论：共 4 个模块引用了 modelTier（5 处 require）。数量已确认，与计划一致，下一步汇总各文件的引用用途。'
    ),
  ],
  dataFetch: [
    _example(
      '获取贵州茅台最近 30 天的日线行情',
      '我用 dataFetch 拉取该标的的日线数据。',
      'dataFetch',
      { symbol: '600519', period: 'daily', days: 30 },
      'dataFetch 成功：返回 30 条日线记录，最新收盘价与日期字段齐全。',
      '数据获取成功，30 条记录完整无缺失。与计划预期一致，本步完成。下一步基于这批数据做趋势汇总，不需要再次拉取。'
    ),
    _example(
      '查一下 Node.js 22 LTS 的官方发布时间',
      '这是外部事实查询，我用 webSearch 检索官方信息。',
      'webSearch',
      { query: 'Node.js 22 LTS release date official' },
      'webSearch 返回 5 条结果，第一条为 nodejs.org 官方发布公告。',
      '检索成功，已拿到官方来源。本步结论：以 nodejs.org 官方公告为准提取发布时间。与计划一致，下一步整理答案并注明来源链接。'
    ),
  ],
  general: [
    _example(
      '帮我找到项目里的 README 文件并看看第一段写了什么',
      '我先用 glob 定位 README 文件的路径。',
      'glob',
      { pattern: '**/README.md' },
      'glob 找到 2 个文件：README.md、kernel/README.md。',
      '定位成功，根目录 README.md 是目标文件。与计划一致，下一步用 readFile 读取它的开头部分再汇报第一段内容。'
    ),
    // Neutral demo (cwd query, not a version probe): the previous "node
    // --version → v22.11.0" demo seeded a Node-22 fixation in weak models
    // (session 2deaa521, 2026-09: they invented a "Node.js 22 LTS release
    // date" task out of it). Keep demos free of version numbers and nouns
    // that read like a pending task.
    _example(
      '看看当前工作目录的完整路径',
      '我用 shellCommand 执行目录查询命令。',
      'shellCommand',
      { command: 'cd' },
      'shellCommand 成功：输出 D:\\projects\\demo，退出码 0。',
      '命令执行成功，退出码 0 无错误。本步结论：当前工作目录为 D:\\projects\\demo。任务目标已达成，可直接汇总，无需更多工具调用。'
    ),
  ],
});

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the instruction prompt for one pipeline phase.
 *
 * @param {string} phase - One of PHASES ('PHASE_PLANNING' | 'PHASE_STEP_EXECUTION'
 *   | 'PHASE_SELF_CHECK' | 'PHASE_SUMMARY')
 * @param {object} [opts]
 * @param {string} [opts.tier] - 'T0'..'T3'; 'T3' selects the compact family
 * @param {string} [opts.taskType] - 'code'|'analysis'|'dataFetch'|'general'
 * @param {object} [opts.planState] - { steps: Array, currentStep: number }
 *   (shape of taskComplexity.parseExecutionPlan() output plus cursor)
 * @returns {string} Prompt text; empty string for unknown phase (never throws)
 */
function buildPhasePrompt(phase, opts = {}) {
  const tier = opts && opts.tier;
  const taskType = _normalizeTaskType(opts && opts.taskType);
  const planState = (opts && opts.planState) || null;
  const compact = _isCompactTier(tier);

  switch (phase) {
    case 'PHASE_PLANNING':
      return compact ? _planningT3(taskType) : _planningStandard(taskType);
    case 'PHASE_STEP_EXECUTION':
      return compact ? _stepExecutionT3(planState) : _stepExecutionStandard(planState);
    case 'PHASE_SELF_CHECK':
      return compact ? _selfCheckT3() : _selfCheckStandard(planState);
    case 'PHASE_SUMMARY':
      return compact ? _summaryT3() : _summaryStandard(planState);
    default:
      return '';
  }
}

/**
 * Few-shot tool-call examples for a task type.
 *
 * Returns a flat message array ready to splice before the real conversation.
 * Each example contributes 4 messages:
 *   user(task) → assistant(tool call via <tool_call> JSON block)
 *   → user('[工具结果] …') → assistant(result handling & next-step decision)
 *
 * @param {string} taskType - 'code'|'analysis'|'dataFetch'|'general'
 * @param {number} count - Number of examples to include (typically from
 *   constants/smallModelDefaults.getFewShotCount(tier)); invalid/0 → []
 * @returns {Array<{role: string, content: string}>}
 */
function getFewShotExamples(taskType, count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (n === 0) {
    return [];
  }
  const pool = FEW_SHOT_EXAMPLES[_normalizeTaskType(taskType)] || [];
  const picked = pool.slice(0, n);
  const flat = [];
  for (const example of picked) {
    for (const message of example) {
      flat.push({ role: message.role, content: message.content });
    }
  }
  return flat;
}

/**
 * Concise four-phase overview for the on-demand system prompt section
 * `small_model_structured_flow` (constants/prompts.js).
 * @returns {string}
 */
function buildStructuredFlowOverview() {
  const items = [
    '计划（PHASE_PLANNING）：先用 <execution_plan> 标签输出 2-5 个编号步骤（可选 [工具名] 前缀与 parallel_group 标记），再开始执行。',
    '单步执行（PHASE_STEP_EXECUTION）：每轮只做当前一步、只调用一个工具，收到结果后简要汇报再继续，不跳步。',
    '自检（PHASE_SELF_CHECK）：对照计划检查本步结果，识别 error/failed 等失败标记；失败先修正参数重试，方向错误则显式调整计划。',
    '汇总（PHASE_SUMMARY）：结束时输出"完成了什么 / 关键发现 / 未完成项"三段式总结，只陈述真实验证过的结果。',
  ];
  return ['# Small model structured flow', ...items.map((i) => ` - ${i}`)].join('\n');
}

module.exports = {
  PHASES,
  TASK_TYPES,
  T3_TEMPLATE_MAX_CHARS,
  TASK_TYPE_TOOL_HINTS,
  buildPhasePrompt,
  getFewShotExamples,
  buildStructuredFlowOverview,
};
