'use strict';

/**
 * _llmDecomposer.js — LLM-assisted task decomposition.
 *
 * When pattern-matching strategies fail (no numbered lists, no file targets,
 * no parallel markers), falls back to LLM for semantic decomposition.
 *
 * Feature-gated: KHY_LLM_DECOMPOSE=true (opt-in).
 */

const DECOMPOSE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;

const { extractFirstJson } = require('./gateway/safeJsonParse');

const SYSTEM_PROMPT = `You are a task decomposition assistant. Given a user request, determine if it contains multiple independent subtasks that can be executed in parallel.

If decomposable, output ONLY a JSON array:
[{"title": "short title", "description": "full subtask prompt", "role": "explore|implement|verify", "dependencies": []}]

If NOT decomposable (single coherent task), output: []

Rules:
- Only split into truly independent subtasks (no interdependencies unless explicit)
- Each subtask must be self-contained with enough context to execute alone
- Minimum 2 subtasks, maximum 6
- Role must be one of: explore, implement, verify, general
- Output ONLY the JSON array, no explanation`;

// Simple LRU-style cache
const _cache = new Map();

function _getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function _setCache(key, value) {
  // Cap cache size
  if (_cache.size > 50) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
  _cache.set(key, { value, ts: Date.now() });
}

/**
 * Decompose a message using the AI gateway.
 *
 * @param {string} message - User message to decompose
 * @param {object} deps - { callModel } from query engine
 * @returns {Promise<{subtasks: Array, reason: string} | null>}
 */
async function decompose(message, deps) {
  if (!message || !deps?.callModel) return null;

  // Feature gate
  if (String(process.env.KHY_LLM_DECOMPOSE || '').toLowerCase() !== 'true') {
    return null;
  }

  // Cache check
  const cacheKey = message.slice(0, 500);
  const cached = _getCached(cacheKey);
  if (cached !== null) return cached;

  try {
    const result = await Promise.race([
      deps.callModel(
        `${SYSTEM_PROMPT}\n\nUser request:\n${message}`,
        { effort: 'low', _isFollowUp: true }
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('decompose timeout')), DECOMPOSE_TIMEOUT_MS)
      ),
    ]);

    const reply = result?.reply || result?.content || '';
    // Recover the structured value the model was asked to emit. The model may
    // wrap the array in prose or a ```json fence, or return a {subtasks:[...]}
    // wrapper — extractFirstJson handles all of these and repairs malformed JSON.
    const recovered = extractFirstJson(reply, null);
    const parsed = Array.isArray(recovered)
      ? recovered
      : (Array.isArray(recovered?.subtasks) ? recovered.subtasks
        : (Array.isArray(recovered?.tasks) ? recovered.tasks : null));
    if (!Array.isArray(parsed) || parsed.length < 2) {
      _setCache(cacheKey, null);
      return null;
    }

    const subtasks = parsed.slice(0, 6).map((item, i) => ({
      prompt: item.description || item.title || '',
      role: ['explore', 'implement', 'verify', 'general'].includes(item.role)
        ? item.role : 'general',
      originIndex: i,
      dependencies: Array.isArray(item.dependencies) ? item.dependencies : [],
    })).filter(st => st.prompt.length > 0);

    if (subtasks.length < 2) {
      _setCache(cacheKey, null);
      return null;
    }

    const output = { subtasks, reason: 'llm_semantic' };
    _setCache(cacheKey, output);
    return output;
  } catch {
    _setCache(cacheKey, null);
    return null;
  }
}

module.exports = { decompose };
