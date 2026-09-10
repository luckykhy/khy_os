const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class RerankTool extends BaseTool {
  static toolName = 'Rerank';
  static category = 'analysis';
  static risk = 'low';
  static aliases = ['rerank', 'rerank_documents', 're_rank'];
  static searchHint = 'rerank documents relevance query';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Re-rank documents by relevance to a query.

Supported providers:
- "cohere" — Cohere Rerank
- "together" — Together AI Rerank
- "voyage" — Voyage AI Rerank

Returns documents sorted by relevance score.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query to rank documents against',
        },
        documents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of document texts to rerank',
        },
        provider: {
          type: 'string',
          enum: ['cohere', 'together', 'voyage', 'auto'],
          description: 'Rerank provider (default: auto)',
        },
        topN: {
          type: 'number',
          description: 'Number of top results to return (default: all)',
          minimum: 1,
        },
      },
      required: ['query', 'documents'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_RERANK_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 60000,
    });

    try {
      const rerankService = require('../../services/rerank');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        for (const p of rerankService.listProviders()) {
          if (rerankService.isProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No rerank provider configured. Set KHY_RERANK_COHERE_API_KEY, KHY_RERANK_TOGETHER_API_KEY, or KHY_RERANK_VOYAGE_API_KEY.' };
        }
      }

      const result = await withDeadline(
        () => rerankService.rerank(provider, params.query, params.documents, {
          topN: params.topN,
        }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `Rerank timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `Rerank error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `重排序：${input.query?.slice(0, 40) || ''}`;
  }
}

module.exports = RerankTool;
