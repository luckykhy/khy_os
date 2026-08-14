'use strict';

/**
 * Tests for activeAssist.js — single source for 「被动响应 → 主动协助 + 被动兜底」.
 * Goal 2026-06-25. Covers env gating, the conclusion detector (delegated to by
 * toolUseLoop._looksLikeDeliveryConclusion), and the three gap rules A1/A2/A3.
 */

const assert = require('assert');

const MASTER = 'KHY_ACTIVE_ASSIST';
const SUMMARY = 'KHY_ACTIVE_ASSIST_SUMMARY';
const AGENT = 'KHY_ACTIVE_ASSIST_AGENT';
const IDLE = 'KHY_ACTIVE_ASSIST_IDLE';
const ALL_FLAGS = [MASTER, SUMMARY, AGENT, IDLE];
const MODULE_PATH = '../src/services/query/activeAssist';

function load(env = {}) {
  for (const f of ALL_FLAGS) delete process.env[f];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

// A long, non-placeholder answer with NO conclusion (>= SUMMARY_MIN_CHARS=400).
const LONG_NO_CONCLUSION = '这段代码定义了一个事件循环，'.repeat(40); // ~520 chars, no 完成/总结/result
// A long answer that DOES carry a conclusion.
const LONG_WITH_CONCLUSION = LONG_NO_CONCLUSION + '综上，最终结果已给出，任务完成。';

describe('activeAssist — enablement', () => {
  afterEach(() => { for (const f of ALL_FLAGS) delete process.env[f]; });

  test('all gates ON by default', () => {
    const m = load();
    assert.strictEqual(m.isEnabled(), true);
    assert.strictEqual(m.summaryAssistEnabled(), true);
    assert.strictEqual(m.agentAssistEnabled(), true);
    assert.strictEqual(m.idleAssistEnabled(), true);
  });

  test('master gate off disables every sub-capability', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      const m = load({ [MASTER]: v });
      assert.strictEqual(m.isEnabled(), false, `${v}`);
      assert.strictEqual(m.summaryAssistEnabled(), false);
      assert.strictEqual(m.agentAssistEnabled(), false);
      assert.strictEqual(m.idleAssistEnabled(), false);
    }
  });

  test('per-gap sub-gates disable independently', () => {
    assert.strictEqual(load({ [SUMMARY]: '0' }).summaryAssistEnabled(), false);
    assert.strictEqual(load({ [SUMMARY]: '0' }).agentAssistEnabled(), true);
    assert.strictEqual(load({ [AGENT]: 'off' }).agentAssistEnabled(), false);
    assert.strictEqual(load({ [IDLE]: 'no' }).idleAssistEnabled(), false);
  });
});

describe('activeAssist — hasSynthesizedConclusion', () => {
  const m = load();

  test('detects a conclusion', () => {
    assert.strictEqual(m.hasSynthesizedConclusion('任务已完成'), true);
    assert.strictEqual(m.hasSynthesizedConclusion('Done, summary follows'), true);
    assert.strictEqual(m.hasSynthesizedConclusion('综上，结果如下'), true);
  });

  test('no conclusion / empty → false', () => {
    assert.strictEqual(m.hasSynthesizedConclusion('这段代码定义了一个事件循环'), false);
    assert.strictEqual(m.hasSynthesizedConclusion(''), false);
    assert.strictEqual(m.hasSynthesizedConclusion('   '), false);
  });
});

