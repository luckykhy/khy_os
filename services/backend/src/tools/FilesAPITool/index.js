const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class FilesAPITool extends BaseTool {
  static toolName = 'FilesAPI';
  static category = 'storage';
  static risk = 'medium';
  static aliases = ['files_api', 'managed_files', 'file_storage'];
  static searchHint = 'files api upload list delete managed storage';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Managed file storage for AI model consumption.

Supported providers:
- "openai" — OpenAI Files API
- "local" — Local file storage (always available)

Operations: upload, list, delete`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['upload', 'list', 'delete'],
          description: 'Operation to perform',
        },
        provider: {
          type: 'string',
          enum: ['openai', 'local', 'auto'],
          description: 'File storage provider (default: auto)',
        },
        filePath: {
          type: 'string',
          description: 'Path to file (for upload operation)',
        },
        fileId: {
          type: 'string',
          description: 'File ID (for delete operation)',
        },
        purpose: {
          type: 'string',
          description: 'File purpose (e.g., "assistants", "general")',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_FILES_API_TIMEOUT_MS',
      defaultMs: 60000,
      min: 1000,
      max: 120000,
    });

    try {
      const files = require('../../services/files');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        if (files.isProviderConfigured('openai')) {
          provider = 'openai';
        } else {
          provider = 'local';
        }
      }

      switch (params.operation) {
        case 'upload':
          if (!params.filePath) {
            return { success: false, error: 'filePath is required for upload operation' };
          }
          return await withDeadline(
            () => files.uploadFile(provider, params.filePath, params.purpose),
            timeoutMs
          );

        case 'list':
          return await withDeadline(
            () => files.listFiles(provider, params.purpose),
            timeoutMs
          );

        case 'delete':
          if (!params.fileId) {
            return { success: false, error: 'fileId is required for delete operation' };
          }
          return await withDeadline(
            () => files.deleteFile(provider, params.fileId),
            timeoutMs
          );

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Files API error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `文件API：${input.operation || ''}`;
  }
}

module.exports = FilesAPITool;
