'use strict';

/**
 * resolveModelCostEntriesHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the prefix-match entries in
 * resolveModelCost(): the Object.entries(DEFAULT_MODEL_PRICING) array is now
 * built once at module load instead of per fallback lookup. Behavior must be
 * byte-identical: exact match, prefix match, and miss all unchanged.
 */

const test = require('node:test');
const assert = require('node:assert');

const uf = require('../src/services/usageFormatter.js');
const { resolveModelCost, DEFAULT_MODEL_PRICING } = uf;

test('exact match returns the table entry by reference', () => {
  const cfg = resolveModelCost('claude-opus-4');
  assert.strictEqual(cfg, DEFAULT_MODEL_PRICING['claude-opus-4']);
});

test('prefix match resolves dated/suffixed model ids', () => {
  const cfg = resolveModelCost('claude-opus-4-20250514');
  assert.strictEqual(cfg, DEFAULT_MODEL_PRICING['claude-opus-4']);
  // Prefix match is order-dependent (first startsWith wins): 'gpt-4.1' precedes
  // 'gpt-4.1-mini' in the table, so a mini id resolves to the gpt-4.1 entry.
  // The hoist preserves this insertion order byte-for-byte.
  assert.strictEqual(resolveModelCost('gpt-4.1-mini-2025'), DEFAULT_MODEL_PRICING['gpt-4.1']);
});

test('unknown model returns undefined', () => {
  assert.strictEqual(resolveModelCost('totally-unknown-model'), undefined);
});

test('empty / falsy model returns undefined', () => {
  assert.strictEqual(resolveModelCost(''), undefined);
  assert.strictEqual(resolveModelCost(null), undefined);
  assert.strictEqual(resolveModelCost(undefined), undefined);
});

test('case-insensitive lookup', () => {
  assert.strictEqual(resolveModelCost('CLAUDE-OPUS-4'), DEFAULT_MODEL_PRICING['claude-opus-4']);
});

test('repeated lookups are stable (hoisted entries not corrupted)', () => {
  const a = resolveModelCost('deepseek-r1-0528');
  const b = resolveModelCost('deepseek-r1-0528');
  assert.strictEqual(a, b);
  assert.strictEqual(a, DEFAULT_MODEL_PRICING['deepseek-r1']);
});
