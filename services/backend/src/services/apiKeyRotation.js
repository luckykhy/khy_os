'use strict';

/**
 * apiKeyRotation.js — Multi-key rotation for rate limit recovery.
 *
 * Ported from OpenClaw's api-key-rotation.ts.
 * Simple linear rotation through available API keys when rate-limited.
 * Deduplicates keys to prevent retry thrashing.
 *
 * Usage:
 *   const result = await executeWithRotation({
 *     apiKeys: [key1, key2, key3],
 *     provider: 'openai',
 *     execute: (key) => fetch(url, { headers: { 'Authorization': `Bearer ${key}` } }),
 *   });
 */

/**
 * Deduplicate API keys, trimming whitespace and removing empties.
 *
 * @param {string[]} raw
 * @returns {string[]}
 */
function dedupeApiKeys(raw) {
  const seen = new Set();
  const keys = [];
  for (const value of raw) {
    const key = (value || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Execute a function with API key rotation on rate limit errors.
 *
 * @param {object} params
 * @param {string[]} params.apiKeys - Available API keys
 * @param {string} params.provider - Provider name (for error messages)
 * @param {function} params.execute - (apiKey: string) => Promise<T>
 * @param {function} [params.shouldRetry] - ({ apiKey, error, attempt, message }) => boolean
 * @param {function} [params.onRetry] - ({ apiKey, error, attempt, message }) => void
 * @returns {Promise<T>}
 */
async function executeWithRotation(params) {
  const keys = dedupeApiKeys(params.apiKeys);
  if (keys.length === 0) {
    throw new Error(`No API keys configured for provider "${params.provider}".`);
  }

  let lastError;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const apiKey = keys[attempt];
    try {
      return await params.execute(apiKey);
    } catch (error) {
      lastError = error;
      const message = _formatErrorMessage(error);

      // Check if we should try the next key
      const retryable = params.shouldRetry
        ? params.shouldRetry({ apiKey, error, attempt, message })
        : _isRateLimitError(message);

      if (!retryable || attempt + 1 >= keys.length) break;

      if (params.onRetry) {
        params.onRetry({ apiKey, error, attempt, message });
      }
    }
  }

  if (lastError === undefined) {
    throw new Error(`Failed to run API request for ${params.provider}.`);
  }
  throw lastError;
}

/**
 * Collect API keys for a provider from environment variables.
 * Looks for: PROVIDER_API_KEY, PROVIDER_API_KEYS (comma-separated),
 *            PROVIDER_API_KEY_1, PROVIDER_API_KEY_2, etc.
 *
 * @param {string} provider
 * @param {string} [primaryKey] - Primary key (highest priority)
 * @returns {string[]}
 */
function collectProviderKeys(provider, primaryKey) {
  const prefix = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const keys = [];

  if (primaryKey?.trim()) keys.push(primaryKey.trim());

  // Single key env var
  const single = process.env[`${prefix}_API_KEY`];
  if (single?.trim()) keys.push(single.trim());

  // Comma-separated env var
  const multi = process.env[`${prefix}_API_KEYS`];
  if (multi) {
    for (const k of multi.split(',')) {
      if (k.trim()) keys.push(k.trim());
    }
  }

  // Numbered env vars (1-10)
  for (let i = 1; i <= 10; i++) {
    const numbered = process.env[`${prefix}_API_KEY_${i}`];
    if (numbered?.trim()) keys.push(numbered.trim());
  }

  return dedupeApiKeys(keys);
}

function _isRateLimitError(message) {
  return /rate.?limit|too.?many.?requests|429|quota.?exceeded/i.test(message || '');
}

function _formatErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

module.exports = {
  executeWithRotation,
  collectProviderKeys,
  dedupeApiKeys,
};
