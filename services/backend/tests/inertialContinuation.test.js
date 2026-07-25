'use strict';

/**
 * Tests for inertialContinuation.js — the single source for "惯性接续" at the
 * connection-instability seams in toolUseLoop (transient retry / empty-reply /
 * stall-nudge). Goal 2026-06-25: 「多处链接不稳定的地方可以使用惯性接续」.
 *
 * The contract the loop relies on:
 *   • isEnabled            — ON by default; only an explicit falsy flag disables
 *   • captureCarryover     — only a long-enough prefix is "meaningful"
 *   • buildContinuationDirective — resume directive when a prefix exists, else
 *                            the EXACT legacy from-scratch string per seam
 *   • mergePrefix          — stitch prefix + continuation, dedup any overlap
 */

const assert = require('assert');

const FLAG = 'KHY_INERTIAL_CONTINUATION';
const MODULE_PATH = '../src/services/query/inertialContinuation';

// Reload the module under a chosen flag value so isEnabled() reflects env at the
// time of the call (it reads process.env each call, but reloading keeps tests
// hermetic regardless).
function load(flagValue) {
  if (flagValue === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flagValue;
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

// A prefix comfortably above MIN_CARRYOVER_CHARS (24) of visible content.
const LONG_PREFIX = '我正在分析这段代码的执行流程，首先检查入口函数与调用关系，然后';
// A fragment below the threshold.
const SHORT_PREFIX = '正在分析…';

describe('inertialContinuation — enablement', () => {
  afterEach(() => { delete process.env[FLAG]; });

  test('ON by default when flag unset', () => {
    assert.strictEqual(load(undefined).isEnabled(), true);
  });

  test('explicit falsy values disable it', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      assert.strictEqual(load(v).isEnabled(), false, `${v} must disable`);
    }
  });

  test('any truthy value keeps it on', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
      assert.strictEqual(load(v).isEnabled(), true, `${v} must enable`);
    }
  });
});

describe('inertialContinuation — captureCarryover', () => {
  afterEach(() => { delete process.env[FLAG]; });

  test('a long-enough prefix is meaningful and trimmed of trailing space', () => {
    const m = load('1');
    const r = m.captureCarryover(`${LONG_PREFIX}   \n`);
    assert.strictEqual(r.meaningful, true);
    assert.strictEqual(r.text, LONG_PREFIX);
  });

  test('a short fragment is not meaningful', () => {
    const m = load('1');
    const r = m.captureCarryover(SHORT_PREFIX);
    assert.strictEqual(r.meaningful, false);
    assert.strictEqual(r.text, '');
  });

  test('null / empty input is not meaningful', () => {
    const m = load('1');
    assert.strictEqual(m.captureCarryover(null).meaningful, false);
    assert.strictEqual(m.captureCarryover('').meaningful, false);
    assert.strictEqual(m.captureCarryover('     ').meaningful, false);
  });

  test('disabled → never meaningful even for a long prefix', () => {
    const m = load('0');
    const r = m.captureCarryover(LONG_PREFIX);
    assert.strictEqual(r.meaningful, false);
    assert.strictEqual(r.text, '');
  });
});

