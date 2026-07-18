'use strict';

// Unit tests for the model-capability tier resolver and harness profile.
// Pure functions — no loop, no network.

const modelTier = require('../src/services/modelTier');

const TIER_ENV = [
  'KHY_CAPABILITY_TIER',
  'KHY_HARNESS_NUDGES',
  'KHY_HARNESS_SYNTHETIC_TOOLS',
  'KHY_HARNESS_CAPABILITY_GATE',
  'KHY_HARNESS_PROMPT_VERBOSITY',
  'KHY_HARNESS_DECOMPOSE',
  'KHY_HARNESS_MAX_ITER_BOOST',
  'KHY_HARNESS_THINKING_FLOOR',
  'KHY_HARNESS_TOOL_PROTOCOL',
  'KHY_SELF_RENDER',
  'KHY_FORCE_NORMALIZE',
  'KHY_MODEL_TIER_MAP',
];
afterEach(() => { for (const k of TIER_ENV) delete process.env[k]; });

describe('resolveTier', () => {
  test('frontier models → T0', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4', 'opus-4-1', 'gpt-5', 'gpt5', 'grok-4', 'o3-pro']) {
      expect(modelTier.resolveTier(id)).toBe('T0');
    }
  });

  test('opus-4 is never demoted by weak tokens', () => {
    // Synthetic id carrying a weak token; frontier match must win.
    expect(modelTier.resolveTier('claude-opus-4-8')).toBe('T0');
  });

  test('strong models → T1', () => {
    for (const id of ['claude-sonnet-4-5', 'claude-3-7-sonnet', 'gpt-4o', 'gpt-4.1',
      'o1-preview', 'deepseek-chat', 'qwen-max', 'qwen2.5-72b-instruct',
      'gemini-1.5-pro', 'llama-3.1-405b', 'mistral-large-latest']) {
      expect(modelTier.resolveTier(id)).toBe('T1');
    }
  });

  test('weak models → T3 (demotion overrides strong/default)', () => {
    for (const id of ['gpt-4o-mini', 'claude-haiku-4-5', 'gemini-2.0-flash',
      'qwen2.5-7b', 'llama-3-8b', 'phi-3-mini', 'some-nano-model']) {
      expect(modelTier.resolveTier(id)).toBe('T3');
    }
  });

  test('unknown / empty → T2', () => {
    expect(modelTier.resolveTier('totally-unknown-model')).toBe('T2');
    expect(modelTier.resolveTier('')).toBe('T2');
    expect(modelTier.resolveTier(undefined)).toBe('T2');
  });

  test('KHY_CAPABILITY_TIER forces a tier', () => {
    process.env.KHY_CAPABILITY_TIER = 't3';
    expect(modelTier.resolveTier('claude-opus-4-8')).toBe('T3');
    process.env.KHY_CAPABILITY_TIER = 'T0';
    expect(modelTier.resolveTier('gpt-4o-mini')).toBe('T0');
  });

  test('opts.forceTier overrides id', () => {
    expect(modelTier.resolveTier('gpt-4o-mini', { forceTier: 'T0' })).toBe('T0');
  });

  test('KHY_MODEL_TIER_MAP pins a per-model tier (wins over regex)', () => {
    // agnes-2.0-flash trips the weak-token heuristic → T3 by default.
    expect(modelTier.resolveTier('agnes-2.0-flash')).toBe('T3');
    process.env.KHY_MODEL_TIER_MAP = JSON.stringify({ 'agnes-2.0-flash': 'T1' });
    expect(modelTier.resolveTier('agnes-2.0-flash')).toBe('T1');
    // Case-insensitive exact match on the id.
    expect(modelTier.resolveTier('AGNES-2.0-FLASH')).toBe('T1');
  });

  test('KHY_MODEL_TIER_MAP loses to the global force', () => {
    process.env.KHY_MODEL_TIER_MAP = JSON.stringify({ 'agnes-2.0-flash': 'T1' });
    process.env.KHY_CAPABILITY_TIER = 'T0';
    expect(modelTier.resolveTier('agnes-2.0-flash')).toBe('T0');
  });

  test('malformed KHY_MODEL_TIER_MAP is ignored (falls back to auto)', () => {
    process.env.KHY_MODEL_TIER_MAP = 'not-json{';
    expect(modelTier.resolveTier('agnes-2.0-flash')).toBe('T3');
    process.env.KHY_MODEL_TIER_MAP = JSON.stringify({ 'agnes-2.0-flash': 'BOGUS' });
    expect(modelTier.resolveTier('agnes-2.0-flash')).toBe('T3');
  });
});

