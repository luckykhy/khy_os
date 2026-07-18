'use strict';

/**
 * localBrainCalc — 计算子能力特征化测试（node:test，确定性、可在本环境直接运行）。
 *
 * 背景：原 `localBrainSafeEval.test.js` 是 Jest（describe/expect），本环境无 Jest 运行器，
 * 故无法据其验证抽出重构。本测试以 node:test 复刻并扩展安全求值断言，锁定从
 * localBrainService.js 抽出后的**行为不变**（[DESIGN-ARCH-051] 降巨石）。同时验证
 * localBrainService 经 calcService 转发的对外导出契约不变。
 */

const test = require('node:test');
const assert = require('node:assert');

const calc = require('../../src/services/localBrainCalc');
const brain = require('../../src/services/localBrainService');

test('安全求值：四则/取模/幂/括号/一元正负', () => {
  assert.strictEqual(calc.safeEvalArithmetic('1 + 2 * 3'), 7);
  assert.strictEqual(calc.safeEvalArithmetic('(1 + 2) * 3'), 9);
  assert.strictEqual(calc.safeEvalArithmetic('2 ** 3 ** 2'), 512); // 右结合
  assert.strictEqual(calc.safeEvalArithmetic('10 % 3'), 1);
  assert.strictEqual(calc.safeEvalArithmetic('-3 + 5'), 2);
  assert.strictEqual(calc.safeEvalArithmetic('3.5 * 2'), 7);
});

test('安全求值：白名单函数与常量', () => {
  assert.strictEqual(calc.safeEvalArithmetic('Math.pow(2,10)'), 1024);
  assert.strictEqual(calc.safeEvalArithmetic('Math.sqrt(144)'), 12);
  assert.ok(Math.abs(calc.safeEvalArithmetic('Math.PI') - Math.PI) < 1e-9);
});

test('安全求值：拒绝标识符/动态代码注入（new Function 已根除）', () => {
  for (const evil of ['constructor', 'this', 'global.process', '(function(){return 1})()',
    "require('fs')", '1;process.exit(1)', 'Math.constructor', 'Math.max(1,2)']) {
    assert.throws(() => calc.safeEvalArithmetic(evil), undefined, `应拒绝：${evil}`);
  }
});

test('_executeCalc 返回契约：合法/非法/除零', () => {
  assert.deepStrictEqual(
    { type: calc.executeCalc({ expr: '2 + 2', label: '2 + 2' }).type, success: calc.executeCalc({ expr: '2 + 2', label: '2 + 2' }).success, result: calc.executeCalc({ expr: '2 + 2', label: '2 + 2' }).result },
    { type: 'calc', success: true, result: 4 });
  assert.strictEqual(calc.executeCalc({ expr: 'process.exit(1)', label: 'x' }).success, false);
  assert.strictEqual(calc.executeCalc({ expr: '1 / 0', label: '1/0' }).success, false); // Infinity 视为无效
});

test('意图识别 + 检测 + 格式化（中文数学归一）', () => {
  assert.strictEqual(calc.isCalcIntent('1 + 2 * 3'), true);
  assert.strictEqual(calc.isCalcIntent('计算 10 % 3'), true);
  assert.strictEqual(calc.isCalcIntent('今天天气怎么样'), false);
  const plan = calc.detectCalc('计算 3 的 4 次方');
  assert.strictEqual(plan.type, 'calc');
  assert.match(plan.expr, /Math\.pow\(3,4\)/);
  assert.strictEqual(calc.executeCalc(plan).result, 81);
  assert.strictEqual(calc.formatCalc({ success: true, expr: '2+2', result: 4 }), '2+2 = 4');
  assert.match(calc.formatCalc({ success: false, error: 'x' }), /计算失败/);
});

test('localBrainService 对外契约不变：经 calcService 转发导出', () => {
  assert.strictEqual(typeof brain._safeEvalArithmetic, 'function');
  assert.strictEqual(brain._safeEvalArithmetic('6 * 7'), 42);
  assert.strictEqual(brain._executeCalc({ expr: '2 ** 5', label: '2^5' }).result, 32);
});

test('端到端：detectDeterministic → execute → format 仍走 calc 路径', () => {
  const plan = brain.detectDeterministic('1 + 2 * 3', {});
  assert.ok(plan && plan.type === 'calc');
  const r = brain.executeDeterministic(plan, {});
  assert.strictEqual(brain.formatDeterministicResult(r), '1 + 2 * 3 = 7');
});
