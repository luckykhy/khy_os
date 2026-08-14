'use strict';

/**
 * modelConstants.test.js — guards the model-name single source of truth.
 *
 * Intent: model names must live in ONE place (constants/models.js) as typed
 * arrays grouped by role/tier; call sites reference array names (or their
 * primary), never raw model-id strings. These tests pin the module's shape and
 * the fail-soft contract so a future "switch the model" edit stays one-place.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const models = require('../src/constants/models');

const ARRAY_EXPORTS = [
  'CLAUDE_OPUS_MODELS',
  'CLAUDE_SONNET_MODELS',
  'CLAUDE_HAIKU_MODELS',
  'EMBEDDING_MODELS',
  'LOCAL_BRAIN_MODELS',
  'LOCAL_BRAIN_GGUF_FILES',
  'OLLAMA_DEFAULT_MODELS',
  'IDE_DEFAULT_MODELS',
  'RELAY_DEFAULT_MODELS',
  'CODEX_PROBE_MODELS',
  'CODEX_AGENT_MODELS',
  'LIGHTWEIGHT_AGENT_MODELS',
  'FREE_GOOGLE_MODELS',
  'FREE_GROQ_MODELS',
  'OPENAI_DIRECT_MODELS',
  'ANTHROPIC_DIRECT_MODELS',
  'QWEN_DIRECT_MODELS',
  'ZHIPU_DIRECT_MODELS',
];

test('every typed export is a non-empty array of non-empty strings', () => {
  for (const name of ARRAY_EXPORTS) {
    const arr = models[name];
    assert.ok(Array.isArray(arr), `${name} should be an array`);
    assert.ok(arr.length > 0, `${name} should be non-empty`);
    for (const entry of arr) {
      assert.strictEqual(typeof entry, 'string', `${name} entries must be strings`);
      assert.ok(entry.trim().length > 0, `${name} entries must be non-empty`);
    }
  }
});

test('primaryOf returns first element and is fail-soft', () => {
  assert.strictEqual(models.primaryOf(['a', 'b']), 'a');
  assert.strictEqual(models.primaryOf(['only']), 'only');
  // fail-soft: never throws on bad input
  assert.strictEqual(models.primaryOf([]), '');
  assert.strictEqual(models.primaryOf(null), '');
  assert.strictEqual(models.primaryOf(undefined), '');
  assert.strictEqual(models.primaryOf('not-an-array'), '');
  assert.strictEqual(models.primaryOf(42), '');
});

test('PRIMARY map exposes the first element of each backing array', () => {
  const pairs = [
    ['opus', 'CLAUDE_OPUS_MODELS'],
    ['sonnet', 'CLAUDE_SONNET_MODELS'],
    ['haiku', 'CLAUDE_HAIKU_MODELS'],
    ['embedding', 'EMBEDDING_MODELS'],
    ['localBrain', 'LOCAL_BRAIN_MODELS'],
    ['ollama', 'OLLAMA_DEFAULT_MODELS'],
    ['ide', 'IDE_DEFAULT_MODELS'],
    ['relay', 'RELAY_DEFAULT_MODELS'],
    ['codexProbe', 'CODEX_PROBE_MODELS'],
    ['freeGoogle', 'FREE_GOOGLE_MODELS'],
    ['freeGroq', 'FREE_GROQ_MODELS'],
    ['openaiDirect', 'OPENAI_DIRECT_MODELS'],
    ['anthropicDirect', 'ANTHROPIC_DIRECT_MODELS'],
    ['qwenDirect', 'QWEN_DIRECT_MODELS'],
    ['zhipuDirect', 'ZHIPU_DIRECT_MODELS'],
  ];
  for (const [key, arrName] of pairs) {
    assert.strictEqual(
      models.PRIMARY[key],
      models[arrName][0],
      `PRIMARY.${key} should equal ${arrName}[0]`
    );
  }
});

test('every PRIMARY value is a non-empty string', () => {
  for (const [key, value] of Object.entries(models.PRIMARY)) {
    assert.strictEqual(typeof value, 'string', `PRIMARY.${key} must be a string`);
    assert.ok(value.trim().length > 0, `PRIMARY.${key} must be non-empty`);
  }
});

test('LOCAL_BRAIN_GGUF_FILES holds the three positional weight candidates', () => {
  // localLLMService references [0]/[1]/[2] by index — pin the arity so an
  // edit there cannot silently drop a candidate path.
  assert.strictEqual(models.LOCAL_BRAIN_GGUF_FILES.length, 3);
  for (const f of models.LOCAL_BRAIN_GGUF_FILES) {
    assert.ok(/\.gguf$/i.test(f), `${f} should be a .gguf file name`);
  }
});

test('LIGHTWEIGHT_AGENT_MODELS exposes two positional ids (AgentTool [0]/[1])', () => {
  assert.strictEqual(models.LIGHTWEIGHT_AGENT_MODELS.length, 2);
});

test('models.js is pure: requiring it does not read process.env', () => {
  // Spy on env access to confirm the leaf reads no env at load time.
  const seen = [];
  const realEnv = process.env;
  const proxy = new Proxy(realEnv, {
    get(target, prop) { seen.push(prop); return target[prop]; },
  });
  // eslint-disable-next-line no-global-assign
  process.env = proxy;
  try {
    delete require.cache[require.resolve('../src/constants/models')];
    require('../src/constants/models');
  } finally {
    process.env = realEnv;
  }
  assert.strictEqual(seen.length, 0, `models.js should not read env, saw: ${seen.join(',')}`);
});

test('prompts.js MODEL_IDS are sourced from the SSOT (opus/sonnet/haiku)', () => {
  const { MODEL_IDS } = require('../src/constants/prompts');
  assert.strictEqual(MODEL_IDS.opus, models.PRIMARY.opus);
  assert.strictEqual(MODEL_IDS.sonnet, models.PRIMARY.sonnet);
  assert.strictEqual(MODEL_IDS.haiku, models.PRIMARY.haiku);
});
