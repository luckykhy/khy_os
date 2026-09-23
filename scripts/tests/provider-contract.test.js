'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  discoverAdapters,
  validateFixtureCoverage,
  validateResult,
  validateSourceContract,
} = require('../quality-gate/provider-contract');

describe('provider contract gate', () => {
  test('discovers every generate exporter and has an exact fixture set', () => {
    const files = discoverAdapters();
    // 19 adapters as of 2026-09-23: commandCodeAdapter.js (KHY_COMMANDCODE, opt-in)
    // is a thin shell over cliToolAdapter and exports generate, so the gate must
    // cover it too. Keep this count in sync with providerContractFixtures.js.
    assert.equal(files.length, 19);
    assert.doesNotThrow(() => validateFixtureCoverage(files));
    for (const file of files) assert.doesNotThrow(() => validateSourceContract(file));
  });

  test('projects canonical content to requested text shape', () => {
    const projected = validateResult('fixtureAdapter.js', {
      success: true,
      content: 'fixture text',
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: 'fixture-model',
    });
    assert.deepEqual(projected, {
      text: 'fixture text',
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: 'fixture-model',
    });
  });

  test('catches deliberately broken adapter return fields', () => {
    const file = path.join('tmp', 'brokenAdapter.js');
    const base = {
      success: true,
      content: 'ok',
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 1 },
      model: 'fixture-model',
    };
    assert.throws(() => validateResult(file, { ...base, content: '' }), /text\/content/);
    assert.throws(() => validateResult(file, { ...base, tokenUsage: null }), /tokenUsage/);
    assert.throws(() => validateResult(file, { ...base, tokenUsage: { totalTokens: 1 } }), /inputTokens/);
    assert.throws(() => validateResult(file, { ...base, model: null }), /model/);
    assert.throws(() => validateResult(file, { ...base, success: false }), /failure/);
  });
});