describe('inertialContinuation — buildContinuationDirective', () => {
  afterEach(() => { delete process.env[FLAG]; });

  test('no carryover → byte-identical legacy from-scratch string per seam', () => {
    const m = load('1');
    for (const reason of ['transient', 'empty_reply', 'stall']) {
      assert.strictEqual(
        m.buildContinuationDirective({ reason }),
        m.LEGACY_DIRECTIVE[reason],
        `${reason} with no prefix must equal legacy`,
      );
    }
  });

  test('short carryover → still falls back to legacy', () => {
    const m = load('1');
    assert.strictEqual(
      m.buildContinuationDirective({ reason: 'stall', carryover: SHORT_PREFIX }),
      m.LEGACY_DIRECTIVE.stall,
    );
  });

  test('disabled → legacy regardless of a long prefix', () => {
    const m = load('0');
    assert.strictEqual(
      m.buildContinuationDirective({ reason: 'empty_reply', carryover: LONG_PREFIX }),
      m.LEGACY_DIRECTIVE.empty_reply,
    );
  });

  test('enabled + meaningful prefix → resume directive that embeds the tail', () => {
    const m = load('1');
    const d = m.buildContinuationDirective({ reason: 'empty_reply', carryover: LONG_PREFIX });
    assert.notStrictEqual(d, m.LEGACY_DIRECTIVE.empty_reply);
    assert.ok(d.includes('无缝继续'), 'must instruct to resume seamlessly');
    assert.ok(d.includes(LONG_PREFIX.slice(-10)), 'must echo the prefix tail as anchor');
    assert.ok(/不要重复/.test(d), 'must forbid repeating the prefix');
  });

  test('transient seam keeps the tool-progress clause; other seams do not', () => {
    const m = load('1');
    const t = m.buildContinuationDirective({ reason: 'transient', carryover: LONG_PREFIX });
    const e = m.buildContinuationDirective({ reason: 'empty_reply', carryover: LONG_PREFIX });
    assert.ok(/工具调用无需重复/.test(t), 'transient must preserve the no-repeat-tools contract');
    assert.ok(!/工具调用无需重复/.test(e), 'empty_reply must not invent a tool clause');
  });

  test('very long prefix is truncated to the anchor tail', () => {
    const m = load('1');
    const huge = 'x'.repeat(5000);
    const d = m.buildContinuationDirective({ reason: 'stall', carryover: huge });
    // The directive must not embed the full 5000-char prefix.
    assert.ok(d.length < 1500, 'directive must cap the embedded tail');
    assert.ok(d.includes('x'.repeat(m.ANCHOR_TAIL_CHARS)), 'must embed exactly the tail window');
  });
});

describe('inertialContinuation — mergePrefix', () => {
  const m = require(MODULE_PATH);

  test('plain concatenation when there is no overlap', () => {
    assert.strictEqual(m.mergePrefix('Hello ', 'world'), 'Hello world');
  });

  test('drops a duplicated overlap if the model re-emitted the tail', () => {
    assert.strictEqual(m.mergePrefix('the quick brown', 'brown fox jumps'), 'the quick brown fox jumps');
  });

  test('empty operands degrade gracefully', () => {
    assert.strictEqual(m.mergePrefix('', 'abc'), 'abc');
    assert.strictEqual(m.mergePrefix('abc', ''), 'abc');
    assert.strictEqual(m.mergePrefix('', ''), '');
  });

  test('full continuation already containing the whole prefix is not doubled', () => {
    assert.strictEqual(m.mergePrefix('abcdef', 'abcdef ghi'), 'abcdef ghi');
  });
});

describe('inertialContinuation — isProgressPreface / isDegeneratePrefix', () => {
  const m = require(MODULE_PATH);

  test('short content-free openers are prefaces', () => {
    for (const t of ['正在分析…', '让我看看', '我来检查一下', 'Let me check', "I'll take a look", 'Thinking...']) {
      assert.strictEqual(m.isProgressPreface(t), true, `"${t}" must be a preface`);
    }
  });

  test('a long prefix that merely starts like a preface carries real content', () => {
    // "让我" opener but well past PROGRESS_PREFACE_MAX_CHARS of substance.
    assert.strictEqual(m.isProgressPreface(LONG_PREFIX), false);
  });

  test('non-preface text is not a preface', () => {
    assert.strictEqual(m.isProgressPreface('函数 foo 的返回值是 42'), false);
    assert.strictEqual(m.isProgressPreface(''), false);
  });

  test('degenerate kinds are classified in priority order', () => {
    assert.deepStrictEqual(m.isDegeneratePrefix('   '), { degenerate: true, kind: 'whitespace' });
    assert.deepStrictEqual(m.isDegeneratePrefix('短'), { degenerate: true, kind: 'too_short' });
    assert.deepStrictEqual(m.isDegeneratePrefix('正在分析…'), { degenerate: true, kind: 'too_short' });
    // Long pure preface (above the length floor) → kind 'preface'.
    const longPreface = `让我先来看看${'，稍等'.repeat(8)}`;
    const dp = m.isDegeneratePrefix(longPreface);
    assert.strictEqual(dp.degenerate, true);
    assert.ok(['preface', 'repetition'].includes(dp.kind), `expected preface/repetition, got ${dp.kind}`);
  });

  test('a substantive prefix is NOT degenerate', () => {
    assert.deepStrictEqual(m.isDegeneratePrefix(LONG_PREFIX), { degenerate: false, kind: null });
  });
});

