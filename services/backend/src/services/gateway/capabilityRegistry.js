'use strict';

/**
 * capabilityRegistry.js — Model capability declaration and query engine.
 *
 * Each adapter declares its capabilities on an 11-dimension scale (0-5).
 * The registry answers: "given these requirements, which adapters are best?"
 *
 * Score scale:
 *   0 = not supported at all
 *   1 = barely functional / experimental
 *   2 = basic / limited
 *   3 = usable / adequate
 *   4 = good / reliable
 *   5 = best-in-class
 */

const fs = require('fs');
const path = require('path');

// ── Capability dimensions ─────────────────────────────────────────────
const CAPABILITIES = {
  text:         'text',         // Basic text generation
  code:         'code',         // Code generation & editing
  tool_use:     'tool_use',     // Function calling / tool use
  vision:       'vision',       // Image understanding
  image_gen:    'image_gen',    // Image generation (DALL-E, SD, etc.)
  video_gen:    'video_gen',    // Video generation (text/image-to-video)
  reasoning:    'reasoning',    // Deep reasoning (o-series, R1, etc.)
  long_context: 'long_context', // 100k+ token context
  streaming:    'streaming',    // Streaming output
  embedding:    'embedding',    // Vector embeddings
  audio:        'audio',        // Audio/speech
  multilingual: 'multilingual', // Multi-language support
  synthetic_tool: 'synthetic_tool', // Synthetic tool layer activation (higher = more likely)
};

// ── Default capability declarations per adapter ───────────────────────
const DEFAULT_ADAPTER_CAPABILITIES = {
  claude:     { text: 5, code: 5, tool_use: 5, vision: 4, reasoning: 5, long_context: 5, streaming: 5, multilingual: 4 },
  codex:      { text: 4, code: 5, tool_use: 5, vision: 3, reasoning: 4, long_context: 4, streaming: 5, multilingual: 3 },
  kiro:       { text: 4, code: 4, tool_use: 5, vision: 3, long_context: 4, streaming: 4, multilingual: 3 },
  cursor:     { text: 4, code: 5, tool_use: 4, vision: 3, streaming: 4, long_context: 4, multilingual: 3 },
  trae:       { text: 4, code: 4, tool_use: 4, vision: 3, streaming: 4, multilingual: 3 },
  api:        { text: 5, code: 4, tool_use: 3, vision: 3, reasoning: 4, long_context: 5, streaming: 4, image_gen: 3, embedding: 4, multilingual: 5 },
  windsurf:   { text: 3, code: 4, tool_use: 3, vision: 2, streaming: 3, multilingual: 2 },
  vscode:     { text: 3, code: 4, tool_use: 3, streaming: 3, multilingual: 2 },
  warp:       { text: 2, code: 2, tool_use: 1, streaming: 2 },
  cursor2api: { text: 4, code: 4, tool_use: 4, vision: 3, streaming: 4, long_context: 4, multilingual: 3 },
  relay_api:  { text: 4, code: 3, tool_use: 3, vision: 2, streaming: 4, long_context: 4, multilingual: 4 },
  ollama:     { text: 3, code: 3, tool_use: 1, vision: 2, long_context: 3, streaming: 3, multilingual: 3, synthetic_tool: 4 },
  localLLM:   { text: 2, code: 2, tool_use: 0, streaming: 2, synthetic_tool: 5 },
  cli:        { text: 4, code: 4, tool_use: 4, streaming: 3 },
  opencode:   { text: 4, code: 5, tool_use: 4, reasoning: 4, streaming: 3, multilingual: 3 },
  relay:      { text: 3, code: 2, tool_use: 0, streaming: 0, multilingual: 3 },
  clipboard:  { text: 3, code: 2, tool_use: 0, streaming: 0, multilingual: 3 },
};

// ── Task type → minimum capability requirements ──────────────────────
const TASK_REQUIREMENTS = {
  reasoning:    { reasoning: 4, text: 3 },
  code:         { code: 4, tool_use: 3 },
  analysis:     { text: 4, long_context: 3 },
  vision:       { vision: 3, text: 2 },
  image_gen:    { image_gen: 3 },
  video_gen:    { video_gen: 3 },
  embedding:    { embedding: 3 },
  audio:        { audio: 3 },
  conversation: { text: 2 },
};

class CapabilityRegistry {
  /**
   * @param {object} [gateway] - Optional reference to AIGateway for availability checks
   */
  constructor(gateway) {
    this._gateway = gateway || null;
    // Deep-clone defaults so runtime updates don't mutate the static table
    this._capabilities = {};
    for (const [key, caps] of Object.entries(DEFAULT_ADAPTER_CAPABILITIES)) {
      this._capabilities[key] = { ...caps };
    }
    this._loadCustomCapabilities();
  }

  /**
   * Get capability scores for an adapter.
   * @param {string} adapterKey
   * @returns {object|null} { text: 5, code: 4, ... } or null if unknown
   */
  getCapabilities(adapterKey) {
    return this._capabilities[adapterKey] || null;
  }

