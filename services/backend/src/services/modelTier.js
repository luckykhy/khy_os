/**
 * modelTier — model-capability tiering for the tool-use loop.
 *
 * The loop (toolUseLoop.js) carries a large body of scaffolding built for weak
 * models: behavioral nudges ("you're not done, keep going"), a synthetic tool
 * layer (executes on behalf of models that can't function-call), and a hard
 * capability gate that pre-blocks tasks. That scaffolding rescues 7B/mini-class
 * models but actively cages frontier models (Opus 4.8, GPT-5), which already
 * conclude correctly and just need to be left alone.
 *
 * This module assigns a model a tier and returns a `harnessProfile` describing
 * which scaffolding to keep. It is intentionally SELF-CONTAINED — it does not
 * require cli/ai.js (avoids a circular dependency through the heavy CLI entry)
 * and mirrors the style of the loop's existing `_isLowTierModel` regex.
 *
 * First cut: only T0 (frontier) is relaxed. T1/T2/T3 keep today's behavior
 * verbatim, so there is zero regression for the DeepSeek/Qwen (T1) path that
 * relies on nudges to deliver.
 *
 * Tiers:
 *   T0  frontier  — opus-4*, gpt-5, grok-4, o3-pro
 *   T1  strong    — sonnet-4, claude-3.7, gpt-4o/4.1, o1/o3, deepseek, qwen-max…
 *   T2  default   — anything unrecognized (keeps full scaffolding)
 *   T3  weak      — mini/lite/flash/haiku/small/7b… (demoted from T1/T2)
 *
 * Env overrides (escape hatches, same spirit as KHY_* flags elsewhere):
 *   KHY_CAPABILITY_TIER           force a tier for ALL models (T0..T3)
 *   KHY_MODEL_TIER_MAP            per-model tier, JSON {"<modelId>":"T1"}
 *                                 (case-insensitive exact match; wins over the
 *                                 regex auto-classification, loses to the global
 *                                 force above). Lets a model whose name trips the
 *                                 weak-token heuristic — e.g. agnes-2.0-flash —
 *                                 declare its true tier without code changes.
 *   KHY_HARNESS_NUDGES            per-dial: true|false
 *   KHY_HARNESS_SYNTHETIC_TOOLS   per-dial: true|false
 *   KHY_HARNESS_CAPABILITY_GATE   per-dial: hard|warn|off
 *   KHY_HARNESS_PROMPT_VERBOSITY  per-dial: lean|full
 *   KHY_HARNESS_DECOMPOSE         per-dial: true|false
 *   KHY_HARNESS_MAX_ITER_BOOST    per-dial: integer (added to the loop cap)
 *   KHY_HARNESS_THINKING_FLOOR    per-dial: low|high|max|none
 *   KHY_HARNESS_SHORT_CONTEXT     per-dial: true|false (force short-context prompt)
 *   KHY_SHORT_CONTEXT_TOKENS      window (tokens) at/below which a model is "short" (default 32768)
 */
'use strict';

const VALID_TIERS = ['T0', 'T1', 'T2', 'T3'];

// Frontier models. These names never contain a weak token, so the weak
// demotion below cannot touch them.
const FRONTIER_RE = /(opus-?4|gpt-?5|grok-?4|o3-?pro)/i;

// Strong (non-frontier) models. Deliberately does NOT include bare o3-mini etc.
// (those fall through to the weak demotion).
const STRONG_RE = /(sonnet-?4|claude-3[.-]7|gpt-4o|gpt-4\.1|\bo1\b|\bo3\b|deepseek|qwen.*(max|plus|3|2\.5)|gemini.*pro|llama.*405|mistral-large|grok-?[23])/i;

