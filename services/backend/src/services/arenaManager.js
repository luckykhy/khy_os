'use strict';

/**
 * Arena Manager — run a prompt against multiple models in parallel,
 * collect responses, and produce a diff summary.
 *
 * Usage:
 *   const arena = new ArenaManager(gateway);
 *   const result = await arena.run({
 *     prompt: 'Implement quicksort in Python',
 *     models: ['gpt-4', 'claude-sonnet', 'qwen-max'],
 *   });
 *   console.log(result.summary);
 *
 * @module arenaManager
 */

const crypto = require('crypto');
const log = require('../utils/logger');

/**
 * @typedef {object} ArenaEntry
 * @property {string} model - Model identifier
 * @property {string} content - Full response text
 * @property {number} latencyMs - Time to first token (ms)
 * @property {number} totalMs - Total response time (ms)
 * @property {object} [usage] - Token usage { prompt, completion, total }
 * @property {string} [error] - Error message if failed
 * @property {boolean} failed - Whether this entry failed
 */

/**
 * @typedef {object} ArenaResult
 * @property {string} arenaId - Unique arena run ID
 * @property {string} prompt - The input prompt
 * @property {ArenaEntry[]} entries - Results per model
 * @property {object} summary - Diff summary
 * @property {number} totalMs - Total arena run time
 */

class ArenaManager {
  /**
   * @param {object} gateway - AI gateway instance (must have .chat() or .query())
   * @param {object} [options]
   * @param {number} [options.timeoutMs=60000] - Per-model timeout
   * @param {number} [options.maxConcurrency=5] - Max concurrent model queries
   */
  constructor(gateway, options) {
    this._gateway = gateway;
    this._timeoutMs = (options && options.timeoutMs) || 60_000;
    this._maxConcurrency = (options && options.maxConcurrency) || 5;
  }

  /**
   * Run a prompt against multiple models in parallel.
   *
   * @param {object} params
   * @param {string} params.prompt - The prompt to send
   * @param {string[]} params.models - Model identifiers to compare
   * @param {string} [params.system] - System prompt override
   * @param {number} [params.maxTokens] - Max tokens per response
   * @param {number} [params.temperature] - Temperature setting
   * @param {Function} [params.onProgress] - Callback(model, event) for streaming progress
   * @param {Function} [params.evalFn] - Optional evaluation function(prompt, response, model) => { score: number, notes: string }
   * @param {boolean} [params.persist=true] - Auto-save result to arenaResultStore
   * @returns {Promise<ArenaResult>}
   */
  async run(params) {
    const { prompt, models, system, maxTokens, temperature, onProgress, evalFn, persist } = params;

    if (!prompt || !models || models.length < 2) {
      throw new Error('Arena requires a prompt and at least 2 models');
    }
    if (models.length > this._maxConcurrency) {
      throw new Error(`Arena supports at most ${this._maxConcurrency} concurrent models`);
    }

    const arenaId = 'arena-' + crypto.randomBytes(4).toString('hex');
    log.info(`Arena ${arenaId}: starting with ${models.length} models`);

    const startTime = Date.now();

    // Run all models in parallel
    const entries = await Promise.all(
      models.map((model) => this._queryModel(model, {
        prompt,
        system,
        maxTokens,
        temperature,
        onProgress,
      })),
    );

    const totalMs = Date.now() - startTime;

    // Generate diff summary
    const summary = generateArenaSummary(prompt, entries);

    const result = {
      arenaId,
      prompt,
      entries,
      summary,
      totalMs,
    };

    // Run optional evaluation on each successful entry
    if (typeof evalFn === 'function') {
      for (const entry of entries) {
        if (entry.failed) continue;
        try {
          const evalResult = await evalFn(prompt, entry.content, entry.model);
          entry.evalScore = evalResult.score ?? null;
          entry.evalNotes = evalResult.notes ?? '';
        } catch (err) {
          entry.evalScore = null;
          entry.evalNotes = `eval error: ${err.message}`;
        }
      }
    }

    // Auto-persist (default: true)
    if (persist !== false) {
      try {
        const store = require('./arenaResultStore');
        store.saveResult(result);
      } catch (err) {
        log.warn(`Arena ${arenaId}: failed to persist result: ${err.message}`);
      }
    }

    log.info(`Arena ${arenaId}: completed in ${totalMs}ms, ${entries.filter((e) => !e.failed).length}/${models.length} succeeded`);

    return result;
  }

