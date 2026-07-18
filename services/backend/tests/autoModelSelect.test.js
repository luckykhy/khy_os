'use strict';

/**
 * autoModelSelect.test.js — 纯叶子契约:模型列表「Auto」入口 + 任务感知的可用模型排序。
 * /goal「khy 在模型列表下设置一个 auto 模型自动选择最适合当前任务且可用的模型模式」。
 *
 * 覆盖:门控(flagRegistry 优先 + 本地 CANON 回退)、isAutoSelection 各形状、rankAutoModels
 * 的任务→tier 贴合度 + 可用性过滤 + 稳定/确定性、pickAutoModel 头名、buildAutoChoice 形状与
 * 预览、fail-soft。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/gateway/autoModelSelect'));

test('isEnabled: default ON; CANON off-words disable', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_AUTO_MODEL_SELECT: 'true' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(leaf.isEnabled({ KHY_AUTO_MODEL_SELECT: off }), false, `off=${off}`);
  }
  // non-CANON word stays ON (superset-safe)
  assert.equal(leaf.isEnabled({ KHY_AUTO_MODEL_SELECT: 'disabled' }), true);
});

test('isAutoSelection: object/string/edge shapes', () => {
  assert.equal(leaf.isAutoSelection({ adapter: 'auto', model: 'auto' }), true);
  assert.equal(leaf.isAutoSelection({ adapter: 'AUTO', model: 'x' }), true);
  assert.equal(leaf.isAutoSelection({ adapter: 'api', model: 'auto' }), true);
  assert.equal(leaf.isAutoSelection('auto'), true);
  assert.equal(leaf.isAutoSelection(' Auto '), true);
  assert.equal(leaf.isAutoSelection({ adapter: 'api', model: 'glm-4.6' }), false);
  assert.equal(leaf.isAutoSelection(null), false);
  assert.equal(leaf.isAutoSelection(42), false);
});

test('rankAutoModels: filters unavailable (disabled/cooldown)', () => {
  const cands = [
    { model: 'a', tier: 'T2', status: 'active' },
    { model: 'b', tier: 'T2', status: 'disabled' },
    { model: 'c', tier: 'T2', status: 'cooldown' },
    { model: 'd', tier: 'T2', status: '' }, // unknown status → treated available
  ];
  const ranked = leaf.rankAutoModels('conversation', cands);
  const ids = ranked.map((r) => r.model);
  assert.ok(ids.includes('a'));
  assert.ok(ids.includes('d'));
  assert.ok(!ids.includes('b'));
  assert.ok(!ids.includes('c'));
});

test('rankAutoModels: reasoning prefers strongest tier (T0), conversation prefers balanced (T2)', () => {
  const cands = [
    { model: 'light', tier: 'T3', status: 'active' },
    { model: 'balanced', tier: 'T2', status: 'active' },
    { model: 'strong', tier: 'T1', status: 'active' },
    { model: 'flagship', tier: 'T0', status: 'active' },
  ];
  assert.equal(leaf.pickAutoModel('reasoning', cands).model, 'flagship');
  assert.equal(leaf.pickAutoModel('conversation', cands).model, 'balanced');
  assert.equal(leaf.pickAutoModel('code', cands).model, 'strong');
});

test('rankAutoModels: deterministic + stable (tie broken by original index)', () => {
  const cands = [
    { model: 'x', tier: 'T2', status: 'active' },
    { model: 'y', tier: 'T2', status: 'active' },
    { model: 'z', tier: 'T2', status: 'active' },
  ];
  const a = leaf.rankAutoModels('conversation', cands).map((r) => r.model);
  const b = leaf.rankAutoModels('conversation', cands).map((r) => r.model);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['x', 'y', 'z']); // all T2 → tie → original order
});

test('rankAutoModels: source credibility breaks tier ties (remote/chat > config > hint)', () => {
  const cands = [
    { model: 'hinted', tier: 'T2', status: 'active', source: 'hint' },
    { model: 'remoted', tier: 'T2', status: 'active', source: 'remote' },
    { model: 'configed', tier: 'T2', status: 'active', source: 'config' },
  ];
  assert.equal(leaf.pickAutoModel('conversation', cands).model, 'remoted');
});

test('rankAutoModels: bare string ids + tier inferred via modelTier', () => {
  const ranked = leaf.rankAutoModels('conversation', ['glm-4.6', 'some-model']);
  assert.ok(Array.isArray(ranked));
  assert.ok(ranked.length >= 1);
  ranked.forEach((r) => assert.ok(/^T[0-3]$/.test(r.tier)));
});

test('rankAutoModels: dedupe by model id (first wins)', () => {
  const cands = [
    { model: 'dup', tier: 'T1', status: 'active' },
    { model: 'DUP', tier: 'T3', status: 'active' },
  ];
  const ranked = leaf.rankAutoModels('conversation', cands);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].model, 'dup');
});

test('rankAutoModels / pickAutoModel: fail-soft on bad input', () => {
  assert.deepEqual(leaf.rankAutoModels('x', null), []);
  assert.deepEqual(leaf.rankAutoModels('x', undefined), []);
  assert.deepEqual(leaf.rankAutoModels('x', 'not-array'), []);
  assert.deepEqual(leaf.rankAutoModels('x', []), []);
  assert.equal(leaf.pickAutoModel('x', null), null);
  assert.equal(leaf.pickAutoModel('x', [{ model: 'a', status: 'disabled' }]), null);
});

test('buildAutoChoice: shape + sentinel value + preview label', () => {
  const c = leaf.buildAutoChoice();
  assert.equal(c.value.adapter, 'auto');
  assert.equal(c.value.model, 'auto');
  assert.equal(c.disabled, false);
  assert.ok(/Auto/.test(c.name));

  const withPreview = leaf.buildAutoChoice({ previewModel: 'glm-4.6' });
  assert.ok(withPreview.name.includes('glm-4.6'));

  // chalk that throws must not break the choice (fail-soft)
  const bad = leaf.buildAutoChoice({ chalk: { dim() { throw new Error('boom'); } }, previewModel: 'm' });
  assert.equal(bad.value.adapter, 'auto');
});

test('AUTO_SENTINEL + describe are stable exports', () => {
  assert.equal(leaf.AUTO_SENTINEL, 'auto');
  const d = leaf.describeAutoModelSelect();
  assert.equal(d.gate, 'KHY_AUTO_MODEL_SELECT');
  assert.equal(d.defaultOn, true);
  assert.equal(d.sentinel, 'auto');
});