// Weak token regex — same token set the loop uses for `_isLowTierModel`, but
// with a letter-boundary guard so a token does not match inside a larger word
// (e.g. "mini" must not fire on "ge**mini**", "lite" not on "e**lite**").
// Applied LAST as a demotion: pulls a T1/T2 model down to T3, but never T0.
const WEAK_RE = /(?<![a-z])(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i;

/**
 * Parse an env value into a boolean. Recognizes 1/true/yes/on and 0/false/no/off.
 * Returns `undefined` when unset/blank/unrecognized so callers can fall back.
 * @param {string|undefined} raw
 * @returns {boolean|undefined}
 */
function _envBool(raw) {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

/**
 * Resolve a model id to a capability tier.
 * @param {string} modelId
 * @param {{forceTier?: string}} [opts]
 * @returns {'T0'|'T1'|'T2'|'T3'}
 */
function resolveTier(modelId, opts = {}) {
  // 1. Explicit global force (option then env) — wins over everything.
  const forced = String(opts.forceTier || process.env.KHY_CAPABILITY_TIER || '')
    .trim().toUpperCase();
  if (VALID_TIERS.includes(forced)) return forced;

  const id = String(modelId || '').toLowerCase();
  if (!id) return 'T2';

  // 2. Per-model override (KHY_MODEL_TIER_MAP). Case-insensitive exact match on
  //    the model id; lets a user pin a tier that the regex would misjudge.
  const mapped = _resolveModelTierMap(id);
  if (mapped) return mapped;

  // 3. Frontier — not subject to weak demotion.
  if (FRONTIER_RE.test(id)) return 'T0';

  // 4. Strong, else default mid.
  let tier = STRONG_RE.test(id) ? 'T1' : 'T2';

  // 5. Weak demotion (non-frontier only). gpt-4o-mini → T3, haiku → T3.
  if (WEAK_RE.test(id)) tier = 'T3';

  return tier;
}

// Cache the parsed map keyed by the raw env string so repeated resolveTier
// calls don't re-parse JSON on every request.
let _tierMapCacheRaw = null;
let _tierMapCache = null;

/**
 * Look up a model id in KHY_MODEL_TIER_MAP (case-insensitive exact match).
 * @param {string} lowerId already-lowercased model id
 * @returns {'T0'|'T1'|'T2'|'T3'|null}
 */
function _resolveModelTierMap(lowerId) {
  const raw = process.env.KHY_MODEL_TIER_MAP;
  if (!raw || !String(raw).trim()) { _tierMapCacheRaw = null; _tierMapCache = null; return null; }
  if (raw !== _tierMapCacheRaw) {
    _tierMapCacheRaw = raw;
    _tierMapCache = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          const tier = String(v || '').trim().toUpperCase();
          if (VALID_TIERS.includes(tier)) _tierMapCache[String(k).toLowerCase()] = tier;
        }
      }
    } catch {
      _tierMapCache = {};
    }
  }
  return _tierMapCache[lowerId] || null;
}

const _EFFORT_TIERS = ['low', 'high', 'max'];

/**
 * Map a tier to the harness dials the loop should apply.
 *
 * Only T0 (frontier) relaxes; T1/T2/T3 == current behavior. Each dial can be
 * overridden by its KHY_HARNESS_* env flag (escape hatch).
 *
 * Dials:
 *   nudges          behavioral "keep going" nudges (off for T0)
 *   syntheticTools  synthetic tool execution layer (off for T0)
 *   capabilityGate  pre-block enforcement: hard|warn|off (warn for T0)
 *   promptVerbosity injected scaffolding text: lean|full (lean for T0)
 *   decompose       force auto task decomposition (off for T0)
 *   maxIterationsBoost  added to the agentic loop cap (+20 for T0)
 *   thinkingFloor   minimum auto-reasoning effort, or null (high for T0)
 *   toolCallProtocol  tool-call transport: native|text ('native' for ALL tiers)
 *
 * IMPORTANT — toolCallProtocol is a TRANSPORT statement, not a capability one,
 * so it is 'native' for EVERY tier (cloud T3 like haiku has perfectly good
 * native function calling and must NOT be auto-routed to the weak-model text
 * protocol). The authoritative "use text" signal comes from dispatch — which
 * knows it is talking to a LOCAL adapter — via an explicit options override on
 * the loop, NOT derived from tier. The KHY_HARNESS_TOOL_PROTOCOL env below is a
 * global escape hatch only.
 *
 * shortContext is a WINDOW signal, orthogonal to tier: when the model's
 * resolved context window is small (≤ KHY_SHORT_CONTEXT_TOKENS, default 32k) the
 * static system prompt must shrink regardless of tier, because the multi-KB
 * hand-holding sections would eat an 8k window whole. It does NOT touch the
 * runtime scaffolding (nudges/syntheticTools stay tier-driven), so a weak model
 * on a short window keeps its per-turn nudges while losing only the static bulk.
 * A weak model on a LONG window (e.g. deepseek 128k) is unaffected.
 *
 * @param {'T0'|'T1'|'T2'|'T3'} tier
 * @param {{contextWindow?: number}} [opts]
 * @returns {{tier:string, nudges:boolean, syntheticTools:boolean,
 *   capabilityGate:'hard'|'warn'|'off', promptVerbosity:'lean'|'full',
 *   decompose:boolean, maxIterationsBoost:number, thinkingFloor:(string|null),
 *   toolCallProtocol:'native'|'text', shortContext:boolean}}
 */
