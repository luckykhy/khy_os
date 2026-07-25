'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  resultGuardEnabled,
  emptyAfterToolsGuardEnabled,
  progressOnlyGuardEnabled,
  deliveryNudgeForcedForWeakTier,
  looksLikeForwardPromise,
  looksLikeProgressNarration,
  assessClosure,
  shouldAppendDeliverySummary,
  buildClosureNotice,
} = require('./resultGuard');

const ON = {}; // 默认开(无 KHY_RESULT_GUARD)
const OFF = { KHY_RESULT_GUARD: '0' };

// 截图复现的承诺式长前言(字数远超 40/80,正是历史粗代理会误判为「已写结论」的样本)。
const PROMISE = '让我先收集你电脑的硬件和软件现状,再给具体建议。根据你电脑的现状,'
  + '建议从三方面入手:桌面文件较多且杂乱,系统盘存在多个开发项目,正在做量化交易相关研究。';
const PROMISE2 = '先看看你电脑的现状,再给针对性建议。';
const REAL_CONCLUSION = '已完成桌面整理:把 12 个文件按项目归档到三个文件夹,系统盘释放 4GB。总结:无需进一步操作。';

// ── 门控梯 ────────────────────────────────────────────────────────────────────
test('门控:默认开', () => {
  assert.equal(resultGuardEnabled(ON), true);
  assert.equal(resultGuardEnabled({}), true);
});

test('门控:0/false/off/no → 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(resultGuardEnabled({ KHY_RESULT_GUARD: v }), false);
  }
});

test('门控:其他值 → 开', () => {
  assert.equal(resultGuardEnabled({ KHY_RESULT_GUARD: '1' }), true);
  assert.equal(resultGuardEnabled({ KHY_RESULT_GUARD: 'yes' }), true);
});

// ── looksLikeForwardPromise ────────────────────────────────────────────────────
test('forwardPromise:命中「让我先…再给具体建议」长前言', () => {
  assert.equal(looksLikeForwardPromise(PROMISE), true);
});

test('forwardPromise:命中「先看看…再给针对性建议」短前言', () => {
  assert.equal(looksLikeForwardPromise(PROMISE2), true);
});

test('forwardPromise:命中英文 let me first then give recommendations', () => {
  assert.equal(
    looksLikeForwardPromise("Let me first gather your system info, then I'll give you recommendations."),
    true,
  );
});

test('forwardPromise:不误伤真结论(无承诺引导/无延迟交付)', () => {
  assert.equal(looksLikeForwardPromise(REAL_CONCLUSION), false);
});

test('forwardPromise:有承诺引导但无延迟交付名词 → false', () => {
  assert.equal(looksLikeForwardPromise('让我先看看桌面有什么文件。'), false);
});

test('forwardPromise:有延迟交付名词但无承诺引导 → false', () => {
  assert.equal(looksLikeForwardPromise('这是给你的建议,然后请采纳。'), false);
});

test('forwardPromise:防呆 null/undefined/非串/空白', () => {
  assert.equal(looksLikeForwardPromise(null), false);
  assert.equal(looksLikeForwardPromise(undefined), false);
  assert.equal(looksLikeForwardPromise(12345), false);
  assert.equal(looksLikeForwardPromise('   '), false);
});

// ── assessClosure ──────────────────────────────────────────────────────────────
test('assessClosure:执行了工具+承诺无交付 → unfinished', () => {
  const r = assessClosure({ totalToolCalls: 6, hasDeliveredConclusion: false, finalText: PROMISE }, ON);
  assert.equal(r.unfinished, true);
  assert.equal(r.reason, 'promise-without-delivery');
});

test('assessClosure:已交付结论 → 不 unfinished', () => {
  const r = assessClosure({ totalToolCalls: 6, hasDeliveredConclusion: true, finalText: PROMISE }, ON);
  assert.equal(r.unfinished, false);
});

