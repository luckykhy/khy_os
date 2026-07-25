'use strict';

/**
 * preferenceSignals.test.js — 「太懂我了」响应风格纠偏检测器纯模块单测。
 *
 * 守护:
 *  - 五类信号(too_long/too_short/skipped_plan/liked_plan/skipped_tip)各自命中。
 *  - 优先级:too_long 在 too_short 之前 → "太详细了"(想更短)压过 "详细" 子串。
 *  - 零假阳性:任务交付物里的 "简短/详细"(如「写个简短的报告」)绝不误判成纠偏。
 *  - meta-marker(回复/你/上面…)让较长的反馈句也能被识别。
 *  - 学习→应用闭环:recordResponseFeedback → getHabitContext 真往返(隔离 HOME)。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectPreferenceSignal } = require('../../src/services/preferenceSignals');

describe('detectPreferenceSignal — 信号分类', () => {
  test('too_long:简短/啰嗦/说重点/太详细', () => {
    for (const t of ['太长了', '太啰嗦了', '说重点', '精简一点', '太详细了', 'too long', 'be concise']) {
      assert.equal(detectPreferenceSignal(t), 'too_long', t);
    }
  });

  test('too_short:详细点/展开/具体点/深入', () => {
    for (const t of ['详细点', '展开说说', '具体点', '深入一点', 'more detail', 'elaborate']) {
      assert.equal(detectPreferenceSignal(t), 'too_short', t);
    }
  });

  test('skipped_plan:直接做/别给计划', () => {
    for (const t of ['直接做', '别给计划', '直接执行', 'just do it', 'skip the plan']) {
      assert.equal(detectPreferenceSignal(t), 'skipped_plan', t);
    }
  });

  test('liked_plan:先给计划/先出方案', () => {
    for (const t of ['先给计划', '先出方案', '先别动手', 'plan first']) {
      assert.equal(detectPreferenceSignal(t), 'liked_plan', t);
    }
  });

  test('skipped_tip:别给提示', () => {
    for (const t of ['别给提示', '不用小贴士', 'no tips']) {
      assert.equal(detectPreferenceSignal(t), 'skipped_tip', t);
    }
  });

  test('too_much_code:别贴代码/只说思路', () => {
    for (const t of ['别贴大段代码', '只说思路', '少贴代码', 'no code', 'just explain']) {
      assert.equal(detectPreferenceSignal(t), 'too_much_code', t);
    }
  });

  test('wants_code:上代码/直接给代码', () => {
    for (const t of ['直接上代码', '给我代码', '别光说思路', 'show me the code']) {
      assert.equal(detectPreferenceSignal(t), 'wants_code', t);
    }
  });
});

describe('detectPreferenceSignal — 优先级与歧义', () => {
  test('"太详细了" 想更短 → too_long(压过 too_short 的 "详细" 子串)', () => {
    assert.equal(detectPreferenceSignal('太详细了'), 'too_long');
  });

  test('"详细点" 想更多 → too_short(无 too_long 触发词)', () => {
    assert.equal(detectPreferenceSignal('详细点'), 'too_short');
  });
});

describe('detectPreferenceSignal — 零假阳性(交付物 vs 反馈)', () => {
  test('长任务请求里的 "简短" 描述交付物 → null', () => {
    assert.equal(
      detectPreferenceSignal('帮我写个简短的报告介绍一下这个项目的背景和目标'),
      null,
    );
  });

  test('长任务请求里的 "详细" 描述交付物 → null', () => {
    assert.equal(
      detectPreferenceSignal('请详细分析一下这只股票的基本面和技术面走势给出买卖建议'),
      null,
    );
  });

  test('"帮我写...代码..." 是任务而非纠偏 → null', () => {
    assert.equal(
      detectPreferenceSignal('帮我写一段快速排序的代码并加上注释和测试用例'),
      null,
    );
  });

  test('中性问题 / 空 / 非串 → null', () => {
    assert.equal(detectPreferenceSignal('今天天气怎么样'), null);
    assert.equal(detectPreferenceSignal(''), null);
    assert.equal(detectPreferenceSignal('   '), null);
    assert.equal(detectPreferenceSignal(null), null);
    assert.equal(detectPreferenceSignal(undefined), null);
    assert.equal(detectPreferenceSignal(42), null);
  });
});

describe('_classifyTopic — 通用领域(不再只懂量化)', () => {
  const { _classifyTopic } = require('../../src/services/usageHabitService');

  test('通用开发/OS/写作/检索域命中', () => {
    assert.equal(_classifyTopic('帮我看下这个报错怎么调试'), 'debugging');
    assert.equal(_classifyTopic('写个排序函数'), 'coding');
    assert.equal(_classifyTopic('帮我部署到docker'), 'devops');
    assert.equal(_classifyTopic('搜一下最新的新闻'), 'research_search');
    assert.equal(_classifyTopic('给这段内核进程调度加个文档'), 'system_os');
  });

  test('遗留量化域仍向后兼容', () => {
    assert.equal(_classifyTopic('跑个回测策略'), 'backtesting');
    assert.equal(_classifyTopic('看下这只票的风险止损'), 'risk_management');
  });

  test('无关内容 / 空 → null', () => {
    assert.equal(_classifyTopic('今天天气'), null);
    assert.equal(_classifyTopic(''), null);
    assert.equal(_classifyTopic(null), null);
  });
});

describe('describeResponseStyle — 自然语言透明面（懂我）', () => {
  const { describeResponseStyle } = require('../../src/services/usageHabitService');

  test('未学到任何偏离默认的偏好 → 空数组（调用方渲染"还在观察"）', () => {
    assert.deepEqual(
      describeResponseStyle({ preferredLength: 'medium', detailLevel: 'balanced', codeInResponse: true, planBeforeAction: null, showCost: true, showTips: true }),
      [],
    );
    assert.deepEqual(describeResponseStyle(undefined), []);
    assert.deepEqual(describeResponseStyle(null), []);
  });

  test('学到的偏好用自然语言列出，且只说真正学到的(非默认)', () => {
    const lines = describeResponseStyle({
      preferredLength: 'short',
      planBeforeAction: false,
      codeInResponse: false,
      showTips: false,
      showCost: true, // 默认 → 不出现
    });
    assert.ok(lines.some((l) => /简短/.test(l)), '应说简短');
    assert.ok(lines.some((l) => /直接行动/.test(l)), '应说直接行动');
    assert.ok(lines.some((l) => /少贴大段代码/.test(l)), '应说少贴代码');
    assert.ok(lines.some((l) => /知识小贴士/.test(l)), '应说关掉贴士');
    assert.ok(!lines.some((l) => /费用/.test(l)), 'showCost 默认 true 不应出现');
  });

  test('codeInResponse 默认 true 不渲染(避免噪音)；长度 long 渲染详细', () => {
    const lines = describeResponseStyle({ preferredLength: 'long', codeInResponse: true, planBeforeAction: true });
    assert.ok(lines.some((l) => /详细/.test(l)));
    assert.ok(lines.some((l) => /先给计划/.test(l)));
    assert.ok(!lines.some((l) => /代码/.test(l)), 'codeInResponse=true 默认态不出代码行');
  });
});

describe('detectPreferenceSignal — meta-marker 放宽长度', () => {
  test('较长但引用回复("你这次回答太啰嗦了")→ too_long', () => {
    assert.equal(detectPreferenceSignal('你这次回答太啰嗦了，下次注意一下行不行'), 'too_long');
  });

  test('引用 + 太简略 + 详细点 → too_short', () => {
    assert.equal(detectPreferenceSignal('你上面说得太简略了，详细点'), 'too_short');
  });

  test('无 meta-marker 的长句即使含触发词也保守返回 null', () => {
    // 26+ 字、无 "回复/你/上面" 等引用 → 视为任务而非反馈。
    assert.equal(
      detectPreferenceSignal('我需要一份非常详细的市场调研文档涵盖竞品分析用户画像和增长策略'),
      null,
    );
  });
});

describe('学习→应用闭环 — recordResponseFeedback → getHabitContext', () => {
  let tmpHome;
  let realHome;
  let habits;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-habits-'));
    realHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // usageHabitService 在 require 时即以 os.homedir() 锁定路径,故须在改 HOME 后再加载。
    delete require.cache[require.resolve('../../src/services/usageHabitService')];
    habits = require('../../src/services/usageHabitService');
  });

  after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    delete require.cache[require.resolve('../../src/services/usageHabitService')];
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('初始无偏好 → 空上下文', () => {
    assert.equal(habits.getHabitContext(), '');
  });

  test('"太长了" → 学到简短 → 同一会话即可应用', () => {
    const sig = detectPreferenceSignal('太长了');
    assert.equal(sig, 'too_long');
    habits.recordResponseFeedback(sig);
    assert.match(habits.getHabitContext(), /用户偏好简短回复/);
  });

  test('叠加 "直接做，别给计划" → 同时带简短 + 直接行动', () => {
    habits.recordResponseFeedback(detectPreferenceSignal('直接做，别给计划'));
    const ctx = habits.getHabitContext();
    assert.match(ctx, /用户偏好简短回复/);
    assert.match(ctx, /用户更喜欢直接行动/);
  });

  test('偏好可逆转:"详细点" 覆盖回详细', () => {
    habits.recordResponseFeedback(detectPreferenceSignal('你回答太简略了，详细点'));
    const ctx = habits.getHabitContext();
    assert.match(ctx, /用户喜欢详细回复/);
    assert.doesNotMatch(ctx, /用户偏好简短回复/);
  });

  test('代码偏好:"别贴大段代码" → 注入少贴代码提示;默认(true)不出提示', () => {
    // 默认 codeInResponse=true 时,getHabitContext 保持沉默(无噪音)。
    assert.doesNotMatch(habits.getHabitContext(), /少贴大段代码/);
    habits.recordResponseFeedback(detectPreferenceSignal('别贴大段代码，说思路就行'));
    assert.match(habits.getHabitContext(), /少贴大段代码/);
    // 逆转回想要代码 → 提示消失。
    habits.recordResponseFeedback(detectPreferenceSignal('直接上代码'));
    assert.doesNotMatch(habits.getHabitContext(), /少贴大段代码/);
  });
});
