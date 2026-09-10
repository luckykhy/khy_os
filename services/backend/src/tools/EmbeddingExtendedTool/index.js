const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class EmbeddingExtendedTool extends BaseTool {
  static toolName = 'EmbeddingExtended';
  static category = 'multimodal';
  static risk = 'low';
  static aliases = ['embed_extended', 'embed_provider'];
  static searchHint = 'embedding vector text similarity';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Generate text embeddings using multiple providers.

Supported providers:
- "openai" — OpenAI text-embedding-3-small/large
- "voyage" — Voyage AI
- "jina" — Jina AI
- "cohere" — Cohere Embed

Returns high-dimensional vector representations of text for semantic search and similarity.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of text strings to embed',
        },
        provider: {
          type: 'string',
          enum: ['openai', 'voyage', 'jina', 'cohere', 'auto'],
          description: 'Embedding provider (default: auto)',
        },
        model: {
          type: 'string',
          description: 'Model name (provider-specific)',
        },
      },
      required: ['texts'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_EMBED_EXTENDED_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 60000,
    });

    try {
      const extEmbed = require('../../services/extendedEmbeddingProviders');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        for (const p of extEmbed.listExtendedProviders()) {
          if (extEmbed.isExtendedProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No embedding provider configured. Set KHY_EMBED_OPENAI_API_KEY, KHY_EMBED_VOYAGE_API_KEY, KHY_EMBED_JINA_API_KEY, or KHY_EMBED_COHERE_API_KEY.' };
        }
      }

      const result = await withDeadline(
        () => extEmbed.embedWithProvider(provider, params.texts, { model: params.model }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `Embedding timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `Embedding error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `生成嵌入向量：${input.texts?.length || 0} 条文本`;
  }
}

module.exports = EmbeddingExtendedTool;
