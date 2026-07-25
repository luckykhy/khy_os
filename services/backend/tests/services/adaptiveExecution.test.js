'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const ae = require('../../src/services/adaptiveExecution');

// 工具结果构造助手
const ok = (tool, result = {}) => ({ tool, params: {}, result: { success: true, ...result } });
const fail = (tool, error = '炸了') => ({ tool, params: {}, result: { success: false, error } });

test('1. 门控:off/0/false/no 关闭 assess,默认开', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '我的计划是:先读再改', toolResults: [fail('shell')] });
  // 默认开:偏差应可浮出
  const onRes = ae.assess(st, {});
  assert.strictEqual(onRes.adjust, true);

  for (const v of ['off', '0', 'false', 'no', 'OFF', ' Off ']) {
    const s2 = ae.createState();
    ae.recordStep(s2, { assistantText: '计划:先读再改', toolResults: [fail('shell')] }, { KHY_ADAPTIVE_EXECUTION: v });
    const r = ae.assess(s2, { KHY_ADAPTIVE_EXECUTION: v });
    assert.strictEqual(r.adjust, false, `env=${v} 应关闭`);
    assert.strictEqual(r.directive, null);
  }
});

test('2. 计划捕获:结构化计划措辞命中,casual 提及不命中', () => {
  assert.strictEqual(ae._looksLikePlan('我的计划是:先读 sched.c 再改'), true);
  assert.strictEqual(ae._looksLikePlan('首先读取文件,然后修改函数'), true);
  assert.strictEqual(ae._looksLikePlan('打算分三步完成'), true);
  assert.strictEqual(ae._looksLikePlan('接下来我会先跑测试'), true);
  // casual 不算计划
  assert.strictEqual(ae._looksLikePlan('这个方案挺好的'), false); // 「方案」无后续结构措辞
  assert.strictEqual(ae._looksLikePlan('好的,我来看看'), false);
  assert.strictEqual(ae._looksLikePlan(''), false);
});

test('3. 反思识别(宽松):各类回看/改计划标记命中', () => {
  for (const t of [
    '看来需要换个思路', '这和预期不符,我重新规划一下', '其实应该先复现',
    '调整方案:改用正则', '原计划行不通', '出乎意料,结果为空', '我意识到方向偏了',
    '此路不通,换条路', '发现刚才漏了一步',
  ]) {
    assert.strictEqual(ae._looksReflective(t), true, `应判反思: ${t}`);
  }
  // 普通推进文本不算反思
  assert.strictEqual(ae._looksReflective('好的,我继续读下一个文件'), false);
  assert.strictEqual(ae._looksReflective('修改完成,运行测试'), false);
});

test('4. 偏差触发:工具失败 + 本轮未反思 → 提示', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '我继续按计划改', toolResults: [fail('shell_command', 'command not found')] });
  const r = ae.assess(st, {});
  assert.strictEqual(r.adjust, true);
  assert.match(r.directive, /边做边想/);
  assert.match(r.directive, /不一致|偏离|调整/);
  assert.strictEqual(r.signals[0].type, 'plan-reality-divergence');
});

test('5. 偏差但本轮已反思 → 不打扰(模型自己已在调整)', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '结果为空,看来需要换个思路重新规划', toolResults: [fail('grep')] });
  const r = ae.assess(st, {});
  assert.strictEqual(r.adjust, false, '模型已自发反思,不应再提示');
});

test('6. 显式空结果算偏差(count=0 / 空数组)', () => {
  for (const res of [
    ok('grep', { count: 0 }),
    ok('search', { matches: [] }),
    ok('glob', { results: [] }),
  ]) {
    const st = ae.createState();
    ae.recordStep(st, { assistantText: '继续找', toolResults: [res] });
    const r = ae.assess(st, {});
    assert.strictEqual(r.adjust, true, `应触发偏差: ${JSON.stringify(res.result)}`);
  }
  // 成功且有结果 → 无偏差
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '继续', toolResults: [ok('grep', { count: 3, matches: ['a', 'b', 'c'] })] });
  assert.strictEqual(ae.assess(st, {}).adjust, false);
});

test('7. 僵化连推:有计划后连续 N 步无反思 → 检查点提示', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '我的计划是:逐个文件改', toolResults: [ok('read')] });
  // 默认阈值 5;捕计划那轮也算一步推进(有工具),再推进直到 streak>=5
  for (let i = 0; i < 5; i++) {
    ae.recordStep(st, { assistantText: '继续改下一个', toolResults: [ok('edit')] });
  }
  const r = ae.assess(st, {});
  assert.strictEqual(r.adjust, true);
  assert.ok(r.signals.some((s) => s.type === 'rigid-execution'), '应有 rigid 信号');
});

