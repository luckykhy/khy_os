'use strict';

/**
 * mathSolvePolicy + groundTruth 变量感知精确求值 的确定性测试(node:test)。
 *
 * 锁定:
 *  ① 数学题意图识别零假阳性(微积分/方程/方程组/线代命中;纯聊天不命中);
 *  ② 解题指令:命中才产出、带图强化「转写+复述确认+读不出如实说」、含 ```khy-check 模板与诚实边界;
 *  ③ 门控 KHY_MATH_SOLVE 默认开、显式 off 关 → routeMathSolve 空指令 + verifySolution 不复核;
 *  ④ verifySolution:把模型解代回原方程,满足→confirmed、不满足→falsified、无法精确求值→跳过(零假阳性);
 *  ⑤ buildSolutionConfirmation:全满足才出正向注记,有失败/未运行→null;
 *  ⑥ groundTruth.evaluateRational / equalsUnderBindings:变量绑定下精确有理数求值(零浮点)、未绑定 fail。
 */

const test = require('node:test');
const assert = require('node:assert');

const m = require('../src/services/mathSolvePolicy');
const gt = require('../src/services/groundTruth');

const ON = undefined;                       // 默认开
const OFF = { KHY_MATH_SOLVE: 'off' };

// ── ① 意图识别 ───────────────────────────────────────────────────────────────
test('detectMathProblem: 微积分/方程/方程组/线代命中,纯聊天不命中(零假阳性)', () => {
  assert.strictEqual(m.detectMathProblem('求 ∫ x dx').isMath, true);
  assert.strictEqual(m.detectMathProblem('对 x^2 求导数').isMath, true);
  assert.strictEqual(m.detectMathProblem('求极限 lim x->0').isMath, true);
  assert.strictEqual(m.detectMathProblem('解方程组 2x+3y=7, x-y=1').isMath, true);
  assert.strictEqual(m.detectMathProblem('解方程 x^2-5x+6=0').isMath, true);
  assert.strictEqual(m.detectMathProblem('求这个矩阵的行列式').isMath, true);
  assert.strictEqual(m.detectMathProblem('2x+3=7').isMath, true);                 // 裸变量方程
  assert.strictEqual(m.detectMathProblem('计算 3*(4+5)').isMath, true);            // 解题意图 + 算式

  // 负例:不得误判
  assert.strictEqual(m.detectMathProblem('今天天气怎么样').isMath, false);
  assert.strictEqual(m.detectMathProblem('帮我写一个 React 组件').isMath, false);
  assert.strictEqual(m.detectMathProblem('').isMath, false);
  assert.strictEqual(m.detectMathProblem(null).isMath, false);
  // 代码里的 = 不应触发(strip code)
  assert.strictEqual(m.detectMathProblem('看看这段 ```js\nconst a = b + 1\n```').isMath, false);
});

test('detectMathProblem: 题型分类', () => {
  assert.deepStrictEqual(m.detectMathProblem('不定积分 ∫ x dx').kinds, ['calculus']);
  assert.deepStrictEqual(m.detectMathProblem('特征值与特征向量').kinds, ['linear-algebra']);
  assert.ok(m.detectMathProblem('解方程 x+1=2').kinds.includes('equation'));
});

// ── ② 解题指令 ───────────────────────────────────────────────────────────────
test('buildMathSolveDirective: 含分步骤/精确值/自检/khy-check 模板/诚实边界', () => {
  const d = m.buildMathSolveDirective({ kinds: ['equation'], hasImage: false });
  assert.ok(d.includes('[SYSTEM: 数学解题协议]'));
  assert.ok(d.includes('分步骤'));
  assert.ok(d.includes('精确'));
  assert.ok(d.includes('自检'));
  assert.ok(d.includes('```khy-check'));
  assert.ok(d.includes('vars:') && d.includes('eq:'));
  assert.ok(/显式写\s*`?\*`?/.test(d), '应要求乘法显式写 *');
  assert.ok(d.includes('需人工复核'), '应含符号微积分诚实边界');
  // 不带图:不应出现「图片」转写要求
  assert.ok(!d.includes('图片里的题目'));
});

test('buildMathSolveDirective: 带图强化「转写+复述确认+读不出如实说」', () => {
  const d = m.buildMathSolveDirective({ kinds: ['calculus'], hasImage: true });
  assert.ok(d.includes('转写'));
  assert.ok(d.includes('复述'));
  assert.ok(/看不清|读不出/.test(d));
  assert.ok(/绝不臆测|绝不.*编造/.test(d));
});

// ── ③ 门控 ───────────────────────────────────────────────────────────────────
test('isEnabled / routeMathSolve: 默认开,显式 off 关 → 空指令(byte-revert)', () => {
  assert.strictEqual(m.isEnabled(ON), true);
  assert.strictEqual(m.isEnabled({}), true);
  assert.strictEqual(m.isEnabled(OFF), false);
  assert.strictEqual(m.isEnabled({ KHY_MATH_SOLVE: '0' }), false);

  const on = m.routeMathSolve({ text: '解方程 x+1=2' });
  assert.strictEqual(on.isMath, true);
  assert.ok(on.directive.length > 0);

  const off = m.routeMathSolve({ text: '解方程 x+1=2', env: OFF });
  assert.deepStrictEqual(off, { isMath: false, kinds: [], directive: '' });

  // 非数学题 → 空指令
  const chat = m.routeMathSolve({ text: '讲个笑话' });
  assert.deepStrictEqual(chat, { isMath: false, kinds: [], directive: '' });
});

