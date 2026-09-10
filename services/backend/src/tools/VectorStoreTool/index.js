const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class VectorStoreTool extends BaseTool {
  static toolName = 'VectorStore';
  static category = 'storage';
  static risk = 'low';
  static aliases = ['vector_store', 'vector_db', 'embedding_store'];
  static searchHint = 'vector store embedding similarity search';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Store and query vector embeddings for semantic search.

Supported providers:
- "memory" — In-memory store (fast, ephemeral)
- "file" — File-backed store (persistent)

Operations: add, query, delete, size`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['add', 'query', 'delete', 'size'],
          description: 'Operation to perform',
        },
        provider: {
          type: 'string',
          enum: ['memory', 'file', 'auto'],
          description: 'Vector store provider (default: auto)',
        },
        id: {
          type: 'string',
          description: 'Vector ID (for add/delete operations)',
        },
        vector: {
          type: 'array',
          items: { type: 'number' },
          description: 'Embedding vector (for add operation)',
        },
        queryVector: {
          type: 'array',
          items: { type: 'number' },
          description: 'Query vector (for query operation)',
        },
        topK: {
          type: 'number',
          description: 'Number of results to return (default: 10)',
          minimum: 1,
          maximum: 100,
        },
        metadata: {
          type: 'object',
          description: 'Metadata to store with vector (for add operation)',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_VECTOR_STORE_TIMEOUT_MS',
      defaultMs: 10000,
      min: 100,
      max: 60000,
    });

    try {
      const vectorStore = require('../../services/vectorStore');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        provider = 'memory';
      }

      const store = vectorStore.createStore(provider);

      switch (params.operation) {
        case 'add':
          if (!params.id || !params.vector) {
            return { success: false, error: 'id and vector are required for add operation' };
          }
          return await withDeadline(
            () => store.add(params.id, params.vector, params.metadata),
            timeoutMs
          );

        case 'query':
          if (!params.queryVector) {
            return { success: false, error: 'queryVector is required for query operation' };
          }
          return await withDeadline(
            () => store.query(params.queryVector, params.topK || 10),
            timeoutMs
          );

        case 'delete':
          if (!params.id) {
            return { success: false, error: 'id is required for delete operation' };
          }
          return await withDeadline(
            () => store.delete(params.id),
            timeoutMs
          );

        case 'size':
          return await withDeadline(
            () => store.size(),
            timeoutMs
          );

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Vector store error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `向量存储：${input.operation || ''}`;
  }
}

module.exports = VectorStoreTool;
