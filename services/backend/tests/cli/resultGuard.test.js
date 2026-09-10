'use strict';
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
const ON = {}; // 默认开(�?KHY_RESULT_GUARD)
const OFF = { KHY_RESULT_GUARD: '0' };
// 截图复现的承诺式长前言(字数远超 40/80,正是历史粗代理会误判为「已写结论」的样本)�?const PROMISE =
  '让我先收集你电脑的硬件和软件现状,再给具体建议。根据你电脑的现�?' +
  '建议从三方面入手:桌面文件较多且杂�?系统盘存在多个开发项�?正在做量化交易相关研究�?;
const PROMISE2 = '先看看你电脑的现�?再给针对性建议�?;
const REAL_CONCLUSION =
  '已完成桌面整�?�?12 个文件按项目归档到三个文件夹,系统盘释�?4GB。总结:无需进一步操作�?;
// ── 门控�?────────────────────────────────────────────────────────────────────
// ── looksLikeForwardPromise ────────────────────────────────────────────────────
// ── assessClosure ──────────────────────────────────────────────────────────────
// ── shouldAppendDeliverySummary(替换 >= 40 粗代�?────────────────────────────
describe('Result Guard', () => {
  test('shouldAppendDeliverySummary:门控�?�?逐字节等�?`< 40`', () => {
    // 去空白后 < 40 �?true(应追加摘�?;>= 40 �?false�?    const short = '已完成�?; // 去空�?4 �?    const long = '�?.repeat(40); // 去空�?40 �?    assert.equal(
      shouldAppendDeliverySummary({ finalText: short, hasDeliveredConclusion: true }, OFF),
      true
    );
    assert.equal(
      shouldAppendDeliverySummary({ finalText: long, hasDeliveredConclusion: false }, OFF),
      false
    );
  });
  // ── buildClosureNotice ──────────────────────────────────────────────────────────
  // ── 刀4 (a) deliveryNudgeForcedForWeakTier(子门�?KHY_T0_DELIVERY_NUDGE)──────────
  // ── 刀4 (b) emptyAfterToolsGuardEnabled + assessClosure 空文本分�?───────────────
  // ── 进度旁白分支(子门�?KHY_RESULT_GUARD_PROGRESS_ONLY)────────────────────────
  // 复现截图:grep→read 空转,每轮只留一句「找�?3 处匹�?我逐个核对,先从第一处入手�?
  // 「定位相关位�?再往下走」——既非空、也无「再给建�?结论」延迟交付名�?两条旧分支都躲过�?  const PROGRESS1 = '找到 3 处匹�?我逐个核对,先从第一处入手�?;
  const PROGRESS2 = '定位相关位置,再往下走�?;
  const PROGRESS3 = '看下当前实现,然后再继续排查�?;
  
  test('门控:默认开', () => {
      expect(resultGuardEnabled(ON)).toBe(true);
      expect(resultGuardEnabled({})).toBe(true);
  });

  test('门控:0/false/off/no �?�?, () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(resultGuardEnabled({ KHY_RESULT_GUARD: v })).toBe(false);
      }
  });

  test('门控:其他�?�?开', () => {
      expect(resultGuardEnabled({ KHY_RESULT_GUARD: '1' })).toBe(true);
      expect(resultGuardEnabled({ KHY_RESULT_GUARD: 'yes' })).toBe(true);
  });

  test('forwardPromise:命中「让我先…再给具体建议」长前言', () => {
      expect(looksLikeForwardPromise(PROMISE)).toBe(true);
  });

  test('forwardPromise:命中「先看看…再给针对性建议」短前言', () => {
      expect(looksLikeForwardPromise(PROMISE2)).toBe(true);
  });

  test('forwardPromise:命中英文 let me first then give recommendations', () => {
      assert.equal(
        looksLikeForwardPromise(
          "Let me first gather your system info, then I'll give you recommendations."
        ),
        true
      );
  });

  test('forwardPromise:不误伤真结论(无承诺引�?无延迟交�?', () => {
      expect(looksLikeForwardPromise(REAL_CONCLUSION)).toBe(false);
  });

  test('forwardPromise:有承诺引导但无延迟交付名�?�?false', () => {
      expect(looksLikeForwardPromise('让我先看看桌面有什么文件�?)).toBe(false);
  });

  test('forwardPromise:有延迟交付名词但无承诺引�?�?false', () => {
      expect(looksLikeForwardPromise('这是给你的建�?).toBe(然后请采纳�?);
  });

  test('forwardPromise:防呆 null/undefined/非串/空白', () => {
      expect(looksLikeForwardPromise(null)).toBe(false);
      expect(looksLikeForwardPromise(undefined)).toBe(false);
      expect(looksLikeForwardPromise(12345)).toBe(false);
      expect(looksLikeForwardPromise('   ')).toBe(false);
  });

  test('assessClosure:执行了工�?承诺无交�?�?unfinished', () => {
      const r = assessClosure(
        { totalToolCalls: 6, hasDeliveredConclusion: false, finalText: PROMISE },
        ON
      );
      expect(r.unfinished).toBe(true);
      expect(r.reason).toBe('promise-without-delivery');
  });

  test('assessClosure:已交付结�?�?�?unfinished', () => {
      const r = assessClosure(
        { totalToolCalls: 6, hasDeliveredConclusion: true, finalText: PROMISE },
        ON
      );
      expect(r.unfinished).toBe(false);
  });

  test('assessClosure:没调工具(纯聊�?�?�?unfinished', () => {
      const r = assessClosure(
        { totalToolCalls: 0, hasDeliveredConclusion: false, finalText: PROMISE },
        ON
      );
      expect(r.unfinished).toBe(false);
  });

  test('assessClosure:执行了工具但文本是有实质的非承诺结论(>12 �?�?�?unfinished', () => {
      const r = assessClosure(
        {
          totalToolCalls: 3,
          hasDeliveredConclusion: false,
          finalText: '我看了一下这几个文件,内容都正常没有问题�?,
        },
        ON
      );
      expect(r.unfinished).toBe(false);
  });

  test('assessClosure:门控�?�?�?unfinished:false(逐字节回退)', () => {
      const r = assessClosure(
        { totalToolCalls: 6, hasDeliveredConclusion: false, finalText: PROMISE },
        OFF
      );
      expect(r.unfinished).toBe(false);
      expect(r.reason).toBe(null);
  });

  test('assessClosure:防呆缺参/非数 totalToolCalls', () => {
      expect(assessClosure({}).toBe(ON).unfinished, false);
      assert.equal(
        assessClosure({ totalToolCalls: NaN, hasDeliveredConclusion: false, finalText: PROMISE }, ON)
          .unfinished,
        false
      );
  });

  test('shouldAppendDeliverySummary:门控关只看长�?忽略 hasDeliveredConclusion(字节回退)', () => {
      // PROMISE 很长(>=40)�?门控关恒 false,与历史「长前言被当结论」行为一致�?      assert.equal(
        shouldAppendDeliverySummary({ finalText: PROMISE, hasDeliveredConclusion: false }, OFF),
        false
      );
  });

  test('shouldAppendDeliverySummary:门控开 �?用真结论判据', () => {
      // 长承诺但未交付结�?�?门控开应追加摘�?true),修正历史漏洞�?      assert.equal(
        shouldAppendDeliverySummary({ finalText: PROMISE, hasDeliveredConclusion: false }, ON),
        true
      );
      // 真交付结�?�?不追加�?      assert.equal(
        shouldAppendDeliverySummary({ finalText: REAL_CONCLUSION, hasDeliveredConclusion: true }, ON),
        false
      );
  });

  test('buildClosureNotice:门控�?�?空串(逐字节回退)', () => {
      assert.equal(
        buildClosureNotice({ totalToolCalls: 6, reason: 'promise-without-delivery' }, OFF),
        ''
      );
  });

  test('buildClosureNotice:门控开 �?诚实收尾含次数与继续提示', () => {
      const s = buildClosureNotice({ totalToolCalls: 6, reason: 'promise-without-delivery' }, ON);
      expect(s).toMatch(/未给出最终结论\/建议|尚未给出最终结�?);
      expect(s).toMatch(/6 次工�?);
      expect(s).toMatch(/继续/);
  });

  test('buildClosureNotice:门控开+无次�?�?不渲染「已执行 N 次」片�?, () => {
      const s = buildClosureNotice({ totalToolCalls: 0 }, ON);
      expect(!/次工�?.test(s).toBeTruthy());
      expect(s).toMatch(/尚未给出最终结�?);
  });

  test('deliveryNudgeForcedForWeakTier:默认开', () => {
      expect(deliveryNudgeForcedForWeakTier({})).toBe(true);
      expect(deliveryNudgeForcedForWeakTier(undefined)).toBe(true);
  });

  test('deliveryNudgeForcedForWeakTier:0/false/off/no �?�?, () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
        expect(deliveryNudgeForcedForWeakTier({ KHY_T0_DELIVERY_NUDGE: v })).toBe(false);
      }
  });

  test('emptyAfterToolsGuardEnabled:默认开;off �?�?, () => {
      expect(emptyAfterToolsGuardEnabled({})).toBe(true);
      expect(emptyAfterToolsGuardEnabled({ KHY_RESULT_GUARD_EMPTY: 'off' })).toBe(false);
  });

  test('assessClosure:执行了工�?空文�?未交�?�?unfinished(empty-after-tools)', () => {
      const r = assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: false, finalText: '' }, ON);
      expect(r.unfinished).toBe(true);
      expect(r.reason).toBe('empty-after-tools');
  });

  test('assessClosure:执行了工�?极短文本(<=12 去空�?+未交�?�?unfinished', () => {
      const r = assessClosure(
        { totalToolCalls: 2, hasDeliveredConclusion: false, finalText: '  {"x":1}  ' },
        ON
      );
      expect(r.unfinished).toBe(true);
      expect(r.reason).toBe('empty-after-tools');
  });

  test('assessClosure:执行了工�?稍长文本(>12)+未交付且非承�?�?�?unfinished', () => {
      const r = assessClosure(
        { totalToolCalls: 2, hasDeliveredConclusion: false, finalText: '我已经看完了这些文件的内容�? },
        ON
      );
      expect(r.unfinished).toBe(false);
  });

  test('assessClosure:空文本但已交付结�?�?�?unfinished', () => {
      const r = assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: true, finalText: '' }, ON);
      expect(r.unfinished).toBe(false);
  });

  test('assessClosure:空文本但没调工具 �?�?unfinished', () => {
      const r = assessClosure({ totalToolCalls: 0, hasDeliveredConclusion: false, finalText: '' }, ON);
      expect(r.unfinished).toBe(false);
  });

  test('assessClosure:子门控关(KHY_RESULT_GUARD_EMPTY=0)�?空文本不�?unfinished,承诺式仍判定', () => {
      const subOff = { KHY_RESULT_GUARD_EMPTY: '0' };
      assert.equal(
        assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: false, finalText: '' }, subOff)
          .unfinished,
        false
      );
      // 父门控仍开,承诺式前言照常 unfinished(字节回退仅作用于空文本分�?�?      const r = assessClosure(
        { totalToolCalls: 4, hasDeliveredConclusion: false, finalText: PROMISE },
        subOff
      );
      expect(r.unfinished).toBe(true);
      expect(r.reason).toBe('promise-without-delivery');
  });

  test('assessClosure:父门控关 �?空文本也�?unfinished:false(逐字节回退)', () => {
      assert.equal(
        assessClosure({ totalToolCalls: 4, hasDeliveredConclusion: false, finalText: '' }, OFF)
          .unfinished,
        false
      );
  });

  test('buildClosureNotice:empty-after-tools �?专属文案(几乎没有文字结论 + 继续提示)', () => {
      const s = buildClosureNotice({ totalToolCalls: 3, reason: 'empty-after-tools' }, ON);
      expect(s).toMatch(/几乎没有给出文字结论|被截�?);
      expect(s).toMatch(/3 次工�?);
      expect(s).toMatch(/继续/);
  });

  test('progressOnlyGuardEnabled:默认开;off �?�?, () => {
      expect(progressOnlyGuardEnabled({})).toBe(true);
      expect(progressOnlyGuardEnabled(undefined)).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
        assert.equal(
          progressOnlyGuardEnabled({ KHY_RESULT_GUARD_PROGRESS_ONLY: v }),
          false,
          `value ${v}`
        );
      }
  });

  test('looksLikeProgressNarration:命中「找到…逐个核对…先从…入手」纯进度旁白', () => {
      expect(looksLikeProgressNarration(PROGRESS1)).toBe(true);
      expect(looksLikeProgressNarration(PROGRESS2)).toBe(true);
      expect(looksLikeProgressNarration(PROGRESS3)).toBe(true);
  });

  test('looksLikeProgressNarration:不误伤真结论(有动作动词但无推进标�?/ 含结�?', () => {
      expect(looksLikeProgressNarration('我看了这几个文件)).toBe(内容都正常没有问题�?);
      expect(looksLikeProgressNarration(REAL_CONCLUSION)).toBe(false);
  });

  test('looksLikeProgressNarration:含代码块 / tool_call / 超长 �?false(有实质产�?/ 保守)', () => {
      expect(looksLikeProgressNarration('找到问题)).toBe(先从这里入手\n```js\nconst x=1;\n```');
      expect(looksLikeProgressNarration('找到匹配)).toBe(逐个核对 <tool_call>{}</tool_call>');
      assert.equal(
        looksLikeProgressNarration('找到匹配,逐个核对,先从第一处入手�? + '�?.repeat(500)),
        false
      );
  });

  test('looksLikeProgressNarration:防呆 null/undefined/非串/空白', () => {
      expect(looksLikeProgressNarration(null)).toBe(false);
      expect(looksLikeProgressNarration(undefined)).toBe(false);
      expect(looksLikeProgressNarration(123)).toBe(false);
      expect(looksLikeProgressNarration('   ')).toBe(false);
  });

  test('assessClosure:执行了工�?纯进度旁�?未交�?�?unfinished(progress-only-after-tools)', () => {
      const r = assessClosure(
        { totalToolCalls: 8, hasDeliveredConclusion: false, finalText: PROGRESS1 },
        ON
      );
      expect(r.unfinished).toBe(true);
      expect(r.reason).toBe('progress-only-after-tools');
  });

  test('assessClosure:进度旁白但已交付结论 �?�?unfinished', () => {
      const r = assessClosure(
        { totalToolCalls: 8, hasDeliveredConclusion: true, finalText: PROGRESS1 },
        ON
      );
      expect(r.unfinished).toBe(false);
  });

  test('assessClosure:进度旁白但没调工�?�?�?unfinished', () => {
      const r = assessClosure(
        { totalToolCalls: 0, hasDeliveredConclusion: false, finalText: PROGRESS1 },
        ON
      );
      expect(r.unfinished).toBe(false);
  });

  test('assessClosure:子门控关(KHY_RESULT_GUARD_PROGRESS_ONLY=0)�?进度旁白不再 unfinished,承诺/空仍判定', () => {
      const subOff = { KHY_RESULT_GUARD_PROGRESS_ONLY: '0' };
      assert.equal(
        assessClosure(
          { totalToolCalls: 8, hasDeliveredConclusion: false, finalText: PROGRESS1 },
          subOff
        ).unfinished,
        false
      );
      // 父门控仍开:承诺式前言、空文本两条旧分支照�?unfinished(字节回退仅作用于进度旁白分支)�?      assert.equal(
        assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: false, finalText: PROMISE }, subOff)
          .reason,
        'promise-without-delivery'
      );
      assert.equal(
        assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: false, finalText: '' }, subOff)
          .reason,
        'empty-after-tools'
      );
  });

  test('assessClosure:父门控关 �?进度旁白也恒 unfinished:false(逐字节回退)', () => {
      assert.equal(
        assessClosure({ totalToolCalls: 8, hasDeliveredConclusion: false, finalText: PROGRESS1 }, OFF)
          .unfinished,
        false
      );
  });

  test('buildClosureNotice:progress-only-after-tools �?专属文案(只报告进�?+ 继续给结论提�?', () => {
      const s = buildClosureNotice({ totalToolCalls: 8, reason: 'progress-only-after-tools' }, ON);
      expect(s).toMatch(/只报告了处理进度|宣告了下一步|空转/);
      expect(s).toMatch(/8 次工�?);
      expect(s).toMatch(/继续/);
  });

});

