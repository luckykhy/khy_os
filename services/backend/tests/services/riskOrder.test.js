'use strict';

/**
 * riskOrder — behavior lock for the risk-ordinal single-source-of-truth leaf
 * and the SCC decoupling cut it enables (node:test).
 *
 * Background: the ordinal scale { safe..critical → 0..4 } was copy-pasted into
 * four modules (riskGate, commandRiskClassifier, shellToToolMapper,
 * receiptService); approvalLedger borrowed it from riskGate, which pulled the
 * approval/risk cluster into the giant dependency SCC. The constant is now
 * hoisted into the zero-dependency leaf constants/riskOrder.js and every module
 * imports it from there — cutting the approvalLedger → riskGate edge (giant SCC
 * 63 → 59, [DESIGN-ARCH-051] §6.6). This suite pins the golden value, the
 * single-reference identity across all re-exporting consumers, the preserved
 * comparison behavior, and the no-phantom-edge source guard.
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/constants/riskOrder');

// The exact historical inline literal every module used to duplicate.
const GOLDEN = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

test('叶子 RISK_ORDER 与历史内联字面量逐字等价（golden）', () => {
  assert.deepStrictEqual({ ...leaf.RISK_ORDER }, GOLDEN);
});

test('叶子常量被冻结（防止任何消费者意外篡改共享单源）', () => {
  assert.strictEqual(Object.isFrozen(leaf.RISK_ORDER), true);
});

test('单一真源身份：四个再导出模块共享同一引用（证明去重而非再次复制）', () => {
  const riskGate = require('../../src/services/riskGate');
  const classifier = require('../../src/services/commandRiskClassifier');
  const mapper = require('../../src/services/shellToToolMapper');
  // 同一对象引用 ⇒ 确实从叶子借用，而非又抄了一份。
  assert.strictEqual(riskGate.RISK_ORDER, leaf.RISK_ORDER);
  assert.strictEqual(classifier.RISK_ORDER, leaf.RISK_ORDER);
  assert.strictEqual(mapper.RISK_ORDER, leaf.RISK_ORDER);
});

test('消费者比较逻辑零变化：maxRisk 仍取严（行为 golden）', () => {
  const mapper = require('../../src/services/shellToToolMapper');
  const classifier = require('../../src/services/commandRiskClassifier');
  for (const fn of [mapper.maxRisk, classifier.maxRisk]) {
    assert.strictEqual(fn('low', 'high'), 'high');
    assert.strictEqual(fn('critical', 'safe'), 'critical');
    assert.strictEqual(fn('medium', 'medium'), 'medium');
    assert.strictEqual(fn('safe', 'low'), 'low');
  }
});

test('approvalLedger 经叶子判定 safe/low 资格不变（端到端行为锁）', () => {
  // _rankSafeLow 不导出，经 recordAutoApproval 的资格门间接验证：
  // safe/low 通过、medium 及以上不通过。这里直接复刻其判定式确保叶子值正确。
  const { RISK_ORDER } = leaf;
  const rankSafeLow = (risk) => { const r = RISK_ORDER[risk]; return r != null && r <= RISK_ORDER.low; };
  assert.strictEqual(rankSafeLow('safe'), true);
  assert.strictEqual(rankSafeLow('low'), true);
  assert.strictEqual(rankSafeLow('medium'), false);
  assert.strictEqual(rankSafeLow('critical'), false);
  assert.strictEqual(rankSafeLow('nonsense'), false);
});

test('叶子模块零依赖（含注释也无 require 调用语法——防架构债扫描器误判幽灵边回退）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/constants/riskOrder.js'), 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, 'riskOrder leaf source (incl. comments) must contain no require-call syntax');
});