describe('activeAssist — classifySummary (A1)', () => {
  afterEach(() => { for (const f of ALL_FLAGS) delete process.env[f]; });

  test('CAN: long, conclusion-free, no-tool answer → assist (missing_summary)', () => {
    const v = load().classifySummary({ text: LONG_NO_CONCLUSION, hadToolCalls: false });
    assert.strictEqual(v.assist, true);
    assert.strictEqual(v.reason, 'missing_summary');
  });

  test('CANNOT ok_has_conclusion: a real conclusion present', () => {
    const v = load().classifySummary({ text: LONG_WITH_CONCLUSION });
    assert.strictEqual(v.assist, false);
    assert.strictEqual(v.reason, 'ok_has_conclusion');
  });

  test('CANNOT too_short: below SUMMARY_MIN_CHARS', () => {
    const v = load().classifySummary({ text: '短回答，没有结论。' });
    assert.strictEqual(v.assist, false);
    assert.strictEqual(v.reason, 'too_short');
  });

  test('CANNOT info_request: information lookups need no forced summary', () => {
    const v = load().classifySummary({ text: LONG_NO_CONCLUSION, isInfoRequest: true });
    assert.strictEqual(v.assist, false);
    assert.strictEqual(v.reason, 'info_request');
  });

  test('CANNOT already_assisted: one-shot', () => {
    const v = load().classifySummary({ text: LONG_NO_CONCLUSION, alreadyAssisted: true });
    assert.strictEqual(v.assist, false);
    assert.strictEqual(v.reason, 'already_assisted');
  });

  test('CANNOT disabled: sub-gate off', () => {
    const v = load({ [SUMMARY]: '0' }).classifySummary({ text: LONG_NO_CONCLUSION });
    assert.strictEqual(v.assist, false);
    assert.strictEqual(v.reason, 'disabled');
  });
});

describe('activeAssist — summary directive & fallback', () => {
  const m = load();

  test('directive forbids repeating body / using tools, in Chinese', () => {
    const d = m.buildSummaryDirective();
    assert.ok(/总结|结论/.test(d));
    assert.ok(/不要重复/.test(d));
    assert.ok(/不要调用任何工具/.test(d));
  });

  test('fallback synthesizes a closing only when no conclusion exists', () => {
    assert.ok(m.buildSummaryFallback(LONG_NO_CONCLUSION).includes('小结'));
    // model already concluded → no double rendering
    assert.strictEqual(m.buildSummaryFallback(LONG_WITH_CONCLUSION), '');
    assert.strictEqual(m.buildSummaryFallback(''), '');
  });

  test('fallback empty when sub-gate off', () => {
    assert.strictEqual(load({ [SUMMARY]: 'off' }).buildSummaryFallback(LONG_NO_CONCLUSION), '');
  });
});

describe('activeAssist — composeAgentAllFailedFallback (A2)', () => {
  afterEach(() => { for (const f of ALL_FLAGS) delete process.env[f]; });

  test('salvages per-agent failure reasons into an honest message', () => {
    const out = load().composeAgentAllFailedFallback([
      { name: '分析师A', status: 'error', detail: 'connection reset' },
      { name: '分析师B', status: 'completed', result: '' },
    ]);
    assert.ok(out);
    assert.ok(out.includes('分析师A'));
    assert.ok(out.includes('connection reset'));
    assert.ok(out.includes('分析师B'));
    assert.ok(/返回为空/.test(out));
    assert.ok(/建议/.test(out));
  });

  test('salvages a non-empty result that was excluded upstream', () => {
    const out = load().composeAgentAllFailedFallback([
      { name: 'X', status: 'completed', result: '这是一段足够长的部分产出内容用于抢救判定' },
    ]);
    assert.ok(out.includes('部分产出'));
    assert.ok(out.includes('这是一段足够长的部分产出内容'));
  });

  test('no information at all → null (caller falls back to canned)', () => {
    assert.strictEqual(load().composeAgentAllFailedFallback([]), null);
    assert.strictEqual(load().composeAgentAllFailedFallback(null), null);
  });

  test('disabled → null regardless', () => {
    const out = load({ [AGENT]: '0' }).composeAgentAllFailedFallback([
      { name: 'A', status: 'error', detail: 'boom' },
    ]);
    assert.strictEqual(out, null);
  });
});

describe('activeAssist — shouldAttemptIdleContinuation (A3)', () => {
  afterEach(() => { for (const f of ALL_FLAGS) delete process.env[f]; });

  test('attempt once when no substantive content and not yet used', () => {
    assert.strictEqual(load().shouldAttemptIdleContinuation({ substantive: false, used: false }), true);
  });

  test('do not attempt when content already collected', () => {
    assert.strictEqual(load().shouldAttemptIdleContinuation({ substantive: true, used: false }), false);
  });

  test('one-shot: never attempt twice', () => {
    assert.strictEqual(load().shouldAttemptIdleContinuation({ substantive: false, used: true }), false);
  });

  test('disabled → never attempt', () => {
    assert.strictEqual(load({ [IDLE]: 'off' }).shouldAttemptIdleContinuation({ substantive: false, used: false }), false);
  });
});