describe('harnessProfile', () => {
  test('T0 relaxes all scaffolding', () => {
    expect(modelTier.harnessProfile('T0')).toEqual({
      tier: 'T0', nudges: false, syntheticTools: false, capabilityGate: 'warn',
      promptVerbosity: 'lean', decompose: false, maxIterationsBoost: 20, thinkingFloor: 'high',
      toolCallProtocol: 'native', shortContext: false,
    });
  });

  test('T1/T2/T3 keep full scaffolding but gate is warn (weak models may attempt delivery)', () => {
    for (const t of ['T1', 'T2', 'T3']) {
      expect(modelTier.harnessProfile(t)).toEqual({
        tier: t, nudges: true, syntheticTools: true, capabilityGate: 'warn',
        promptVerbosity: 'full', decompose: true, maxIterationsBoost: 0, thinkingFloor: null,
        toolCallProtocol: 'native', shortContext: false,
      });
    }
  });

  describe('shortContext (window-driven, orthogonal to tier)', () => {
    afterEach(() => { delete process.env.KHY_HARNESS_SHORT_CONTEXT; });

    test('defaults false when no window is given', () => {
      expect(modelTier.harnessProfile('T2').shortContext).toBe(false);
    });
    test('true for a small window, regardless of tier', () => {
      // A strong model forced onto an 8k window still needs the static prompt trimmed.
      expect(modelTier.harnessProfile('T1', { contextWindow: 8000 }).shortContext).toBe(true);
      expect(modelTier.harnessProfile('T3', { contextWindow: 16384 }).shortContext).toBe(true);
    });
    test('false for a large window even on a weak tier', () => {
      // A weak model on a 128k window (e.g. deepseek) keeps the full prompt.
      expect(modelTier.harnessProfile('T3', { contextWindow: 128000 }).shortContext).toBe(false);
    });
    test('unknown (0) window → not short', () => {
      expect(modelTier.harnessProfile('T2', { contextWindow: 0 }).shortContext).toBe(false);
    });
    test('does NOT disturb the runtime scaffolding dials (nudges stay tier-driven)', () => {
      const p = modelTier.harnessProfile('T3', { contextWindow: 8000 });
      expect(p.nudges).toBe(true);          // weak model keeps per-turn nudges
      expect(p.syntheticTools).toBe(true);  // and its synthetic-tool layer
      expect(p.shortContext).toBe(true);    // only the static-prompt signal flips
    });
    test('KHY_HARNESS_SHORT_CONTEXT override forces the signal', () => {
      process.env.KHY_HARNESS_SHORT_CONTEXT = 'true';
      expect(modelTier.harnessProfile('T0', { contextWindow: 200000 }).shortContext).toBe(true);
      process.env.KHY_HARNESS_SHORT_CONTEXT = 'false';
      expect(modelTier.harnessProfile('T3', { contextWindow: 8000 }).shortContext).toBe(false);
    });
  });

  test('capabilityGate defaults to warn for EVERY tier (no tier is hard-refused at iter 0)', () => {
    for (const t of ['T0', 'T1', 'T2', 'T3']) {
      expect(modelTier.harnessProfile(t).capabilityGate).toBe('warn');
    }
  });

  test('KHY_HARNESS_CAPABILITY_GATE=hard restores the old hard-block for weak tiers', () => {
    process.env.KHY_HARNESS_CAPABILITY_GATE = 'hard';
    for (const t of ['T1', 'T2', 'T3']) {
      expect(modelTier.harnessProfile(t).capabilityGate).toBe('hard');
    }
  });

  test('unknown tier defaults to T2 dials', () => {
    expect(modelTier.harnessProfile('bogus')).toMatchObject({
      tier: 'T2', nudges: true, capabilityGate: 'warn',
    });
  });

  test('KHY_HARNESS_NUDGES flips the nudges dial back on for T0', () => {
    process.env.KHY_HARNESS_NUDGES = 'true';
    expect(modelTier.harnessProfile('T0').nudges).toBe(true);
  });

  test('KHY_HARNESS_SYNTHETIC_TOOLS off-overrides for T1', () => {
    process.env.KHY_HARNESS_SYNTHETIC_TOOLS = 'false';
    expect(modelTier.harnessProfile('T1').syntheticTools).toBe(false);
  });

  test('KHY_HARNESS_CAPABILITY_GATE overrides the gate', () => {
    process.env.KHY_HARNESS_CAPABILITY_GATE = 'off';
    expect(modelTier.harnessProfile('T1').capabilityGate).toBe('off');
    process.env.KHY_HARNESS_CAPABILITY_GATE = 'garbage';
    expect(modelTier.harnessProfile('T0').capabilityGate).toBe('warn'); // unrecognized → default
  });

  test('KHY_HARNESS_PROMPT_VERBOSITY / DECOMPOSE override the second-cut dials', () => {
    process.env.KHY_HARNESS_PROMPT_VERBOSITY = 'lean';
    expect(modelTier.harnessProfile('T1').promptVerbosity).toBe('lean');
    process.env.KHY_HARNESS_DECOMPOSE = 'false';
    expect(modelTier.harnessProfile('T2').decompose).toBe(false);
  });

  test('KHY_HARNESS_MAX_ITER_BOOST overrides the loop-cap boost', () => {
    process.env.KHY_HARNESS_MAX_ITER_BOOST = '40';
    expect(modelTier.harnessProfile('T0').maxIterationsBoost).toBe(40);
    expect(modelTier.harnessProfile('T1').maxIterationsBoost).toBe(40);
  });

  test('KHY_HARNESS_THINKING_FLOOR overrides / disables the floor', () => {
    process.env.KHY_HARNESS_THINKING_FLOOR = 'max';
    expect(modelTier.harnessProfile('T1').thinkingFloor).toBe('max');
    process.env.KHY_HARNESS_THINKING_FLOOR = 'none';
    expect(modelTier.harnessProfile('T0').thinkingFloor).toBe(null);
  });

  test('toolCallProtocol defaults to native for EVERY tier (transport ≠ capability)', () => {
    // Even T3 (weak/haiku-class CLOUD models) keep native: they have real
    // function calling. The text protocol is dispatch-driven for LOCAL adapters
    // only, never derived from a low tier.
    for (const t of ['T0', 'T1', 'T2', 'T3']) {
      expect(modelTier.harnessProfile(t).toolCallProtocol).toBe('native');
    }
  });

  test('KHY_HARNESS_TOOL_PROTOCOL is a global escape hatch (native|text only)', () => {
    process.env.KHY_HARNESS_TOOL_PROTOCOL = 'text';
    expect(modelTier.harnessProfile('T0').toolCallProtocol).toBe('text');
    process.env.KHY_HARNESS_TOOL_PROTOCOL = 'native';
    expect(modelTier.harnessProfile('T3').toolCallProtocol).toBe('native');
    process.env.KHY_HARNESS_TOOL_PROTOCOL = 'garbage';
    expect(modelTier.harnessProfile('T1').toolCallProtocol).toBe('native'); // unrecognized → default
  });
});