  /**
   * Query a single model with timeout.
   * @private
   */
  async _queryModel(model, params) {
    const start = Date.now();
    let firstTokenMs = 0;

    /** @type {ArenaEntry} */
    const entry = {
      model,
      content: '',
      latencyMs: 0,
      totalMs: 0,
      usage: null,
      error: null,
      failed: false,
    };

    let timer = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), this._timeoutMs);

      const result = await this._callGateway(model, params, {
        signal: controller.signal,
        onChunk: (chunk) => {
          if (!firstTokenMs) firstTokenMs = Date.now() - start;
          entry.content += chunk;
          if (params.onProgress) {
            try { params.onProgress(model, { type: 'chunk', content: chunk }); }
            catch { /* ignore */ }
          }
        },
      });

      entry.content = result.content || entry.content;
      entry.usage = result.usage || null;
      entry.latencyMs = firstTokenMs || (Date.now() - start);
      entry.totalMs = Date.now() - start;
    } catch (err) {
      entry.error = err.message || String(err);
      entry.failed = true;
      entry.totalMs = Date.now() - start;
      log.warn(`Arena: model ${model} failed: ${entry.error}`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return entry;
  }

  /**
   * Call the gateway for a single model. Handles both streaming and non-streaming modes.
   * @private
   */
  async _callGateway(model, params, opts) {
    const gw = this._gateway;

    // Build request
    const messages = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    messages.push({ role: 'user', content: params.prompt });

    const reqOptions = {
      model,
      messages,
      maxTokens: params.maxTokens || 4096,
      temperature: params.temperature != null ? params.temperature : 0.7,
      signal: opts.signal,
    };

    // Try streaming chat first
    if (typeof gw.chatStream === 'function') {
      let content = '';
      let usage = null;

      const stream = gw.chatStream(reqOptions);
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        for await (const event of stream) {
          if (opts.signal && opts.signal.aborted) break;
          if (event.type === 'chunk' || event.delta) {
            const chunk = event.delta || event.content || '';
            content += chunk;
            if (opts.onChunk) opts.onChunk(chunk);
          }
          if (event.usage) usage = event.usage;
        }
        return { content, usage };
      }
    }

    // Fallback to non-streaming
    if (typeof gw.chat === 'function') {
      const result = await gw.chat(reqOptions);
      const content = result.content || result.text || '';
      if (opts.onChunk) opts.onChunk(content);
      return { content, usage: result.usage || null };
    }

    // Fallback to query
    if (typeof gw.query === 'function') {
      const result = await gw.query(params.prompt, { model, signal: opts.signal });
      const content = typeof result === 'string' ? result : (result.reply || result.content || '');
      if (opts.onChunk) opts.onChunk(content);
      return { content, usage: null };
    }

    throw new Error(`Gateway does not support chat/chatStream/query methods`);
  }
}

// ── Arena Summary / Diff ──

/**
 * Generate a summary comparing multiple model responses.
 *
 * @param {string} prompt
 * @param {ArenaEntry[]} entries
 * @returns {object}
 */
