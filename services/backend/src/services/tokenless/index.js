/**
 * Tokenless — unified entry point for token optimization.
 *
 * Combines schema compression, response compression, and history rewriting
 * into a single Gateway plugin interface.
 */
const { compressSchema, compressTools } = require('./schemaCompressor');
const { compressResponse, compressToolOutput } = require('./responseCompressor');
const { rewriteHistory, stripCompletedToolCalls } = require('./commandRewriter');
const toonCodec = require('./toonCodec');

// Cumulative stats across the session
const _stats = {
  schemaTokensSaved: 0,
  responseTokensSaved: 0,
  historyTokensSaved: 0,
  totalRequests: 0,
};

/**
 * Gateway plugin interface for pluginChain integration.
 */
const tokenlessPlugin = {
  name: 'tokenless',
  priority: 900, // run early in the chain
  hooks: {
    /**
     * Compress tool schemas and rewrite history before sending to LLM.
     */
    onBeforeRequest: async (ctx, next) => {
      _stats.totalRequests++;

      // Compress tool schemas
      if (ctx.tools && Array.isArray(ctx.tools)) {
        const { tools, stats } = compressTools(ctx.tools);
        ctx.tools = tools;
        if (stats) _stats.schemaTokensSaved += stats.savedPercent;
      }

      // Rewrite conversation history
      if (ctx.messages && Array.isArray(ctx.messages) && ctx.messages.length > 6) {
        const { messages, stats } = rewriteHistory(ctx.messages, {
          keepRecent: 4,
          maxHistoryTokens: 500,
        });
        ctx.messages = messages;
        _stats.historyTokensSaved += stats.estimatedSaved;
      }

      return next(ctx);
    },

    /**
     * Compress tool outputs in the response.
     */
    onAfterResponse: async (ctx, next) => {
      if (ctx.response?.content && typeof ctx.response.content === 'string') {
        const { text, stats } = compressResponse(ctx.response.content, {
          stripFillers: false, // don't alter user-facing responses
          collapseWhitespace: true,
        });
        ctx.response.content = text;
        _stats.responseTokensSaved += stats.savedPercent;
      }
      return next(ctx);
    },
  },
};

function getStats() {
  return { ..._stats };
}

function resetStats() {
  Object.keys(_stats).forEach(k => { _stats[k] = 0; });
}

module.exports = {
  // Individual modules
  compressSchema,
  compressTools,
  compressResponse,
  compressToolOutput,
  rewriteHistory,
  stripCompletedToolCalls,
  // TOON codec (ANOLISA-aligned)
  toonEncode: toonCodec.encode,
  toonDecode: toonCodec.decode,
  toonCodec,
  // Gateway plugin
  tokenlessPlugin,
  // Stats
  getStats,
  resetStats,
};
