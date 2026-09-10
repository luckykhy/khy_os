const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class FineTuningTool extends BaseTool {
  static toolName = 'FineTuning';
  static category = 'training';
  static risk = 'medium';
  static aliases = ['finetune', 'fine_tuning', 'train_model'];
  static searchHint = 'fine-tuning model training create job';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Managed model fine-tuning service.

Supported providers:
- "openai" — OpenAI Fine-tuning
- "azure" — Azure Fine-tuning
- "vertex" — Vertex AI Fine-tuning

Operations: create_job, list_jobs, get_job, cancel_job`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create_job', 'list_jobs', 'get_job', 'cancel_job'],
          description: 'Operation to perform',
        },
        provider: {
          type: 'string',
          enum: ['openai', 'azure', 'vertex', 'auto'],
          description: 'Fine-tuning provider (default: auto)',
        },
        trainingFileId: {
          type: 'string',
          description: 'Training file ID (for create_job)',
        },
        jobId: {
          type: 'string',
          description: 'Job ID (for get_job/cancel_job)',
        },
        model: {
          type: 'string',
          description: 'Base model to fine-tune',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_FINETUNE_TIMEOUT_MS',
      defaultMs: 60000,
      min: 1000,
      max: 120000,
    });

    try {
      const fineTuning = require('../../services/fineTuning');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        for (const p of fineTuning.listProviders()) {
          if (fineTuning.isProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No fine-tuning provider configured.' };
        }
      }

      switch (params.operation) {
        case 'create_job':
          if (!params.trainingFileId) {
            return { success: false, error: 'trainingFileId is required for create_job' };
          }
          return await withDeadline(
            () => fineTuning.createJob(provider, params.trainingFileId, { model: params.model }),
            timeoutMs
          );

        case 'list_jobs':
          return await withDeadline(
            () => fineTuning.listJobs(provider),
            timeoutMs
          );

        case 'get_job':
          if (!params.jobId) {
            return { success: false, error: 'jobId is required for get_job' };
          }
          return await withDeadline(
            () => fineTuning.getJob(provider, params.jobId),
            timeoutMs
          );

        case 'cancel_job':
          if (!params.jobId) {
            return { success: false, error: 'jobId is required for cancel_job' };
          }
          return await withDeadline(
            () => fineTuning.cancelJob(provider, params.jobId),
            timeoutMs
          );

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Fine-tuning error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `微调：${input.operation || ''}`;
  }
}

module.exports = FineTuningTool;