test('assessClosure:没调工具(纯聊天)→ 不 unfinished', () => {
  const r = assessClosure({ totalToolCalls: 0, hasDeliveredConclusion: false, finalText: PROMISE }, ON);
  assert.equal(r.unfinished, false);
});

test('assessClosure:执行了工具但文本是有实质的非承诺结论(>12 字)→ 不 unfinished', () => {
  const r = assessClosure({ totalToolCalls: 3, hasDeliveredConclusion: false, finalText: '我看了一下这几个文件,内容都正常没有问题。' }, ON);
  assert.equal(r.unfinished, false);
});

test('assessClosure:门控关 → 恒 unfinished:false(逐字节回退)', () => {
  const r = assessClosure({ totalToolCalls: 6, hasDeliveredConclusion: false, finalText: PROMISE }, OFF);
  assert.equal(r.unfinished, false);
  assert.equal(r.reason, null);
});

test('assessClosure:防呆缺参/非数 totalToolCalls', () => {
  assert.equal(assessClosure({}, ON).unfinished, false);
  assert.equal(assessClosure({ totalToolCalls: NaN, hasDeliveredConclusion: false, finalText: PROMISE }, ON).unfinished, false);
});

// ── shouldAppendDeliverySummary(替换 >= 40 粗代理)────────────────────────────
test('shouldAppendDeliverySummary:门控关 → 逐字节等价 `< 40`', () => {
  // 去空白后 < 40 → true(应追加摘要);>= 40 → false。
  const short = '已完成。';                         // 去空白 4 字
  const long = '已'.repeat(40);                     // 去空白 40 字
  assert.equal(shouldAppendDeliverySummary({ finalText: short, hasDeliveredConclusion: true }, OFF), true);
  assert.equal(shouldAppendDeliverySummary({ finalText: long, hasDeliveredConclusion: false }, OFF), false);
});

test('shouldAppendDeliverySummary:门控关只看长度,忽略 hasDeliveredConclusion(字节回退)', () => {
  // PROMISE 很长(>=40)→ 门控关恒 false,与历史「长前言被当结论」行为一致。
  assert.equal(shouldAppendDeliverySummary({ finalText: PROMISE, hasDeliveredConclusion: false }, OFF), false);
});

test('shouldAppendDeliverySummary:门控开 → 用真结论判据', () => {
  // 长承诺但未交付结论 → 门控开应追加摘要(true),修正历史漏洞。
  assert.equal(shouldAppendDeliverySummary({ finalText: PROMISE, hasDeliveredConclusion: false }, ON), true);
  // 真交付结论 → 不追加。
  assert.equal(shouldAppendDeliverySummary({ finalText: REAL_CONCLUSION, hasDeliveredConclusion: true }, ON), false);
});

// ── buildClosureNotice ──────────────────────────────────────────────────────────
test('buildClosureNotice:门控关 → 空串(逐字节回退)', () => {
  assert.equal(buildClosureNotice({ totalToolCalls: 6, reason: 'promise-without-delivery' }, OFF), '');
});

test('buildClosureNotice:门控开 → 诚实收尾含次数与继续提示', () => {
  const s = buildClosureNotice({ totalToolCalls: 6, reason: 'promise-without-delivery' }, ON);
  assert.match(s, /未给出最终结论\/建议|尚未给出最终结论/);
  assert.match(s, /6 次工具/);
  assert.match(s, /继续/);
});

test('buildClosureNotice:门控开+无次数 → 不渲染「已执行 N 次」片段', () => {
  const s = buildClosureNotice({ totalToolCalls: 0 }, ON);
  assert.ok(!/次工具/.test(s));
  assert.match(s, /尚未给出最终结论/);
});

// ── 刀4 (a) deliveryNudgeForcedForWeakTier(子门控 KHY_T0_DELIVERY_NUDGE)──────────
test('deliveryNudgeForcedForWeakTier:默认开', () => {
  assert.equal(deliveryNudgeForcedForWeakTier({}), true);
  assert.equal(deliveryNudgeForcedForWeakTier(undefined), true);
});