describe('inertialContinuation — classify (explicit CAN / CANNOT rules)', () => {
  afterEach(() => { delete process.env[FLAG]; });

  // ── CAN ──────────────────────────────────────────────────────────────────
  test('all four rules satisfied → resumable, carryover = merged prefix', () => {
    const m = load('1');
    const v = m.classify({ aborted: false, cooldown: false, streamed: LONG_PREFIX });
    assert.strictEqual(v.resumable, true);
    assert.strictEqual(v.reason, 'ok');
    assert.strictEqual(v.carryover, LONG_PREFIX);
  });

  test('merges prior + streamed, dedup overlap', () => {
    const m = load('1');
    const prior = '函数入口接收请求并校验参数，随后';
    const streamed = '随后进入主循环逐条处理任务直到队列清空为止';
    const v = m.classify({ prior, streamed });
    assert.strictEqual(v.resumable, true);
    assert.strictEqual(v.carryover, m.mergePrefix(prior, streamed));
  });

  // ── CANNOT ───────────────────────────────────────────────────────────────
  test('R1 user abort → CANNOT (user_abort), carryover empty', () => {
    const m = load('1');
    const v = m.classify({ aborted: true, streamed: LONG_PREFIX });
    assert.strictEqual(v.resumable, false);
    assert.strictEqual(v.reason, 'user_abort');
    assert.strictEqual(v.carryover, '');
  });

  test('R2 cooldown → CANNOT (cooldown)', () => {
    const m = load('1');
    const v = m.classify({ cooldown: true, streamed: LONG_PREFIX });
    assert.strictEqual(v.resumable, false);
    assert.strictEqual(v.reason, 'cooldown');
    assert.strictEqual(v.carryover, '');
  });

  test('R3 non-resumable errorType → CANNOT (non_resumable_error), detail = type', () => {
    const m = load('1');
    for (const et of ['content_filter', 'safety', 'refusal', 'permission', 'context_overflow']) {
      const v = m.classify({ errorType: et, streamed: LONG_PREFIX });
      assert.strictEqual(v.resumable, false, `${et} must not resume`);
      assert.strictEqual(v.reason, 'non_resumable_error');
      assert.strictEqual(v.detail, et);
      assert.strictEqual(v.carryover, '');
    }
  });

  test('R3 resumable errorType passes through to prefix check', () => {
    const m = load('1');
    const v = m.classify({ errorType: 'network_timeout', streamed: LONG_PREFIX });
    assert.strictEqual(v.resumable, true);
    assert.strictEqual(v.reason, 'ok');
  });

  test('R4 degenerate prefix → CANNOT (degenerate_prefix) with kind detail', () => {
    const m = load('1');
    const tooShort = m.classify({ streamed: '正在分析…' });
    assert.strictEqual(tooShort.resumable, false);
    assert.strictEqual(tooShort.reason, 'degenerate_prefix');
    assert.strictEqual(tooShort.detail, 'too_short');
    assert.strictEqual(tooShort.carryover, '');

    const empty = m.classify({ streamed: '   ' });
    assert.strictEqual(empty.reason, 'degenerate_prefix');
    assert.strictEqual(empty.detail, 'whitespace');
  });

  test('rule precedence: abort beats cooldown beats error beats prefix', () => {
    const m = load('1');
    // All adverse at once → R1 wins.
    const v = m.classify({
      aborted: true, cooldown: true, errorType: 'content_filter', streamed: '正在…',
    });
    assert.strictEqual(v.reason, 'user_abort');
  });

  test('disabled flag → CANNOT (disabled) regardless of inputs', () => {
    const m = load('0');
    const v = m.classify({ aborted: false, streamed: LONG_PREFIX });
    assert.strictEqual(v.resumable, false);
    assert.strictEqual(v.reason, 'disabled');
    assert.strictEqual(v.carryover, '');
  });
});
