'use strict';

/**
 * planModeSink — behavior lock for the plan-read-only provider sink and the
 * SCC decoupling cut it enables (node:test).
 *
 * The leaf inverts the toolCalling → planModeService edge ([DESIGN-ARCH-051]
 * §6.11): planModeService registers its isPlanReadOnly getter here at load;
 * toolCalling reads the plan-read-only flag through the leaf instead of
 * importing the plan chain. Cutting that single best-effort read-only query
 * edge splits the giant SCC (31 → 29), ejecting planModeService and
 * goalModeService. This suite pins the sink contract, the best-effort absence
 * semantics (false when unregistered = "no active plan"), the live registration
 * round-trip with golden parity against the real state machine, throw
 * suppression, and the no-phantom-edge source guard.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('无 provider → isPlanReadOnly 返回 false（缺省等同“无活动计划、非只读窗口”）', () => {
  const sink = require('../../src/services/planModeSink');
  sink.setPlanReadOnlyProvider(null);          // reset to clean state
  assert.strictEqual(sink.isPlanReadOnly(), false);
});

test('注册 provider 后透传其布尔返回值', () => {
  const sink = require('../../src/services/planModeSink');
  let flag = false;
  sink.setPlanReadOnlyProvider(() => flag);
  assert.strictEqual(sink.isPlanReadOnly(), false);
  flag = true;
  assert.strictEqual(sink.isPlanReadOnly(), true);
  sink.setPlanReadOnlyProvider(null);
});

test('provider 返回非 true 的真值 → 归一化为 false（只认严格 true）', () => {
  const sink = require('../../src/services/planModeSink');
  sink.setPlanReadOnlyProvider(() => 'generating');     // 真值但非 boolean true
  assert.strictEqual(sink.isPlanReadOnly(), false);
  sink.setPlanReadOnlyProvider(null);
});

test('provider 抛错被吞 → false（绝不把 best-effort 读取升级为崩溃）', () => {
  const sink = require('../../src/services/planModeSink');
  sink.setPlanReadOnlyProvider(() => { throw new Error('boom'); });
  assert.strictEqual(sink.isPlanReadOnly(), false);
  sink.setPlanReadOnlyProvider(null);
});

test('传非函数 → 清空 provider', () => {
  const sink = require('../../src/services/planModeSink');
  sink.setPlanReadOnlyProvider(() => true);
  sink.setPlanReadOnlyProvider('not-a-fn');
  assert.strictEqual(sink.isPlanReadOnly(), false);
});

test('per-turn 覆盖:setTurnReadOnly(true) 使 isPlanReadOnly 返 true(即便无 provider)', () => {
  // CC 对齐计划模式:计划轮走真·循环时 planModeService._state 仍是 idle,provider() 读不到
  // 只读窗口。bridge 用本开关在计划轮内强制只读闸生效;finally 清零后回到 provider 语义。
  const sink = require('../../src/services/planModeSink');
  sink.setPlanReadOnlyProvider(null);
  assert.strictEqual(sink.isPlanReadOnly(), false, '默认无 provider、无 per-turn → false');
  sink.setTurnReadOnly(true);
  assert.strictEqual(sink.isPlanReadOnly(), true, 'per-turn 置真 → 只读窗口即生效');
  sink.setTurnReadOnly(false);
  assert.strictEqual(sink.isPlanReadOnly(), false, '清零后回落 provider 语义(此处无 provider)');
});

test('per-turn 覆盖只认严格 true;清零后不影响 provider 真值透传', () => {
  const sink = require('../../src/services/planModeSink');
  sink.setPlanReadOnlyProvider(null);
  sink.setTurnReadOnly('yes');                 // 非严格 true → 归一化为 false
  assert.strictEqual(sink.isPlanReadOnly(), false);
  sink.setTurnReadOnly(1);                      // 非严格 true → false
  assert.strictEqual(sink.isPlanReadOnly(), false);
  // per-turn 关、provider 开 → 仍透传 provider 真值(两来源取或)
  sink.setTurnReadOnly(false);
  sink.setPlanReadOnlyProvider(() => true);
  assert.strictEqual(sink.isPlanReadOnly(), true);
  sink.setPlanReadOnlyProvider(null);
});

test('module.exports 暴露 setTurnReadOnly', () => {
  const sink = require('../../src/services/planModeSink');
  assert.strictEqual(typeof sink.setTurnReadOnly, 'function');
});

test('planModeService 加载即自注册 → 经 sink 读到的标志与真实状态机一致（golden parity）', () => {
  // 加载 planModeService 触发其 setPlanReadOnlyProvider(isPlanReadOnly) 自注册。
  const plan = require('../../src/services/planModeService');
  const sink = require('../../src/services/planModeSink');

  // idle 态（不触发 AI 的确定性路径）：服务与经叶子读取逐字一致为 false。
  plan.reset();
  assert.strictEqual(plan.isPlanReadOnly(), false);
  assert.strictEqual(sink.isPlanReadOnly(), plan.isPlanReadOnly());

  // 自注册的 provider 即服务自身的 isPlanReadOnly：临时改写状态机也应被 sink 透传。
  // 用服务公开的 isPlanReadOnly 作为基准，覆写 provider 验证“只读窗口”真值贯通，
  // 再恢复真实自注册，避免调用会触发 AI 的 enterPlanMode/presentForApproval。
  sink.setPlanReadOnlyProvider(() => true);
  assert.strictEqual(sink.isPlanReadOnly(), true, '只读窗口真值应经叶子透传');
  sink.setPlanReadOnlyProvider(plan.isPlanReadOnly);    // 恢复真实自注册的读取器
  assert.strictEqual(sink.isPlanReadOnly(), plan.isPlanReadOnly());
  assert.strictEqual(sink.isPlanReadOnly(), false);
});

test('toolCalling 不再静态 import planModeService（断边确证，源级守卫）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/toolCalling.js'), 'utf8');
  assert.strictEqual(
    /require\(\s*['"]\.\/planModeService['"]\s*\)/.test(src),
    false,
    'toolCalling 必须经 planModeSink 读取只读标志，不得再 require planModeService',
  );
});

test('叶子零依赖（含注释也无 require 调用语法——防架构债扫描器幽灵边回退）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/planModeSink.js'), 'utf8');
  assert.strictEqual(
    /\brequire\s*\(/.test(src),
    false,
    'planModeSink leaf source (incl. comments) must contain no require-call syntax',
  );
});
