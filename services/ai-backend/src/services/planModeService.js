/**
 * Plan Mode Service — structured plan → approve → execute workflow.
 *
 * When a complex task is detected, AI generates a numbered execution plan.
 * The user can approve, modify, or reject before step-by-step execution.
 *
 * State machine: idle → generating → reviewing → executing → complete
 */
const readline = require('readline');

// ── State ─────────────────────────────────────────────────────────────
let _state = 'idle'; // idle | generating | reviewing | executing | complete
let _currentPlan = null;

// ── Plan Prompt Template ──────────────────────────────────────────────
const PLAN_PROMPT = `[大型任务 — 请先制定详细执行计划]

用户请求: {REQUEST}

请输出一个结构化的执行计划，格式如下:

## 执行计划
1. [步骤描述]
2. [步骤描述]
...

## 需要的数据
- [数据项]

## 预计输出
- [输出描述]

## 风险与注意事项
- [风险项]

注意: 每个步骤应独立可执行，步骤之间有明确的输入/输出关系。`;

/**
 * Enter plan mode: generate a plan from AI.
 * @param {string} userRequest - the user's original request
 * @param {object} aiModule - the ai module (lazy-loaded)
 * @param {object} [opts] - { onChunk, effort }
 * @returns {{ plan: object, rawResponse: string }}
 */
async function enterPlanMode(userRequest, aiModule, opts = {}) {
  _state = 'generating';

  const prompt = PLAN_PROMPT.replace('{REQUEST}', userRequest);
  const result = await aiModule.chat(prompt, {
    ...opts,
    _isFollowUp: false,
  });

  if (!result.reply) {
    _state = 'idle';
    return { plan: null, rawResponse: '' };
  }

  const plan = parsePlanFromResponse(result.reply);
  _currentPlan = plan;
  _state = 'reviewing';

  return { plan, rawResponse: result.reply, provider: result.provider, elapsed: result.elapsed };
}

/**
 * Parse a numbered plan from AI response text.
 * Extracts steps from patterns like "1. xxx\n2. xxx\n..."
 *
 * @param {string} text - AI response containing a plan
 * @returns {{ steps: Array<{id: number, description: string, status: string}>, dataNeeds: string[], expectedOutputs: string[], risks: string[] }}
 */
