/**
 * Cache Plugin — caches identical prompt responses to avoid redundant API calls.
 *
 * Copy to ~/.khyquant/gateway_plugins/cache-plugin.js to activate.
 */
const crypto = require('crypto');

const cache = new Map();
const MAX_CACHE_SIZE = 50;
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function hashPrompt(prompt) {
  return crypto.createHash('md5').update(prompt).digest('hex');
}

module.exports = {
  name: 'cache',
  priority: 200,
  enabled: true,
  hooks: {
    onBeforeRequest: async (ctx, next) => {
      const key = hashPrompt(ctx.prompt);
      const entry = cache.get(key);
      if (entry && Date.now() - entry.time < TTL_MS) {
        // Cache hit — inject cached response
        ctx._cachedResponse = entry.response;
      }
      return next(ctx);
    },

    onAfterResponse: async (ctx, next) => {
      if (ctx.response?.success && !ctx._cachedResponse) {
        const key = hashPrompt(ctx.prompt);
        cache.set(key, { response: ctx.response, time: Date.now() });
        // Evict oldest if over size
        if (cache.size > MAX_CACHE_SIZE) {
          const firstKey = cache.keys().next().value;
          cache.delete(firstKey);
        }
      }
      return next(ctx);
    },
  },
};