test('8. 僵化连推被反思打断 → 重新计数,不误报', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '计划:逐个改', toolResults: [ok('read')] });
  for (let i = 0; i < 3; i++) ae.recordStep(st, { assistantText: '继续', toolResults: [ok('edit')] });
  // 中途反思,清零
  ae.recordStep(st, { assistantText: '其实应该先跑测试,调整一下', toolResults: [ok('edit')] });
  assert.strictEqual(st.rigidStreak, 0);
  // 再推进 2 步还不到阈值 → 不触发 rigid
  ae.recordStep(st, { assistantText: '继续', toolResults: [ok('edit')] });
  ae.recordStep(st, { assistantText: '继续', toolResults: [ok('edit')] });
  const r = ae.assess(st, {});
  assert.ok(!r.signals || !r.signals.some((s) => s.type === 'rigid-execution'), 'streak 已清零不应 rigid');
});

test('9. 无计划时不产 rigid(没有计划就谈不上僵化按计划执行)', () => {
  const st = ae.createState();
  for (let i = 0; i < 8; i++) ae.recordStep(st, { assistantText: '继续干', toolResults: [ok('edit')] });
  const r = ae.assess(st, {});
  assert.ok(!r.signals || !r.signals.some((s) => s.type === 'rigid-execution'), '无计划不应 rigid');
});

test('10. episode 去重:偏差连续两轮只提示一次;解除后重新武装', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '继续', toolResults: [fail('shell')] });
  assert.strictEqual(ae.assess(st, {}).adjust, true); // 第一次浮出
  ae.recordStep(st, { assistantText: '继续', toolResults: [fail('shell')] });
  assert.strictEqual(ae.assess(st, {}).adjust, false); // 同条件不重复
  // 一轮正常(无偏差)解除武装
  ae.recordStep(st, { assistantText: '继续', toolResults: [ok('edit')] });
  ae.assess(st, {});
  // 再次偏差 → 可再提示
  ae.recordStep(st, { assistantText: '继续', toolResults: [fail('shell')] });
  assert.strictEqual(ae.assess(st, {}).adjust, true);
});

test('11. 零假阳性:健康任务(有计划、顺利推进、无偏差)默认不打扰', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '我的计划是:读 a.js,改函数,跑测试', toolResults: [ok('read')] });
  ae.recordStep(st, { assistantText: '改好了', toolResults: [ok('edit')] });
  ae.recordStep(st, { assistantText: '跑测试', toolResults: [ok('shell', { count: 1 })] });
  const r = ae.assess(st, {});
  assert.strictEqual(r.adjust, false, '健康短任务零误报');
  assert.strictEqual(ae.hasNudges(st), false);
});

test('12. summarize / hasNudges 契约', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '计划:逐个改', toolResults: [fail('shell')] });
  ae.assess(st, {});
  assert.strictEqual(ae.hasNudges(st), true);
  const s = ae.summarize(st);
  assert.strictEqual(typeof s.iterations, 'number');
  assert.strictEqual(s.planCaptured, true);
  assert.ok(s.nudges.length >= 1);
  assert.ok(s.byType['plan-reality-divergence'] >= 1);
});

test('13. fail-soft:畸形输入绝不抛', () => {
  const st = ae.createState();
  assert.doesNotThrow(() => ae.recordStep(st, { assistantText: null, toolResults: null }));
  assert.doesNotThrow(() => ae.recordStep(st, {}));
  assert.doesNotThrow(() => ae.recordStep(null, {}));
  assert.doesNotThrow(() => ae.recordStep(st, { toolResults: [null, {}, { result: null }] }));
  assert.doesNotThrow(() => ae.assess(null, {}));
  assert.doesNotThrow(() => ae.assess(st, {}));
  assert.doesNotThrow(() => ae.summarize(null));
});

test('14. 阈值可调 KHY_ADAPTIVE_STREAK', () => {
  const env = { KHY_ADAPTIVE_STREAK: '3' };
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '计划:逐个改', toolResults: [ok('edit')] }, env);
  ae.recordStep(st, { assistantText: '继续', toolResults: [ok('edit')] }, env);
  ae.recordStep(st, { assistantText: '继续', toolResults: [ok('edit')] }, env);
  const r = ae.assess(st, env);
  assert.ok(r.signals.some((s) => s.type === 'rigid-execution'), '阈值=3 应更早触发');
});

// ── 做/想交替(goal 续:不能一直想,做与想交替进行)─────────────────────
test('15. 过度反思:连续只想不做 → 反过来提示去执行', () => {
  const st = ae.createState();
  // 只想不做:有反思措辞但无任何工具动作。默认 thinkMax=2。
  ae.recordStep(st, { assistantText: '我再想想,调整一下思路', toolResults: [] });
  ae.recordStep(st, { assistantText: '重新评估一下这个方案', toolResults: [] });
  assert.strictEqual(st.thinkStreak, 2);
  const r = ae.assess(st, {});
  assert.strictEqual(r.adjust, true);
  assert.ok(r.signals.some((s) => s.type === 'over-deliberation'), '应触发 over-deliberation');
  assert.match(r.directive, /动手执行|别陷在|一直想/);
});