describe('shouldSelfRender', () => {
  test('strong-enough models (T0/T1) self-render', () => {
    for (const id of ['claude-opus-4-8', 'gpt-5', 'claude-sonnet-4-5', 'deepseek-chat', 'qwen-max']) {
      expect(modelTier.shouldSelfRender(id)).toBe(true);
    }
  });

  test('small / unknown models (T2/T3) do NOT self-render (normalized)', () => {
    for (const id of ['gpt-4o-mini', 'claude-haiku-4-5', 'gemini-2.0-flash',
      'qwen2.5-7b', 'totally-unknown-model', '']) {
      expect(modelTier.shouldSelfRender(id)).toBe(false);
    }
  });

  test('KHY_SELF_RENDER forces the decision for ALL models', () => {
    process.env.KHY_SELF_RENDER = 'true';
    expect(modelTier.shouldSelfRender('gpt-4o-mini')).toBe(true); // weak forced on
    process.env.KHY_SELF_RENDER = 'false';
    expect(modelTier.shouldSelfRender('claude-opus-4-8')).toBe(false); // frontier forced off
  });

  test('KHY_FORCE_NORMALIZE disables self-render for everything', () => {
    process.env.KHY_FORCE_NORMALIZE = '1';
    expect(modelTier.shouldSelfRender('claude-opus-4-8')).toBe(false);
    expect(modelTier.shouldSelfRender('gpt-5')).toBe(false);
  });

  test('KHY_SELF_RENDER takes precedence over KHY_FORCE_NORMALIZE', () => {
    process.env.KHY_SELF_RENDER = 'true';
    process.env.KHY_FORCE_NORMALIZE = '1';
    expect(modelTier.shouldSelfRender('gpt-4o-mini')).toBe(true);
  });

  test('opts.forceTier flows through to the decision', () => {
    expect(modelTier.shouldSelfRender('gpt-4o-mini', { forceTier: 'T0' })).toBe(true);
    expect(modelTier.shouldSelfRender('claude-opus-4-8', { forceTier: 'T3' })).toBe(false);
  });
});