function parsePlanFromResponse(text) {
  const plan = {
    steps: [],
    dataNeeds: [],
    expectedOutputs: [],
    risks: [],
  };

  // Extract numbered steps
  const stepPattern = /(?:^|\n)\s*(\d+)[.、）)]\s*(.+)/g;
  const matches = [...text.matchAll(stepPattern)];
  for (const m of matches) {
    plan.steps.push({
      id: parseInt(m[1], 10),
      description: m[2].trim().slice(0, 100),
      status: 'pending', // pending | in_progress | completed | skipped | error
    });
  }

  // Extract data needs section
  const dataSection = text.match(/需要的数据[\s\S]*?(?=##|$)/);
  if (dataSection) {
    const dataItems = [...dataSection[0].matchAll(/[-•]\s*(.+)/g)];
    plan.dataNeeds = dataItems.map(m => m[1].trim());
  }

  // Extract expected outputs section
  const outputSection = text.match(/预计输出[\s\S]*?(?=##|$)/);
  if (outputSection) {
    const outputItems = [...outputSection[0].matchAll(/[-•]\s*(.+)/g)];
    plan.expectedOutputs = outputItems.map(m => m[1].trim());
  }

  // Extract risks section
  const riskSection = text.match(/风险[\s\S]*?(?=##|$)/);
  if (riskSection) {
    const riskItems = [...riskSection[0].matchAll(/[-•]\s*(.+)/g)];
    plan.risks = riskItems.map(m => m[1].trim());
  }

  return plan;
}

/**
 * Present plan for user approval via interactive prompt.
 * @param {object} plan - parsed plan object
 * @param {object} renderer - aiRenderer module
 * @param {readline.Interface} rl - existing readline interface
 * @returns {Promise<{approved: boolean, modifications: string[]}>}
 */
async function presentForApproval(plan, renderer, rl) {
  // Render plan as task checklist
  const planTracker = new renderer.TaskPlanTracker();
  for (const step of plan.steps) {
    planTracker.addTask(step.description);
  }
  planTracker.render();

  // Show data needs and risks if present
  let _chalk;
  const c = () => (_chalk ??= (require('chalk').default || require('chalk')));

  if (plan.dataNeeds.length > 0) {
    console.log('');
    console.log(c().dim('  需要的数据:'));
    plan.dataNeeds.forEach(d => console.log(c().dim(`    • ${d}`)));
  }

  if (plan.risks.length > 0) {
    console.log('');
    console.log(c().yellow('  风险提示:'));
    plan.risks.forEach(r => console.log(c().yellow(`    ⚠ ${r}`)));
  }

  console.log('');
  console.log(c().cyan('  操作: ') +
    c().white('Enter') + c().dim(' 确认执行 · ') +
    c().white('skip N') + c().dim(' 跳过步骤 · ') +
    c().white('edit N 描述') + c().dim(' 修改步骤 · ') +
    c().white('n') + c().dim(' 取消')
  );

  return new Promise((resolve) => {
    rl.question(c().dim('  > '), (answer) => {
      const trimmed = answer.trim().toLowerCase();

      if (!trimmed || trimmed === 'y' || trimmed === 'yes') {
        resolve({ approved: true, modifications: [] });
        return;
      }

      if (trimmed === 'n' || trimmed === 'no' || trimmed === '取消') {
        _state = 'idle';
        _currentPlan = null;
        resolve({ approved: false, modifications: [] });
        return;
      }

      // Handle modifications
      const modifications = [];
      const commands = trimmed.split(/[;,]/);
      for (const cmd of commands) {
        const skipMatch = cmd.trim().match(/^skip\s+(\d+)/i);
        const editMatch = cmd.trim().match(/^edit\s+(\d+)\s+(.+)/i);
        const addMatch = cmd.trim().match(/^add\s+(?:after\s+)?(\d+)\s+(.+)/i);

        if (skipMatch) {
          const idx = parseInt(skipMatch[1], 10) - 1;
          if (idx >= 0 && idx < plan.steps.length) {
            plan.steps[idx].status = 'skipped';
            modifications.push(`Skipped step ${skipMatch[1]}`);
          }
        } else if (editMatch) {
          const idx = parseInt(editMatch[1], 10) - 1;
          if (idx >= 0 && idx < plan.steps.length) {
            plan.steps[idx].description = editMatch[2].trim();
            modifications.push(`Edited step ${editMatch[1]}`);
          }
        } else if (addMatch) {
          const afterIdx = parseInt(addMatch[1], 10);
          plan.steps.splice(afterIdx, 0, {
            id: afterIdx + 1,
            description: addMatch[2].trim(),
            status: 'pending',
          });
          // Re-number
          plan.steps.forEach((s, i) => { s.id = i + 1; });
          modifications.push(`Added step after ${addMatch[1]}`);
        }
      }

      if (modifications.length > 0) {
        // Re-render modified plan and ask again
        resolve({ approved: true, modifications });
      } else {
        // Unknown input, treat as approval
        resolve({ approved: true, modifications: [] });
      }
    });
  });
}

/**
 * Execute plan steps one by one with live progress tracking.
 * @param {object} plan - the plan with steps
 * @param {object} opts - { ai, renderer, rl, route, parseInput }
 * @returns {Array<{step: object, result: object}>}
 */
async function executePlanSteps(plan, opts) {
  const { ai: aiModule, renderer, rl } = opts;
  _state = 'executing';

  const results = [];
  const planTracker = new renderer.TaskPlanTracker();

  // Add all non-skipped steps
  const activeSteps = plan.steps.filter(s => s.status !== 'skipped');
  for (const step of activeSteps) {
    planTracker.addTask(step.description);
  }
  planTracker.render();

  for (let i = 0; i < activeSteps.length; i++) {
    const step = activeSteps[i];
    planTracker.start(i);

    try {
      // Execute step via AI with follow-up flag (prevents recursive plan mode)
      const stepPrompt = `[执行计划步骤 ${step.id}/${plan.steps.length}]\n\n任务: ${step.description}\n\n请执行此步骤并返回结果。如需使用工具，在回复中包含 [CMD:...] 指令。`;

      const result = await aiModule.chat(stepPrompt, { _isFollowUp: true });

      if (result.reply) {
        planTracker.complete(i);
        step.status = 'completed';
        results.push({ step, result });
      } else {
        planTracker.fail(i);
        step.status = 'error';
        results.push({ step, result: { error: 'No response' } });
      }
    } catch (err) {
      planTracker.fail(i);
      step.status = 'error';
      results.push({ step, result: { error: err.message } });
    }
  }

  _state = 'complete';
  _currentPlan = null;

  return results;
}

/**
 * Get current plan mode state.
 */
function getState() {
  return _state;
}

/**
 * Reset plan mode to idle.
 */
function reset() {
  _state = 'idle';
  _currentPlan = null;
}

module.exports = {
  enterPlanMode,
  parsePlanFromResponse,
  presentForApproval,
  executePlanSteps,
  getState,
  reset,
  PLAN_PROMPT,
};
