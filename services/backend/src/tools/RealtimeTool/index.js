const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class RealtimeTool extends BaseTool {
  static toolName = 'Realtime';
  static category = 'realtime';
  static risk = 'low';
  static aliases = ['realtime', 'websocket', 'streaming_api'];
  static searchHint = 'realtime api websocket streaming openai gemini';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Real-time WebSocket-based API for streaming communication.

Supported providers:
- "openai" — OpenAI Realtime API
- "gemini" — Gemini Realtime API
- "azure" — Azure Realtime API
- "xai" — xAI Realtime API

Returns a WebSocket connection for bidirectional streaming.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['connect', 'list_providers'],
          description: 'Action to perform',
        },
        provider: {
          type: 'string',
          enum: ['openai', 'gemini', 'azure', 'xai', 'auto'],
          description: 'Realtime API provider (default: auto)',
        },
        model: {
          type: 'string',
          description: 'Model to use for realtime session',
        },
      },
      required: ['action'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_REALTIME_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 60000,
    });

    try {
      const realtime = require('../../services/realtime');

      if (params.action === 'list_providers') {
        const providers = realtime.listProviders().map((p) => ({
          ...p,
          configured: realtime.isProviderConfigured(p.id),
        }));
        return { success: true, providers };
      }

      if (params.action === 'connect') {
        let provider = params.provider || 'auto';
        if (provider === 'auto') {
          for (const p of realtime.listProviders()) {
            if (realtime.isProviderConfigured(p.id)) {
              provider = p.id;
              break;
            }
          }
          if (provider === 'auto') {
            return { success: false, error: 'No realtime provider configured. Set KHY_REALTIME_OPENAI_API_KEY, KHY_REALTIME_GEMINI_API_KEY, etc.' };
          }
        }

        const result = await withDeadline(
          () => realtime.connect(provider, { model: params.model }),
          timeoutMs
        );

        if (result?.__timedOut) {
          return { success: false, error: `Realtime connection timeout after ${timeoutMs}ms` };
        }

        return result;
      }

      return { success: false, error: `Unknown action: ${params.action}` };
    } catch (err) {
      return { success: false, error: `Realtime error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `实时API：${input.action || ''}`;
  }
}

module.exports = RealtimeTool;