test('16. 做打断想:有工具动作则 thinkStreak 清零,不误报过度反思', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '调整一下思路', toolResults: [] });
  ae.recordStep(st, { assistantText: '再调整一下', toolResults: [] });
  assert.strictEqual(st.thinkStreak, 2);
  // 真去做了一步 → 节奏切回「做」
  ae.recordStep(st, { assistantText: '动手改', toolResults: [ok('edit')] });
  assert.strictEqual(st.thinkStreak, 0);
  assert.strictEqual(st.actStreak, 1);
  const r = ae.assess(st, {});
  assert.ok(!r.signals || !r.signals.some((s) => s.type === 'over-deliberation'), '做之后不应再提示去做');
});

test('17. 冷却期内硬信号(工具失败偏差)不被压制', () => {
  const env = { KHY_ADAPTIVE_COOLDOWN: '5', KHY_ADAPTIVE_THINK_MAX: '2' };
  const st = ae.createState();
  // 先靠过度反思发一次软提示,置 lastNudgeAt
  ae.recordStep(st, { assistantText: '调整一下思路', toolResults: [] }, env);
  ae.recordStep(st, { assistantText: '再换个思路', toolResults: [] }, env);
  assert.strictEqual(ae.assess(st, env).adjust, true);
  // 紧接着出现真实偏差(硬信号),仍在冷却窗内 → 必须照样提示
  ae.recordStep(st, { assistantText: '继续往下改', toolResults: [fail('shell_command', 'not found')] }, env);
  const r = ae.assess(st, env);
  assert.strictEqual(r.adjust, true, '硬信号不受冷却压制');
  assert.ok(r.signals.some((s) => s.type === 'plan-reality-divergence'));
});

test('18. 冷却期内软提示被压制(保证做/想交替);cooldown=0 可关闭节流', () => {
  const env = { KHY_ADAPTIVE_COOLDOWN: '10', KHY_ADAPTIVE_THINK_MAX: '2' };
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '调整一下思路', toolResults: [] }, env);
  ae.recordStep(st, { assistantText: '再换个思路', toolResults: [] }, env);
  assert.strictEqual(ae.assess(st, env).adjust, true); // 软提示首发(iter2)
  // 做一步 → 解除 over-deliberation 条件(重新武装)
  ae.recordStep(st, { assistantText: '动手', toolResults: [ok('edit')] }, env);
  ae.assess(st, env);
  // 又开始一直想:本应再触发,但仍在冷却窗内(sinceLast<10)→ 软提示被压住
  ae.recordStep(st, { assistantText: '再调整一下', toolResults: [] }, env);
  ae.recordStep(st, { assistantText: '换个做法', toolResults: [] }, env);
  const suppressed = ae.assess(st, env);
  assert.strictEqual(suppressed.adjust, false, '冷却窗内软提示应被压制,留出「做」的空间');

  // cooldown=0 关闭节流:同样情形立即放行
  const env0 = { KHY_ADAPTIVE_COOLDOWN: '0', KHY_ADAPTIVE_THINK_MAX: '2' };
  const st2 = ae.createState();
  ae.recordStep(st2, { assistantText: '调整一下思路', toolResults: [] }, env0);
  ae.recordStep(st2, { assistantText: '再换个思路', toolResults: [] }, env0);
  ae.assess(st2, env0);
  ae.recordStep(st2, { assistantText: '动手', toolResults: [ok('edit')] }, env0);
  ae.assess(st2, env0);
  ae.recordStep(st2, { assistantText: '再调整一下', toolResults: [] }, env0);
  ae.recordStep(st2, { assistantText: '换个做法', toolResults: [] }, env0);
  const r2 = ae.assess(st2, env0);
  assert.strictEqual(r2.adjust, true, 'cooldown=0 应不节流、立即放行');
});

test('19. 健康任务零误报:做想自然交替不触发任何提示', () => {
  const st = ae.createState();
  ae.recordStep(st, { assistantText: '我的计划是:读、改、测', toolResults: [ok('read')] });
  ae.recordStep(st, { assistantText: '这里和预期不同,调整一下', toolResults: [] }); // 一轮想
  ae.recordStep(st, { assistantText: '按新思路改', toolResults: [ok('edit')] });       // 回到做
  ae.recordStep(st, { assistantText: '跑测试', toolResults: [ok('shell', { count: 1 })] });
  const r = ae.assess(st, {});
  assert.strictEqual(r.adjust, false, '做想自然交替,零误报');
  assert.strictEqual(ae.hasNudges(st), false);
});