  /**
   * Check if an adapter meets all requirements.
   * @param {string} adapterKey
   * @param {object} requirements - { capability: minScore, ... }
   * @returns {boolean}
   */
  meetsRequirements(adapterKey, requirements) {
    const caps = this._capabilities[adapterKey];
    if (!caps) return false;
    for (const [cap, minScore] of Object.entries(requirements)) {
      if ((caps[cap] || 0) < minScore) return false;
    }
    return true;
  }

  /**
   * Find adapters that meet the requirements, ranked by total score.
   * Only returns adapters that meet ALL minimum requirements.
   *
   * @param {object} requirements - { capability: minScore, ... }
   * @param {object} [opts]
   * @param {boolean} [opts.onlyAvailable=true] - Filter by gateway availability
   * @param {number} [opts.limit=5] - Max results
   * @param {object} [opts.weighting] - B3 soft re-ranking signals. Applied as
   *   gentle additive terms on top of the capability score so they break ties
   *   and nudge ordering without overturning a clear capability win:
   *     - skills:    {string[]} required skill tags for the task
   *     - profiles:  {Object<adapterKey,{skills?:string[]}>} per-adapter skill tags
   *     - stats:     {Object<adapterKey,{reworkRate?:number,activeCount?:number}>}
   *   Weights (each ≤ ~1.5, vs capability totals that run 10-30):
   *     + skill-tag match  : +0.5 per matched tag (cap +1.5)
   *     + reliability      : +1.0 * (1 - reworkRate)
   *     + idleness         : +1.0 / (1 + activeCount)
   * @returns {Array<{ key: string, score: number, weight: number, gaps: string[] }>}
   */
  bestAdaptersFor(requirements, opts = {}) {
    const onlyAvailable = opts.onlyAvailable !== false;
    const limit = opts.limit || 5;
    const weighting = opts.weighting || null;

    const results = [];
    for (const [key, caps] of Object.entries(this._capabilities)) {
      // Check availability via gateway if requested
      if (onlyAvailable && this._gateway) {
        try {
          const adapterEntry = this._gateway._adapters?.find(a => a.key === key);
          if (adapterEntry && (!adapterEntry.enabled || !adapterEntry.adapter?.detect?.())) continue;
        } catch { /* ignore detection failures, include adapter */ }
      }

      let totalScore = 0;
      let meetsAll = true;
      const gaps = [];

      for (const [cap, minScore] of Object.entries(requirements)) {
        const actual = caps[cap] || 0;
        if (actual < minScore) {
          meetsAll = false;
          gaps.push(`${cap}: ${actual}/${minScore}`);
        }
        totalScore += actual;
      }

      if (meetsAll) {
        const weight = this._selectionWeight(key, weighting);
        results.push({ key, score: totalScore, weight, effective: totalScore + weight, gaps: [] });
      } else if (gaps.length <= 1 && opts.includeMarginal) {
        // Optionally include adapters that miss by only 1 dimension
        const weight = this._selectionWeight(key, weighting);
        results.push({ key, score: totalScore, weight, effective: totalScore + weight, gaps });
      }
    }

    // Sort by capability+weight descending, break ties by default priority
    results.sort((a, b) => {
      if (b.effective !== a.effective) return b.effective - a.effective;
      return (this._adapterPriority(a.key) || 99) - (this._adapterPriority(b.key) || 99);
    });

    return results.slice(0, limit);
  }

  /**
   * B3 — compute the soft selection weight for an adapter from skill-tag match,
   * historical rework rate, and current load. Returns 0 when no weighting
   * signals are supplied, so the legacy capability-only ranking is unchanged.
   * @private
   */
  _selectionWeight(key, weighting) {
    if (!weighting) return 0;
    let weight = 0;

    // Skill-tag match: +0.5 per required tag the adapter's profile advertises.
    const required = Array.isArray(weighting.skills) ? weighting.skills : [];
    const profile = weighting.profiles && weighting.profiles[key];
    const advertised = profile && Array.isArray(profile.skills) ? profile.skills : [];
    if (required.length && advertised.length) {
      const adSet = new Set(advertised.map(s => String(s).toLowerCase()));
      let matched = 0;
      for (const tag of required) {
        if (adSet.has(String(tag).toLowerCase())) matched++;
      }
      weight += Math.min(1.5, matched * 0.5);
    }

    // Reliability + idleness from the runtime stats ledger.
    const stats = weighting.stats && weighting.stats[key];
    if (stats) {
      const reworkRate = Number.isFinite(stats.reworkRate) ? Math.max(0, Math.min(1, stats.reworkRate)) : 0;
      const activeCount = Number.isFinite(stats.activeCount) && stats.activeCount > 0 ? stats.activeCount : 0;
      weight += 1.0 * (1 - reworkRate);
      weight += 1.0 / (1 + activeCount);
    }

    return weight;
  }