test('deliveryNudgeForcedForWeakTier:0/false/off/no → 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(deliveryNudgeForcedForWeakTier({ KHY_T0_DELIVERY_NUDGE: v }), false, `value ${v}`);
  }
});

// ── 刀4 (b) emptyAfterToolsGuardEnabled + assessClosure 空文本分支 ───────────────
test('emptyAfterToolsGuardEnabled:默认开;off → 关', () => {
  assert.equal(emptyAfterToolsGuardEnabled({}), true);
  assert.equal(emptyAfterToolsGuardEnabled({ KHY_RESULT_GUARD_EMPTY: 'off' }), false);
});

test('assessClosure:执行了工具+空文本+未交付 → unfinished(empty-after-tools)', () => {
  const r = assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: false, finalText: '' }, ON);
  assert.equal(r.unfinished, true);
  assert.equal(r.reason, 'empty-after-tools');
});

test('assessClosure:执行了工具+极短文本(<=12 去空白)+未交付 → unfinished', () => {
  const r = assessClosure({ totalToolCalls: 2, hasDeliveredConclusion: false, finalText: '  {"x":1}  ' }, ON);
  assert.equal(r.unfinished, true);
  assert.equal(r.reason, 'empty-after-tools');
});

test('assessClosure:执行了工具+稍长文本(>12)+未交付且非承诺 → 不 unfinished', () => {
  const r = assessClosure({ totalToolCalls: 2, hasDeliveredConclusion: false, finalText: '我已经看完了这些文件的内容。' }, ON);
  assert.equal(r.unfinished, false);
});

test('assessClosure:空文本但已交付结论 → 不 unfinished', () => {
  const r = assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: true, finalText: '' }, ON);
  assert.equal(r.unfinished, false);
});

test('assessClosure:空文本但没调工具 → 不 unfinished', () => {
  const r = assessClosure({ totalToolCalls: 0, hasDeliveredConclusion: false, finalText: '' }, ON);
  assert.equal(r.unfinished, false);
});

test('assessClosure:子门控关(KHY_RESULT_GUARD_EMPTY=0)→ 空文本不再 unfinished,承诺式仍判定', () => {
  const subOff = { KHY_RESULT_GUARD_EMPTY: '0' };
  assert.equal(assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: false, finalText: '' }, subOff).unfinished, false);
  // 父门控仍开,承诺式前言照常 unfinished(字节回退仅作用于空文本分支)。
  const r = assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: false, finalText: PROMISE }, subOff);
  assert.equal(r.unfinished, true);
  assert.equal(r.reason, 'promise-without-delivery');
});

test('assessClosure:父门控关 → 空文本也恒 unfinished:false(逐字节回退)', () => {
  assert.equal(assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: false, finalText: '' }, OFF).unfinished, false);
});

test('buildClosureNotice:empty-after-tools → 专属文案(几乎没有文字结论 + 继续提示)', () => {
  const s = buildClosureNotice({ totalToolCalls: 3, reason: 'empty-after-tools' }, ON);
  assert.match(s, /几乎没有给出文字结论|被截断/);
  assert.match(s, /3 次工具/);
  assert.match(s, /继续/);
});

// ── 进度旁白分支(子门控 KHY_RESULT_GUARD_PROGRESS_ONLY)────────────────────────
// 复现截图:grep→read 空转,每轮只留一句「找到 3 处匹配,我逐个核对,先从第一处入手」/
// 「定位相关位置,再往下走」——既非空、也无「再给建议/结论」延迟交付名词,两条旧分支都躲过。
const PROGRESS1 = '找到 3 处匹配,我逐个核对,先从第一处入手。';
const PROGRESS2 = '定位相关位置,再往下走。';
const PROGRESS3 = '看下当前实现,然后再继续排查。';

