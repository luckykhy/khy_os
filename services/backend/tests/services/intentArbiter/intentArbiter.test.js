'use strict';

/**
 * intentArbiter.test.js — 意图精准裁决子系统测试（[DESIGN-ARCH-041]）。
 *
 * 覆盖 §3.1 光谱解析、§3.2 动态提权、§3.3 分级沙箱、§3.4 误判淬火，以及四条防呆铁律：
 *   ① 绝不单关键词路由（必须综合动词/句式/强调）
 *   ② 歧义带禁止自主猜测执行，必须确认后才放行
 *   ③ 否定/肯定追加反馈 → MisjudgmentQuencher 自动淬火出进化需求
 *   ④ ConfirmSandbox 零副作用、零工具
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

// 进化账本落到隔离临时领地（须在 require 子系统前设好）。
const TMP_HOME = path.join(os.tmpdir(), 'khy-intent-arbiter-test-' + process.pid);
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const {
  IntentArbiter,
  IntentSpectrumAnalyzer,
  TieredResponseRouter,
  MisjudgmentQuencher,
  MISJUDGMENT_KIND,
  BANDS,
} = require('../../../src/services/intentArbiter');
const { ZeroRiskViolationError } = require('../../../src/services/intentArbiter/tieredResponseRouter');

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

let _b = 0;
function freshBranch() { return `intent_test_${process.pid}_${_b++}`; }

// ——————————————————————————————————————————————————————————————
// §3.1 / §3.2 光谱解析 + 动态提权：场景表
// ——————————————————————————————————————————————————————————————
test('§3.1 光谱场景表：自指疑问→安全对话带 ~0.1', () => {
  const a = new IntentSpectrumAnalyzer().analyze('你是什么模型');
  assert.equal(a.band, BANDS.CHAT);
  assert.ok(a.confidence <= 0.2, `期望低置信度，实得 ${a.confidence}`);
});

test('§3.1 光谱场景表：弱动词+目标→歧义模糊带 ~0.5', () => {
  const a = new IntentSpectrumAnalyzer().analyze('看看本地模式');
  assert.equal(a.band, BANDS.CONFIRM);
  assert.ok(a.confidence >= 0.3 && a.confidence < 0.7, `期望落歧义带，实得 ${a.confidence}`);
});

test('§3.1 光谱场景表：特权动词+目标+强调→指令执行带 ≥0.7', () => {
  const a = new IntentSpectrumAnalyzer().analyze('我明确要求进入本地模式');
  assert.equal(a.band, BANDS.EXECUTION);
  assert.ok(a.confidence >= 0.7, `期望跨入执行带，实得 ${a.confidence}`);
  assert.ok(a.features.privilegedVerbs.includes('进入'));
});

test('§3.2 祈使 >> 疑问：同特征疑问句整体衰减', () => {
  const an = new IntentSpectrumAnalyzer();
  const imperative = an.analyze('进入本地模式');
  const question = an.analyze('要进入本地模式吗');
  assert.ok(imperative.confidence > question.confidence,
    `祈使(${imperative.confidence}) 应高于疑问(${question.confidence})`);
});

// ——————————————————————————————————————————————————————————————
// 防呆①：绝不单关键词路由
// ——————————————————————————————————————————————————————————————
test('防呆①：单一目标关键词「本地模式」绝不进入执行带', () => {
  const a = new IntentSpectrumAnalyzer().analyze('本地模式');
  assert.notEqual(a.band, BANDS.EXECUTION);
});

test('防呆①：无特权动词时即便堆叠多关键词也封顶 0.69，绝不放行执行', () => {
  // 弱动词 + 强调 + 目标 + 祈使引导，叠加超 0.69，但缺特权动词 → 必被硬上限钳住。
  const a = new IntentSpectrumAnalyzer().analyze('请看看立刻本地模式');
  assert.equal(a.features.privilegedVerbs.length, 0);
  assert.ok(a.confidence <= 0.69, `应被 NO_VERB_CAP 钳住，实得 ${a.confidence}`);
  assert.notEqual(a.band, BANDS.EXECUTION);
});

// ——————————————————————————————————————————————————————————————
// P0#1 否定降级：否定语境下的特权动词不计入提权
// ——————————————————————————————————————————————————————————————
test('P0#1：「别执行本地模式」否定降级 → 绝不进入执行带', () => {
  const a = new IntentSpectrumAnalyzer().analyze('别执行本地模式');
  assert.notEqual(a.band, BANDS.EXECUTION);
  assert.ok(a.features.negatedVerbs.includes('执行'), '执行 应被识别为否定语境');
  assert.equal(a.features.activeVerbs.length, 0, '无主动特权动词');
});

test('P0#1：「立刻执行本地模式」未否定对照 → 仍进入执行带', () => {
  const a = new IntentSpectrumAnalyzer().analyze('立刻执行本地模式');
  assert.equal(a.band, BANDS.EXECUTION);
  assert.ok(a.features.activeVerbs.includes('执行'));
  assert.equal(a.features.negatedVerbs.length, 0);
});

test('P0#1：后向情态「执行不了这个」 → 陈述句,绝不进入执行带', () => {
  const a = new IntentSpectrumAnalyzer().analyze('执行不了这个');
  assert.notEqual(a.band, BANDS.EXECUTION);
  assert.ok(a.features.negatedVerbs.includes('执行'));
});

test('P0#1 门控关 KHY_INTENT_NEGATION=off → 字节回退（否定动词重新计入）', () => {
  const prev = process.env.KHY_INTENT_NEGATION;
  process.env.KHY_INTENT_NEGATION = 'off';
  try {
    const a = new IntentSpectrumAnalyzer().analyze('别执行本地模式');
    // 回退到旧行为：'执行' 计入提权 → 跨入执行带。
    assert.equal(a.band, BANDS.EXECUTION);
    assert.equal(a.features.negatedVerbs.length, 0);
    assert.ok(a.features.activeVerbs.includes('执行'));
  } finally {
    if (prev === undefined) delete process.env.KHY_INTENT_NEGATION;
    else process.env.KHY_INTENT_NEGATION = prev;
  }
});

// ——————————————————————————————————————————————————————————————
// P0#3 同义词扩充：口语动词识别
// ——————————————————————————————————————————————————————————————
test('P0#3：「跑一下测试」识别为特权动词,脱离闲聊带', () => {
  const a = new IntentSpectrumAnalyzer().analyze('跑一下测试');
  assert.ok(a.features.privilegedVerbs.includes('跑一下'));
  assert.ok(a.features.activeVerbs.includes('跑一下'));
  assert.notEqual(a.band, BANDS.CHAT);
});

test('P0#3：「搞一下」识别为弱动词 → 落歧义带待确认', () => {
  const a = new IntentSpectrumAnalyzer().analyze('搞一下');
  assert.ok(a.features.weakVerbs.includes('搞一下'));
  assert.equal(a.features.privilegedVerbs.length, 0);
  assert.equal(a.band, BANDS.CONFIRM);
});

// ——————————————————————————————————————————————————————————————
// §3.3 分级沙箱 + 防呆④：ConfirmSandbox 零副作用
// ——————————————————————————————————————————————————————————————
test('§3.3 路由三段映射到三沙箱', () => {
  const router = new TieredResponseRouter();
  const an = new IntentSpectrumAnalyzer();
  assert.equal(router.route(an.analyze('你好啊')).sandbox, 'ChatSandbox');
  assert.equal(router.route(an.analyze('看看本地模式')).sandbox, 'ConfirmSandbox');
  assert.equal(router.route(an.analyze('我明确要求进入本地模式')).sandbox, 'ExecutionGateway');
});

test('防呆④：ConfirmSandbox 零副作用、零工具、无下游执行管道', () => {
  const r = new TieredResponseRouter().route(new IntentSpectrumAnalyzer().analyze('看看本地模式'));
  assert.equal(r.sandbox, 'ConfirmSandbox');
  assert.equal(r.sideEffectsAllowed, false);
  assert.equal(r.toolsAllowed, false);
  assert.ok(!('downstream' in r), '确认沙箱绝不携带执行下游');
  assert.ok(typeof r.confirmPrompt === 'string' && r.confirmPrompt.length > 0);
});

test('防呆④：副作用接口渗入确认沙箱即抛 ZeroRiskViolationError', () => {
  const router = new TieredResponseRouter();
  assert.throws(
    () => router.assertZeroRisk({ sandbox: 'ConfirmSandbox', sideEffectsAllowed: true }),
    ZeroRiskViolationError,
  );
  assert.throws(
    () => router.assertZeroRisk({ sandbox: 'ConfirmSandbox', commit: () => {} }),
    /ERR_CONFIRM_SANDBOX_SIDE_EFFECT|零风险/,
  );
});

test('§3.3 ExecutionGateway 放行声明下游主权网关 + 权限审批（[DESIGN-ARCH-040]）', () => {
  const r = new TieredResponseRouter().route(new IntentSpectrumAnalyzer().analyze('立刻执行扫描系统'));
  assert.equal(r.sandbox, 'ExecutionGateway');
  assert.deepEqual(r.downstream, ['data-sovereignty', 'permission-approval']);
});

// ——————————————————————————————————————————————————————————————
// §4 门面编排：dispatch
// ——————————————————————————————————————————————————————————————
test('dispatch：三类输入分流 chat/confirm/execution', () => {
  const arb = new IntentArbiter({ branch: freshBranch() });
  assert.equal(arb.dispatch('你是什么模型').status, 'chat');
  assert.equal(arb.dispatch('看看本地模式').status, 'confirm');
  assert.equal(arb.dispatch('我明确要求进入本地模式').status, 'execution');
});

// ——————————————————————————————————————————————————————————————
// 防呆②：歧义带禁止自主猜测，必须确认后才放行
// ——————————————————————————————————————————————————————————————
test('防呆②：歧义带不自动执行，dispatch 仅产出确认请求', () => {
  const arb = new IntentArbiter({ branch: freshBranch() });
  const d = arb.dispatch('看看本地模式');
  assert.equal(d.status, 'confirm');
  assert.equal(d.route.sideEffectsAllowed, false);
});

test('防呆②：用户显式确认后方才升入执行带放行', () => {
  const arb = new IntentArbiter({ branch: freshBranch() });
  const yes = arb.confirm('看看本地模式', '是');
  assert.equal(yes.status, 'execution');
  assert.equal(yes.route.sandbox, 'ExecutionGateway');
});

test('防呆②：用户否决 → 中止，绝不放行', () => {
  const arb = new IntentArbiter({ branch: freshBranch() });
  assert.equal(arb.confirm('看看本地模式', '不要').status, 'aborted');
});

test('防呆②：答复仍歧义 → 继续要求明确，绝不自主猜测执行', () => {
  const arb = new IntentArbiter({ branch: freshBranch() });
  assert.equal(arb.confirm('看看本地模式', '呃我也不知道').status, 'unclear');
});

// ——————————————————————————————————————————————————————————————
// 防呆③：误判反馈 → 自动淬火出进化需求
// ——————————————————————————————————————————————————————————————
test('防呆③：误触反馈淬火出 L0 调权重需求', () => {
  const q = new MisjudgmentQuencher().quench('我没让你执行，只是在聊天', { originalText: '本地模式', confidence: 0.75 });
  assert.ok(q);
  assert.equal(q.misjudgmentKind, MISJUDGMENT_KIND.FALSE_TRIGGER);
  assert.equal(q.requirement.level, 'L0');
  assert.equal(q.requirement.intentMisjudgment, true);
});

test('防呆③：漏判反馈淬火出 L1 扩充特权动词库需求', () => {
  const q = new MisjudgmentQuencher().quench('我刚才说了帮我执行', { originalText: '搞一下本地模式', confidence: 0.4 });
  assert.ok(q);
  assert.equal(q.misjudgmentKind, MISJUDGMENT_KIND.MISS);
  assert.equal(q.requirement.level, 'L1');
});

test('防呆③：非纠正话语不淬火（返回 no-signal）', () => {
  const arb = new IntentArbiter({ branch: freshBranch() });
  assert.equal(arb.feedback('今天天气不错').status, 'no-signal');
});

test('防呆③：feedback 把淬火需求落入不可变账本', () => {
  const branch = freshBranch();
  const arb = new IntentArbiter({ branch });
  const r = arb.feedback('我没让你执行，只是在聊天', { originalText: '本地模式' });
  assert.equal(r.status, 'quenched');
  const pool = arb.pool();
  assert.equal(pool.length, 1);
  assert.equal(pool[0].payload.source, 'intent-arbiter');
  assert.equal(pool[0].payload.misjudgmentKind, MISJUDGMENT_KIND.FALSE_TRIGGER);
});

// ——————————————————————————————————————————————————————————————
// Phase C-2 第 2 层：确定性历史校准（盲账本被读 → 误触被记住 → 仅向安全侧降级）
// ——————————————————————————————————————————————————————————————
test('历史校准闭环：既往误触纠正落账 → 相似歧义带输入降到 chat', () => {
  const branch = freshBranch();
  const arb = new IntentArbiter({ branch });
  // 基线：无历史时「看看本地模式」落歧义带 confirm。
  assert.equal(arb.dispatch('看看本地模式').status, 'confirm');
  // 用户纠正「我没让你执行」→ 误触(false-trigger)落账,记住原文「看看本地模式」。
  const fb = arb.feedback('我没让你执行', { originalText: '看看本地模式' });
  assert.equal(fb.status, 'quenched');
  assert.equal(fb.misjudgmentKind, MISJUDGMENT_KIND.FALSE_TRIGGER);
  // 同句再来 → 校准命中既往误触 → 压向安全对话带 chat。
  const d = arb.dispatch('看看本地模式');
  assert.equal(d.status, 'chat', '相似误触历史应把歧义带降到 chat');
  assert.equal(d.analysis.calibrated, true);
});

test('历史校准 门控关 KHY_INTENT_CALIBRATION=off → 字节回退(仍 confirm)', () => {
  const prev = process.env.KHY_INTENT_CALIBRATION;
  const branch = freshBranch();
  const arb = new IntentArbiter({ branch });
  arb.feedback('我没让你执行', { originalText: '看看本地模式' });
  process.env.KHY_INTENT_CALIBRATION = 'off';
  try {
    const d = arb.dispatch('看看本地模式');
    assert.equal(d.status, 'confirm', '门控关 → 校准恒等,回到 confirm');
    assert.notEqual(d.analysis.calibrated, true);
  } finally {
    if (prev === undefined) delete process.env.KHY_INTENT_CALIBRATION;
    else process.env.KHY_INTENT_CALIBRATION = prev;
  }
});

test('防呆②：漏判(miss)历史绝不让歧义带升档到 execution', () => {
  const branch = freshBranch();
  const arb = new IntentArbiter({ branch });
  // 漏判纠正落账（miss）。
  const fb = arb.feedback('我刚才说了帮我执行', { originalText: '搞一下本地模式' });
  assert.equal(fb.misjudgmentKind, MISJUDGMENT_KIND.MISS);
  // 同句再来：miss 样本被校准刻意过滤(只消费 false-trigger)→ 绝不升档,仍 confirm。
  const d = arb.dispatch('搞一下本地模式');
  assert.equal(d.status, 'confirm', 'miss 历史不参与自动路由,绝不升执行带');
  assert.notEqual(d.status, 'execution');
});

test('历史校准绝不抬升：明确执行带输入不被任何历史改写', () => {
  const branch = freshBranch();
  const arb = new IntentArbiter({ branch });
  arb.feedback('我没让你执行', { originalText: '我明确要求进入本地模式' });
  // 执行带本就强意图;校准只对 confirm 带生效 → 不插手,仍 execution。
  assert.equal(arb.dispatch('我明确要求进入本地模式').status, 'execution');
});

test('账本哈希链完整可校验', () => {
  const branch = freshBranch();
  const arb = new IntentArbiter({ branch });
  arb.feedback('我没让你执行', { originalText: 'A' });
  arb.feedback('我刚才说了帮我执行', { originalText: 'B' });
  const v = arb.verifyPool();
  assert.equal(v.ok, true);
  assert.equal(v.length, 2);
});

test('classifySignal 三态判别', () => {
  const q = new MisjudgmentQuencher();
  assert.equal(q.classifySignal('我没让你执行'), MISJUDGMENT_KIND.FALSE_TRIGGER);
  assert.equal(q.classifySignal('为什么没反应'), MISJUDGMENT_KIND.MISS);
  assert.equal(q.classifySignal('你好'), null);
});

test('空输入/异常输入安全降级到安全对话带', () => {
  const an = new IntentSpectrumAnalyzer();
  assert.equal(an.analyze('').band, BANDS.CHAT);
  assert.equal(an.analyze(null).band, BANDS.CHAT);
  assert.equal(an.analyze(undefined).band, BANDS.CHAT);
});
