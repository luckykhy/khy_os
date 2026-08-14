'use strict';

/**
 * onDemandCapsuleModesHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the on-demand prompt-capsule mode Set
 * out of makeSystemPrompt. It was rebuilt inline on every prompt-cache miss; now
 * built once at module load as _ON_DEMAND_CAPSULE_MODES. The Set is consumed
 * read-only via `.has`, so a single shared instance is byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert');

const runtime = require('../src/services/khyUpgradeRuntime');
const { _ON_DEMAND_CAPSULE_MODES: MODES, makeSystemPrompt } = runtime;

test('exports the on-demand capsule mode Set with exactly the four modes', () => {
  assert.ok(MODES instanceof Set);
  const expected = ['on_demand', 'on_demand_omit', 'continuation_fallback', 'short_request_fallback'];
  assert.strictEqual(MODES.size, expected.length);
  for (const m of expected) assert.ok(MODES.has(m), `missing mode ${m}`);
  // A non-member (e.g. the 'unknown'/full-prompt default) must NOT match.
  assert.ok(!MODES.has('unknown'));
  assert.ok(!MODES.has('full'));
});

test('the exported Set is a stable singleton across re-require', () => {
  const again = require('../src/services/khyUpgradeRuntime');
  assert.strictEqual(again._ON_DEMAND_CAPSULE_MODES, MODES);
});

test('makeSystemPrompt still produces a stable prompt across repeated calls', async () => {
  const modelInfo = { model: 'claude-3-haiku', adapter: 'api' };
  const opts = { userMessage: 'help me refactor this function', taskScale: 'medium' };
  const a = await makeSystemPrompt(process.cwd(), modelInfo, [], opts);
  const b = await makeSystemPrompt(process.cwd(), modelInfo, [], opts);
  assert.strictEqual(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.strictEqual(a, b);
});
