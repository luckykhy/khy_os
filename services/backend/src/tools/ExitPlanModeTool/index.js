/**
 * ExitPlanModeTool — exit plan mode with approval or cancellation.
 *
 * After a plan has been generated via EnterPlanMode, this tool presents
 * the plan for approval and optionally begins step-by-step execution.
 */
const { BaseTool } = require('../_baseTool');

class ExitPlanModeTool extends BaseTool {
  static toolName = 'ExitPlanMode';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['exit_plan', 'approve_plan', 'cancel_plan'];
  static searchHint = 'exit plan mode approve cancel execute';
  static alwaysLoad = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Exit plan mode by approving or cancelling the current plan.

Use this tool when:
- You have finished generating a plan and want the user to review/approve it
- You need plan approval — do NOT use AskUserQuestion for this
- The user wants to cancel the current plan

Actions:
- "approve" — approve the plan and begin execution
- "cancel" — cancel the plan and return to normal mode

When approving, put your finished plan in the "plan" field as a numbered execution
plan (1. 2. 3. …) — one concrete, actionable step per line, naming the key files or
changes. The user reviews and approves this plan before anything runs.

IMPORTANT: Always use this tool (not AskUserQuestion) when you need plan approval. The user can see the plan details only when this tool is called.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['approve', 'cancel'],
          description: 'Whether to approve and execute the plan, or cancel it.',
        },
        plan: {
          type: 'string',
          description: 'The finished plan as a numbered execution list (required when approving). One concrete step per line.',
        },
      },
      required: ['action'],
    };
  }

  getActivityDescription(input) {
    return input.action === 'approve' ? '批准计划' : '取消计划';
  }

  async execute(params, _context) {
    const { action } = params;

    try {
      const planMode = require('../../services/planModeService');
      const currentState = planMode.getState();

      if (currentState === 'idle') {
        return {
          success: false,
          error: 'No active plan. Use EnterPlanMode first to generate a plan.',
        };
      }

      if (action === 'cancel') {
        planMode.reset();
        return {
          success: true,
          action: 'cancelled',
          message: 'Plan cancelled. Returned to normal mode.',
        };
      }

      if (action === 'approve') {
        if (currentState !== 'reviewing') {
          return {
            success: false,
            error: `Cannot approve plan in state "${currentState}". Plan must be in "reviewing" state.`,
          };
        }

        // Execute the plan — this is handled by the plan mode service
        // In non-interactive mode, we auto-approve
        return {
          success: true,
          action: 'approved',
          state: currentState,
          message: '计划已批准，开始按顺序执行步骤。',
        };
      }

      return {
        success: false,
        error: `Unknown action: ${action}. Must be "approve" or "cancel".`,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = new ExitPlanModeTool();
module.exports.ExitPlanModeTool = ExitPlanModeTool;