function generateArenaSummary(prompt, entries) {
  const successful = entries.filter((e) => !e.failed);
  const failed = entries.filter((e) => e.failed);

  // Basic metrics
  const metrics = successful.map((e) => ({
    model: e.model,
    latencyMs: e.latencyMs,
    totalMs: e.totalMs,
    tokens: e.usage ? e.usage.total || (e.usage.prompt + e.usage.completion) : null,
    contentLength: e.content.length,
    wordCount: e.content.split(/\s+/).length,
    hasCode: /```/.test(e.content),
    codeBlockCount: (e.content.match(/```/g) || []).length / 2,
  }));

  // Find fastest/slowest
  const sortedByLatency = [...metrics].sort((a, b) => a.latencyMs - b.latencyMs);
  const fastest = sortedByLatency[0];
  const sortedByTotal = [...metrics].sort((a, b) => a.totalMs - b.totalMs);

  // Content similarity (simple Jaccard on word sets)
  const similarities = [];
  for (let i = 0; i < successful.length; i++) {
    for (let j = i + 1; j < successful.length; j++) {
      const sim = _jaccardSimilarity(
        successful[i].content,
        successful[j].content,
      );
      similarities.push({
        modelA: successful[i].model,
        modelB: successful[j].model,
        similarity: Math.round(sim * 100),
      });
    }
  }

  // Structural comparison
  const structures = successful.map((e) => ({
    model: e.model,
    hasCodeBlocks: /```/.test(e.content),
    hasNumberedList: /^\s*\d+[.)]\s/m.test(e.content),
    hasBulletList: /^\s*[-*]\s/m.test(e.content),
    hasHeadings: /^#+\s/m.test(e.content),
    paragraphs: e.content.split(/\n\n+/).length,
  }));

  return {
    totalModels: entries.length,
    successCount: successful.length,
    failedCount: failed.length,
    failedModels: failed.map((e) => ({ model: e.model, error: e.error })),
    fastest: fastest ? { model: fastest.model, latencyMs: fastest.latencyMs } : null,
    metrics,
    similarities,
    structures,
    recommendation: _pickRecommendation(metrics, similarities),
  };
}

/**
 * Simple Jaccard similarity on word sets.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0-1
 */
function _jaccardSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Pick a recommendation based on metrics.
 * @param {object[]} metrics
 * @param {object[]} similarities
 * @returns {string}
 */
function _pickRecommendation(metrics, similarities) {
  if (metrics.length === 0) return 'No successful responses to compare.';
  if (metrics.length === 1) return `Only ${metrics[0].model} responded successfully.`;

  // Score each model: lower latency = better, more content = better
  const scores = metrics.map((m) => {
    let score = 0;
    // Latency score (0-30): lower is better
    const maxLatency = Math.max(...metrics.map((x) => x.latencyMs)) || 1;
    score += 30 * (1 - m.latencyMs / maxLatency);
    // Content richness (0-30): more words is better (up to a point)
    const maxWords = Math.max(...metrics.map((x) => x.wordCount)) || 1;
    score += 30 * Math.min(1, m.wordCount / maxWords);
    // Code presence bonus (0-20)
    if (m.hasCode) score += 20;
    // Total time (0-20): faster completion
    const maxTotal = Math.max(...metrics.map((x) => x.totalMs)) || 1;
    score += 20 * (1 - m.totalMs / maxTotal);
    return { model: m.model, score: Math.round(score) };
  });

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const second = scores[1];

  if (best.score - second.score < 5) {
    return `${best.model} and ${second.model} performed similarly (scores: ${best.score} vs ${second.score}). Choose based on preference.`;
  }

  return `${best.model} recommended (score: ${best.score}/${100}). Fastest first-token and richest response.`;
}

/**
 * Format arena result for CLI display.
 * @param {ArenaResult} result
 * @param {object} [options]
 * @param {Function} [options.chalk]
 * @returns {string}
 */
function formatArenaResult(result, options) {
  const c = (options && options.chalk) || { bold: (t) => t, green: (t) => t, red: (t) => t, dim: (t) => t, cyan: (t) => t, yellow: (t) => t, white: (t) => t, hex: () => (t) => t };
  const lines = [];

  lines.push('');
  lines.push(c.bold(`  Arena Results (${result.arenaId})`));
  lines.push(c.dim(`  Prompt: ${result.prompt.substring(0, 80)}${result.prompt.length > 80 ? '...' : ''}`));
  lines.push(c.dim(`  Total time: ${result.totalMs}ms`));
  lines.push('');

  // Table header
  lines.push(c.bold('  Model              │ Latency   │ Total     │ Words  │ Code │ Status'));
  lines.push('  ───────────────────┼───────────┼───────────┼────────┼──────┼────────');

  for (const m of result.summary.metrics) {
    const name = m.model.padEnd(19);
    const lat = `${m.latencyMs}ms`.padEnd(9);
    const tot = `${m.totalMs}ms`.padEnd(9);
    const words = String(m.wordCount).padEnd(6);
    const code = m.hasCode ? c.green('yes ') : c.dim('no  ');
    const status = c.green('ok');
    lines.push(`  ${name} │ ${lat} │ ${tot} │ ${words} │ ${code} │ ${status}`);
  }

  for (const f of result.summary.failedModels) {
    const name = f.model.padEnd(19);
    const err = f.error.substring(0, 30);
    lines.push(`  ${name} │ ${c.red('failed')}    │           │        │      │ ${c.red(err)}`);
  }

  // Similarity matrix
  if (result.summary.similarities.length > 0) {
    lines.push('');
    lines.push(c.bold('  Content Similarity:'));
    for (const s of result.summary.similarities) {
      const bar = '█'.repeat(Math.round(s.similarity / 5)) + '░'.repeat(20 - Math.round(s.similarity / 5));
      lines.push(`    ${s.modelA} ↔ ${s.modelB}: ${bar} ${s.similarity}%`);
    }
  }

  // Recommendation
  lines.push('');
  lines.push(c.cyan(`  → ${result.summary.recommendation}`));
  lines.push('');

  return lines.join('\n');
}

/**
 * Built-in code evaluation function for arena comparisons.
 * Checks: code block presence, completeness, structure, density.
 *
 * @param {string} prompt
 * @param {string} response
 * @param {string} _model
 * @returns {{ score: number, notes: string }}
 */
function codeEval(prompt, response, _model) {
  let score = 50; // neutral baseline
  const notes = [];

  // Code block presence
  const codeBlocks = (response.match(/```[\s\S]*?```/g) || []);
  if (codeBlocks.length > 0) {
    score += 15;
    notes.push(`${codeBlocks.length} code block(s)`);
  } else if (/code|implement|function|class|write/i.test(prompt)) {
    score -= 15;
    notes.push('No code blocks for code request');
  }

  // Response completeness (not truncated)
  const lastLine = response.trim().split('\n').pop() || '';
  if (lastLine.endsWith('...') || lastLine.endsWith('…')) {
    score -= 10;
    notes.push('Appears truncated');
  }

  // Content density (words per character — higher = more informative)
  const words = response.split(/\s+/).filter(Boolean).length;
  if (words > 50) {
    score += 5;
  }

  // Explanation quality (has both code and explanation)
  if (codeBlocks.length > 0 && words > codeBlocks.join('').length / 5) {
    score += 10;
    notes.push('Has code + explanation');
  }

  return { score: Math.max(0, Math.min(100, score)), notes: notes.join('; ') };
}

module.exports = {
  ArenaManager,
  generateArenaSummary,
  formatArenaResult,
  codeEval,
};