  /**
   * Update a capability score at runtime (e.g., after probing).
   * @param {string} adapterKey
   * @param {string} capability
   * @param {number} score - 0-5
   */
  updateCapability(adapterKey, capability, score) {
    if (!this._capabilities[adapterKey]) {
      this._capabilities[adapterKey] = {};
    }
    this._capabilities[adapterKey][capability] = Math.max(0, Math.min(5, Math.round(score)));
  }

  /**
   * Get the full capability matrix for all adapters.
   * @returns {object} { adapterKey: { cap: score, ... }, ... }
   */
  getMatrix() {
    const matrix = {};
    for (const [key, caps] of Object.entries(this._capabilities)) {
      matrix[key] = { ...caps };
    }
    return matrix;
  }

  /**
   * Get the TASK_REQUIREMENTS mapping.
   * @returns {object}
   */
  getTaskRequirements() {
    return { ...TASK_REQUIREMENTS };
  }

  /**
   * Infer capability requirements from a task description.
   * @param {string} description - Task text
   * @param {string} [role] - Agent role hint
   * @returns {object} { capability: minScore, ... }
   */
  inferRequirements(description, role) {
    const reqs = { text: 2 };
    const lower = String(description || '').toLowerCase();

    // Role-based
    if (['coder', 'implement', 'codex', 'claude', 'opencode'].includes(role)) {
      reqs.code = 4; reqs.tool_use = 3;
    } else if (['explore', 'reviewer', 'verify'].includes(role)) {
      reqs.code = 3; reqs.tool_use = 2;
    } else if (['planner', 'Plan'].includes(role)) {
      reqs.reasoning = 3; reqs.text = 3;
    }

    // Keyword-based
    if (/图片|image|screenshot|视觉|photo|看[看这个]|identify.*visual|analyze.*image/i.test(lower)) {
      reqs.vision = 3;
    }
    if (/画|绘|生成图|draw|generate.*image|create.*picture|create.*diagram|render.*image/i.test(lower)) {
      reqs.image_gen = 3;
    }
    if (/视频|动画|generate.*video|text.to.video|image.to.video|文生视频|图生视频|关键帧|keyframe/i.test(lower)) {
      reqs.video_gen = 3;
    }
    if (/推理|reason|think.*step|chain.of.thought|analyze.*deeply|数学|math|proof/i.test(lower)) {
      reqs.reasoning = Math.max(reqs.reasoning || 0, 4);
    }
    if (/代码|code|编程|implement|function|class|module|refactor|debug/i.test(lower)) {
      reqs.code = Math.max(reqs.code || 0, 3);
    }
    if (/embed|向量|vector|similarity|semantic.*search/i.test(lower)) {
      reqs.embedding = 3;
    }
    if (/audio|音频|语音|speech|transcri/i.test(lower)) {
      reqs.audio = 3;
    }

    return reqs;
  }

  /**
   * Get adapter priority from gateway (lower = higher priority).
   * @private
   */
  _adapterPriority(key) {
    if (!this._gateway?._adapters) return 99;
    const entry = this._gateway._adapters.find(a => a.key === key);
    return entry ? entry.priority : 99;
  }

  /**
   * Load custom capability overrides from env vars and config file.
   * @private
   */
  _loadCustomCapabilities() {
    // 1. Environment variables: GATEWAY_CAPABILITIES_<adapter>='{"code":4,...}'
    for (const [envKey, envVal] of Object.entries(process.env)) {
      const match = envKey.match(/^GATEWAY_CAPABILITIES_(\w+)$/i);
      if (!match) continue;
      const adapterKey = match[1].toLowerCase();
      try {
        const overrides = JSON.parse(envVal);
        if (overrides && typeof overrides === 'object') {
          if (!this._capabilities[adapterKey]) this._capabilities[adapterKey] = {};
          Object.assign(this._capabilities[adapterKey], overrides);
        }
      } catch { /* invalid JSON, skip */ }
    }

    // 2. Config file: ~/.khyquant/adapter_capabilities.json
    try {
      const homedir = require('os').homedir();
      const configPath = path.join(homedir, '.khyquant', 'adapter_capabilities.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        if (config && typeof config === 'object') {
          for (const [key, overrides] of Object.entries(config)) {
            if (overrides && typeof overrides === 'object') {
              if (!this._capabilities[key]) this._capabilities[key] = {};
              Object.assign(this._capabilities[key], overrides);
            }
          }
        }
      }
    } catch { /* config not available */ }
  }
}

// Singleton for non-gateway contexts
let _singleton = null;
function getCapabilityRegistry(gateway) {
  if (gateway) return new CapabilityRegistry(gateway);
  if (!_singleton) _singleton = new CapabilityRegistry();
  return _singleton;
}

module.exports = {
  CapabilityRegistry,
  getCapabilityRegistry,
  CAPABILITIES,
  TASK_REQUIREMENTS,
  DEFAULT_ADAPTER_CAPABILITIES,
};
