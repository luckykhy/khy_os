'use strict';

/**
 * PlanRetryTool — retry failed plan steps with root cause analysis.
 */

const { BaseTool } = require('../_baseTool');

class PlanRetryTool extends BaseTool {
  static toolName = 'PlanRetry';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['plan_retry', 'retry_step', 'retry_plan'];
  static searchHint = 'plan retry failed step root cause analysis';

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return false;
  }

  prompt() {
    return `Retry a failed plan step with mandatory root cause analysis.
Resets the step status to pending for re-execution.
Requires root cause analysis if step has failed 2+ times.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        stepId: {
          type: 'number',
          description: 'ID of the step to retry',
        },
        reasonAnalysis: {
          type: 'string',
          description: 'Root cause analysis (required if step failed 2+ times)',
        },
        force: {
          type: 'boolean',
          description: 'Force retry even if attempt limit reached (default: false)',
        },
      },
      required: ['stepId'],
    };
  }

  async execute(params) {
    try {
      const planMode = require('../../services/planModeService');
      const state = planMode.getState();

      if (state !== 'executing') {
        return { success: false, error: `Plan mode not in executing state (current: ${state})` };
      }

      const stepId = params.stepId;
      const step = planMode._currentPlan?.steps?.find((s) => s.id === stepId);

      if (!step) {
        return { success: false, error: `Step ${stepId} not found in current plan` };
      }

      if (!['failed', 'blocked', 'cancelled', 'error'].includes(step.status)) {
        return { success: false, error: `Step ${stepId} is not in a retryable state (current: ${step.status})` };
      }

      if ((step.retryCount || 0) >= 2 && !params.force) {
        const analysis = planMode.analyzeStepFailure(step);
        return {
          success: false,
          error: `Step ${stepId} has failed ${step.retryCount} times. Root cause analysis required.`,
          rootCause: analysis,
          hint: 'Provide reasonAnalysis parameter with detailed root cause analysis to force retry.',
        };
      }

      const result = planMode.retryPlanStep(stepId, {
        force: params.force || false,
        reasonAnalysis: params.reasonAnalysis,
      });

      if (!result) {
        return { success: false, error: `Failed to retry step ${stepId}` };
      }

      return {
        success: true,
        message: `Step ${stepId} reset to pending`,
        retryCount: step.retryCount,
        status: 'pending',
      };
    } catch (err) {
      return { success: false, error: `Plan retry error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `重试计划步骤 #${input.stepId || ''}`;
  }
}

module.exports = PlanRetryTool;
