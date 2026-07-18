'use strict';

/**
 * followThroughGuard.test.js — 纯叶子契约([修复智能体纪律])。
 *
 * 覆盖:
 *  - 门控(flagRegistry-first + 本地 CANON 回退,parent=KHY_WEAK_MODEL_GUIDANCE);
 *  - 触发条件闸(仅动作任务 + 零工具调用 + 非实质交付 + 非空回复);
 *  - 两模式识别:虚构阻碍(fabricated-blocker,含中英)优先于空头承诺(bare-commitment);
 *  - 反例:合法长交付 / 纯 Q&A 叙述 / 过去时「已修改」/ 向用户提问的空头承诺被抑制;
 *  - fabricated-blocker 不因问句被抑制(「指令似乎被截断了,能否重发?」正是该 bug);
 *  - buildFollowThroughNudge 产出 [SYSTEM] 指令 & 未知 pattern 返 '';
 *  - 门关 → assessFollowThrough 恒 null(逐字节回退);
 *  - 垃圾 / 异常输入 fail-soft 返 null,绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/followThroughGuard'));

// happy-path 上下文工厂:动作任务、零工具调用、非实质交付。
function ctx(reply, over) {
  return Object.assign({
    reply,
    toolCallCount: 0,
    isActionTask: true,
    substantiveDelivery: false,
  }, over || {});
}

test('gate: default ON; CANON off-words disable; other truthy → ON', () => {
  assert.strictEqual(leaf.isFollowThroughGuardEnabled({}), true);
  assert.strictEqual(leaf.isFollowThroughGuardEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.isFollowThroughGuardEnabled({ KHY_FOLLOW_THROUGH_GUARD: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.isFollowThroughGuardEnabled({ KHY_FOLLOW_THROUGH_GUARD: 'yes' }), true);
  assert.strictEqual(leaf.isFollowThroughGuardEnabled({ KHY_FOLLOW_THROUGH_GUARD: '1' }), true);
});

test('gate: parent KHY_WEAK_MODEL_GUIDANCE off → child off (byte-revert)', () => {
  // parent off must force this guard off regardless of own value.
  assert.strictEqual(
    leaf.isFollowThroughGuardEnabled({ KHY_WEAK_MODEL_GUIDANCE: 'off' }), false);
  assert.strictEqual(
    leaf.assessFollowThrough(ctx('你的指令被截断了,我无法继续。'), { KHY_WEAK_MODEL_GUIDANCE: 'off' }),
    null);
});

test('fabricated-blocker: Chinese "指令被截断/无法继续" → nudge', () => {
  const r = leaf.assessFollowThrough(ctx('你的指令似乎被截断了,我无法继续这次编辑。'), {});
  assert.ok(r && r.shouldNudge);
  assert.strictEqual(r.pattern, 'fabricated-blocker');
  assert.ok(typeof r.marker === 'string' && r.marker.length > 0);
});

test('fabricated-blocker: English "instruction was truncated / cannot proceed" → nudge', () => {
  const r1 = leaf.assessFollowThrough(ctx('The instruction appears to be truncated, so I cannot proceed.'), {});
  assert.ok(r1 && r1.pattern === 'fabricated-blocker');
  const r2 = leaf.assessFollowThrough(ctx('The file content seems incomplete; unable to complete the edit.'), {});
  assert.ok(r2 && r2.pattern === 'fabricated-blocker');
});

test('fabricated-blocker fires even when phrased as a question (the exact khy bug)', () => {
  // "指令似乎被截断了,能否重新发送?" — must NOT be suppressed; should verify with a Read first.
  const r = leaf.assessFollowThrough(ctx('你的指令似乎被截断了,能否重新发送完整内容?'), {});
  assert.ok(r && r.pattern === 'fabricated-blocker');
});

test('bare-commitment: Chinese "我将编辑 / 让我修改" with zero tool calls → nudge', () => {
  const r1 = leaf.assessFollowThrough(ctx('好的,接下来我会修改这个函数以修复该问题。'), {});
  assert.ok(r1 && r1.pattern === 'bare-commitment');
  const r2 = leaf.assessFollowThrough(ctx('让我来编辑 config.js 添加这个开关。'), {});
  assert.ok(r2 && r2.pattern === 'bare-commitment');
});

test('bare-commitment: English "I\'ll now edit / let me run" → nudge', () => {
  const r1 = leaf.assessFollowThrough(ctx("Sure, I'll now edit the router to add the route."), {});
  assert.ok(r1 && r1.pattern === 'bare-commitment');
  const r2 = leaf.assessFollowThrough(ctx('Let me run the tests to confirm the fix.'), {});
  assert.ok(r2 && r2.pattern === 'bare-commitment');
});

test('fabricated-blocker takes priority over bare-commitment when both present', () => {
  const r = leaf.assessFollowThrough(
    ctx('我将编辑该文件,但你的指令似乎被截断了,我无法继续。'), {});
  assert.ok(r && r.pattern === 'fabricated-blocker');
});

test('bare-commitment suppressed when the model is asking the user (waiting, not abandoning)', () => {
  // Commitment gated on user confirmation is legitimate.
  assert.strictEqual(
    leaf.assessFollowThrough(ctx('我可以帮你编辑这个文件,你希望我改哪一部分?'), {}),
    null);
  assert.strictEqual(
    leaf.assessFollowThrough(ctx("I'll edit it — would you like me to update the header too?"), {}),
    null);
});

test('negative: substantive long delivery → null (not nagged)', () => {
  const long = '我已经完成了修改。' + '这是详细的实现说明:'.repeat(40);
  assert.strictEqual(leaf.assessFollowThrough(ctx(long, { substantiveDelivery: true }), {}), null);
});

test('negative: past-tense "我已经修改 / I edited" is not a bare commitment', () => {
  assert.strictEqual(leaf.assessFollowThrough(ctx('我已经修改了该文件并验证通过。'), {}), null);
  assert.strictEqual(leaf.assessFollowThrough(ctx('I edited the router and the tests pass.'), {}), null);
});

test('negative: pure narrative verbs (总结/解释/summarize) do not match commitment', () => {
  assert.strictEqual(leaf.assessFollowThrough(ctx('让我来总结一下刚才的分析结论。'), {}), null);
  assert.strictEqual(leaf.assessFollowThrough(ctx("Let me explain why this approach is better."), {}), null);
});

test('gate: non-action task / has tool calls / empty reply → null', () => {
  assert.strictEqual(leaf.assessFollowThrough(ctx('你的指令被截断了', { isActionTask: false }), {}), null);
  assert.strictEqual(leaf.assessFollowThrough(ctx('你的指令被截断了', { toolCallCount: 1 }), {}), null);
  assert.strictEqual(leaf.assessFollowThrough(ctx('   '), {}), null);
});

test('OFF: gate off → null even on a clear fabricated-blocker (byte-revert)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.assessFollowThrough(ctx('你的指令被截断了,我无法继续。'), { KHY_FOLLOW_THROUGH_GUARD: off }),
      null, `off=${off}`);
  }
});

test('buildFollowThroughNudge: emits [SYSTEM] directive for known patterns; "" for unknown', () => {
  const a = leaf.buildFollowThroughNudge('fabricated-blocker');
  const b = leaf.buildFollowThroughNudge('bare-commitment');
  assert.ok(a.includes('[SYSTEM') && /证据|工具/.test(a));
  assert.ok(b.includes('[SYSTEM') && /承诺不等于执行|工具调用/.test(b));
  assert.strictEqual(leaf.buildFollowThroughNudge('nope'), '');
  assert.strictEqual(leaf.buildFollowThroughNudge(undefined), '');
});

test('fail-soft: garbage / throwing input → null, never throws', () => {
  assert.strictEqual(leaf.assessFollowThrough(null, {}), null);
  assert.strictEqual(leaf.assessFollowThrough(undefined, {}), null);
  assert.strictEqual(leaf.assessFollowThrough(42, {}), null);
  assert.strictEqual(leaf.assessFollowThrough(ctx({ not: 'a string' }), {}), null);
});