function harnessProfile(tier, opts = {}) {
  const t = VALID_TIERS.includes(tier) ? tier : 'T2';
  const relaxed = t === 'T0';

  // Window-driven short-context detection (single source of truth in
  // contextProfile). Unknown/large windows → false → today's behavior verbatim.
  let shortContext = false;
  try {
    const cw = Number(opts && opts.contextWindow);
    if (Number.isFinite(cw) && cw > 0) {
      shortContext = require('./contextProfile').isShortContext(cw);
    }
  } catch { /* contextProfile optional — default to not-short */ }

  const profile = {
    tier: t,
    nudges: !relaxed,                          // T0: off; others: on (current)
    syntheticTools: !relaxed,                  // T0: off; others: on (current)
    capabilityGate: 'warn',                    // all tiers: warn (never hard-refuse a weak model at iter 0); restore old behavior via KHY_HARNESS_CAPABILITY_GATE=hard
    promptVerbosity: relaxed ? 'lean' : 'full',// T0: skip injected scaffolding text
    decompose: !relaxed,                       // T0: trust native planning
    maxIterationsBoost: relaxed ? 20 : 0,      // T0: longer agentic chains
    thinkingFloor: relaxed ? 'high' : null,    // T0: never think below 'high'
    toolCallProtocol: 'native',                // all tiers: native; text is dispatch-driven (local adapters), never tier-derived
    shortContext,                              // window ≤ 32k: shrink the STATIC prompt only (runtime scaffolding unchanged)
  };

  // Short-context override (escape hatch): force on/off regardless of window.
  const shortOverride = _envBool(process.env.KHY_HARNESS_SHORT_CONTEXT);
  if (shortOverride !== undefined) profile.shortContext = shortOverride;

  // Per-dial env overrides.
  const nudgesOverride = _envBool(process.env.KHY_HARNESS_NUDGES);
  if (nudgesOverride !== undefined) profile.nudges = nudgesOverride;

  const synOverride = _envBool(process.env.KHY_HARNESS_SYNTHETIC_TOOLS);
  if (synOverride !== undefined) profile.syntheticTools = synOverride;

  const gateOverride = String(process.env.KHY_HARNESS_CAPABILITY_GATE || '')
    .trim().toLowerCase();
  if (['hard', 'warn', 'off'].includes(gateOverride)) profile.capabilityGate = gateOverride;

  const verbosityOverride = String(process.env.KHY_HARNESS_PROMPT_VERBOSITY || '')
    .trim().toLowerCase();
  if (['lean', 'full'].includes(verbosityOverride)) profile.promptVerbosity = verbosityOverride;

  const decomposeOverride = _envBool(process.env.KHY_HARNESS_DECOMPOSE);
  if (decomposeOverride !== undefined) profile.decompose = decomposeOverride;

  const boostRaw = process.env.KHY_HARNESS_MAX_ITER_BOOST;
  if (boostRaw !== undefined && boostRaw !== '') {
    const n = Number.parseInt(boostRaw, 10);
    if (Number.isFinite(n)) profile.maxIterationsBoost = n;
  }

  const floorOverride = String(process.env.KHY_HARNESS_THINKING_FLOOR || '')
    .trim().toLowerCase();
  if (floorOverride === 'none') profile.thinkingFloor = null;
  else if (_EFFORT_TIERS.includes(floorOverride)) profile.thinkingFloor = floorOverride;

  // Global escape hatch only — the live "use text" decision is dispatch-driven
  // (options.toolCallProtocol), never tier-derived. This flag exists so an
  // operator can force one protocol fleet-wide for debugging.
  const protocolOverride = String(process.env.KHY_HARNESS_TOOL_PROTOCOL || '')
    .trim().toLowerCase();
  if (protocolOverride === 'native' || protocolOverride === 'text') {
    profile.toolCallProtocol = protocolOverride;
  }

  return profile;
}

/**
 * Decide whether a model should "self-render": pass its output through with no
 * structural normalization, trusting it to format cleanly. Strong-enough models
 * (T0 frontier, T1 strong) earn this — they emit well-formed markdown and never
 * leak chat-template sentinels, so touching their output only risks harm and
 * adds latency. T2 (unknown) and T3 (weak/small) do NOT self-render: their
 * output is normalized to a uniform shape (see cli/modelTextNormalizer) to fix
 * the messy display small models produce.
 *
 * Escape hatches:
 *   KHY_SELF_RENDER       force on|off for ALL models (overrides tier)
 *   KHY_FORCE_NORMALIZE   truthy → never self-render (normalize everything)
 *
 * @param {string} modelId
 * @param {{forceTier?: string}} [opts]
 * @returns {boolean}
 */
function shouldSelfRender(modelId, opts = {}) {
  const forced = _envBool(process.env.KHY_SELF_RENDER);
  if (forced !== undefined) return forced;
  if (_envBool(process.env.KHY_FORCE_NORMALIZE)) return false;
  const tier = resolveTier(modelId, opts);
  return tier === 'T0' || tier === 'T1';
}

module.exports = {
  resolveTier,
  harnessProfile,
  shouldSelfRender,
  // test hooks
  __resolveTierForTests: resolveTier,
  __envBoolForTests: _envBool,
};
