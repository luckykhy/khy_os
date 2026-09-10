const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class EvalsTool extends BaseTool {
  static toolName = 'Evals';
  static category = 'analysis';
  static risk = 'low';
  static aliases = ['evals', 'evaluation', 'test_model'];
  static searchHint = 'model evaluation testing metrics';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Model evaluation and testing service.

Operations:
- "run" — Run a single evaluation
- "batch" — Run batch evaluations
- "compare" — Compare multiple models
- "list" — List evaluation history
- "save" — Save evaluation result`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['run', 'batch', 'compare', 'list', 'save'],
          description: 'Operation to perform',
        },
        model: {
          type: 'string',
          description: 'Model to evaluate (for run operation)',
        },
        prompt: {
          type: 'string',
          description: 'Evaluation prompt',
        },
        expectedOutput: {
          type: 'string',
          description: 'Expected output for comparison',
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evaluation metrics (accuracy, relevance, coherence, fluency, safety)',
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Models to compare (for compare operation)',
        },
        evaluations: {
          type: 'array',
          description: 'Evaluation configs (for batch operation)',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_EVALS_TIMEOUT_MS',
      defaultMs: 120000,
      min: 1000,
      max: 300000,
    });

    try {
      const evals = require('../../services/evals');

      switch (params.operation) {
        case 'run':
          if (!params.model || !params.prompt) {
            return { success: false, error: 'model and prompt are required' };
          }
          return await withDeadline(
            () => evals.runEvaluation({
              model: params.model,
              prompt: params.prompt,
              expectedOutput: params.expectedOutput,
              metrics: params.metrics,
            }),
            timeoutMs
          );

        case 'batch':
          if (!params.evaluations) {
            return { success: false, error: 'evaluations array is required' };
          }
          return await withDeadline(
            () => evals.runBatchEvaluations(params.evaluations),
            timeoutMs
          );

        case 'compare':
          if (!params.models || !params.prompt) {
            return { success: false, error: 'models and prompt are required' };
          }
          return await withDeadline(
            () => evals.compareModels(params.models, params.prompt),
            timeoutMs
          );

        case 'list':
          return await withDeadline(() => evals.listEvaluationResults(), timeoutMs);

        case 'save':
          if (!params.evaluations) {
            return { success: false, error: 'evaluations result is required' };
          }
          return await withDeadline(
            () => evals.saveEvaluationResult(params.evaluations),
            timeoutMs
          );

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Evals error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `评估：${input.operation || ''}`;
  }
}

module.exports = EvalsTool;