test('progressOnlyGuardEnabled:默认开;off → 关', () => {
  assert.equal(progressOnlyGuardEnabled({}), true);
  assert.equal(progressOnlyGuardEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(progressOnlyGuardEnabled({ KHY_RESULT_GUARD_PROGRESS_ONLY: v }), false, `value ${v}`);
  }
});

test('looksLikeProgressNarration:命中「找到…逐个核对…先从…入手」纯进度旁白', () => {
  assert.equal(looksLikeProgressNarration(PROGRESS1), true);
  assert.equal(looksLikeProgressNarration(PROGRESS2), true);
  assert.equal(looksLikeProgressNarration(PROGRESS3), true);
});

test('looksLikeProgressNarration:不误伤真结论(有动作动词但无推进标记 / 含结论)', () => {
  assert.equal(looksLikeProgressNarration('我看了这几个文件,内容都正常没有问题。'), false);
  assert.equal(looksLikeProgressNarration(REAL_CONCLUSION), false);
});

test('looksLikeProgressNarration:含代码块 / tool_call / 超长 → false(有实质产物 / 保守)', () => {
  assert.equal(looksLikeProgressNarration('找到问题,先从这里入手\n```js\nconst x=1;\n```'), false);
  assert.equal(looksLikeProgressNarration('找到匹配,逐个核对 <tool_call>{}</tool_call>'), false);
  assert.equal(looksLikeProgressNarration('找到匹配,逐个核对,先从第一处入手。' + '补'.repeat(500)), false);
});

test('looksLikeProgressNarration:防呆 null/undefined/非串/空白', () => {
  assert.equal(looksLikeProgressNarration(null), false);
  assert.equal(looksLikeProgressNarration(undefined), false);
  assert.equal(looksLikeProgressNarration(123), false);
  assert.equal(looksLikeProgressNarration('   '), false);
});

test('assessClosure:执行了工具+纯进度旁白+未交付 → unfinished(progress-only-after-tools)', () => {
  const r = assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: false, finalText: PROGRESS1 }, ON);
  assert.equal(r.unfinished, true);
  assert.equal(r.reason, 'progress-only-after-tools');
});

test('assessClosure:进度旁白但已交付结论 → 不 unfinished', () => {
  const r = assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: true, finalText: PROGRESS1 }, ON);
  assert.equal(r.unfinished, false);
});

test('assessClosure:进度旁白但没调工具 → 不 unfinished', () => {
  const r = assessClosure({ totalToolCalls: 0, hasDeliveredConclusion: false, finalText: PROGRESS1 }, ON);
  assert.equal(r.unfinished, false);
});

test('assessClosure:子门控关(KHY_RESULT_GUARD_PROGRESS_ONLY=0)→ 进度旁白不再 unfinished,承诺/空仍判定', () => {
  const subOff = { KHY_RESULT_GUARD_PROGRESS_ONLY: '0' };
  assert.equal(assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: false, finalText: PROGRESS1 }, subOff).unfinished, false);
  // 父门控仍开:承诺式前言、空文本两条旧分支照常 unfinished(字节回退仅作用于进度旁白分支)。
  assert.equal(assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: false, finalText: PROMISE }, subOff).reason, 'promise-without-delivery');
  assert.equal(assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: false, finalText: '' }, subOff).reason, 'empty-after-tools');
});

test('assessClosure:父门控关 → 进度旁白也恒 unfinished:false(逐字节回退)', () => {
  assert.equal(assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: false, finalText: PROGRESS1 }, OFF).unfinished, false);
});

test('buildClosureNotice:progress-only-after-tools → 专属文案(只报告进度 + 继续给结论提示)', () => {
  const s = buildClosureNotice({ totalToolCalls: 8, reason: 'progress-only-after-tools' }, ON);
  assert.match(s, /只报告了处理进度|宣告了下一步|空转/);
  assert.match(s, /8 次工具/);
  assert.match(s, /继续/);
});
