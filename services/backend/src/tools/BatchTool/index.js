const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class BatchTool extends BaseTool {
  static toolName = 'Batch';
  static category = 'data';
  static risk = 'low';
  static aliases = ['batch', 'batch_process', 'create_batch'];
  static searchHint = 'batch processing api create list';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Batch processing API for large-scale operations.

Operations:
- "create_batch" — Create a batch job
- "list_batches" — List all batch jobs
- "get_batch" — Get batch status
- "cancel_batch" — Cancel a batch job
- "create_input_file" — Create input file for batch`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create_batch', 'list_batches', 'get_batch', 'cancel_batch', 'create_input_file'],
          description: 'Operation to perform',
        },
        inputFileId: {
          type: 'string',
          description: 'Input file ID (for create_batch)',
        },
        batchId: {
          type: 'string',
          description: 'Batch ID ( for get/cancel operations )',
        },
        jsonlContent: {
          type: 'string',
          description: 'JSONL content for input file',
        },
        endpoint: {
          type: 'string',
          description: 'API endpoint for batch (default: /v1/chat/completions)',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_BATCH_TIMEOUT_MS',
      defaultMs: 60000,
      min: 1000,
      max: 120000,
    });

    try {
      const batches = require('../../services/batches');

      if (!batches.isProviderConfigured('openai')) {
        return { success: false, error: 'OpenAI API Key not configured.' };
      }

      switch (params.operation) {
        case 'create_batch':
          if (!params.inputFileId) return { success: false, error: 'inputFileId is required' };
          return await withDeadline(
            () => batches.openaiCreateBatch(params.inputFileId, params.endpoint),
            timeoutMs
          );

        case 'list_batches':
          return await withDeadline(() => batches.openaiListBatches(), timeoutMs);

        case 'get_batch':
          if (!params.batchId) return { success: false, error: 'batchId is required' };
          return await withDeadline(() => batches.openaiGetBatch(params.batchId), timeoutMs);

        case 'cancel_batch':
          if (!params.batchId) return { success: false, error: 'batchId is required' };
          return await withDeadline(() => batches.openaiCancelBatch(params.batchId), timeoutMs);

        case 'create_input_file':
          if (!params.jsonlContent) return { success: false, error: 'jsonlContent is required' };
          return await withDeadline(
            () => batches.openaiCreateInputFile(params.jsonlContent),
            timeoutMs
          );

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Batch error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `批处理：${input.operation || ''}`;
  }
}

module.exports = BatchTool;