// ── ④ verifySolution:代入复核 ────────────────────────────────────────────────
test('verifySolution: 正确解全部 confirmed,错误解被 falsified', () => {
  const good = '解得 x=2,y=1。\n```khy-check\nvars: x=2, y=1\neq: 2*x + 3*y = 7\neq: x - y = 1\n```';
  const rg = m.verifySolution(good);
  assert.strictEqual(rg.ran, true);
  assert.strictEqual(rg.confirmed.length, 2);
  assert.strictEqual(rg.falsified.length, 0);

  const bad = '解得 x=5。\n```khy-check\nvars: x=5\neq: 2*x + 3 = 7\n```';
  const rb = m.verifySolution(bad);
  assert.strictEqual(rb.ran, true);
  assert.strictEqual(rb.falsified.length, 1);
  assert.strictEqual(rb.falsified[0].lhs, '13');
  assert.strictEqual(rb.falsified[0].rhs, '7');
});

test('verifySolution: 无 khy-check 块 / 无法精确求值 → 不下结论(零假阳性)', () => {
  assert.strictEqual(m.verifySolution('就是普通一段话,没有核验块').ran, false);
  // 含变量未绑定 → 跳过(ok:false),不算 confirmed 也不算 falsified
  const unbound = '```khy-check\nvars: x=1\neq: z + 1 = 2\n```';
  const r = m.verifySolution(unbound);
  assert.strictEqual(r.confirmed.length, 0);
  assert.strictEqual(r.falsified.length, 0);
  // 不等式被忽略(只处理等式)
  const ineq = '```khy-check\nvars: x=1\neq: x < 5\n```';
  assert.strictEqual(m.verifySolution(ineq).ran, false);
});

test('verifySolution: 分数解精确代入(零浮点)', () => {
  const r = m.verifySolution('```khy-check\nvars: x=3/2\neq: 2*x = 3\n```');
  assert.strictEqual(r.confirmed.length, 1);
  assert.strictEqual(r.falsified.length, 0);
});

test('verifySolution: 门控关 → 不复核', () => {
  const good = '```khy-check\nvars: x=2\neq: x = 2\n```';
  assert.strictEqual(m.verifySolution(good, OFF).ran, false);
});

// ── ⑤ buildSolutionConfirmation ──────────────────────────────────────────────
test('buildSolutionConfirmation: 全满足才出正向注记;有失败/未运行 → null', () => {
  const ok = { ran: true, confirmed: [{ eqText: 'x=2' }], falsified: [] };
  assert.ok(/确定性验证为真/.test(m.buildSolutionConfirmation(ok) || ''));
  assert.ok((m.buildSolutionConfirmation(ok) || '').includes(m.SOLUTION_MARKER));

  assert.strictEqual(m.buildSolutionConfirmation({ ran: true, confirmed: [{}], falsified: [{}] }), null);
  assert.strictEqual(m.buildSolutionConfirmation({ ran: false, confirmed: [], falsified: [] }), null);
  assert.strictEqual(m.buildSolutionConfirmation({ ran: true, confirmed: [], falsified: [] }), null);
  assert.strictEqual(m.buildSolutionConfirmation(null), null);
});

// ── ⑥ groundTruth 变量感知精确求值 ───────────────────────────────────────────
test('groundTruth.evaluateRational: 变量绑定下精确求值(零浮点)', () => {
  assert.deepStrictEqual(
    (() => { const r = gt.evaluateRational('2*x + 3*y', { x: 2, y: 1 }); return [r.ok, r.exact]; })(),
    [true, '7'],
  );
  // 0.1 + 0.2 经有理数 → 精确 0.3(用变量承载)
  const r = gt.evaluateRational('a + b', { a: '0.1', b: '0.2' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.exact, '0.3');
  // 分数绑定
  assert.strictEqual(gt.evaluateRational('x*2', { x: '3/2' }).exact, '3');
  // 未绑定变量 → fail
  assert.strictEqual(gt.evaluateRational('z+1', { x: 1 }).ok, false);
  // 非法绑定值 → fail-closed
  assert.strictEqual(gt.evaluateRational('x', { x: 'abc' }).ok, false);
});

test('groundTruth.equalsUnderBindings: 精确相等判定 + 无法求值 ok:false', () => {
  assert.strictEqual(gt.equalsUnderBindings('x^2 - 5*x + 6', '0', { x: 2 }).equal, true);
  assert.strictEqual(gt.equalsUnderBindings('x^2 - 5*x + 6', '0', { x: 3 }).equal, true);
  assert.strictEqual(gt.equalsUnderBindings('x^2 - 5*x + 6', '0', { x: 4 }).equal, false);
  assert.strictEqual(gt.equalsUnderBindings('z', '1', {}).ok, false);
  // 绝不抛
  assert.doesNotThrow(() => gt.equalsUnderBindings(null, undefined, null));
});
