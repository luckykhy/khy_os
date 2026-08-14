'use strict';

/**
 * futureProofing.test.js — 与时俱进体检纯叶子的确定性单测 (node:test)。
 *
 * 覆盖：EOL 边界（已过/临近/在保/未来版本/无法识别）、模型时效（退役命中/正常/缺失）、
 * 自维护支柱（齐备/可重建 yellow/生命线缺失 red）、守卫覆盖、汇总判级、渲染、门控、fail-soft。
 * 所有事实由参数传入——叶子零 IO，故测试无需打桩文件系统。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const fp = require('../../src/services/futureProofing');

const ms = (iso) => Date.parse(iso);

describe('futureProofing._checkRuntimeEol', () => {
  test('past EOL → red with upgrade action', () => {
    const c = fp._checkRuntimeEol('v18.19.0', ms('2026-06-26'));
    assert.equal(c.status, 'red');
    assert.match(c.detail, /已于 2025-04-30/);
    assert.ok(c.action && /nvm/.test(c.action));
  });

  test('approaching EOL within window → yellow', () => {
    // Node 20 EOL 2026-04-30；取 EOL 前 100 天。
    const c = fp._checkRuntimeEol('v20.11.0', ms('2026-01-20'));
    assert.equal(c.status, 'yellow');
    assert.match(c.detail, /剩 \d+ 天/);
  });

  test('comfortably in support → green', () => {
    const c = fp._checkRuntimeEol('v22.0.0', ms('2026-06-26'));
    assert.equal(c.status, 'green');
    assert.equal(c.action, null);
  });

  test('newer-than-table major → green (never false-alarm)', () => {
    const c = fp._checkRuntimeEol('v26.0.0', ms('2026-06-26'));
    assert.equal(c.status, 'green');
  });

  test('ancient unlisted major → red', () => {
    const c = fp._checkRuntimeEol('v10.0.0', ms('2026-06-26'));
    assert.equal(c.status, 'red');
  });

  test('unparseable version → green (non-blocking)', () => {
    assert.equal(fp._checkRuntimeEol('garbage', ms('2026-06-26')).status, 'green');
    assert.equal(fp._checkRuntimeEol(undefined, ms('2026-06-26')).status, 'green');
  });

  test('EOL boundary is exclusive: exactly at EOL is not yet past', () => {
    // nowMs === eolMs → not > eol → falls into approaching window (0 days) → yellow.
    const c = fp._checkRuntimeEol('v18.0.0', ms('2025-04-30'));
    assert.equal(c.status, 'yellow');
  });
});

describe('futureProofing._checkModelCurrency', () => {
  test('healthy identity models → green, points at SSOT', () => {
    const c = fp._checkModelCurrency({ opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-latest' });
    assert.equal(c.status, 'green');
    assert.match(c.detail, /constants\/models\.js/);
  });

  test('retired identity model → yellow advisory', () => {
    const c = fp._checkModelCurrency({ opus: 'claude-2.1', sonnet: 'claude-sonnet-4-6' });
    assert.equal(c.status, 'yellow');
    assert.match(c.detail, /claude-2\.1/);
  });

  test('missing PRIMARY → yellow', () => {
    assert.equal(fp._checkModelCurrency({}).status, 'yellow');
    assert.equal(fp._checkModelCurrency(null).status, 'yellow');
  });

  test('legacy direct-API ids are NOT flagged (zero false positive)', () => {
    // gpt-3.5-turbo lives in openaiDirect, not identity tier → never reached here.
    const c = fp._checkModelCurrency({ opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-latest' });
    assert.equal(c.status, 'green');
  });
});

describe('futureProofing._checkSelfMaintenance', () => {
  test('all pillars present → green', () => {
    const c = fp._checkSelfMaintenance({ pipLifeline: true, aiSeedDocs: true, maintenanceLaunchers: true, inheritanceDoc: true });
    assert.equal(c.status, 'green');
  });

  test('rebuildable pillar missing → yellow', () => {
    const c = fp._checkSelfMaintenance({ pipLifeline: true, aiSeedDocs: false, maintenanceLaunchers: true, inheritanceDoc: true });
    assert.equal(c.status, 'yellow');
    assert.match(c.detail, /种子文档/);
  });

  test('pip lifeline gone → red (cannot distribute)', () => {
    const c = fp._checkSelfMaintenance({ pipLifeline: false, aiSeedDocs: true, maintenanceLaunchers: true, inheritanceDoc: true });
    assert.equal(c.status, 'red');
  });

  test('absent keys (undefined) are not treated as missing', () => {
    // only explicit false counts as missing → unknown wiring stays green.
    assert.equal(fp._checkSelfMaintenance({}).status, 'green');
  });
});

describe('futureProofing._checkGuardCoverage', () => {
  test('all guards wired → green', () => {
    const c = fp._checkGuardCoverage({
      'check-agent-rules': true, 'check-leaf-contract': true,
      'check-model-hardcoding': true, 'check-change-safety': true,
    });
    assert.equal(c.status, 'green');
  });

  test('a guard disconnected → yellow', () => {
    const c = fp._checkGuardCoverage({
      'check-agent-rules': true, 'check-leaf-contract': false,
      'check-model-hardcoding': true, 'check-change-safety': true,
    });
    assert.equal(c.status, 'yellow');
    assert.match(c.detail, /check-leaf-contract/);
  });

  test('no parse data → yellow (non-blocking)', () => {
    assert.equal(fp._checkGuardCoverage({}).status, 'yellow');
  });
});

describe('futureProofing.buildFreshnessReport', () => {
  test('aggregates to worst severity (red wins)', () => {
    const r = fp.buildFreshnessReport({
      now: '2026-06-26', nodeVersion: 'v18.0.0',
      primaryModels: { opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-latest' },
      wiring: { pipLifeline: true, aiSeedDocs: true, maintenanceLaunchers: true, inheritanceDoc: true },
      guards: { 'check-agent-rules': true, 'check-leaf-contract': true, 'check-model-hardcoding': true, 'check-change-safety': true },
    });
    assert.equal(r.level, 'red');
    assert.equal(r.ok, false);
    assert.equal(r.checks.length, 4);
  });

  test('all healthy → green, ok true', () => {
    const r = fp.buildFreshnessReport({
      now: '2026-06-26', nodeVersion: 'v22.0.0',
      primaryModels: { opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-latest' },
      wiring: { pipLifeline: true, aiSeedDocs: true, maintenanceLaunchers: true, inheritanceDoc: true },
      guards: { 'check-agent-rules': true, 'check-leaf-contract': true, 'check-model-hardcoding': true, 'check-change-safety': true },
    });
    assert.equal(r.level, 'green');
    assert.equal(r.ok, true);
  });

  test('deterministic: identical input → identical output', () => {
    const ctx = { now: '2026-06-26', nodeVersion: 'v22.0.0', primaryModels: { opus: 'claude-opus-4-8' } };
    assert.deepEqual(fp.buildFreshnessReport(ctx), fp.buildFreshnessReport(ctx));
  });

  test('empty context → never throws, yields checks', () => {
    const r = fp.buildFreshnessReport();
    assert.ok(Array.isArray(r.checks) && r.checks.length === 4);
  });
});

describe('futureProofing.renderFreshness', () => {
  test('produces non-empty lines incl. actions for findings', () => {
    const r = fp.buildFreshnessReport({ now: '2026-06-26', nodeVersion: 'v18.0.0' });
    const lines = fp.renderFreshness(r);
    assert.ok(lines.length > r.checks.length); // header + checks + actions + summary
    assert.ok(lines.some((l) => /→/.test(l)));
  });

  test('fail-soft on malformed report', () => {
    assert.deepEqual(fp.renderFreshness(null).length >= 2, true);
  });
});

describe('futureProofing.isEnabled / freshnessHintLine (gate)', () => {
  test('default on', () => {
    assert.equal(fp.isEnabled({}), true);
    assert.ok(fp.freshnessHintLine({}).includes('maintain freshness'));
  });

  test('off values disable the hint', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(fp.isEnabled({ KHY_FUTURE_PROOFING: v }), false);
      assert.equal(fp.freshnessHintLine({ KHY_FUTURE_PROOFING: v }), '');
    }
  });
});

describe('futureProofing.getModelRetirementNotice (CC model-deprecation parity)', () => {
  const now = ms; // ISO → epoch ms

  test('matches a deprecated model by substring, firstParty default provider', () => {
    const n = fp.getModelRetirementNotice('claude-3-7-sonnet-20250219', { nowMs: now('2026-07-01') });
    assert.ok(n && n.includes('Claude 3.7 Sonnet'));
    assert.ok(n.includes('February 19, 2026'));
    assert.ok(n.includes('建议切换到更新的模型'));
  });

  test('tense-aware: past retirement date → 已于', () => {
    // 2026-07-01 is after February 19, 2026 (firstParty).
    const n = fp.getModelRetirementNotice('claude-3-7-sonnet', { nowMs: now('2026-07-01') });
    assert.match(n, /已于/);
    assert.doesNotMatch(n, /将于/);
  });

  test('tense-aware: future retirement date → 将于', () => {
    // Before February 19, 2026 the firstParty date is still upcoming.
    const n = fp.getModelRetirementNotice('claude-3-7-sonnet', { nowMs: now('2026-01-01') });
    assert.match(n, /将于/);
  });

  test('no nowMs → neutral 计划于 (CC has no tense)', () => {
    const n = fp.getModelRetirementNotice('claude-3-opus-20240229', {});
    assert.match(n, /计划于/);
  });

  test('provider column selection: bedrock differs from firstParty', () => {
    const fpNotice = fp.getModelRetirementNotice('claude-3-opus', { provider: 'firstParty', nowMs: now('2025-01-01') });
    const bedNotice = fp.getModelRetirementNotice('claude-3-opus', { provider: 'bedrock', nowMs: now('2025-01-01') });
    assert.ok(fpNotice.includes('January 5, 2026'));
    assert.ok(bedNotice.includes('January 15, 2026'));
  });

  test('null retirement date for a provider → no notice (haiku on bedrock)', () => {
    // claude-3-5-haiku has firstParty date but null on bedrock/vertex/foundry.
    assert.equal(fp.getModelRetirementNotice('claude-3-5-haiku', { provider: 'bedrock' }), null);
    assert.ok(fp.getModelRetirementNotice('claude-3-5-haiku', { provider: 'firstParty' }));
  });

  test('adapterName maps to provider bucket', () => {
    assert.equal(fp._apiProviderBucket('anthropic-relay'), 'firstParty');
    assert.equal(fp._apiProviderBucket('aws-bedrock'), 'bedrock');
    assert.equal(fp._apiProviderBucket('gcp-vertex'), 'vertex');
    assert.equal(fp._apiProviderBucket('azure-foundry'), 'foundry');
    assert.equal(fp._apiProviderBucket('ollama-local'), 'firstParty');
  });

  test('current khy models (opus-4-x) are NOT in the retirement table → null', () => {
    assert.equal(fp.getModelRetirementNotice('claude-opus-4-8', { nowMs: now('2026-07-01') }), null);
    assert.equal(fp.getModelRetirementNotice('claude-sonnet-4-6', { nowMs: now('2026-07-01') }), null);
    assert.equal(fp.getModelRetirementNotice('claude-haiku-4-5-20251001', { nowMs: now('2026-07-01') }), null);
  });

  test('non-Anthropic / unknown / bad input → null, never throws', () => {
    assert.equal(fp.getModelRetirementNotice('gpt-4o', {}), null);
    assert.equal(fp.getModelRetirementNotice('', {}), null);
    assert.equal(fp.getModelRetirementNotice(null, {}), null);
    assert.equal(fp.getModelRetirementNotice(undefined), null);
    assert.equal(fp.getModelRetirementNotice(123, {}), null);
  });

  test('gate KHY_MODEL_DEPRECATION_NOTICE off → null (byte-identical fallback)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(fp.isModelDeprecationEnabled({ KHY_MODEL_DEPRECATION_NOTICE: v }), false);
      assert.equal(
        fp.getModelRetirementNotice('claude-3-7-sonnet', { nowMs: now('2026-07-01'), env: { KHY_MODEL_DEPRECATION_NOTICE: v } }),
        null,
      );
    }
    assert.equal(fp.isModelDeprecationEnabled({}), true);
  });

  test('RETIRED_MODEL_IDS and MODEL_RETIREMENT keys are disjoint (orthogonal surfaces)', () => {
    for (const key of Object.keys(fp.MODEL_RETIREMENT)) {
      assert.equal(fp.RETIRED_MODEL_IDS.has(key), false);
    }
  });
});
