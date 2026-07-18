/**
 * EnterPlanModeTool — enter structured planning mode.
 *
 * Triggers plan generation for complex tasks. The AI generates a numbered
 * execution plan that the user can approve, modify, or reject before execution.
 * Delegates to the planModeService for state management.
 */
const { BaseTool } = require('../_baseTool');

class EnterPlanModeTool extends BaseTool {
  static toolName = 'EnterPlanMode';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['plan_mode', 'enter_plan', 'start_plan'];
  static searchHint = 'plan mode planning structured task';
  static alwaysLoad = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Enter plan mode to create a structured execution plan for a complex task.

Use this tool when:
- A task requires 3+ steps and careful coordination
- The user explicitly asks for a plan before execution
- The task has risks that should be reviewed before proceeding
- You need user approval before making significant changes

Plan mode will:
1. Generate a numbered step-by-step execution plan
2. Present it to the user for review
3. Allow the user to approve, modify, skip steps, or cancel
4. Execute approved steps one by one with progress tracking

Do NOT use this tool for:
- Simple, single-step tasks
- Tasks the user wants done immediately without planning
- Informational or conversational requests

Provide a clear, detailed description of the task so the plan generator has full context.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        task_description: {
          type: 'string',
          description: 'Detailed description of the task to plan. Include all relevant context, constraints, and expected outcomes.',
        },
      },
      required: ['task_description'],
    };
  }

  getActivityDescription(input) {
    return `生成计划：${(input.task_description || '').slice(0, 40)}`;
  }

  async execute(params, _context) {
    const { task_description } = params;

    try {
      const planMode = require('../../services/planModeService');
      const currentState = planMode.getState();

      if (currentState !== 'idle') {
        return {
          success: false,
          error: `Plan mode is already active (state: ${currentState}). Use ExitPlanMode first.`,
        };
      }

      // Generate the plan
      const ai = require('../../cli/ai');
      const { plan, rawResponse, provider, elapsed } = await planMode.enterPlanMode(task_description, ai);

      if (!plan || !plan.steps || plan.steps.length === 0) {
        planMode.reset();
        return {
          success: false,
          error: 'Failed to generate a valid plan. The AI did not return structured steps.',
        };
      }

      return {
        success: true,
        state: planMode.getState(),
        plan: {
          steps: plan.steps,
          dataNeeds: plan.dataNeeds || [],
          expectedOutputs: plan.expectedOutputs || [],
          risks: plan.risks || [],
        },
        provider,
        elapsed,
        message: `Plan generated with ${plan.steps.length} steps. Use ExitPlanMode to approve and execute.`,
      };
    } catch (err) {
      try { require('../../services/planModeService').reset(); } catch { /* ignore */ }
      return { success: false, error: err.message };
    }
  }
}

module.exports = new EnterPlanModeTool();
module.exports.EnterPlanModeTool = EnterPlanModeTool;
